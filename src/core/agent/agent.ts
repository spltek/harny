import type { ConfigProvider } from "../config/types";
import { requiresApiKey } from "../config/requires-api-key";
import { describeFetchError } from "../tools/url-utils";
import type { EventBus } from "../events/event-bus";
import type { ChatHistory } from "../history/chat-history";
import type { ChatMessage } from "../history/types";
import type { LLMProviderFactory, LLMMessage } from "../llm/types";
import type { Tool, ToolCall, ToolRegistry, ToolResult } from "../tools";
import {
  ANALYZE_BLOCKED_SHELL_MESSAGE,
  ANALYZE_BLOCKED_TOOL_MESSAGE,
  DEFAULT_CHAT_MODE,
  isAnalyzeMode,
  isToolBlockedInAnalyze,
  isWriteCommand,
  toolDefinitionsForMode,
  type ChatMode,
} from "../tools/mode-policy";
import type { ToolDefinition } from "../tools/tool";
import type { ChatController } from "./chat-controller";
import {
  DELEGATE_TOOL_NAME,
  formatSubAgentError,
  parseDelegateSpec,
  planToolExecution,
  runWithConcurrency,
  type DelegateSpec,
  type PlannedCall,
} from "./orchestration";
import type { SystemPromptBuilder } from "./system-prompt";
import { ToolCallAccumulator } from "./tool-call-accumulator";
import { ThinkingTagParser } from "./thinking-parser";
import type { AgentEvent } from "./types";

/**
 * One-shot corrective prompt injected when the model repeats the SAME tool call
 * (name + arguments) 3 turns in a row. The usual cause is retrying an
 * identical Shell command instead of switching tools — so point it at
 * Glob/Grep/Read and tell it to change approach or conclude.
 */
function repeatedCallNudge(name?: string): string {
  return (
    `You called the SAME tool ("${name ?? "?"}") with identical arguments 3 times in a row and made no progress. ` +
    "STOP repeating it. Change approach NOW: use Glob to locate files, Grep to search and Read to inspect — " +
    "prefer these over Shell. If a command failed or returned nothing, do not run it verbatim again: use different " +
    "arguments or a different tool, or conclude. Then write your final report."
  );
}

export interface AgentDeps {
  config: ConfigProvider;
  llmFactory: LLMProviderFactory;
  tools: ToolRegistry;
  history: ChatHistory;
  events: EventBus<AgentEvent>;
  systemPrompt: SystemPromptBuilder;
  /** Maximum number of LLM turns per user message (default 20). */
  maxTurns?: number;
  /** Whether this agent may launch sub-agents via Delegate (default true).
   * Sub-agents pass false, capping orchestration depth at 1. */
  allowDelegation?: boolean;
  /** Session-scoped runner for delegated sub-tasks. Required to execute a
   * Delegate call. `onEvent` forwards the sub-agent's live events (thinking /
   * text / tools) so the UI can stream them inside the sub-agent bubble. */
  spawnSubAgent?: (
    spec: DelegateSpec,
    onEvent?: (event: import("./types").SubAgentEvent) => void,
  ) => Promise<ToolResult>;
  /** Called by abort() so the parent can cascade Stop to active sub-agents. */
  onAbort?: () => void;
  /** When the turn budget is exhausted, run ONE final tool-less turn that asks
   * the model for its report, instead of stopping with a bare "turn limit"
   * note. Sub-agents set this so the caller always gets a usable report. */
  forceFinalReportOnLimit?: boolean;
}

/**
 * Orchestrates the agent loop: LLM turn -> tool calls -> tool execution ->
 * continuation. All collaborators are injected (Dependency Injection).
 */
export class Agent implements ChatController {
  private abortController: AbortController | null = null;
  private _streaming = false;
  /** Chat mode: "analyze" (read-only) by default — see setMode(). */
  private _mode: ChatMode = DEFAULT_CHAT_MODE;
  /** Consecutive turns whose tool calls ALL failed (reset per send). */
  private consecutiveErrorTurns = 0;
  /** Per-turn signature of tool calls (name|args), for repetition detection (reset per send). */
  private turnSignatures: string[] = [];
  /** Whether the corrective re-emit prompt was already sent this user message. */
  private corrected = false;
  /** Whether the forced final-report turn already ran (turn-budget exhausted). */
  private forcedFinalReport = false;
  /** Cap: may this agent EVER delegate? Sub-agents pass false (depth 1). */
  private readonly mayDelegate: boolean;
  /** Runtime toggle: the UI "Parallel" switch enables orchestration. */
  private delegationEnabled = false;

