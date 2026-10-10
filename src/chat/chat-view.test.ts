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
import { Compactor, DEFAULT_COMPACTION, estimateContextTokens } from "../core/sessions/compactor";
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
  showSaveDialog: vi.fn(),
  // Built-in commands (e.g. vscode.openFolder) fired by the manage form.
  executeCommand: vi.fn(),
  // VS Code filesystem used by provider export/import.
  fsWriteFile: vi.fn(async () => {}),
  fsReadFile: vi.fn(async () => new Uint8Array()),
  // VS Code settings write + the vacuum threshold (undefined = default 20).
  updateConfiguration: vi.fn(async () => {}),
  dbVacuumThreshold: undefined as number | undefined,
}));

vi.mock("vscode", () => ({
  window: {
    showInputBox: state.showInputBox,
    showWarningMessage: state.showWarningMessage,
    showErrorMessage: state.showErrorMessage,
    showInformationMessage: state.showInformationMessage,
    showOpenDialog: state.showOpenDialog,
    showSaveDialog: state.showSaveDialog,
  },
  commands: { executeCommand: state.executeCommand },
  workspace: {
    getConfiguration: () => ({
      get: (key: string) =>
        key === "fontSize" ? 14 : key === "dbVacuumThresholdPercent" ? state.dbVacuumThreshold : undefined,
      update: state.updateConfiguration,
    }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    fs: { writeFile: state.fsWriteFile, readFile: state.fsReadFile },
  },
  Uri: { joinPath: () => ({}), file: (p: string) => ({ fsPath: p }) },
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
    dbVacuumStats: vi.fn(() => ({ pageCount: 100, freePages: 0, pageSize: 4096, bytesFree: 0, bytesTotal: 409600, ratio: 0 })),
    maintain: vi.fn(() => ({
      vacuumed: false,
      before: { pageCount: 100, freePages: 0, pageSize: 4096, bytesFree: 0, bytesTotal: 409600, ratio: 0 },
      after: { pageCount: 100, freePages: 0, pageSize: 4096, bytesFree: 0, bytesTotal: 409600, ratio: 0 },
      durationMs: 0,
    })),
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

/** Stub SkillRegistry for the manual-activation tests. */
function fakeSkillRegistry(skills: { name: string; description: string; body?: string }[] = []) {
  const loaded = skills.map((s) => ({
    name: s.name,
    description: s.description,
    dir: `/w/.agents/skills/${s.name}`,
    path: `/w/.agents/skills/${s.name}/SKILL.md`,
    body: s.body ?? `BODY ${s.name}`,
  }));
  return {
    list: () => loaded,
    get: (n: string) => loaded.find((s) => s.name === n),
    invalidate: () => {},
  } as any;
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
      steer: vi.fn(),
      cancelSteer: vi.fn(),
      setMode: vi.fn(),
      setDelegation: vi.fn(),
      setMaxParallelSubAgents: vi.fn(),
      setLoopGuardOptions: vi.fn(),
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
    readMcpServers: vi.fn(() => (opts.mcpServers as Record<string, unknown> | undefined) ?? {}),
    saveMcpServers: vi.fn(() => (opts.mcpSaveOk as boolean | undefined) ?? true),
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
    // buildHtml() is async: WAIT for the HTML instead of a fixed delay.
    await vi.waitFor(() => expect(view.webview.html).toContain('id="sessions"'), { timeout: 2000 });
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
        attachments: [{ name: "a.txt", path: "/tmp/a.txt", size: 2, isImage: false }],
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

  it("setMaxParallelSubAgents persists on the session, applies to the agent, and pushes the effective cap", async () => {
    const { store, provider, registry } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setMaxParallelSubAgents", value: 6 });
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { maxParallelSubAgents: 6 });
    expect(registry.get("s1")!.agent.setMaxParallelSubAgents).toHaveBeenCalledWith(6);
    const configPosts = view.webview.postMessage.mock.calls
      .map((c) => c[0] as any)
      .filter((m) => m.type === "config");
    expect(configPosts[configPosts.length - 1].config.maxParallelSubAgents).toBe(6);

    // Off = 0 (explicitly no cap), still persisted as a number.
    await handler({ type: "setMaxParallelSubAgents", value: 0 });
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { maxParallelSubAgents: 0 });
    await vi.waitFor(() => {
      const posts = view.webview.postMessage.mock.calls
        .map((c) => c[0] as any)
        .filter((m) => m.type === "config");
      expect(posts[posts.length - 1].config.maxParallelSubAgents).toBe(0);
    });
  });

  it("setLoopGuard persists the knobs, applies them to the agent, and undefined clears", async () => {
    const { store, provider, registry } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setLoopGuard", value: "high" });
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { loopGuard: "high" });
    expect(registry.get("s1")!.agent.setLoopGuardOptions).toHaveBeenCalled();
    const configPosts = view.webview.postMessage.mock.calls
      .map((c) => c[0] as any)
      .filter((m) => m.type === "config");
    expect(configPosts[configPosts.length - 1].config.loopGuard).toBe("high");

    await handler({ type: "setLoopGuard", value: undefined });
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { loopGuard: undefined });
  });

  it("setLoopGuardResponse persists the opt-in flag and applies it to the agent", async () => {
    const { store, provider, registry } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setLoopGuardResponse", value: true });
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { loopGuardResponse: true });
    expect(registry.get("s1")!.agent.setLoopGuardOptions).toHaveBeenCalled();
    await vi.waitFor(() => {
      const posts = view.webview.postMessage.mock.calls
        .map((c) => c[0] as any)
        .filter((m) => m.type === "config");
      expect(posts[posts.length - 1].config.loopGuardResponse).toBe(true);
    });
  });

  it("buildConfig pushes the installed skills catalog", async () => {
    const { provider } = buildHarness({ skills: fakeSkillRegistry([{ name: "pdf", description: "PDFs" }]) });
    const { handler, view } = resolveWith(provider);
    await provider.createNew();
    await handler({ type: "getConfig" });
    const posts = view.webview.postMessage.mock.calls.map((c) => c[0] as any).filter((m) => m.type === "config");
    expect(posts[posts.length - 1].config.skills).toEqual([{ name: "pdf", description: "PDFs" }]);
  });

  it("getSkills replies with the installed skills catalog (no network)", async () => {
    const { provider } = buildHarness({ skills: fakeSkillRegistry([{ name: "pdf", description: "PDFs" }]) });
    const { handler, view } = resolveWith(provider);
    await handler({ type: "getSkills" });
    const msg = view.webview.postMessage.mock.calls.map((c) => c[0] as any).find((m) => m.type === "skills");
    expect(msg.skills).toEqual([{ name: "pdf", description: "PDFs" }]);
  });

  it("getMcpServers replies with the configured MCP servers + statuses", async () => {
    const { provider } = buildHarness({ mcpServers: { test: { command: "node" } } });
    const { handler, view } = resolveWith(provider);
    await handler({ type: "getMcpServers" });
    const msg = view.webview.postMessage.mock.calls.map((c) => c[0] as any).find((m) => m.type === "mcpServers");
    expect(msg.data.servers).toEqual({ test: { command: "node" } });
    expect(msg.data.statuses).toEqual([]);
  });

  it("saveMcpServers persists and replies mcpSaved (ok / failure)", async () => {
    const ok = buildHarness({ mcpSaveOk: true });
    const a = resolveWith(ok.provider);
    await a.handler({ type: "saveMcpServers", servers: { test: { command: "node" } } });
    expect(a.view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "mcpSaved", ok: true }));

    const bad = buildHarness({ mcpSaveOk: false });
    const b = resolveWith(bad.provider);
    await b.handler({ type: "saveMcpServers", servers: {} });
    expect(b.view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "mcpSaved", ok: false }));
  });

  it("toggleMcpServer persists the enabled flag and reconnects", async () => {
    const saveMcpServers = vi.fn(() => true);
    const { provider } = buildHarness({
      providers: {
        getProvider: vi.fn(),
        saveModelSelection: vi.fn(),
        readMcpServers: vi.fn(() => ({ test: { command: "node" } })),
        saveMcpServers,
      } as unknown as ProviderCatalog,
    });
    const { handler } = resolveWith(provider);
    await handler({ type: "toggleMcpServer", name: "test", enabled: false });
    expect(saveMcpServers).toHaveBeenCalledWith({ test: { command: "node", enabled: false } });
  });

  it("testMcpServer rejects a server with neither command nor url", async () => {
    const { provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await handler({ type: "testMcpServer", server: {} });
    expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "mcpTested", ok: false }));
  });

  it("/skill <name> injects the skill instructions and keeps the command as display text", async () => {
    const { provider, registry } = buildHarness({
      skills: fakeSkillRegistry([{ name: "pdf", description: "PDFs", body: "USE PDFTOTEXT" }]),
    });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "gpt-4o", provider: undefined });

    await handler({ type: "send", text: "/skill pdf extract the table" });

    const agent = registry.get("s1")!.agent as any;
    const [text, opts] = agent.send.mock.calls[0];
    expect(text).toContain("USE PDFTOTEXT");
    expect(text).toContain("extract the table");
    expect(opts.displayText).toBe("/skill pdf extract the table");
  });

  it("/skills lists the installed skills as an assistant bubble", async () => {
    const { provider, registry } = buildHarness({ skills: fakeSkillRegistry([{ name: "pdf", description: "PDFs" }]) });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "gpt-4o", provider: undefined });

    await handler({ type: "send", text: "/skills" });

    const msgs = registry.get("s1")!.agent.getMessages();
    expect(msgs.some((m: any) => m.role === "assistant" && /Skills/.test(m.content) && m.content.includes("pdf"))).toBe(true);
  });

  it("/skill with an unknown name answers with the installed list (no agent run)", async () => {
    const { provider, registry } = buildHarness({ skills: fakeSkillRegistry([{ name: "pdf", description: "PDFs" }]) });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "gpt-4o", provider: undefined });

    await handler({ type: "send", text: "/skill nope" });

    const msgs = registry.get("s1")!.agent.getMessages();
    expect(msgs.some((m: any) => m.role === "assistant" && /Unknown skill/.test(m.content))).toBe(true);
    expect((registry.get("s1")!.agent as any).send).not.toHaveBeenCalled();
  });

  it("send re-asserts the per-session cap + Loop Guard on the agent", async () => {
    const { provider, registry } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "gpt-4o", provider: undefined });
    await handler({ type: "setMaxParallelSubAgents", value: 3 });
    await handler({ type: "setLoopGuard", value: "low" });
    await handler({ type: "setLoopGuardResponse", value: true });
    const agent = registry.get("s1")!.agent;
    (agent.setMaxParallelSubAgents as ReturnType<typeof vi.fn>).mockClear();
    (agent.setLoopGuardOptions as ReturnType<typeof vi.fn>).mockClear();

    await handler({ type: "send", text: "hi" });

    expect(agent.setMaxParallelSubAgents).toHaveBeenCalledWith(3);
    // The response guard flag is folded into the resolved options at send time.
    expect(agent.setLoopGuardOptions).toHaveBeenCalledWith(
      expect.objectContaining({ guardResponse: true, reasoningThreshold: 0.65 }),
    );
  });

  it("Loop Guard field overrides apply live and are SAVED on the session", async () => {
    const { store, provider, registry } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "gpt-4o", provider: undefined });
    await handler({ type: "setLoopGuard", value: "low" });
    const agent = registry.get("s1")!.agent;
    (agent.setLoopGuardOptions as ReturnType<typeof vi.fn>).mockClear();
    (store.saveSettings as ReturnType<typeof vi.fn>).mockClear();

    // The overrides are clamped to the editable ranges and applied live.
    await handler({ type: "setLoopGuardOverrides", overrides: { maxNudges: 5, reasoningThreshold: 999 } });
    expect(agent.setLoopGuardOptions).toHaveBeenCalledWith(
      expect.objectContaining({ maxNudges: 5, reasoningThreshold: 1, crossTurnSimilarity: 0.92 }),
    );
    // ...and PERSISTED on the session (per-session settings).
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { loopGuardParams: { maxNudges: 5, reasoningThreshold: 1 } });

    // They survive a turn: send re-asserts the SAME overrides.
    (agent.setLoopGuardOptions as ReturnType<typeof vi.fn>).mockClear();
    await handler({ type: "send", text: "hi" });
    expect(agent.setLoopGuardOptions).toHaveBeenCalledWith(expect.objectContaining({ maxNudges: 5 }));

    // Picking a sensitivity level DROPS them (the preset is the new baseline).
    (agent.setLoopGuardOptions as ReturnType<typeof vi.fn>).mockClear();
    await handler({ type: "setLoopGuard", value: "high" });
    expect(agent.setLoopGuardOptions).toHaveBeenCalledWith(expect.objectContaining({ maxNudges: 3 }));
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
      { id: "s1", name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 2, model: "gpt-4o", outputTokens: 16384, maxParallelSubAgents: 6, loopGuard: "high", loopGuardResponse: true },
    ]);
    (store.load as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === "s1"
        ? {
            summary: { id: "s1", name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 2, model: "gpt-4o", outputTokens: 16384, maxParallelSubAgents: 6, loopGuard: "high", loopGuardResponse: true },
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
    // Every per-session setting is copied, including the Control-card ones.
    expect(store.saveSettings).toHaveBeenCalledWith("s2", {
      model: "gpt-4o",
      outputTokens: 16384,
      maxParallelSubAgents: 6,
      loopGuard: "high",
      loopGuardResponse: true,
    });
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
    expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "refresh", messages: kept }));
  });

  it("truncateAt recomputes AND persists the context tokens from the KEPT messages", async () => {
    const { store, registry, provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    const kept = [
      { role: "user", content: "q1", timestamp: 1 },
      { role: "assistant", content: "a1", timestamp: 2 },
    ];
    rt.history.replace([...kept, { role: "user", content: "q2", timestamp: 3 }]);
    rt.contextTokens = 99999; // stale provider count from before the cut
    store.saveSettings("s1", { contextTokens: 99999 });
    (store.saveSettings as any).mockClear();

    await handler({ type: "truncateAt", index: 2 }); // keep [q1, a1]

    // Subtracting the removed interaction: the fill is the KEPT sum, not 0.
    const expected = estimateContextTokens(kept as never);
    expect(expected).toBeLessThan(99999);
    expect(rt.contextTokens).toBe(expected);
    // PERSISTED: a reload (tab switch / panel reload / restart) must NOT restore
    // the pre-cut count (saveMessages carries the old one over).
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { contextTokens: expected });
  });

  it("truncateAt to EMPTY leaves 0 context tokens", async () => {
    const { store, registry, provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.history.replace([
      { role: "user", content: "q1", timestamp: 1 },
      { role: "assistant", content: "a1", timestamp: 2 },
    ]);
    rt.contextTokens = 99999;

    await handler({ type: "truncateAt", index: 0 });

    expect(rt.contextTokens).toBe(0);
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { contextTokens: 0 });
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

  it("exportProviders writes the config to the chosen file", async () => {
    const exportProviders = vi.fn(() => ({ providers: { a: { baseUrl: "http://a/v1" } }, provider: "a" }));
    const { provider } = buildHarness({
      providers: { getProvider: vi.fn(), saveModelSelection: vi.fn(), exportProviders } as unknown as ProviderCatalog,
    });
    const { handler, view } = resolveWith(provider);
    state.showSaveDialog.mockResolvedValue({ fsPath: "/tmp/out.json" });
    state.fsWriteFile.mockClear();
    await handler({ type: "exportProviders" });
    expect(exportProviders).toHaveBeenCalled();
    expect(state.fsWriteFile).toHaveBeenCalled();
    expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "providersExported", ok: true }));
  });

  it("exportProviders cancelled writes nothing", async () => {
    const exportProviders = vi.fn(() => ({ providers: { a: { baseUrl: "http://a/v1" } } }));
    const { provider } = buildHarness({
      providers: { getProvider: vi.fn(), saveModelSelection: vi.fn(), exportProviders } as unknown as ProviderCatalog,
    });
    const { handler } = resolveWith(provider);
    state.showSaveDialog.mockResolvedValue(undefined);
    state.fsWriteFile.mockClear();
    await handler({ type: "exportProviders" });
    expect(state.fsWriteFile).not.toHaveBeenCalled();
  });

  it("importProviders reads the file and MERGES it into the config", async () => {
    const importProviders = vi.fn(() => true);
    const readProvidersEditor = vi.fn(() => ({ providers: { a: { baseUrl: "http://a/v1" } } }));
    const { provider } = buildHarness({
      providers: { getProvider: vi.fn(), saveModelSelection: vi.fn(), importProviders, readProvidersEditor } as unknown as ProviderCatalog,
    });
    const { handler, view } = resolveWith(provider);
    state.showOpenDialog.mockResolvedValue([{ fsPath: "/tmp/in.json" }]);
    state.fsReadFile.mockResolvedValue(new TextEncoder().encode('{"providers":{"a":{"baseUrl":"http://a/v1"}}}'));
    await handler({ type: "importProviders" });
    expect(importProviders).toHaveBeenCalledWith(expect.anything(), "merge");
    expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "providersImported", ok: true }));
    expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "providersEditor" }));
  });

  it("importProviders reports an invalid file", async () => {
    const importProviders = vi.fn(() => false);
    const { provider } = buildHarness({
      providers: {
        getProvider: vi.fn(),
        saveModelSelection: vi.fn(),
        importProviders,
        readProvidersEditor: vi.fn(() => ({ providers: {} })),
      } as unknown as ProviderCatalog,
    });
    const { handler, view } = resolveWith(provider);
    state.showOpenDialog.mockResolvedValue([{ fsPath: "/tmp/in.json" }]);
    state.fsReadFile.mockResolvedValue(new TextEncoder().encode('{"nope":true}'));
    await handler({ type: "importProviders" });
    expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "providersImported", ok: false }));
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
    // The async open + refresh settle on their own: WAIT for the effect.
    await vi.waitFor(() =>
      expect(view.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "sessionsManager", currentFolder: "/home/me/a" }),
      ),
    );
    expect(registry.listOpenIds()).toContain("x");
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

  it("searchSessions replies with the FTS matches (and none without a search hook)", async () => {
    const searchSessions = vi.fn((q: string) => [{ sessionId: "a", snippet: `in [${q}]` }]);
    const { provider } = buildHarness({ currentFolder: () => "/home/me/a", searchSessions });
    const { handler, view } = resolveWith(provider);

    await handler({ type: "searchSessions", query: "rome", scope: "main" });

    expect(searchSessions).toHaveBeenCalledWith("rome");
    // The scope (main list vs modal) is echoed back for the webview to route.
    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: "sessionsSearchResult",
      query: "rome",
      scope: "main",
      matches: [{ sessionId: "a", snippet: "in [rome]" }],
    });

    // No search hook wired (e.g. a non-SQLite build): an empty result, no throw.
    const plain = buildHarness();
    const { handler: h2, view: v2 } = resolveWith(plain.provider);
    await h2({ type: "searchSessions", query: "x" });
    expect(v2.webview.postMessage).toHaveBeenCalledWith({
      type: "sessionsSearchResult",
      query: "x",
      scope: "modal",
      matches: [],
    });
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

  it("changeSessionFolder defaults the picker to the session's folder when it still exists", async () => {
    const { store, provider } = buildHarness({ currentFolder: () => "/home/me/a" });
    (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "x", name: "X", createdAt: 1, updatedAt: 2, messageCount: 0, folder: "/home/me/old", folderMissing: false },
    ]);
    state.showOpenDialog.mockResolvedValue(undefined);
    const { handler } = resolveWith(provider);
    await handler({ type: "sessionsManagerChangeFolder", id: "x" });
    expect(state.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultUri: { fsPath: "/home/me/old" } }),
    );
  });

  it("changeSessionFolder warns then omits the default when the session's folder is gone", async () => {
    const { store, provider } = buildHarness({ currentFolder: () => "/home/me/a" });
    (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "x", name: "X", createdAt: 1, updatedAt: 2, messageCount: 0, folder: "/home/me/gone", folderMissing: true },
    ]);
    state.showOpenDialog.mockResolvedValue(undefined);
    const { view, handler } = resolveWith(provider);
    await handler({ type: "sessionsManagerChangeFolder", id: "x" });
    // Warned first (in-panel alert naming the gone folder)…
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "alert", message: expect.stringContaining("/home/me/gone") }),
    );
    // …then opened the picker without a default location.
    const arg = state.showOpenDialog.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty("defaultUri");
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

  it("sessionsManagerOpenFolder opens the session's folder in VS Code (no picker)", async () => {
    const { store, provider } = buildHarness({ currentFolder: () => "/home/me/a" });
    (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "x", name: "X", createdAt: 1, updatedAt: 2, messageCount: 0, folder: "/home/me/b", folderMissing: false },
    ]);
    const { handler } = resolveWith(provider);
    await handler({ type: "sessionsManagerOpenFolder", id: "x" });
    expect(state.executeCommand).toHaveBeenCalledWith("vscode.openFolder", { fsPath: "/home/me/b" }, false);
    expect(state.showOpenDialog).not.toHaveBeenCalled();
  });

  it("sessionsManagerOpenFolder forwards Windows and POSIX paths verbatim", async () => {
    const { store, provider } = buildHarness({ currentFolder: () => "C:\\Users\\Me\\A" });
    (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "w", name: "W", createdAt: 1, updatedAt: 2, messageCount: 0, folder: "C:\\Users\\Me\\B", folderMissing: false },
      { id: "p", name: "P", createdAt: 1, updatedAt: 1, messageCount: 0, folder: "/home/me/b", folderMissing: false },
    ]);
    const { handler } = resolveWith(provider);
    await handler({ type: "sessionsManagerOpenFolder", id: "w" });
    expect(state.executeCommand).toHaveBeenLastCalledWith("vscode.openFolder", { fsPath: "C:\\Users\\Me\\B" }, false);
    await handler({ type: "sessionsManagerOpenFolder", id: "p" });
    expect(state.executeCommand).toHaveBeenLastCalledWith("vscode.openFolder", { fsPath: "/home/me/b" }, false);
    expect(state.showOpenDialog).not.toHaveBeenCalled();
  });

  it("sessionsManagerOpenFolder falls back to the picker when the folder is gone", async () => {
    const { store, provider } = buildHarness({ currentFolder: () => "/home/me/a" });
    (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "x", name: "X", createdAt: 1, updatedAt: 2, messageCount: 0, folder: "/home/me/gone", folderMissing: true },
    ]);
    state.showOpenDialog.mockResolvedValue([{ fsPath: "/home/me/new" }]);
    const { handler } = resolveWith(provider);
    await handler({ type: "sessionsManagerOpenFolder", id: "x" });
    expect(state.executeCommand).not.toHaveBeenCalled();
    expect(store.saveSettings).toHaveBeenCalledWith("x", { folder: "/home/me/new" });
  });

  it("the MAIN sessions list shows only the current folder's sessions", async () => {
    const { store, provider } = buildHarness({ currentFolder: () => "/home/me/a" });
    (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "a", name: "Local", createdAt: 1, updatedAt: 3, messageCount: 0, folder: "/home/me/a", folderMissing: false },
      { id: "b", name: "Foreign", createdAt: 1, updatedAt: 2, messageCount: 0, folder: "/home/me/b", folderMissing: false },
    ]);
    const { view } = resolveWith(provider);
    await vi.waitFor(() => expect(view.webview.html).toContain('"name":"Local"'), { timeout: 2000 });
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
    expect(conv[0].role).toBe("user"); // the summary was injected
    expect(String(conv[1].content)).toContain("## Goal");
    expect((store.saveSettings as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    // stale cache hits from the pre-compaction turn are reset (no >100% ratio)
    expect(rt.cachedTokens).toBe(0);
    // final bubble posted (the UI shows completion, no toast needed)
    expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "refresh" }));
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
    expect(conv[0].role).toBe("user");
    expect(String(conv[1].content)).toContain("## Goal");
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
    expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "refresh" }));
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "status", active: false }),
    );
    // …and they arrive in the blocking order: bubble, status-IN, note, status-OUT.
    const seq = (view.webview.postMessage as ReturnType<typeof vi.fn>)
      .mock.calls.map((c: unknown[]) => (c[0] as { type: string }).type);
    const startAt = seq.indexOf("compactStart");
    const doneAt = seq.lastIndexOf("refresh");
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
    await vi.waitFor(() =>
      expect(view.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "config", config: expect.objectContaining({ contextWindow: 131072 }) }),
      ),
    );

    // A model WITHOUT a reported window keeps the current one.
    await handler({ type: "setModel", model: "openrouter/plain", provider: "openrouter" });
    expect(rt.contextWindow).toBe(131072);
  });

  it("falls back to models.dev for the context window when the host does not report it", async () => {
    const { registry, provider } = buildHarness({
      providerEntry: { name: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1", models: [] },
      fetchModelInfos: async () => [{ id: "kimi-k3" }], // host reports NO context
      modelsDev: { getLimits: vi.fn(async () => ({ context: 1048576 })) },
    });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;

    await handler({ type: "setModel", model: "kimi-k3", provider: "opencode-go" });
    await vi.waitFor(() => expect(rt.contextWindow).toBe(1048576));
  });

  it("alerts in-panel when the context window is unknown everywhere (host + models.dev)", async () => {
    const { provider } = buildHarness({
      providerEntry: { name: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1", models: [] },
      fetchModelInfos: async () => [{ id: "unknown-model" }], // host reports NO context
      modelsDev: { getLimits: vi.fn(async () => ({})) }, // catalog does not know it
    });
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    view.webview.postMessage.mockClear();

    await handler({ type: "setModel", model: "unknown-model", provider: "opencode-go" });

    await vi.waitFor(() =>
      expect(view.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "modal",
          kind: "alert",
          title: "Model limits unknown",
          message: expect.stringContaining("unknown-model"),
        }),
      ),
    );

    // Re-selecting the SAME unknown model must NOT alert again (once per model).
    const isContextAlert = (m: unknown): boolean =>
      !!m && typeof m === "object" && (m as { title?: string }).title === "Model limits unknown";
    view.webview.postMessage.mockClear();
    await handler({ type: "setModel", model: "unknown-model", provider: "opencode-go" });
    await new Promise((r) => setTimeout(r, 0));
    expect(view.webview.postMessage.mock.calls.some((c: unknown[]) => isContextAlert(c[0]))).toBe(false);
  });

  it("enriches the model LIST with the models.dev context window (host reports none)", async () => {
    const getLimits = vi.fn(async () => ({ context: 1048576 }));
    const { provider } = buildHarness({
      config: { ...CONFIG, hostModelProviders: ["opencode-go"] },
      providerEntry: { name: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1", models: [] },
      fetchModelInfos: async () => [{ id: "kimi-k3" }], // host reports NO context
      modelsDev: { getLimits },
    });
    const { view } = resolveWith(provider);

    // Background enrichment resolves it and pushes an updated config; the list
    // entry then carries the contextLength (so it shows in the model modal).
    await vi.waitFor(() => {
      const configs = view.webview.postMessage.mock.calls
        .map((c: unknown[]) => c[0] as { type?: string; config?: { providerModels?: { model: string; contextLength?: number }[] } })
        .filter((m) => m?.type === "config");
      const models = configs.flatMap((c) => c.config?.providerModels ?? []);
      expect(models.some((m) => m.model === "kimi-k3" && m.contextLength === 1048576)).toBe(true);
    });
    expect(getLimits).toHaveBeenCalled();
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
    expect(registry.get("s1")!.history.conversation()[0].role).toBe("user");
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "compactStart" });
    expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "refresh" }));
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
    expect(conv[0].role).toBe("user");
    expect(String(conv[1].content)).toContain("## Goal");
    expect(send).toHaveBeenCalled(); // the request still went out afterwards
    // Visible feedback identical to the manual button: bubble, blocking status
    // while running, then note + release.
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "compactStart" });
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "status", active: true, message: "Compacting…" }),
    );
    expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "refresh" }));
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

    expect(registry.get("s1")!.history.conversation()[0].role).toBe("user");
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "compactStart" });
    // Mid-run: the transcript is NOT re-rendered (the run is still streaming),
    // so the compacted span is shown as a quiet block, not a refresh.
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
    expect(conv[0].role).toBe("user"); // REALLY compacted (manual plan)
    expect(String(conv[1].content)).toContain("## Goal");
    expect((store.saveSettings as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    // Exactly the button's visible flow: bubble -> block -> note -> release.
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "compactStart" });
    expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "refresh" }));
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
    expect(registry.get("s1")!.history.conversation()[0].role).toBe("user");
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
    expect(conv[0].role).toBe("user"); // compacted despite no contextWindow
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "compactStart" });
    expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "refresh" }));
  });
});

