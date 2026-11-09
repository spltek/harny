/**
 * FIFO queue for in-panel modals (name dialog, alerts, confirms…): ONE modal
 * is visible at a time, further requests wait behind it.
 *
 * The webview shows the head via `post` (`modal` message) and answers with
 * `modalResponse` (id + value). Extensible: a new dialog kind only needs a
 * request object + a webview branch — nothing in this class changes.
 *
 * ## A queue is not a page
 *
 * `post` writes into a DOCUMENT: if the panel's script is not listening _yet_ (the HTML was
 * just assigned and the document is still loading), the message falls on the floor and no
 * answer ever comes back. The request used to be posted once and forgotten — so the promise
 * stayed pending, `hasPending()` stayed true, and every later `refresh()` deferred behind a
 * modal nobody had seen until the stall guard gave up two minutes later (a frozen panel).
 *
 * The queue therefore separates "queued" from "ON SCREEN": `pageReplaced()` marks the head
 * as gone (a rebuild wipes the DOM, so the modal must be shown again instead of waiting for
 * an answer to a dialog that no longer exists) and `flush()` shows it on the document that
 * says hello. A fresh document cannot be showing a dialog, which is why the host calls BOTH
 * on the webview's `ready` handshake.
 */
export class PanelModalQueue {
  private queue: { id: number; req: Record<string, unknown>; resolve: (v: unknown) => void; shown: boolean }[] = [];
  private seq = 0;

  constructor(private post: (msg: unknown) => void) {}

  /** Queue a modal request and resolve when the webview answers. */
  request(req: Record<string, unknown>): Promise<unknown> {
    return new Promise<unknown>((resolve) => {
      const id = ++this.seq;
      this.queue.push({ id, req, resolve, shown: false });
      // FIFO: only the head of the queue is shown, and only if a page can show it.
      this.deliver();
    });
  }

  /** Drains the matching entry and shows the next queued modal, if any. */
  respond(id: number, value: unknown): void {
    const i = this.queue.findIndex((m) => m.id === id);
    if (i < 0) return;
    this.queue.splice(i, 1)[0].resolve(value);
    this.deliver();
  }

  /**
   * The page is listening now: show the head if it has not been shown on THIS document.
   * Called by the host on the webview's `ready` handshake.
   */
  flush(): void {
    this.deliver();
  }

  /**
   * The document is being replaced (a new HTML was assigned): the modal it was showing
   * went away with it. The answer's promise stays open — the user can answer the same
   * question on the new page — but it must be SHOWN again, so it is no longer "shown".
   */
  pageReplaced(): void {
    const head = this.queue[0];
    if (head) head.shown = false;
  }

  /** True when at least one modal is waiting (shown or queued). */
  hasPending(): boolean {
    return this.queue.length > 0;
  }

  /**
   * True when the head is ON SCREEN, i.e. a rebuild would wipe a dialog the user is
   * looking at. This — not `hasPending()` — is what a refresh must defer behind: a request
   * that has not been delivered yet is not in any document, and the rebuild is precisely
   * what brings the page that will show it.
   */
  hasShown(): boolean {
    return this.queue.length > 0 && this.queue[0].shown;
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

  /** Show the head, once, on the current document. */
  private deliver(): void {
    const head = this.queue[0];
    if (!head || head.shown) return;
    head.shown = true;
    this.post({ type: "modal", modalId: head.id, ...head.req });
  }
}
