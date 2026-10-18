import type { ConfigProvider } from "../config/types";
import type { ChatMessage } from "../history/types";
import type { ChatHistory } from "../history/chat-history";
import { InMemoryChatHistory } from "../history/in-memory-chat-history";
import { InMemoryEventBus } from "../events/in-memory-event-bus";
import type { LLMProviderFactory } from "../llm/types";
import type { ToolRegistry, ToolResult } from "../tools";
import { toolDefinitionsForMode, type ChatMode } from "../tools/mode-policy";
import type { LoopGuardOptions } from "./loop-guard";
import { Agent } from "./agent";
import type { ContextOverflowEvidence } from "./agent";
import type { ChatController } from "./chat-controller";
import type { AgentEvent, SubAgentEvent, PreparedChange } from "./types";
import type { SkillMeta } from "../skills/types";
import {
  DELEGATE_TOOL_NAME,
  buildSubAgentTask,
  formatSubAgentAborted,
  formatSubAgentError,
  formatSubAgentReport,
  type DelegateSpec,
} from "./orchestration";
import { SubAgentSystemPromptBuilder } from "./system-prompt";

/** Turn budget for a sub-agent: bounded work, but generous enough for real
 * exploration with verbose models (DeepSeek and friends). When the budget is
 * exhausted the agent still runs ONE forced, tool-less report turn. */
export interface SubAgentRunnerDeps {
  config: ConfigProvider;
  llmFactory: LLMProviderFactory;
  tools: ToolRegistry;
  cwd: () => string;
  /** Installed Agent Skills (catalog only): a sub-agent gets the SAME catalog as the
   * orchestrator, so it can activate a skill on its own when the task matches one. The
   * orchestrator can still point it at a specific skill in the Delegate goal/context.
   * Absent = an empty catalog (no `## Skills` section, the pre-feature behaviour). */
  skills?: () => readonly SkillMeta[];
  /** Optional turn budget per sub-agent (undefined = UNBOUNDED, like the
   * orchestrator: the loop guard + Stop are the safeguards). */
  maxTurns?: number;
  /** The SESSION's usable context (window − output reserve), in tokens. A sub-agent
   * runs on the same model as its session, so it must size its own memory of the
   * window the same way: without it, a sub-agent gets no observation masking, keeps
   * the FIXED tool-output caps (50KB is an entire 8k context) and can only detect an
   * overflow from the provider's wording (see core/agent/agent.ts). Absent = the
   * pre-budget behaviour. */
  contextBudget?: () => number;
  /** This SESSION's resolved Loop Guard options (preset + response + ephemeral
   * overrides). A sub-agent is part of the session's work, so a guard tuned for a
   * flaky model must protect it too — otherwise the README's "sub-agents share the
   * loop guard" would only mean "they have a default one". Read per run, so a change
   * made in the UI applies to the next sub-agent. Absent = the default preset. */
  loopGuard?: () => LoopGuardOptions;
  /** Why an overflow reaches the host here too: the sub-agent's history is EPHEMERAL
   * (the runner owns it), so the session's compaction routine cannot act on it — the
   * host compacts THIS history with the same strategy a session uses and answers
   * whether it changed anything. Absent = an overflow ends the sub-agent. */
  onContextOverflow?: (history: ChatHistory, signal: AbortSignal, evidence: ContextOverflowEvidence) => Promise<boolean>;
  /** Called at every turn boundary of a sub-agent, with ITS history: the session frees
   * room there too (`maybeCompactDuringRun`), and a sub-agent — unbounded, and full of
   * heavy reads — is the one that needs it most. The host decides whether the threshold
   * is crossed. Absent = the sub-agent only recovers on a refusal. */
  onTurnBoundary?: (history: ChatHistory, signal: AbortSignal) => Promise<boolean | void> | boolean | void;
  /** Optional diagnostic sink; sub-agent lines are tagged with their id. */
  log?: (message: string) => void;
}

