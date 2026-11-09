import type { AttachmentContext } from "./attachment-service";
import type { AttachmentInfo, AttachmentPart } from "./attachment-types";
import type { SessionRuntime } from "./session-registry";

/**
 * A message the user typed WHILE the session was working. `queue` runs as a new
 * send once the current run ends; `steer` is injected into the running loop at
 * its next turn boundary (merged with the other pending steers).
 */
export interface PendingInput {
  id: string;
  mode: "queue" | "steer";
  text: string;
  attachments?: AttachmentInfo[];
}

/** The fields `enqueue` reads off an incoming webview message. */
interface PendingEnqueueMessage {
  text?: string;
  attachments?: AttachmentInfo[];
  mode?: "queue" | "steer";
  id?: string;
}

interface PendingInputQueueDeps {
  /** Build the LLM context (inlined text + images + parts) for a steer draft. */
  buildContext: (files: AttachmentInfo[]) => Promise<AttachmentContext>;
  /** Push a session's pending list to the view (no-op when it is not active). */
  post: (sessionId: string, items: PendingInput[]) => void;
}

/**
 * Per-session queue of messages typed while the agent is working, extracted
 * from the chat view provider (SRP). It owns the "pending" state and the two
 * delivery rules:
 *
 * - `queue` items run as ordinary sends once the run ends (FIFO, steers first);
 * - each `steer` is its own pending item (individually cancellable) and is
 *   handed to the agent, which merges them into ONE message at its next turn
 *   boundary.
 *
 * The queue never runs a send itself: `drain` receives a `dispatch` callback
 * (Dependency Inversion), so it stays decoupled from the host's send pipeline.
 */
export class PendingInputQueue {
  private readonly bySession = new Map<string, PendingInput[]>();
  private readonly draining = new Set<string>();
  private seq = 0;
  /** Per-session counter: supersedes a stale async steer apply when the item
   * was cancelled/cleared while its attachment context was building. */
  private readonly steerVersion = new Map<string, number>();

  constructor(private deps: PendingInputQueueDeps) {}

  /** The pending list of a session (empty when it has none). */
  items(sessionId: string): PendingInput[] {
    return this.bySession.get(sessionId) ?? [];
  }

  /** True while this session's queued messages are being drained. */
  isDraining(sessionId: string): boolean {
    return this.draining.has(sessionId);
  }

  /**
   * Hold a message typed while the session works. A `steer` becomes its OWN
   * pending item (individually cancellable) and is handed to the agent for the
   * next boundary; a `queue` item waits for the run to end.
   */
  enqueue(rt: SessionRuntime, msg: PendingEnqueueMessage): void {
    const text = typeof msg.text === "string" ? msg.text : "";
    const attachments = msg.attachments ?? [];
    if (!text.trim() && attachments.length === 0) return;
    const list = this.bySession.get(rt.sessionId) ?? [];
    if (!this.bySession.has(rt.sessionId)) this.bySession.set(rt.sessionId, list);
    if (msg.mode === "steer") {
      // Each steer stays its OWN pending item (the user can delete individual
      // ones); the AGENT merges them into one message at the turn boundary.
      const id = typeof msg.id === "string" && msg.id ? msg.id : `s-${++this.seq}`;
      const item: PendingInput = {
        id,
        mode: "steer",
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
      };
      list.push(item);
      this.post(rt.sessionId);
      void this.applySteer(rt, item);
      return;
    }
    const id = typeof msg.id === "string" && msg.id ? msg.id : `p-${++this.seq}`;
    list.push({ id, mode: "queue", text, ...(attachments.length > 0 ? { attachments } : {}) });
    this.post(rt.sessionId);
  }

  /**
   * Convert a pending item between the two delivery modes.
   *
   * The two are NOT two views of the same message: they differ in WHEN the text
   * reaches the model. A `steer` is injected at the running loop's next turn
   * boundary (and, once the run ends, goes FIRST); a `queued` message waits for the
   * run to finish and then runs in FIFO order with the others. So this is a real
   * change of destination, and one direction is delicate: `steer -> queue` must
   * WITHDRAW the draft from the agent, which may already hold it — otherwise a
   * message the user just "put back in the queue" is delivered as a steer anyway.
   */
  setMode(rt: SessionRuntime, id: string, mode: PendingInput["mode"]): void {
    const list = this.bySession.get(rt.sessionId);
    const item = list?.find((p) => p.id === id);
    if (!list || !item || item.mode === mode) return;
    item.mode = mode;
    if (mode === "queue") {
      rt.agent.cancelSteer(id);
      this.bumpVersion(rt.sessionId); // supersede an in-flight apply
    } else if (rt.agent.streaming) {
      // Hand it to the RUNNING loop now, exactly as if it had been typed as one.
      void this.applySteer(rt, item);
    }
    this.post(rt.sessionId);
  }

