import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConfigProvider, HarnyConfig, ProviderCatalog } from "../core/config/types";
import { MemoryOverrideConfigProvider } from "../core/config/memory-override-config-provider";
import { CompositeConfigProvider } from "../core/config/composite-config-provider";
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
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  // In-panel name modal: auto-reply switch (tests that focus on the prompt
  // set noAutoName and reply manually via the handler).
  noAutoName: false,
  autoName: "New Session" as string | undefined,
  // In-panel alert/confirm: auto-reply switch (default = confirm OK).
  noAutoAlert: false,
  alertOk: true as boolean | undefined,
  // VS Code dialogs exercised by the manage-sessions form.
  showOpenDialog: vi.fn(),
}));

vi.mock("vscode", () => ({
  window: {
    showInputBox: state.showInputBox,
    showWarningMessage: state.showWarningMessage,
    showErrorMessage: state.showErrorMessage,
    showInformationMessage: state.showInformationMessage,
    showOpenDialog: state.showOpenDialog,
  },
  workspace: {
    getConfiguration: () => ({ get: (key: string) => (key === "fontSize" ? 14 : undefined) }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
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
    saveSettings: vi.fn((id, patch) => ({ id, name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 0, ...patch })),
    rename: vi.fn((id, name) => ({ id, name, createdAt: 1, updatedAt: 2, messageCount: 0 })),
    remove: vi.fn(() => true),
    saveModel: vi.fn((id, model, provider) => ({ id, name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 0, ...(model ? { model } : {}), ...(provider ? { modelProvider: provider } : {}) })),
    saveThinkingLevel: vi.fn((id, level) => ({ id, name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 0, thinkingLevel: level })),
    saveContextWindow: vi.fn((id, window) => ({ id, name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 0, ...(window ? { contextWindow: window } : {}) })),
    saveOutputTokens: vi.fn((id, tokens) => ({ id, name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 0, ...(tokens ? { outputTokens: tokens } : {}) })),
    saveTemperature: vi.fn((id, temp) => ({ id, name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 0, ...(temp !== undefined ? { temperature: temp } : {}) })),
    savePresencePenalty: vi.fn((id, value) => ({ id, name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 0, ...(value !== undefined ? { presencePenalty: value } : {}) })),
    saveFrequencyPenalty: vi.fn((id, value) => ({ id, name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 0, ...(value !== undefined ? { frequencyPenalty: value } : {}) })),
    saveTopP: vi.fn((id, value) => ({ id, name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 0, ...(value !== undefined ? { topP: value } : {}) })),
    saveSampler: vi.fn((id, mode) => ({ id, name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 0, ...(mode ? { sampler: mode } : {}) })),
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
    if (m.type === "modal") {
      if (m.kind === "name" && !state.noAutoName) {
        queueMicrotask(() => {
          handler?.({ type: "modalResponse", id: m.modalId, value: state.autoName ?? "New Session" });
        });
      }
      if (m.kind === "alert" && !state.noAutoAlert) {
        queueMicrotask(() => {
          handler?.({ type: "modalResponse", id: m.modalId, value: state.alertOk ?? true });
        });
      }
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
      send: vi.fn(async () => {
        // Mirrors the real Agent: streaming flips synchronously on send start.
        agent.streaming = true;
      }),
      abort: vi.fn(),
      abortSubAgent: vi.fn(),
      setMode: vi.fn(),
      setDelegation: vi.fn(),
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
  // Faithful config chain, like the composition root in extension.ts:
  // base + a REAL memory-override provider wrapped in spies (keeps behaviour
  // for the provider and lets tests assert on set/clear calls).
  const base: ConfigProvider = { get: () => (opts.config as HarnyConfig | undefined) ?? CONFIG };
  const modelSelector = new MemoryOverrideConfigProvider();
  vi.spyOn(modelSelector, "set");
  vi.spyOn(modelSelector, "clear");
  const config = new CompositeConfigProvider(base, [modelSelector]);
  const attachments = (opts.attachments as AttachmentService | undefined) ?? ({ pick: vi.fn(async () => []), buildContext: vi.fn(async () => ({ text: "", images: [] })) } as unknown as AttachmentService);
  const providers = (opts.providers as ProviderCatalog | undefined) ?? {
    getProvider: vi.fn(() => opts.providerEntry as import("../core/config/types").ResolvedNamedProvider | undefined),
    saveModelSelection: vi.fn(),
    readProvidersEditor: vi.fn(() => ({ providers: {} })),
    saveProvidersEditor: vi.fn(() => true),
  } as unknown as ProviderCatalog;
  const modelList = {
    fetchModels: vi.fn(opts.fetchModels ?? (async () => [])),
    ...(opts.fetchModelInfos ? { fetchModelInfos: vi.fn(opts.fetchModelInfos as () => Promise<unknown[]>) } : {}),
  } as unknown as ModelListProvider;

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
      expect.objectContaining({ type: "modal", kind: "name", mode: "create", current: undefined }),
    );
    // the resolved session is named with the modal's answer (auto-replied)
    expect(state.showInputBox).not.toHaveBeenCalled(); // no native box: modal instead
  });

  it("createNew without a single workspace asks for a folder and creates nothing", async () => {
    const { store, provider } = buildHarness({ workspaceReady: () => false });
    const { handler, view } = resolveWith(provider);
    await handler({ type: "newSession" });
    expect(store.create).not.toHaveBeenCalled();
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "modal", kind: "alert", message: expect.stringContaining("exactly one open folder") }),
    );
  });

  it("cancelling the in-panel name prompt creates nothing", async () => {
    const { provider, registry } = buildHarness();
    const { handler, view } = resolveWith(provider);
    state.noAutoName = true;
    try {
      const pending = provider.createNew();
      const modalPost = view.webview.postMessage.mock.calls
        .map((c) => c[0] as any)
        .find((m) => m.type === "modal");
      await handler({ type: "modalResponse", id: modalPost.modalId, value: undefined });
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

  it("queues modals FIFO: a second modal is only shown after the first resolves", async () => {
    const { provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    state.noAutoName = true;
    state.noAutoAlert = true;
    try {
      // Name dialog opens (queue head posted).
      const create = provider.createNew();
      // While it is open, a delete confirm arrives: it must QUEUE, not show.
      const del = handler({ type: "deleteSession", id: "s1" });
      const posts = () => view.webview.postMessage.mock.calls.map((c) => c[0] as any).filter((m) => m.type === "modal");
      expect(posts().map((m) => m.kind)).toEqual(["name"]); // alert NOT shown yet

      // Resolve the name modal -> the queued alert is now posted automatically.
      await handler({ type: "modalResponse", id: posts()[0].modalId, value: "New Session" });
      await create;
      const alertPost = posts().find((m) => m.kind === "alert");
      expect(alertPost).toBeTruthy();

      await handler({ type: "modalResponse", id: alertPost.modalId, value: true });
      await del;
    } finally {
      state.noAutoName = false;
      state.noAutoAlert = false;
    }
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

  it("send without a model keeps user message + warning in history (follow-up keeps context)", async () => {
    const { registry, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1

    expect(registry.get("s1")!.model).toBeUndefined(); // new session: no model yet
    await handler({ type: "send", text: "primo messaggio" });

    // both entries persist: refresh/switch re-renders from history, and the
    // next "now do it" (after picking a model) still sees this message.
    const msgs = registry.get("s1")!.agent.getMessages();
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[0].content).toBe("primo messaggio");
    expect(msgs[1].content).toContain("Select a model");
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", error: expect.stringContaining("Select a model") }),
    );
  });

  it("send with attachments only builds context and sends (no text needed)", async () => {
    const attachments = {
      pick: vi.fn(async () => []),
      buildContext: vi.fn(async () => ({ text: 'Attached file "a.txt":\n```\nhi\n```', images: [] })),
    } as unknown as AttachmentService;
    const { registry, provider } = buildHarness({ attachments });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "m", provider: "p" });
    const agent = registry.get("s1")!.agent as any;

    await handler({
      type: "send",
      text: "",
      attachments: [{ name: "a.txt", path: "/tmp/a.txt", size: 2, isImage: false }],
    });

    expect(attachments.buildContext).toHaveBeenCalled();
    expect(agent.send).toHaveBeenCalledWith(
      expect.stringContaining("Attached file"),
      expect.objectContaining({
        attachments: [{ name: "a.txt", path: "/tmp/a.txt", size: 2 }],
        displayText: "",
      }),
    );
  });

  it("pickFiles asks the attachment service and posts the picked files", async () => {
    const picked = [{ name: "a.txt", path: "/tmp/a.txt", size: 2, isImage: false }];
    const attachments = {
      pick: vi.fn(async () => picked),
      buildContext: vi.fn(async () => ({ text: "", images: [] })),
    } as unknown as AttachmentService;
    const { provider } = buildHarness({ attachments });
    const { handler, view } = resolveWith(provider);
    await provider.createNew();
    view.webview.postMessage.mockClear();

    await handler({ type: "pickFiles" });

    expect(attachments.pick).toHaveBeenCalled();
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "attachments", files: picked });
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
        expect.objectContaining({ type: "modal", kind: "name", mode: "rename", id: "s1" }),
      );
      expect(store.rename).toHaveBeenCalledWith("s1", "Refactor auth");
    } finally {
      state.autoName = "New Session";
    }
  });

  it("deleteSession closes the runtime and removes the persisted session", async () => {
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
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    (rt.agent as { streaming: boolean }).streaming = true;

    await handler({ type: "deleteSession", id: "s1" });

    expect(registry.isOpen("s1")).toBe(true);
    expect(store.remove).not.toHaveBeenCalled();
  });

  it("refuses to rename a session that is still working", async () => {
    const { store, registry, provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    (rt.agent as { streaming: boolean }).streaming = true;

    await handler({ type: "renameSession", id: "s1" });

    expect(store.rename).not.toHaveBeenCalled();
  });

  it("setThinkingLevel persists the level, refreshes and pushes config", async () => {
    const { store, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "gpt-4o", provider: undefined });
    await handler({ type: "setThinkingLevel", level: "high" });
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { thinkingLevel: "high" });
    const configPosts = view.webview.postMessage.mock.calls
      .map((c) => c[0] as any)
      .filter((m) => m.type === "config");
    expect(configPosts[configPosts.length - 1].config.thinkingLevel).toBe("high");
  });

  it("setMode stores the mode on the runtime, propagates it to the agent and pushes config", async () => {
    const { provider, registry } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;

    await handler({ type: "setMode", mode: "agent" });
    expect(rt.mode).toBe("agent");
    expect(rt.agent.setMode).toHaveBeenCalledWith("agent");

    await handler({ type: "setMode", mode: "analyze" });
    expect(rt.mode).toBe("analyze");
    expect(rt.agent.setMode).toHaveBeenCalledWith("analyze");

    const configPosts = view.webview.postMessage.mock.calls
      .map((c) => c[0] as any)
      .filter((m) => m.type === "config");
    expect(configPosts[configPosts.length - 1].config.mode).toBe("analyze");

    // invalid modes are rejected
    await handler({ type: "setMode", mode: "banana" });
    expect(rt.mode).toBe("analyze");
  });

  it("setParallel applies to the active agent and pushes config", async () => {
    const { provider, registry } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;

    await handler({ type: "setParallel", parallel: true });
    expect(rt.agent.setDelegation).toHaveBeenCalledWith(true);
    const configPosts = view.webview.postMessage.mock.calls
      .map((c) => c[0] as any)
      .filter((m) => m.type === "config");
    expect(configPosts[configPosts.length - 1].config.parallel).toBe(true);

    // non-boolean payloads are rejected
    await handler({ type: "setParallel", parallel: "yes" });
    const after = view.webview.postMessage.mock.calls
      .map((c) => c[0] as any)
      .filter((m) => m.type === "config");
    expect(after[after.length - 1].config.parallel).toBe(true);
  });

  it("a NEW session resets Parallel OFF", async () => {
    const { provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    // Turn Parallel on globally (no active session yet).
    await handler({ type: "setParallel", parallel: true });

    // Creating a session must force Parallel off (the switchView config).
    await provider.createNew();

    const switchPosts = view.webview.postMessage.mock.calls
      .map((c) => c[0] as any)
      .filter((m) => m.type === "switchView");
    expect(switchPosts[switchPosts.length - 1].config.parallel).toBe(false);
  });

  it("reports a CONCRETE mode: a fresh session is analyze even after another was agent", async () => {
    const { provider, registry } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setMode", mode: "agent" });
    expect(registry.get("s1")!.mode).toBe("agent");

    // A brand-new session must report analyze (never a stale/undefined mode).
    const s2 = registry.create("Other");
    await provider.setActive(s2.sessionId);

    const switchPosts = view.webview.postMessage.mock.calls
      .map((c) => c[0] as any)
      .filter((m) => m.type === "switchView");
    expect(switchPosts[switchPosts.length - 1].config.mode).toBe("analyze");
  });

  it("setOutputTokens persists the value to the session and refreshes", async () => {
    const { store, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "gpt-4o", provider: undefined }); // runtime needs a model
    await handler({ type: "setOutputTokens", value: 16384 });
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { outputTokens: 16384 });
    const configPosts = view.webview.postMessage.mock.calls
      .map((c) => c[0] as any)
      .filter((m) => m.type === "config");
    expect(configPosts[configPosts.length - 1].config.outputTokens).toBe(16384);
  });

  it("setPresencePenalty/setFrequencyPenalty persist and push config", async () => {
    const { store, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "gpt-4o", provider: undefined });
    await handler({ type: "setPresencePenalty", value: 1.5 });
    await handler({ type: "setFrequencyPenalty", value: 0.5 });
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { presencePenalty: 1.5 });
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { frequencyPenalty: 0.5 });
    const configPosts = view.webview.postMessage.mock.calls
      .map((c) => c[0] as any)
      .filter((m) => m.type === "config");
    const cfg = configPosts[configPosts.length - 1].config;
    expect(cfg.presencePenalty).toBe(1.5);
    expect(cfg.frequencyPenalty).toBe(0.5);
  });

  it("sampler value persists on the active field and switching mode clears both to Auto", async () => {
    const { store, provider, modelSelector } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "gpt-4o", provider: undefined });
    // Temperature (default): the shared value lands on temperature, 0 is valid.
    await handler({ type: "setSamplerValue", value: 0 });
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { temperature: 0 });
    expect(modelSelector.set).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0 }));

    // Switch to Top-P: mode persists AND both stored values reset to Auto.
    await handler({ type: "setSamplerMode", mode: "topP" });
    // temperature was set (0), so it is cleared to Auto in the same patch.
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { sampler: "topP", temperature: undefined });
    // Only the active sampler carries a value: temperature cleared to none.
    expect(modelSelector.set).toHaveBeenCalledWith(expect.objectContaining({ topP: undefined, temperature: undefined }));

    // Now the shared value lands on topP (0.9 valid on the 0–1 scale).
    await handler({ type: "setSamplerValue", value: 0.9 });
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { topP: 0.9 });
    const configPosts = view.webview.postMessage.mock.calls
      .map((c) => c[0] as any)
      .filter((m) => m.type === "config");
    const cfg = configPosts[configPosts.length - 1].config;
    expect(cfg.sampler).toBe("topP");
    expect(cfg.topP).toBe(0.9);
    expect(cfg.temperature).toBeUndefined(); // inactive sampler never sent
  });

  it("closeTab falls back to the last open tab when closing the active one", async () => {
    const { provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await provider.createNew(); // s2 (active)
    await handler({ type: "closeTab", id: "s2" });
    // The switchView (with the new active tab) is still posted — the later
    // sessionsManager refresh only re-renders the manage form.
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "switchView", activeId: "s1" }),
    );
  });

  it("closeTab on an inactive session leaves the active one untouched", async () => {
    const { provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await provider.createNew(); // s2 (active)
    await handler({ type: "closeTab", id: "s1" });
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "switchView", activeId: "s2" }),
    );
  });

  it("openSession opens an existing session", async () => {
    const { provider, registry } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await provider.createNew(); // s2 (active)
    await handler({ type: "openSession", id: "s1" });
    expect(registry.isOpen("s1")).toBe(true);
  });

  it("branchSession copies messages + settings and activates the branch", async () => {
    const { store, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "gpt-4o", provider: undefined });
    await handler({ type: "setOutputTokens", value: 16384 });
    (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "s1", name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 2, model: "gpt-4o", outputTokens: 16384 },
    ]);
    (store.load as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === "s1"
        ? {
            summary: { id: "s1", name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 2, model: "gpt-4o", outputTokens: 16384 },
            messages: [
              { role: "user", content: "hi", timestamp: 1 },
              { role: "assistant", content: "hello", timestamp: 2 },
            ],
          }
        : { summary: { id, name: "S", createdAt: 1, updatedAt: 1, messageCount: 0 }, messages: [] },
    );
    state.autoName = "Branch copy"; // must differ from the source name
    await handler({ type: "branchSession", id: "s1" });

    // create() returned s1 on the original session, so the branch is s2.
    expect(store.create).toHaveBeenCalledWith("Branch copy");
    expect(store.saveMessages).toHaveBeenCalledWith("s2", [
      { role: "user", content: "hi", timestamp: 1 },
      { role: "assistant", content: "hello", timestamp: 2 },
    ]);
    expect(store.saveSettings).toHaveBeenCalledWith("s2", { model: "gpt-4o", outputTokens: 16384 });
    const switchPosts = view.webview.postMessage.mock.calls
      .map((c) => c[0] as any)
      .filter((m) => m.type === "switchView");
    expect(switchPosts[switchPosts.length - 1].activeId).toBe("s2");
  });

  it("branchAt copies the transcript up to (and including) the given reply", async () => {
    const { store, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1 (active)
    const msgs = [
      { role: "user", content: "q1", timestamp: 1 },
      { role: "assistant", content: "a1", timestamp: 2 },
      { role: "user", content: "q2", timestamp: 3 },
      { role: "assistant", content: "a2", timestamp: 4 },
    ];
    (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "s1", name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 4, model: "gpt-4o" },
    ]);
    (store.load as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === "s1"
        ? { summary: { id: "s1", name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 4, model: "gpt-4o" }, messages: msgs }
        : { summary: { id, name: "S", createdAt: 1, updatedAt: 1, messageCount: 0 }, messages: [] },
    );
    state.autoName = "Branch copy";
    await handler({ type: "branchAt", index: 2 }); // up to q2 -> [q1, a1, q2]
    expect(store.create).toHaveBeenCalledWith("Branch copy");
    expect(store.saveMessages).toHaveBeenCalledWith("s2", [msgs[0], msgs[1], msgs[2]]);
    const switchPosts = view.webview.postMessage.mock.calls
      .map((c) => c[0] as any)
      .filter((m) => m.type === "switchView");
    expect(switchPosts[switchPosts.length - 1].activeId).toBe("s2");
  });

  it("branchAt ignores out-of-range or invalid indexes", async () => {
    const { store, provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    (store.load as ReturnType<typeof vi.fn>).mockReturnValue({
      summary: { id: "s1", name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 2 },
      messages: [{ role: "user", content: "q", timestamp: 1 }, { role: "assistant", content: "a", timestamp: 2 }],
    });
    state.autoName = "X";
    await handler({ type: "branchAt", index: 99 }); // stale bubble
    expect(store.create).toHaveBeenCalledTimes(1); // only the original
    await handler({ type: "branchAt", index: -1 });
    expect(store.create).toHaveBeenCalledTimes(1);
    await handler({ type: "branchAt", index: "x" });
    expect(store.create).toHaveBeenCalledTimes(1);
  });

  it("truncateAt cuts the transcript from the reply downward and persists it", async () => {
    const { store, registry, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1 (active)
    const msgs = [
      { role: "user", content: "q1", timestamp: 1 },
      { role: "assistant", content: "a1", timestamp: 2 },
      { role: "user", content: "q2", timestamp: 3 },
      { role: "assistant", content: "a2", timestamp: 4 },
    ];
    const rt = registry.get("s1")!;
    rt.history.replace(msgs);

    await handler({ type: "truncateAt", index: 2 }); // cut the q2 prompt -> [q1, a1]

    const kept = [msgs[0], msgs[1]];
    expect(store.saveMessages).toHaveBeenCalledWith("s1", kept);
    expect(rt.history.all()).toEqual(kept);
    expect(rt.agent.getMessages()).toEqual(kept);
    // Asked for confirmation (danger) and re-rendered the cut conversation.
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "modal", kind: "alert", alertKind: "confirm", danger: true }),
    );
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "refresh", messages: kept });
  });

  it("truncateAt does nothing when the confirmation is cancelled", async () => {
    const { store, registry, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    const msgs = [
      { role: "user", content: "q", timestamp: 1 },
      { role: "assistant", content: "a", timestamp: 2 },
    ];
    const rt = registry.get("s1")!;
    rt.history.replace(msgs);
    state.noAutoAlert = true;
    try {
      const p = handler({ type: "truncateAt", index: 1 });
      const modal = view.webview.postMessage.mock.calls
        .map((c) => c[0] as any)
        .find((m) => m.type === "modal" && m.kind === "alert");
      await handler({ type: "modalResponse", id: modal.modalId, value: false });
      await p;
    } finally {
      state.noAutoAlert = false;
    }
    expect(store.saveMessages).not.toHaveBeenCalled();
    expect(rt.history.all()).toEqual(msgs);
  });

  it("truncateAt can cut the whole conversation down to empty (index 0)", async () => {
    const { store, registry, provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.history.replace([{ role: "user", content: "q", timestamp: 1 }, { role: "assistant", content: "a", timestamp: 2 }]);

    await handler({ type: "truncateAt", index: 0 });

    expect(store.saveMessages).toHaveBeenCalledWith("s1", []);
    expect(rt.history.all()).toEqual([]);
  });

  it("refuses to cut while the session is working", async () => {
    const { store, registry, provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.history.replace([{ role: "user", content: "q", timestamp: 1 }, { role: "assistant", content: "a", timestamp: 2 }]);
    (rt.agent as { streaming: boolean }).streaming = true;

    await handler({ type: "truncateAt", index: 1 });

    expect(store.saveMessages).not.toHaveBeenCalled();
  });

  it("truncateAt ignores out-of-range or invalid indexes", async () => {
    const { store, registry, provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.history.replace([{ role: "user", content: "q", timestamp: 1 }, { role: "assistant", content: "a", timestamp: 2 }]);

    await handler({ type: "truncateAt", index: 99 }); // stale bubble
    await handler({ type: "truncateAt", index: -1 });
    await handler({ type: "truncateAt", index: "x" });

    expect(store.saveMessages).not.toHaveBeenCalled();
  });

  it("refuses to branch with a name already in use", async () => {
    const { store, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1 named "New Session"
    (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "s1", name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 0 },
    ]);
    (store.load as ReturnType<typeof vi.fn>).mockReturnValue({
      summary: { id: "s1", name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 0 },
      messages: [],
    });
    state.autoName = "New Session"; // duplicates the source name
    await handler({ type: "branchSession", id: "s1" });
    expect(store.create).toHaveBeenCalledTimes(1); // only the original creation
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "modal", kind: "alert", alertKind: "error", message: expect.stringContaining("already exists") }),
    );
  });

  it("createNew refuses a name already used in this workspace", async () => {
    const { store, provider } = buildHarness();
    (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "x9", name: "New Session", createdAt: 1, updatedAt: 1, messageCount: 0 },
    ]);
    state.autoName = "New Session"; // collides with x9
    const { handler, view } = resolveWith(provider);
    await handler({ type: "newSession" });
    expect(store.create).not.toHaveBeenCalled();
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "modal", kind: "alert", alertKind: "error", message: expect.stringContaining("already exists") }),
    );
  });

  it("renameSession refuses a name already used by another session", async () => {
    const { store, provider } = buildHarness();
    await provider.createNew(); // s1
    await provider.createNew(); // s2
    (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "s1", name: "Refactor", createdAt: 1, updatedAt: 2, messageCount: 0 },
      { id: "s2", name: "Debug", createdAt: 1, updatedAt: 2, messageCount: 0 },
    ]);
    state.autoName = "Debug"; // s2's name
    const { handler, view } = resolveWith(provider);
    await handler({ type: "renameSession", id: "s1" });
    expect(store.rename).not.toHaveBeenCalled();
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "modal", kind: "alert", alertKind: "error", message: expect.stringContaining("already exists") }),
    );
  });

  it("usage events update the session context tokens and persist them", async () => {
    const { store, registry, provider } = buildHarness({ emitEvents: true });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    (rt.agent as any).emit({ type: "usage", usage: { input: 50, output: 4, total: 54 } });
    expect(rt.contextTokens).toBe(50);
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { contextTokens: 50 });
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

  it("setModel defaults thinking to medium on reasoning-capable providers", async () => {
    const { provider, modelSelector, store } = buildHarness({
      providerEntry: {
        name: "opencode-go",
        baseUrl: "https://x/v1",
        apiKey: "sk",
        thinkingMode: "effort",
        models: [{ id: "m1" }],
      },
    });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "m1", provider: "opencode-go" });
    // Medium is saved as the session default for the new model selection.
    expect(store.saveSettings).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ model: "m1", modelProvider: "opencode-go", thinkingLevel: "medium" }),
    );
    // The runtime overrides carry the default so requests send reasoning_effort.
    expect(modelSelector.set).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: "medium" }));
  });

  it("setModel keeps an explicit session thinking level (no default overwrite)", async () => {
    const { provider, modelSelector, store } = buildHarness({
      providerEntry: {
        name: "opencode-go",
        baseUrl: "https://x/v1",
        apiKey: "sk",
        thinkingMode: "effort",
        models: [{ id: "m1" }],
      },
    });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await provider.createNew(); // s2 (s1 now inactive? no: s2 active)
    // Set an explicit level on the active session first, then pick a model.
    await handler({ type: "setThinkingLevel", level: "high" });
    await handler({ type: "setModel", model: "m1", provider: "opencode-go" });
    expect(modelSelector.set).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: "high" }));
    expect(store.saveSettings).not.toHaveBeenCalledWith(
      "s2",
      expect.objectContaining({ model: "m1", thinkingLevel: "medium" }),
    );
  });

  it("setModel on a provider without reasoning leaves no thinking default", async () => {
    const { provider, modelSelector, store } = buildHarness({
      providerEntry: {
        name: "plain",
        baseUrl: "https://x/v1",
        apiKey: "sk",
        thinkingMode: "unspecified",
        models: [{ id: "m1" }],
      },
    });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "m1", provider: "plain" });
    expect(modelSelector.set).toHaveBeenCalledWith(
      expect.objectContaining({ thinkingMode: "unspecified", thinkingLevel: undefined }),
    );
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { model: "m1", modelProvider: "plain" });
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

  it("buildConfig fetches EVERY provider (declared models included) and shows only live lists", async () => {
    const fetchModels = vi.fn(async () => ["d1", "d2"]);
    const { provider } = buildHarness({
      // "opencode-go" declares a model in the config; "host-only" does not.
      // getProvider is mocked to the SAME entry for any name, so both must
      // be fetched (2 calls) and the stale declared list must NOT show.
      config: {
        ...CONFIG,
        providerModels: [{ provider: "opencode-go", model: "stale-declared" }],
        hostModelProviders: ["host-only"],
      },
      providerEntry: { name: "opencode-go", baseUrl: "https://declared/v1", apiKey: "k", models: [{ id: "stale-declared" }] },
      fetchModels,
    });
    const { handler, view } = resolveWith(provider);
    await handler({ type: "getConfig" });
    const configPosts = view.webview.postMessage.mock.calls
      .map((c) => c[0] as any)
      .filter((m) => m.type === "config");
    const cfg = configPosts[configPosts.length - 1].config;
    // The stale declared list is NOT shown: only the fetched live lists are.
    expect(cfg.providerModels).not.toContainEqual({ provider: "opencode-go", model: "stale-declared" });
    expect(cfg.providerModels).toContainEqual({ provider: "opencode-go", model: "d1" });
    // The DECLARED provider got fetched like any other (before the fix it was
    // never fetched: only hostModelProviders were).
    expect(fetchModels).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://declared/v1" }),
    );
  });

  it("buildConfig reports a red error for a provider without baseUrl", async () => {
    const { provider } = buildHarness({
      config: { ...CONFIG, hostModelProviders: ["no-base"] },
      providerEntry: undefined, // getProvider returns nothing
      fetchModels: vi.fn(async () => []),
    });
    const { handler, view } = resolveWith(provider);
    await handler({ type: "getConfig" });
    const configPosts = view.webview.postMessage.mock.calls
      .map((c) => c[0] as any)
      .filter((m) => m.type === "config");
    const cfg = configPosts[configPosts.length - 1].config;
    expect(cfg.hostModelErrors).toContainEqual({ provider: "no-base", error: "no baseUrl configured" });
  });

  it("getProvidersEditor posts the raw provider map from the config file", async () => {
    const { provider } = buildHarness({
      providers: {
        getProvider: vi.fn(),
        saveModelSelection: vi.fn(),
        readProvidersEditor: vi.fn(() => ({
          activeProvider: "llamacpp",
          providers: { llamacpp: { baseUrl: "http://localhost:8090/v1" } },
        })),
        saveProvidersEditor: vi.fn(() => true),
      } as unknown as ProviderCatalog,
    });
    const { handler, view } = resolveWith(provider);
    await handler({ type: "getProvidersEditor" });
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "providersEditor",
        data: expect.objectContaining({ activeProvider: "llamacpp" }),
      }),
    );
  });

  it("saveProviders persists the editor data and refreshes the config", async () => {
    const saveProvidersEditor = vi.fn(() => true);
    const { provider } = buildHarness({
      providers: {
        getProvider: vi.fn(),
        saveModelSelection: vi.fn(),
        readProvidersEditor: vi.fn(() => ({ providers: {} })),
        saveProvidersEditor,
      } as unknown as ProviderCatalog,
    });
    const { handler, view } = resolveWith(provider);
    await handler({ type: "saveProviders", data: { activeProvider: "x", providers: { x: { baseUrl: "http://x/v1" } } } });
    expect(saveProvidersEditor).toHaveBeenCalledWith({
      activeProvider: "x",
      providers: { x: { baseUrl: "http://x/v1" } },
    });
    expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "providersSaved", ok: true }));
  });

  it("saveProviders failure replies providersSaved ok:false", async () => {
    const { provider } = buildHarness({
      providers: {
        getProvider: vi.fn(),
        saveModelSelection: vi.fn(),
        readProvidersEditor: vi.fn(() => ({ providers: {} })),
        saveProvidersEditor: vi.fn(() => false),
      } as unknown as ProviderCatalog,
    });
    const { handler, view } = resolveWith(provider);
    await handler({ type: "saveProviders", data: { providers: {} } });
    expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "providersSaved", ok: false }));
  });

  it("testProvider fetches live models and posts the outcome", async () => {
    const fetchModels = vi.fn(async () => ["m1", "m2"]);
    const { provider } = buildHarness({ fetchModels });
    const { handler, view } = resolveWith(provider);
    await handler({ type: "testProvider", data: { baseUrl: "http://localhost:8090/v1", apiKey: "k" } });
    expect(fetchModels).toHaveBeenCalledWith({ baseUrl: "http://localhost:8090/v1", apiKey: "k" });
    expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "providersTested", ok: true, models: ["m1", "m2"] }));
  });

  it("testProvider failure posts the error", async () => {
    const { provider } = buildHarness({ fetchModels: vi.fn(async () => {
      throw new Error("HTTP 500");
    }) });
    const { handler, view } = resolveWith(provider);
    await handler({ type: "testProvider", data: { baseUrl: "http://x/v1" } });
    expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "providersTested", ok: false, error: "HTTP 500" }));
  });

  it("send routes to the active runtime agent", async () => {
    const { registry, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew();
    // New sessions start with no model: pick one before sending.
    await handler({ type: "setModel", model: "deepseek-v4-flash", provider: "opencode-go" });
    await handler({ type: "send", text: "hello" });
    const rt = registry.get("s1")!;
    expect(rt.agent.send).toHaveBeenCalledWith("hello", expect.any(Object));
    // The status posted when the stream starts must ALREADY carry the session
    // id in workingIds — otherwise the row never locks (regression guard for
    // the postStatus-after-send timing).
    const statusPosts = view.webview.postMessage.mock.calls.map((c) => c[0]);
    expect(statusPosts).toContainEqual(
      expect.objectContaining({ type: "status", workingIds: ["s1"] }),
    );
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

  it("abortSubAgent routes to the active agent with the sub-agent's tool-call id", async () => {
    const { registry, provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    await handler({ type: "abortSubAgent", toolCallId: "d1" });
    // Targets ONE sub-agent; the whole run is left alone.
    expect(rt.agent.abortSubAgent).toHaveBeenCalledWith("d1");
    expect(rt.agent.abort).not.toHaveBeenCalled();
  });

  it("abortSubAgent ignores a missing/non-string tool-call id", async () => {
    const { registry, provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    await handler({ type: "abortSubAgent" });
    await handler({ type: "abortSubAgent", toolCallId: 42 });
    expect(rt.agent.abortSubAgent).not.toHaveBeenCalled();
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
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { model: "gemma.gguf", modelProvider: "llamacpp" });
  });

  it("setModel carries the stable session id + the provider's declared session/static headers into the runtime config", async () => {
    const { provider, modelSelector } = buildHarness({
      providerEntry: {
        baseUrl: "https://opencode.ai/go/v1",
        apiKey: "go-key",
        maxTokens: 16384,
        sessionHeader: "x-opencode-session",
        extraHeaders: { "X-Origin": "harny" },
        models: [{ id: "deepseek-v4-pro" }],
      } as any,
    });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1 (active runtime with a session id)
    await handler({ type: "setModel", model: "deepseek-v4-pro", provider: "opencode-go" });
    expect(modelSelector.set).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: expect.any(String),
        sessionHeader: "x-opencode-session",
        extraHeaders: { "X-Origin": "harny" },
      }),
    );
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
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { contextWindow: 200000 });
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

describe("ChatViewProvider all-sessions manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("cannot open a session whose folder is missing (nothing runs, no runtime)", async () => {
    const { store, registry, provider } = buildHarness({ currentFolder: () => "/home/me/a" });
    (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "gone", name: "Gone", createdAt: 1, updatedAt: 2, messageCount: 1, folder: "/gone", folderMissing: true },
    ]);
    const { handler } = resolveWith(provider);
    await handler({ type: "openSession", id: "gone" });
    expect(registry.listOpenIds()).toHaveLength(0);
  });

  it("opens a session of the CURRENT folder in place (no window switching)", async () => {
    const { store, registry, provider } = buildHarness({ currentFolder: () => "/home/me/a" });
    (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "x", name: "Local", createdAt: 1, updatedAt: 2, messageCount: 0, folder: "/home/me/a", folderMissing: false },
    ]);
    const { handler, view } = resolveWith(provider);
    await handler({ type: "openSession", id: "x" });
    await new Promise((r) => setTimeout(r, 0)); // let the async open + refresh settle
    expect(registry.listOpenIds()).toContain("x");
    // Silent refresh of the manage form (if open).
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sessionsManager", currentFolder: "/home/me/a" }),
    );
  });

  it("getAllSessions replies with EVERY session plus the current folder", async () => {
    const { store, provider } = buildHarness({ currentFolder: () => "/home/me/a" });
    const all = [
      { id: "a", name: "A", createdAt: 1, updatedAt: 3, messageCount: 0, folder: "/home/me/a", folderMissing: false },
      { id: "b", name: "B", createdAt: 1, updatedAt: 2, messageCount: 0, folder: "/home/me/b", folderMissing: true },
    ];
    (store.list as ReturnType<typeof vi.fn>).mockReturnValue(all);
    const { handler, view } = resolveWith(provider);
    await handler({ type: "getAllSessions" });
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sessionsManager", sessions: all, currentFolder: "/home/me/a" }),
    );
  });

  it("changeSessionFolder picks a folder, persists it and refreshes the form", async () => {
    const { store, provider } = buildHarness({ currentFolder: () => "/home/me/a" });
    state.showOpenDialog.mockResolvedValue([{ fsPath: "/home/me/new" }]);
    const { handler, view } = resolveWith(provider);
    await handler({ type: "sessionsManagerChangeFolder", id: "x" });
    expect(store.saveSettings).toHaveBeenCalledWith("x", { folder: "/home/me/new" });
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sessionsManager", currentFolder: "/home/me/a" }),
    );
  });

  it("changeSessionFolder with a cancelled dialog changes nothing", async () => {
    const { store, provider } = buildHarness({ currentFolder: () => "/home/me/a" });
    state.showOpenDialog.mockResolvedValue(undefined); // user closed the picker
    const { handler, view } = resolveWith(provider);
    await handler({ type: "sessionsManagerChangeFolder", id: "x" });
    expect(store.saveSettings).not.toHaveBeenCalled();
    expect(view.webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "sessionsManager" }),
    );
  });

  it("the MAIN sessions list shows only the current folder's sessions", async () => {
    const { store, provider } = buildHarness({ currentFolder: () => "/home/me/a" });
    (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "a", name: "Local", createdAt: 1, updatedAt: 3, messageCount: 0, folder: "/home/me/a", folderMissing: false },
      { id: "b", name: "Foreign", createdAt: 1, updatedAt: 2, messageCount: 0, folder: "/home/me/b", folderMissing: false },
    ]);
    const { view } = resolveWith(provider);
    await new Promise((r) => setTimeout(r, 30));
    expect(view.webview.html).toContain('"name":"Local"');
    expect(view.webview.html).not.toContain('"name":"Foreign"');
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
    expect((store.saveSettings as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    // stale cache hits from the pre-compaction turn are reset (no >100% ratio)
    expect(rt.cachedTokens).toBe(0);
    // final bubble posted (the UI shows completion, no toast needed)
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "compactDone" });
  });

  it("auto-compacts right after a response when the reply crossed the threshold", async () => {
    const options = {
      compactor: new Compactor(compactorFactory(), () => CONFIG),
      compaction: DEFAULT_COMPACTION,
    };
    const { store, registry, provider } = buildHarness(options);
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "m", provider: "p" });
    const rt = registry.get("s1")!;
    rt.contextWindow = 200000;
    rt.contextTokens = 100000; // 50%: under the 80% threshold before the request
    rt.history.replace([
      { role: "user", content: "let's go", timestamp: 1 },
      { role: "assistant", content: "ok", timestamp: 2 },
      { role: "user", content: "then", timestamp: 3 },
      { role: "assistant", content: "done", timestamp: 4 },
    ]);
    // The in-flight turn pushes the fill above the threshold.
    (rt.agent as any).send = vi.fn(async () => {
      (rt.agent as any).streaming = true;
      rt.contextTokens = 170000; // 85% of 200000
    });

    await handler({ type: "send", text: "more" });

    // The response landed and the fill crossed the threshold -> the history
    // was compacted immediately after, WITHOUT the user asking for it.
    const conv = registry.get("s1")!.history.conversation();
    expect(conv[0].role).toBe("system");
    expect(String(conv[0].content)).toContain("## Goal");
    expect((store.saveSettings as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ contextTokens: expect.any(Number) }),
    );
    // The trigger posts the same UI sequence as the manual Compact button:
    // bubble in chat + blocking status while it runs, then note + release.
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "compactStart" });
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "status", active: true, message: "Compacting…" }),
    );
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "compactDone" });
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "status", active: false }),
    );
    // …and they arrive in the blocking order: bubble, status-IN, note, status-OUT.
    const seq = (view.webview.postMessage as ReturnType<typeof vi.fn>)
      .mock.calls.map((c: unknown[]) => (c[0] as { type: string }).type);
    const startAt = seq.indexOf("compactStart");
    const doneAt = seq.indexOf("compactDone");
    expect(seq[startAt + 1]).toBe("status");
    expect(seq[doneAt + 1]).toBe("status");
    expect(startAt).toBeLessThan(doneAt);
  });

  it("adopts the host-reported context window when a model is selected", async () => {
    const { store, registry, provider } = buildHarness({
      providerEntry: { name: "openrouter", baseUrl: "http://x/v1", models: [] },
      fetchModelInfos: async () => [
        { id: "openrouter/x", contextLength: 131072 },
        { id: "openrouter/plain" },
      ],
    });
    const { view, handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;

    await handler({ type: "setModel", model: "openrouter/x", provider: "openrouter" });
    expect(rt.contextWindow).toBe(131072);
    expect(store.saveSettings).toHaveBeenCalledWith("s1", expect.objectContaining({ contextWindow: 131072 }));
    // ...and the host PUSHES the adopted value so the UI control updates.
    await new Promise((r) => setTimeout(r, 0));
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "config", config: expect.objectContaining({ contextWindow: 131072 }) }),
    );

    // A model WITHOUT a reported window keeps the current one.
    await handler({ type: "setModel", model: "openrouter/plain", provider: "openrouter" });
    expect(rt.contextWindow).toBe(131072);
  });

  it("falls back to models.dev for the context window when the host does not report it", async () => {
    const { registry, provider } = buildHarness({
      providerEntry: { name: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1", models: [] },
      fetchModelInfos: async () => [{ id: "kimi-k3" }], // host reports NO context
      modelsDev: { getContext: vi.fn(async () => 1048576) },
    });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;

    await handler({ type: "setModel", model: "kimi-k3", provider: "opencode-go" });
    await new Promise((r) => setTimeout(r, 0));

    expect(rt.contextWindow).toBe(1048576);
  });

  it("setCompactionThreshold stores the session override (clamped) and persists it", async () => {
    const options = { compactor: new Compactor(compactorFactory(), () => CONFIG), compaction: DEFAULT_COMPACTION };
    const { store, registry, provider } = buildHarness(options);
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;

    await handler({ type: "setCompactionThreshold", value: 65 });
    expect(rt.compactionThresholdPercent).toBe(65);
    expect((store.saveSettings as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ compactionThresholdPercent: 65 }),
    );

    // Out-of-range values are clamped host-side to 1–100.
    await handler({ type: "setCompactionThreshold", value: 150 });
    expect(rt.compactionThresholdPercent).toBe(100);

    // Invalid values fall back to the default 80.
    await handler({ type: "setCompactionThreshold", value: "abc" });
    expect(rt.compactionThresholdPercent).toBe(80);
    expect((store.saveSettings as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ compactionThresholdPercent: 80 }),
    );
  });

  it("auto-compaction follows the session's custom threshold %", async () => {
    const options = {
      compactor: new Compactor(compactorFactory(), () => CONFIG),
      compaction: DEFAULT_COMPACTION,
    };
    const { registry, provider } = buildHarness(options);
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "m", provider: "p" });
    // The gear saved a custom 65% for this session.
    await handler({ type: "setCompactionThreshold", value: 65 });
    const rt = registry.get("s1")!;
    rt.contextWindow = 200000;
    rt.history.replace([
      { role: "user", content: "let's go", timestamp: 1 },
      { role: "assistant", content: "ok", timestamp: 2 },
      { role: "user", content: "then", timestamp: 3 },
      { role: "assistant", content: "done", timestamp: 4 },
    ]);

    // 62.5%: under the custom 65% (though over the default 60% floor) — no compact.
    rt.contextTokens = 125000;
    (rt.agent as any).send = vi.fn(async () => {
      (rt.agent as any).streaming = true;
      rt.contextTokens = 125000;
    });
    await handler({ type: "send", text: "more" });
    expect(registry.get("s1")!.history.conversation()[0].role).not.toBe("system");

    // 70%: over the custom 65% -> compacted (same button routine).
    (rt.agent as any).streaming = false; // the turn above finished (mock quirk)
    view.webview.postMessage.mockClear();
    (rt.agent as any).send = vi.fn(async () => {
      (rt.agent as any).streaming = true;
      rt.contextTokens = 140000;
    });
    await handler({ type: "send", text: "more" });
    expect(registry.get("s1")!.history.conversation()[0].role).toBe("system");
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "compactStart" });
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "compactDone" });
  });

  it("auto-compacts before the request when already over the threshold", async () => {
    const options = {
      compactor: new Compactor(compactorFactory(), () => CONFIG),
      compaction: DEFAULT_COMPACTION,
    };
    const { registry, provider } = buildHarness(options);
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "m", provider: "p" });
    const rt = registry.get("s1")!;
    rt.contextWindow = 200000;
    rt.contextTokens = 170000; // 85%: OVER before the request starts
    rt.history.replace([
      { role: "user", content: "let's go", timestamp: 1 },
      { role: "assistant", content: "ok", timestamp: 2 },
      { role: "user", content: "then", timestamp: 3 },
      { role: "assistant", content: "done", timestamp: 4 },
    ]);
    const send = (rt.agent as any).send;

    await handler({ type: "send", text: "more" });

    // The conversation was compacted BEFORE the in-flight turn was sent.
    const conv = registry.get("s1")!.history.conversation();
    expect(conv[0].role).toBe("system");
    expect(String(conv[0].content)).toContain("## Goal");
    expect(send).toHaveBeenCalled(); // the request still went out afterwards
    // Visible feedback identical to the manual button: bubble, blocking status
    // while running, then note + release.
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "compactStart" });
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "status", active: true, message: "Compacting…" }),
    );
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "compactDone" });
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "status", active: false }),
    );
  });

  it("best-effort: a failed auto-compaction does not abort the request or hang", async () => {
    const failingFactory = {
      create: vi.fn(() => ({
        protocol: "chat" as const,
        async *stream() {
          throw new Error("summarizer network error");
        },
      })),
    } as unknown as LLMProviderFactory;
    const options = { compactor: new Compactor(failingFactory, () => CONFIG), compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "m", provider: "p" });
    const rt = registry.get("s1")!;
    rt.contextWindow = 200000;
    rt.contextTokens = 170000; // over the threshold -> would compact BEFORE the request
    rt.history.replace([
      { role: "user", content: "let's go", timestamp: 1 },
      { role: "assistant", content: "ok", timestamp: 2 },
      { role: "user", content: "then", timestamp: 3 },
      { role: "assistant", content: "done", timestamp: 4 },
    ]);
    const send = vi.fn(async () => {
      (rt.agent as any).streaming = true;
    });
    (rt.agent as any).send = send;

    // Must resolve (no throw) and still dispatch the user's request.
    await handler({ type: "send", text: "more" });

    expect(send).toHaveBeenCalled();
  });

  it("mid-run auto-compaction compacts at a turn boundary without ending the working state", async () => {
    const options = { compactor: new Compactor(compactorFactory(), () => CONFIG), compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    const { view } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.contextWindow = 200000;
    rt.contextTokens = 170000; // over the threshold
    rt.history.replace([
      { role: "user", content: "let's go", timestamp: 1 },
      { role: "assistant", content: "ok", timestamp: 2 },
      { role: "user", content: "then", timestamp: 3 },
      { role: "assistant", content: "done", timestamp: 4 },
    ]);
    view.webview.postMessage.mockClear();

    await provider.maybeCompactDuringRun("s1");

    expect(registry.get("s1")!.history.conversation()[0].role).toBe("system");
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "compactStart" });
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "compactDone" });
    // The run is still going: NO status message may turn the working bar off.
    expect(view.webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "status", active: false }),
    );
  });

  it("mid-run auto-compaction is a no-op below the threshold", async () => {
    const options = { compactor: new Compactor(compactorFactory(), () => CONFIG), compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    const { view } = resolveWith(provider);
    await provider.createNew(); // s1
    registry.get("s1")!.contextTokens = 1000; // 0.5%: way below
    view.webview.postMessage.mockClear();

    await provider.maybeCompactDuringRun("s1");

    expect(view.webview.postMessage).not.toHaveBeenCalledWith({ type: "compactStart" });
  });

  it("auto-compacts with the SAME manual plan as the Compact button (never a silent no-op)", async () => {
    // A small talk that crosses the threshold must still be REALLY compacted:
    // the button's planManualCompaction always compacts a fraction, so the
    // auto trigger (same routine) never produces an empty fake bubble.
    const options = {
      compactor: new Compactor(compactorFactory(), () => CONFIG),
      compaction: DEFAULT_COMPACTION,
    };
    const { store, registry, provider } = buildHarness(options);
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "m", provider: "p" });
    const rt = registry.get("s1")!;
    rt.contextWindow = 200000;
    rt.contextTokens = 170000; // 85%: over the 80% threshold, small talk
    rt.history.replace([
      { role: "user", content: "let's go", timestamp: 1 },
      { role: "assistant", content: "ok", timestamp: 2 },
      { role: "user", content: "then", timestamp: 3 },
      { role: "assistant", content: "done", timestamp: 4 },
    ]);

    await handler({ type: "send", text: "more" });

    const conv = registry.get("s1")!.history.conversation();
    expect(conv[0].role).toBe("system"); // REALLY compacted (manual plan)
    expect(String(conv[0].content)).toContain("## Goal");
    expect((store.saveSettings as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    // Exactly the button's visible flow: bubble -> block -> note -> release.
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "compactStart" });
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "compactDone" });
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "status", active: true, message: "Compacting…" }),
    );
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "status", active: false }),
    );
  });

  it("does NOT auto-compact after a response that stays under the threshold", async () => {
    const options = {
      compactor: new Compactor(compactorFactory(), () => CONFIG),
      compaction: DEFAULT_COMPACTION,
    };
    const { registry, provider } = buildHarness(options);
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "m", provider: "p" });
    const rt = registry.get("s1")!;
    rt.contextWindow = 200000;
    rt.contextTokens = 120000; // 60% stays under the 80% threshold
    rt.history.replace([
      { role: "user", content: "let's go", timestamp: 1 },
      { role: "assistant", content: "ok", timestamp: 2 },
      { role: "user", content: "then", timestamp: 3 },
      { role: "assistant", content: "done", timestamp: 4 },
    ]);
    (rt.agent as any).send = vi.fn(async () => {
      (rt.agent as any).streaming = true;
      rt.contextTokens = 155000; // 77.5%: still under
    });

    await handler({ type: "send", text: "more" });

    const conv = registry.get("s1")!.history.conversation();
    expect(conv[0].role).not.toBe("system"); // no summary injected
    expect(conv.some((m) => m.role === "system")).toBe(false);
    expect(conv.length).toBe(4); // transcript untouched
  });

  it("auto-compacts a background session silently (history only, no bubble on the active tab)", async () => {
    const options = {
      compactor: new Compactor(compactorFactory(), () => CONFIG),
      compaction: DEFAULT_COMPACTION,
    };
    const { registry, provider } = buildHarness(options);
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "m", provider: "p" });
    const rt = registry.get("s1")!;
    rt.contextWindow = 200000;
    rt.contextTokens = 120000; // under 80% BEFORE the request (no pre-request bubble)
    rt.history.replace([
      { role: "user", content: "let's go", timestamp: 1 },
      { role: "assistant", content: "ok", timestamp: 2 },
      { role: "user", content: "then", timestamp: 3 },
      { role: "assistant", content: "done", timestamp: 4 },
    ]);
    await provider.createNew(); // s2 (needed for the mid-turn switch)
    await handler({ type: "switchTab", id: "s1" }); // s1 active again
    view.webview.postMessage.mockClear();
    // While s1 streams, the user switches to s2; s1's reply crosses the threshold.
    (rt.agent as any).send = vi.fn(async () => {
      (rt.agent as any).streaming = true;
      rt.contextTokens = 170000; // over after the response
    });
    const sendPromise = handler({ type: "send", text: "bg" });
    await handler({ type: "switchTab", id: "s2" }); // s2 becomes the active tab
    await sendPromise;

    // The history IS compacted...
    expect(registry.get("s1")!.history.conversation()[0].role).toBe("system");
    // ...but the view got NO compaction feedback (it belongs to the active tab).
    expect(view.webview.postMessage).not.toHaveBeenCalledWith({ type: "compactStart" });
  });

  it("triggers even when the runtime has no explicit context window (default 128k applies)", async () => {
    const options = {
      compactor: new Compactor(compactorFactory(), () => CONFIG),
      compaction: DEFAULT_COMPACTION,
    };
    const { registry, provider } = buildHarness(options);
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "m", provider: "p" });
    const rt = registry.get("s1")!;
    expect(rt.contextWindow).toBeUndefined(); // brand-new session, as in practice
    rt.contextTokens = 110000; // > 80% of the default 128k window
    rt.history.replace([
      { role: "user", content: "let's go", timestamp: 1 },
      { role: "assistant", content: "ok", timestamp: 2 },
      { role: "user", content: "then", timestamp: 3 },
      { role: "assistant", content: "done", timestamp: 4 },
    ]);
    (rt.agent as any).send = vi.fn(async () => {
      (rt.agent as any).streaming = true;
      rt.contextTokens = 110000; // refreshes usage so the post-turn check sees it too
    });

    await handler({ type: "send", text: "more" });

    const conv = registry.get("s1")!.history.conversation();
    expect(conv[0].role).toBe("system"); // compacted despite no contextWindow
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "compactStart" });
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "compactDone" });
  });
});
