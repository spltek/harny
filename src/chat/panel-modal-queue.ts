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

  /**
   * Cancel every pending request. Called when the webview page is rebuilt
   * (refresh/reload) with a modal open: the DOM modal is wiped, so its promise
   * would otherwise never resolve and the host flow (create/rename/delete…)
   * would hang forever. Each request resolves with `undefined` (= cancelled).
   */
  cancelAll(): void {
    const pending = this.queue.splice(0);
    for (const m of pending) m.resolve(undefined);
  }
}