/**
 * Runs delegated sub-agents for ONE session. Each run gets a fresh in-memory
 * history (ephemeral — never written to the session file), the SHARED tool
 * registry and LLM factory, its own system prompt and (by default) NO turn
 * cap — like the orchestrator, a sub-agent runs until it finishes or is
 * stopped; the loop guard breaks degenerate loops. Sub-agents cannot delegate
 * further (depth 1). The runner tracks active sub-agents so the parent's Stop
 * aborts them all (cascade).
 */
export class SubAgentRunner {
  /** Running sub-agents keyed by the Delegate tool-call id, so ONE can be
   * aborted from its UI bubble without touching its siblings. */
  private active = new Map<string, ChatController>();
  /** Sub-agents the user stopped (whole-run Stop OR per-sub-task abort): their
   * run is reported as ABORTED, not done. */
  private abortedAgents = new WeakSet<ChatController>();
  /** Fallback key counter for runs without a tool-call id (direct/test calls). */
  private nextKey = 0;

  constructor(private deps: SubAgentRunnerDeps) {}

  /** Abort every in-flight sub-agent (called when the parent run is aborted). */
  abortAll(): void {
    for (const agent of this.active.values()) {
      this.abortedAgents.add(agent);
      agent.abort();
    }
    this.active.clear();
  }

  /** Abort ONE running sub-agent by its Delegate tool-call id. No-op when it is
   * not running (already finished, or still QUEUED — the Agent skips a queued
   * one via its own pending-abort set). */
  abort(toolCallId: string): void {
    const agent = this.active.get(toolCallId);
    if (!agent) return;
    this.abortedAgents.add(agent);
    agent.abort();
    this.active.delete(toolCallId);
  }

  get activeCount(): number {
    return this.active.size;
  }

