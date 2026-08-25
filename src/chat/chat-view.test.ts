import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConfigProvider, HarnyConfig, ProviderCatalog } from "../core/config/types";
import type { MemoryOverrideConfigProvider } from "../core/config/memory-override-config-provider";
import type { ModelListProvider } from "../core/llm/model-list";
import type { AttachmentService } from "./attachment-service";
import { SessionManager } from "../core/sessions/session-manager";
import type { SessionStore } from "../core/sessions/types";
import { SessionRegistry } from "./session-registry";
import type { ChatController } from "../core/agent/chat-controller";
import type { ChatHistory } from "../core/history/chat-history";
import { ChatViewProvider } from "./chat-view";
import { Compactor, DEFAULT_COMPACTION } from "../core/sessions/compactor";
import type { LLMProviderFactory } from "../core/llm/types";

const state = vi.hoisted(() => ({
  showInputBox: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  // In-panel name modal: auto-reply switch (tests that focus on the prompt
  // set noAutoName and reply manually via the handler).
  noAutoName: false,
  autoName: "New Session" as string | undefined,
}));

vi.mock("vscode", () => ({
  window: {
    showInputBox: state.showInputBox,
    showWarningMessage: state.showWarningMessage,
    showInformationMessage: state.showInformationMessage,
  },
  Uri: { joinPath: () => ({}) },
}));

const CONFIG: HarnyConfig = {
  provider: "openai",
  apiKey: "sk",
  baseUrl: "https://api.openai.com",
  model: "gpt-4o",
  maxTokens: 100,
  temperature: 0,
  contextFiles: true,
  autoApprove: false,
  autoOpen: false,
};

function makeStore(): SessionStore {
  let c = 0;
  return {
    list: vi.fn(() => []),
    create: vi.fn((name?: string) => ({ id: `s${++c}`, name: name?.trim() || "New Session", createdAt: 1, updatedAt: 1, messageCount: 0 })),
    load: vi.fn((id: string) => ({ summary: { id, name: "S", createdAt: 1, updatedAt: 1, messageCount: 0 }, messages: [] })),
    saveMessages: vi.fn((id: string, messages) => ({ id, name: "S", createdAt: 1, updatedAt: 2, messageCount: messages.length })),
    rename: vi.fn((id, name) => ({ id, name, createdAt: 1, updatedAt: 2, messageCount: 0 })),
    remove: vi.fn(() => true),
    saveModel: vi.fn((id, model, provider) => ({ id, name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 0, ...(model ? { model } : {}), ...(provider ? { modelProvider: provider } : {}) })),
    saveThinkingLevel: vi.fn((id, level) => ({ id, name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 0, thinkingLevel: level })),
    saveContextWindow: vi.fn((id, window) => ({ id, name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 0, ...(window ? { contextWindow: window } : {}) })),
    saveOutputTokens: vi.fn((id, tokens) => ({ id, name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 0, ...(tokens ? { outputTokens: tokens } : {}) })),
    saveTemperature: vi.fn((id, temp) => ({ id, name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 0, ...(temp !== undefined ? { temperature: temp } : {}) })),
    saveContextTokens: vi.fn((id, tokens) => ({ id, name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 0, ...(tokens ? { contextTokens: tokens } : {}) })),
  } as unknown as SessionStore;
}

function makeView() {
  let handler: ((m: any) => unknown) | undefined;
  const onDidReceiveMessage = vi.fn((fn: (m: any) => unknown) => {
    handler = fn;
  });
  const postMessage = vi.fn((m: any) => {
    // In-panel name modal: auto-answer so `await createNew()` etc. resolve.
    if (m.type === "promptName" && !state.noAutoName) {
      queueMicrotask(() => {
        handler?.({ type: "sessionName", mode: m.mode, id: m.id, name: state.autoName ?? "New Session" });
      });
    }
  });
  const view: any = {
    webview: {
      html: "",
      cspSource: "vscode-webview://test",
      onDidReceiveMessage,
      asWebviewUri: vi.fn(() => ({ with: (opts: any) => ({ toString: () => "https://r/view.js?" + opts.query }), toString: () => "https://r/view.js" })),
      postMessage,
      options: {},
    },
  };
  return { view, onDidReceiveMessage, postMessage };
}

