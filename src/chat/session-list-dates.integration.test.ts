// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { bootClient, detachBridge, pageOf, resetBridge, wire } from "./webview-bridge.test-utils";

/**
 * The sessions list's dates, END TO END across the seam.
 *
 * The requirement: `updated` must follow a session as it runs, not freeze until you open
 * it. `chat-view.test.ts` proves the host posts the patch and `webview/view.test.ts` proves
 * the client patches the row against a hand-written fixture — neither can catch the SEAM,
 * which here is three untyped strings at once: the message `type`, the shape of `meta`, and
 * the selector the client patches (`.srow[data-id] .smeta`).
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

    // Exactly the pair `PersistentChatHistory.persist()` performs on every write: the store
    // hands back the summary it just updated, and the host relays it to the panel.
    const written = store.saveMessages(id, [{ role: "user", content: "hi", timestamp: 1 }]);
    provider.noteSessionActivity(written);

    await vi.waitFor(() => expect(meta().textContent).not.toBe(before), { timeout: 2000 });
    // Patched, not rebuilt: the row the user is looking at is the SAME node.
    expect(document.querySelector(`.srow[data-id="${id}"] .smeta`)).toBe(element);
    expect(element.textContent).toContain("· updated ");
    expect(element.title).toContain(new Date(written.updatedAt).toLocaleString());
  });
});
