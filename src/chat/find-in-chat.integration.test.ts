// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * ⌘F in the chat, END TO END — the whole chain the keybinding actually travels.
 *
 * The webview cannot win that chord on its own: inside a webview the same key also reaches VS
 * Code, whose own find opens its widget and takes the focus out of the panel. So the extension
 * contributes the keybinding (`focusedView == harny.chatView`, see package.json) and runs a
 * command; this file proves the command's REAL payload reaches the REAL page and lands the caret
 * in the bar — the hops are unit-tested separately, the WIRE is not.
 */
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
  Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) },
  languages: { getDiagnostics: () => [] },
}));

import { bootClient, detachBridge, pageOf, resetBridge, wire } from "./webview-bridge.test-utils";

const bar = () => document.getElementById("find-bar") as HTMLElement;
const findInput = () => document.getElementById("find-input") as HTMLInputElement;

beforeEach(() => {
  resetBridge();
});

afterEach(() => {
  detachBridge();
});

describe("⌘F, from the contributed keybinding to the caret in the bar", () => {
  it("the command's message opens the bar in the real page and focuses its field", async () => {
    const { provider, html } = wire();
    await bootClient(await pageOf(html));

    // Before: no bar, and the focus is wherever the panel left it.
    expect(bar().classList.contains("hidden")).toBe(true);

    // The command the keybinding runs (extension.ts → ChatViewProvider.openFind).
    provider.openFind();
    await vi.waitFor(() => expect(bar().classList.contains("hidden")).toBe(false));
    expect(document.activeElement).toBe(findInput());
  });

  it("it works BEFORE a session is open too (the panel is mounted, no conversation yet)", async () => {
    const { provider, html } = wire({ options: { workspaceReady: () => true } });
    await bootClient(await pageOf(html));
    provider.openFind();
    await vi.waitFor(() => expect(bar().classList.contains("hidden")).toBe(false));
    expect(document.activeElement).toBe(findInput());
    // An empty transcript says so instead of showing "0/0".
    findInput().value = "anything";
    findInput().dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 150));
    expect(document.getElementById("find-count")!.textContent).toBe("no match");
  });

  it("a second ⌘F does not close it: it re-focuses the field (and Esc is the way out)", async () => {
    const { provider, html } = wire();
    await bootClient(await pageOf(html));
    provider.openFind();
    await vi.waitFor(() => expect(bar().classList.contains("hidden")).toBe(false));

    findInput().value = "abc";
    (document.activeElement as HTMLElement)?.blur();
    provider.openFind(); // the message path must behave like the key path
    await vi.waitFor(() => expect(document.activeElement).toBe(findInput()));
    expect(findInput().value).toBe("abc"); // the query is kept
    expect(findInput().selectionStart).toBe(0); // …and selected, so typing replaces it
    expect(findInput().selectionEnd).toBe(3);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await vi.waitFor(() => expect(bar().classList.contains("hidden")).toBe(true));
  });
});