describe("ChatViewProvider soft steering + queue", () => {
  async function setupStreaming(opts: Record<string, unknown> = {}) {
    const harness = buildHarness({ ...opts, emitEvents: true });
    const { handler, view } = resolveWith(harness.provider);
    await harness.provider.createNew(); // s1
    await handler({ type: "setModel", model: "m", provider: "p" });
    const rt = harness.registry.get("s1")!;
    (rt.agent as any).streaming = true; // the session is working
    // The pending state now lives in the extracted PendingInputQueue.
    const queue = (harness.provider as unknown as { pendingQueue: { items(id: string): any[] } }).pendingQueue;
    return { ...harness, handler, view, rt, agent: rt.agent as any, pending: () => queue.items(rt.sessionId) };
  }

  it("queues a message typed while working (no send, pending pushed)", async () => {
    const { handler, view, agent, pending } = await setupStreaming();
    agent.send.mockClear();
    view.webview.postMessage.mockClear();

    await handler({ type: "send", mode: "queue", id: "q1", text: "later" });

    expect(agent.send).not.toHaveBeenCalled();
    expect(pending().map((p) => p.id)).toEqual(["q1"]);
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "pending",
        items: [expect.objectContaining({ id: "q1", mode: "queue", text: "later" })],
      }),
    );
  });

  it("steers a message typed while working (agent.steer, not a new send)", async () => {
    const { handler, agent, pending } = await setupStreaming();
    agent.send.mockClear();

    await handler({ type: "send", mode: "steer", id: "s1x", text: "actually Rome" });
    // applySteer is async: WAIT for it to hand the draft to the agent.
    await vi.waitFor(() =>
      expect(agent.steer).toHaveBeenCalledWith("s1x", "actually Rome", expect.objectContaining({})),
    );

    expect(agent.send).not.toHaveBeenCalled();
    expect(pending().map((p) => p.id)).toEqual(["s1x"]);
  });

  it("ignores the mode when idle: a normal send runs immediately", async () => {
    const { registry, provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew();
    await handler({ type: "setModel", model: "m", provider: "p" });
    const rt = registry.get("s1")!;
    const agent = rt.agent as any;
    agent.send.mockClear();

    await handler({ type: "send", mode: "steer", id: "x", text: "hi" });

    expect(agent.send).toHaveBeenCalled();
    expect(
      (provider as unknown as { pendingQueue: { items(id: string): unknown[] } }).pendingQueue.items("s1"),
    ).toEqual([]);
    expect(agent.steer).not.toHaveBeenCalled();
  });

  it("cancels a queued message without touching the agent", async () => {
    const { handler, agent, view, pending } = await setupStreaming();
    await handler({ type: "send", mode: "queue", id: "q1", text: "later" });
    view.webview.postMessage.mockClear();

    await handler({ type: "cancelPending", id: "q1" });

    expect(pending()).toEqual([]);
    expect(agent.cancelSteer).not.toHaveBeenCalled();
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "pending", items: [] });
  });

  it("cancels a queued steer through the agent too", async () => {
    const { handler, agent, pending } = await setupStreaming();
    await handler({ type: "send", mode: "steer", id: "s1x", text: "hmm" });
    await vi.waitFor(() => expect(agent.steer).toHaveBeenCalled());

    await handler({ type: "cancelPending", id: "s1x" });

    expect(pending()).toEqual([]);
    expect(agent.cancelSteer).toHaveBeenCalledWith("s1x");
  });

  it("a steer with attachments builds the context and forwards it", async () => {
    const attachments = {
      pick: vi.fn(async () => []),
      buildContext: vi.fn(async () => ({ text: 'Attached file "a.txt":\n```\nhi\n```', images: [] })),
    } as unknown as AttachmentService;
    const { handler, agent } = await setupStreaming({ attachments });

    await handler({
      type: "send",
      mode: "steer",
      id: "s1x",
      text: "use THIS instead",
      attachments: [{ name: "a.txt", path: "/tmp/a.txt", size: 2, isImage: false }],
    });
    await vi.waitFor(() =>
      expect(agent.steer).toHaveBeenCalledWith(
        "s1x",
        expect.stringContaining("Attached file"),
        expect.objectContaining({
          displayText: "use THIS instead",
          attachments: [expect.objectContaining({ name: "a.txt" })],
        }),
      ),
    );
  });

  it("does NOT deliver a steer whose run ended while the context was building", async () => {
    const attachments = {
      pick: vi.fn(async () => []),
      buildContext: vi.fn(async () => {
        rt.agent.streaming = false; // the run ended mid-build
        return { text: "ctx", images: [] };
      }),
    } as unknown as AttachmentService;
    const { handler, rt, agent, pending } = await setupStreaming({ attachments });

    await handler({
      type: "send",
      mode: "steer",
      id: "s1x",
      text: "too late",
      attachments: [{ name: "a.txt", path: "/tmp/a.txt", size: 2, isImage: false }],
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(agent.steer).not.toHaveBeenCalled();
    // It stays pending, so the drain can still run it as a normal send.
    expect(pending().map((p) => p.id)).toEqual(["s1x"]);
  });

  it("removes a pending steer when the agent reports it applied", async () => {
    const { handler, agent, view, pending } = await setupStreaming();
    await handler({ type: "send", mode: "steer", id: "s1x", text: "x" });
    await vi.waitFor(() => expect(agent.steer).toHaveBeenCalled());
    view.webview.postMessage.mockClear();

    agent.emit({ type: "steer_applied", ids: ["s1x"], content: "x" });

    expect(pending()).toEqual([]);
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "steerApplied", ids: ["s1x"], content: "x" });
  });

  it("Stop clears the pending queue so the run does not silently restart", async () => {
    const { handler, agent, view, pending } = await setupStreaming();
    await handler({ type: "send", mode: "queue", id: "q1", text: "later" });
    await handler({ type: "send", mode: "steer", id: "s1x", text: "hmm" });
    await vi.waitFor(() => expect(agent.steer).toHaveBeenCalled());
    view.webview.postMessage.mockClear();

    await handler({ type: "abort" });

    expect(pending()).toEqual([]);
    expect(agent.cancelSteer).toHaveBeenCalledWith("s1x");
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "pending", items: [] });
  });

  it("closing a tab drops its pending queue (no stale bubbles on reopen)", async () => {
    const { handler, agent, pending } = await setupStreaming();
    await handler({ type: "send", mode: "queue", id: "q1", text: "later" });
    expect(pending()).toHaveLength(1);

    agent.streaming = false; // the tab can be closed
    await handler({ type: "closeTab", id: "s1" });

    expect(pending()).toEqual([]);
  });

  it("clears ALL pending steers when the merged steer_applied arrives", async () => {
    const { handler, agent, view, pending } = await setupStreaming();
    await handler({ type: "send", mode: "steer", id: "sA", text: "one" });
    await handler({ type: "send", mode: "steer", id: "sB", text: "two" });
    await vi.waitFor(() => expect(agent.steer).toHaveBeenCalledTimes(2));
    expect(pending().filter((p) => p.mode === "steer").length).toBe(2);
    view.webview.postMessage.mockClear();

    agent.emit({ type: "steer_applied", ids: ["sA", "sB"], content: "one\n\ntwo" });

    expect(pending().filter((p) => p.mode === "steer").length).toBe(0);
    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: "steerApplied",
      ids: ["sA", "sB"],
      content: "one\n\ntwo",
    });
  });

  it("includes the pending list in switchView so a tab switch restores it", async () => {
    const { handler, view, rt } = await setupStreaming();
    await handler({ type: "send", mode: "queue", id: "q1", text: "later" });
    view.webview.postMessage.mockClear();

    await handler({ type: "switchTab", id: "s1" });

    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "switchView", pending: [expect.objectContaining({ id: "q1" })] }),
    );
  });
});

