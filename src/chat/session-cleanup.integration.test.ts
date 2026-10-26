// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChatMessage } from "../core/history/types";
import type { ChatHistory } from "../core/history/chat-history";
import type { ChatController } from "../core/agent/chat-controller";
import type { HarnyConfig } from "../core/config/types";
import type { SessionSettingsPatch, SessionStore, SessionSummary } from "../core/sessions/types";
import { SessionManager } from "../core/sessions/session-manager";
import { ChatViewProvider } from "./chat-view";
import { SessionRegistry } from "./session-registry";

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
 * exactly why it exists.
 */

// ── VS Code, reduced to what the flow touches ────────────────────────────────
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

const CONFIG: HarnyConfig = {
  provider: "openai",
  apiKey: "sk",
  baseUrl: "https://api.openai.com",
  model: "gpt-4o",
  maxTokens: 100,
  temperature: 0,
  autoOpen: false,
};

// ── A REAL in-memory store: the test asserts on what was PERSISTED, not on
//    call logs (a call log cannot tell "saved the wrong array" from "saved"). ──
interface MemoryStore extends SessionStore {
  rows: Map<string, SessionSummary>;
  transcripts: Map<string, ChatMessage[]>;
}

function memoryStore(): MemoryStore {
  let n = 0;
  const rows = new Map<string, SessionSummary>();
  const transcripts = new Map<string, ChatMessage[]>();
  const store: MemoryStore = {
    rows,
    transcripts,
    list: () => [...rows.values()].map((s) => ({ ...s })),
    create(name?: string) {
      const now = Date.now();
      const summary: SessionSummary = {
        id: `s${++n}`,
        name: name?.trim() || "New Session",
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
      };
      rows.set(summary.id, summary);
      transcripts.set(summary.id, []);
      return { ...summary };
    },
    load(id: string) {
      const summary = rows.get(id) ?? {
        id,
        name: "S",
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
      };
      const messages = [...(transcripts.get(id) ?? [])];
      return { summary: { ...summary, messageCount: messages.length }, messages };
    },
    saveMessages(id: string, messages: ChatMessage[]) {
      transcripts.set(id, [...messages]);
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, messageCount: messages.length, updatedAt: Date.now() });
      return { ...(rows.get(id) ?? { id, name: "S", createdAt: 1, updatedAt: 1, messageCount: messages.length }) };
    },
    rename(id: string, name: string) {
      const row = rows.get(id)!;
      const next = { ...row, name };
      rows.set(id, next);
      return { ...next };
    },
    remove(id: string) {
      const had = rows.delete(id);
      transcripts.delete(id);
      return had;
    },
    saveSettings(id: string, patch: SessionSettingsPatch) {
      const row = rows.get(id) ?? { id, name: "S", createdAt: 1, updatedAt: 1, messageCount: 0 };
      const next = { ...row, ...patch } as SessionSummary;
      rows.set(id, next);
      return { ...next };
    },
    // No maintenance support: the vacuum suggestion is a no-op, which keeps the
    // flow free of an unrelated modal.
    dbVacuumStats: () => ({ pageCount: 0, freePages: 0, pageSize: 0, bytesFree: 0, bytesTotal: 0, ratio: 0 }),
  };
  return store;
}

/** The agent, reduced to what a cleanup needs (no model is ever called). */
function stubAgent(history: ChatHistory): ChatController {
  const agent: Record<string, unknown> = {
    streaming: false,
    getMessages: () => history.all(),
    addUserMessage: vi.fn(),
    send: vi.fn(async () => {}),
    abort: vi.fn(),
    abortSubAgent: vi.fn(),
    steer: vi.fn(),
    cancelSteer: vi.fn(),
    setMode: vi.fn(),
    setDelegation: vi.fn(),
    setMaxParallelSubAgents: vi.fn(),
    setLoopGuardOptions: vi.fn(),
    onEvent: vi.fn(() => () => {}),
  };
  return agent as unknown as ChatController;
}

// ── The wire ─────────────────────────────────────────────────────────────────
/** Messages the host posted before the client was listening (resolve() posts at
 * once: dropping them would leave the page without its state). */
let inbox: unknown[] = [];
let clientLive = false;
/** The provider's `onDidReceiveMessage` handler = the router. */
let hostHandler: ((msg: unknown) => unknown) | undefined;

