// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { bootClient, detachBridge, pageOf, resetBridge, wire } from "./webview-bridge.test-utils";
import { tipTextOf } from "./webview/tips";

/**
 * The sessions list's dates, END TO END across the seam.
 *
 * The requirement: `updated` must follow a session as it runs, not freeze until you open
 * it. `chat-view.test.ts` proves the host posts the patch and `webview/view.test.ts` proves
 * the client patches the row against a hand-written fixture — neither can catch the SEAM,
 * which here is three untyped strings at once: the message `type`, the shape of `meta`, and
 * the selector the client patches (`.srow[data-id] .smeta`).
 *
 * The second requirement is the other side of the same coin: because a patch never moves a
 * row, the ORDER on screen ages — so opening the section asks the host for the list again
 * (`refreshSessions` → `sessions`). Two message names and a render, which is exactly the
 * kind of pair a unit test on each side cannot check.
 *
 * Here the provider runs for real over an in-memory store and the page is the one
 * `renderViewHtml` produces, so a rename of the class or of the message field goes red in
 * this file while both unit suites stay green — which is exactly why it exists.
 */

// ── VS Code, reduced to what the panel touches (mocks are per test FILE) ──────
vi.mock("vscode", () => ({
  window: {
    showInputBox: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
    showInformationMessage: vi.fn(async () => undefined),
  },
  commands: { executeCommand: vi.fn(async () => undefined) },
  workspace: {
    getConfiguration: () => ({ get: () => undefined, update: vi.fn(async () => undefined) }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    fs: { writeFile: vi.fn(async () => {}), readFile: vi.fn(async () => new Uint8Array()) },
  },
  Uri: {
    joinPath: (_base: unknown, ...parts: string[]) => ({ fsPath: "/ext/" + parts.join("/") }),
    file: (p: string) => ({ fsPath: p }),
  },
}));

beforeEach(resetBridge);
afterEach(detachBridge);

describe("the sessions list's dates, host ⇄ webview", () => {
  it("a history write repaints `updated` IN PLACE in the real page", async () => {
    let id = "";
    const { store, html, provider } = wire({
      prepare: (s) => {
        // Seeded OLD on purpose: a session created in this same second would format to the
        // same "updated" text after the write, and the test would pass without patching.
        const seeded = s.create("Live");
        id = seeded.id;
        s.rows.set(id, { ...seeded, createdAt: 1_600_000_000_000, updatedAt: 1_600_000_000_000 });
      },
    });
    await bootClient(await pageOf(html));

    const meta = (): HTMLElement => document.querySelector(`.srow[data-id="${id}"] .smeta`) as HTMLElement;
    const row = document.querySelector(`.srow[data-id="${id}"]`);
    expect(row, "the seeded session must have a row in the rendered list").not.toBeNull();
    const element = meta();
    const before = element.textContent;

    // Exactly the pair `PersistentChatHistory.persist()` + the turn's end perform: the
    // store hands back the summary it just updated, the host accumulates it, and
    // `onRunFinished` — the moment the turn stops moving `updatedAt` — publishes it.
    const written = store.saveMessages(id, [{ role: "user", content: "hi", timestamp: 1 }]);
    provider.noteSessionActivity(written);
    provider.flushSessionMeta(); // = the turn ended (see ChatViewProvider.onRunFinished)

    await vi.waitFor(() => expect(meta().textContent).not.toBe(before), { timeout: 2000 });
    // Patched, not rebuilt: the row the user is looking at is the SAME node.
    expect(document.querySelector(`.srow[data-id="${id}"] .smeta`)).toBe(element);
    expect(element.textContent).toContain("· updated ");
    expect(tipTextOf(element)).toContain(new Date(written.updatedAt).toLocaleString());
  });

  it("OPENING the section re-reads the order from the store", async () => {
    let older = "";
    let newer = "";
    const { store, html } = wire({
      prepare: (s) => {
        const a = s.create("Older");
        older = a.id;
        const b = s.create("Newer");
        newer = b.id;
        // Distinct dates: created in the same millisecond the two rows would tie.
        s.rows.set(older, { ...a, createdAt: 1_600_000_000_000, updatedAt: 1_600_000_000_000 });
        s.rows.set(newer, { ...b, createdAt: 1_600_000_100_000, updatedAt: 1_600_000_100_000 });
      },
    });
    await bootClient(await pageOf(html));
    const ids = (): (string | undefined)[] =>
      [...document.querySelectorAll(".srow")].map((r) => (r as HTMLElement).dataset.id);
    // Most recently touched first — and that rank is the HOST's, not the page's.
    expect(ids()).toEqual([newer, older]);

    // The OLDER session was worked on while the list was not looking (another window, or a
    // patch that moved a date without moving a row): the store knows, the DOM does not.
    store.rows.set(older, { ...store.rows.get(older)!, updatedAt: 1_600_000_900_000 });
    expect(ids()).toEqual([newer, older]);

    const head = document.getElementById("session-head") as HTMLElement;
    head.click(); // collapse
    head.click(); // open: the client asks, the host re-reads, the rows come back sorted

    await vi.waitFor(() => expect(ids()).toEqual([older, newer]), { timeout: 2000 });
  });
});
