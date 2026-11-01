// @vitest-environment jsdom
import { vi, expect } from "vitest";
import type { ChatMessage } from "../core/history/types";
import type { ChatHistory } from "../core/history/chat-history";
import type { ChatController } from "../core/agent/chat-controller";
import type { HarnyConfig, ProviderCatalog } from "../core/config/types";
import type { SessionSettingsPatch, SessionStore, SessionSummary } from "../core/sessions/types";
import { SessionManager } from "../core/sessions/session-manager";
import { ChatViewProvider } from "./chat-view";
import { SessionRegistry } from "./session-registry";

/**
 * The HOST ⇄ WEBVIEW bridge for the end-to-end tests (`*.integration.test.ts`).
 *
 * A unit test on each side cannot see the seam: a field the host posts and the client
 * does not read, an answer the client sends while the host compares to something else,
 * or a page that has an element the client's fixture invented. Here both halves run
 * FOR REAL — the provider over a real store, the page `renderViewHtml` produces, the
 * real client module — and the test only clicks.
 *
 * What is NOT shared, on purpose: the `vi.mock("vscode", …)` of each file. Mocks are
 * per test FILE, and hoisting only sees the test file's own imports, so every
 * integration file carries its own three-line stub (see the top of the callers).
 */

const CONFIG: HarnyConfig = {
  provider: "openai",
  apiKey: "sk",
  baseUrl: "https://api.openai.com",
  model: "gpt-4o",
  maxTokens: 100,
  temperature: 0,
  autoOpen: false,
};

// ── A REAL in-memory store: the tests assert on what was PERSISTED, not on call
//    logs (a call log cannot tell "saved the wrong array" from "saved"). ─────────
export interface MemoryStore extends SessionStore {
  rows: Map<string, SessionSummary>;
  transcripts: Map<string, ChatMessage[]>;
}

export function memoryStore(): MemoryStore {
  let n = 0;
  const rows = new Map<string, SessionSummary>();
  const transcripts = new Map<string, ChatMessage[]>();
  return {
    rows,
    transcripts,
    list: () => [...rows.values()].map((s) => ({ ...s })),
    // The interface's O(1) metadata read (see SessionStore.summary): the SqliteSessionStore has
    // it, and a store that does not would break every caller that only needs one setting.
    summary: (id: string) => {
      const row = rows.get(id);
      return row ? { ...row } : undefined;
    },
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
      const summary = rows.get(id) ?? { id, name: "S", createdAt: 1, updatedAt: 1, messageCount: 0 };
      const messages = [...(transcripts.get(id) ?? [])];
      return { summary: { ...summary, messageCount: messages.length }, messages };
    },
    saveMessages(id: string, messages: ChatMessage[]) {
      transcripts.set(id, [...messages]);
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, messageCount: messages.length, updatedAt: Date.now() });
      return {
        ...(rows.get(id) ?? { id, name: "S", createdAt: 1, updatedAt: 1, messageCount: messages.length }),
      };
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
    // No maintenance support: the vacuum suggestion is a no-op, which keeps the flows
    // free of an unrelated modal.
    dbVacuumStats: () => ({ pageCount: 0, freePages: 0, pageSize: 0, bytesFree: 0, bytesTotal: 0, ratio: 0 }),
  };
}

/** The agent, reduced to what these flows need (no model is ever called). */
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
/** Listeners the client registered on the SHARED window: detached after every test,
 * or each test would add one more handler onto the same DOM. */
let windowListeners: { type: string; fn: EventListener; options?: AddEventListenerOptions | boolean }[] = [];

interface WireOptions {
  /** Seed the store BEFORE the provider builds its HTML (the list comes from it). */
  prepare?: (store: MemoryStore) => void;
  /** Overrides for the config/provider catalog the host reads and writes. */
  providers?: Partial<ProviderCatalog>;
  /** The McpManager to hand to the provider (absent = no MCP). */
  mcp?: unknown;
  /** Extra provider options (e.g. `currentFolder`). */
  options?: Record<string, unknown>;
}

interface Wiring {
  provider: ChatViewProvider;
  store: MemoryStore;
  sessions: SessionManager;
  /** The page the provider built (empty until `pageOf` resolves). */
  html: () => string;
}

export function wire(opts: WireOptions = {}): Wiring {
  const store = memoryStore();
  opts.prepare?.(store);
  const sessions = new SessionManager(store);
  let provider: ChatViewProvider;
  const registry = new SessionRegistry({
    sessions,
    store,
    createAgent: (h) => stubAgent(h),
    configFor: (id) => provider.sessionConfigFor(id),
  });
  const providers = {
    getProvider: () => undefined,
    readProvidersEditor: () => ({ providers: {} }),
    readMcpServers: () => ({}),
    saveMcpServers: () => true,
    ...opts.providers,
  } as unknown as ProviderCatalog;

  provider = new ChatViewProvider(
    { get: () => CONFIG },
    { pick: vi.fn(async () => []), buildContext: vi.fn(async () => ({ text: "", images: [] })) } as never,
    providers,
    { fetchModels: vi.fn(async () => []) } as never,
    sessions,
    registry,
    {
      workspaceReady: () => true,
      ...(opts.mcp ? { mcp: opts.mcp } : {}),
      ...(opts.options ?? {}),
    } as never,
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

function hostToClient(msg: unknown): void {
  if (!clientLive) {
    inbox.push(msg);
    return;
  }
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

/** Put the REAL page in the document and start the REAL client on it. */
export async function bootClient(html: string): Promise<void> {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  document.body.innerHTML = parsed.body.innerHTML;
  (globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
    postMessage: (m: unknown) => {
      void hostHandler?.(m);
    },
    getState: () => ({}),
    setState: () => {},
  });
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
export async function pageOf(html: () => string): Promise<string> {
  await vi.waitFor(() => expect(html()).toContain("harny-view-init"), { timeout: 2000 });
  return html();
}

/** Let the host finish. Every click crosses the wire and the router AWAITS
 * (buildConfig, a modal answer, the store writes), so an assertion made in the same
 * tick would read the state from before the click. A handful of macrotask turns
 * drains that chain without polling — for work that SPAWNS something (an MCP
 * server) use `vi.waitFor` instead, which is the honest tool there. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Fresh wire + document for a test (call from `beforeEach`). */
export function resetBridge(): void {
  inbox = [];
  clientLive = false;
  hostHandler = undefined;
  windowListeners = [];
  document.body.innerHTML = "";
  vi.resetModules();
}

/** Detach what the client subscribed to (call from `afterEach`). */
export function detachBridge(): void {
  for (const l of windowListeners) window.removeEventListener(l.type, l.fn, l.options);
  windowListeners = [];
}
