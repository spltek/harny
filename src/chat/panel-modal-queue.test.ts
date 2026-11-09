import { describe, it, expect } from "vitest";
import { PanelModalQueue } from "./panel-modal-queue";

describe("PanelModalQueue (FIFO)", () => {
  it("posts the head immediately and queues the rest until resolved", async () => {
    const posted: unknown[] = [];
    const q = new PanelModalQueue((m) => posted.push(m));

    const p1 = q.request({ kind: "name", mode: "create", current: undefined });
    const p2 = q.request({ kind: "alert", alertKind: "confirm", title: "Delete" });

    // Only the head is shown while the first dialog is open.
    expect(posted).toEqual([{ type: "modal", modalId: 1, kind: "name", mode: "create", current: undefined }]);

    // Resolving the head posts the next queued modal automatically.
    q.respond(1, "Cool Project");
    expect(await p1).toBe("Cool Project");
    expect(posted).toHaveLength(2);
    expect(posted[1]).toEqual({ type: "modal", modalId: 2, kind: "alert", alertKind: "confirm", title: "Delete" });

    q.respond(2, true);
    expect(await p2).toBe(true);
  });

  it("ignores responses for unknown ids", async () => {
    const posted: unknown[] = [];
    const q = new PanelModalQueue((m) => posted.push(m));
    q.respond(99, "x"); // no-op, must not throw
    const p = q.request({ kind: "alert", title: "t", message: "m" });
    q.respond(1, true);
    expect(await p).toBe(true);
  });

  it("hasPending reflects whether any modal is waiting", () => {
    const q = new PanelModalQueue(() => {});
    expect(q.hasPending()).toBe(false);
    void q.request({ kind: "alert", title: "t", message: "m" });
    expect(q.hasPending()).toBe(true);
    q.respond(1, true);
    expect(q.hasPending()).toBe(false);
  });

  it("cancelAll resolves every pending request (webview rebuilt with a modal open)", async () => {
    const posted: unknown[] = [];
    const q = new PanelModalQueue((m) => posted.push(m));
    const p1 = q.request({ kind: "name", mode: "create", current: undefined });
    const p2 = q.request({ kind: "alert", alertKind: "confirm", title: "Delete" });
    q.cancelAll();
    expect(await p1).toBeUndefined();
    expect(await p2).toBeUndefined();
    // The queue is empty: a later request shows immediately.
    const p3 = q.request({ kind: "alert", title: "t", message: "m" });
    expect(posted[posted.length - 1]).toMatchObject({ type: "modal", kind: "alert", title: "t" });
    q.respond(3, true);
    expect(await p3).toBe(true);
  });

  describe("a queue is not a page", () => {
    it("re-shows a request that a rebuild wiped (`pageReplaced` + `flush`)", async () => {
      const posted: { modalId?: number; type?: string; title?: string }[] = [];
      const q = new PanelModalQueue((m) => posted.push(m as { modalId?: number; type?: string; title?: string }));

      const p = q.request({ kind: "alert", title: "Vacuum?", message: "m" });
      expect(posted.map((m) => m.modalId)).toEqual([1]);
      expect(q.hasShown()).toBe(true);

      // The HTML is replaced: the dialog went away with the old document, so it is no longer
      // on screen. The promise stays open (same question, answerable on the new page) — and
      // until it is re-shown it must NOT block rebuilds, or the panel freezes behind a
      // dialog nobody can see.
      q.pageReplaced();
      expect(q.hasShown()).toBe(false);
      expect(q.hasPending()).toBe(true);

      q.flush(); // the new document said hello
      expect(posted.map((m) => m.modalId)).toEqual([1, 1]);
      expect(q.hasShown()).toBe(true);

      // Flushing again must not draw a third copy.
      q.flush();
      expect(posted).toHaveLength(2);

      q.respond(1, true);
      expect(await p).toBe(true);
      expect(q.hasPending()).toBe(false);
    });

    it("only the HEAD is on screen: the ones behind it are pending, not shown", async () => {
      const posted: { modalId?: number }[] = [];
      const q = new PanelModalQueue((m) => posted.push(m as { modalId?: number }));
      const p1 = q.request({ kind: "alert", title: "one", message: "m" });
      const p2 = q.request({ kind: "alert", title: "two", message: "m" });
      expect(posted.map((m) => m.modalId)).toEqual([1]);
      expect(q.hasPending()).toBe(true);

      q.respond(1, true);
      expect(posted.map((m) => m.modalId)).toEqual([1, 2]);
      q.respond(2, true);
      expect(await p1).toBe(true);
      expect(await p2).toBe(true);
    });
  });
});