  constructor(private deps: AgentDeps) {
    this.mayDelegate = deps.allowDelegation !== false;
  }

  /** Enable/disable orchestration (sub-agents) — the "Parallel" toggle. */
  setDelegation(enabled: boolean): void {
    this.delegationEnabled = enabled && this.mayDelegate;
  }

  /** Switch chat mode: "analyze" (read-only) or "agent" (full tools). */
  setMode(mode: ChatMode): void {
    this._mode = mode === "agent" ? "agent" : DEFAULT_CHAT_MODE;
  }

  get streaming(): boolean {
    return this._streaming;
  }

  getMessages(): ChatMessage[] {
    return this.deps.history.all();
  }

  reset(): void {
    this.deps.history.clear();
  }

  load(messages: ChatMessage[]): void {
    this.deps.history.replace(messages);
  }

  onEvent(handler: (event: AgentEvent) => void): () => void {
    return this.deps.events.subscribe(handler);
  }

  addUserMessage(content: string): void {
    this.deps.history.add({ role: "user", content, timestamp: Date.now() });
  }

  abort(): void {
    this.abortController?.abort();
    // Cascade the stop to any sub-agents this run launched.
    this.deps.onAbort?.();
    // Do NOT set _streaming = false here. Let send()'s finally block do it.
    // Otherwise a new send() can start before the previous one's cleanup finishes.
  }

  async send(userMessage: string, options: import("./chat-controller").SendOptions = {}): Promise<void> {
    const images = options.images;
    this.deps.history.add({
      role: "user",
      content: userMessage,
      images: images && images.length > 0 ? images : undefined,
      attachments: options.attachments && options.attachments.length > 0 ? options.attachments : undefined,
      displayText: options.displayText,
      timestamp: Date.now(),
    });

    const config = this.deps.config.get();
    if (requiresApiKey(config)) {
      this.reportError(
        `No API key configured for ${config.baseUrl}. ` +
          "Local models (localhost/127.0.0.1) don't need a key: point `harny.baseUrl` at your local server. " +
          "Otherwise set `harny.apiKey` in VS Code settings, create a config file in the extension storage folder, " +
          "or set the OPENAI_API_KEY environment variable.",
      );
      this.deps.events.emit({ type: "done" });
      return;
    }

    this.abortController = new AbortController();
    this._streaming = true;
    this.consecutiveErrorTurns = 0;
    this.turnSignatures = [];
    this.corrected = false;
    this.forcedFinalReport = false;
    try {
      await this.runTurns(0);
      this.deps.events.emit({ type: "done" });
    } catch (err: any) {
      if (err.name === "AbortError") {
        this.deps.events.emit({ type: "done" });
      } else {
        // Mid-conversation failure (network/API): include it in the LLM story
        // too, so the model knows the previous turn errored (coherent state).
        this.reportError(describeFetchError(err), true);
        this.deps.events.emit({ type: "done" });
      }
    } finally {
      this._streaming = false;
      this.abortController = null;
    }
  }

  /**
   * Record an error bubble in the transcript (and optionally in the LLM's
   * story). auth/config errors stay uiOnly (the model cannot act on them);
   * mid-conversation fetch/API errors are passed to the model so it knows the
   * previous turn failed and can react coherently.
   */
  private reportError(content: string, includeInContext = false): void {
    this.deps.history.add({
      role: "assistant",
      content: content.startsWith("❌") ? content : `❌ ${content}`,
      timestamp: Date.now(),
      ...(includeInContext ? {} : { uiOnly: true }),
    });
    this.deps.events.emit({ type: "error", error: content });
  }