function hostToClient(msg: unknown): void {
  if (!clientLive) {
    inbox.push(msg);
    return;
  }
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

/** Listeners the client registered on the SHARED window: detached after every
 * test, or each test would add one more handler onto the same DOM. */
let windowListeners: { type: string; fn: EventListener; options?: AddEventListenerOptions | boolean }[] = [];

function wire(prepare?: (store: MemoryStore) => void): {
  provider: ChatViewProvider;
  store: MemoryStore;
  sessions: SessionManager;
  html: () => string;
} {
  const store = memoryStore();
  // The list the page opens with comes from the store, so a session must exist
  // BEFORE the provider builds its HTML (no folder: nothing is filtered out).
  prepare?.(store);
  const sessions = new SessionManager(store);
  const registry = new SessionRegistry({ sessions, store, createAgent: (h) => stubAgent(h) });

  const provider = new ChatViewProvider(
    { get: () => CONFIG },
    { set: vi.fn(), clear: vi.fn() } as never,
    { pick: vi.fn(async () => []), buildContext: vi.fn(async () => ({ text: "", images: [] })) } as never,
    { getProvider: vi.fn(() => undefined), readProvidersEditor: vi.fn(() => ({ providers: {} })) } as never,
    { fetchModels: vi.fn(async () => []) } as never,
    sessions,
    registry,
    { workspaceReady: () => true },
  );
  provider.setContext({ extensionUri: { fsPath: "/ext" }, subscriptions: [] } as never);

  const view = {
    webview: {
      html: "",
      cspSource: "vscode-webview://test",
      options: {},
      onDidReceiveMessage: (fn: (m: unknown) => unknown) => {
        hostHandler = fn;
        return { dispose: () => {} };
      },
      postMessage: (m: unknown) => {
        hostToClient(m);
        return Promise.resolve(true);
      },
      asWebviewUri: (uri: { fsPath: string }) => ({
        with: () => ({ toString: () => "https://r/" + uri.fsPath }),
        toString: () => "https://r/" + uri.fsPath,
      }),
    },
    onDidChangeVisibility: () => ({ dispose: () => {} }),
    show: () => {},
  };
  provider.resolveWebviewView(view as never, {} as never, {});
  return { provider, store, sessions, html: () => view.webview.html };
}

/** Put the REAL page in the document and start the REAL client on it. */
async function bootClient(html: string): Promise<void> {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  document.body.innerHTML = parsed.body.innerHTML;
  (globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
    postMessage: (m: unknown) => {
      void hostHandler?.(m);
    },
    getState: () => ({}),
    setState: () => {},
  });
  // Record the listeners the client subscribes to (see windowListeners).
  const add = window.addEventListener;
  window.addEventListener = function (type: string, fn: EventListener, options?: AddEventListenerOptions | boolean) {
    windowListeners.push({ type, fn, options });
    return add.call(window, type, fn, options);
  } as typeof window.addEventListener;
  try {
    await import("./webview/view");
  } finally {
    window.addEventListener = add;
  }
  clientLive = true;
  for (const m of inbox.splice(0)) window.dispatchEvent(new MessageEvent("message", { data: m }));
}

/** The provider's HTML is built asynchronously (buildHtml awaits the config). */
async function pageOf(html: () => string): Promise<string> {
  await vi.waitFor(() => expect(html()).toContain("harny-view-init"), { timeout: 2000 });
  return html();
}

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

/** Let the host finish. Every click crosses the wire and the router AWAITS
 * (buildConfig, the modal answer, the store writes), so an assertion made in the
 * same tick would read the state from before the click. A handful of macrotask
 * turns drains that chain without polling. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
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

beforeEach(() => {
  inbox = [];
  clientLive = false;
  hostHandler = undefined;
  windowListeners = [];
  document.body.innerHTML = "";
  vi.resetModules();
});

afterEach(() => {
  for (const l of windowListeners) window.removeEventListener(l.type, l.fn, l.options);
  windowListeners = [];
});

describe("session cleanup, host ⇄ webview", () => {
  it("clicking the trash asks delete / rewind / empty IN THE REAL PAGE, and Empty empties the session", async () => {
    let id = "";
    const { store, html } = wire((s) => (id = seedSession(s, "Too long", TRANSCRIPT)));
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
    const { store, html } = wire((s) => (id = seedSession(s, "Compacted", TRANSCRIPT)));
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
    const { store, html } = wire((s) => (id = seedSession(s, "Never compacted", plain)));
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
    const { store, html } = wire((s) => (id = seedSession(s, "Gone", TRANSCRIPT)));
    await bootClient(await pageOf(html));

    trashOf(id).click();
    (document.getElementById("alert-ok") as HTMLButtonElement).click();
    await settle();

    expect(store.rows.has(id)).toBe(false);
    expect(document.querySelector(`.srow[data-id="${id}"]`)).toBeNull();
  });
});