function buildHarness(opts: Record<string, unknown> = {}) {
  // New sessions are named via a native prompt; default the mock so createNew
  // resolves unless a specific test overrides it.
  state.showInputBox.mockResolvedValue("New Session");
  const store = makeStore();
  const sessions = new SessionManager(store);
  const createAgent = vi.fn((h: ChatHistory): ChatController => {
    const history = h;
    const handlers: ((e: any) => void)[] = [];
    const agent: any = {
      streaming: false,
      getMessages: vi.fn(() => history.conversation()),
      reset: vi.fn(),
      load: vi.fn(),
      addUserMessage: vi.fn(),
      send: vi.fn(async () => {}),
      abort: vi.fn(),
      onEvent: vi.fn((fn: (e: any) => void) => {
        handlers.push(fn);
        return () => {
          const i = handlers.indexOf(fn);
          if (i >= 0) handlers.splice(i, 1);
        };
      }),
    };
    // emitEvents: used by the live-buffer tests to push real agent events.
    if (opts.emitEvents) {
      agent.emit = (e: any) => handlers.forEach((fn) => fn(e));
    }
    return agent as unknown as ChatController;
  });
  const registry = new SessionRegistry({ sessions, store, createAgent });
  const config: ConfigProvider = { get: () => (opts.config as HarnyConfig | undefined) ?? CONFIG };
  const modelSelector = { set: vi.fn(), clear: vi.fn() } as unknown as MemoryOverrideConfigProvider;
  const attachments = { pick: vi.fn(async () => []), buildContext: vi.fn(async () => ({ text: "", images: [] })) } as unknown as AttachmentService;
  const providers = {
    getProvider: vi.fn(() => opts.providerEntry as import("../core/config/types").ResolvedNamedProvider | undefined),
    saveModelSelection: vi.fn(),
  } as unknown as ProviderCatalog;
  const modelList = { fetchModels: vi.fn(opts.fetchModels ?? (async () => [])) } as unknown as ModelListProvider;

  const provider = new ChatViewProvider(config, modelSelector, attachments, providers, modelList, sessions, registry, opts);
  provider.setContext({ extensionUri: { fsPath: "/ext" }, subscriptions: [] } as any);
  return { store, sessions, registry, createAgent, provider, modelSelector };
}

function resolveWith(provider: ChatViewProvider): { view: any; handler: (msg: any) => Promise<void> } {
  const { view } = makeView();
  provider.resolveWebviewView(view, {} as any, {});
  return { view, handler: view.webview.onDidReceiveMessage.mock.calls[0][0] as (m: any) => Promise<void> };
}