  private async runTurns(turn: number): Promise<void> {
    // No default turn budget: the user keeps control and can abort manually
    // (the Stop button). The cap ONLY applies when a caller opts in via
    // `maxTurns` (e.g. a future config option or a unit test).
    const maxTurns = this.deps.maxTurns ?? Infinity;
    if (turn >= maxTurns) {
      // Budget exhausted. If enabled (sub-agents), force ONE final turn with
      // NO tools so the model synthesises a report from what it already has —
      // otherwise every heavy sub-agent would return a raw "turn limit" note.
      if (this.deps.forceFinalReportOnLimit && !this.forcedFinalReport) {
        this.forcedFinalReport = true;
        this.deps.history.add({
          role: "user",
          content:
            "Tool budget exhausted. Do NOT call any more tools. Reply NOW with your final report " +
            "(what you did, key findings/results, files touched, blockers).",
          timestamp: Date.now(),
        });
        const final = await this.runLlmTurn([]);
        this.deps.history.add({
          role: "assistant",
          content: final.content.trim() || "(no report produced)",
          timestamp: Date.now(),
          ...(final.thinking.trim() ? { thinking: final.thinking } : {}),
          ...(final.reasoningDetails && final.reasoningDetails.length > 0
            ? { reasoningDetails: final.reasoningDetails }
            : {}),
        });
        return;
      }
      // Bounded, but say so: a silent stop looks like a hang. This branch only
      // runs when maxTurns is explicitly configured.
      this.deps.history.add({
        role: "assistant",
        content: `⏹ Stopped: reached the ${maxTurns}-turn limit.`,
        timestamp: Date.now(),
      });
      return;
    }

    const { content, toolCalls, thinking, reasoningDetails } = await this.runLlmTurn();
    const toolSummary =
      toolCalls.length > 0
        ? `🔧 ${toolCalls.length === 1 ? "Tool" : "Tools"}: ${toolCalls.map((t) => t.name).join(", ")}`
        : "";

    // A turn that only reasoned (no text, no tools) produced no answer yet.
    // Give the model another chance instead of stopping with an empty
    // response — common with reasoning models that think before acting.
    // Bounded by maxTurns, and the thinking was already streamed to the UI.
    if (toolCalls.length === 0 && !content.trim() && thinking.trim()) {
      return this.runTurns(turn + 1);
    }

    this.deps.history.add({
      role: "assistant",
      content: content || toolSummary || "(empty response)",
      toolCalls,
      timestamp: Date.now(),
      ...(thinking.trim() ? { thinking } : {}),
      ...(reasoningDetails && reasoningDetails.length > 0 ? { reasoningDetails } : {}),
    });

    if (toolCalls.length === 0) {
      // Follow-through safety is enforced by the system prompt, not by runtime
      // heuristics: it states that an action MUST be expressed as a tool call
      // in the same turn and that a no-tool turn counts as the final answer.
      // This keeps the guard model- and language-agnostic (no word lists, no
      // per-model patches) and costs zero extra LLM turns.
      return;
    }

    // Track consecutive tool failures to detect loops
    const toolResults: { name: string; args: Record<string, unknown>; isError: boolean }[] = [];

    // Plan the execution. Non-delegates and writers run one at a time, in
    // order; CONSECUTIVE read-only parallel delegates run as a concurrent
    // batch. Each result is EMITTED as soon as its call completes (so the UI
    // flips each sub-agent to done individually), while history still stores
    // them in the ORIGINAL call order for the model.
    const planned: PlannedCall[] = toolCalls.map((tc) => {
      const isDelegate = tc.name === DELEGATE_TOOL_NAME;
      return { isDelegate, spec: isDelegate ? parseDelegateSpec(tc.arguments).spec : undefined };
    });
    const steps = planToolExecution(planned);
    const results: ToolResult[] = new Array(toolCalls.length);
    const emitResult = (index: number, result: ToolResult): void => {
      this.deps.events.emit({
        type: "tool_result",
        toolResult: { toolCallId: toolCalls[index].id, output: result.content, isError: result.isError },
      });
    };
    // Global cap on concurrently-running sub-agents (gear setting). Undefined
    // or invalid = no cap (the whole parallel batch waits together).
    const capRaw = this.deps.config.get().maxParallelSubAgents;
    const parallelCap =
      typeof capRaw === "number" && Number.isInteger(capRaw) && capRaw > 0 ? capRaw : Infinity;
    for (const step of steps) {
      if (step.kind === "single") {
        const r = await this.executeToolSafely(toolCalls[step.index]);
        results[step.index] = r;
        emitResult(step.index, r);
      } else {
        // Run the parallel batch with at most `parallelCap` sub-agents in
        // flight: as soon as one finishes its slot is freed for the next one,
        // so there are ALWAYS ~cap running (a sliding window, not a barrier).
        // Each result is emitted the moment its call resolves.
        await runWithConcurrency(step.indices, parallelCap, async (idx) => {
          const r = await this.executeToolSafely(toolCalls[idx]);
          results[idx] = r;
          emitResult(idx, r);
        });
      }
    }

    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      const result = results[i] ?? { content: `Tool ${tc.name} produced no result`, isError: true };
      this.deps.history.add({ role: "tool", content: result.content, toolCallId: tc.id, timestamp: Date.now() });
      toolResults.push({ name: tc.name, args: tc.arguments, isError: result.isError });
    }