  /** Drop a still-pending message (queued, or a steer not yet at a boundary). */
  cancel(rt: SessionRuntime, id: string): void {
    const list = this.bySession.get(rt.sessionId);
    const item = list?.find((p) => p.id === id);
    if (!list || !item) return;
    this.bySession.set(
      rt.sessionId,
      list.filter((p) => p.id !== id),
    );
    if (item.mode === "steer") {
      rt.agent.cancelSteer(id);
      this.bumpVersion(rt.sessionId); // supersede any in-flight apply
    }
    this.post(rt.sessionId);
  }

  /** Stop: drop everything still pending for the session (steers are cancelled). */
  clear(rt: SessionRuntime): void {
    const list = this.bySession.get(rt.sessionId);
    if (!list || list.length === 0) return;
    for (const p of list) if (p.mode === "steer") rt.agent.cancelSteer(p.id);
    this.bySession.set(rt.sessionId, []);
    this.bumpVersion(rt.sessionId);
    this.post(rt.sessionId);
  }

  /**
   * Forget a session's pending state (tab closed / session deleted). Without
   * this the queue would keep the list and re-show STALE pending bubbles if
   * the session is reopened (the old runtime-held state was dropped with it).
   */
  drop(sessionId: string): void {
    this.bySession.delete(sessionId);
    this.steerVersion.delete(sessionId);
  }

  /** The agent applied (merged) the given steer drafts: drop them from the UI. */
  onSteerApplied(sessionId: string, ids: string[]): void {
    const list = this.bySession.get(sessionId);
    if (!list) return;
    const consumed = new Set(ids);
    this.bySession.set(
      sessionId,
      list.filter((p) => !consumed.has(p.id)),
    );
    this.post(sessionId);
  }

  /** Run the queued messages, one after another, while the session is idle. */
  async drain(rt: SessionRuntime, dispatch: (item: PendingInput) => Promise<void>): Promise<void> {
    if (this.draining.has(rt.sessionId)) return;
    this.draining.add(rt.sessionId);
    try {
      let list = this.bySession.get(rt.sessionId) ?? [];
      // `working`, not `streaming`: a compaction REWRITES the history from a snapshot taken
      // before it started, so a send dispatched into it would be appended to a transcript
      // that is about to be rebuilt from that older copy.
      while (!rt.engine.working && list.length > 0) {
        // Steers first (they were meant to apply earlier), then queued messages
        // FIFO — matching the UI, where steer bubbles sit above the queue.
        const steerIdx = list.findIndex((p) => p.mode === "steer");
        const [next] = list.splice(steerIdx >= 0 ? steerIdx : 0, 1);
        this.post(rt.sessionId);
        await dispatch(next);
        // `enqueue` may have appended more while the last item ran.
        list = this.bySession.get(rt.sessionId) ?? [];
      }
    } finally {
      this.draining.delete(rt.sessionId);
    }
    // A message that arrived while the last item ran must not be stranded.
    const remaining = this.bySession.get(rt.sessionId) ?? [];
    if (!rt.engine.working && remaining.length > 0) void this.drain(rt, dispatch);
  }

  /** Build the attachment context for the steer DRAFT and hand it to the agent. */
  private async applySteer(rt: SessionRuntime, item: PendingInput): Promise<void> {
    // Snapshot the item; a later cancel/clear bumps the version and supersedes
    // this call, so a stale apply never delivers a removed steer.
    const version = this.bumpVersion(rt.sessionId);
    const draftText = item.text;
    const draftAttachments = item.attachments ? [...item.attachments] : [];
    let text = draftText;
    let images: string[] | undefined;
    let displayText: string | undefined;
    let attachmentMeta: AttachmentInfo[] | undefined;
    let attachmentParts: AttachmentPart[] | undefined;
    if (draftAttachments.length > 0) {
      const ctx = await this.deps.buildContext(draftAttachments);
      text = ctx.text ? `${ctx.text}\n\n${draftText}` : draftText;
      images = ctx.images.length > 0 ? ctx.images : undefined;
      attachmentMeta = draftAttachments;
      attachmentParts = ctx.parts;
      displayText = draftText;
    }
    // The run may have ended, or the item been cancelled/cleared while the
    // context was building: never deliver a stale steer.
    if (!rt.agent.streaming) return;
    if ((this.steerVersion.get(rt.sessionId) ?? 0) !== version) return;
    if (!this.bySession.get(rt.sessionId)?.some((p) => p.id === item.id)) return;
    rt.agent.steer(item.id, text, {
      images,
      attachments: attachmentMeta,
      displayText,
      attachmentParts,
    });
  }

  private bumpVersion(sessionId: string): number {
    const v = (this.steerVersion.get(sessionId) ?? 0) + 1;
    this.steerVersion.set(sessionId, v);
    return v;
  }

  private post(sessionId: string): void {
    this.deps.post(sessionId, this.items(sessionId));
  }
}
