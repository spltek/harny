import type { ChatMessage, MessageAttachment } from "../history/types";
import type { AttachmentPart } from "../../chat/attachment-types";
import type { AgentEvent } from "./types";
import type { ChatMode } from "../tools/mode-policy";
import type { LoopGuardOptions } from "./loop-guard";

/** Optional payload for {@link ChatController.send}. */
export interface SendOptions {
  /** Data-URI images (multimodal content). */
  images?: string[];
  /** Attached-file metadata, echoed in the user bubble. */
  attachments?: MessageAttachment[];
  /** Text to show in the UI when the LLM `content` differs (file contents inlined). */
  displayText?: string;
  /** Per-attachment parts, so a Delegate can hand each sub-agent only the
   * attachments its sub-task needs (indices in the numbered list). */
  attachmentParts?: AttachmentPart[];
}

/**
 * The contract the chat UI needs from the agent. Keeps the webview layer
 * decoupled from the concrete Agent implementation (Dependency Inversion).
 */
export interface ChatController {
  readonly streaming: boolean;
  getMessages(): ChatMessage[];
  reset(): void;
  /** Replace the whole conversation with a loaded session (no autosave). */
  load(messages: ChatMessage[]): void;
  send(text: string, options?: SendOptions): Promise<void>;
  /**
   * Inject a user message into the RUNNING loop (soft steering): it is added to
   * the history at the next turn boundary, so the model sees it on its next
   * request without restarting the run. `id` correlates the pending bubble in
   * the UI; a no-op when the agent is not streaming (the host queues instead).
   */
  steer(id: string, text: string, options?: SendOptions): void;
  /** Drop a queued steer before it is applied at a turn boundary. */
  cancelSteer(id: string): void;
  abort(): void;
  /** Abort ONE running sub-agent (Delegate bubble) without stopping the whole
   * run. The orchestrator still receives that Delegate's tool result
   * ("aborted"), so it can continue with the remaining work. No-op when the
   * given tool-call id is not a live sub-agent. */
  abortSubAgent(toolCallId: string): void;
  onEvent(handler: (event: AgentEvent) => void): () => void;
  /** Queue a user message without starting the agent loop (used by context-menu commands). */
  addUserMessage(content: string): void;
  /**
   * Set the chat mode: "analyze" (read-only) or "agent" (full tool access).
   * Defaults to analyze.
   */
  setMode(mode: ChatMode): void;
  /**
   * Enable/disable orchestration (sub-agents) — the UI "Parallel" toggle.
   * When off, the Delegate tool is hidden and refused.
   */
  setDelegation(enabled: boolean): void;
  /** Apply the per-session concurrent sub-agent cap (undefined = inherit the
   * config default; 0 = explicitly no cap). */
  setMaxParallelSubAgents(cap: number | undefined): void;
  /** Apply the per-session Loop Guard options (resolved from the three knobs). */
  setLoopGuardOptions(options: LoopGuardOptions): void;
}