    // ── Loop detection ────────────────────────────────────────────────
    // A) The same tool calls (name AND arguments) failed for 2 consecutive
    //    turns. Two DIFFERENT failing calls of the same tool (e.g. Read a.ts
    //    then Read b.ts) do NOT match: they are distinct work, not a loop.
    // B) 3 consecutive turns where every tool call failed (even different tools).
    // C) The same tool call (name+args) repeated for 3 consecutive turns,
    //    even when it succeeds (e.g. reading the same file forever).
    const allFailed = toolResults.length >= 1 && toolResults.every((r) => r.isError);

    if (allFailed) {
      // A) identical failing sequence as the previous turn
      const prevAssistant = this.deps.history
        .all()
        .filter((m) => m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0)
        .slice(-2, -1); // second-to-last assistant (the current one is the last)
      if (prevAssistant.length > 0) {
        const prevTools = prevAssistant[0].toolCalls!;
        const sameAsPrevious =
          toolResults.length === prevTools.length &&
          toolResults.every(
            (r, i) =>
              i < prevTools.length &&
              prevTools[i].name === r.name &&
              JSON.stringify(prevTools[i].arguments) === JSON.stringify(r.args),
          );
        if (sameAsPrevious) {
          // Local reasoning models can fail tool-call JSON once (often a
          // truncated trace), then recover if prompted again. Give it one
          // corrective re-emit before hard-stopping on the next identical miss.
          if (!this.corrected && turn + 1 < maxTurns) {
            this.corrected = true;
            this.deps.history.add({
              role: "user",
              content:
                "Your last tool call(s) failed: their arguments were empty or malformed JSON, or the target text " +
                "was not found in the file (wrong/stale path or stale content). Re-Read the file first, then " +
                "re-emit the tool call(s) with complete, valid JSON against the ACTUAL file content.",
              timestamp: Date.now(),
            });
            return this.runTurns(turn + 1);
          }
          this.stopWithLoopMessage(
            "Tool loop detected: the model repeated the same failing tool call(s) even after a " +
              "corrective prompt. Empty or malformed tool arguments usually mean the LLM failed to emit " +
              "tool-call JSON (check the 📡 raw stream to see what it sent).",
          );
          return;
        }
      }

      // B) too many error turns in a row, whatever the tools
      this.consecutiveErrorTurns++;
      if (this.consecutiveErrorTurns >= 3) {
        this.stopWithLoopMessage(
          `Loop detected: ${this.consecutiveErrorTurns} consecutive turns of tool errors ` +
            `(${toolResults.map((r) => r.name || "?").join(", ")}). The model cannot recover — ` +
            "check the 📡 raw stream and verify the tools are reachable.",
        );
        return;
      }
    } else {
      this.consecutiveErrorTurns = 0;
    }

    // C) identical tool call repeated across 3 consecutive turns
    const signature = toolCalls.map((t) => `${t.name}|${JSON.stringify(t.arguments)}`).join("&");
    const sigs = this.turnSignatures;
    if (signature && sigs.length >= 2 && sigs[sigs.length - 1] === signature && sigs[sigs.length - 2] === signature) {
      // One corrective chance BEFORE hard-stopping: the usual cause is the
      // model retrying the same Shell command instead of switching to
      // Glob/Grep/Read (or changing arguments). Tell it to change approach.
      if (!this.corrected && turn + 1 < maxTurns) {
        this.corrected = true;
        this.deps.history.add({
          role: "user",
          content: repeatedCallNudge(toolCalls[0]?.name),
          timestamp: Date.now(),
        });
        return this.runTurns(turn + 1);
      }
      this.stopWithLoopMessage(
        `Loop detected: the model called "${toolCalls[0]?.name ?? "?"}" 3 times in a row with the same ` +
          "arguments without making progress. Stopping to avoid burning tokens.",
      );
      return;
    }
    sigs.push(signature);

