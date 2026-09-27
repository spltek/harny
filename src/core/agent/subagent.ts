import type { ConfigProvider } from "../config/types";
import type { ChatMessage } from "../history/types";
import { InMemoryChatHistory } from "../history/in-memory-chat-history";
import { InMemoryEventBus } from "../events/in-memory-event-bus";
import type { LLMProviderFactory } from "../llm/types";
import type { ToolRegistry, ToolResult } from "../tools";
import { toolDefinitionsForMode, type ChatMode } from "../tools/mode-policy";
import { Agent } from "./agent";
import type { ChatController } from "./chat-controller";
import type { AgentEvent, SubAgentEvent } from "./types";
import {
  DELEGATE_TOOL_NAME,
  buildSubAgentTask,
  formatSubAgentError,
  formatSubAgentInterrupted,
  formatSubAgentReport,
  type DelegateSpec,
} from "./orchestration";
import { SubAgentSystemPromptBuilder } from "./system-prompt";

/** Turn budget for a sub-agent: bounded work, but generous enough for real
 * exploration with verbose models (DeepSeek and friends). When the budget is
 * exhausted the agent still runs ONE forced, tool-less report turn. */
export const SUBAGENT_MAX_TURNS = 100;

export interface SubAgentRunnerDeps {
  config: ConfigProvider;
  llmFactory: LLMProviderFactory;
  tools: ToolRegistry;
  cwd: () => string;
  /** Turn budget per sub-agent (default SUBAGENT_MAX_TURNS). */
  maxTurns?: number;
  /** Optional diagnostic sink; sub-agent lines are tagged with their id. */
  log?: (message: string) => void;
}

/**
 * Runs delegated sub-agents for ONE session. Each run gets a fresh in-memory
 * history (ephemeral — never written to the session file), the SHARED tool
 * registry and LLM factory, its own system prompt and a bounded turn budget.
 * Sub-agents cannot delegate further (depth 1). The runner tracks active
 * sub-agents so the parent's Stop aborts them all (cascade).
 */
export class SubAgentRunner {
  private active = new Set<ChatController>();
  /** Sub-agents aborted by the parent (Stop): their run is INTERRUPTED, not done. */
  private abortedAgents = new WeakSet<ChatController>();

  constructor(private deps: SubAgentRunnerDeps) {}

  /** Abort every in-flight sub-agent (called when the parent run is aborted). */
  abortAll(): void {
    for (const agent of this.active) {
      this.abortedAgents.add(agent);
      agent.abort();
    }
    this.active.clear();
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
  ): Promise<ToolResult> {
    // Stop arrived BEFORE this sub-agent started: never start it (queued -> aborted).
    if (signal?.aborted) return { content: formatSubAgentInterrupted(spec), isError: true };
    // Analyze-style read-only sub-agent, or a full agent for writers.
    const mode: ChatMode = spec.access === "read" ? "analyze" : "agent";
    const history = new InMemoryChatHistory();
    const events = new InMemoryEventBus<AgentEvent>();
    // Explicit dep (tests) wins; otherwise the configured budget (default
    // 100) so a long sub-task is not truncated at an arbitrary low number.
    const maxTurns = this.deps.maxTurns ?? this.deps.config.get().subagentMaxTurns ?? SUBAGENT_MAX_TURNS;
    const systemPrompt = new SubAgentSystemPromptBuilder(
      (m) => toolDefinitionsForMode(this.deps.tools.getAll(), m, { exclude: [DELEGATE_TOOL_NAME] }),
      this.deps.cwd,
      { role: spec.role, access: spec.access, resources: spec.resources, turnBudget: maxTurns },
    );

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
      log: this.deps.log ? (m) => this.deps.log!(`subagent "${spec.id}": ${m}`) : undefined,
    });
    agent.setMode(mode);

    // Forward the sub-agent's live activity (thinking / text / tools) to the
    // caller, tagged by the Delegate tool call — nested streaming in the UI.
    // On abort we DROP the sub-agent's own "done" (it was interrupted, not
    // finished) so the UI can mark it interrupted instead of done.
    if (onEvent) {
      events.subscribe((e) => {
        if (e.type === "done" && this.abortedAgents.has(agent)) return;
        const sub = toSubAgentEvent(e);
        if (sub) onEvent(sub);
      });
    }

    this.active.add(agent);
    // Link the parent abort signal so a sub-agent that starts JUST as the user
    // presses Stop is aborted too (closes the start/abort race).
    const onParentAbort = (): void => {
      this.abortedAgents.add(agent);
      agent.abort();
    };
    signal?.addEventListener("abort", onParentAbort);
    try {
      await agent.send(buildSubAgentTask(spec));
      if (this.abortedAgents.has(agent) || signal?.aborted) {
        return { content: formatSubAgentInterrupted(spec), isError: true };
      }
      return { content: formatSubAgentReport(spec, lastAssistantReport(agent.getMessages())), isError: false };
    } catch (e) {
      return { content: formatSubAgentError(spec, e instanceof Error ? e.message : String(e)), isError: true };
    } finally {
      signal?.removeEventListener("abort", onParentAbort);
      this.active.delete(agent);
    }
  }
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
