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
});