    await this.runTurns(turn + 1);
  }

  private stopWithLoopMessage(message: string): void {
    this.deps.events.emit({ type: "error", error: message });
    // Persist the FULL diagnostic (not just a short label) so it stays in the
    // transcript for later debugging AND the story the LLM sees stays coherent
    // (the model knows its last tool calls failed and were stopped). The "❌"
    // prefix makes the view render it as a persistent red bubble.
    this.deps.history.add({
      role: "assistant",
      content: `❌ ${message}`,
      timestamp: Date.now(),
    });
  }

  private async runLlmTurn(toolDefinitionsOverride?: ToolDefinition[]): Promise<{
    content: string;
    toolCalls: ToolCall[];
    thinking: string;
    reasoningDetails?: unknown[];
  }> {
    const config = this.deps.config.get();
    const provider = this.deps.llmFactory.create(config);
    // Mode-filtered tool set: analyze advertises NO file-mutating tools, so
    // the model cannot even attempt a write (the execution side below is the
    // second layer of defense). An explicit [] (forced final report) makes the
    // turn tool-less.
    const toolDefinitions: ToolDefinition[] =
      toolDefinitionsOverride ??
      toolDefinitionsForMode(this.deps.tools.getAll(), this._mode, {
        exclude: this.delegationEnabled ? [] : [DELEGATE_TOOL_NAME],
      });

    const messages: LLMMessage[] = [
      { role: "system", content: this.deps.systemPrompt.build(this._mode, toolDefinitions) },
      ...this.deps.history.conversation().map((m) => ({
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls,
        toolCallId: m.toolCallId,
        images: m.images,
        thinking: m.thinking,
        reasoningDetails: m.reasoningDetails,
      })),
    ];

    const accumulator = new ToolCallAccumulator();
    let content = "";
    let thinking = "";
    let reasoningDetails: unknown[] | undefined;
    const toolCalls: ToolCall[] = [];

    // Thinking tag parser: some models (Qwen, local LLMs) emit reasoning
    // inside <think>...</think> or <reason>...</reason> embedded in text.
    // We parse these out and emit them as thinking events instead. The parser
    // is stateful across chunks (a block may span several chunks).
    const thinkingParser = new ThinkingTagParser();

    for await (const chunk of provider.stream(messages, this.abortController!.signal, toolDefinitions)) {
      if (chunk.type === "text") {
        // Emit raw chunk for stream log
        this.deps.events.emit({ type: "raw_chunk", chunk: chunk.content, kind: "text" });

        // Stream the text, splitting <think>/<reason> blocks into thinking
        // deltas and the rest into visible text deltas, in order.
        for (const ev of thinkingParser.feed(chunk.content)) {
          if (ev.kind === "thinking") {
            thinking += ev.content;
            this.deps.events.emit({ type: "thinking_delta", content: ev.content });
          } else {
            content += ev.content;
            this.deps.events.emit({ type: "text_delta", content: ev.content });
          }
        }
      } else if (chunk.type === "thinking") {
        // Emit raw chunk for stream log
        this.deps.events.emit({ type: "raw_chunk", chunk: chunk.content, kind: "thinking" });
        // Forward reasoning content separately and keep it in the message
        thinking += chunk.content;
        this.deps.events.emit({ type: "thinking_delta", content: chunk.content });
      } else if (chunk.type === "thinking_details") {
        // Structured reasoning blocks (OpenRouter): kept BESIDE the plaintext
        // thinking so they can be passed back verbatim (encrypted reasoning).
        reasoningDetails = chunk.details;
      } else if (chunk.type === "usage") {
        this.deps.events.emit({ type: "usage", usage: chunk.usage });
      } else {
        // Emit raw chunk for tool events
        if (chunk.type === "tool_call_start") {
          this.deps.events.emit({ type: "raw_chunk", chunk: JSON.stringify({ id: chunk.id, name: chunk.name }), kind: "tool_start" });
        } else if (chunk.type === "tool_call_delta") {
          // Show exactly what the model emitted for the arguments — critical
          // when tool calls come back empty.
          this.deps.events.emit({ type: "raw_chunk", chunk: chunk.delta, kind: "tool_args" });
        } else if (chunk.type === "tool_call_end") {
          this.deps.events.emit({ type: "raw_chunk", chunk: JSON.stringify({ index: chunk.index }), kind: "tool_end" });
        }
        const completed = accumulator.handle(chunk);
        if (completed) {
          toolCalls.push(completed);
          this.deps.events.emit({ type: "tool_call", toolCall: completed });
        }
      }
    }

    return { content, toolCalls, thinking, reasoningDetails };
  }

  private async executeToolSafely(tc: ToolCall): Promise<ToolResult> {
    // Delegate is executed by the orchestrator (not the generic tool path):
    // it owns the session's sub-agent runner and the depth-1 policy.
    if (tc.name === DELEGATE_TOOL_NAME) return this.executeDelegate(tc);
    const tool: Tool | undefined = this.deps.tools.get(tc.name);
    if (!tool) return { content: `Unknown tool: ${tc.name}`, isError: true };
    // Analyze (read-only) mode: refuse file-mutating tools and read-only
    // shell usage BEFORE anything runs (defense in depth — the model must not
    // see these tools either, but never trust the model).
    if (isAnalyzeMode(this._mode)) {
      if (isToolBlockedInAnalyze(tc.name)) {
        return { content: ANALYZE_BLOCKED_TOOL_MESSAGE(tc.name), isError: true };
      }
      if (tc.name === "Shell" && isWriteCommand(String(tc.arguments.command ?? ""))) {
        return { content: ANALYZE_BLOCKED_SHELL_MESSAGE(String(tc.arguments.command ?? "")), isError: true };
      }
    }
    // Explicit signal for calls whose arguments contained no valid JSON, so the
    // model sees WHY it failed (instead of a generic "missing arg" error) and
    // the corrective nudge can fire on the next turn.
    if (tc.malformed) {
      return {
        content: `Tool ${tc.name}: malformed tool arguments (no valid JSON was emitted). ` +
          "Re-emit this tool call with complete, valid JSON arguments.",
        isError: true,
      };
    }
    try {
      return await tool.execute(tc.arguments);
    } catch (err: any) {
      return { content: `Tool error (${tc.name}): ${err.message || String(err)}`, isError: true };
    }
  }

  /**
   * Run one Delegate call: validate the declared spec, enforce the read-only
   * rule in Analyze mode and the depth-1 policy, then hand the sub-task to the
   * session's runner (which builds and drives a separate Agent).
   */
  private async executeDelegate(tc: ToolCall): Promise<ToolResult> {
    if (!this.mayDelegate) {
      return { content: "Sub-agents cannot delegate further (orchestration depth is 1).", isError: true };
    }
    if (!this.delegationEnabled) {
      return {
        content: 'Delegation is disabled. Turn on the "Parallel" toggle to allow sub-agents.',
        isError: true,
      };
    }
    if (!this.deps.spawnSubAgent) {
      return { content: "Delegation is not available in this build.", isError: true };
    }
    const parsed = parseDelegateSpec(tc.arguments);
    const spec = parsed.spec;
    if (!spec) return { content: parsed.error ?? "Invalid Delegate call.", isError: true };
    // Read-only (Analyze) mode must never delegate a WRITER: that would
    // bypass the read-only guarantee.
    if (isAnalyzeMode(this._mode) && spec.access !== "read") {
      return {
        content: '⛔ Analyze (read-only) mode: sub-agents may only be delegated with access "read".',
        isError: true,
      };
    }
    try {
      // Signal the UI that this sub-agent is STARTING now (queued → running):
      // with a concurrency cap, several delegates may be queued behind others.
      this.deps.events.emit({ type: "subagent_start", toolCallId: tc.id });
      // Forward the sub-agent's live events into its bubble (nested streaming).
      const onEvent = (event: import("./types").SubAgentEvent) =>
        this.deps.events.emit({ type: "subagent_event", toolCallId: tc.id, event });
      return await this.deps.spawnSubAgent(spec, onEvent);
    } catch (err: any) {
      return { content: formatSubAgentError(spec, err?.message || String(err)), isError: true };
    }
  }
}