describe("ChatViewProvider DB vacuum suggestion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.noAutoName = false;
    state.autoName = "New Session";
    state.dbVacuumThreshold = undefined;
  });

  const stats = (freeMB: number, totalMB = 1000) => ({
    pageCount: Math.round((totalMB * 1024 * 1024) / 4096),
    freePages: Math.round((freeMB * 1024 * 1024) / 4096),
    pageSize: 4096,
    bytesFree: Math.round(freeMB * 1024 * 1024),
    bytesTotal: Math.round(totalMB * 1024 * 1024),
    ratio: freeMB / totalMB,
  });
  const openedVacuum = (view: any) =>
    view.webview.postMessage.mock.calls.some((c: any[]) => c[0]?.type === "modal" && c[0]?.kind === "dbVacuum");

  it("suggests compaction after a session delete when the free ratio exceeds the threshold", async () => {
    const { store, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    (store.dbVacuumStats as any).mockReturnValue(stats(500)); // 50% >= 20% and 500 MB >= 128 MB
    await handler({ type: "deleteSession", id: "s1" });
    await vi.waitFor(() => expect(openedVacuum(view)).toBe(true));
  });

  it("does NOT suggest when below the threshold", async () => {
    const { store, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew();
    (store.dbVacuumStats as any).mockReturnValue(stats(50)); // 5% < 20%
    await handler({ type: "deleteSession", id: "s1" });
    await new Promise((r) => setTimeout(r, 30));
    expect(openedVacuum(view)).toBe(false);
  });

  it("does NOT suggest below the minimum RECLAIMABLE size (even at a high ratio)", async () => {
    const { store, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew();
    // 90% free but only 90 MB reclaimable (< 128 MB minimum) -> no nagging.
    (store.dbVacuumStats as any).mockReturnValue(stats(90, 100));
    await handler({ type: "deleteSession", id: "s1" });
    await new Promise((r) => setTimeout(r, 30));
    expect(openedVacuum(view)).toBe(false);
  });

  it("suggests after a ✂ cut too", async () => {
    const { store, registry, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew();
    const rt = registry.get("s1")!;
    rt.history.replace([
      { role: "user", content: "q", timestamp: 1 },
      { role: "assistant", content: "a", timestamp: 2 },
    ]);
    (store.dbVacuumStats as any).mockReturnValue(stats(500));
    await handler({ type: "truncateAt", index: 1 });
    await vi.waitFor(() => expect(openedVacuum(view)).toBe(true));
  });

  it("the manual button opens the SAME modal", async () => {
    const { store, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    (store.dbVacuumStats as any).mockReturnValue(stats(500));
    await handler({ type: "openVacuumModal" });
    await vi.waitFor(() => expect(openedVacuum(view)).toBe(true));
  });

  it("runVacuum FORCES a compaction and reports the result", async () => {
    const { store, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    (store.maintain as any).mockReturnValue({ vacuumed: true, before: stats(500), after: stats(0), durationMs: 42 });
    await handler({ type: "runVacuum" });
    expect(store.maintain).toHaveBeenCalledWith({ freeRatioThreshold: 0 });
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "dbVacuumResult", result: expect.objectContaining({ vacuumed: true }) }),
    );
  });

  it("setVacuumThreshold persists the global VS Code setting", async () => {
    const { provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await handler({ type: "setVacuumThreshold", percent: 35 });
    expect(state.updateConfiguration).toHaveBeenCalledWith("dbVacuumThresholdPercent", 35, true);
  });

  it("setVacuumMinFreeMB persists the global VS Code setting", async () => {
    const { provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await handler({ type: "setVacuumMinFreeMB", mb: 25 });
    expect(state.updateConfiguration).toHaveBeenCalledWith("dbVacuumMinFreeMB", 25, true);
  });
});

describe("ChatViewProvider DB vacuum — re-ask + clamping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.noAutoName = false;
    state.autoName = "New Session";
    state.dbVacuumThreshold = undefined;
  });
  const stats = (freeMB: number, totalMB = 1000) => ({
    pageCount: Math.round((totalMB * 1024 * 1024) / 4096),
    freePages: Math.round((freeMB * 1024 * 1024) / 4096),
    pageSize: 4096,
    bytesFree: Math.round(freeMB * 1024 * 1024),
    bytesTotal: Math.round(totalMB * 1024 * 1024),
    ratio: freeMB / totalMB,
  });
  const openedVacuum = (view: any) =>
    view.webview.postMessage.mock.calls.some((c: any[]) => c[0]?.type === "modal" && c[0]?.kind === "dbVacuum");

  it("re-suggests on the NEXT trigger after the prompt was closed", async () => {
    const { store, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await provider.createNew(); // s2
    (store.dbVacuumStats as any).mockReturnValue(stats(500));
    await handler({ type: "deleteSession", id: "s1" });
    await vi.waitFor(() => expect(openedVacuum(view)).toBe(true));
    const first = view.webview.postMessage.mock.calls.map((c: any[]) => c[0]).find((m: any) => m?.kind === "dbVacuum");
    await handler({ type: "modalResponse", id: first.modalId, value: true });
    view.webview.postMessage.mockClear();
    await handler({ type: "openVacuumModal" });
    await vi.waitFor(() => expect(openedVacuum(view)).toBe(true));
  });

  it("clamps the threshold to 1..100 and the min MB to 0..10240", async () => {
    const { provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await handler({ type: "setVacuumThreshold", percent: 0 });
    expect(state.updateConfiguration).toHaveBeenCalledWith("dbVacuumThresholdPercent", 1, true);
    await handler({ type: "setVacuumThreshold", percent: 999 });
    expect(state.updateConfiguration).toHaveBeenCalledWith("dbVacuumThresholdPercent", 100, true);
    await handler({ type: "setVacuumMinFreeMB", mb: -5 });
    expect(state.updateConfiguration).toHaveBeenCalledWith("dbVacuumMinFreeMB", 0, true);
    await handler({ type: "setVacuumMinFreeMB", mb: 999999 });
    expect(state.updateConfiguration).toHaveBeenCalledWith("dbVacuumMinFreeMB", 10240, true);
  });
});

describe("ChatViewProvider DB vacuum — a bocce ferme", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.noAutoName = false;
    state.autoName = "New Session";
    state.dbVacuumThreshold = undefined;
  });

  it("runVacuum WAITS while a session streams, then compacts once idle", async () => {
    const { store, registry, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    (rt.agent as any).streaming = true; // a live turn: a synchronous VACUUM would freeze it
    (store.maintain as any).mockReturnValue({
      vacuumed: true,
      before: { pageCount: 1, freePages: 1, pageSize: 4096, bytesFree: 4096, bytesTotal: 4096, ratio: 1 },
      after: { pageCount: 1, freePages: 0, pageSize: 4096, bytesFree: 0, bytesTotal: 4096, ratio: 0 },
      durationMs: 1,
    });

    const pending = handler({ type: "runVacuum" });
    await new Promise((r) => setTimeout(r, 50));
    // Still streaming: nothing ran yet, and the UI was told we are waiting.
    expect(store.maintain).not.toHaveBeenCalled();
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "dbVacuumRunning" });

    (rt.agent as any).streaming = false;
    await pending; // the 1s poll fires, the session is idle -> compact
    expect(store.maintain).toHaveBeenCalledWith({ freeRatioThreshold: 0 });
    expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "dbVacuumResult" }));
  }, 10_000);
});

