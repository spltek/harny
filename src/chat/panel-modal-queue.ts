/**
 * FIFO queue for in-panel modals (name dialog, alerts, confirms…): ONE modal
 * is visible at a time, further requests wait behind it.
 *
 * The webview shows the head via `post` (`modal` message) and answers with
 * `modalResponse` (id + value). Extensible: a new dialog kind only needs a
 * request object + a webview branch — nothing in this class changes.
 */
export class PanelModalQueue {
  private queue: { id: number; req: Record<string, unknown>; resolve: (v: unknown) => void }[] = [];
  private seq = 0;

  constructor(private post: (msg: unknown) => void) {}

  /** Queue a modal request and resolve when the webview answers. */
  request(req: Record<string, unknown>): Promise<unknown> {
    return new Promise<unknown>((resolve) => {
      const id = ++this.seq;
      this.queue.push({ id, req, resolve });
      // FIFO: only the head of the queue is posted to the webview.
      if (this.queue.length === 1) {
        this.post({ type: "modal", modalId: id, ...req });
      }
    });
  }

  /** Drains the matching entry and shows the next queued modal, if any. */
  respond(id: number, value: unknown): void {
    const i = this.queue.findIndex((m) => m.id === id);
    if (i < 0) return;
    this.queue.splice(i, 1)[0].resolve(value);
    const next = this.queue[0];
    if (next) this.post({ type: "modal", modalId: next.id, ...next.req });
  }

  /** True when at least one modal is waiting (shown or queued). */
  hasPending(): boolean {
    return this.queue.length > 0;
  }

  /**
   * Cancel every pending request, resolving each with `undefined` (= cancelled).
   *
   * Called by `dispose()`: the host is going away, so a modal that nobody can answer must
   * not leave its flow waiting on a promise whose webview no longer exists. It used to
   * claim it was called when the page was rebuilt with a modal open — nothing called it at
   * all, and a rebuild that landed while a modal was OPENING left such a promise forever
   * pending (and every later refresh deferred behind it: a frozen panel). The rebuild now
   * DEFERS instead of wiping the page, so this is the shutdown path, not the rebuild one.
   */
  cancelAll(): void {
    const pending = this.queue.splice(0);
    for (const m of pending) m.resolve(undefined);
  }
}
