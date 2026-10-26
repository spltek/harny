// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChatMessage } from "../core/history/types";
import {
  bootClient,
  detachBridge,
  pageOf,
  resetBridge,
  settle,
  wire,
  type MemoryStore,
} from "./webview-bridge.test-utils";

/**
 * The 🗑 flow, END TO END across the seam.
 *
 * `chat-view.test.ts` proves the HOST's half with a fake view; `webview/view.test.ts`
 * proves the CLIENT's half against a hand-written DOM fixture. Neither can catch the
 * seam itself: a field the host sends and the client does not read (`extraActions`
 * vs `extras`), an answer the client posts as `"empty"` while the host compares to
 * `"Empty"`, or a fixture carrying an element the real page does not have.
 *
 * Here there is no fake on either side of the wire: the provider runs for real over
 * an in-memory store, the page is the one `renderViewHtml` produces, the client is
 * the real bundle module, and the only thing the test does is CLICK. If the two
 * halves disagree, this file goes red while both unit suites stay green — which is
 * exactly why it exists. The plumbing lives in `webview-bridge.test-utils.ts`.
 */

// ── VS Code, reduced to what the flow touches (mocks are per test FILE) ──────
const dialogs = vi.hoisted(() => ({
  showInputBox: vi.fn(async () => undefined as string | undefined),
  showWarningMessage: vi.fn(async () => undefined as string | undefined),
  showErrorMessage: vi.fn(async () => undefined),
  showInformationMessage: vi.fn(async () => undefined),
}));

vi.mock("vscode", () => ({
  window: {
    showInputBox: dialogs.showInputBox,
    showWarningMessage: dialogs.showWarningMessage,
    showErrorMessage: dialogs.showErrorMessage,
    showInformationMessage: dialogs.showInformationMessage,
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

const CHECKPOINT: ChatMessage[] = [
  { role: "user", content: "Summary of past interactions", timestamp: 3, synthetic: true },
  { role: "assistant", content: "## Goal\nship the cleanup dialog", timestamp: 4, synthetic: true },
];
const TRANSCRIPT: ChatMessage[] = [
  { role: "user", content: "old question", timestamp: 1 },
  { role: "assistant", content: "old answer", timestamp: 2 },
  ...CHECKPOINT,
  { role: "user", content: "after the summary", timestamp: 5 },
  { role: "assistant", content: "after the summary — answer", timestamp: 6 },
];

/** A stored session with a transcript, exactly as the panel would list it. */
function seedSession(store: MemoryStore, name: string, messages: ChatMessage[]): string {
  const summary = store.create(name);
  store.saveMessages(summary.id, messages);
  return summary.id;
}

/** The row's 🗑 in the REAL rendered sessions list. */
function trashOf(sessionId: string): HTMLButtonElement {
  const row = document.querySelector(`.srow[data-id="${sessionId}"]`);
  expect(row, "the session row must be in the rendered list").not.toBeNull();
  return row!.querySelector(".del") as HTMLButtonElement;
}

/** The extra answer the modal is showing right now, by its label. */
function modalButton(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("#alert-modal .alert-extra")].find(
    (b) => b.textContent === text,
  );
}

beforeEach(resetBridge);
afterEach(detachBridge);

describe("session cleanup, host ⇄ webview", () => {
  it("clicking the trash asks delete / rewind / empty IN THE REAL PAGE, and Empty empties the session", async () => {
    let id = "";
    const { store, html } = wire({
      prepare: (s) => {
        id = seedSession(s, "Too long", TRANSCRIPT);
      },
    });
    await bootClient(await pageOf(html));

    trashOf(id).click();

    // The dialog is up, in the page the extension actually serves.
    const modal = document.getElementById("alert-modal") as HTMLDivElement;
    expect(modal.classList.contains("hidden")).toBe(false);
    expect(document.querySelector("#alert-title")?.textContent).toBe("Delete or empty session");
    expect(modalButton("Rewind")?.disabled).toBe(false);
    expect(modalButton("Empty")).toBeTruthy();
    expect(document.getElementById("alert-ok")?.textContent).toBe("Delete");
    // The body names all three outcomes: a button alone would not say what
    // "Rewind" keeps.
    const message = document.getElementById("alert-message")?.textContent ?? "";
    expect(message).toContain("Too long");
    expect(message).toContain("first compaction summary");

    modalButton("Empty")!.click();
    await settle();

    // The session SURVIVES with its settings; only the transcript is gone.
    expect(store.rows.has(id)).toBe(true);
    expect(store.transcripts.get(id)).toEqual([]);
    expect(store.rows.get(id)?.contextTokens).toBe(0);
    // …and the dialog is down.
    expect(modal.classList.contains("hidden")).toBe(true);
  });

  it("Rewind keeps the first summary and drops what came after it", async () => {
    let id = "";
    const { store, html } = wire({
      prepare: (s) => {
        id = seedSession(s, "Compacted", TRANSCRIPT);
      },
    });
    await bootClient(await pageOf(html));

    trashOf(id).click();
    modalButton("Rewind")!.click();
    await settle();

    // [old question][old answer][summary label][summary] — and nothing after.
    expect(store.transcripts.get(id)).toEqual(TRANSCRIPT.slice(0, 4));
    expect(store.rows.has(id)).toBe(true);
  });

  it("a session with no summary offers Rewind DISABLED and refuses to act on it", async () => {
    const plain: ChatMessage[] = [
      { role: "user", content: "q", timestamp: 1 },
      { role: "assistant", content: "a", timestamp: 2 },
    ];
    let id = "";
    const { store, html } = wire({
      prepare: (s) => {
        id = seedSession(s, "Never compacted", plain);
      },
    });
    await bootClient(await pageOf(html));

    trashOf(id).click();
    const rewind = modalButton("Rewind") as HTMLButtonElement;
    expect(rewind.disabled).toBe(true);
    rewind.click(); // a disabled button answers nothing

    // Nothing moved: the dialog is still up and the transcript is untouched.
    expect((document.getElementById("alert-modal") as HTMLDivElement).classList.contains("hidden")).toBe(false);
    expect(store.transcripts.get(id)).toEqual(plain);
  });

  it("Delete (the red primary) really removes the session and drops its row", async () => {
    let id = "";
    const { store, html } = wire({
      prepare: (s) => {
        id = seedSession(s, "Gone", TRANSCRIPT);
      },
    });
    await bootClient(await pageOf(html));

    trashOf(id).click();
    (document.getElementById("alert-ok") as HTMLButtonElement).click();
    await settle();

    expect(store.rows.has(id)).toBe(false);
    expect(document.querySelector(`.srow[data-id="${id}"]`)).toBeNull();
  });
});