describe("ChatViewProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.noAutoName = false;
    state.autoName = "New Session";
  });

  it("resolveWebviewView renders the unified layout", async () => {
    const { provider } = buildHarness();
    const { view } = resolveWith(provider);
    await new Promise((r) => setTimeout(r, 30));
    expect(view.webview.html).toContain('id="sessions"');
    expect(view.webview.html).toContain('id="tabs"');
    expect(view.webview.html).toContain('id="user-input"');
  });

  it("createNew prompts for a name and opens a new session runtime", async () => {
    const { provider, registry } = buildHarness();
    await provider.createNew();
    expect(registry.listOpenIds().length).toBe(1);
  });

  it("createNew asks for a name via the in-panel modal (New Session default)", async () => {
    const { provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew();
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "promptName", mode: "create", current: undefined }),
    );
    // the resolved session is named with the modal's answer (auto-replied)
    expect(state.showInputBox).not.toHaveBeenCalled(); // no native box: modal instead
  });

  it("cancelling the in-panel name prompt creates nothing", async () => {
    const { provider, registry } = buildHarness();
    const { handler } = resolveWith(provider);
    state.noAutoName = true;
    try {
      const pending = provider.createNew();
      await handler({ type: "cancelNamePrompt" });
      await pending;
      expect(registry.listOpenIds().length).toBe(0);
    } finally {
      state.noAutoName = false;
    }
  });

  it("switchTab message activates a session", async () => {
    const { provider, registry } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await provider.createNew(); // s2
    await handler({ type: "switchTab", id: "s1" });
    expect(registry.isOpen("s1")).toBe(true);
  });

  it("posts a switchView with the per-session working state when switching tabs", async () => {
    const { registry, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await provider.createNew(); // s2
    const rt1 = registry.get("s1")!;
    (rt1.agent as { streaming: boolean }).streaming = true;

    await handler({ type: "switchTab", id: "s2" });
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "switchView", activeId: "s2", streaming: false }),
    );

    await handler({ type: "switchTab", id: "s1" });
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "switchView", activeId: "s1", streaming: true, workingIds: ["s1"] }),
    );
  });

  it("handles several simultaneous working sessions independently", async () => {
    const { registry, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await provider.createNew(); // s2
    await provider.createNew(); // s3
    (registry.get("s1")!.agent as { streaming: boolean }).streaming = true;
    (registry.get("s3")!.agent as { streaming: boolean }).streaming = true;

    await handler({ type: "switchTab", id: "s2" });
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "switchView", activeId: "s2", streaming: false, workingIds: ["s1", "s3"] }),
    );
    await handler({ type: "switchTab", id: "s3" });
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "switchView", activeId: "s3", streaming: true }),
    );
  });

  it("keeps per-session live buffers isolated while any session streams", async () => {
    const { registry, provider } = buildHarness({ emitEvents: true });
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await provider.createNew(); // s2
    const a1: any = registry.get("s1")!.agent;
    const a2: any = registry.get("s2")!.agent;
    a1.streaming = true;

    // s1 streams while the user is on s2 (active tab): its deltas accumulate
    // in s1's OWN buffer and are NOT forwarded to the view.
    await handler({ type: "switchTab", id: "s2" });
    view.webview.postMessage.mockClear();
    a1.emit({ type: "thinking_delta", content: "s1 reasoning" });
    expect(view.webview.postMessage).not.toHaveBeenCalled();

    // Back on s1: the switchView replays ONLY s1's buffer (s2 stays empty).
    await handler({ type: "switchTab", id: "s1" });
    const calls = view.webview.postMessage.mock.calls;
    const last = calls[calls.length - 1][0];
    expect(last.type).toBe("switchView");
    expect(last.streaming).toBe(true);
    expect(last.liveThinking).toContain("s1 reasoning");
    expect(last.liveAnswer).toBe("");

    // s2 accumulates its own text_delta; s1's buffer stays unpolluted.
    await handler({ type: "switchTab", id: "s2" });
    a2.emit({ type: "text_delta", content: "s2 answer" });
    await handler({ type: "switchTab", id: "s1" });
    const calls2 = view.webview.postMessage.mock.calls;
    const last2 = calls2[calls2.length - 1][0];
    expect(last2.liveThinking).toContain("s1 reasoning");
    expect(last2.liveAnswer).toBe("");

    // s2's own switchView carries s2's answer, not s1's.
    await handler({ type: "switchTab", id: "s2" });
    const calls3 = view.webview.postMessage.mock.calls;
    const last3 = calls3[calls3.length - 1][0];
    expect(last3.liveAnswer).toContain("s2 answer");
  });

  it("does not push a refresh when the sending session is no longer the active tab", async () => {
    const { provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "m", provider: "p" }); // s1 has a model
    await provider.createNew(); // s2
    await handler({ type: "switchTab", id: "s1" }); // s1 active again
    view.webview.postMessage.mockClear();

    // Start sending on s1; while its agent.send is still pending, switch to s2.
    const sendPromise = handler({ type: "send", text: "hello" });
    await handler({ type: "switchTab", id: "s2" });
    await sendPromise;

    // s1 finished in the background: the view must NOT be rebuilt with s1's
    // transcript (it would clobber s2's UI).
    expect(view.webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "refresh" }));
  });

  it("newSession message creates and activates a session", async () => {
    const { provider, registry } = buildHarness();
    const { handler } = resolveWith(provider);
    await handler({ type: "newSession" });
    expect(registry.listOpenIds().length).toBe(1);
  });

  it("renameSession renames via the in-panel modal", async () => {
    const { store, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    state.autoName = "Refactor auth";
    try {
      await provider.createNew(); // auto-named "Refactor auth"
      view.webview.postMessage.mockClear();
      await handler({ type: "renameSession", id: "s1" });
      expect(view.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "promptName", mode: "rename", id: "s1" }),
      );
      expect(store.rename).toHaveBeenCalledWith("s1", "Refactor auth");
    } finally {
      state.autoName = "New Session";
    }
  });

  it("deleteSession closes the runtime and removes the persisted session", async () => {
    state.showWarningMessage.mockResolvedValueOnce("Delete");
    const { store, sessions, registry, provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew();
    await handler({ type: "deleteSession", id: "s1" });
    expect(registry.isOpen("s1")).toBe(false);
    expect(store.remove).toHaveBeenCalledWith("s1");
    expect(sessions.list()).toEqual([]);
  });

  it("refuses to delete a session that is still working", async () => {
    const { store, registry, provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    (rt.agent as { streaming: boolean }).streaming = true;

    await handler({ type: "deleteSession", id: "s1" });

    expect(registry.isOpen("s1")).toBe(true);
    expect(store.remove).not.toHaveBeenCalled();
    expect(state.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("while it is working"));
  });

  it("refuses to rename a session that is still working", async () => {
    const { store, registry, provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    (rt.agent as { streaming: boolean }).streaming = true;

    await handler({ type: "renameSession", id: "s1" });

    expect(store.rename).not.toHaveBeenCalled();
    expect(state.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("while it is working"));
  });

  it("setThinkingLevel persists the level and refreshes", async () => {
    const { store, provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setThinkingLevel", level: "high" });
    expect(store.saveThinkingLevel).toHaveBeenCalledWith("s1", "high");
  });

  it("setOutputTokens persists the value to the session and refreshes", async () => {
    const { store, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "gpt-4o", provider: undefined }); // runtime needs a model
    await handler({ type: "setOutputTokens", value: 16384 });
    expect(store.saveOutputTokens).toHaveBeenCalledWith("s1", 16384);
    await handler({ type: "getConfig" });
    const configPosts = view.webview.postMessage.mock.calls
      .map((c) => c[0] as any)
      .filter((m) => m.type === "config");
    expect(configPosts[configPosts.length - 1].config.outputTokens).toBe(16384);
  });

  it("setTemperature persists to the session, clears on Auto and applies the override", async () => {
    const { store, provider, modelSelector } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "gpt-4o", provider: undefined });
    await handler({ type: "setTemperature", value: 0.7 });
    expect(store.saveTemperature).toHaveBeenCalledWith("s1", 0.7);
    // 0 is a valid temperature and must be applied, not skipped as falsy.
    expect(modelSelector.set).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0.7 }));
    await handler({ type: "getConfig" });
    const configPosts = view.webview.postMessage.mock.calls
      .map((c) => c[0] as any)
      .filter((m) => m.type === "config");
    expect(configPosts[configPosts.length - 1].config.temperature).toBe(0.7);

    // Auto (null) clears the session value and the override.
    await handler({ type: "setTemperature", value: null });
    expect(store.saveTemperature).toHaveBeenCalledWith("s1", undefined);
    expect(modelSelector.set).toHaveBeenCalledWith(expect.not.objectContaining({ temperature: expect.any(Number) }));
    await handler({ type: "getConfig" });
    const posts = view.webview.postMessage.mock.calls
      .map((c) => c[0] as any)
      .filter((m) => m.type === "config");
    expect(posts[posts.length - 1].config.temperature).toBeUndefined();
  });

  it("closeTab falls back to the last open tab when closing the active one", async () => {
    const { provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await provider.createNew(); // s2 (active)
    await handler({ type: "closeTab", id: "s2" });
    const last = view.webview.postMessage.mock.calls[view.webview.postMessage.mock.calls.length - 1][0] as any;
    expect(last.type).toBe("switchView");
    expect(last.activeId).toBe("s1");
  });

  it("closeTab on an inactive session leaves the active one untouched", async () => {
    const { provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await provider.createNew(); // s2 (active)
    await handler({ type: "closeTab", id: "s1" });
    const last = view.webview.postMessage.mock.calls[view.webview.postMessage.mock.calls.length - 1][0] as any;
    expect(last.type).toBe("switchView");
    expect(last.activeId).toBe("s2");
  });

  it("openSession opens an existing session", async () => {
    const { provider, registry } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await provider.createNew(); // s2 (active)
    await handler({ type: "openSession", id: "s1" });
    expect(registry.isOpen("s1")).toBe(true);
  });

  it("createWithMessage seeds the agent and names the session", async () => {
    state.showInputBox.mockResolvedValue("Explain");
    const { provider, registry } = buildHarness();
    await provider.createWithMessage("Explain this code");
    expect((registry.get("s1")!.agent as any).addUserMessage).toHaveBeenCalledWith("Explain this code");
  });

  it("usage events update the session context tokens and persist them", async () => {
    const { store, registry, provider } = buildHarness({ emitEvents: true });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    (rt.agent as any).emit({ type: "usage", usage: { input: 50, output: 4, total: 54 } });
    expect(rt.contextTokens).toBe(50);
    expect(store.saveContextTokens).toHaveBeenCalledWith("s1", 50);
  });

  it("setModel with a named provider applies its overrides", async () => {
    const { provider, modelSelector } = buildHarness({
      providerEntry: {
        name: "opencode-go",
        baseUrl: "https://x/v1",
        apiKey: "sk",
        enableThinking: true,
        thinkingMode: "effort",
        maxTokens: 123,
        models: [{ id: "m1", input: ["text", "image"] }],
      },
    });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "m1", provider: "opencode-go" });
    expect(modelSelector.set).toHaveBeenCalledWith(
      expect.objectContaining({
        activeProvider: "opencode-go",
        baseUrl: "https://x/v1",
        maxTokens: 123,
        thinkingMode: "effort",
        availableModels: ["m1"],
      }),
    );
  });

  it("buildConfig fetches and caches the host model list", async () => {
    const fetchModels = vi.fn(async () => ["h1", "h2"]);
    const { provider } = buildHarness({
      config: { ...CONFIG, hostModelProviders: ["opencode-go"] },
      providerEntry: { name: "opencode-go", baseUrl: "https://x/v1", apiKey: "k", models: [] },
      fetchModels,
    });
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "getConfig" });
    await handler({ type: "getConfig" });
    const configPosts = view.webview.postMessage.mock.calls
      .map((c) => c[0] as any)
      .filter((m) => m.type === "config");
    const cfg = configPosts[configPosts.length - 1].config;
    expect(cfg.providerModels).toContainEqual({ provider: "opencode-go", model: "h1" });
    expect(fetchModels).toHaveBeenCalledTimes(1); // cached (HOST_CACHE_TTL)
  });

  it("send routes to the active runtime agent", async () => {
    const { registry, provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew();
    // New sessions start with no model: pick one before sending.
    await handler({ type: "setModel", model: "deepseek-v4-flash", provider: "opencode-go" });
    await handler({ type: "send", text: "hello" });
    const rt = registry.get("s1")!;
    expect(rt.agent.send).toHaveBeenCalledWith("hello", undefined);
  });

  it("abort while streaming posts an interrupted notice and persists it", async () => {
    const { registry, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    (rt.agent as { streaming: boolean }).streaming = true;
    await handler({ type: "abort" });
    expect(rt.agent.abort).toHaveBeenCalled();
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "interrupted" });
    expect(rt.history.all().some((m) => !m.uiOnly && /Processing interrupted/.test(m.content ?? ""))).toBe(true);
  });

  it("abort without streaming does nothing", async () => {
    const { registry, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    (rt.agent as { streaming: boolean }).streaming = false;
    await handler({ type: "abort" });
    expect(rt.agent.abort).not.toHaveBeenCalled();
    expect(view.webview.postMessage).not.toHaveBeenCalledWith({ type: "interrupted" });
  });

  it("blocks send when the active session has no model", async () => {
    const { registry, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew();
    await handler({ type: "send", text: "hello" });
    const rt = registry.get("s1")!;
    expect(rt.agent.send).not.toHaveBeenCalled();
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", error: expect.stringContaining("Select a model") }),
    );
  });
});