describe("ChatViewProvider model limits (context + output)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.noAutoName = false;
    state.autoName = "New Session";
  });

  it("adopts BOTH the context window and the max output tokens the host reports", async () => {
    const { registry, provider } = buildHarness({
      providerEntry: { name: "openrouter", baseUrl: "https://x/v1", models: [] },
      fetchModelInfos: async () => [{ id: "m1", contextLength: 128000, maxOutputTokens: 16384 }],
    });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    await handler({ type: "setModel", model: "m1", provider: "openrouter" });
    expect(rt.contextWindow).toBe(128000);
    expect(rt.outputTokens).toBe(16384);
  });

  it("caps a config maxTokens above the scale maximum (never above 256k)", async () => {
    const { provider, modelSelector } = buildHarness({
      providerEntry: { name: "p", baseUrl: "https://x/v1", maxTokens: 999_999, models: [{ id: "m1" }] },
    });
    const { handler } = resolveWith(provider);
    await provider.createNew();
    await handler({ type: "setModel", model: "m1", provider: "p" });
    expect(modelSelector.set).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 262_144 }));
  });

  it("adopts the models.dev output too when the host reports neither limit", async () => {
    const { registry, provider } = buildHarness({
      providerEntry: { name: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1", models: [] },
      fetchModelInfos: async () => [{ id: "kimi-k3" }],
      modelsDev: { getLimits: vi.fn(async () => ({ context: 1048576, output: 32000 })) },
    });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    await handler({ type: "setModel", model: "kimi-k3", provider: "opencode-go" });
    await vi.waitFor(() => expect(rt.outputTokens).toBe(32000));
    expect(rt.contextWindow).toBe(1048576);
  });

  it("mentions BOTH context and output in the unknown-model alert", async () => {
    const { provider } = buildHarness({
      providerEntry: { name: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1", models: [] },
      fetchModelInfos: async () => [{ id: "unknown-model" }],
      modelsDev: { getLimits: vi.fn(async () => ({})) },
    });
    const { handler, view } = resolveWith(provider);
    await provider.createNew();
    view.webview.postMessage.mockClear();
    await handler({ type: "setModel", model: "unknown-model", provider: "opencode-go" });
    await vi.waitFor(() =>
      expect(view.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "modal",
          kind: "alert",
          message: expect.stringMatching(/context window and max output tokens/),
        }),
      ),
    );
  });
});

