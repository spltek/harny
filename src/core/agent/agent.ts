import type { ConfigProvider } from "../config/types";
import { requiresApiKey } from "../config/requires-api-key";
import { describeFetchError } from "../tools/url-utils";
import type { EventBus } from "../events/event-bus";
import type { ChatHistory } from "../history/chat-history";
import type { ChatMessage, MessageMeta } from "../history/types";
import { conversationFaults, describeFaults } from "../history/conversation-validity";
import { maskKeepTokens, maskOldToolResults } from "../history/observation-masking";
import { isContextOverflowError, isRequestRejection, matchedOverflowSignature, overflowLimitFromError } from "../llm/context-overflow";
import { estimateTokens } from "../sessions/compactor";
import type { LLMProviderFactory, LLMMessage, Usage } from "../llm/types";
import type { Tool, ToolCall, ToolRegistry, ToolResult } from "../tools";
import { DEFAULT_ANALYZE_POLICY, type AnalyzePolicy } from "../tools/tool";
import {
  DEFAULT_CHAT_MODE,
  analyzeRefusalMessage,
  isAnalyzeMode,
  toolDefinitionsForMode,
  type ChatMode,
} from "../tools/mode-policy";
import type { ToolDefinition } from "../tools/tool";
import type { ChatController, SendOptions } from "./chat-controller";
import type { PreparedChange } from "./types";
import {
  DELEGATE_TOOL_NAME,
  formatSubAgentAborted,
  formatSubAgentError,
  parseDelegateSpec,
  planToolExecution,
  runWithConcurrency,
  type DelegateSpec,
  type PlannedCall,
} from "./orchestration";
import { BUILD_SWITCH_HINT, type SystemPromptBuilder } from "./system-prompt";
import type { AttachmentPart } from "../../chat/attachment-types";
import { LoopGuard, DEFAULT_LOOP_GUARD_OPTIONS, type LoopDecision, type LoopGuardOptions } from "./loop-guard";
import { ToolCallAccumulator } from "./tool-call-accumulator";
import { ThinkingTagParser } from "./thinking-parser";
import type { AgentEvent } from "./types";

/**
 * The host writes a synthetic label as the assistant content of a turn that
 * only called tools (no model text). It exists for the transcript/logs, but it
 * must NEVER reach the model: models IMITATE it and emit it back as visible
 * text with no tool call, which then looks like an empty final answer and ends
 * the run. It is stripped from the LLM conversation and treated as empty when
 * the model echoes it.
 */
const TOOL_SUMMARY_RE = /^🔧 (?:Tool|Tools):/;

/** Marker of the host-added "nothing applied" footer (used to trigger the
 * highlighted "Switch to Build" call to action in the UI). */
const PREVIEW_FOOTER_MARKER = "Nothing has been applied";

/** Default cap on concurrently-running sub-agents when neither the session nor
 * the config sets one (the "Parallel sub-agents" control defaults to ON/4). */
export const DEFAULT_MAX_PARALLEL_SUB_AGENTS = 4;

/** If NO chunk arrives for this long, the provider stream is considered dead
 * (accepted-but-silent connection, crashed server, stuck model load) and the
 * turn is aborted with an explicit error instead of hanging the run forever.
 * Deliberately generous so a slow local model warming up is not killed. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 5 * 60_000;

function streamIdleError(ms: number): Error {
  const e = new Error(
    `The provider stream stalled: no data for ${Math.round(ms / 1000)}s. ` +
      "Check that the server/model is up (it may have crashed or be stuck loading), then retry.",
  );
  e.name = "StreamIdleTimeout";
  return e;
}

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
    /** The Delegate tool-call id: registers the sub-agent so the host can abort
     * JUST this one from its UI bubble. */
    toolCallId?: string,
    /** Called when the sub-agent prepares an Analyze preview, so the
     * orchestrator can surface the "Switch to Build" CTA for delegated work. */
    onPreviewPrepared?: (change: PreparedChange) => void,
  ) => Promise<ToolResult>;
  /** Called by abort() so the parent can cascade Stop to active sub-agents. */
  onAbort?: () => void;
  /** Abort ONE running sub-agent by its Delegate tool-call id (per-sub-task
   * Stop). No-op when that sub-agent is not running. */
  abortSubAgent?: (toolCallId: string) => void;
  /** When the turn budget is exhausted, run ONE final tool-less turn that asks
   * the model for its report, instead of stopping with a bare "turn limit"
   * note. Sub-agents set this so the caller always gets a usable report. */
  forceFinalReportOnLimit?: boolean;
  /** Optional diagnostic sink (wired to the "Output > Harny" channel). One
   * line per turn + one per loop/stop decision, so a run can be diagnosed
   * after the fact without the in-memory raw stream. Never throws. */
  log?: (message: string) => void;
  /** Idle-stream watchdog: abort a turn when the provider sends NO chunk for
   * this long (undefined = {@link DEFAULT_STREAM_IDLE_TIMEOUT_MS}). */
  streamIdleTimeoutMs?: number;
  /** Optional per-session Loop Guard options (resolved from the session's three
   * knobs). Undefined = the "normal" preset. */
  loopGuard?: LoopGuardOptions;
  /** Called (and awaited) at the START of every turn, before the LLM request.
   * The host uses it to auto-compact MID-RUN when the context threshold is
   * exceeded: it compacts at a step boundary, then the run continues. It
   * receives the run's abort signal so a user Stop cancels the compaction. */
  onTurnBoundary?: (signal: AbortSignal) => Promise<void> | void;
  /** Called when the provider REJECTED a request because the input was too big:
   * the host compacts the session in place and answers whether anything changed.
   * When it did, the agent sends the SAME turn again — the safety net under every
   * budget calculation, since our estimate is a heuristic and the declared window
   * can be wrong. See {@link Agent.runLlmTurnWithOverflowRecovery}.
   * `evidence` carries what the rejection revealed: the provider's own wording
   * family, and the context LIMIT when it stated one (let the host adopt it). */
  onContextOverflow?: (signal: AbortSignal, evidence: ContextOverflowEvidence) => Promise<boolean> | boolean;
  /** The USABLE context of the current turn (window − output reserve). Used to
   * decide whether a rejection we cannot read was about size, and to size the
   * masking of old tool results. Absent = those two features stay off. */
  contextBudget?: () => number;
  /** Working directory, used to resolve delegate `resources` for the safe
   * parallelism decision (relative vs absolute paths must MATCH). */
  cwd?: () => string;
  /** Identity of this agent, passed to tools that keep per-conversation state
   * (e.g. TodoWrite): each session and each sub-agent gets its OWN state. */
  ownerId?: string;
  /** Called when a SUB-AGENT prepared an Analyze preview (dry-run). */
  onPreviewPrepared?: (change: PreparedChange) => void;
  /** Called when a tool ACTUALLY changed a file (Build mode, not a preview):
   * lets the parent track what a run/sub-agent touched. */
  onFileChanged?: (change: PreparedChange) => void;
}