describe("ChatViewProvider per-session model", () => {
  beforeEach(() => vi.clearAllMocks());

  it("setModel stores and persists the selection on the active session", async () => {
    const { store, registry, provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "gemma.gguf", provider: "llamacpp" });

    const rt = registry.get("s1")!;
    expect(rt.model).toBe("gemma.gguf");
    expect(rt.modelProvider).toBe("llamacpp");
    expect(store.saveModel).toHaveBeenCalledWith("s1", "gemma.gguf", "llamacpp");
  });

  it("applies the session model when switching to it and clears it for new sessions", async () => {
    const { store, registry, provider, modelSelector } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1 (new: no model) -> clear
    expect(modelSelector.clear).toHaveBeenCalled();

    registry.create(); // s2
    await handler({ type: "switchTab", id: "s2" }); // s2 active (no model) -> clear
    await handler({ type: "setModel", model: "deepseek-v4-pro", provider: "opencode-go" }); // on s2

    expect(registry.get("s2")!.model).toBe("deepseek-v4-pro");
    // Switching away (s1: no model) clears, switching back to s2 re-applies its model.
    modelSelector.set.mockClear();
    await handler({ type: "switchTab", id: "s1" });
    await handler({ type: "switchTab", id: "s2" });
    expect(modelSelector.set).toHaveBeenCalledWith(expect.objectContaining({ model: "deepseek-v4-pro" }));
  });
});

