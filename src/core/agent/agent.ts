import type { ConfigProvider } from "../config/types";
import { requiresApiKey } from "../config/requires-api-key";
import { describeFetchError } from "../tools/url-utils";
import type { EventBus } from "../events/event-bus";
import type { ChatHistory } from "../history/chat-history";
import type { ChatMessage } from "../history/types";
import type { LLMProviderFactory, LLMMessage } from "../llm/types";
import type { Tool, ToolCall, ToolRegistry, ToolResult } from "../tools";
import type { ChatController } from "./chat-controller";
import type { SystemPromptBuilder } from "./system-prompt";
import { ToolCallAccumulator } from "./tool-call-accumulator";
import { ThinkingTagParser } from "./thinking-parser";
import type { AgentEvent } from "./types";

export interface AgentDeps {
  config: ConfigProvider;
  llmFactory: LLMProviderFactory;
  tools: ToolRegistry;
  history: ChatHistory;
  events: EventBus<AgentEvent>;
  systemPrompt: SystemPromptBuilder;
  /** Maximum number of LLM turns per user message (default 20). */
  maxTurns?: number;
}

/**
 * Orchestrates the agent loop: LLM turn -> tool calls -> tool execution ->
 * continuation. All collaborators are injected (Dependency Injection).
 */
export class Agent implements ChatController {
  private abortController: AbortController | null = null;
  private _streaming = false;
  /** Consecutive turns whose tool calls ALL failed (reset per send). */
  private consecutiveErrorTurns = 0;
  /** Per-turn signature of tool calls (name|args), for repetition detection (reset per send). */
  private turnSignatures: string[] = [];
  /** Whether the corrective re-emit prompt was already sent this user message. */
  private corrected = false;

  constructor(private deps: AgentDeps) {}

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
    // Do NOT set _streaming = false here. Let send()'s finally block do it.
    // Otherwise a new send() can start before the previous one's cleanup finishes.
  }

  async send(userMessage: string, images?: string[]): Promise<void> {
    this.deps.history.add({
      role: "user",
      content: userMessage,
      images: images && images.length > 0 ? images : undefined,
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
      // Bounded, but say so: a silent stop looks like a hang. This branch only
      // runs when maxTurns is explicitly configured.
      this.deps.history.add({
        role: "assistant",
        content: `⏹ Stopped: reached the ${maxTurns}-turn limit.`,
        timestamp: Date.now(),
      });
      return;
    }

    const { content, toolCalls, thinking } = await this.runLlmTurn();
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

    for (const tc of toolCalls) {
      const result = await this.executeToolSafely(tc);
      this.deps.events.emit({
        type: "tool_result",
        toolResult: { toolCallId: tc.id, output: result.content, isError: result.isError },
      });
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

  private async runLlmTurn(): Promise<{ content: string; toolCalls: ToolCall[]; thinking: string }> {
    const config = this.deps.config.get();
    const provider = this.deps.llmFactory.create(config);

    const messages: LLMMessage[] = [
      { role: "system", content: this.deps.systemPrompt.build() },
      ...this.deps.history.conversation().map((m) => ({
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls,
        toolCallId: m.toolCallId,
        images: m.images,
        thinking: m.thinking,
      })),
    ];

    const accumulator = new ToolCallAccumulator();
    let content = "";
    let thinking = "";
    const toolCalls: ToolCall[] = [];

    // Thinking tag parser: some models (Qwen, local LLMs) emit reasoning
    // inside <think>...</think> or <reason>...</reason> embedded in text.
    // We parse these out and emit them as thinking events instead. The parser
    // is stateful across chunks (a block may span several chunks).
    const thinkingParser = new ThinkingTagParser();

    for await (const chunk of provider.stream(messages, this.abortController!.signal)) {
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

    return { content, toolCalls, thinking };
  }

  private async executeToolSafely(tc: ToolCall): Promise<ToolResult> {
    const tool: Tool | undefined = this.deps.tools.get(tc.name);
    if (!tool) return { content: `Unknown tool: ${tc.name}`, isError: true };
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
}
