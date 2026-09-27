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
  DEFAULT_CHAT_MODE,
  isAnalyzeMode,
  isFileMutatingTool,
  isReadOnlyTool,
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
import { BUILD_SWITCH_HINT, type SystemPromptBuilder } from "./system-prompt";
import { LoopGuard, type LoopDecision } from "./loop-guard";
import { ToolCallAccumulator } from "./tool-call-accumulator";
import { ThinkingTagParser } from "./thinking-parser";
import type { AgentEvent, SubAgentEvent } from "./types";

/**
 * The host writes a synthetic label as the assistant content of a turn that
 * only called tools (no model text). It exists for the transcript/logs, but it
 * must NEVER reach the model: models IMITATE it and emit it back as visible
 * text with no tool call, which then looks like an empty final answer and ends
 * the run. It is stripped from the LLM conversation and treated as empty when
 * the model echoes it.
 */
const TOOL_SUMMARY_RE = /^🔧 (?:Tool|Tools):/;

function isSyntheticToolSummary(content: string): boolean {
  return TOOL_SUMMARY_RE.test(content);
}
export interface AgentDeps {
  config: ConfigProvider;
  llmFactory: LLMProviderFactory;
  tools: ToolRegistry;
  history: ChatHistory;
  events: EventBus<AgentEvent>;
  systemPrompt: SystemPromptBuilder;
  /** Maximum number of LLM turns per user message. Undefined = no cap
   * (the orchestrator runs until it answers or the user Stops; the loop guard
   * stops degenerate loops). Sub-agents may pass a finite cap. */
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
    /** Parent abort signal: lets the runner abort a sub-agent that starts
     * AFTER Stop (closes the start/abort race). */
    signal?: AbortSignal,
  ) => Promise<ToolResult>;
  /** Called by abort() so the parent can cascade Stop to active sub-agents. */
  onAbort?: () => void;
  /** When the turn budget is exhausted, run ONE final tool-less turn that asks
   * the model for its report, instead of stopping with a bare "turn limit"
   * note. Sub-agents set this so the caller always gets a usable report. */
  forceFinalReportOnLimit?: boolean;
  /** Optional diagnostic sink (wired to the "Output > Harny" channel). One
   * line per turn + one per loop/stop decision, so a run can be diagnosed
   * after the fact without the in-memory raw stream. Never throws. */
  log?: (message: string) => void;
  /** Called (and awaited) at the START of every turn, before the LLM request.
   * The host uses it to auto-compact MID-RUN when the context threshold is
   * exceeded: it compacts at a step boundary, then the run continues. */
  onTurnBoundary?: () => Promise<void> | void;
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
  /** Loop detection/breaking state (reset per run). */
  private readonly guard = new LoopGuard();
  /** Analyze mode: at least one change was PREPARED as a dry-run preview. */
  private preparedPreviews = false;
  /** Parallel ON: at least one Delegate call was emitted for this user message. */
  private delegatedThisRun = false;
  /** Parallel ON: the "you must delegate" corrective was already injected. */
  private forcedDelegationNudge = false;
  /** The user message that started the current run (goal for the forced sub-agent). */
  private runGoal = "";
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
    this.runGoal = userMessage.trim() || options.displayText?.trim() || "";

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
    this.log(`send: mode=${this._mode} parallel=${this.delegationEnabled ? "ON" : "OFF"}`);
    this.guard.reset();
    this.preparedPreviews = false;
    this.delegatedThisRun = false;
    this.forcedDelegationNudge = false;
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
    // Turn boundary: the host may auto-compact here (threshold exceeded) so a
    // long run compacts at a step boundary and CONTINUES. Awaited so the next
    // LLM request already sees the compacted history.
    if (this.deps.onTurnBoundary) {
      try {
        await this.deps.onTurnBoundary();
      } catch (err: any) {
        this.log(`onTurnBoundary failed: ${err?.message ?? String(err)}`);
      }
    }
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
        // Never let the synthetic tool label leak into a stored report either.
        const finalText = isSyntheticToolSummary(final.content) ? "" : final.content.trim();
        this.deps.history.add({
          role: "assistant",
          content: finalText || "(no report produced)",
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

    this.guard.beginTurn();
    const turnResult = await this.runLlmTurn();
    // An echoed synthetic label is NOT an answer: treat it as empty so the loop
    // guard nudges the model to actually act/answer instead of ending the run.
    const echoedLabel = isSyntheticToolSummary(turnResult.content);
    const content = echoedLabel ? "" : turnResult.content;
    const { toolCalls, thinking, reasoningDetails, finishReason, reasoningLoop } = turnResult;
    this.log(
      `turn ${turn}: finish=${finishReason ?? "-"} content=${content.length}c thinking=${thinking.length}c ` +
        `tools=[${toolCalls.map((t) => t.name).join(",")}]` +
        (reasoningLoop ? " reasoningLoop" : "") +
        (echoedLabel ? " discardedEchoedLabel" : ""),
    );
    const toolSummary =
      toolCalls.length > 0
        ? `🔧 ${toolCalls.length === 1 ? "Tool" : "Tools"}: ${toolCalls.map((t) => t.name).join(", ")}`
        : "";
    const truncated = finishReason === "length";

    // A reasoning loop was cut mid-stream: the stream was interrupted, so any
    // half-emitted tool call is untrustworthy. Break the loop and nudge.
    if (reasoningLoop) {
      if (!this.handleLoop(this.guard.noteReasoningLoop(), turn + 1 < maxTurns)) return;
      return this.runTurns(turn + 1);
    }

    // A turn with NO answer and NO tool call is NOT a final answer: the model
    // stalled. This is common right after a tool result with local/reasoning
    // models, which may emit only reasoning (thinking) or nothing at all and
    // then stop. The guard nudges a bounded number of times, then stops loudly.
    if (toolCalls.length === 0 && !content.trim()) {
      // Output-token limit reached before ANY answer/tool: nudging will not
      // help (the budget is the problem). Say so explicitly.
      if (truncated) {
        this.stopWithTruncationMessage(thinking.trim().length > 0);
        return;
      }
      const decision = this.guard.observeTurn({ content, thinking, toolCalls: [], toolResults: [] });
      if (decision.kind === "continue") return; // defensive; should not happen
      if (!this.handleLoop(decision, turn + 1 < maxTurns)) return;
      return this.runTurns(turn + 1);
    }

    // Token-limit truncation WITH an answer: keep the partial answer, but make
    // the truncation explicit (appended to the content so it survives refresh
    // and stays valid around any tool calls).
    const storedContent = content || toolSummary || "(empty response)";
    const withTruncation = truncated
      ? `${storedContent}\n\n> ⚠️ ${this.truncationNote(thinking.trim().length > 0)}`
      : storedContent;
    // Parallel ON is a HARD guarantee (≥1 sub-agent per request). If the model
    // refused even after the nudge, the HOST will dispatch one itself; in that
    // case keep the model's direct answer only in the UI (uiOnly) so the LLM
    // story does not carry a now-superseded answer before the sub-agent turn.
    const willForceDelegate =
      toolCalls.length === 0 &&
      this.delegationEnabled &&
      !this.delegatedThisRun &&
      this.forcedDelegationNudge &&
      !!this.deps.spawnSubAgent &&
      !!this.runGoal;
    this.deps.history.add({
      role: "assistant",
      content: this.withPreviewFooter(withTruncation),
      toolCalls,
      timestamp: Date.now(),
      ...(willForceDelegate ? { uiOnly: true } : {}),
      ...(thinking.trim() ? { thinking } : {}),
      ...(reasoningDetails && reasoningDetails.length > 0 ? { reasoningDetails } : {}),
    });

    if (toolCalls.length === 0) {
      if (this.delegationEnabled && !this.delegatedThisRun) {
        // 1) First offense: nudge the model to delegate and continue.
        if (!this.forcedDelegationNudge && turn + 1 < maxTurns) {
          this.forcedDelegationNudge = true;
          this.log(`parallel ON but no Delegate call — nudging the model to delegate`);
          this.deps.history.add({
            role: "user",
            content:
              "Parallel is ON but you did NOT delegate. This is MANDATORY: emit at least one Delegate call NOW. " +
              "Decompose the request and run its independent sub-tasks as sub-agents; if nothing can run in parallel, " +
              "delegate the single bounded sub-task to ONE sub-agent. Do not answer directly.",
            timestamp: Date.now(),
          });
          return this.runTurns(turn + 1);
        }
        // 2) The model ignored the nudge: the HOST dispatches one sub-agent.
        if (willForceDelegate) {
          await this.forceDelegate(turn);
          return;
        }
      }
      // Follow-through safety is enforced by the system prompt, not by runtime
      // heuristics: it states that an action MUST be expressed as a tool call
      // in the same turn and that a no-tool turn counts as the final answer.
      // This keeps the guard model- and language-agnostic (no word lists, no
      // per-model patches) and costs zero extra LLM turns.
      return;
    }

    // Track tool outcomes for loop classification.
    const toolResults: { name: string; args: Record<string, unknown>; isError: boolean; content: string }[] = [];

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
    const emitted = new Set<number>();
    const emitResult = (index: number, result: ToolResult): void => {
      emitted.add(index);
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
    // Stop launching MORE work once the run is aborted (queued sub-agents must
    // not start after the user pressed Stop).
    const abortedRun = (): boolean => this.abortController?.signal.aborted === true;
    // Execute ONE call through the loop guard: identical successful read-only
    // calls reuse the cached result; identical failing calls are refused (not
    // re-run). This BREAKS tool loops at the source instead of only nudging.
    const runOne = async (index: number): Promise<void> => {
      const tc = toolCalls[index];
      const readOnly = isReadOnlyTool(tc.name);
      const decision = this.guard.beforeToolCall(tc, readOnly);
      let r: ToolResult;
      if (decision.mode === "run") {
        r = await this.executeToolSafely(tc);
        this.guard.afterToolCall(tc, r.isError, r.content, readOnly);
      } else {
        r = { content: decision.content, isError: decision.mode === "refuse" };
      }
      results[index] = r;
      emitResult(index, r);
    };
    for (const step of steps) {
      if (abortedRun()) break;
      if (step.kind === "single") {
        await runOne(step.index);
      } else {
        // Run the parallel batch with at most `parallelCap` sub-agents in
        // flight: as soon as one finishes its slot is freed for the next one,
        // so there are ALWAYS ~cap running (a sliding window, not a barrier).
        // Each result is emitted the moment its call resolves.
        await runWithConcurrency(step.indices, parallelCap, async (idx) => {
          if (abortedRun()) return; // do not START a queued sub-agent after Stop
          await runOne(idx);
        });
      }
    }

    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      const result =
        results[i] ??
        (abortedRun()
          ? { content: "\u23f9 aborted before running (Parallel stopped).", isError: true }
          : { content: `Tool ${tc.name} produced no result`, isError: true });
      // Calls that never started (queued sub-agents killed by Stop) still get a
      // tool_result so the UI can mark them ABORTED.
      if (!emitted.has(i)) emitResult(i, result);
      this.deps.history.add({ role: "tool", content: result.content, toolCallId: tc.id, timestamp: Date.now() });
      toolResults.push({ name: tc.name, args: tc.arguments, isError: result.isError, content: result.content });
    }

    // Aborted: do not continue the turn loop.
    if (abortedRun()) return;

    // ── Loop guard ─────────────────────────────────────────────────────
    // Classify the turn (reasoning / empty / tool-failure / error-streak /
    // tool-repeat) and BREAK it: log what happened, tell the model how to
    // recover, and keep going. The guard escalates after repeated interventions
    // and only then returns a final `stop`.
    const decision = this.guard.observeTurn({ content, thinking, toolCalls, toolResults });
    if (decision.kind === "continue") {
      await this.runTurns(turn + 1);
      return;
    }
    if (!this.handleLoop(decision, turn + 1 < maxTurns)) return;
    await this.runTurns(turn + 1);
  }

  /**
   * Apply a loop decision: `react` logs the loop (UI-only note + event) and
   * injects a corrective user nudge so the model can recover; `stop` emits the
   * final diagnostic. Returns true when the run should continue.
   */
  private handleLoop(decision: LoopDecision, hasRoom = true): boolean {
    if (decision.kind === "continue") return true;
    if (decision.kind === "stop") {
      this.log(`loop-stop [${decision.type}] after ${decision.level} intervention(s): ${decision.message}`);
      this.stopWithLoopMessage(
        `Loop not resolved [${decision.type}] after ${decision.level} intervention(s): ${decision.message}`,
      );
      return false;
    }
    this.log(`loop-guard [${decision.type}] level ${decision.level}: ${decision.note}`);
    if (!hasRoom) {
      this.stopWithLoopMessage(`Loop detected [${decision.type}] but the turn budget is exhausted: ${decision.note}`);
      return false;
    }
    const note = `🔁 **Loop guard** [${decision.type}] — ${decision.note}`;
    this.deps.history.add({ role: "assistant", content: note, timestamp: Date.now(), uiOnly: true });
    this.deps.events.emit({
      type: "loop_intervention",
      loopType: decision.type,
      level: decision.level,
      message: decision.note,
    });
    this.deps.history.add({ role: "user", content: decision.nudge, timestamp: Date.now() });
    return true;
  }

  /** Human-readable note for a response truncated at the output-token limit. */
  private truncationNote(reasoningAteBudget: boolean): string {
    const maxTokens = this.deps.config.get().maxTokens;
    return (
      "Output truncated by the token limit (finish_reason=length" +
      `, maxTokens=${maxTokens})` +
      (reasoningAteBudget ? " — the reasoning likely consumed the whole budget" : "") +
      ". Increase `harny.maxTokens` (or shorten the request/reasoning) and ask me to continue."
    );
  }

  /** Best-effort diagnostic sink; diagnostics must never break a run. */
  private log(message: string): void {
    try {
      this.deps.log?.(message);
    } catch {
      /* ignore */
    }
  }

  /** Stop a run whose turn was truncated by the output-token limit before it
   * could answer or call a tool (the reasoning usually ate the budget). */
  private stopWithTruncationMessage(reasoningAteBudget: boolean): void {
    this.log(`stop [truncation]: output-token limit reached (finish_reason=length)`);
    const note = this.truncationNote(reasoningAteBudget);
    this.deps.history.add({ role: "assistant", content: `❌ ${note}`, timestamp: Date.now() });
    this.deps.events.emit({ type: "error", error: note });
  }

  private stopWithLoopMessage(message: string): void {
    this.log(`stop: ${message}`);
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

  /**
   * The conversation sent to the LLM. When orchestration is OFF (Parallel not
   * enabled) any past Delegate turn and its results are DROPPED, so the model
   * has no trace of sub-agents to imitate: delegation is not even a visible
   * possibility. The stored history is untouched (only this view is filtered).
   */
  private llmConversation(): ChatMessage[] {
    const all = this.deps.history.conversation();
    if (this.delegationEnabled) return all;
    const droppedIds = new Set<string>();
    const out: ChatMessage[] = [];
    for (const m of all) {
      if (m.role === "assistant" && m.toolCalls?.some((tc) => tc.name === DELEGATE_TOOL_NAME)) {
        for (const tc of m.toolCalls) droppedIds.add(tc.id);
        continue; // drop the whole Delegate turn
      }
      if (m.role === "tool" && m.toolCallId && droppedIds.has(m.toolCallId)) continue;
      out.push(m);
    }
    return out;
  }

  /**
   * A one-line, ALWAYS-PRESENT state banner prepended to the system prompt on
   * EVERY turn, so the model cannot miss the current mode / Parallel state
   * (a tool would require the model to call it — this does not).
   */
  private stateLine(): string {
    const readOnly = isAnalyzeMode(this._mode);
    const mode = readOnly
      ? "Analyze — READ-ONLY PREVIEW: you can PREPARE changes (Write/Edit/StrReplace/Delete run as " +
        "VALIDATED diff previews) but nothing is applied; finish by telling the user to switch to Build to apply"
      : "Build — you CAN create, modify and delete files";
    const parallel = this.delegationEnabled
      ? "ON — MANDATORY: you MUST run at least one sub-agent via the Delegate tool on EVERY request " +
        "(a single one is fine when nothing can run in parallel)"
      : "OFF — no sub-agents: use your own tools only";
    return `[CURRENT STATE] Mode: ${mode}. Parallel: ${parallel}.`;
  }

  private async runLlmTurn(toolDefinitionsOverride?: ToolDefinition[]): Promise<{
    content: string;
    toolCalls: ToolCall[];
    thinking: string;
    reasoningDetails?: unknown[];
    /** Provider finish reason for this turn ("length" = output-token limit). */
    finishReason?: string;
    /** True when the loop guard cut this turn short because the reasoning
     * repeated itself; the caller must nudge instead of executing tools. */
    reasoningLoop?: boolean;
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
      { role: "system", content: `${this.stateLine()}\n\n${this.deps.systemPrompt.build(this._mode, toolDefinitions)}` },
      ...this.llmConversation().map((m) => ({
        role: m.role,
        // Never send the synthetic tool label to the model (it gets imitated).
        content: m.role === "assistant" && isSyntheticToolSummary(m.content) ? "" : m.content,
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
    let finishReason: string | undefined;
    let reasoningLoop = false;
    const toolCalls: ToolCall[] = [];

    // Thinking tag parser: some models (Qwen, local LLMs) emit reasoning
    // inside <think>...</think> or <reason>...</reason> embedded in text.
    // We parse these out and emit them as thinking events instead. The parser
    // is stateful across chunks (a block may span several chunks).
    const thinkingParser = new ThinkingTagParser();

    // Per-turn abort: lets the LOOP GUARD cut a runaway reasoning stream
    // WITHOUT cancelling the whole run. A user Stop still aborts through the
    // main signal, which is linked here.
    const turnAbort = new AbortController();
    const linkMainAbort = (): void => turnAbort.abort();
    if (this.abortController!.signal.aborted) turnAbort.abort();
    this.abortController!.signal.addEventListener("abort", linkMainAbort);

    try {
      for await (const chunk of provider.stream(messages, turnAbort.signal, toolDefinitions)) {
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
        } else if (chunk.type === "finish") {
          finishReason = chunk.reason;
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

        // Within-turn reasoning loop: cut the stream and let the caller nudge.
        if (!reasoningLoop && this.guard.observeThinking(thinking)) {
          reasoningLoop = true;
          turnAbort.abort();
          break;
        }
      }
    } catch (err) {
      // A real user Stop must propagate; a guard-initiated cut must not.
      if (this.abortController!.signal.aborted) throw err;
      if (!reasoningLoop) throw err;
    } finally {
      this.abortController!.signal.removeEventListener("abort", linkMainAbort);
    }

    // A user Stop must end the run even when the provider resolved the stream
    // cleanly instead of throwing (some providers/mocks do).
    if (this.abortController!.signal.aborted) {
      const abortErr = new Error("Aborted");
      abortErr.name = "AbortError";
      throw abortErr;
    }

    return { content, toolCalls, thinking, reasoningDetails, finishReason, reasoningLoop };
  }

  private async executeToolSafely(tc: ToolCall): Promise<ToolResult> {
    // Delegate is executed by the orchestrator (not the generic tool path):
    // it owns the session's sub-agent runner and the depth-1 policy.
    if (tc.name === DELEGATE_TOOL_NAME) return this.executeDelegate(tc);
    const tool: Tool | undefined = this.deps.tools.get(tc.name);
    if (!tool) return { content: `Unknown tool: ${tc.name}`, isError: true };
    // Analyze (read-only PREVIEW) mode, defense in depth — never trust the
    // model even though the prompt tells it how to behave:
    //  · Shell is refused when the command could modify the filesystem;
    //  · the file-mutating tools (Write/StrReplace/Edit/Delete) run DRY-RUN:
    //    they validate the change and return the diff, but write NOTHING.
    let dryRun = false;
    if (isAnalyzeMode(this._mode)) {
      if (tc.name === "Shell" && isWriteCommand(String(tc.arguments.command ?? ""))) {
        return { content: ANALYZE_BLOCKED_SHELL_MESSAGE(String(tc.arguments.command ?? "")), isError: true };
      }
      dryRun = isFileMutatingTool(tc.name);
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
      const result = await tool.execute(tc.arguments, dryRun ? { dryRun: true } : undefined);
      // Remember that a preview was prepared so the final answer can be made
      // unambiguous (the model may still claim it "applied" the change).
      if (dryRun && !result.isError) this.preparedPreviews = true;
      return result;
    } catch (err: any) {
      return { content: `Tool error (${tc.name}): ${err.message || String(err)}`, isError: true };
    }
  }

  /**
   * In Analyze mode, if changes were prepared as previews, GUARANTEE that the
   * final message says nothing was applied and how to apply it — independently
   * of whether the model did (it regularly replies "fixed it" anyway).
   */
  private withPreviewFooter(content: string): string {
    // Only the TOP-LEVEL orchestrator (which the user reads) gets the footer:
    // a sub-agent's report is consumed by the orchestrator, so the notice there
    // is noise.
    if (!this.mayDelegate) return content;
    if (!this.preparedPreviews || !isAnalyzeMode(this._mode)) return content;
    // Do not duplicate the hint if the model already included it.
    if (/switch to\s*\**build\**/i.test(content)) return content;
    return (
      `${content}\n\n---\n⚠️ Nothing has been applied: the changes above were prepared as **previews** ` +
      `and are NOT on disk. ${BUILD_SWITCH_HINT}`
    );
  }

  /**
   * HARD guarantee for Parallel ON: the model refused to delegate even after
   * the corrective nudge, so the HOST dispatches ONE sub-agent with the whole
   * user request. It is recorded as a synthetic Delegate tool call (so the
   * transcript, the UI bubble and the LLM story all stay coherent), then the
   * orchestrator is asked to answer from the report.
   */
  private async forceDelegate(turn: number): Promise<void> {
    if (!this.deps.spawnSubAgent || !this.runGoal) return;
    const spec: DelegateSpec = {
      id: "auto",
      goal: this.runGoal,
      access: isAnalyzeMode(this._mode) ? "read" : "write",
      resources: ["."],
      parallel: false,
      after: [],
    };
    const toolCallId = "auto-delegate";
    const args: Record<string, unknown> = {
      id: spec.id,
      goal: spec.goal,
      access: spec.access,
      resources: spec.resources,
    };
    this.delegatedThisRun = true;
    this.log(`parallel hard fallback: host dispatched one sub-agent ("${spec.id}")`);
    this.deps.history.add({
      role: "assistant",
      content: "",
      toolCalls: [{ id: toolCallId, name: DELEGATE_TOOL_NAME, arguments: args }],
      timestamp: Date.now(),
    });
    this.deps.events.emit({
      type: "tool_call",
      toolCall: { id: toolCallId, name: DELEGATE_TOOL_NAME, arguments: args },
    });
    let result: ToolResult;
    try {
      this.deps.events.emit({ type: "subagent_start", toolCallId });
      const onEvent = (event: SubAgentEvent) =>
        this.deps.events.emit({ type: "subagent_event", toolCallId, event });
      result = await this.deps.spawnSubAgent(spec, onEvent, this.abortController?.signal);
    } catch (err: any) {
      result = { content: formatSubAgentError(spec, err?.message || String(err)), isError: true };
    }
    this.deps.events.emit({
      type: "tool_result",
      toolResult: { toolCallId, output: result.content, isError: result.isError },
    });
    this.deps.history.add({ role: "tool", content: result.content, toolCallId, timestamp: Date.now() });
    if (this.abortController?.signal.aborted) return;
    await this.runTurns(turn + 1);
  }

  /**
   * Run one Delegate call: validate the declared spec, enforce the read-only
   * rule in Analyze mode and the depth-1 policy, then hand the sub-task to the
   * session's runner (which builds and drives a separate Agent).
   */
  private async executeDelegate(tc: ToolCall): Promise<ToolResult> {
    // Mark that the model DID delegate this run (used by the Parallel hard
    // guarantee: at least one Delegate per user message when Parallel is ON).
    this.delegatedThisRun = true;
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
      return await this.deps.spawnSubAgent(spec, onEvent, this.abortController?.signal);
    } catch (err: any) {
      return { content: formatSubAgentError(spec, err?.message || String(err)), isError: true };
    }
  }
}