/** What a context-overflow rejection revealed. */
export interface ContextOverflowEvidence {
  /** Which provider family's wording matched (for the dev log). */
  signature?: string;
  /** The context limit the provider STATED, when its message carried one. The
   * caller should adopt it: it is the model's real window, where the configured
   * one may be a guess (see context-overflow.ts: overflowLimitFromError). */
  limitTokens?: number;
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
  /** The mode THIS TURN runs under: frozen when the turn starts.
   *
   * Mode and Parallel are behaviour policies the UI lets the user change while the
   * session works (they are not request parameters), and a change must land at a TURN
   * BOUNDARY — the same moment a steer is applied. Without this snapshot a switch could
   * catch a turn in flight and change the meaning of a tool call the model had already
   * emitted: an Analyze preview becoming a real write, with the diff never shown. So a
   * turn is coherent from its first token to its last tool result, and the next turn is
   * born in the new mode. */
  private turnMode: ChatMode = DEFAULT_CHAT_MODE;
  /** Loop detection/breaking state (reset per run). */
  private readonly guard: LoopGuard;
  /** Per-session concurrent sub-agent cap: undefined = fall back to the config
   * default (then DEFAULT_MAX_PARALLEL_SUB_AGENTS); 0 = explicitly no cap. */
  private parallelCap: number | undefined;
  /** Analyze mode: changes PREPARED as dry-run previews, keyed by path (so the
   * "switch to Build" notice can say exactly WHAT still needs Build). */
  private readonly preparedChanges = new Map<string, string>();
  /** Parallel ON + Analyze: changes a SUB-AGENT prepared as a preview, keyed by
   * path (its own Agent tracks them; they bubble up so the orchestrator can
   * show the CTA AND list exactly WHAT still needs Build). */
  private readonly subAgentChanges = new Map<string, string>();
  /** Per-attachment parts of the CURRENT user message, forwarded to sub-agents. */
  private currentAttachmentParts: AttachmentPart[] = [];
  /** Delegate tool-call ids the user aborted from the UI. A running one is
   * aborted through `abortSubAgent`; a QUEUED one is recorded here so it is
   * skipped when its turn comes and reported to the orchestrator as
   * aborted. Cleared per run. */
  private readonly abortedDelegates = new Set<string>();
  /** Whether the forced final-report turn already ran (turn-budget exhausted). */
  private forcedFinalReport = false;
  /** Cap: may this agent EVER delegate? Sub-agents pass false (depth 1). */
  private readonly mayDelegate: boolean;
  /** Runtime toggle: the UI "Parallel" switch enables orchestration. */
  private delegationEnabled = false;
  /** Soft-steer messages waiting for the next turn boundary. Each carries the
   * UI id so it can be cancelled before it is applied. Cleared per run. */
  private pendingSteers: { id: string; content: string; options: SendOptions }[] = [];

  constructor(private deps: AgentDeps) {
    this.mayDelegate = deps.allowDelegation !== false;
    this.guard = new LoopGuard(deps.loopGuard ?? DEFAULT_LOOP_GUARD_OPTIONS);
  }

  /** Enable/disable orchestration (sub-agents) — the "Parallel" toggle. */
  setDelegation(enabled: boolean): void {
    this.delegationEnabled = enabled && this.mayDelegate;
  }

  /** Apply the per-session concurrent sub-agent cap (undefined = inherit the
   * config default; 0 = no cap). Re-asserted by the host before each run. */
  setMaxParallelSubAgents(cap: number | undefined): void {
    this.parallelCap = cap;
  }