describe("ChatViewProvider slider maxima", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.noAutoName = false;
    state.autoName = "New Session";
  });

  it("pushes the model's DETECTED limits as the slider MAXIMA", async () => {
    const { provider } = buildHarness({
      providerEntry: { name: "openrouter", baseUrl: "https://x/v1", models: [] },
      fetchModelInfos: async () => [{ id: "m1", contextLength: 128000, maxOutputTokens: 16384 }],
    });
    const { handler, view } = resolveWith(provider);
    await provider.createNew();
    await handler({ type: "setModel", model: "m1", provider: "openrouter" });
    await vi.waitFor(() => {
      const configs = view.webview.postMessage.mock.calls
        .map((c: unknown[]) => c[0] as { type?: string; config?: { maxContextWindow?: number; maxOutputTokens?: number } })
        .filter((m) => m?.type === "config");
      expect(configs.some((c) => c.config?.maxContextWindow === 128000 && c.config?.maxOutputTokens === 16384)).toBe(true);
    });
  });
});

describe("ChatViewProvider models.dev unreachable warning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.noAutoName = false;
    state.autoName = "New Session";
  });

  const harness = (reachable: boolean, limits: { context?: number; output?: number }) =>
    buildHarness({
      config: { ...CONFIG, hostModelProviders: ["opencode-go"] },
      providerEntry: { name: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1", models: [] },
      fetchModelInfos: async () => [{ id: "kimi-k3" }], // host reports NO limits
      modelsDev: { getLimits: vi.fn(async () => limits), isReachable: () => reachable },
    });

  it("flags modelsDevError when the fallback is UNREACHABLE and a limit is missing", async () => {
    const { provider } = harness(false, {});
    const { handler, view } = resolveWith(provider);
    await handler({ type: "getConfig" });
    const configs = view.webview.postMessage.mock.calls
      .map((c: unknown[]) => c[0] as { type?: string; config?: { modelsDevError?: boolean } })
      .filter((m) => m?.type === "config");
    expect(configs.some((c) => c.config?.modelsDevError === true)).toBe(true);
  });

  it("does NOT flag it when the catalog is reachable (limits resolved)", async () => {
    const { provider } = harness(true, { context: 1000, output: 100 });
    const { view } = resolveWith(provider);
    await vi.waitFor(() => {
      const configs = view.webview.postMessage.mock.calls
        .map((c: unknown[]) => c[0] as { type?: string; config?: { modelsDevError?: boolean } })
        .filter((m) => m?.type === "config");
      expect(configs.length).toBeGreaterThan(0);
      expect(configs.some((c) => c.config?.modelsDevError === true)).toBe(false);
    });
  });
});