  /** Run one delegated sub-task and return its report as a tool result.
   * `onEvent` (optional) receives the sub-agent's live events so the caller
   * can stream them into the sub-agent bubble. */
  async run(
    spec: DelegateSpec,
    onEvent?: (event: SubAgentEvent) => void,
    signal?: AbortSignal,
    /** The Delegate tool-call id: the key that lets the host abort THIS
     * sub-agent from its UI bubble. Absent for direct/test calls. */
    toolCallId?: string,
    /** Forwarded to the sub-agent: called when it prepares an Analyze preview,
     * so the orchestrator can surface the "Switch to Build" CTA. */
    onPreviewPrepared?: (change: PreparedChange) => void,
  ): Promise<ToolResult> {
    // Stop arrived BEFORE this sub-agent started: never start it (queued -> aborted).
    if (signal?.aborted) return { content: formatSubAgentAborted(spec) + structuredFooter("aborted", [], []), isError: true };
    const key = toolCallId ?? `sub-${this.nextKey++}`;
    // Analyze-style read-only sub-agent, or a full agent for writers.
    const mode: ChatMode = spec.access === "read" ? "analyze" : "agent";
    const history = new InMemoryChatHistory();
    const events = new InMemoryEventBus<AgentEvent>();
    // Optional per-run cap (internal/test knob). Undefined = UNBOUNDED, like the
    // orchestrator: the loop guard + Stop are the safeguards, not a turn cap.
    const maxTurns = this.deps.maxTurns;
    const systemPrompt = new SubAgentSystemPromptBuilder(
      (m) => toolDefinitionsForMode(this.deps.tools.getAll(), m, { exclude: [DELEGATE_TOOL_NAME] }),
      this.deps.cwd,
      { role: spec.role, access: spec.access, resources: spec.resources, turnBudget: maxTurns },
      this.deps.skills,
    );

    // Preview changes this sub-agent prepares (Analyze only): forwarded to the
    // orchestrator (CTA) AND used to tell it the sub-task needed write access.
    const prepared: PreparedChange[] = [];
    const forwardPreview = (change: PreparedChange): void => {
      prepared.push(change);
      onPreviewPrepared?.(change);
    };
    // Files the sub-agent ACTUALLY wrote (Build mode), for the structured report.
    const touched = new Set<string>();

    const agent = new Agent({
      config: this.deps.config,
      llmFactory: this.deps.llmFactory,
      tools: this.deps.tools,
      history,
      events,
      systemPrompt,
      maxTurns,
      allowDelegation: false,
      // Never end a heavy sub-agent with a bare "turn limit": force a final
      // tool-less report turn so the caller always gets a usable synthesis.
      forceFinalReportOnLimit: true,
      cwd: this.deps.cwd,
      // Same session, same window: the sub-agent sizes its masking and its tool
      // caps on the budget the host knows (see SubAgentRunnerDeps.contextBudget).
      contextBudget: this.deps.contextBudget,
      // …and this session's guard, not a default one (see deps.loopGuard).
      ...(this.deps.loopGuard ? { loopGuard: this.deps.loopGuard() } : {}),
      // …and the SAME recovery as its session, applied to ITS OWN history: the host
      // compacts it (one strategy, see core/sessions/compactHistory) and the turn is
      // retried. Without this an overflow would end the sub-task instead.
      onContextOverflow: (signal, evidence) =>
        this.deps.onContextOverflow ? this.deps.onContextOverflow(history, signal, evidence) : false,
      // The same turn-boundary release the session gets (see deps.onTurnBoundary). The
      // Agent's hook takes no answer, so the host's verdict (did it free room?) is
      // dropped here — it only logs it.
      ...(this.deps.onTurnBoundary
        ? {
            onTurnBoundary: async (signal: AbortSignal): Promise<void> => {
              await this.deps.onTurnBoundary!(history, signal);
            },
          }
        : {}),
      // Each sub-agent has its OWN tool state (TodoWrite): concurrent sub-agents
      // must never clobber each other's list.
      ownerId: `sub-${key}`,
      // Bubble an Analyze preview up to the orchestrator (CTA for delegated work).
      onPreviewPrepared: forwardPreview,
      // Track the files it actually wrote (Build), for the report footer.
      onFileChanged: (change) => touched.add(change.path),
      log: this.deps.log ? (m) => this.deps.log!(`subagent "${spec.id}": ${m}`) : undefined,
    });
    agent.setMode(mode);

    // Forward the sub-agent's live activity (thinking / text / tools) to the
    // caller, tagged by the Delegate tool call — nested streaming in the UI.
    // On abort we DROP the sub-agent's own "done" (it was aborted, not
    // finished) so the UI can mark it aborted instead of done. We ALWAYS
    // subscribe (even without `onEvent`) to detect a failed run: the Agent
    // reports a fatal error (API/loop stop) as an `error` event and does NOT
    // throw, so without this a failed sub-agent would be reported as a
    // successful report.
    let hadError = false;
    events.subscribe((e) => {
      if (e.type === "error") hadError = true;
      if (!onEvent) return;
      if (e.type === "done" && this.abortedAgents.has(agent)) return;
      const sub = toSubAgentEvent(e);
      if (sub) onEvent(sub);
    });

    this.active.set(key, agent);
    // Link the parent abort signal so a sub-agent that starts JUST as the user
    // presses Stop is aborted too (closes the start/abort race).
    const onParentAbort = (): void => {
      this.abortedAgents.add(agent);
      agent.abort();
    };
    signal?.addEventListener("abort", onParentAbort);
    // Lifecycle log: start + end (with duration and outcome) so a sub-agent that
    // "hangs" is visible after the fact (Output > Harny; file with HARNY_DEBUG=1).
    const startedAt = Date.now();
    this.deps.log?.(
      `subagent "${spec.id}" start: access=${spec.access} resources=${spec.resources.length} ` +
        `maxTurns=${maxTurns ?? "\u221e"} key=${key}`,
    );
    try {
      // Forward the attachments the orchestrator selected for this sub-task.
      const task =
        buildSubAgentTask(spec) + (spec.attachmentText ? `\n\n${spec.attachmentText}` : "");
      await agent.send(task, { images: spec.images });
      // Any user stop (whole-run Stop or a per-sub-task abort) is reported as
      // ABORTED — sub-agents have a single terminal stop state.
      if (this.abortedAgents.has(agent) || signal?.aborted) {
        return { content: formatSubAgentAborted(spec) + structuredFooter("aborted", touched, prepared), isError: true };
      }
      // A fatal error (API failure, loop guard stop, no API key) reached the
      // transcript as an `error` event: report it as an ERROR result so the
      // orchestrator knows the sub-task did NOT complete (it must not treat the
      // text as a finished report).
      const report = lastAssistantReport(agent.getMessages());
      if (hadError) {
        return { content: formatSubAgentError(spec, report) + structuredFooter("error", touched, prepared), isError: true };
      }
      const base = formatSubAgentReport(spec, report);
      // A READ-ONLY sub-agent that prepared previews could not write: make that
      // explicit and machine-obvious so the orchestrator re-delegates a writer.
      const needsWrite = mode === "analyze" && prepared.length > 0;
      const content =
        (needsWrite ? base + subAgentEscalationNote(prepared) : base) +
        structuredFooter(needsWrite ? "needs-write" : "done", touched, prepared);
      return { content, isError: false };
    } catch (e) {
      this.deps.log?.(`subagent "${spec.id}" error in ${Date.now() - startedAt}ms: ${e instanceof Error ? e.message : String(e)}`);
      return {
        content: formatSubAgentError(spec, e instanceof Error ? e.message : String(e)) + structuredFooter("error", touched, prepared),
        isError: true,
      };
    } finally {
      this.deps.log?.(`subagent "${spec.id}" end in ${Date.now() - startedAt}ms`);
      signal?.removeEventListener("abort", onParentAbort);
      this.active.delete(key);
    }
  }
}