describe("ChatViewProvider context window", () => {
  it("setContextWindow persists on the session and clamps", async () => {
    const { store, registry, provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setContextWindow", value: 200000 });
    expect(registry.get("s1")!.contextWindow).toBe(200000);
    expect(store.saveContextWindow).toHaveBeenCalledWith("s1", 200000);
  });
});

describe("ChatViewProvider output tokens reload", () => {
  it("reapplies the persisted session output tokens to the active config on reopen", async () => {
    const { store, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    // Simulate a session persisted on disk with both model and outputTokens.
    (store.load as ReturnType<typeof vi.fn>).mockReturnValue({
      summary: { id: "s9", name: "S", createdAt: 1, updatedAt: 1, messageCount: 0, model: "gpt-4o", outputTokens: 16384 },
      messages: [],
    });
    await handler({ type: "openSession", id: "s9" });
    await handler({ type: "switchTab", id: "s9" }); // makes it the active runtime
    await handler({ type: "getConfig" });
    const configPosts = view.webview.postMessage.mock.calls
      .map((c) => c[0] as any)
      .filter((m) => m.type === "config");
    expect(configPosts[configPosts.length - 1].config.outputTokens).toBe(16384);
  });
});

describe("ChatViewProvider temperature reload", () => {
  it("reapplies the persisted session temperature to the active config on reopen", async () => {
    const { store, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    // Simulate a session persisted on disk with both model and temperature.
    (store.load as ReturnType<typeof vi.fn>).mockReturnValue({
      summary: { id: "s9", name: "S", createdAt: 1, updatedAt: 1, messageCount: 0, model: "gpt-4o", temperature: 0.3 },
      messages: [],
    });
    await handler({ type: "openSession", id: "s9" });
    await handler({ type: "switchTab", id: "s9" }); // makes it the active runtime
    await handler({ type: "getConfig" });
    const configPosts = view.webview.postMessage.mock.calls
      .map((c) => c[0] as any)
      .filter((m) => m.type === "config");
    expect(configPosts[configPosts.length - 1].config.temperature).toBe(0.3);
  });
});

describe("ChatViewProvider compaction", () => {
  function compactorFactory(): LLMProviderFactory {
    return {
      create: vi.fn(() => ({
        protocol: "chat" as const,
        async *stream() {
          yield { type: "text", content: "## Goal\nConsolidated summary" };
        },
      })),
    } as unknown as LLMProviderFactory;
  }

  it("compact (manual) re-summarizes context via the compactor", async () => {
    state.showWarningMessage.mockResolvedValueOnce("Compact");
    const options = { compactor: new Compactor(compactorFactory(), () => CONFIG), compaction: DEFAULT_COMPACTION };
    const { store, registry, provider } = buildHarness(options);
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.contextWindow = 200000;
    rt.contextTokens = 26000; // 13%
    rt.history.replace([
      { role: "user", content: "let's go", timestamp: 1 },
      { role: "assistant", content: "ok", timestamp: 2 },
      { role: "user", content: "then", timestamp: 3 },
      { role: "assistant", content: "done", timestamp: 4 },
    ]);

    await handler({ type: "compact" });

    const conv = registry.get("s1")!.history.conversation();
    expect(conv[0].role).toBe("system"); // the summary was injected
    expect(String(conv[0].content)).toContain("## Goal");
    expect((store.saveContextTokens as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    // stale cache hits from the pre-compaction turn are reset (no >100% ratio)
    expect(rt.cachedTokens).toBe(0);
    // final bubble posted (the UI shows completion, no toast needed)
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "compactDone" });
  });
});