  /** Apply the per-session Loop Guard options (the three resolved knobs). */
  setLoopGuardOptions(options: LoopGuardOptions): void {
    this.guard.setOptions(options);
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

  onEvent(handler: (event: AgentEvent) => void): () => void {
    return this.deps.events.subscribe(handler);
  }

  addUserMessage(content: string): void {
    this.deps.history.add({ role: "user", content, timestamp: Date.now() });
  }

  /**
   * Soft steering: queue a user message for the NEXT turn boundary. Nothing is
   * interrupted — the in-flight LLM stream and tool batch finish, then the
   * merged message is added to the history and the model sees it on its next
   * request. In Parallel, this simply waits for the sub-agent batch to finish,
   * after which the orchestrator re-plans from the correction.
   */
  steer(id: string, content: string, options: SendOptions = {}): void {
    if (!content.trim() && !(options.images?.length) && !(options.attachments?.length)) return;
    this.pendingSteers.push({ id, content, options });
  }

  /** Drop a queued steer before it reaches a boundary (no-op once applied). */
  cancelSteer(id: string): void {
    this.pendingSteers = this.pendingSteers.filter((s) => s.id !== id);
  }

  /**
   * Apply ALL queued steers at a turn boundary as ONE merged user message:
   * the model sees a single correction turn (no consecutive user messages) and
   * the transcript shows a single steer bubble. Each steer stayed individually
   * cancellable until this point.
   */
  private drainSteers(): void {
    if (this.pendingSteers.length === 0) return;
    const steers = this.pendingSteers;
    this.pendingSteers = [];
    const content = steers.map((s) => s.content).join("\n\n");
    const displayText = steers.map((s) => s.options.displayText ?? s.content).join("\n\n");
    const images = steers.flatMap((s) => s.options.images ?? []);
    const attachments = steers.flatMap((s) => s.options.attachments ?? []);
    const parts = steers.flatMap((s) => s.options.attachmentParts ?? []);
    if (parts.length > 0) this.currentAttachmentParts = parts;
    this.deps.history.add({
      role: "user",
      content,
      images: images.length > 0 ? images : undefined,
      attachments: attachments.length > 0 ? attachments : undefined,
      displayText,
      steer: true,
      timestamp: Date.now(),
    });
    // Carry the SAME two fields the history entry above got, so the LIVE bubble
    // is rendered from the same data as the one rebuilt from the transcript.
    // Without them the attachments reached the model but never the bubble.
    this.deps.events.emit({
      type: "steer_applied",
      ids: steers.map((s) => s.id),
      content: displayText,
      ...(images.length > 0 ? { images } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  }

  abort(): void {
    this.abortController?.abort();
    // Cascade the stop to any sub-agents this run launched.
    this.deps.onAbort?.();
    // Do NOT set _streaming = false here. Let send()'s finally block do it.
    // Otherwise a new send() can start before the previous one's cleanup finishes.
  }

  /** Abort ONE sub-agent (Delegate bubble) without stopping the whole run. The
   * orchestrator still receives that Delegate's tool result ("aborted") and
   * continues. A QUEUED sub-agent is skipped when its turn comes. */
  abortSubAgent(toolCallId: string): void {
    if (!toolCallId) return;
    this.abortedDelegates.add(toolCallId);
    this.deps.abortSubAgent?.(toolCallId);
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
    this.currentAttachmentParts = options.attachmentParts ?? [];

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
    this.preparedChanges.clear();
    this.subAgentChanges.clear();
    this.forcedFinalReport = false;
    this.abortedDelegates.clear();
    this.pendingSteers = [];
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
    // Turn boundary: apply any soft-steer messages FIRST, so the history order
    // stays valid (after the previous assistant + tool results) and the LLM
    // request below already carries the correction.
    this.drainSteers();
    // Turn boundary: the host may auto-compact here (threshold exceeded) so a
    // long run compacts at a step boundary and CONTINUES. Awaited so the next
    // LLM request already sees the compacted history.
    if (this.deps.onTurnBoundary) {
      try {
        await this.deps.onTurnBoundary(this.abortController!.signal);
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
        this.addHarnessNudge(
          "Tool budget exhausted. Do NOT call any more tools. Reply NOW with your final report " +
            "(what you did, key findings/results, files touched, blockers).",
        );
        const final = await this.runLlmTurn([]);
        // Never let the synthetic tool label leak into a stored report either.
        const finalText = isSyntheticToolSummary(final.content) ? "" : final.content.trim();
        const finalMeta = this.turnMeta(final);
        this.deps.history.add({
          role: "assistant",
          content: finalText || "(no report produced)",
          timestamp: Date.now(),
          ...(final.thinking.trim() ? { thinking: final.thinking } : {}),
          ...(final.reasoningDetails && final.reasoningDetails.length > 0
            ? { reasoningDetails: final.reasoningDetails }
            : {}),
          meta: finalMeta,
        });
        this.deps.events.emit({ type: "turn_meta", meta: finalMeta });
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
    // Freeze the mode for this turn (see turnMode): a switch made mid-run applies from
    // the NEXT turn, never to the tool calls of a turn already in flight.
    this.turnMode = this._mode;
    const turnResult = await this.runLlmTurnWithOverflowRecovery();
    // An echoed synthetic label is NOT an answer: treat it as empty so the loop
    // guard nudges the model to actually act/answer instead of ending the run.
    const echoedLabel = isSyntheticToolSummary(turnResult.content);
    const content = echoedLabel ? "" : turnResult.content;
    const { toolCalls, thinking, reasoningDetails, finishReason, reasoningLoop, answerLoop } = turnResult;
    this.log(
      `turn ${turn}: mode=${this.turnMode} parallel=${this.delegationEnabled ? "ON" : "OFF"} ` +
        `finish=${finishReason ?? "-"} content=${content.length}c thinking=${thinking.length}c ` +
        `tools=[${toolCalls.map((t) => t.name).join(",")}]` +
        (reasoningLoop ? " reasoningLoop" : "") +
        (answerLoop ? " answerLoop" : "") +
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

    // The opt-in response guard cut the answer mid-stream: nudge and continue.
    if (answerLoop) {
      if (!this.handleLoop(this.guard.noteAnswerLoop(), turn + 1 < maxTurns)) return;
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
    // The Analyze preview footer belongs to the FINAL answer only: appending it
    // to an intermediate tool turn (the run continues) would be premature.
    const finalContent = toolCalls.length === 0 ? this.withPreviewFooter(withTruncation) : withTruncation;
    const meta = this.turnMeta(turnResult);
    // Analyze prepared previews that are not applied: flag the FINAL answer so
    // the UI shows the highlighted "Switch to Build" CTA. Driven by the REAL
    // condition (a preview was prepared), not by a marker in the text — the
    // model's own "switch to Build" line is not a reliable signal.
    const previewPrepared = toolCalls.length === 0 && this.hasUnappliedPreviews();
    const turnMessage: ChatMessage = {
      role: "assistant",
      content: finalContent,
      toolCalls,
      timestamp: Date.now(),
      ...(thinking.trim() ? { thinking } : {}),
      ...(reasoningDetails && reasoningDetails.length > 0 ? { reasoningDetails } : {}),
      ...(previewPrepared ? { previewPrepared: true } : {}),
      meta,
    };
    // A turn that asks for TOOLS is NOT committed here: it is appended together
    // with its results, as ONE unit, once they all exist (see the group append
    // below the tool phase). Committing it now would open a window in which the
    // history says "these tools were called" without their results — and anything
    // written during that window (the host's interruption notice on Stop, an
    // error path) lands BETWEEN the two. No provider accepts that, and because
    // the same broken history is re-sent on every later request, the session is
    // wedged for good. A no-tool turn has no results to wait for: it is complete
    // the moment it exists.
    if (toolCalls.length === 0) this.deps.history.add(turnMessage);
    // Publish the turn's REAL metrics NOW (the turn just ended), so the UI can
    // show the badge as soon as it is done instead of only on the end-of-run
    // refresh.
    this.deps.events.emit({ type: "turn_meta", meta });
    // Changes prepared as previews: highlight the "Switch to Build" CTA in the UI.
    if (previewPrepared) {
      this.deps.events.emit({ type: "preview_ready" });
    }

    if (toolCalls.length === 0) {
      // A no-tool turn is the FINAL answer. The parallel decision is
      // prompt-driven (no host enforcement): the model may answer directly,
      // work with its own tools, and/or delegate the parallelizable parts.
      // A steer that arrived while THIS final answer was streaming had no turn
      // boundary left to be applied at. Apply it NOW, at the end of the run and
      // BEFORE the host's queued messages, instead of ending: one more turn
      // that already carries the correction (same run, same context). This is
      // pi's "steering enters after the current assistant turn" behaviour for
      // the final-turn case.
      if (this.pendingSteers.length > 0) return this.runTurns(turn + 1);
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
    const steps = planToolExecution(planned, this.deps.cwd?.());
    const results: ToolResult[] = new Array(toolCalls.length);
    const emitted = new Set<number>();
    const emitResult = (index: number, result: ToolResult): void => {
      emitted.add(index);
      this.deps.events.emit({
        type: "tool_result",
        toolResult: { toolCallId: toolCalls[index].id, output: result.content, isError: result.isError },
      });
    };
    // Cap on concurrently-running sub-agents: the per-session setting wins,
    // then the config default, then DEFAULT_MAX_PARALLEL_SUB_AGENTS. 0 = no cap.
    const capRaw =
      this.parallelCap !== undefined
        ? this.parallelCap
        : (this.deps.config.get().maxParallelSubAgents ?? DEFAULT_MAX_PARALLEL_SUB_AGENTS);
    const parallelCap =
      typeof capRaw === "number" && Number.isInteger(capRaw) && capRaw > 0 ? capRaw : Infinity;
    // Diagnostics: the ACTUAL execution plan for this turn (how many calls run
    // together), plus each delegate's declaration. Makes a low-parallelism turn
    // explainable instead of looking random (Output > Harny).
    if (planned.some((p) => p.isDelegate)) {
      const shape = steps.map((s) => (s.kind === "single" ? "1" : String(s.indices.length))).join("+");
      // Planned peak concurrency = the largest parallel batch, capped. Makes a
      // "fewer agents than the max" turn explainable at a glance.
      const peak = steps.reduce(
        (m, s) => (s.kind === "parallel" ? Math.max(m, Math.min(s.indices.length, parallelCap)) : m),
        0,
      );
      this.log(
        `orchestration: ${planned.length} calls -> steps ${shape} ` +
          `(cap ${parallelCap === Infinity ? "\u221e" : parallelCap}, peak ${peak === Infinity ? "\u221e" : peak})`,
      );
      for (const p of planned) {
        if (!p.isDelegate) continue;
        if (!p.spec) {
          this.log("delegate: invalid args -> serial");
          continue;
        }
        this.log(
          `delegate "${p.spec.id || "?"}" access=${p.spec.access} after=[${p.spec.after.join(", ")}] ` +
            `resources=[${p.spec.resources.join(", ")}]`,
        );
      }
    }
    // Stop launching MORE work once the run is aborted (queued sub-agents must
    // not start after the user pressed Stop).
    const abortedRun = (): boolean => this.abortController?.signal.aborted === true;
    // Execute ONE call through the loop guard: identical successful read-only
    // calls reuse the cached result; identical failing calls are refused (not
    // re-run). This BREAKS tool loops at the source instead of only nudging.
    const runOne = async (index: number): Promise<void> => {
      const tc = toolCalls[index];
      // A Delegate is NEVER cached/deduped: it is an expensive, non-deterministic
      // nested run whose failure must remain retryable, so the loop guard treats
      // it as a side-effecting call (idempotent-read caching would replay a
      // stale/failed sub-agent instead of re-running it).
      const readOnly = this.deps.tools.get(tc.name)?.cacheable ?? false;
      const decision = this.guard.beforeToolCall(tc, readOnly);
      let r: ToolResult;
      if (decision.mode === "run") {
        const t0 = Date.now();
        this.log(`tool: ${tc.name} start`);
        r = await this.executeToolSafely(tc);
        this.log(`tool: ${tc.name} ${r.isError ? "error" : "ok"} in ${Date.now() - t0}ms`);
        this.guard.afterToolCall(tc, r.isError, r.content, readOnly);
      } else {
        this.log(`tool: ${tc.name} skipped (${decision.mode})`);
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

    // Collect the results in the ORIGINAL call order, then append the turn and
    // its results in ONE write: `addGroup` makes the pair inseparable, so no other
    // writer (a host notice, an error) can land between them, and the store does
    // it in a single transaction. See ChatHistory.addGroup for the whole reason.
    const toolMessages: ChatMessage[] = [];
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
      toolMessages.push({ role: "tool", content: result.content, toolCallId: tc.id, timestamp: Date.now() });
      toolResults.push({ name: tc.name, args: tc.arguments, isError: result.isError, content: result.content });
    }
    this.deps.history.addGroup([turnMessage, ...toolMessages]);

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
    this.addHarnessNudge(decision.nudge);
    return true;
  }

  /** Add a corrective HARNESS prompt (user role, marked `harness`) AND surface
   * it LIVE, so the UI shows the light-blue "Nudge" bubble immediately — not
   * only on the end-of-run refresh (which is skipped when the run stops with an
   * error). */
  private addHarnessNudge(content: string): void {
    this.deps.history.add({ role: "user", harness: true, content, timestamp: Date.now() });
    this.deps.events.emit({ type: "harness_nudge", content });
  }

  /** Human-readable note for a response truncated at the output-token limit. */
  private truncationNote(reasoningAteBudget: boolean): string {
    const maxTokens = this.deps.config.get().maxTokens;
    const shown =
      typeof maxTokens === "number" && Number.isFinite(maxTokens) ? `, max output tokens = ${maxTokens}` : "";
    return (
      "Output truncated by the token limit (finish_reason=length" +
      `${shown})` +
      (reasoningAteBudget ? " — the reasoning likely consumed the whole budget" : "") +
      ". Raise the session's Output tokens (or `harny.maxTokens`), or shorten the request/reasoning, and ask me to continue."
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
    const kept = this.delegationEnabled
      ? all
      : (() => {
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
        })();
    // Old tool results become one-line stubs IN THIS VIEW (see
    // observation-masking.ts): the newest output stays verbatim, the rest stops
    // consuming the window without touching the stored history. It changes
    // `content` only, so it cannot affect the wire rules checked just below.
    const usable = this.deps.contextBudget?.() ?? 0;
    if (usable <= 0) return kept;
    const { messages, masked, savedTokens } = maskOldToolResults(kept, maskKeepTokens(usable), estimateTokens);
    if (masked > 0) this.log(`masked ${masked} old tool result(s), ~${savedTokens} tokens saved`);
    return messages;
  }

  /**
   * A one-line, ALWAYS-PRESENT state banner prepended to the system prompt on
   * EVERY turn, so the model cannot miss the current mode / Parallel state
   * (a tool would require the model to call it — this does not).
   */
  private stateLine(): string {
    const readOnly = isAnalyzeMode(this.turnMode);
    const mode = readOnly
      ? "Analyze — READ-ONLY PREVIEW: you can PREPARE changes (Write/Edit/StrReplace/Delete run as " +
        "VALIDATED diff previews) but nothing is applied; finish by telling the user to switch to Build to apply"
      : "Build — you CAN create, modify and delete files";
    // Parallel OFF: the model must not even know that sub-tasks exist, so the
    // state banner says nothing about Parallel.
    if (!this.delegationEnabled) return `[CURRENT STATE] Mode: ${mode}.`;
    return (
      `[CURRENT STATE] Mode: ${mode}. Parallel: ON — PARALLELISM MEANS SUB-TASKS: the ONLY way to run work in ` +
      `parallel is one Delegate per independent item; your own tool calls run one after another (serially).`
    );
  }

  /** Build the per-turn `meta` (REAL usage + wall-clock timings) for an assistant message. */
  private turnMeta(r: {
    usage?: Usage;
    startedAt: number;
    firstTokenAt?: number;
    endedAt?: number;
    model?: string;
    modelProvider?: string;
    contextWindow?: number;
    maxTokens?: number;
  }): MessageMeta {
    const endedAt = r.endedAt ?? Date.now();
    return {
      ...(r.model ? { model: r.model } : {}),
      ...(r.modelProvider ? { provider: r.modelProvider } : {}),
      ...(typeof r.contextWindow === "number" ? { contextWindow: r.contextWindow } : {}),
      ...(typeof r.maxTokens === "number" ? { maxTokens: r.maxTokens } : {}),
      ...(r.usage
        ? {
            inputTokens: r.usage.input,
            outputTokens: r.usage.output,
            totalTokens: r.usage.total,
            ...(typeof r.usage.cached === "number" ? { cachedTokens: r.usage.cached } : {}),
            ...(typeof r.usage.cachedWrite === "number" ? { cachedWriteTokens: r.usage.cachedWrite } : {}),
          }
        : {}),
      startedAt: r.startedAt,
      ...(r.firstTokenAt !== undefined ? { firstTokenAt: r.firstTokenAt, ttftMs: r.firstTokenAt - r.startedAt } : {}),
      endedAt,
      durationMs: endedAt - r.startedAt,
    };
  }

  /**
   * A turn, with recovery from a context overflow: when the provider rejects the
   * request because the input is too big, compact the session and send the SAME
   * turn again (bounded). For the user this is the difference between a session
   * that dies and one that keeps working.
   *
   * Only reachable BEFORE a token is streamed: an overflow is a 4xx on the POST,
   * so nothing was emitted and the retry cannot duplicate output.
   */
  private async runLlmTurnWithOverflowRecovery(toolDefinitionsOverride?: ToolDefinition[]): Promise<Awaited<ReturnType<Agent["runLlmTurn"]>>> {
    const maxRecoveries = 2;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.runLlmTurn(toolDefinitionsOverride);
      } catch (err) {
        const signal = this.abortController?.signal;
        if (attempt >= maxRecoveries || !signal || signal.aborted || !this.deps.onContextOverflow) throw err;
        if (!this.isOverflowRejection(err)) throw err;
        const signature = matchedOverflowSignature(err);
        const limitTokens = overflowLimitFromError(err);
        this.log(
          `context overflow (${signature ?? "wording not recognised"}${
            limitTokens ? `, provider states ${limitTokens} tokens` : ""
          }) -> compacting and retrying the turn (${attempt + 1}/${maxRecoveries})`,
        );
        const compacted = await this.deps.onContextOverflow(signal, {
          ...(signature ? { signature } : {}),
          ...(limitTokens ? { limitTokens } : {}),
        });
        // Nothing to compact (or it failed): do not retry the same request twice.
        if (!compacted) throw err;
      }
    }
  }

  /**
   * True when a failure is (or very likely is) a context overflow.
   *
   * Two independent legs, on purpose: a provider's WORDING (see
   * context-overflow.ts for the families) or — when we cannot read it — its own
   * status plus OUR estimate of the request we just sent. Without the second leg,
   * any backend that phrases the limit differently would still kill the session;
   * with it, an unreadable 4xx sent at the ceiling is treated as size, and the
   * cost of being wrong is one compaction.
   */
  private isOverflowRejection(err: unknown): boolean {
    if (isContextOverflowError(err)) return true;
    if (!isRequestRejection(err)) return false;
    const budget = this.deps.contextBudget?.() ?? 0;
    if (budget <= 0) return false;
    return this.estimatedRequestTokens() >= budget * 0.9;
  }

  /**
   * Size of the request this turn sends, by the same estimate the footer uses.
   * Deliberately independent of the provider: it is what makes the second leg of
   * {@link Agent.isOverflowRejection} work for any backend.
   */
  private estimatedRequestTokens(): number {
    // Built from the TURN's mode, like the request it estimates (see turnMode): an
    // estimate that used a different mode than the request would be off by the whole
    // write-tool set, and this is the leg that decides whether a rejection was size.
    const system = this.deps.systemPrompt.build(this.turnMode, this.deps.tools.definitions());
    return this.llmConversation().reduce(
      (total, m) =>
        total +
        estimateTokens(m.content ?? "") +
        estimateTokens((m.toolCalls ?? []).map((tc) => JSON.stringify(tc.arguments)).join("")),
      estimateTokens(system),
    );
  }

  private async runLlmTurn(toolDefinitionsOverride?: ToolDefinition[]): Promise<{
    content: string;
    toolCalls: ToolCall[];
    thinking: string;
    reasoningDetails?: unknown[];
    /** Provider finish reason for this turn ("length" = output-token limit). */
    finishReason?: string;
    /** The model/provider/budget this turn ACTUALLY ran with (read from the
     * config at request time, so it follows a mid-session model switch). */
    model: string;
    modelProvider?: string;
    contextWindow?: number;
    maxTokens?: number;
    /** True when the loop guard cut this turn short because the reasoning
     * repeated itself; the caller must nudge instead of executing tools. */
    reasoningLoop?: boolean;
    /** True when the opt-in RESPONSE guard cut the visible answer short because
     * it repeated itself; the caller must nudge instead of executing tools. */
    answerLoop?: boolean;
    /** Provider-reported token usage for this turn (undefined = not reported). */
    usage?: Usage;
    /** Wall-clock start of the LLM request (ms epoch). */
    startedAt: number;
    /** Wall-clock epoch of the first streamed token (undefined = none). */
    firstTokenAt?: number;
    /** Wall-clock end of the turn (ms epoch). */
    endedAt: number;
  }> {
    const config = this.deps.config.get();
    const provider = this.deps.llmFactory.create(config);
    // Mode-filtered tool set: in Analyze the file-mutating tools stay LISTED but carry
    // the PREVIEW note (so the model knows a write prepares a diff), and the execution
    // side below runs them dry — the tool list is the first layer, never the only one.
    // `exclude` is how Parallel OFF keeps Delegate out of the model's sight entirely.
    // An explicit [] (forced final report) makes the turn tool-less.
    const modeDefs = toolDefinitionsForMode(this.deps.tools.getAll(), this.turnMode, {
      exclude: this.delegationEnabled ? [] : [DELEGATE_TOOL_NAME],
    });
    const toolDefinitions: ToolDefinition[] = toolDefinitionsOverride ?? modeDefs;

    const messages: LLMMessage[] = [
      { role: "system", content: `${this.stateLine()}\n\n${this.deps.systemPrompt.build(this.turnMode, toolDefinitions)}` },
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

    // The pairing invariant, at the LAST point before the wire. A violation is
    // rejected by the provider on THIS and on every later request, with a message
    // ("insufficient tool messages following tool_calls") that says nothing about
    // where the damage is, so it is named here instead. Deliberately NOT repaired:
    // a silent fix would hide whichever writer produced it, and this check exists
    // precisely to keep that producer visible.
    const pairing = conversationFaults(messages);
    if (pairing.length > 0) {
      const detail = describeFaults(pairing);
      this.log(`tool-call pairing violation -> request refused: ${detail}`);
      throw new Error(
        `Harny internal error: this conversation is not replayable (${detail}). ` +
          "The request was NOT sent: the provider would reject it, and every request after it. " +
          "This is a bug in Harny, not in the provider — the session cannot continue, but the cause is " +
          "now named here and in Output \u203a Harny.",
      );
    }

    const accumulator = new ToolCallAccumulator();
    let content = "";
    let thinking = "";
    let reasoningDetails: unknown[] | undefined;
    let finishReason: string | undefined;
    let reasoningLoop = false;
    let answerLoop = false;
    const toolCalls: ToolCall[] = [];
    let usage: Usage | undefined;
    let firstTokenAt: number | undefined;

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

    // Stream watchdog: log the start plus a periodic heartbeat, so a STALLED
    // provider stream is visible after the fact (Output > Harny; persisted to a
    // file when HARNY_DEBUG=1). If a sub-agent "hangs", the last heartbeat shows
    // whether the model stopped emitting, a tool never returned, etc.
    const streamStart = Date.now();
    let chunkCount = 0;
    let lastChunkAt = streamStart;
    this.log(`stream: start model=${config.model} msgs=${messages.length} tools=${toolDefinitions.length}`);
    const heartbeat = this.deps.log
      ? setInterval(() => {
          const elapsed = Math.round((Date.now() - streamStart) / 1000);
          const since = Math.round((Date.now() - lastChunkAt) / 1000);
          this.log(
            `stream: waiting ${elapsed}s (${since}s since last chunk) chunks=${chunkCount} ` +
              `content=${content.length}c thinking=${thinking.length}c tools=${toolCalls.length}`,
          );
        }, 15000)
      : undefined;

    // Idle watchdog: abort the turn if the provider sends NOTHING for too long
    // (dead connection / stuck server). Reset on every chunk; armed BEFORE the
    // first chunk so a hung CONNECT (no response headers) is covered too.
    const idleTimeoutMs = this.deps.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    let idleTimedOut = false;
    let idleTimer: NodeJS.Timeout | undefined;
    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        this.log(`stream: idle for ${idleTimeoutMs}ms — aborting the turn`);
        turnAbort.abort();
      }, idleTimeoutMs);
    };
    armIdle();

    try {
      for await (const chunk of provider.stream(messages, turnAbort.signal, toolDefinitions)) {
        chunkCount++;
        lastChunkAt = Date.now();
        armIdle();
        if (chunk.type === "text") {
          // Time to first token: the first CONTENT chunk, not any chunk.
          if (firstTokenAt === undefined) firstTokenAt = Date.now();
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
          if (firstTokenAt === undefined) firstTokenAt = Date.now();
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
          usage = chunk.usage;
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

        // Within-turn RESPONSE loop (opt-in): cut the visible answer and nudge.
        if (!answerLoop && this.guard.observeAnswer(content)) {
          answerLoop = true;
          turnAbort.abort();
          break;
        }
      }
    } catch (err) {
      // A real user Stop must propagate; an idle-timeout must be reported as an
      // error; a guard-initiated cut must not.
      if (this.abortController!.signal.aborted) throw err;
      if (idleTimedOut) throw streamIdleError(idleTimeoutMs);
      if (!reasoningLoop && !answerLoop) throw err;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (idleTimer) clearTimeout(idleTimer);
      this.abortController!.signal.removeEventListener("abort", linkMainAbort);
    }

    // A user Stop must end the run even when the provider resolved the stream
    // cleanly instead of throwing (some providers/mocks do).
    if (this.abortController!.signal.aborted) {
      const abortErr = new Error("Aborted");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    // Same for an idle timeout that a mock provider may not have surfaced.
    if (idleTimedOut) throw streamIdleError(idleTimeoutMs);

    this.log(
      `stream: end after ${Math.round((Date.now() - streamStart) / 1000)}s chunks=${chunkCount} ` +
        `content=${content.length}c thinking=${thinking.length}c tools=${toolCalls.length} finish=${finishReason ?? "-"}`,
    );
    return {
      content,
      toolCalls,
      thinking,
      reasoningDetails,
      finishReason,
      reasoningLoop,
      answerLoop,
      usage,
      // Identity of the turn: the model may differ from the previous one (the
      // user switches mid-session), and so may the budget it runs with.
      model: config.model,
      modelProvider: config.activeProvider,
      contextWindow: config.contextWindow,
      maxTokens: config.maxTokens,
      startedAt: streamStart,
      firstTokenAt,
      endedAt: Date.now(),
    };
  }

  /** The Analyze policy of a tool, by name. Unknown ⇒ `refuse` (see AnalyzePolicy). */
  private analyzePolicyFor(name: string): AnalyzePolicy {
    return this.deps.tools.get(name)?.analyzePolicy ?? DEFAULT_ANALYZE_POLICY;
  }

  private async executeToolSafely(tc: ToolCall): Promise<ToolResult> {
    // Delegate is executed by the orchestrator (not the generic tool path):
    // it owns the session's sub-agent runner and the depth-1 policy — and it is where
    // Parallel OFF is refused (see executeDelegate), the execution-side layer behind
    // the tool list.
    if (tc.name === DELEGATE_TOOL_NAME) return this.executeDelegate(tc);
    const tool: Tool | undefined = this.deps.tools.get(tc.name);
    if (!tool) return { content: `Unknown tool: ${tc.name}`, isError: true };
    // Analyze (read-only PREVIEW) mode — the promise is "no resource is modified", and
    // the TOOL says how it keeps it (see AnalyzePolicy). The default is `refuse`: a tool
    // nobody described (a new MCP server, a plugin, a tool added tomorrow) is NOT assumed
    // harmless. Defense in depth, never trust the model… and never trust a name list
    // either: that is how an MCP `drop_table` used to run for real in Analyze.
    const policy = this.analyzePolicyFor(tc.name);
    let dryRun = false;
    if (isAnalyzeMode(this.turnMode)) {
      if (policy === "refuse") {
        return { content: analyzeRefusalMessage(tool), isError: true };
      }
      if (policy === "guarded") {
        const why = tool.guardAnalyze?.(tc.arguments);
        if (why) return { content: why, isError: true };
      }
      dryRun = policy === "preview";
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
      // `ownerId` lets stateful tools (TodoWrite) keep PER-conversation state,
      // so concurrent sub-agents never clobber each other's list. `signal` lets
      // long-running tools (Shell) be cancelled by a user Stop.
      const ctx: import("../tools/tool").ToolContext = {
        ...(dryRun ? { dryRun: true } : {}),
        ...(this.deps.ownerId ? { ownerId: this.deps.ownerId } : {}),
        ...(this.abortController ? { signal: this.abortController.signal } : {}),
        // The session's usable window, so a tool that emits large output sizes its
        // cap against THIS model instead of a constant (see output-budget.ts).
        ...(this.deps.contextBudget ? { contextBudget: this.deps.contextBudget() } : {}),
      };
      let result = await tool.execute(tc.arguments, ctx);
      // A tool result is NEVER blank: `grep` with no match, `mkdir -p`, a silent
      // command… all legally return "". An empty `tool` message is rejected by
      // strict servers and tells the model nothing (did it run? fail? do
      // nothing?), so the placeholder is produced HERE, at the single point every
      // tool result passes through (rule 5 of conversation-validity).
      if (!result.content.trim()) result = { ...result, content: `${tc.name}: no output` };
      // Remember that a preview was prepared so the final answer can be made
      // unambiguous (the model may still claim it "applied" the change).
      if (dryRun && !result.isError) {
        const path = String(tc.arguments.path ?? "").trim() || "(unknown)";
        if (!this.preparedChanges.has(path)) this.preparedChanges.set(path, tc.name);
        // Tell the parent (when this agent is a sub-agent) that a preview was
        // prepared, so the orchestrator surfaces the "Switch to Build" CTA.
        this.deps.onPreviewPrepared?.({ path, tool: tc.name });
      }
      // A REAL file change (Build, not a preview): let the parent track it.
      if (!dryRun && !result.isError && this.analyzePolicyFor(tc.name) === "preview") {
        const changed = String(tc.arguments.path ?? "").trim();
        if (changed) this.deps.onFileChanged?.({ path: changed, tool: tc.name });
      }
      return result;
    } catch (err: any) {
      return { content: `Tool error (${tc.name}): ${err.message || String(err)}`, isError: true };
    }
  }

  /** Analyze prepared changes (by this agent OR one of its sub-agents) that are
   * NOT applied: the final answer gets the "Switch to Build" call to action. */
  private hasUnappliedPreviews(): boolean {
    if (!this.mayDelegate || !isAnalyzeMode(this._mode)) return false;
    return this.preparedChanges.size > 0 || this.subAgentChanges.size > 0;
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
    const hasSwitchLine = /switch to\s*\**build\**/i.test(content);
    // No preview was prepared (or not in Analyze): a "switch to Build / apply"
    // note is superfluous — the model often adds it on its own. DROP it so a
    // pure question/analysis answer does not end with a bogus call to action.
    if (!this.hasUnappliedPreviews()) {
      if (!hasSwitchLine) return content;
      return content
        .split("\n")
        .filter((line) => !/switch to\s*\**build\**/i.test(line))
        .join("\n")
        .replace(/\n+(?:-{3,}\s*)$/, "")
        .trimEnd();
    }
    // Changes WERE prepared: guarantee the explicit "nothing applied" footer,
    // without duplicating the hint if the model already included it. (The CTA
    // in the UI is triggered by the message flag, NOT by this text.)
    if (hasSwitchLine) return content;
    const merged = new Map<string, string>(this.preparedChanges);
    for (const [p, n] of this.subAgentChanges) if (!merged.has(p)) merged.set(p, n);
    const list = [...merged.entries()].map(([path, name]) => `- ${name} \`${path}\``).join("\n");
    const detail = list
      ? `these changes were prepared as **previews** and are NOT on disk:\n${list}`
      : "the changes prepared by the sub-agents are **previews** and are NOT on disk.";
    return `${content}\n\n---\n⚠️ ${PREVIEW_FOOTER_MARKER}: ${detail}\n${BUILD_SWITCH_HINT}`;
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
    // Read-only (Analyze) mode must never delegate a WRITER: that would bypass
    // the read-only guarantee.
    if (isAnalyzeMode(this.turnMode) && spec.access !== "read") {
      return {
        content: '⛔ Analyze (read-only) mode: sub-agents may only be delegated with access "read".',
        isError: true,
      };
    }
    // The user aborted THIS sub-task from its bubble: never start it (covers a
    // sub-agent still QUEUED behind the concurrency cap) and tell the
    // orchestrator it was aborted so it can adjust its plan.
    if (this.abortedDelegates.has(tc.id)) {
      return { content: formatSubAgentAborted(spec), isError: true };
    }
    // Forward to the sub-agent the attachments its sub-task needs (by number),
    // defaulting to ALL of them when the orchestrator did not specify any.
    const forwarded = this.resolveAttachments(spec.attachments);
    const resolvedSpec: DelegateSpec = { ...spec, images: forwarded.images, attachmentText: forwarded.text };
    try {
      // Signal the UI that this sub-agent is STARTING now (queued → running):
      // with a concurrency cap, several delegates may be queued behind others.
      this.deps.events.emit({ type: "subagent_start", toolCallId: tc.id });
      // Forward the sub-agent's live events into its bubble (nested streaming).
      const onEvent = (event: import("./types").SubAgentEvent) =>
        this.deps.events.emit({ type: "subagent_event", toolCallId: tc.id, event });
      return await this.deps.spawnSubAgent(resolvedSpec, onEvent, this.abortController?.signal, tc.id, (change) => {
        if (!this.subAgentChanges.has(change.path)) this.subAgentChanges.set(change.path, change.tool);
      });
    } catch (err: any) {
      return { content: formatSubAgentError(resolvedSpec, err?.message || String(err)), isError: true };
    }
  }

  /**
   * Resolve a Delegate's `attachments` selection to the actual data to forward
   * to the sub-agent: image data URIs (multimodal) + inline text. No selection
   * (or an empty one) means ALL of the current user message's attachments.
   */
  private resolveAttachments(indices?: number[]): { images: string[]; text: string } {
    const parts = this.currentAttachmentParts;
    if (parts.length === 0) return { images: [], text: "" };
    const chosen =
      indices && indices.length > 0
        ? indices.map((n) => parts[n - 1]).filter((p): p is AttachmentPart => !!p)
        : parts;
    const effective = chosen.length > 0 ? chosen : parts;
    const images = effective.filter((p) => p.isImage && p.dataUri).map((p) => p.dataUri as string);
    const text = effective
      .filter((p) => !p.isImage && p.text)
      .map((p) => `Attached file "${p.name}":\n\`\`\`\n${p.text}\n\`\`\``)
      .join("\n\n");
    return { images, text };
  }
}