/** Marker prefixing the machine-readable facts appended to every sub-agent
 * report. The orchestrator can trust these over the prose, and tooling can
 * parse them (JSON after the marker). */
export const SUBAGENT_REPORT_MARKER = "[harny-subagent-report]";

/** Append host-generated FACTS (status + touched files + prepared previews) to a
 * sub-agent report, so the orchestrator reads facts instead of interpreting
 * free text. */
function structuredFooter(
  status: "done" | "needs-write" | "error" | "aborted",
  filesTouched: Iterable<string>,
  previews: readonly PreparedChange[],
): string {
  return (
    `\n\n${SUBAGENT_REPORT_MARKER} ` +
    JSON.stringify({ status, filesTouched: [...filesTouched], previews: previews.map((p) => p.path) })
  );
}

/** Deterministic note appended to a READ-ONLY sub-agent's report when it
 * prepared previews: it could not write, so the orchestrator must re-delegate
 * with access "write" to apply them. Host-generated, so it cannot be forgotten
 * by a weak model. */
function subAgentEscalationNote(changes: readonly PreparedChange[]): string {
  const list = changes.map((c) => `- ${c.tool} \`${c.path}\``).join("\n");
  return (
    `\n\n⛔ This sub-agent ran READ-ONLY and could NOT write: it prepared previews for\n${list}\n` +
    `Re-delegate this sub-task with access "write" (and those resources) to apply them in Build.`
  );
}

/** Keep only the sub-agent events worth streaming (drop usage / raw chunks). */
export function toSubAgentEvent(e: AgentEvent): SubAgentEvent | undefined {
  switch (e.type) {
    case "text_delta":
    case "thinking_delta":
    case "tool_call":
    case "tool_result":
    case "done":
    case "error":
      return e;
    default:
      return undefined;
  }
}

/** The sub-agent's final answer: the last assistant message with text that is
 * not a pending tool-call turn and is visible to the model. */
export function lastAssistantReport(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.content || m.uiOnly) continue;
    if (m.toolCalls && m.toolCalls.length > 0) continue;
    return m.content;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.content && !m.uiOnly) return m.content;
  }
  return "(no report produced)";
}
