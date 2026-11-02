import { describe, it, expect, vi, beforeEach } from "vitest";
import { MODAL_STALL_MS } from "./modal-stall-guard";
import { memoryStore } from "./webview-bridge.test-utils";
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
import { InMemoryChatHistory } from "../core/history/in-memory-chat-history";
import { ChatViewProvider } from "./chat-view";
import { Compactor, DEFAULT_COMPACTION, TRIM_LABEL, estimateContextTokens } from "../core/sessions/compactor";
import type { LLMProviderFactory } from "../core/llm/types";
import { conversationFaults } from "../core/history/conversation-validity";
import { infoLog } from "../logger";

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
  // The extension host's config-change listener (captured for tests).
  configListener: undefined as ((e: { affectsConfiguration: (s: string) => boolean }) => void) | undefined,
  dbVacuumThreshold: undefined as number | undefined,
}));

vi.mock("../logger", () => ({ infoLog: vi.fn(), debugLog: vi.fn() }));
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
    onDidChangeConfiguration: (cb: (e: { affectsConfiguration: (s: string) => boolean }) => void) => {
      state.configListener = cb;
      return { dispose: () => {} };
    },
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
  autoOpen: false,
};

function makeStore(): SessionStore {
  let c = 0;
  return {
    list: vi.fn(() => []),
    create: vi.fn((name?: string) => ({
      id: `s${++c}`,
      name: name?.trim() || "New Session",
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
    })),
    load: vi.fn((id: string) => ({
      summary: { id, name: "S", createdAt: 1, updatedAt: 1, messageCount: 0 },
      messages: [],
    })),
    // One session's METADATA without its messages (the interface requires it; the cast
    // above used to hide the gap, and `resumeSession` reads it).
    summary: vi.fn((id: string) => ({ id, name: "S", createdAt: 1, updatedAt: 1, messageCount: 0 })),
    saveMessages: vi.fn((id: string, messages) => ({
      id,
      name: "S",
      createdAt: 1,
      updatedAt: 2,
      messageCount: messages.length,
    })),
    saveSettings: vi.fn((id, patch) => ({
      id,
      name: "New Session",
      createdAt: 1,
      updatedAt: 2,
      messageCount: 0,
      ...patch,
    })),
    rename: vi.fn((id, name) => ({ id, name, createdAt: 1, updatedAt: 2, messageCount: 0 })),
    remove: vi.fn(() => true),
    dbVacuumStats: vi.fn(() => ({
      pageCount: 100,
      freePages: 0,
      pageSize: 4096,
      bytesFree: 0,
      bytesTotal: 409600,
      ratio: 0,
    })),
    maintain: vi.fn(() => ({
      vacuumed: false,
      before: { pageCount: 100, freePages: 0, pageSize: 4096, bytesFree: 0, bytesTotal: 409600, ratio: 0 },
      after: { pageCount: 100, freePages: 0, pageSize: 4096, bytesFree: 0, bytesTotal: 409600, ratio: 0 },
      durationMs: 0,
    })),
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
      asWebviewUri: vi.fn(() => ({
        with: (opts: any) => ({ toString: () => "https://r/view.js?" + opts.query }),
        toString: () => "https://r/view.js",
      })),
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
  const store = (opts.store as SessionStore | undefined) ?? makeStore();
  const sessions = new SessionManager(store);
  const createAgent = vi.fn((h: ChatHistory): ChatController => {
    const history = h;
    const handlers: ((e: any) => void)[] = [];
    const agent: any = {
      streaming: false,
      // Faithful to the real Agent: `getMessages()` exposes the WHOLE stored
      // history (`all()`), not the window the model sees (`conversation()`). The
      // two differ as soon as a summary checkpoint exists — and the host uses
      // this for the transcript, the ✂ cut and the ⎇ branch, which must all see
      // the preserved past.
      getMessages: vi.fn(() => history.all()),
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
  // Same wiring as the composition root: the registry asks the VIEW for each session's
  // config, lazily (a session can only be spawned after the provider exists).
  const registry: SessionRegistry = new SessionRegistry({
    sessions,
    store,
    createAgent,
    configFor: (id: string) => provider.sessionConfigFor(id),
  });
  // Faithful config chain, like the composition root in extension.ts:
  // base + a REAL memory-override provider wrapped in spies (keeps behaviour
  // for the provider and lets tests assert on set/clear calls).
  const base: ConfigProvider = { get: () => (opts.config as HarnyConfig | undefined) ?? CONFIG };
  const config = new CompositeConfigProvider(base, []);
  const attachments =
    (opts.attachments as AttachmentService | undefined) ??
    ({
      pick: vi.fn(async () => []),
      buildContext: vi.fn(async () => ({ text: "", images: [] })),
    } as unknown as AttachmentService);
  const providers =
    (opts.providers as ProviderCatalog | undefined) ??
    ({
      getProvider: vi.fn(() => opts.providerEntry as import("../core/config/types").ResolvedNamedProvider | undefined),
      saveModelSelection: vi.fn(),
      readProvidersEditor: vi.fn(() => ({ providers: {} })),
      saveProvidersEditor: vi.fn(() => true),
      readMcpServers: vi.fn(() => (opts.mcpServers as Record<string, unknown> | undefined) ?? {}),
      saveMcpServers: vi.fn(() => (opts.mcpSaveOk as boolean | undefined) ?? true),
    } as unknown as ProviderCatalog);
  const modelList = {
    fetchModels: vi.fn(opts.fetchModels ?? (async () => [])),
    ...(opts.fetchModelInfos ? { fetchModelInfos: vi.fn(opts.fetchModelInfos as () => Promise<unknown[]>) } : {}),
  } as unknown as ModelListProvider;

  const provider = new ChatViewProvider(config, attachments, providers, modelList, sessions, registry, opts);
  provider.setContext({ extensionUri: { fsPath: "/ext" }, subscriptions: [] } as any);
  /**
   * The config the session's agent will actually read: the host chain with THAT
   * session's own override layer on top — the same shape extension.ts builds.
   *
   * Assert on this, not on a shared store: the overrides are per session now, so
   * "which session got the value" is half of what a test has to pin down (see the
   * tab-switch regressions at the bottom of `session switch keeps every run its own`).
   */
  const agentConfig = (sessionId: string): Record<string, unknown> =>
    provider.sessionConfigFor(sessionId).get() as unknown as Record<string, unknown>;
  return { store, sessions, registry, createAgent, provider, agentConfig };
}

function resolveWith(provider: ChatViewProvider): { view: any; handler: (msg: any) => Promise<void> } {
  const { view } = makeView();
  provider.resolveWebviewView(view, {} as any, {});
  return { view, handler: view.webview.onDidReceiveMessage.mock.calls[0][0] as (m: any) => Promise<void> };
}

/**
 * The prerequisites EVERY test in this file shares, in ONE place: the vscode mocks cleared and the
 * state they read reset to its defaults.
 *
 * It used to be repeated in eleven `beforeEach` blocks, in two shapes — one of them also resetting
 * `dbVacuumThreshold`, so a test in a block that forgot that line started from another test's
 * value. A prerequisite is a fixture: one top-level hook, the SUPERSET, and no copies to drift.
 */
beforeEach(() => {
  vi.clearAllMocks();
  state.noAutoName = false;
  state.autoName = "New Session";
  state.dbVacuumThreshold = undefined;
});

describe("ChatViewProvider", () => {
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

  it("renders the credit as PLAIN TEXT by default (no dead link)", async () => {
    const { provider } = buildHarness();
    const { view } = resolveWith(provider);
    await vi.waitFor(() => expect(view.webview.html).toContain('id="sessions"'), { timeout: 2000 });
    expect(view.webview.html).toContain('"brand":{"name":"SPLTek"}');
  });

  it("never links to `repository`: a private repo would hand out a 404", async () => {
    const { provider } = buildHarness();
    provider.setContext({
      extensionUri: { fsPath: "/ext" },
      subscriptions: [],
      extension: { packageJSON: { repository: "git+https://github.com/spltek/harny.git" } },
    } as any);
    const { view } = resolveWith(provider);
    await vi.waitFor(() => expect(view.webview.html).toContain('id="sessions"'), { timeout: 2000 });
    expect(view.webview.html).toContain('"brand":{"name":"SPLTek"}');
    expect(view.webview.html).not.toContain("github.com/spltek");
  });

  it("links the credit when `homepage` is set explicitly", async () => {
    const { provider } = buildHarness();
    provider.setContext({
      extensionUri: { fsPath: "/ext" },
      subscriptions: [],
      extension: {
        packageJSON: {
          homepage: "https://spltek.example/harny",
          repository: "git+https://github.com/spltek/harny.git",
        },
      },
    } as any);
    const { view } = resolveWith(provider);
    await vi.waitFor(() => expect(view.webview.html).toContain('id="sessions"'), { timeout: 2000 });
    expect(view.webview.html).toContain('"name":"SPLTek","url":"https://spltek.example/harny"');
    // `repository` must stay out of the output entirely.
    expect(view.webview.html).not.toContain("github.com/spltek");
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

  /**
   * THE HOME SCREEN (no single folder open).
   *
   * Harny cannot work without one folder, and the old answer was an alert that named
   * the menu — a dead end that also hid the history. Every flow below now ends in a
   * FOLDER, through one injected object, and never in an opened session (with no root
   * its tools would run in `process.cwd()`).
   */
  describe("folder flows (home screen: no single folder open)", () => {
    /** The last config the provider pushed (it pushes more than one while resolving). */
    function lastConfig(view: any): any {
      const posts = view.webview.postMessage.mock.calls
        .map((c: unknown[]) => c[0] as any)
        .filter((m: any) => m.type === "config");
      return posts[posts.length - 1].config;
    }

    it("createNew opens the PICKER for a folder and creates nothing", async () => {
      const { store, provider } = buildHarness({ workspaceReady: () => false });
      const { handler, view } = resolveWith(provider);
      state.showOpenDialog.mockResolvedValue([{ fsPath: "/home/me/new" }]);
      await handler({ type: "newSession" });
      expect(store.create).not.toHaveBeenCalled();
      expect(state.showOpenDialog).toHaveBeenCalledWith(
        expect.objectContaining({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false }),
      );
      expect(state.executeCommand).toHaveBeenCalledWith(
        "vscode.openFolder",
        { fsPath: "/home/me/new" },
        {
          forceReuseWindow: true,
        },
      );
      // No more "exactly one open folder" alert: the folder IS the answer.
      expect(view.webview.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "modal", kind: "alert" }),
      );
    });

    it("…and a cancelled dialog changes nothing at all", async () => {
      const { store, provider } = buildHarness({ workspaceReady: () => false });
      const { handler } = resolveWith(provider);
      state.showOpenDialog.mockResolvedValue(undefined);
      await handler({ type: "newSession" });
      expect(store.create).not.toHaveBeenCalled();
      // A cancelled picker must not reload the window.
      expect(state.executeCommand).not.toHaveBeenCalled();
    });

    it("openWorkspace (the home screen's CTA) opens the chosen folder as the workspace", async () => {
      const { provider } = buildHarness({ workspaceReady: () => false });
      const { handler } = resolveWith(provider);
      state.showOpenDialog.mockResolvedValue([{ fsPath: "/p/chosen" }]);
      await handler({ type: "openWorkspace" });
      expect(state.executeCommand).toHaveBeenCalledWith(
        "vscode.openFolder",
        { fsPath: "/p/chosen" },
        {
          forceReuseWindow: true,
        },
      );
    });

    it("a row whose folder is ALREADY this window's workspace resumes the session, with no reload", async () => {
      // The field report, from the Extension Development Host: the same folder the main window has
      // open was also this window's, so "open that folder" was a no-op that VS Code answered by
      // bringing the OTHER window forward. Nothing to open, so nothing is asked: the click meant
      // "open that session", and it does exactly that, here.
      const pending = { remember: vi.fn(async () => {}), take: vi.fn() };
      const workspace = {
        pick: vi.fn(async () => undefined as string | undefined),
        open: vi.fn(async () => undefined),
        isCurrent: vi.fn(async () => true),
      };
      const { store, provider, registry } = buildHarness({ workspaceReady: () => true, workspace, pending });
      (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          id: "x",
          name: "Casa",
          createdAt: 1,
          updatedAt: 2,
          messageCount: 3,
          folder: "/p/harny",
          folderMissing: false,
        },
      ]);
      const { handler } = resolveWith(provider);
      await handler({ type: "openSessionFolder", id: "x" });

      expect(workspace.open).not.toHaveBeenCalled();
      expect(state.executeCommand).not.toHaveBeenCalledWith("vscode.openFolder", expect.anything(), expect.anything());
      // No marker either: there is no reload to survive, so a marker would only be debris that the
      // next window to activate would have to discard.
      expect(pending.remember).not.toHaveBeenCalled();
      // …and the session IS open here, in this window: the gesture finished, it did not evaporate.
      expect(registry.listOpenIds()).toContain("x");
    });

    it("openSessionFolder (a HOME row) opens that session's folder and NOT the session", async () => {
      const { store, provider, registry } = buildHarness({ workspaceReady: () => false });
      (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          id: "x",
          name: "Casa",
          createdAt: 1,
          updatedAt: 2,
          messageCount: 3,
          folder: "/p/harny",
          folderMissing: false,
        },
      ]);
      const { handler } = resolveWith(provider);
      await handler({ type: "openSessionFolder", id: "x" });
      expect(state.executeCommand).toHaveBeenCalledWith(
        "vscode.openFolder",
        { fsPath: "/p/harny" },
        {
          forceReuseWindow: true,
        },
      );
      expect(state.showOpenDialog).not.toHaveBeenCalled();
      // Opening a session with no root would leave its tools in `process.cwd()`.
      expect(registry.listOpenIds()).toEqual([]);
    });

    it("routes every folder flow through the injected WorkspaceActions (one implementation)", async () => {
      // The provider must not keep its own copy of "ask and open": this is what makes the
      // gesture identical from the CTA, from New session and from a row.
      const workspace = {
        pick: vi.fn(async () => "/p/picked" as string | undefined),
        open: vi.fn(async () => undefined),
        isCurrent: vi.fn(async () => false),
      };
      const { store, provider } = buildHarness({ workspaceReady: () => false, workspace });
      const { handler } = resolveWith(provider);

      await handler({ type: "openWorkspace" });
      expect(workspace.pick).toHaveBeenCalledTimes(1);
      expect(workspace.open).toHaveBeenCalledWith("/p/picked");

      workspace.pick.mockClear();
      (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          id: "s",
          name: "S",
          createdAt: 1,
          updatedAt: 2,
          messageCount: 0,
          folder: "/p/old",
          folderMissing: false,
        },
      ]);
      await handler({ type: "sessionsManagerChangeFolder", id: "s" });
      expect(workspace.pick).toHaveBeenCalledWith(expect.objectContaining({ defaultFolder: "/p/old" }));
      // Re-pointing a session only ASKS: it must not reload the window.
      expect(store.saveSettings).toHaveBeenCalledWith("s", { folder: "/p/picked" });

      // …and the provider never reached for `vscode` to do any of it.
      expect(state.showOpenDialog).not.toHaveBeenCalled();
      expect(state.executeCommand).not.toHaveBeenCalled();
    });

    it("remembers the session to reopen BEFORE the folder opens (the reload is the interruption)", async () => {
      // The marker has to be on disk when the process goes away: the ORDER is the test.
      const order: string[] = [];
      const pending = { remember: vi.fn(async () => void order.push("remember")), take: vi.fn() };
      const workspace = {
        pick: vi.fn(async () => undefined as string | undefined),
        open: vi.fn(async () => void order.push("open")),
        isCurrent: vi.fn(async () => false),
      };
      const { store, provider } = buildHarness({ workspaceReady: () => false, workspace, pending });
      (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          id: "x",
          name: "Casa",
          createdAt: 1,
          updatedAt: 2,
          messageCount: 3,
          folder: "/p/harny",
          folderMissing: false,
        },
      ]);
      const { handler } = resolveWith(provider);
      await handler({ type: "openSessionFolder", id: "x" });
      expect(pending.remember).toHaveBeenCalledWith("/p/harny", { kind: "session", sessionId: "x" });
      expect(order).toEqual(["remember", "open"]);
    });

    it("New session with no folder remembers 'create' for the folder it opens", async () => {
      const pending = { remember: vi.fn(async () => {}), take: vi.fn() };
      const workspace = {
        pick: vi.fn(async () => "/p/new"),
        open: vi.fn(async () => undefined),
        isCurrent: vi.fn(async () => false),
      };
      const { provider } = buildHarness({ workspaceReady: () => false, workspace, pending });
      const { handler } = resolveWith(provider);
      await handler({ type: "newSession" });
      expect(pending.remember).toHaveBeenCalledWith("/p/new", { kind: "create" });
      expect(workspace.open).toHaveBeenCalledWith("/p/new");
    });

    it("the home CTA opens a folder and remembers NOTHING (it is not a session)", async () => {
      const pending = { remember: vi.fn(async () => {}), take: vi.fn() };
      const workspace = {
        pick: vi.fn(async () => "/p/x"),
        open: vi.fn(async () => undefined),
        isCurrent: vi.fn(async () => false),
      };
      const { provider } = buildHarness({ workspaceReady: () => false, workspace, pending });
      const { handler } = resolveWith(provider);
      await handler({ type: "openWorkspace" });
      expect(workspace.open).toHaveBeenCalledWith("/p/x");
      expect(pending.remember).not.toHaveBeenCalled();
    });

    it("a cancelled picker remembers nothing and reloads nothing", async () => {
      const pending = { remember: vi.fn(async () => {}), take: vi.fn() };
      const { provider } = buildHarness({ workspaceReady: () => false, pending });
      const { handler } = resolveWith(provider);
      state.showOpenDialog.mockResolvedValue(undefined);
      await handler({ type: "newSession" });
      await handler({ type: "openWorkspace" });
      expect(pending.remember).not.toHaveBeenCalled();
      expect(state.executeCommand).not.toHaveBeenCalled();
    });

    it("resumeSession finishes the gesture — as soon as the panel can show it", async () => {
      const { store, provider, registry } = buildHarness();
      (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: "x", name: "Casa", createdAt: 1, updatedAt: 2, messageCount: 3, folder: "/p/harny" },
      ]);
      // The reload finished, the panel did not exist yet: the action must WAIT, or its
      // `switchView` would be posted into a page that is not there.
      provider.resumeSession("x");
      expect(registry.isOpen("x")).toBe(false);

      resolveWith(provider);
      await vi.waitFor(() => expect(registry.isOpen("x")).toBe(true));
    });

    it("resumeSession ignores a session that is gone (deleted while the window reloaded)", async () => {
      const { store, provider, registry } = buildHarness();
      (store.summary as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      resolveWith(provider);
      provider.resumeSession("gone");
      // The marker is an intent, not a promise that the row still exists.
      expect(registry.isOpen("gone")).toBe(false);
    });

    it("reports HOW MANY folders are open (a multi-root must not be told 'none is open')", async () => {
      const { provider } = buildHarness({ workspaceReady: () => false, workspaceFolderCount: () => 3 });
      const { handler, view } = resolveWith(provider);
      await handler({ type: "getConfig" });
      const config = lastConfig(view);
      expect(config.workspaceFolderCount).toBe(3);
      expect(config.workspaceReady).toBe(false);
    });

    it("a workspace folder that is GONE is not ready, and the list opens to every folder", async () => {
      // VS Code keeps the workspace open when its folder is deleted on disk. The panel must
      // stop treating it as usable (every tool would fail) AND stop filtering by it: the
      // list becomes the workspace picker, which is the way out.
      const { store, provider } = buildHarness({
        workspaceReady: () => false,
        workspaceFolderCount: () => 1,
        currentFolder: () => "/p/gone",
      });
      (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: "a", name: "A", createdAt: 1, updatedAt: 2, messageCount: 0, folder: "/p/a" },
        { id: "b", name: "B", createdAt: 1, updatedAt: 1, messageCount: 0, folder: "/p/b" },
      ]);
      const { view } = resolveWith(provider);
      await vi.waitFor(() => expect(view.webview.html).toContain('id="harny-view-init"'), { timeout: 2000 });
      const raw = view.webview.html.match(/id="harny-view-init" type="application\/json">([\s\S]*?)<\/script>/);
      const init = JSON.parse(raw![1] as string);
      // Both folders' sessions, in the order the store returned them.
      expect(init.sessions.map((s: { id: string }) => s.id)).toEqual(["a", "b"]);
      expect(init.config.workspaceReady).toBe(false);
      expect(init.config.workspaceFolderCount).toBe(1);
      // …and the hero can NAME the folder it is complaining about.
      expect(init.config.workspaceFolder).toBe("/p/gone");
    });

    it("an embedder that never reports the count still gets a coherent number", async () => {
      const { provider } = buildHarness();
      const { handler, view } = resolveWith(provider);
      await handler({ type: "getConfig" });
      expect(lastConfig(view).workspaceFolderCount).toBe(1);
    });

    it("refresh() before the panel exists is a no-op (activation comes first)", async () => {
      // The composition root can ask for a rebuild before anyone has ever shown the view.
      const { provider } = buildHarness();
      await expect(provider.refresh()).resolves.toBeUndefined();
    });

    it("a deferred action that throws neither breaks the page nor the actions after it", async () => {
      const { store, provider, registry } = buildHarness();
      (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: "x", name: "Casa", createdAt: 1, updatedAt: 2, messageCount: 3, folder: "/p/harny" },
      ]);
      provider.runWhenReady(() => {
        throw new Error("boom");
      });
      provider.resumeSession("x");
      resolveWith(provider);
      // The throwing one is swallowed; the queue keeps going.
      await vi.waitFor(() => expect(registry.isOpen("x")).toBe(true));
    });
  });

  it("play on a dead folder brings the DIALOG back (play → openSessionFolder → alert)", async () => {
    // The whole point of the send gate: the panel posts `openSessionFolder` instead of `send`,
    // and the host answers with the SAME dialog the red row opens — the way forward is always
    // one gesture away, and nothing ever paints a "Working…" that cannot be cleared.
    const store = makeStore();
    (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        id: "s1",
        name: "Dead session",
        createdAt: 1,
        updatedAt: 2,
        messageCount: 3,
        folder: "/p/gone",
        folderMissing: true,
      },
    ]);
    const { provider } = buildHarness({ store, workspaceReady: () => false });
    const { handler, view } = resolveWith(provider);

    await handler({ type: "openSessionFolder", id: "s1" });

    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "modal",
        kind: "alert",
        title: "Folder no longer available",
        message: expect.stringContaining("no longer exists. Pick a new one."),
      }),
    );
  });

  it("warnLostFolder says nothing when no session is on screen (the home IS the picker)", async () => {
    const { provider } = buildHarness({ workspaceReady: () => false });
    const { view } = resolveWith(provider);

    await provider.warnLostFolder();

    // No session to re-point: the picker is already the screen, so there is nothing to ask.
    expect(view.webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "modal" }));
  });

  it("never ENTERS working without a usable root: the send is refused in-panel", async () => {
    // The hole this closes: the panel hides the prompt in the home state, but a session that is
    // OPEN with a dead folder is the chat — and the host used to hand any message to the engine.
    const { provider } = buildHarness({ workspaceReady: () => false });
    const { handler, view } = resolveWith(provider);

    await handler({ type: "send", text: "hello" });

    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "denied",
        action: "send",
        reason: expect.stringContaining("cannot work here"),
      }),
    );
    // …and NOT a dialog: the refusal is said in the transcript, where the message would have
    // gone (no modal on top of the panel for something the panel can say itself).
    expect(view.webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "modal" }));
  });

  it("a rebuild that lands while a modal OPENED does not wipe it (that froze the panel)", async () => {
    // `buildHtml()` is async (config, skills, MCP status): a modal can open in the middle.
    // Wiping the page then would leave its answer never arriving, the queue non-empty for
    // ever and EVERY later refresh deferred behind it — a dialog nobody can answer and a
    // panel that no longer updates.
    const { provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    const before = view.webview.html;
    state.noAutoName = true; // the modal stays open, like a user reading it
    try {
      const rebuilding = provider.refresh();
      const answered = handler({ type: "newSession" });
      await rebuilding;

      expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "modal", kind: "name" }));
      // The page was NOT replaced under the open modal…
      expect(view.webview.html).toBe(before);

      // …and answering it lets the deferred rebuild through: the panel comes back to life.
      const modalPost = view.webview.postMessage.mock.calls.map((c) => c[0] as any).find((m) => m.type === "modal");
      await handler({ type: "modalResponse", id: modalPost.modalId, value: "Casa" });
      await answered;
      expect(view.webview.html).not.toBe(before);
    } finally {
      state.noAutoName = false;
    }
  });

  it("a rebuild stuck behind an unanswered modal RECOVERS by itself (no reload needed)", async () => {
    // The rescue net: the modal is cancelled and the page rebuilt, with a line in the log.
    // Only the TIMER is faked; the rest of the provider keeps its real timing.
    const { store, provider } = buildHarness();
    const { view } = resolveWith(provider);
    state.noAutoName = true;
    const before = view.webview.html;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = provider.createNew(); // a modal nobody answers
      provider.refresh(); // …and a rebuild that must wait behind it
      expect(view.webview.html).toBe(before);

      vi.advanceTimersByTime(MODAL_STALL_MS + 1);
      vi.useRealTimers(); // back to real time before awaiting anything

      // The dialog was cancelled (so the flow ends) and the page was rebuilt.
      await expect(pending).resolves.toBeUndefined();
      expect(store.create).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(view.webview.html).not.toBe(before), { timeout: 2000 });
    } finally {
      vi.useRealTimers();
      state.noAutoName = false;
    }
  });

  it("dispose() cancels a pending modal instead of leaving the flow hanging", async () => {
    const { store, provider } = buildHarness();
    resolveWith(provider);
    state.noAutoName = true;
    try {
      const pending = provider.createNew(); // nobody will answer: the host is going away
      provider.dispose();
      await expect(pending).resolves.toBeUndefined();
      expect(store.create).not.toHaveBeenCalled();
    } finally {
      state.noAutoName = false;
    }
  });

  it("cancelling the in-panel name prompt creates nothing", async () => {
    const { provider, registry } = buildHarness();
    const { handler, view } = resolveWith(provider);
    state.noAutoName = true;
    try {
      const pending = provider.createNew();
      const modalPost = view.webview.postMessage.mock.calls.map((c) => c[0] as any).find((m) => m.type === "modal");
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

  it("reorderTabs applies the dragged order without rebuilding the transcript", async () => {
    const { provider, registry } = buildHarness();
    const { view, handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await provider.createNew(); // s2
    view.webview.postMessage.mockClear();

    await handler({ type: "reorderTabs", ids: ["s2", "s1"] });

    expect(registry.listOpenIds()).toEqual(["s2", "s1"]);
    // The view already shows the new order: a switchView here would wipe and
    // re-render the transcript for a purely cosmetic change.
    expect(view.webview.postMessage).not.toHaveBeenCalled();
  });

  it("setActive announces the switch BEFORE the state, so the view can veil the wait", async () => {
    const { provider } = buildHarness();
    const { view, handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await provider.createNew(); // s2
    view.webview.postMessage.mockClear();

    await handler({ type: "switchTab", id: "s1" });

    const sent = view.webview.postMessage.mock.calls.map((c: any[]) => c[0]);
    // FIRST message out: the button was pressed and the state is still being built
    // (`buildConfig` awaits). Posting it later would be a spinner for a wait that
    // already happened.
    expect(sent[0]).toMatchObject({ type: "switching", id: "s1" });
    expect(sent.map((m: any) => m?.type)).toContain("switchView");
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
    // Nothing reaches the view: a background session's stream is recorded in its own
    // engine and replayed on switch, never painted into the tab you are looking at.
    expect(
      view.webview.postMessage.mock.calls
        .map((c) => c[0])
        .filter((m: any) => m?.type !== "status" && m?.type !== "getConfig"),
    ).toHaveLength(0);

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

  it("ships the WHOLE in-flight turn (tool calls + sub-agents) on switchView, not just text", async () => {
    // The history has NOTHING for an in-flight Parallel batch: the assistant turn
    // is committed with ONE addGroup when the whole batch ends. Without liveTurn,
    // returning to a working session showed a bare "Working…" bar until Stop.
    const { registry, provider } = buildHarness({ emitEvents: true });
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await provider.createNew(); // s2 (active)
    const a1: any = registry.get("s1")!.agent;
    a1.streaming = true;

    a1.emit({ type: "text_delta", content: "Lancio i sub-agent." });
    a1.emit({ type: "tool_call", toolCall: { id: "d1", name: "Delegate", arguments: { id: "api", goal: "g" } } });
    a1.emit({ type: "subagent_start", toolCallId: "d1" });
    a1.emit({ type: "subagent_event", toolCallId: "d1", event: { type: "text_delta", content: "leggo" } });

    await handler({ type: "switchTab", id: "s1" });
    const last = view.webview.postMessage.mock.calls.slice(-1)[0][0];
    expect(last.type).toBe("switchView");
    expect(last.liveTurn).toMatchObject({
      answer: "Lancio i sub-agent.",
      textAfterTools: false, // the preamble stays above the Delegate bubbles
      toolCalls: [{ id: "d1", name: "Delegate", done: false }],
      subAgents: { d1: { status: "running" } },
    });
    expect(last.liveTurn.subAgents.d1.events).toHaveLength(1);

    // The other session's engine is empty: nothing of s1 leaks into it.
    await handler({ type: "switchTab", id: "s2" });
    const last2 = view.webview.postMessage.mock.calls.slice(-1)[0][0];
    expect(last2.liveTurn).toBeUndefined();
  });

  it("drops a switchView that resolves OUT OF ORDER (the newer tab always wins)", async () => {
    // `postSwitchView` awaits the config build, so two clicks can be in flight at
    // once. If the older one lands last it would paint the tab you already left.
    const { provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await provider.createNew(); // s2

    const p = provider as any;
    const real = p.buildConfig.bind(p);
    const gates: (() => void)[] = [];
    p.buildConfig = () => new Promise((resolve) => gates.push(() => resolve(real())));
    view.webview.postMessage.mockClear();

    const first = handler({ type: "switchTab", id: "s1" });
    await new Promise((r) => setTimeout(r, 0));
    const second = handler({ type: "switchTab", id: "s2" });
    await new Promise((r) => setTimeout(r, 0));
    expect(gates).toHaveLength(2);

    gates[1](); // the NEWEST switch (s2) applies…
    await second;
    gates[0](); // …and the stale one (s1) lands late and must be dropped
    await first;

    const switches = view.webview.postMessage.mock.calls.map((c) => c[0]).filter((m: any) => m?.type === "switchView");
    expect(switches).toHaveLength(1);
    expect(switches[0].activeId).toBe("s2");
  });

  it("reports a session as streaming while its SEND PREAMBLE is still running", async () => {
    // The attachment build and the pre-request auto-compaction run BEFORE
    // `agent.streaming` flips: coming back to such a session must still show the
    // working bar and the locked input, not an idle transcript.
    const { registry, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    registry.get("s1")!.engine.beginSend();
    view.webview.postMessage.mockClear();

    await handler({ type: "switchTab", id: "s1" });

    const last = view.webview.postMessage.mock.calls.slice(-1)[0][0];
    expect(last.type).toBe("switchView");
    expect(last.streaming).toBe(true);
    registry.get("s1")!.engine.endSend();
  });

  it("compacts session B while session A is ALREADY compacting", async () => {
    // The guard is per session: a global flag made Compact on B a silent no-op
    // (and skipped B's auto-compaction) whenever A was summarizing.
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\nx");
    const { provider, registry } = buildHarness({
      compactor: { summarize } as unknown as Compactor,
      compaction: DEFAULT_COMPACTION,
    });
    resolveWith(provider);
    await provider.createNew(); // s1
    await provider.createNew(); // s2
    const msgs = [
      { role: "user", content: "a", timestamp: 1 },
      { role: "assistant", content: "b", timestamp: 2 },
      { role: "user", content: "c", timestamp: 3 },
      { role: "assistant", content: "d", timestamp: 4 },
      { role: "user", content: "e", timestamp: 5 },
      { role: "assistant", content: "f", timestamp: 6 },
      { role: "user", content: "g", timestamp: 7 },
      { role: "assistant", content: "h", timestamp: 8 },
    ];
    registry.get("s1")!.history.replace(msgs);
    registry.get("s2")!.history.replace(msgs);

    registry.get("s1")!.engine.beginCompaction(); // A is busy
    const ok = await provider.compactForOverflow("s2");

    expect(ok).toBe(true);
    expect(summarize).toHaveBeenCalled();
  });

  it("does NOT rebuild the config for the usage of a session you are not watching", async () => {
    // Every session reports usage at every turn: a hidden one must not trigger a
    // config build + post (the numbers on screen are the ACTIVE session's).
    const { registry, provider } = buildHarness({ emitEvents: true });
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await provider.createNew(); // s2 (active)
    const a1: any = registry.get("s1")!.agent;
    a1.streaming = true;
    view.webview.postMessage.mockClear();

    a1.emit({ type: "usage", usage: { input: 100, output: 10, total: 110 } });

    const configs = view.webview.postMessage.mock.calls.map((c) => c[0]).filter((m: any) => m?.type === "config");
    expect(configs).toHaveLength(0);
    // The value is still recorded, so opening that session shows it.
    expect(registry.get("s1")!.contextTokens).toBe(100);
    void handler;
  });

  it("pushes the config for the ACTIVE session's usage, ONCE for a burst", async () => {
    const { registry, provider } = buildHarness({ emitEvents: true });
    resolveWith(provider);
    await provider.createNew(); // s1 (active)
    const a1: any = registry.get("s1")!.agent;
    a1.streaming = true;
    const view = (provider as unknown as { view: { webview: { postMessage: any } } }).view;
    view.webview.postMessage.mockClear();

    a1.emit({ type: "usage", usage: { input: 42, output: 1, total: 43 } });
    a1.emit({ type: "usage", usage: { input: 43, output: 1, total: 44 } });
    a1.emit({ type: "usage", usage: { input: 44, output: 1, total: 45 } });

    await vi.waitFor(() => {
      const configs = view.webview.postMessage.mock.calls
        .map((c: any[]) => c[0])
        .filter((m: any) => m?.type === "config");
      expect(configs).toHaveLength(1); // three reports, ONE push
    });
  });

  it("refuses to SAVE providers while a session is streaming", async () => {
    // A provider edit rewrites the endpoint/key every open run resolves on its next
    // request: the gears stay usable, this specific save does not.
    const { registry, provider } = buildHarness({ emitEvents: true });
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1 (active)
    (registry.get("s1")!.agent as any).streaming = true;
    view.webview.postMessage.mockClear();

    await handler({ type: "saveProviders", data: { providers: {} } });

    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "providersSaved", ok: false });
  });

  it("does not re-send the sessions list on a plain tab switch (but does on create)", async () => {
    // `currentFolderSessions()` is a SELECT * on the session table: sending it on
    // every click is pure waste, and the list only changes on create/branch/close.
    const { provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await provider.createNew(); // s2
    view.webview.postMessage.mockClear();
    const switchViews = () =>
      view.webview.postMessage.mock.calls.map((c) => c[0]).filter((m: any) => m?.type === "switchView");

    await handler({ type: "switchTab", id: "s1" });
    expect(switchViews().slice(-1)[0].sessions).toBeUndefined(); // "keep what you have"

    await provider.createNew(); // the list CHANGED: it must travel
    expect(Array.isArray(switchViews().slice(-1)[0].sessions)).toBe(true);
  });

  it("keeps the ⏹ (abort-requested) state of a sub-agent across a tab switch", async () => {
    const { registry, provider } = buildHarness({ emitEvents: true });
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await provider.createNew(); // s2 (active)
    const rt = registry.get("s1")!;
    const a1: any = rt.agent;
    a1.streaming = true;
    a1.emit({ type: "tool_call", toolCall: { id: "d1", name: "Delegate", arguments: { id: "api" } } });
    a1.emit({ type: "subagent_start", toolCallId: "d1" });

    await handler({ type: "switchTab", id: "s1" });
    await handler({ type: "abortSubAgent", toolCallId: "d1" });
    expect(a1.abortSubAgent).toHaveBeenCalledWith("d1");

    // Away and back: the projection still carries the request, so the rebuilt
    // bubble does not offer an abort button that was already pressed.
    await handler({ type: "switchTab", id: "s2" });
    await handler({ type: "switchTab", id: "s1" });
    const last = view.webview.postMessage.mock.calls.slice(-1)[0][0];
    expect(last.liveTurn.toolCalls[0]).toMatchObject({ id: "d1", abortRequested: true });
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

  it("queues a second send arriving during the async preamble (no overlapping run)", async () => {
    let release!: (v: { text: string; images: string[] }) => void;
    const gate = new Promise<{ text: string; images: string[] }>((r) => (release = r));
    const attachments = {
      pick: vi.fn(async () => []),
      buildContext: vi.fn(() => gate),
    } as unknown as AttachmentService;
    const { registry, provider } = buildHarness({ attachments });
    const { handler, view } = resolveWith(provider);
    await provider.createNew();
    await handler({ type: "setModel", model: "m", provider: "p" });
    const agent = registry.get("s1")!.agent as any;

    // First message: its preamble (attachment build) is in flight.
    const first = handler({
      type: "send",
      text: "first",
      attachments: [{ name: "a.txt", path: "/tmp/a", size: 1, isImage: false }],
    });
    // A second message must be QUEUED (the send lock), not start a second run.
    await handler({ type: "send", text: "second" });
    expect(agent.send).not.toHaveBeenCalled();
    const pending = view.webview.postMessage.mock.calls
      .map((c) => c[0])
      .filter((m) => m.type === "pending")
      .at(-1);
    expect(pending.items.map((i: { text: string }) => i.text)).toContain("second");

    release({ text: "", images: [] });
    await first;
    // Only the first run started; the queued one did not overlap it.
    expect(agent.send).toHaveBeenCalledTimes(1);
  });

  it("runVacuum SKIPS (never freezes a live turn) when the chat is still busy", async () => {
    const { store, registry, provider } = buildHarness({ vacuumWaitMs: 20 });
    const { handler, view } = resolveWith(provider);
    await provider.createNew();
    await handler({ type: "setModel", model: "m", provider: "p" });
    (registry.get("s1")!.agent as any).streaming = true; // session busy

    await handler({ type: "runVacuum" });

    expect(store.maintain as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "dbVacuumSkipped" });
  });

  it("persists the model selection to the config as the comment-preserving default", async () => {
    const saveModelSelection = vi.fn(() => true);
    const providers = {
      getProvider: vi.fn(() => undefined),
      saveModelSelection,
      readProvidersEditor: vi.fn(() => ({ providers: {} })),
      saveProvidersEditor: vi.fn(() => true),
      readMcpServers: vi.fn(() => ({})),
      saveMcpServers: vi.fn(() => true),
    } as unknown as import("../core/config/types").ProviderCatalog;
    const { provider } = buildHarness({ providers });
    const { handler } = resolveWith(provider);
    await provider.createNew();

    await handler({ type: "setModel", model: "gpt-4o", provider: "openai" });

    // The choice is also written back to config.json (top-level `model`),
    // preserving comments — the documented default for new sessions.
    expect(saveModelSelection).toHaveBeenCalledWith("gpt-4o", "openai");
  });

  it("reports the EFFECTIVE output tokens (config default) for a session with no override", async () => {
    const { provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // fresh session: no output override
    view.webview.postMessage.mockClear();

    await handler({ type: "getConfig" });

    const configMsg = view.webview.postMessage.mock.calls
      .map((c) => c[0])
      .filter((m) => m.type === "config")
      .at(-1);
    // The slider must show what the request really sends (CONFIG.maxTokens=100),
    // not the bare DEFAULT_OUTPUT_TOKENS (8 192).
    expect(configMsg.config.outputTokens).toBe(100);
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
    await handler({ type: "send", text: "first message" });

    // both entries persist: refresh/switch re-renders from history, and the
    // next "now do it" (after picking a model) still sees this message.
    const msgs = registry.get("s1")!.agent.getMessages();
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[0].content).toBe("first message");
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

  // ── The 🗑 question: delete / rewind / empty ──
  // The trash asks ONE question with three answers. These tests answer it by hand
  // (`state.noAutoAlert`) because the auto-reply can only say true/false.
  const cleanupModal = (view: any) =>
    view.webview.postMessage.mock.calls
      .map((c: any[]) => c[0] as any)
      .filter((m) => m.type === "modal" && m.kind === "alert")
      .pop();

  it("the trash asks delete / rewind / empty in ONE modal, rewind disabled without a summary", async () => {
    const { provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1: never compacted, so there is nothing to rewind to
    state.noAutoAlert = true;
    try {
      const p = handler({ type: "deleteSession", id: "s1" });
      const modal = cleanupModal(view);
      expect(modal.confirmText).toBe("Delete");
      expect(modal.danger).toBe(true);
      expect(modal.extraActions.map((a: any) => a.value)).toEqual(["rewind", "empty"]);
      // Disabled, NOT hidden: the answer set must not move between two sessions.
      expect(modal.extraActions[0].disabled).toBe(true);
      expect(modal.extraActions[1].disabled).toBeFalsy();
      expect(modal.message).toContain("first compaction summary");
      await handler({ type: "modalResponse", id: modal.modalId, value: false });
      await p;
    } finally {
      state.noAutoAlert = false;
    }
  });

  it("the trash can EMPTY a session: the session and its settings stay, the transcript goes", async () => {
    const { store, registry, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.history.replace([
      { role: "user", content: "q", timestamp: 1 },
      { role: "assistant", content: "a", timestamp: 2 },
    ]);
    rt.contextTokens = 4242;
    rt.cachedTokens = 900;
    state.noAutoAlert = true;
    try {
      const p = handler({ type: "deleteSession", id: "s1" });
      const modal = cleanupModal(view);
      await handler({ type: "modalResponse", id: modal.modalId, value: "empty" });
      await p;
    } finally {
      state.noAutoAlert = false;
    }
    expect(store.remove).not.toHaveBeenCalled();
    expect(registry.isOpen("s1")).toBe(true);
    expect(rt.history.all()).toEqual([]);
    expect(store.saveMessages).toHaveBeenCalledWith("s1", [], { replace: true });
    // The metric belonged to the transcript that was just dropped.
    expect(rt.contextTokens).toBe(0);
    expect(rt.cachedTokens).toBe(0);
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { contextTokens: 0 });
  });

  it("the trash can REWIND to the first summary: the summary stays, everything after it goes", async () => {
    const { store, registry, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    const pair = [
      { role: "user", content: "Summary of past interactions", timestamp: 3, synthetic: true },
      { role: "assistant", content: "## Goal\nship it", timestamp: 4, synthetic: true },
    ];
    const msgs = [
      { role: "user", content: "q", timestamp: 1 },
      { role: "assistant", content: "a", timestamp: 2 },
      ...pair,
      { role: "user", content: "after", timestamp: 5 },
      { role: "assistant", content: "after-a", timestamp: 6 },
    ];
    rt.history.replace(msgs);
    rt.contextTokens = 99999;
    state.noAutoAlert = true;
    try {
      const p = handler({ type: "deleteSession", id: "s1" });
      const modal = cleanupModal(view);
      expect(modal.extraActions[0].disabled).toBe(false);
      await handler({ type: "modalResponse", id: modal.modalId, value: "rewind" });
      await p;
    } finally {
      state.noAutoAlert = false;
    }
    const kept = msgs.slice(0, 4);
    expect(store.remove).not.toHaveBeenCalled();
    expect(registry.isOpen("s1")).toBe(true);
    expect(rt.history.all()).toEqual(kept);
    expect(store.saveMessages).toHaveBeenCalledWith("s1", kept, { replace: true });
    // The window now OPENS on the kept summary: the metric is that state document,
    // not the tail that was dropped.
    expect(rt.contextTokens).toBe(estimateContextTokens(pair));
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { contextTokens: rt.contextTokens });
  });

  it("a rewind without a summary is refused instead of emptying the session", async () => {
    // The answer is sent DISABLED, so a stale or scripted client cannot turn
    // "rewind" into a wipe: no checkpoint means no rewrite at all.
    const { store, registry, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1: never compacted
    const msgs = [
      { role: "user", content: "q", timestamp: 1 },
      { role: "assistant", content: "a", timestamp: 2 },
    ];
    const rt = registry.get("s1")!;
    rt.history.replace(msgs);
    state.noAutoAlert = true;
    try {
      const p = handler({ type: "deleteSession", id: "s1" });
      const modal = cleanupModal(view);
      await handler({ type: "modalResponse", id: modal.modalId, value: "rewind" });
      await p;
    } finally {
      state.noAutoAlert = false;
    }
    expect(rt.history.all()).toEqual(msgs);
    expect(store.saveMessages).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
  });

  it("cancelling the trash question changes nothing", async () => {
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
      const p = handler({ type: "deleteSession", id: "s1" });
      const modal = cleanupModal(view);
      await handler({ type: "modalResponse", id: modal.modalId, value: undefined });
      await p;
    } finally {
      state.noAutoAlert = false;
    }
    expect(store.remove).not.toHaveBeenCalled();
    expect(registry.isOpen("s1")).toBe(true);
    expect(rt.history.all()).toEqual(msgs);
    expect(store.saveMessages).not.toHaveBeenCalled();
  });

  it("refuses to delete and rename a session whose SEND PREAMBLE is still running", async () => {
    // "Working" used to mean `agent.streaming` only: during the preamble (attachment
    // build, pre-request auto-compaction — seconds) the destructive actions looked
    // available and only the host's silent guard stood between them and a runtime
    // that already had a run on the way. `workingIds`/the guards now use `isWorking`.
    const { store, registry, provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    registry.get("s1")!.engine.beginSend();
    try {
      await handler({ type: "deleteSession", id: "s1" });
      expect(registry.isOpen("s1")).toBe(true);
      expect(store.remove).not.toHaveBeenCalled();

      await handler({ type: "renameSession", id: "s1" });
      expect(store.rename).not.toHaveBeenCalled(); // the name modal never opened
    } finally {
      registry.get("s1")?.engine.endSend();
    }
  });

  it("reports a session as BUSY (workingIds) while its send preamble runs", async () => {
    const { registry, provider } = buildHarness();
    const { view } = resolveWith(provider);
    await provider.createNew(); // s1
    registry.get("s1")!.engine.beginSend();
    try {
      await provider.setActive("s1");
      const last = view.webview.postMessage.mock.calls.slice(-1)[0][0];
      expect(last.type).toBe("switchView");
      // The tab × , the row actions and the manager all read workingIds: it must
      // agree with the host about what "busy" means.
      expect(last.workingIds).toContain("s1");
    } finally {
      registry.get("s1")!.engine.endSend();
    }
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
    const configPosts = view.webview.postMessage.mock.calls.map((c) => c[0] as any).filter((m) => m.type === "config");
    expect(configPosts[configPosts.length - 1].config.thinkingLevel).toBe("high");
  });

  it("setMode stores the mode on the runtime, propagates it to the agent, persists and pushes config", async () => {
    const { provider, registry, store } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;

    await handler({ type: "setMode", mode: "agent" });
    expect(rt.mode).toBe("agent");
    expect(rt.agent.setMode).toHaveBeenCalledWith("agent");
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { mode: "agent" });

    await handler({ type: "setMode", mode: "analyze" });
    expect(rt.mode).toBe("analyze");
    expect(rt.agent.setMode).toHaveBeenCalledWith("analyze");

    const configPosts = view.webview.postMessage.mock.calls.map((c) => c[0] as any).filter((m) => m.type === "config");
    expect(configPosts[configPosts.length - 1].config.mode).toBe("analyze");

    // invalid modes are rejected
    await handler({ type: "setMode", mode: "banana" });
    expect(rt.mode).toBe("analyze");
  });

  it("setMode propagates to the agent and persists — while the session works too", async () => {
    // The UI used to lock the Mode button during a run, so a click never arrived; the
    // host itself has no such gate: the change lands in the agent immediately and the
    // agent applies it from the NEXT run (see Agent.runMode) — the Mode/Parallel pills are
    // safety policies, decided once per run.
    const { provider, registry, store } = buildHarness({ compactor: { summarize: vi.fn() } as unknown as Compactor });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    (rt.agent as any).streaming = true; // mid-run

    await handler({ type: "setMode", mode: "agent" });

    expect(rt.mode).toBe("agent");
    expect((rt.agent as any).setMode).toHaveBeenCalledWith("agent");
    expect(store.saveSettings).toHaveBeenCalledWith("s1", expect.objectContaining({ mode: "agent" }));

    // A nonsense value is ignored: no silent mode loss.
    (rt.agent as any).setMode.mockClear();
    await handler({ type: "setMode", mode: "nonsense" });
    expect((rt.agent as any).setMode).not.toHaveBeenCalled();
    expect(rt.mode).toBe("agent");
  });

  it("Restricted Mode (untrusted folder): Build is REFUSED with a reason, never stored", async () => {
    // An untrusted folder outranks the mode toggle. Storing the preference would leave the pill
    // saying "Build" over a run that can only preview: a refusal that is EXPLAINED is honest, a
    // promise that is not kept is not. The reason lands in the transcript (the `denied` contract)
    // and the panel is told the truth on the next config push.
    const { provider, registry, store } = buildHarness({ workspaceTrusted: () => false });
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    (rt.agent as any).setMode.mockClear();
    view.webview.postMessage.mockClear();
    // A FRESH read of the posts: pushConfig is async, so a snapshot taken before a call would
    // simply not contain that call's push (and the assertion would blame the host).
    const postsOf = (): any[] => view.webview.postMessage.mock.calls.map((c: unknown[]) => c[0] as any);

    await handler({ type: "setMode", mode: "agent" });

    expect(rt.mode).not.toBe("agent"); // nothing stored…
    expect(store.saveSettings).not.toHaveBeenCalledWith("s1", expect.objectContaining({ mode: "agent" }));
    expect((rt.agent as any).setMode).not.toHaveBeenCalledWith("agent"); // …and nothing promised
    expect(postsOf().find((m) => m.type === "denied")?.reason).toMatch(/Restricted Mode/);

    // Analyze is still allowed — and that is what the panel is TOLD the session is.
    await handler({ type: "setMode", mode: "analyze" });
    await new Promise((r) => setTimeout(r, 0));
    const configs = postsOf().filter((m) => m.type === "config");
    expect(configs.length).toBeGreaterThan(0);
    expect(configs[configs.length - 1].config.workspaceTrusted).toBe(false);
    expect(configs[configs.length - 1].config.mode).toBe("analyze");
  });

  it("a session that had Build SAVED runs Analyze in Restricted Mode (the preference survives)", async () => {
    // The other direction of the same rule: the stored choice is left alone, so trusting the folder
    // gives Build back without another click — but the agent must never RUN it meanwhile.
    const { provider, registry } = buildHarness({ workspaceTrusted: () => false });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.mode = "agent"; // e.g. saved in a trusted folder, then the window reloaded untrusted
    await handler({ type: "setModel", model: "gpt-4o", provider: undefined });
    (rt.agent as any).setMode.mockClear();
    await handler({ type: "send", text: "do it" });

    expect((rt.agent as any).setMode).toHaveBeenCalledWith("analyze");
    expect(rt.mode).toBe("agent"); // the preference is the user's, not ours to erase
  });

  it("setParallel is PER-SESSION, persists and pushes config", async () => {
    const { provider, registry, store } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;

    await handler({ type: "setParallel", parallel: true });
    expect(rt.parallel).toBe(true);
    expect(rt.agent.setDelegation).toHaveBeenCalledWith(true);
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { parallel: true });
    const configPosts = view.webview.postMessage.mock.calls.map((c) => c[0] as any).filter((m) => m.type === "config");
    expect(configPosts[configPosts.length - 1].config.parallel).toBe(true);

    // non-boolean payloads are rejected
    await handler({ type: "setParallel", parallel: "yes" });
    const after = view.webview.postMessage.mock.calls.map((c) => c[0] as any).filter((m) => m.type === "config");
    expect(after[after.length - 1].config.parallel).toBe(true);
  });

  it("Parallel is per-session: a NEW session starts OFF, switching back restores it", async () => {
    const { provider, registry } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setParallel", parallel: true }); // s1 → ON
    expect(registry.get("s1")!.parallel).toBe(true);

    await provider.createNew(); // s2 (active)
    const switchPosts = view.webview.postMessage.mock.calls
      .map((c) => c[0] as any)
      .filter((m) => m.type === "switchView");
    expect(switchPosts[switchPosts.length - 1].config.parallel).toBe(false);

    // Switching back to s1 restores ITS Parallel ON.
    await handler({ type: "switchTab", id: "s1" });
    const back = view.webview.postMessage.mock.calls.map((c) => c[0] as any).filter((m) => m.type === "switchView");
    expect(back[back.length - 1].config.parallel).toBe(true);
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
    const configPosts = view.webview.postMessage.mock.calls.map((c) => c[0] as any).filter((m) => m.type === "config");
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
    const configPosts = view.webview.postMessage.mock.calls.map((c) => c[0] as any).filter((m) => m.type === "config");
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
    const configPosts = view.webview.postMessage.mock.calls.map((c) => c[0] as any).filter((m) => m.type === "config");
    expect(configPosts[configPosts.length - 1].config.maxParallelSubAgents).toBe(6);

    // Off = 0 (explicitly no cap), still persisted as a number.
    await handler({ type: "setMaxParallelSubAgents", value: 0 });
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { maxParallelSubAgents: 0 });
    await vi.waitFor(() => {
      const posts = view.webview.postMessage.mock.calls.map((c) => c[0] as any).filter((m) => m.type === "config");
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
    const configPosts = view.webview.postMessage.mock.calls.map((c) => c[0] as any).filter((m) => m.type === "config");
    expect(configPosts[configPosts.length - 1].config.loopGuard).toBe("high");

    await handler({ type: "setLoopGuard", value: undefined });
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { loopGuard: undefined });
  });

  it("setLoopGuard accepts off, and a legacy 'normal' is stored as 'medium'", async () => {
    const { store, provider, registry } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1

    // OFF reaches the agent as a DISABLED option set (the guard is fully inert).
    const agent = registry.get("s1")!.agent;
    (agent.setLoopGuardOptions as ReturnType<typeof vi.fn>).mockClear();
    await handler({ type: "setLoopGuard", value: "off" });
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { loopGuard: "off" });
    expect(agent.setLoopGuardOptions).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    const configPosts = view.webview.postMessage.mock.calls.map((c) => c[0] as any).filter((m) => m.type === "config");
    expect(configPosts[configPosts.length - 1].config.loopGuard).toBe("off");

    // A client still sending the pre-rename name is migrated, never stored verbatim.
    (agent.setLoopGuardOptions as ReturnType<typeof vi.fn>).mockClear();
    await handler({ type: "setLoopGuard", value: "normal" as never });
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { loopGuard: "medium" });
    expect(agent.setLoopGuardOptions).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));

    // And a truly unknown value clears the override (undefined = the default).
    await handler({ type: "setLoopGuard", value: "bogus" as never });
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { loopGuard: undefined });

    // The push the webview needs to RENDER all four states: the presets must carry `off`,
    // or the parameter panel would have nothing to fill in when the guard is switched off.
    const last = configPosts[configPosts.length - 1].config;
    expect(Object.keys(last.loopGuardPresets).sort()).toEqual(["high", "low", "medium", "off"]);
    expect(last.loopGuardPresets.off.enabled).toBe(false);
    expect(last.loopGuardPresets.medium.enabled).toBe(true);
  });

  it("setLoopGuardResponse persists the opt-in flag and applies it to the agent", async () => {
    const { store, provider, registry } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setLoopGuardResponse", value: true });
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { loopGuardResponse: true });
    expect(registry.get("s1")!.agent.setLoopGuardOptions).toHaveBeenCalled();
    await vi.waitFor(() => {
      const posts = view.webview.postMessage.mock.calls.map((c) => c[0] as any).filter((m) => m.type === "config");
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

  it("toggleMcpServer persists the enabled flag and reconnects ONLY that server", async () => {
    const saveMcpServers = vi.fn(() => true);
    const connect = vi.fn(async () => {});
    const { provider } = buildHarness({
      // A full pass here would dispose() every other server: each `npx` process would be
      // killed and respawned just because one row was clicked.
      mcp: { connect, getStatuses: () => [], getTools: () => [] } as any,
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
    expect(connect).toHaveBeenCalledWith("test");
  });

  it("setMcpToolSelection writes ONLY the session: the config file and the connection are untouched", async () => {
    // The panel's Save answers "what does THIS conversation do", so it must not decide for the file
    // (one panel would rule every session) and must not reconnect (nothing about the registration
    // changed — the scope is read live at every turn). It used to do both.
    const saveMcpServers = vi.fn(() => true);
    const connect = vi.fn(async () => {});
    const mcp = {
      connect,
      getTools: () => [],
      getStatuses: () => [
        {
          name: "test",
          ok: true,
          enabled: true,
          toolCount: 2,
          tools: [{ name: "echo" }, { name: "drop_table" }],
        },
      ],
    } as any;
    const { provider, registry } = buildHarness({
      mcp,
      providers: {
        getProvider: vi.fn(),
        saveModelSelection: vi.fn(),
        readMcpServers: vi.fn(() => ({ test: { command: "node", analyze: "read-only" } })),
        saveMcpServers,
      } as unknown as ProviderCatalog,
    });
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    saveMcpServers.mockClear();

    await handler({ type: "setMcpToolSelection", server: "test", enabled: ["echo"], analyze: ["echo"] });

    // `mcp` stays EMPTY: a new session starts with every server switched off, and picking tools is
    // not the switch (see the next test).
    expect(registry.get("s1")!.toolScope).toEqual({
      mcp: [],
      off: ["mcp__test__drop_table"],
      analyze: ["mcp__test__echo"],
    });
    expect(saveMcpServers).not.toHaveBeenCalled(); // the file is the user's, not this panel's
    expect(connect).not.toHaveBeenCalled();
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mcpToolSelectionSaved", server: "test", ok: true }),
    );
  });

  it("a tools save never turns the server ON (or OFF) in the session: that is the card's switch", async () => {
    // The report: "if the mcp was disabled it must stay that way". The tools panel's Save answers
    // "which of this server's tools may the model see"; whether the session USES the server is the
    // card's on/off switch. They used to be one decision — the save pushed the server into the scope
    // as soon as one tool was picked, so editing the tools of a switched-off server turned it back
    // ON behind the user's back (and un-ticking the last tool switched a used one OFF).
    const mcp = {
      connect: vi.fn(async () => {}),
      getTools: () => [],
      getStatuses: () => [
        { name: "test", ok: true, enabled: true, toolCount: 2, tools: [{ name: "echo" }, { name: "ping" }] },
      ],
    } as any;
    const { provider, registry } = buildHarness({
      mcp,
      providers: {
        getProvider: vi.fn(),
        saveModelSelection: vi.fn(),
        readMcpServers: vi.fn(() => ({ test: { command: "node" } })),
        saveMcpServers: vi.fn(() => true),
      } as unknown as ProviderCatalog,
    });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1 — every server starts switched off
    expect(registry.get("s1")!.toolScope?.mcp).toEqual([]);

    // OFF stays OFF, and the choice of tools is still recorded for when it is switched on.
    await handler({ type: "setMcpToolSelection", server: "test", enabled: ["echo"], analyze: [] });
    expect(registry.get("s1")!.toolScope?.mcp).toEqual([]);
    expect(registry.get("s1")!.toolScope?.off).toEqual(["mcp__test__ping"]);

    // ON stays ON — exposing no tool of a server the session IS using drops it from the scope, which
    // is the old, deliberate meaning of "None".
    await handler({ type: "setToolScope", scope: { mcp: ["test"], off: [], analyze: [] } });
    await handler({ type: "setMcpToolSelection", server: "test", enabled: ["echo"], analyze: [] });
    expect(registry.get("s1")!.toolScope?.mcp).toEqual(["test"]);
  });

  it("a server name that needs SANITIZING round-trips: one spelling, on the host's side", async () => {
    // The bug this prevents, found in the wild: the registry registers `my-server` as
    // `mcp__my_server__…`, and a raw-name comparison left that server unswitchable. The panel no
    // longer spells anything — it sends intent — so this pins the seam BOTH ways.
    const mcp = {
      connect: vi.fn(async () => {}),
      getTools: () => [],
      getStatuses: () => [
        { name: "my-server", ok: true, enabled: true, toolCount: 2, tools: [{ name: "read-file" }, { name: "write" }] },
      ],
    } as any;
    const { provider, registry } = buildHarness({
      mcp,
      providers: {
        getProvider: vi.fn(),
        saveModelSelection: vi.fn(),
        readMcpServers: vi.fn(() => ({ "my-server": { command: "node" } })),
        saveMcpServers: vi.fn(() => true),
      } as unknown as ProviderCatalog,
    });
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1

    // The panel wants `write` only.
    await handler({ type: "setMcpToolSelection", server: "my-server", enabled: ["write"] });

    // 1. The SCOPE holds the registered spelling. (`mcp` is empty: the session was not using it.)
    expect(registry.get("s1")!.toolScope).toEqual({
      mcp: [],
      off: ["mcp__my_server__read_file"],
      analyze: [],
    });
    // 2. …and the payload tells the panel about it with that same spelling, so the checkbox shows
    //    the truth instead of comparing two different names.
    const configs = view.webview.postMessage.mock.calls.map((c) => c[0] as any).filter((m) => m.type === "config");
    const tools = configs[configs.length - 1].config.mcp.statuses[0].tools;
    expect(tools).toEqual([{ name: "read-file", off: true }, { name: "write" }]);
  });

  it('a MALFORMED setToolScope changes nothing (it must never mean "everything allowed")', async () => {
    // `undefined` is the one value that restricts nothing — the legacy meaning. A garbled message
    // must not be able to grant a session every server.
    const { provider, registry } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew();
    const rt = registry.get("s1")!;
    rt.toolScope = { mcp: [], off: ["Shell"] };

    for (const payload of [{}, { scope: null }, { scope: "nope" }, { scope: 42 }]) {
      await handler({ type: "setToolScope", ...payload });
      expect(rt.toolScope).toEqual({ mcp: [], off: ["Shell"] }); // untouched
    }
  });

  it("refuses to REMOVE a server a RUNNING session is using — and only then", async () => {
    // The window this closes: the turn already has the server's tools in its list, the user deletes
    // the server, and the very next tool call comes back as "Unknown tool". Blocking is precise:
    // a server nobody is using (or used by an IDLE session) is removed without friction.
    const saveMcpServers = vi.fn(() => true);
    const connect = vi.fn(async () => {});
    const { provider, registry } = buildHarness({
      mcp: { connect, getStatuses: () => [], getTools: () => [] } as any,
      providers: {
        getProvider: vi.fn(),
        saveModelSelection: vi.fn(),
        readMcpServers: vi.fn(() => ({ used: { command: "node" }, idle: { command: "node" } })),
        saveMcpServers,
      } as unknown as ProviderCatalog,
    });
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.toolScope = { mcp: ["used"], off: [] };
    const working = vi.spyOn(provider as unknown as { isWorking: (id: string) => boolean }, "isWorking");
    working.mockReturnValue(true);
    (rt.agent as any).streaming = true;

    // 1. A session is RUNNING with `used` ON: the removal is refused, and says why.
    await handler({ type: "saveMcpServers", servers: { idle: { command: "node" } } });
    expect(saveMcpServers).not.toHaveBeenCalled();
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mcpSaved", ok: false, reason: expect.stringContaining('"used"') }),
    );

    // 2. The same removal passes for a server NOBODY is using.
    await handler({ type: "saveMcpServers", servers: { used: { command: "node" } } });
    expect(saveMcpServers).toHaveBeenCalledWith({ used: { command: "node" } });

    // 3. …and for the busy server once its session is IDLE (a change lands next turn, no loss).
    working.mockReturnValue(false);
    saveMcpServers.mockClear();
    await handler({ type: "saveMcpServers", servers: { idle: { command: "node" } } });
    expect(saveMcpServers).toHaveBeenCalledWith({ idle: { command: "node" } });
  });

  it("the brake also holds for a session with NO scope declared (that means every server is allowed)", async () => {
    // `undefined` is the LEGACY meaning: nothing restricted, so that session may be using this very
    // server right now. Reading `scope?.mcp.includes(…)` skipped it — the brake would have been
    // missing exactly where the risk is highest.
    const saveMcpServers = vi.fn(() => true);
    const { provider, registry } = buildHarness({
      providers: {
        getProvider: vi.fn(),
        saveModelSelection: vi.fn(),
        readMcpServers: vi.fn(() => ({ any: { command: "node" } })),
        saveMcpServers,
      } as unknown as ProviderCatalog,
    });
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    registry.get("s1")!.toolScope = undefined; // a session from before the feature
    vi.spyOn(provider as unknown as { isWorking: (id: string) => boolean }, "isWorking").mockReturnValue(true);

    await handler({ type: "saveMcpServers", servers: {} });
    expect(saveMcpServers).not.toHaveBeenCalled();
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mcpSaved", ok: false, reason: expect.stringContaining('"any"') }),
    );
  });

  it("a server removed from the config is dropped from the sessions that named it — and only those", async () => {
    // The read path already filters a vanished server, so behaviour is right without this; what is
    // pinned here is that the ROW stops carrying a decision about something that no longer exists,
    // without rewriting the sessions that never named it.
    let servers: Record<string, { command: string }> = { files: { command: "node" }, git: { command: "node" } };
    const store = memoryStore();
    const { provider, registry } = buildHarness({
      store,
      providers: {
        getProvider: vi.fn(),
        saveModelSelection: vi.fn(),
        readMcpServers: vi.fn(() => servers),
        saveMcpServers: vi.fn(() => true),
      } as unknown as ProviderCatalog,
    });
    const a = store.create("a");
    const b = store.create("b");
    store.saveSettings(a.id, { toolScope: { mcp: ["files", "git"], off: [], analyze: ["mcp__git__status"] } });
    store.saveSettings(b.id, { toolScope: { mcp: [], off: ["Shell"], analyze: [] } });

    // Session `a` is OPEN: the in-memory runtime must not keep the stale value either.
    provider.openSession(a.id);
    await vi.waitFor(() => expect(registry.get(a.id)).toBeDefined());

    servers = { files: { command: "node" } }; // `git` was uninstalled
    expect(provider.reconcileToolScopes()).toBe(1); // ONE row changed, not both
    // The declaration about the uninstalled server goes with it: it must not revive on reinstall.
    expect(store.summary(a.id)?.toolScope).toEqual({ mcp: ["files"], off: [], analyze: [] });
    expect(registry.get(a.id)?.toolScope).toEqual({ mcp: ["files"], off: [], analyze: [] });
    expect(store.summary(b.id)?.toolScope).toEqual({ mcp: [], off: ["Shell"], analyze: [] });

    // Running it again writes nothing: a config edit must not rewrite every session.
    expect(provider.reconcileToolScopes()).toBe(0);
  });

  it("setToolScope persists the SESSION's scope (not the config) and echoes it back", async () => {
    // Installing an MCP server is a machine fact (config.json); USING it is this conversation's
    // decision, so the write lands on the session row and the panel gets the host's truth back.
    const { provider, registry, store } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;

    await handler({ type: "setToolScope", scope: { mcp: ["files"], off: ["Shell"] } });

    expect(rt.toolScope).toEqual({ mcp: ["files"], off: ["Shell"], analyze: [] });
    expect(store.saveSettings).toHaveBeenCalledWith("s1", {
      toolScope: { mcp: ["files"], off: ["Shell"], analyze: [] },
    });
    // The panel learns it from the CONFIG push it already receives (one message, no ordering
    // hazard with the switch view).
    const configPosts = view.webview.postMessage.mock.calls.map((c) => c[0] as any).filter((m) => m.type === "config");
    expect(configPosts[configPosts.length - 1].config.toolScope).toEqual({
      mcp: ["files"],
      off: ["Shell"],
      analyze: [],
    });

    // Junk is normalized on the way in — the agent must never read a malformed scope.
    await handler({ type: "setToolScope", scope: { mcp: [" files "], off: "nope" } });
    expect(rt.toolScope).toEqual({ mcp: ["files"], off: [], analyze: [] });
  });

  it("the ⌘F keybinding's command opens find INSIDE the panel (the chord is ours, not VS Code's)", () => {
    // Inside a webview the key also reaches VS Code's own find, which opens its widget and takes
    // the focus out of the panel. The contributed keybinding (scoped to our view) runs this
    // command instead, and the panel puts the caret where you were typing.
    const { provider } = buildHarness({});
    const posted: unknown[] = [];
    (provider as unknown as { view: unknown }).view = {
      webview: { postMessage: (m: unknown) => (posted.push(m), Promise.resolve(true)) },
    };
    provider.openFind();
    expect(posted).toEqual([{ type: "openFind" }]);

    // …and with no view attached it is a no-op, not a crash (the command can fire before the
    // panel has ever been revealed).
    (provider as unknown as { view: unknown }).view = undefined;
    expect(() => provider.openFind()).not.toThrow();
  });

  it("the per-tool Analyze declaration is the SESSION's: two conversations can disagree", async () => {
    // `excludeTools` is what the MODEL must not see; the Analyze declaration is what THIS
    // conversation allows read-only — an INCLUDE list, because Analyze is denied by default. Both
    // live in the same row now, so the same tool can be allowed in one tab and refused in the next.
    const saveMcpServers = vi.fn(() => true);
    const mcp = {
      connect: vi.fn(async () => {}),
      getTools: () => [],
      getStatuses: () => [
        {
          name: "sqlite",
          ok: true,
          enabled: true,
          toolCount: 2,
          tools: [{ name: "read_query" }, { name: "drop_table" }],
        },
      ],
    } as any;
    const { provider, registry } = buildHarness({
      mcp,
      providers: {
        getProvider: vi.fn(),
        saveModelSelection: vi.fn(),
        readMcpServers: vi.fn(() => ({ sqlite: { command: "node", analyze: "trusted" } })),
        saveMcpServers,
      } as unknown as ProviderCatalog,
    });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    saveMcpServers.mockClear();

    await handler({
      type: "setMcpToolSelection",
      server: "sqlite",
      enabled: ["read_query", "drop_table"],
      // Deduplicated and trimmed by `strings`, then spelled with the sanitized prefix by the host.
      analyze: ["read_query", "read_query", ""],
    });
    expect(registry.get("s1")!.toolScope?.analyze).toEqual(["mcp__sqlite__read_query"]);
    expect(saveMcpServers).not.toHaveBeenCalled(); // the file keeps only its role as a SEED

    // Taking it back puts the tool in the empty state — the strict answer, not "allowed by default".
    await handler({ type: "setMcpToolSelection", server: "sqlite", enabled: ["read_query"], analyze: [] });
    expect(registry.get("s1")!.toolScope?.analyze).toEqual([]);
    // …and the OTHER tools of the server are untouched by a save that does not name them.
    expect(registry.get("s1")!.toolScope?.off).toEqual(["mcp__sqlite__drop_table"]);
  });

  it("the seed keys in the file are never written by the panel's Save", async () => {
    // `excludeTools` / `analyzeTools` mean "the default a NEW session starts from". A route that
    // wrote them would decide for every conversation — the exact bug this change removes — so the
    // file must come out of a save byte-identical.
    const saveMcpServers = vi.fn(() => true);
    const { provider } = buildHarness({
      mcp: {
        connect: vi.fn(async () => {}),
        getTools: () => [],
        getStatuses: () => [
          { name: "test", ok: true, enabled: true, toolCount: 1, tools: [{ name: "echo" }, { name: "ping" }] },
        ],
      } as any,
      providers: {
        getProvider: vi.fn(),
        saveModelSelection: vi.fn(),
        readMcpServers: vi.fn(() => ({
          test: { command: "node", excludeTools: ["ping"], analyzeTools: ["echo"] },
        })),
        saveMcpServers,
      } as unknown as ProviderCatalog,
    });
    const { handler } = resolveWith(provider);
    await provider.createNew();
    saveMcpServers.mockClear();

    await handler({ type: "setMcpToolSelection", server: "test", enabled: ["ping"], analyze: [] });
    expect(saveMcpServers).not.toHaveBeenCalled();
  });

  it("setMcpToolSelection ignores an unknown server and a scope-less session, and drops junk names", async () => {
    const saveMcpServers = vi.fn(() => true);
    const mcp = {
      connect: vi.fn(async () => {}),
      getTools: () => [],
      getStatuses: () => [
        {
          name: "test",
          ok: true,
          enabled: true,
          toolCount: 1,
          tools: [{ name: "a" }, { name: "b" }],
        },
      ],
    } as any;
    const { provider, registry } = buildHarness({
      mcp,
      providers: {
        getProvider: vi.fn(),
        saveModelSelection: vi.fn(),
        readMcpServers: vi.fn(() => ({ test: { command: "node" } })),
        saveMcpServers,
      } as unknown as ProviderCatalog,
    });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const before = registry.get("s1")!.toolScope;

    // A server nobody installed: nothing to decide, nothing written.
    await handler({ type: "setMcpToolSelection", server: "nope", enabled: ["a"], analyze: ["a"] });
    expect(registry.get("s1")!.toolScope).toEqual(before);

    // Junk in the payload is dropped, and a name the server does not offer is refused: a
    // declaration about a tool that is gone would revive on a rename.
    await handler({
      type: "setMcpToolSelection",
      server: "test",
      enabled: ["a", 42, "", null],
      analyze: ["a", 7, "  ", "ghost"],
    });
    expect(registry.get("s1")!.toolScope).toEqual({
      mcp: [], // the session was not using the server, and picking tools is not the switch
      off: ["mcp__test__b"],
      analyze: ["mcp__test__a"],
    });
    expect(saveMcpServers).not.toHaveBeenCalled();
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
    expect(msgs.some((m: any) => m.role === "assistant" && /Skills/.test(m.content) && m.content.includes("pdf"))).toBe(
      true,
    );
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
    const { store, agentConfig, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "gpt-4o", provider: undefined });
    // Temperature (default): the shared value lands on temperature, 0 is valid.
    await handler({ type: "setSamplerValue", value: 0 });
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { temperature: 0 });
    expect(agentConfig("s1")).toMatchObject({ temperature: 0 });

    // Switch to Top-P: mode persists AND both stored values reset to Auto.
    await handler({ type: "setSamplerMode", mode: "topP" });
    // temperature was set (0), so it is cleared to Auto in the same patch.
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { sampler: "topP", temperature: undefined });
    // Only the ACTIVE sampler carries a value. The session stopped overriding temperature,
    // so the derived config falls back to the CHAIN's value (that is what "Auto" means after
    // the session's own value is gone) and has no topP of its own yet.
    expect(agentConfig("s1").temperature).toBe(CONFIG.temperature);
    expect(agentConfig("s1")).not.toHaveProperty("topP");

    // Now the shared value lands on topP (0.9 valid on the 0–1 scale).
    await handler({ type: "setSamplerValue", value: 0.9 });
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { topP: 0.9 });
    const configPosts = view.webview.postMessage.mock.calls.map((c) => c[0] as any).filter((m) => m.type === "config");
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

  it("refuses to close the tab of a session that is still working", async () => {
    const { registry, provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    (rt.agent as { streaming: boolean }).streaming = true;

    await handler({ type: "closeTab", id: "s1" });

    // The runtime stays open: the close was refused (defense-in-depth; the UI
    // already disables the ×). Closing VS Code still kills everything.
    expect(registry.isOpen("s1")).toBe(true);
  });

  it("asks ONCE to switch to Build when Analyze prepared previews (with a restart tip)", async () => {
    const { registry, provider, store } = buildHarness({ emitEvents: true });
    const { view } = resolveWith(provider);
    await provider.createNew(); // s1 (active; Analyze by default)
    const rt = registry.get("s1")!;

    (rt.agent as unknown as { emit: (e: unknown) => void }).emit({ type: "preview_ready" });
    // Flush the auto-replied modal + the async mode switch.
    await new Promise((r) => setTimeout(r, 0));

    // The confirm modal is shown, with the sensible "restart the chat" tip.
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "modal",
        kind: "alert",
        alertKind: "confirm",
        title: "Switch to Build?",
        message: expect.stringContaining("restart the chat"),
      }),
    );
    // Confirmed (auto-reply true) → the session switched to Build AND persists it
    // (same single path as the mode toggle).
    expect(rt.mode).toBe("agent");
    expect((rt.agent as unknown as { setMode: ReturnType<typeof vi.fn> }).setMode).toHaveBeenCalledWith("agent");
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { mode: "agent" });
  });

  it("tags config pushes with a configSeq (stale-drop support)", async () => {
    const { provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew();
    view.webview.postMessage.mockClear();

    await handler({ type: "setMode", mode: "agent" });
    await new Promise((r) => setTimeout(r, 0));

    const configs = view.webview.postMessage.mock.calls
      .map((c: unknown[]) => c[0] as { type?: string; configSeq?: unknown })
      .filter((m) => m.type === "config");

    expect(configs.length).toBeGreaterThan(0);
    expect(configs.every((m) => typeof m.configSeq === "number")).toBe(true);
  });

  it("refreshConfig pushes config WITHOUT rebuilding the page (prompt preserved)", async () => {
    const { provider } = buildHarness();
    const { view } = resolveWith(provider);
    await provider.createNew();
    view.webview.html = "ORIGINAL";
    view.webview.postMessage.mockClear();

    provider.refreshConfig();
    await new Promise((r) => setTimeout(r, 0));

    // No full HTML rebuild: a typed prompt / scroll survive.
    expect(view.webview.html).toBe("ORIGINAL");
    expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "config" }));
  });

  it("pushConfig swallows a buildConfig failure (no unhandled rejection)", async () => {
    const { provider } = buildHarness();
    const { view } = resolveWith(provider);
    const p = provider as unknown as { buildConfig: () => Promise<unknown>; pushConfig: () => Promise<void> };
    p.buildConfig = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(p.pushConfig()).resolves.toBeUndefined();

    expect(view.webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "config" }));
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
      {
        id: "s1",
        name: "New Session",
        createdAt: 1,
        updatedAt: 2,
        messageCount: 2,
        model: "gpt-4o",
        outputTokens: 16384,
        maxParallelSubAgents: 6,
        loopGuard: "high",
        loopGuardResponse: true,
      },
    ]);
    (store.load as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === "s1"
        ? {
            summary: {
              id: "s1",
              name: "New Session",
              createdAt: 1,
              updatedAt: 2,
              messageCount: 2,
              model: "gpt-4o",
              outputTokens: 16384,
              maxParallelSubAgents: 6,
              loopGuard: "high",
              loopGuardResponse: true,
            },
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

  it("branchAt copies the transcript up to (and including) the given reply's TURN", async () => {
    const { store, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1 (active)
    const msgs = [
      { role: "user", content: "q1", timestamp: 1 },
      { role: "assistant", content: "a1", timestamp: 2 },
      { role: "user", content: "q2", timestamp: 3 },
      { role: "assistant", content: "a2", timestamp: 4 },
      { role: "user", content: "q3", timestamp: 5 },
      { role: "assistant", content: "a3", timestamp: 6 },
    ];
    (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "s1", name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 6, model: "gpt-4o" },
    ]);
    (store.load as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === "s1"
        ? {
            summary: { id: "s1", name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 6, model: "gpt-4o" },
            messages: msgs,
          }
        : { summary: { id, name: "S", createdAt: 1, updatedAt: 1, messageCount: 0 }, messages: [] },
    );
    state.autoName = "Branch copy";
    // Nothing is cut in the middle of a turn: the copy ends at the LAST message
    // of the clicked reply's group (q2 → a2), never inside it.
    await handler({ type: "branchAt", index: 3 });
    expect(store.create).toHaveBeenCalledWith("Branch copy");
    expect(store.saveMessages).toHaveBeenCalledWith("s2", [msgs[0], msgs[1], msgs[2], msgs[3]]);
    const switchPosts = view.webview.postMessage.mock.calls
      .map((c) => c[0] as any)
      .filter((m) => m.type === "switchView");
    expect(switchPosts[switchPosts.length - 1].activeId).toBe("s2");
  });

  it("branchAt on a reply that ALSO called tools copies the WHOLE turn (results + final answer)", async () => {
    const { store, provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1 (active)
    // The reply the user clicks ⎇ on carries text AND a tool call (a preamble):
    // copying "up to and including this reply" without the rest of the turn would
    // make a session that cannot send anything — the turn continues with the tool
    // results and the final answer.
    const msgs = [
      { role: "user", content: "q1", timestamp: 1 },
      {
        role: "assistant",
        content: "let me check",
        toolCalls: [{ id: "c1", name: "Shell", arguments: {} }],
        timestamp: 2,
      },
      { role: "tool", content: "out", toolCallId: "c1", timestamp: 3 },
      { role: "assistant", content: "all good", timestamp: 4 },
    ];
    (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "s1", name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 4, model: "gpt-4o" },
    ]);
    (store.load as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === "s1"
        ? {
            summary: { id: "s1", name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 4, model: "gpt-4o" },
            messages: msgs,
          }
        : { summary: { id, name: "S", createdAt: 1, updatedAt: 1, messageCount: 0 }, messages: [] },
    );
    state.autoName = "Branch copy";
    await handler({ type: "branchAt", index: 1 }); // the preamble of the turn
    expect(store.saveMessages).toHaveBeenCalledWith("s2", [msgs[0], msgs[1], msgs[2], msgs[3]]);
  });

  it("branchAt never copies a DAMAGED turn: the copy stops before it", async () => {
    const { store, provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1 (active)
    // A turn whose call was never answered (a history damaged before this fix):
    // copying it would create a session that cannot send anything, so the copy
    // stops at the last valid boundary instead.
    const msgs = [
      { role: "user", content: "q1", timestamp: 1 },
      { role: "assistant", content: "a1", timestamp: 2 },
      { role: "user", content: "q2", timestamp: 3 },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "Shell", arguments: {} }], timestamp: 4 },
      { role: "assistant", content: "interrupted", timestamp: 5 },
    ];
    (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "s1", name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 5, model: "gpt-4o" },
    ]);
    (store.load as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === "s1"
        ? {
            summary: { id: "s1", name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 5, model: "gpt-4o" },
            messages: msgs,
          }
        : { summary: { id, name: "S", createdAt: 1, updatedAt: 1, messageCount: 0 }, messages: [] },
    );
    state.autoName = "Branch copy";
    await handler({ type: "branchAt", index: 3 });
    // The damaged group (q2 → …) is left out entirely: what is copied is the last
    // COMPLETE turn (q1 → a1).
    expect(store.saveMessages).toHaveBeenCalledWith("s2", [msgs[0], msgs[1]]);
  });

  it("branchAt ignores out-of-range or invalid indexes", async () => {
    const { store, provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    (store.load as ReturnType<typeof vi.fn>).mockReturnValue({
      summary: { id: "s1", name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 2 },
      messages: [
        { role: "user", content: "q", timestamp: 1 },
        { role: "assistant", content: "a", timestamp: 2 },
      ],
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
    expect(store.saveMessages).toHaveBeenCalledWith("s1", kept, { replace: true });
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
    rt.history.replace([
      { role: "user", content: "q", timestamp: 1 },
      { role: "assistant", content: "a", timestamp: 2 },
    ]);

    await handler({ type: "truncateAt", index: 0 });

    expect(store.saveMessages).toHaveBeenCalledWith("s1", [], { replace: true });
    expect(rt.history.all()).toEqual([]);
  });

  it("refuses to cut while the session is working", async () => {
    const { store, registry, provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.history.replace([
      { role: "user", content: "q", timestamp: 1 },
      { role: "assistant", content: "a", timestamp: 2 },
    ]);
    (rt.agent as { streaming: boolean }).streaming = true;

    await handler({ type: "truncateAt", index: 1 });

    expect(store.saveMessages).not.toHaveBeenCalled();
  });

  it("truncateAt ignores out-of-range or invalid indexes", async () => {
    const { store, registry, provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.history.replace([
      { role: "user", content: "q", timestamp: 1 },
      { role: "assistant", content: "a", timestamp: 2 },
    ]);

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
      expect.objectContaining({
        type: "modal",
        kind: "alert",
        alertKind: "error",
        message: expect.stringContaining("already exists"),
      }),
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
      expect.objectContaining({
        type: "modal",
        kind: "alert",
        alertKind: "error",
        message: expect.stringContaining("already exists"),
      }),
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
      expect.objectContaining({
        type: "modal",
        kind: "alert",
        alertKind: "error",
        message: expect.stringContaining("already exists"),
      }),
    );
  });

  it("usage events update the session context tokens and persist them", async () => {
    const { store, registry, provider } = buildHarness({ emitEvents: true });
    void resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    (rt.agent as any).emit({ type: "usage", usage: { input: 50, output: 4, total: 54 } });
    expect(rt.contextTokens).toBe(50); // in memory at once: that is what the UI reads

    // NOT on every report: the write is coalesced (see persistContextTokensSoon), and
    // closing the tab is one of the moments that flushes it while `rt` still exists.
    await provider.closeTab("s1");
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { contextTokens: 50 });
  });

  it("coalesces the token metric: a burst of usage reports costs ONE write, of the LAST value", async () => {
    const { store, registry, provider } = buildHarness({ emitEvents: true });
    void resolveWith(provider);
    await provider.createNew(); // s1
    store.saveSettings.mockClear();
    const rt = registry.get("s1")!;
    const tokenWrites = () => store.saveSettings.mock.calls.filter(([, patch]) => "contextTokens" in (patch as object));

    for (const input of [100, 200, 300]) {
      (rt.agent as any).emit({ type: "usage", usage: { input, output: 1, total: input + 1 } });
    }
    expect(rt.contextTokens).toBe(300);
    expect(tokenWrites()).toEqual([]); // no transaction per turn

    await vi.waitFor(() => expect(tokenWrites()).toEqual([["s1", { contextTokens: 300 }]]), { timeout: 3000 });
  });

  it("dispose() flushes the last metric, so nothing is lost when the panel goes away", async () => {
    const { store, registry, provider } = buildHarness({ emitEvents: true });
    void resolveWith(provider);
    await provider.createNew(); // s1
    store.saveSettings.mockClear();
    const rt = registry.get("s1")!;
    (rt.agent as any).emit({ type: "usage", usage: { input: 77, output: 2, total: 79 } });

    provider.dispose();
    expect(store.saveSettings).toHaveBeenCalledWith("s1", { contextTokens: 77 });
  });

  it("setModel with a named provider applies its overrides", async () => {
    const { provider, agentConfig } = buildHarness({
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
    // The config THIS session's agent reads at the next turn.
    expect(agentConfig("s1")).toMatchObject({
      activeProvider: "opencode-go",
      baseUrl: "https://x/v1",
      maxTokens: 123,
      thinkingMode: "effort",
      availableModels: ["m1"],
    });
  });

  it("setModel defaults thinking to medium on reasoning-capable providers", async () => {
    const { provider, agentConfig, store } = buildHarness({
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
    expect(agentConfig("s1")).toMatchObject({ thinkingLevel: "medium" });
  });

  it("setModel keeps an explicit session thinking level (no default overwrite)", async () => {
    const { provider, agentConfig, store } = buildHarness({
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
    expect(agentConfig("s2")).toMatchObject({ thinkingLevel: "high" });
    expect(store.saveSettings).not.toHaveBeenCalledWith(
      "s2",
      expect.objectContaining({ model: "m1", thinkingLevel: "medium" }),
    );
  });

  it("setModel on a provider without reasoning leaves no thinking default", async () => {
    const { provider, agentConfig, store } = buildHarness({
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
    // `thinkingLevel: undefined` DELETES the key: a non-reasoning provider must not
    // receive a stale level (it would be sent as an unsupported param).
    expect(agentConfig("s1")).toMatchObject({ thinkingMode: "unspecified" });
    expect(agentConfig("s1")).not.toHaveProperty("thinkingLevel");
    expect(store.saveSettings).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ model: "m1", modelProvider: "plain" }),
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
    const configPosts = view.webview.postMessage.mock.calls.map((c) => c[0] as any).filter((m) => m.type === "config");
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
      providerEntry: {
        name: "opencode-go",
        baseUrl: "https://declared/v1",
        apiKey: "k",
        models: [{ id: "stale-declared" }],
      },
      fetchModels,
    });
    const { handler, view } = resolveWith(provider);
    await handler({ type: "getConfig" });
    const configPosts = view.webview.postMessage.mock.calls.map((c) => c[0] as any).filter((m) => m.type === "config");
    const cfg = configPosts[configPosts.length - 1].config;
    // The stale declared list is NOT shown: only the fetched live lists are.
    expect(cfg.providerModels).not.toContainEqual({ provider: "opencode-go", model: "stale-declared" });
    expect(cfg.providerModels).toContainEqual({ provider: "opencode-go", model: "d1" });
    // The DECLARED provider got fetched like any other (before the fix it was
    // never fetched: only hostModelProviders were).
    expect(fetchModels).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "https://declared/v1" }));
  });

  it("buildConfig reports a red error for a provider without baseUrl", async () => {
    const { provider } = buildHarness({
      config: { ...CONFIG, hostModelProviders: ["no-base"] },
      providerEntry: undefined, // getProvider returns nothing
      fetchModels: vi.fn(async () => []),
    });
    const { handler, view } = resolveWith(provider);
    await handler({ type: "getConfig" });
    const configPosts = view.webview.postMessage.mock.calls.map((c) => c[0] as any).filter((m) => m.type === "config");
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
    await handler({
      type: "saveProviders",
      data: { activeProvider: "x", providers: { x: { baseUrl: "http://x/v1" } } },
    });
    expect(saveProvidersEditor).toHaveBeenCalledWith({
      activeProvider: "x",
      providers: { x: { baseUrl: "http://x/v1" } },
    });
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "providersSaved", ok: true }),
    );
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
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "providersSaved", ok: false }),
    );
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
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "providersExported", ok: true }),
    );
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
      providers: {
        getProvider: vi.fn(),
        saveModelSelection: vi.fn(),
        importProviders,
        readProvidersEditor,
      } as unknown as ProviderCatalog,
    });
    const { handler, view } = resolveWith(provider);
    state.showOpenDialog.mockResolvedValue([{ fsPath: "/tmp/in.json" }]);
    state.fsReadFile.mockResolvedValue(new TextEncoder().encode('{"providers":{"a":{"baseUrl":"http://a/v1"}}}'));
    await handler({ type: "importProviders" });
    expect(importProviders).toHaveBeenCalledWith(expect.anything(), "merge");
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "providersImported", ok: true }),
    );
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
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "providersImported", ok: false }),
    );
  });

  it("testProvider fetches live models and posts the outcome", async () => {
    const fetchModels = vi.fn(async () => ["m1", "m2"]);
    const { provider } = buildHarness({ fetchModels });
    const { handler, view } = resolveWith(provider);
    await handler({ type: "testProvider", data: { baseUrl: "http://localhost:8090/v1", apiKey: "k" } });
    expect(fetchModels).toHaveBeenCalledWith({ baseUrl: "http://localhost:8090/v1", apiKey: "k" });
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "providersTested", ok: true, models: ["m1", "m2"] }),
    );
  });

  it("testProvider failure posts the error", async () => {
    const { provider } = buildHarness({
      fetchModels: vi.fn(async () => {
        throw new Error("HTTP 500");
      }),
    });
    const { handler, view } = resolveWith(provider);
    await handler({ type: "testProvider", data: { baseUrl: "http://x/v1" } });
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "providersTested", ok: false, error: "HTTP 500" }),
    );
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
    expect(statusPosts).toContainEqual(expect.objectContaining({ type: "status", workingIds: ["s1"] }));
  });

  it("abort while streaming posts an interrupted notice and persists it as uiOnly", async () => {
    const { registry, provider } = buildHarness();
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    (rt.agent as { streaming: boolean }).streaming = true;
    await handler({ type: "abort" });
    expect(rt.agent.abort).toHaveBeenCalled();
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "interrupted" });
    // Stored (so it survives a reload and shows in the transcript) but uiOnly, so
    // it is NOT part of the request. This is the fix for a wedged session: an
    // assistant message written here sits between a turn's `tool_calls` and its
    // results — the agent appends the two together at its own pace — and every
    // provider then rejects every later request with a 400.
    const notice = rt.history.all().find((m) => /Processing interrupted/.test(m.content ?? ""));
    expect(notice).toBeTruthy();
    expect(notice!.uiOnly).toBe(true);
    // The model still learns about the interruption: from the aborted tool
    // results, which are what the provider actually sees.
    expect(rt.history.conversation().some((m) => /Processing interrupted/.test(m.content ?? ""))).toBe(false);
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
  it("setModel stores and persists the selection on the active session", async () => {
    const { store, registry, provider } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "gemma.gguf", provider: "llamacpp" });

    const rt = registry.get("s1")!;
    expect(rt.model).toBe("gemma.gguf");
    expect(rt.modelProvider).toBe("llamacpp");
    expect(store.saveSettings).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ model: "gemma.gguf", modelProvider: "llamacpp" }),
    );
  });

  it("setModel carries the stable session id + the provider's declared session/static headers into the runtime config", async () => {
    const { provider, agentConfig } = buildHarness({
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
    expect(agentConfig("s1")).toMatchObject({
      // Not `expect.any(String)`: the id must be THIS session's, which is exactly what
      // the old shared layer could not promise (it held whichever tab was visible).
      sessionId: "s1",
      sessionHeader: "x-opencode-session",
      extraHeaders: { "X-Origin": "harny" },
    });
  });

  it("gives every session its OWN override layer: a switch never rewrites another session's config", async () => {
    const { registry, provider, agentConfig } = buildHarness();
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1: no model
    // A session with no model leaves its layer EMPTY: the config chain owns everything.
    expect(agentConfig("s1")).toEqual(CONFIG);

    registry.create(); // s2
    await handler({ type: "switchTab", id: "s2" }); // s2 active, no model
    await handler({ type: "setModel", model: "deepseek-v4-pro", provider: "opencode-go" }); // on s2
    expect(registry.get("s2")!.model).toBe("deepseek-v4-pro");
    expect(agentConfig("s2")).toMatchObject({ model: "deepseek-v4-pro" });

    // THE REGRESSION: switching away must not touch s2. The layer used to be one
    // shared object, so activating a session with no model CLEARED it — and the
    // next turn of a run in s2 went out with the config file's model and no
    // `x-opencode-session` (400 MissingSessionID), or, switching to another
    // session WITH a model, under that session's model and id.
    await handler({ type: "switchTab", id: "s1" });
    expect(agentConfig("s2")).toMatchObject({ model: "deepseek-v4-pro", sessionId: "s2" });
    expect(agentConfig("s1")).toEqual(CONFIG);

    // …and switching back re-derives s2 from its own runtime, unchanged.
    await handler({ type: "switchTab", id: "s2" });
    expect(agentConfig("s2")).toMatchObject({ model: "deepseek-v4-pro", sessionId: "s2" });
  });

  it("opening a NEW session never touches an OPEN session's request identity (the MissingSessionID bug)", async () => {
    const { registry, provider, agentConfig } = buildHarness({
      providerEntry: {
        name: "opencode-go",
        baseUrl: "https://opencode.ai/go/v1",
        apiKey: "go-key",
        sessionHeader: "x-opencode-session",
        models: [{ id: "deepseek-v4-pro" }],
      } as any,
    });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "deepseek-v4-pro", provider: "opencode-go" });
    const before = agentConfig("s1");
    expect(before).toMatchObject({
      sessionId: "s1",
      sessionHeader: "x-opencode-session",
      model: "deepseek-v4-pro",
    });

    // The reported bug, exactly: a session is RUNNING (it reads its config at every
    // turn) and the user opens a new one. The runtime layer used to be one shared
    // object, and activating a session with no model CLEARED it — so the running
    // session's next request went out with the config-file model and NO
    // `x-opencode-session` (OpenCode Go: 400 MissingSessionID). Reopening the session
    // restored the layer, which is why it "worked again" after a close and a reopen.
    await provider.createNew(); // s2: brand new, no model
    expect(agentConfig("s1")).toEqual(before);
    expect(agentConfig("s2")).toEqual(CONFIG);
  });

  it("keeps two sessions' models apart, whichever tab is visible", async () => {
    const { registry, provider, agentConfig } = buildHarness({
      providerEntry: { name: "p", baseUrl: "https://x/v1", models: [{ id: "m1" }, { id: "m2" }] },
    });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "m1", provider: "p" });
    await provider.createNew(); // s2 (now active)
    await handler({ type: "setModel", model: "m2", provider: "p" });

    // Switching to a session WITH a model used to write ITS model into the shared
    // layer, so the other session's next turn silently ran on the wrong model (and
    // under the wrong session id) — valid, accepted, and wrong.
    await handler({ type: "switchTab", id: "s1" });
    expect(agentConfig("s1")).toMatchObject({ model: "m1", sessionId: "s1" });
    expect(agentConfig("s2")).toMatchObject({ model: "m2", sessionId: "s2" });
    await handler({ type: "switchTab", id: "s2" });
    expect(agentConfig("s1")).toMatchObject({ model: "m1", sessionId: "s1" });
    expect(agentConfig("s2")).toMatchObject({ model: "m2", sessionId: "s2" });
    expect(agentConfig("s1")).not.toEqual(agentConfig("s2"));
  });

  it("closing a tab leaves the OTHER session's config untouched, and repairs the next active one", async () => {
    // The reported sequence also included CLOSING/DELETING sessions while a run was going.
    // Two things must hold: the surviving session keeps its layer, and the session that
    // becomes active is DERIVED (the removal path changes the active id without a
    // setActive() call, so nothing else would re-derive it).
    const { registry, provider, agentConfig } = buildHarness({
      providerEntry: { name: "p", baseUrl: "https://x/v1", models: [{ id: "m1" }, { id: "m2" }] },
    });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "m1", provider: "p" });
    await provider.createNew(); // s2 (active)
    await handler({ type: "setModel", model: "m2", provider: "p" });
    const s1Before = agentConfig("s1");

    // Close the tab that is ACTIVE: s1 becomes active again, and its config must be its
    // own — derived, so there is nothing to inherit or to re-derive.
    await handler({ type: "closeTab", id: "s2" });

    expect(registry.get("s2")).toBeUndefined();
    expect(agentConfig("s1")).toEqual(s1Before);
    expect(agentConfig("s1")).toMatchObject({ model: "m1", sessionId: "s1" });
  });

  it("deleting a session does not touch the one that is running", async () => {
    const { registry, provider, agentConfig } = buildHarness({
      providerEntry: { name: "p", baseUrl: "https://x/v1", models: [{ id: "m1" }] },
    });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1: the one that keeps working
    await handler({ type: "setModel", model: "m1", provider: "p" });
    const running = agentConfig("s1");
    await provider.createNew(); // s2: the one that gets deleted
    await provider.createNew(); // s3

    await handler({ type: "closeTab", id: "s2" });
    expect(agentConfig("s1")).toEqual(running);
    expect(registry.isOpen("s2")).toBe(false);
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
      summary: {
        id: "s9",
        name: "S",
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
        model: "gpt-4o",
        outputTokens: 16384,
      },
      messages: [],
    });
    await handler({ type: "openSession", id: "s9" });
    await handler({ type: "switchTab", id: "s9" }); // makes it the active runtime
    await handler({ type: "getConfig" });
    const configPosts = view.webview.postMessage.mock.calls.map((c) => c[0] as any).filter((m) => m.type === "config");
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
    const configPosts = view.webview.postMessage.mock.calls.map((c) => c[0] as any).filter((m) => m.type === "config");
    expect(configPosts[configPosts.length - 1].config.temperature).toBe(0.3);
  });
});

describe("ChatViewProvider all-sessions manager", () => {
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
      {
        id: "x",
        name: "Local",
        createdAt: 1,
        updatedAt: 2,
        messageCount: 0,
        folder: "/home/me/a",
        folderMissing: false,
      },
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
    expect(view.webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "sessionsManager" }));
  });

  it("sessionsManagerOpenFolder opens the session's folder in VS Code (no picker)", async () => {
    const { store, provider } = buildHarness({ currentFolder: () => "/home/me/a" });
    (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "x", name: "X", createdAt: 1, updatedAt: 2, messageCount: 0, folder: "/home/me/b", folderMissing: false },
    ]);
    const { handler } = resolveWith(provider);
    await handler({ type: "sessionsManagerOpenFolder", id: "x" });
    expect(state.executeCommand).toHaveBeenCalledWith(
      "vscode.openFolder",
      { fsPath: "/home/me/b" },
      {
        forceReuseWindow: true,
      },
    );
    expect(state.showOpenDialog).not.toHaveBeenCalled();
  });

  it("sessionsManagerOpenFolder forwards Windows and POSIX paths verbatim", async () => {
    const { store, provider } = buildHarness({ currentFolder: () => "C:\\Users\\Me\\A" });
    (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        id: "w",
        name: "W",
        createdAt: 1,
        updatedAt: 2,
        messageCount: 0,
        folder: "C:\\Users\\Me\\B",
        folderMissing: false,
      },
      { id: "p", name: "P", createdAt: 1, updatedAt: 1, messageCount: 0, folder: "/home/me/b", folderMissing: false },
    ]);
    const { handler } = resolveWith(provider);
    await handler({ type: "sessionsManagerOpenFolder", id: "w" });
    expect(state.executeCommand).toHaveBeenLastCalledWith(
      "vscode.openFolder",
      { fsPath: "C:\\Users\\Me\\B" },
      {
        forceReuseWindow: true,
      },
    );
    await handler({ type: "sessionsManagerOpenFolder", id: "p" });
    expect(state.executeCommand).toHaveBeenLastCalledWith(
      "vscode.openFolder",
      { fsPath: "/home/me/b" },
      {
        forceReuseWindow: true,
      },
    );
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

  it("lists an OPEN session of ANOTHER folder too, marked (a tab must never be orphaned)", async () => {
    // The list is the only navigation surface: hiding an open session from it leaves a
    // tab you cannot get back to once you close it — and an empty list next to an open
    // tab reads as "no sessions yet", which is simply false. Switching the workspace
    // folder and the cross-folder Manage form both make it reachable.
    const { store, registry, provider } = buildHarness({ currentFolder: () => "/home/me/a" });
    const local = {
      id: "a1",
      name: "Local",
      createdAt: 1,
      updatedAt: 3,
      messageCount: 0,
      folder: "/home/me/a",
      folderMissing: false,
    };
    const foreign = {
      id: "b1",
      name: "Elsewhere",
      createdAt: 1,
      updatedAt: 2,
      messageCount: 0,
      folder: "/home/me/b",
      folderMissing: false,
    };
    (store.list as ReturnType<typeof vi.fn>).mockReturnValue([local, foreign]);
    const { handler, view } = resolveWith(provider);

    // Nothing open yet: the list is the folder's alone.
    await vi.waitFor(() => expect(view.webview.html).not.toContain('"name":"Elsewhere"'), { timeout: 2000 });

    await handler({ type: "openSession", id: "b1" });
    expect(registry.listOpenIds()).toContain("b1");

    // Now it is open, so it travels with the list — and says it is not from here.
    await vi.waitFor(
      () => {
        const sw = view.webview.postMessage.mock.calls
          .map((c) => c[0])
          .filter((m: any) => m?.type === "switchView" && Array.isArray(m.sessions))
          .slice(-1)[0];
        expect(sw?.sessions).toContainEqual(expect.objectContaining({ id: "b1", foreign: true }));
      },
      { timeout: 2000 },
    );
    const last = view.webview.postMessage.mock.calls
      .map((c) => c[0])
      .filter((m: any) => m?.type === "switchView" && Array.isArray(m.sessions))
      .slice(-1)[0];
    // The folder's own session is NOT marked.
    expect(last.sessions).toContainEqual(expect.objectContaining({ id: "a1" }));
    expect(last.sessions.find((s: any) => s.id === "a1").foreign).toBeUndefined();
  });

  it("still scopes NAME uniqueness to the folder (a foreign session is navigation, not a neighbour)", async () => {
    const { store, registry, provider } = buildHarness({ currentFolder: () => "/home/me/a" });
    (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        id: "b1",
        name: "Shared",
        createdAt: 1,
        updatedAt: 2,
        messageCount: 0,
        folder: "/home/me/b",
        folderMissing: false,
      },
    ]);
    const { handler, view } = resolveWith(provider);
    const before = registry.listOpenIds().length;
    view.webview.postMessage.mockClear();

    // Creating a session named like another folder's is allowed: uniqueness is scoped to
    // THIS folder, where nobody carries that name. The name arrives from the naming modal
    // and the message is the one the panel really sends: a hand-made `{type:"createNew"}`
    // matched no `case` in the dispatcher, so the flow never ran and this test was green
    // for the wrong reason.
    state.autoName = "Shared";
    await handler({ type: "newSession" });

    expect(view.webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Name already in use" }),
    );
    // The point of the assertion above: the session was actually created.
    expect(registry.listOpenIds().length).toBe(before + 1);
  });

  it("the MAIN sessions list shows only the current folder's sessions", async () => {
    const { store, provider } = buildHarness({ currentFolder: () => "/home/me/a" });
    (store.list as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        id: "a",
        name: "Local",
        createdAt: 1,
        updatedAt: 3,
        messageCount: 0,
        folder: "/home/me/a",
        folderMissing: false,
      },
      {
        id: "b",
        name: "Foreign",
        createdAt: 1,
        updatedAt: 2,
        messageCount: 0,
        folder: "/home/me/b",
        folderMissing: false,
      },
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
    const options = { compactor: new Compactor(compactorFactory()), compaction: DEFAULT_COMPACTION };
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
    expect(store.saveSettings as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    // A compaction REBUILDS the history: the store must be told to REPLACE
    // (the rebuilt history can have the same length as the old one).
    expect(store.saveMessages).toHaveBeenCalledWith("s1", expect.any(Array), { replace: true });
    // stale cache hits from the pre-compaction turn are reset (no >100% ratio)
    expect(rt.cachedTokens).toBe(0);
    // final bubble posted (the UI shows completion, no toast needed)
    expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "refresh" }));
  });

  it("a SECOND compaction UPDATES the previous state instead of re-deriving it", async () => {
    // The failure mode on long sessions: summarize a summary, generation after
    // generation, losing a fact each time. The state the first compaction left behind
    // is passed as such — and its own messages are NOT re-summarized (they carry no
    // new information).
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\ncarried");
    const options = { compactor: { summarize } as unknown as Compactor, compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.contextWindow = 200000;
    const state = "## Goal\nship the parser\n## Facts\nsrc/parser.ts is the entry point";
    rt.history.replace([
      // What a previous compaction left: the synthetic pair.
      { role: "user", content: "Summary of past interactions", timestamp: 1, synthetic: true },
      { role: "assistant", content: state, timestamp: 2, synthetic: true },
      // …plus the work done since (enough of it that the span is not just the pair).
      { role: "user", content: "now add the lexer", timestamp: 3 },
      { role: "assistant", content: "adding it", timestamp: 4 },
      { role: "user", content: "and the tests", timestamp: 5 },
      { role: "assistant", content: "writing them", timestamp: 6 },
      { role: "user", content: "run them", timestamp: 7 },
      { role: "assistant", content: "all green", timestamp: 8 },
    ]);

    await handler({ type: "compact" });

    expect(summarize).toHaveBeenCalledTimes(1);
    const [span, previousState] = summarize.mock.calls[0] as unknown as [ChatMessage[], string];
    // The state is handed over AS the state…
    expect(previousState).toBe(state);
    // …and it is NOT part of the span to summarize again.
    expect(span.some((m) => m.synthetic)).toBe(false);
    expect(span.some((m) => m.content === state)).toBe(false);
    expect(span.some((m) => m.content === "now add the lexer")).toBe(true);
    // The new history still starts with a synthetic pair carrying the new state.
    const conv = registry.get("s1")!.history.conversation();
    expect(conv[0].synthetic).toBe(true);
    expect(conv[1].synthetic).toBe(true);
  });

  it("compacts a SUB-AGENT's ephemeral history with the session's strategy (and adopts a stated limit)", async () => {
    // The sub-agent's history belongs to its runner and is never stored: the host
    // compacts THAT array and answers whether it changed anything, using the same
    // routine the session uses.
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\nsub work\n## Facts\na.ts");
    const { provider, registry, store } = buildHarness({
      compactor: { summarize } as unknown as Compactor,
      compaction: DEFAULT_COMPACTION,
    });
    resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.contextWindow = 200_000;
    // The sub-agent's own history: enough turns that the planner has a span to cut.
    const subHistory = {
      messages: [
        { role: "user", content: "task", timestamp: 1 },
        { role: "assistant", content: "read a.ts", timestamp: 2 },
        { role: "user", content: "more", timestamp: 3 },
        { role: "assistant", content: "read b.ts", timestamp: 4 },
        { role: "user", content: "more", timestamp: 5 },
        { role: "assistant", content: "read c.ts", timestamp: 6 },
        { role: "user", content: "more", timestamp: 7 },
        { role: "assistant", content: "done", timestamp: 8 },
      ] as ChatMessage[],
      conversation(): ChatMessage[] {
        return this.messages;
      },
      replace(next: ChatMessage[]): void {
        this.messages = next;
      },
    };
    store.saveMessages.mockClear();

    const compacted = await provider.compactSubAgentHistory(subHistory as never, "s1", undefined, {
      limitTokens: 32_000,
    } as never);

    expect(compacted).toBe(true);
    // The ephemeral history was rewritten in place: a synthetic pair + the kept tail.
    expect(subHistory.messages[0].synthetic).toBe(true);
    expect(String(subHistory.messages[1].content)).toContain("sub work");
    // Nothing is PERSISTED: a sub-agent's history is not a session transcript.
    expect(store.saveMessages).not.toHaveBeenCalled();
    // The stated limit is the same model as the session, so the session adopts it.
    // (32k, not 8k: the summary request carries its OWN output budget of 8192
    // tokens, so on an 8k window it could never be SENT — the compaction would
    // have to trim instead, which is a different test.)
    expect(rt.contextWindow).toBe(32_000);
  });

  it("compacts a sub-agent proactively when its OWN history crosses the threshold", async () => {
    // Same threshold as the session (ONE implementation, `needsCompact`), so a sub-agent
    // frees room at a turn boundary instead of learning it from a refusal.
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\nsub");
    const { provider, registry } = buildHarness({
      compactor: { summarize } as unknown as Compactor,
      compaction: DEFAULT_COMPACTION,
    });
    resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.contextWindow = 8_192; // tiny: a few messages are already past the threshold
    // The REAL history implementation, not a stub: the contract being checked is
    // that the WINDOW starts at the new checkpoint, which only `conversation()`
    // knows — a stub returning every message could not test it.
    const sub = new InMemoryChatHistory();
    // Decisively over any threshold: the point is the DECISION, not the arithmetic.
    for (let i = 0; i < 40; i++) {
      sub.add({ role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(4_000), timestamp: i + 1 });
    }

    expect(await provider.maybeCompactSubAgentHistory(sub, "s1")).toBe(true);
    // A small window and a ~40k-token history: the span is far past what the
    // summarizer could READ, so the window moves WITHOUT one — and the history it
    // moved past is still there (a sub-agent's is ephemeral, but the rule is one).
    expect(sub.conversation()[0].synthetic).toBe(true);
    expect(sub.all().length).toBeGreaterThan(sub.conversation().length);

    // And the SAME history that fits is left alone (no compaction for nothing).
    rt.contextWindow = 1_000_000;
    summarize.mockClear();
    expect(await provider.maybeCompactSubAgentHistory(sub, "s1")).toBe(false);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("says no when a sub-agent's history has nothing worth summarizing", async () => {
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\nx");
    const { provider } = buildHarness({
      compactor: { summarize } as unknown as Compactor,
      compaction: DEFAULT_COMPACTION,
    });
    resolveWith(provider);
    await provider.createNew();
    const short = {
      messages: [{ role: "user", content: "hi", timestamp: 1 }] as ChatMessage[],
      conversation(): ChatMessage[] {
        return this.messages;
      },
      replace(): void {},
    };

    expect(await provider.compactSubAgentHistory(short as never, "s1")).toBe(false);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("a FIRST compaction has no state to carry", async () => {
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\nx");
    const options = { compactor: { summarize } as unknown as Compactor, compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    const { handler } = resolveWith(provider);
    await provider.createNew();
    const rt = registry.get("s1")!;
    rt.contextWindow = 200000;
    rt.history.replace([
      { role: "user", content: "hi", timestamp: 1 },
      { role: "assistant", content: "ok", timestamp: 2 },
      { role: "user", content: "go", timestamp: 3 },
      { role: "assistant", content: "done", timestamp: 4 },
      { role: "user", content: "more", timestamp: 5 },
      { role: "assistant", content: "still here", timestamp: 6 },
      { role: "user", content: "last", timestamp: 7 },
      { role: "assistant", content: "finished", timestamp: 8 },
    ]);

    await handler({ type: "compact" });

    const [, previousState] = summarize.mock.calls[0] as unknown as [ChatMessage[], string | undefined];
    expect(previousState).toBeUndefined();
  });

  // ── The checkpoint: the summary stays IN the session, and the window starts
  // from it. Everything below is about NOT losing the past while keeping the
  // request small. ──

  const EIGHT_TURNS: ChatMessage[] = [
    { role: "user", content: "first question", timestamp: 1 },
    { role: "assistant", content: "first answer", timestamp: 2 },
    { role: "user", content: "second question", timestamp: 3 },
    { role: "assistant", content: "second answer", timestamp: 4 },
    { role: "user", content: "third question", timestamp: 5 },
    { role: "assistant", content: "third answer", timestamp: 6 },
    { role: "user", content: "fourth question", timestamp: 7 },
    { role: "assistant", content: "fourth answer", timestamp: 8 },
  ];

  it("KEEPS the summarized span in the session, and starts the window at the checkpoint", async () => {
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\ncarried");
    const options = { compactor: { summarize } as unknown as Compactor, compaction: DEFAULT_COMPACTION };
    const { store, registry, provider } = buildHarness(options);
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.contextWindow = 200_000;
    rt.history.replace([...EIGHT_TURNS]);

    await handler({ type: "compact" });

    const all = rt.history.all();
    const conv = rt.history.conversation();

    // The summarized span is still IN the session — nothing was thrown away…
    expect(all.some((m) => m.content === "first question")).toBe(true);
    expect(all.length).toBeGreaterThan(conv.length);
    // …the window BEGINS at the checkpoint…
    expect(conv[0].synthetic).toBe(true);
    expect(conv[1].synthetic).toBe(true);
    expect(conv.some((m) => m.content === "first question")).toBe(false);
    // …and what gets PERSISTED is the whole thing, past included.
    const saved = (store.saveMessages as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as ChatMessage[];
    expect(saved).toHaveLength(all.length);
    expect(saved.some((m) => m.content === "first question")).toBe(true);
  });

  it("a SECOND compaction folds the previous checkpoint in, and keeps the OLDER past", async () => {
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\nnew");
    const options = { compactor: { summarize } as unknown as Compactor, compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.contextWindow = 200_000;
    rt.history.replace([
      { role: "user", content: "ancient question", timestamp: 1 },
      { role: "assistant", content: "ancient answer", timestamp: 2 },
      { role: "user", content: "Riepilogo", timestamp: 3, synthetic: true },
      { role: "assistant", content: "old state", timestamp: 4, synthetic: true },
      { role: "user", content: "lavoro 1", timestamp: 5 },
      { role: "assistant", content: "done 1", timestamp: 6 },
      { role: "user", content: "lavoro 2", timestamp: 7 },
      { role: "assistant", content: "done 2", timestamp: 8 },
      { role: "user", content: "lavoro 3", timestamp: 9 },
      { role: "assistant", content: "done 3", timestamp: 10 },
    ]);

    await handler({ type: "compact" });

    const all = rt.history.all();
    // The past that sat BEFORE the previous checkpoint survives…
    expect(all.some((m) => m.content === "ancient question")).toBe(true);
    // …the previous pair is ABSORBED, never duplicated…
    expect(all.filter((m) => m.synthetic)).toHaveLength(2);
    expect(all.some((m) => m.content === "old state")).toBe(false);
    // …and the window starts from the NEW checkpoint, the old past still excluded.
    const conv = rt.history.conversation();
    expect(conv[0].synthetic).toBe(true);
    expect(conv[1].content).toContain("new");
    expect(conv.some((m) => m.content === "ancient question")).toBe(false);
  });

  it("the preserved past is NOT counted: only the active window is measured", async () => {
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\nx");
    const options = { compactor: { summarize } as unknown as Compactor, compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.history.replace([
      { role: "user", content: "P".repeat(120_000), timestamp: 1 },
      { role: "assistant", content: "Q".repeat(120_000), timestamp: 2 },
      { role: "user", content: "Riepilogo", timestamp: 3, synthetic: true },
      { role: "assistant", content: "## Goal\nx", timestamp: 4, synthetic: true },
      { role: "user", content: "short", timestamp: 5 },
    ]);

    // The SESSION is big…
    expect(estimateContextTokens(rt.history.all())).toBeGreaterThan(50_000);
    // …but the WINDOW is small: the past is not sent, so it must not be counted.
    // (This is what keeps the threshold from firing forever on a long session.)
    expect(estimateContextTokens(rt.history.conversation())).toBeLessThan(500);
  });

  it("a ✂ cut INSIDE the active span leaves the checkpoint (and the past) in place", async () => {
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\nx");
    const options = { compactor: { summarize } as unknown as Compactor, compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.history.replace([
      { role: "user", content: "past", timestamp: 1 },
      { role: "assistant", content: "old answer", timestamp: 2 },
      { role: "user", content: "Riepilogo", timestamp: 3, synthetic: true },
      { role: "assistant", content: "## Goal\nx", timestamp: 4, synthetic: true },
      { role: "user", content: "question 1", timestamp: 5 },
      { role: "assistant", content: "answer 1", timestamp: 6 },
      { role: "user", content: "question 2", timestamp: 7 },
      { role: "assistant", content: "answer 2", timestamp: 8 },
    ]);

    // Cut at "question 2" (index 6): the checkpoint and the past survive.
    await handler({ type: "truncateAt", index: 6 });

    expect(rt.history.conversation().map((m) => m.content)).toEqual([
      "Riepilogo",
      "## Goal\nx",
      "question 1",
      "answer 1",
    ]);
    expect(rt.history.all().some((m) => m.content === "past")).toBe(true);
  });

  it("a ✂ cut AT the checkpoint removes it: the surviving past becomes the window again", async () => {
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\nx");
    const options = { compactor: { summarize } as unknown as Compactor, compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.history.replace([
      { role: "user", content: "past", timestamp: 1 },
      { role: "assistant", content: "old answer", timestamp: 2 },
      { role: "user", content: "Riepilogo", timestamp: 3, synthetic: true },
      { role: "assistant", content: "## Goal\nx", timestamp: 4, synthetic: true },
      { role: "user", content: "question 1", timestamp: 5 },
      { role: "assistant", content: "answer 1", timestamp: 6 },
    ]);

    // Cut at the checkpoint's own label (index 2): the pair and the tail go.
    await handler({ type: "truncateAt", index: 2 });

    const all = rt.history.all();
    expect(all.some((m) => m.synthetic)).toBe(false); // the checkpoint is gone
    expect(all.map((m) => m.content)).toEqual(["past", "old answer"]);
    // No marker left ⇒ the window restarts from what survived. That is "go back
    // to BEFORE that compaction", not a leak.
    expect(rt.history.conversation().map((m) => m.content)).toEqual(["past", "old answer"]);
  });

  // ── The fail-safe: a window that SHRINKS under a full session. A compaction
  // cannot serve it (the summarizer runs on the session's model, so the span it
  // would have to read does not fit), and the window must move anyway. ──

  it("summarizes a BACKGROUND session with ITS config: the summary carries that session's model and routing id", async () => {
    // A compaction is an LLM request made DURING a run, and it used to be built from the
    // host chain: on a host that routes by conversation (OpenCode Go) the summarizer's
    // request had no `x-opencode-session` — 400 MissingSessionID in the middle of a run —
    // and on every other host the summary was written by a DIFFERENT model than the
    // session's. The config now travels from the session being compacted.
    const configs: HarnyConfig[] = [];
    const factory = {
      create: (cfg: HarnyConfig) => {
        configs.push(cfg);
        return {
          protocol: "chat" as const,
          async *stream() {
            yield { type: "text", content: "Summary of past interactions\n---\n## Goal\ncarried" };
          },
        };
      },
    } as unknown as LLMProviderFactory;
    const options = { compactor: new Compactor(factory), compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness({
      ...options,
      providerEntry: {
        name: "opencode-go",
        baseUrl: "https://opencode.ai/go/v1",
        apiKey: "go-key",
        sessionHeader: "x-opencode-session",
        models: [{ id: "deepseek-v4-pro" }],
      } as any,
    });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt1 = registry.get("s1")!;
    await handler({ type: "setModel", model: "deepseek-v4-pro", provider: "opencode-go" });
    const big = 60;
    const history: ChatMessage[] = [];
    for (let i = 0; i < big; i++) {
      history.push({ role: "user", content: `question ${i} ${"x".repeat(8000)}`, timestamp: i * 2 + 1 });
      history.push({ role: "assistant", content: `answer ${i} ${"y".repeat(8000)}`, timestamp: i * 2 + 2 });
    }
    rt1.contextWindow = 32_000;
    rt1.history.replace(history);
    rt1.contextTokens = 240_000;

    // The user looks at ANOTHER session while s1 works: the compaction happens on s1.
    await provider.createNew(); // s2, now active
    await provider.maybeCompactDuringRun("s1");

    expect(configs.length).toBeGreaterThan(0);
    expect(configs.at(-1)).toMatchObject({
      sessionId: "s1",
      sessionHeader: "x-opencode-session",
      model: "deepseek-v4-pro",
    });
    // The other session has no model yet: it must not have contributed anything.
    expect(configs.every((c) => c.sessionId === "s1")).toBe(true);
  });

  it("a window that SHRINKS under a full session still summarizes what it can READ (nothing is lost)", async () => {
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\ncarried");
    const options = { compactor: { summarize } as unknown as Compactor, compaction: DEFAULT_COMPACTION };
    const { store, registry, provider } = buildHarness(options);
    resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;

    // Filled on a BIG model: no checkpoint yet, and far more than a small model
    // could read in one summary call.
    const big: ChatMessage[] = [];
    for (let i = 0; i < 60; i++) {
      big.push({ role: "user", content: `question ${i} ${"x".repeat(8000)}`, timestamp: i * 2 + 1 });
      big.push({ role: "assistant", content: `answer ${i} ${"y".repeat(8000)}`, timestamp: i * 2 + 2 });
    }
    rt.contextWindow = 1_000_000;
    rt.history.replace(big);

    // …then the user switches to a model with a far smaller window, and the next
    // turn boundary re-checks the context against it.
    rt.contextWindow = 32_000;
    rt.contextTokens = 240_000; // what the provider counted on the last turn
    await provider.maybeCompactDuringRun("s1");

    // The summarizer WAS asked: a span bigger than it can read no longer means giving up
    // on the whole span — it reads the most RECENT part that fits.
    expect(summarize).toHaveBeenCalled();
    // The window moved — it now opens on the summary…
    const conv = rt.history.conversation();
    expect(conv[0].synthetic).toBe(true);
    expect(conv[0].content).not.toBe(TRIM_LABEL);
    // …it fits the small model now…
    expect(estimateContextTokens(conv)).toBeLessThan(32_000);
    // …NOTHING was lost: the very first message is still in the session…
    expect(rt.history.all().some((m) => m.content.startsWith("question 0"))).toBe(true);
    // …and it was persisted whole.
    const saved = (store.saveMessages as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as ChatMessage[];
    expect(saved.some((m) => m.content.startsWith("question 0"))).toBe(true);

    // A SECOND check does NOT move the boundary again: the window is under the
    // threshold now, so the prefix stays put (the cache is not invalidated twice).
    const before = rt.history.all().length;
    const calls = summarize.mock.calls.length;
    await provider.maybeCompactDuringRun("s1");
    expect(rt.history.all().length).toBe(before);
    expect(summarize.mock.calls.length).toBe(calls);
  });

  it("a SUB-AGENT's oversized span DEFERS instead of failing: same model, ephemeral history", async () => {
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\ncarried");
    const options = { compactor: { summarize } as unknown as Compactor, compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.contextWindow = 32_000;

    // A sub-agent reads heavily: its OWN history is huge, and the model that would
    // have to summarize it is the session's — a small one.
    const sub = new InMemoryChatHistory();
    for (let i = 0; i < 60; i++) {
      sub.add({ role: "user", content: `task ${i} ${"x".repeat(8000)}`, timestamp: i * 2 + 1 });
      sub.add({ role: "assistant", content: `result ${i} ${"y".repeat(8000)}`, timestamp: i * 2 + 2 });
    }

    const ok = await provider.compactSubAgentHistory(sub, "s1");

    expect(ok).toBe(true);
    // Same rule as the session: it reads the newest part it can and defers the rest.
    expect(summarize).toHaveBeenCalled();
    // The sub-agent's window moved, and its own history keeps everything (it is
    // ephemeral, but the same rule applies: nothing is thrown away mid-run).
    expect(sub.conversation()[0].synthetic).toBe(true);
    expect(sub.conversation()[0].content).not.toBe(TRIM_LABEL);
    expect(sub.all().some((m) => m.content.startsWith("task 0"))).toBe(true);
  });

  it("a NORMAL compaction still runs when the span FITS the model (the trim is not the default)", async () => {
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\ncarried");
    const options = { compactor: { summarize } as unknown as Compactor, compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.contextWindow = 200_000;
    rt.contextTokens = 190_000;
    rt.history.replace([
      { role: "user", content: "a".repeat(20_000), timestamp: 1 },
      { role: "assistant", content: "b".repeat(20_000), timestamp: 2 },
      { role: "user", content: "c".repeat(20_000), timestamp: 3 },
      { role: "assistant", content: "d".repeat(20_000), timestamp: 4 },
      { role: "user", content: "e".repeat(20_000), timestamp: 5 },
      { role: "assistant", content: "f".repeat(20_000), timestamp: 6 },
    ]);

    await provider.maybeCompactDuringRun("s1");

    // The summary RAN — a real compaction, not a trim.
    expect(summarize).toHaveBeenCalledTimes(1);
    const conv = rt.history.conversation();
    expect(conv[0].synthetic).toBe(true);
    expect(conv[0].content).not.toBe(TRIM_LABEL);
    // The summarized span is still stored (the past is preserved), so the session
    // holds MORE than the window does.
    expect(rt.history.all().length).toBeGreaterThan(conv.length);
  });

  it("an 8k window CAN summarize now: the fixed 8192 used to make it impossible", async () => {
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\ncarried");
    const options = { compactor: { summarize } as unknown as Compactor, compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    // 8k — a LOCAL model's default, and a window this project explicitly targets.
    rt.contextWindow = 8_000;
    rt.contextTokens = 7_800;
    rt.history.replace([
      { role: "user", content: "a".repeat(2_000), timestamp: 1 },
      { role: "assistant", content: "b".repeat(2_000), timestamp: 2 },
      { role: "user", content: "c".repeat(2_000), timestamp: 3 },
      { role: "assistant", content: "d".repeat(2_000), timestamp: 4 },
    ]);

    await provider.maybeCompactDuringRun("s1");

    // The ceiling used to subtract a FIXED 8192 (a summary budget nobody had asked for)
    // plus a 2000 prompt guess: from an 8k window nothing was left, so a compaction under
    // ~10.2k could never happen and only the trim kept the session alive. Reserving what
    // the request actually spends gives the small model a real summary again.
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(rt.history.conversation()[0].content).not.toBe(TRIM_LABEL);
  });

  it("asks for a SMALL document but allows the session's declared output to write it", async () => {
    // The two numbers answer different questions and must never be mixed up. The budget is
    // the size we ASK for; the cap is what the model may SPEND — and a model that reasons
    // spends it BEFORE writing a character. Measured on a real session: cap = budget gave
    // EMPTY replies 3 times out of 3, cap = the declared output gave a real document 3/3.
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\nok");
    const options = { compactor: { summarize } as unknown as Compactor, compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.contextWindow = 200_000;
    rt.outputTokens = 8_192;
    rt.contextTokens = 190_000;
    rt.history.replace([
      { role: "user", content: "a".repeat(20_000), timestamp: 1 },
      { role: "assistant", content: "b".repeat(20_000), timestamp: 2 },
      { role: "user", content: "c".repeat(20_000), timestamp: 3 },
      { role: "assistant", content: "d".repeat(20_000), timestamp: 4 },
      { role: "user", content: "e".repeat(20_000), timestamp: 5 },
      { role: "assistant", content: "f".repeat(20_000), timestamp: 6 },
    ]);

    await provider.maybeCompactDuringRun("s1");

    const sent = (summarize.mock.calls[0] as unknown[])[3] as { maxSummaryTokens?: number; maxReplyTokens?: number };
    expect(sent.maxSummaryTokens).toBeGreaterThan(0);
    // The cap is the session's declared OUTPUT…
    expect(sent.maxReplyTokens).toBe(8_192);
    // …and it is NOT the budget: that is the defect that produced empty replies.
    expect(sent.maxReplyTokens).not.toBe(sent.maxSummaryTokens);
  });

  it("retries ONCE when the reply is not the document: a bad roll must not cost the summary", async () => {
    // An auto-router can land on a guard model, or a model can simply lose the thread:
    // that is a transient roll, not a systematic failure. One extra call recovers it —
    // measured 4 runs in 5 succeeding on the same input, so the retry is cheap insurance.
    const summarize = vi
      .fn()
      .mockResolvedValueOnce("Hi! How can I help you today?")
      .mockResolvedValueOnce("Summary of past interactions\n---\n## Goal\nok");
    const options = { compactor: { summarize } as unknown as Compactor, compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.contextWindow = 200_000;
    rt.contextTokens = 190_000;
    rt.history.replace([
      { role: "user", content: "a".repeat(20_000), timestamp: 1 },
      { role: "assistant", content: "b".repeat(20_000), timestamp: 2 },
      { role: "user", content: "c".repeat(20_000), timestamp: 3 },
      { role: "assistant", content: "d".repeat(20_000), timestamp: 4 },
      { role: "user", content: "e".repeat(20_000), timestamp: 5 },
      { role: "assistant", content: "f".repeat(20_000), timestamp: 6 },
    ]);

    await provider.maybeCompactDuringRun("s1");

    expect(summarize).toHaveBeenCalledTimes(2);
    const conv = rt.history.conversation();
    expect(conv[0].content).not.toBe(TRIM_LABEL);
    expect(conv[0].content).toContain("Summary of past interactions");
  });

  it("reads the NEWEST part that fits and DEFERS the rest — nothing is thrown away", async () => {
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\ncarried");
    const options = { compactor: { summarize } as unknown as Compactor, compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.contextWindow = 8_000;
    rt.contextTokens = 7_800;
    // ~12k tokens of history on an 8k window: more than one summary request can read.
    rt.history.replace(
      Array.from({ length: 12 }, (_, i) => ({
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `m${i} ` + "x".repeat(4_000),
        timestamp: i + 1,
      })),
    );

    await provider.maybeCompactDuringRun("s1");

    expect(summarize).toHaveBeenCalledTimes(1);
    const conv = rt.history.conversation();
    expect(conv[0].synthetic).toBe(true);
    expect(conv[0].content).not.toBe(TRIM_LABEL);
    expect(estimateContextTokens(conv)).toBeLessThan(8_000);
    // The oldest messages could not be READ: they are DEFERRED — still in the transcript,
    // ABOVE the new checkpoint, outside the window. Preserved, not summarized, not lost.
    expect(rt.history.all().some((m) => m.content.startsWith("m0 "))).toBe(true);
    expect(conv.some((m) => m.content.startsWith("m0 "))).toBe(false);
  });

  it("the deferred (OLDER) part stays ABOVE the summarized one: the transcript keeps its order", async () => {
    // The summary request reads the newest chunk that fits, so `summarized` is NEWER than
    // `deferred` — and the boundary between them is chosen by a TOKEN budget, which can land
    // anywhere, even in the middle of a turn. Splicing the span back as
    // [summarized][deferred] hoisted that cut above the session's own beginning: the
    // transcript then opened on a dangling thinking block, and every later compaction copied
    // that head verbatim (it is `past`), so it never healed.
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\ncarried");
    const options = { compactor: { summarize } as unknown as Compactor, compaction: DEFAULT_COMPACTION };
    const { store, registry, provider } = buildHarness(options);
    resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.contextWindow = 8_000;
    rt.contextTokens = 7_800;
    rt.history.replace(
      Array.from({ length: 12 }, (_, i) => ({
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `m${i} ` + "x".repeat(4_000),
        timestamp: i + 1,
      })),
    );

    await provider.maybeCompactDuringRun("s1");

    const all = rt.history.all();
    const at = (prefix: string): number => all.findIndex((m) => m.content.startsWith(prefix));
    // The oldest message is the one the summary could NOT read — and it is the FIRST row…
    expect(at("m0 ")).toBe(0);
    // …while the chunk that was summarized sits BELOW it, not above.
    expect(at("m11 ")).toBeGreaterThan(at("m0 "));
    expect(at("m0 ")).toBeLessThan(all.findIndex((m) => m.synthetic === true));
    // What is stored is what the UI will read back: same order, nothing dropped.
    const saved = (store.saveMessages as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as ChatMessage[];
    expect(saved.map((m) => m.content)).toEqual(all.map((m) => m.content));
  });

  it("what a compaction leaves behind is COMPLETE TURNS — the card is itself a turn", async () => {
    // The rule, end to end: a compaction is a turn in its own right (a synthetic question and
    // the state document that answers it), so the transcript around it must be whole turns.
    // Three things can go wrong and none of them is visible from a token count:
    //   • the span the summarizer reads can open mid-turn → `deferred` ends on a call whose
    //     results went into the summary (a card answering nobody);
    //   • the KEPT tail can open mid-turn → the model resumes mid-thought after the card;
    //   • the card itself can land between a call and its results.
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\ncarried");
    const options = { compactor: { summarize } as unknown as Compactor, compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.contextWindow = 8_000;
    rt.contextTokens = 7_800;
    /** One complete turn: request → a step calling TWO tools → both results → the reply. */
    const turn = (n: number): ChatMessage[] => [
      { role: "user", content: `turn ${n} ask ` + "q".repeat(1_500), timestamp: n * 10 },
      {
        role: "assistant",
        content: "",
        timestamp: n * 10 + 1,
        toolCalls: [
          { id: `c${n}a`, name: "Read", arguments: { path: "a.ts" } },
          { id: `c${n}b`, name: "Read", arguments: { path: "b.ts" } },
        ],
      },
      { role: "tool", content: `turn ${n} out-a ` + "a".repeat(1_500), toolCallId: `c${n}a`, timestamp: n * 10 + 2 },
      { role: "tool", content: `turn ${n} out-b ` + "b".repeat(1_500), toolCallId: `c${n}b`, timestamp: n * 10 + 3 },
      { role: "assistant", content: `turn ${n} reply ` + "r".repeat(1_500), timestamp: n * 10 + 4 },
    ];
    const original = [1, 2, 3, 4, 5, 6].flatMap(turn);
    rt.history.replace(original);

    /** Every invariant, checked on whatever is in the transcript right now. */
    const expectWholeTurns = (label: string): void => {
      const all = rt.history.all();
      // 1. start to finish, the stored history is a conversation that can be SENT.
      expect(conversationFaults(all), `${label}: the transcript is sendable`).toEqual([]);
      // 2. it still opens on the very first message ever written…
      expect(all[0].content.startsWith("turn 1 ask "), `${label}: the head`).toBe(true);
      // 3. …and the card is a complete turn: question, then the state document.
      const card = all.findIndex((m) => m.synthetic === true);
      expect(card, `${label}: there is a card`).toBeGreaterThan(0);
      expect(all[card].role, `${label}: the card asks`).toBe("user");
      expect(all[card + 1].role, `${label}: the card answers`).toBe("assistant");
      expect(all[card + 1].content).toContain("## Goal");
      // 4. what follows the card OPENS A TURN — never half of one.
      if (card + 2 < all.length) expect(all[card + 2].role, `${label}: after the card`).toBe("user");
      // 5. and what precedes it is whole too (this is `deferred`, permanent history).
      expect(conversationFaults(all.slice(0, card)), `${label}: above the card`).toEqual([]);
      // 6. nothing was lost on the way.
      const kept = all.filter((m) => m.synthetic !== true).map((m) => m.content);
      expect(kept.sort(), `${label}: nothing dropped`).toEqual(original.map((m) => m.content).sort());
    };

    await provider.maybeCompactDuringRun("s1");
    expectWholeTurns("first compaction");
    expect(summarize).toHaveBeenCalled();

    // More work happens, then a SECOND compaction: the tail that survived becomes `past`
    // (copied verbatim, never re-summarized), so any artifact left behind would be frozen
    // there — this is where a bug becomes permanent.
    const more = [7, 8, 9, 10].flatMap(turn);
    rt.history.addGroup(more);
    original.push(...more);
    rt.contextTokens = 7_800;
    await provider.maybeCompactDuringRun("s1");
    expectWholeTurns("second compaction");
    expect(summarize.mock.calls.length).toBeGreaterThan(1);
    // The new state document is still ONE turn: the previous card sat inside the window, so it
    // was folded into the new state instead of being copied down the transcript.
    expect(rt.history.all().filter((m) => m.synthetic === true)).toHaveLength(2);
  });

  it("a card that lands INSIDE a single turn says so instead of being a mystery", async () => {
    // The one exception: the window is a single turn bigger than the keep target (a dozen tool
    // cycles under one request). There is no turn boundary above it, so the card sits at a STEP
    // boundary inside the turn — and the log has to name it, otherwise a mid-task checkpoint in
    // the transcript looks like a bug forever after.
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\ncarried");
    const options = { compactor: { summarize } as unknown as Compactor, compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.contextWindow = 16_000;
    rt.contextTokens = 15_200;
    // ONE turn: a request, then four heavy steps under it, each calling two tools.
    const step = (n: number): ChatMessage[] => [
      {
        role: "assistant",
        content: "",
        timestamp: n * 10,
        toolCalls: [
          { id: `s${n}a`, name: "Read", arguments: { path: "a.ts" } },
          { id: `s${n}b`, name: "Grep", arguments: { pattern: "x" } },
        ],
      },
      { role: "tool", content: `step ${n} a ` + "a".repeat(3_600), toolCallId: `s${n}a`, timestamp: n * 10 + 1 },
      { role: "tool", content: `step ${n} b ` + "b".repeat(3_600), toolCallId: `s${n}b`, timestamp: n * 10 + 2 },
    ];
    rt.history.replace([
      { role: "user", content: "work through the whole parser " + "q".repeat(3_600), timestamp: 1 },
      ...[1, 2, 3, 4].flatMap(step),
      { role: "assistant", content: "done with the round", timestamp: 99 },
    ]);

    await provider.maybeCompactDuringRun("s1");

    const all = rt.history.all();
    const card = all.findIndex((m) => m.synthetic === true);
    expect(card).toBeGreaterThan(0);
    // Inside the turn: the kept tail CONTINUES it (no new request follows the card)…
    expect(all[card + 2].role).not.toBe("user");
    // …and nothing is broken: no orphan result, no call left without its results.
    expect(conversationFaults(all)).toEqual([]);
    // The line that turns a mystery into a diagnosis.
    const lines = vi
      .mocked(infoLog)
      .mock.calls.map((c) => c.map(String).join(" "))
      .join("\n");
    expect(lines).toContain("ONE turn bigger than the target");
  });

  it("a window that already fits the keep budget is left ALONE (no mid-turn cut, no rewrite)", async () => {
    // The state a session is in right after a compaction: what is left in the window fits the
    // keep budget, so there is nothing worth summarizing — the size the caller reacts to lives
    // in `past`, which is not even sent. Compacting anyway used to cut inside the first turn
    // (the only way to honor the budget), i.e. the model resumed mid-thought after the card.
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\ncarried");
    const options = { compactor: { summarize } as unknown as Compactor, compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.contextWindow = 200_000;
    rt.contextTokens = 190_000;
    // One card, then a single modest turn: the window fits easily, `past` is what is big.
    rt.history.replace([
      { role: "user", content: "Summary of past interactions", timestamp: 1, synthetic: true },
      { role: "assistant", content: "## Goal\nold state" + "s".repeat(40_000), timestamp: 2, synthetic: true },
      { role: "user", content: "next request", timestamp: 3 },
      { role: "assistant", content: "done", timestamp: 4 },
    ]);
    const before = rt.history.all();

    await provider.maybeCompactDuringRun("s1");

    // Nothing to summarize → no request, no new card, and not a byte of the transcript moved.
    expect(summarize).not.toHaveBeenCalled();
    expect(rt.history.all().map((m) => m.content)).toEqual(before.map((m) => m.content));
  });

  it("a summary that FAILS lands on a trim instead of surfacing an error", async () => {
    // The ceiling is our PREDICTION of the summarizer's own request size. A prediction
    // can be wrong (a previous state document bigger than the reserve allows for, a
    // provider phrasing things differently, a transient failure) — and when it is wrong
    // the session must still survive: the trim calls no model, so it cannot fail.
    const summarize = vi.fn(async () => {
      throw new Error("400 invalid_request_error: this model's maximum context length is exceeded");
    });
    const options = { compactor: { summarize } as unknown as Compactor, compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.contextWindow = 200_000;
    rt.contextTokens = 190_000;
    rt.history.replace([
      { role: "user", content: "a".repeat(20_000), timestamp: 1 },
      { role: "assistant", content: "b".repeat(20_000), timestamp: 2 },
      { role: "user", content: "c".repeat(20_000), timestamp: 3 },
      { role: "assistant", content: "d".repeat(20_000), timestamp: 4 },
      { role: "user", content: "e".repeat(20_000), timestamp: 5 },
      { role: "assistant", content: "f".repeat(20_000), timestamp: 6 },
    ]);

    // The run does NOT blow up: no rejection escapes to the user.
    await expect(provider.maybeCompactDuringRun("s1")).resolves.toBeUndefined();
    // The summarizer WAS asked (the ceiling said the span would fit)…
    expect(summarize).toHaveBeenCalled();
    // …and the window moved anyway, through the path that cannot fail.
    const conv = rt.history.conversation();
    expect(conv[0].synthetic).toBe(true);
    expect(conv[0].content).toBe(TRIM_LABEL);
    expect(conv.length).toBeLessThan(rt.history.all().length);
  });

  it("a reply that is NOT a summary lands on a trim: the state document is never written with garbage", async () => {
    // Seen in the wild: the provider answered with a safety classification, and 108
    // messages were reduced to "User Safety: safe". Accepting it broke the CHAIN — every
    // later compaction UPDATES the newest state document, so the garbage propagates and
    // the messages it replaced become unreachable. It is a failed compaction now, so the
    // trim carries the PREVIOUS state verbatim and the chain survives.
    const summarize = vi.fn(async () => "User Safety: safe\nResponse Safety: safe");
    const options = { compactor: { summarize } as unknown as Compactor, compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.contextWindow = 200_000;
    rt.contextTokens = 190_000;
    rt.history.replace([
      { role: "user", content: "a".repeat(20_000), timestamp: 1 },
      { role: "assistant", content: "b".repeat(20_000), timestamp: 2 },
      { role: "user", content: "c".repeat(20_000), timestamp: 3 },
      { role: "assistant", content: "d".repeat(20_000), timestamp: 4 },
      { role: "user", content: "e".repeat(20_000), timestamp: 5 },
      { role: "assistant", content: "f".repeat(20_000), timestamp: 6 },
    ]);

    await provider.maybeCompactDuringRun("s1");

    expect(summarize).toHaveBeenCalled();
    const conv = rt.history.conversation();
    expect(conv[0].content).toBe(TRIM_LABEL);
    expect(JSON.stringify(conv)).not.toContain("User Safety");
  });

  it("a MID-RUN compaction rebuilds the transcript, like the manual one does", async () => {
    // Before this, the auto path only posted `compactStart`/`compactDone`: the divider and
    // the summary card were left for the next unrelated refresh, and a stand-in bubble
    // said the older messages had been summarized. The two paths now do the same thing —
    // the ONE difference that must survive is the absence of `status` posts, because the
    // run is still in flight and the working indicator has to keep showing.
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\ncarried");
    const options = { compactor: { summarize } as unknown as Compactor, compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    const { view } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.contextWindow = 200_000;
    rt.contextTokens = 190_000;
    rt.history.replace([
      { role: "user", content: "a".repeat(20_000), timestamp: 1 },
      { role: "assistant", content: "b".repeat(20_000), timestamp: 2 },
      { role: "user", content: "c".repeat(20_000), timestamp: 3 },
      { role: "assistant", content: "d".repeat(20_000), timestamp: 4 },
      { role: "user", content: "e".repeat(20_000), timestamp: 5 },
      { role: "assistant", content: "f".repeat(20_000), timestamp: 6 },
    ]);
    view.webview.postMessage.mockClear();

    await provider.maybeCompactDuringRun("s1");

    const posted = view.webview.postMessage.mock.calls.map((c) => c[0] as any);
    expect(posted.filter((m) => m.type === "refresh")).toHaveLength(1);
    // The working indicator is NOT touched mid-run.
    expect(posted.filter((m) => m.type === "status")).toHaveLength(0);
    // …and the webview is told the card exists, so it can leave a pointer where the reader is.
    expect(posted.filter((m) => m.type === "compactDone" && m.ok === true)).toHaveLength(1);
  });

  it("a mid-run refresh says the run is ALIVE even with nothing left to replay", async () => {
    // The reported "the Working bar vanished while everything kept going". The rebuild can
    // land on a TURN BOUNDARY, where the committed text is already out of the live
    // projection (`projection()` → undefined). `streaming` is a fact about the RUN, so it
    // must not be paired with the replay data: the webview uses it to put the bar back, and
    // the bar is the anchor the streaming answer bubble is inserted BEFORE.
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\ncarried");
    const options = { compactor: { summarize } as unknown as Compactor, compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    const { view } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.contextWindow = 200_000;
    rt.contextTokens = 190_000;
    rt.history.replace([
      { role: "user", content: "a".repeat(20_000), timestamp: 1 },
      { role: "assistant", content: "b".repeat(20_000), timestamp: 2 },
      { role: "user", content: "c".repeat(20_000), timestamp: 3 },
      { role: "assistant", content: "d".repeat(20_000), timestamp: 4 },
      { role: "user", content: "e".repeat(20_000), timestamp: 5 },
      { role: "assistant", content: "f".repeat(20_000), timestamp: 6 },
    ]);
    // A run in flight with NOTHING uncommitted: no live text, no pending bubble.
    (rt.agent as { streaming: boolean }).streaming = true;
    expect(rt.engine.projection()).toBeUndefined();
    view.webview.postMessage.mockClear();

    await provider.maybeCompactDuringRun("s1");

    const posted = view.webview.postMessage.mock.calls.map((c) => c[0] as any);
    const refresh = posted.find((m) => m.type === "refresh");
    expect(refresh?.streaming).toBe(true); // the bar comes back
    expect(refresh?.liveThinking ?? "").toBe(""); // …with nothing to replay
    // The skills catalog is only carried when the caller asked for it: this path must not
    // pay for it (and a default turned to `true` would ship it on every rebuild).
    expect(refresh?.skills).toBeUndefined();
    // Still no `status`: mid-run the indicator is not to be re-posted, only preserved.
    expect(posted.filter((m) => m.type === "status")).toHaveLength(0);
  });

  it("feeds the summarizer a budget that is a COMPRESSION of the span", async () => {
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\nx");
    const options = {
      compactor: { summarize } as unknown as Compactor,
      compaction: DEFAULT_COMPACTION,
      manualKeepFraction: 0.6,
    };
    const { registry, provider } = buildHarness(options);
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    // A window with an output reserve: the USABLE budget is what matters, not the
    // raw window (the same rule the threshold and the footer use).
    rt.contextWindow = 100_000;
    rt.outputTokens = 20_000;
    rt.contextTokens = 60_000;
    rt.history.replace([
      { role: "user", content: "a".repeat(4000), timestamp: 1 },
      { role: "assistant", content: "b".repeat(4000), timestamp: 2 },
      { role: "user", content: "c".repeat(4000), timestamp: 3 },
      { role: "assistant", content: "d".repeat(4000), timestamp: 4 },
      { role: "user", content: "e".repeat(4000), timestamp: 5 },
      { role: "assistant", content: "f".repeat(4000), timestamp: 6 },
    ]);

    await handler({ type: "compact" });

    // usable = 100k window − 20k reserve = 80k. The budget is a share of the SPAN it
    // replaces (10:1), vetoed by the room the post-compaction window leaves. Asserted as
    // a RELATIONSHIP: pinning the exact number would just re-state the formula.
    expect(summarize).toHaveBeenCalledTimes(1);
    const budget = (summarize.mock.calls[0] as unknown[])[3] as { maxSummaryTokens?: number };
    expect(budget?.maxSummaryTokens).toBeGreaterThanOrEqual(512);
    expect(budget?.maxSummaryTokens).toBeLessThan(40_000);
    // …and the summarizer is told what the session still has in full, so the
    // summary does not pay twice for work the kept tail already shows.
    expect(budget?.keptPreview).toBeTruthy();
  });

  it("auto-compacts against the USABLE budget: the 80% of the RAW window is unreachable when output is reserved", async () => {
    const options = {
      compactor: new Compactor(compactorFactory()),
      compaction: DEFAULT_COMPACTION,
    };
    const { registry, provider } = buildHarness(options);
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    // A model MUST be selected first: without one the send is refused with
    // "Select a model for this session first" and no turn ever runs.
    await handler({ type: "setModel", model: "m", provider: "p" });
    const rt = registry.get("s1")!;
    // The configuration that killed a real session: a 1M window with a 384k
    // output budget. The input can never exceed 664.576, so a threshold applied
    // to the RAW window (80% = 838.861) can never be reached: the provider
    // answers 400 first. Against the USABLE budget (80% of 664.576 = 531.660)
    // the trigger fires — and 663.300 is past it.
    rt.contextWindow = 1_048_576;
    rt.outputTokens = 384_000;
    rt.contextTokens = 400_000; // under the usable threshold before the request
    rt.history.replace([
      { role: "user", content: "let's go", timestamp: 1 },
      { role: "assistant", content: "ok", timestamp: 2 },
      { role: "user", content: "then", timestamp: 3 },
      { role: "assistant", content: "done", timestamp: 4 },
    ]);
    (rt.agent as any).send = vi.fn(async () => {
      (rt.agent as any).streaming = true;
      rt.contextTokens = 663_300; // the failing session's input: 63% of the window
    });

    await handler({ type: "send", text: "more" });

    // Sanity: this fill is FAR below 80% of the raw window — the old math would
    // have sent the request and let the provider reject it.
    expect(663_300).toBeLessThan(1_048_576 * 0.8);
    const conv = registry.get("s1")!.history.conversation();
    expect(conv[0].role).toBe("user");
    expect(String(conv[1].content)).toContain("## Goal");
  });

  it("auto-compacts right after a response when the reply crossed the threshold", async () => {
    const options = {
      compactor: new Compactor(compactorFactory()),
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
    expect(store.saveSettings as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
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
    expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "status", active: false }));
    // …and they arrive in the blocking order: bubble, status-IN, note, status-OUT.
    const seq = (view.webview.postMessage as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as { type: string }).type,
    );
    const startAt = seq.indexOf("compactStart");
    const doneAt = seq.lastIndexOf("refresh");
    expect(seq[startAt + 1]).toBe("status");
    // After the rebuild comes the pointer to the card (`compactDone`), THEN the release.
    expect(seq[doneAt + 1]).toBe("compactDone");
    expect(seq[doneAt + 2]).toBe("status");
    expect(startAt).toBeLessThan(doneAt);
  });

  it("pushes the USABLE context (window − reserve) so the bar and the host threshold agree", async () => {
    const { registry, provider } = buildHarness({
      providerEntry: { name: "p", baseUrl: "http://x/v1", models: [] },
      fetchModelInfos: async () => [{ id: "big", contextLength: 1_048_576, maxOutputTokens: 384_000 }],
    });
    const { view, handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "big", provider: "p" });
    const rt = registry.get("s1")!;
    expect(rt.contextWindow).toBe(1_048_576);
    expect(rt.outputTokens).toBe(384_000);

    // The webview must receive BOTH numbers, otherwise it cannot show the truth:
    // 1M − 384k = 664.576 usable. This is the same function the auto-compaction
    // threshold uses, so the bar and the trigger can never disagree.
    const pushedConfig = (): { contextWindow?: number; contextUsable?: number } | undefined =>
      (view.webview.postMessage as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c[0] as { type?: string; config?: { contextWindow?: number; contextUsable?: number } })
        .filter((m) => m?.type === "config" && m.config?.contextUsable !== undefined)
        .at(-1)?.config;
    await vi.waitFor(() => expect(pushedConfig()?.contextUsable).toBe(664_576));
    expect(pushedConfig()!.contextWindow).toBe(1_048_576);
  });

  it("adopts the host-reported context window when a model is selected", async () => {
    const { store, registry, provider } = buildHarness({
      providerEntry: { name: "openrouter", baseUrl: "http://x/v1", models: [] },
      fetchModelInfos: async () => [{ id: "openrouter/x", contextLength: 131072 }, { id: "openrouter/plain" }],
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

    // A model WITHOUT a reported window RESETS to the default (not the previous model's).
    await handler({ type: "setModel", model: "openrouter/plain", provider: "openrouter" });
    expect(rt.contextWindow).toBe(128000);
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

    // Re-selecting the SAME unknown model DOES alert again while the question is
    // still unanswered (returning to it must remind you); once the form is filled
    // in, the answer is remembered — see the "answering the form" test.
    const isContextAlert = (m: unknown): boolean =>
      !!m && typeof m === "object" && (m as { title?: string }).title === "Model limits unknown";
    view.webview.postMessage.mockClear();
    await handler({ type: "setModel", model: "unknown-model", provider: "opencode-go" });
    await vi.waitFor(() =>
      expect(view.webview.postMessage.mock.calls.some((c: unknown[]) => isContextAlert(c[0]))).toBe(true),
    );
  });

  it("alerts when ONLY the output is unknown (host reports the context — the llama case)", async () => {
    const { registry, provider } = buildHarness({
      providerEntry: { name: "llama-cpp", baseUrl: "http://localhost:8090/v1", models: [] },
      fetchModelInfos: async () => [{ id: "qwen.gguf", contextLength: 32768 }], // context only
      modelsDev: { getLimits: vi.fn(async () => ({})) },
    });
    const { handler, view } = resolveWith(provider);
    await provider.createNew();
    view.webview.postMessage.mockClear();

    await handler({ type: "setModel", model: "qwen.gguf", provider: "llama-cpp" });

    await vi.waitFor(() =>
      expect(view.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "modal",
          kind: "alert",
          title: "Model limits unknown",
          message: expect.stringContaining("max output tokens"),
        }),
      ),
    );
    // The host-identified context is KEPT; the unknown output gets the default.
    expect(registry.get("s1")!.contextWindow).toBe(32768);
    expect(registry.get("s1")!.outputTokens).toBe(8192);
  });

  it("alerts when ONLY the context is unknown (host reports the output)", async () => {
    const { registry, provider } = buildHarness({
      providerEntry: { name: "p", baseUrl: "https://x/v1", models: [] },
      fetchModelInfos: async () => [{ id: "m1", maxOutputTokens: 8192 }], // output only
      modelsDev: { getLimits: vi.fn(async () => ({})) },
    });
    const { handler, view } = resolveWith(provider);
    await provider.createNew();
    view.webview.postMessage.mockClear();

    await handler({ type: "setModel", model: "m1", provider: "p" });

    await vi.waitFor(() =>
      expect(view.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "modal",
          kind: "alert",
          title: "Model limits unknown",
          message: expect.stringContaining("context window"),
        }),
      ),
    );
    // The host-identified output is KEPT; the unknown context gets the default.
    expect(registry.get("s1")!.outputTokens).toBe(8192);
    expect(registry.get("s1")!.contextWindow).toBe(128000);
  });

  it("the unknown-limits alert is a FORM: two sliders pre-filled with the values in use", async () => {
    state.noAutoAlert = true;
    try {
      const { provider } = buildHarness({
        providerEntry: { name: "llama-cpp", baseUrl: "http://localhost:8090/v1", models: [] },
        fetchModelInfos: async () => [{ id: "Qwen3.8-27B-Q4_K_L.gguf", contextLength: 32768 }], // output unknown
        modelsDev: { getLimits: vi.fn(async () => ({})) },
      });
      const { handler, view } = resolveWith(provider);
      await vi.waitFor(() => expect(view.webview.html).toBeTruthy());
      await provider.createNew();
      await handler({ type: "setModel", model: "Qwen3.8-27B-Q4_K_L.gguf", provider: "llama-cpp" });

      const posts = (): any[] => view.webview.postMessage.mock.calls.map((c: unknown[]) => c[0]);
      await vi.waitFor(() => expect(posts().some((m) => m?.title === "Model limits unknown")).toBe(true));
      const alert = posts().find((m) => m?.title === "Model limits unknown");
      const byKey = (k: string) => alert.fields.find((f: { key: string }) => f.key === k);

      // The two sliders the user asked for: the SAME scale as the Window card
      // (1 000 → 2 000 000 / 8 → 524 288) when nothing was detected...
      const outField = byKey("outputTokens");
      expect(outField.min).toBe(8);
      expect(outField.max).toBe(524_288);
      // ...and the value in use, so OK without touching anything changes nothing.
      expect(outField.value).toBe(8192);
      // The DETECTED side is not re-typed from scratch: its own limit is the
      // ceiling (you can only lower it) and the detected value is the start.
      const ctxField = byKey("contextWindow");
      expect(ctxField.min).toBe(1000);
      expect(ctxField.max).toBe(32768);
      expect(ctxField.value).toBe(32768);

      await handler({ type: "modalResponse", id: alert.modalId, value: true });
    } finally {
      state.noAutoAlert = false;
    }
  });

  it("answering the form applies BOTH values and stops asking again for that model", async () => {
    state.noAutoAlert = true;
    try {
      const { store, registry, provider } = buildHarness({
        providerEntry: { name: "llama-cpp", baseUrl: "http://localhost:8090/v1", models: [] },
        fetchModelInfos: async () => [{ id: "qwen.gguf" }], // host reports NOTHING
        modelsDev: { getLimits: vi.fn(async () => ({})) },
      });
      const { handler, view } = resolveWith(provider);
      await vi.waitFor(() => expect(view.webview.html).toBeTruthy());
      await provider.createNew();
      await handler({ type: "setModel", model: "qwen.gguf", provider: "llama-cpp" });

      const posts = (): any[] => view.webview.postMessage.mock.calls.map((c: unknown[]) => c[0]);
      await vi.waitFor(() => expect(posts().some((m) => m?.title === "Model limits unknown")).toBe(true));
      const alert = posts().find((m) => m?.title === "Model limits unknown");

      // The numbers the user dragged the sliders to.
      await handler({
        type: "modalResponse",
        id: alert.modalId,
        value: { contextWindow: 32768, outputTokens: 4096 },
      });
      const rt = registry.get("s1")!;
      await vi.waitFor(() => expect(rt.contextWindow).toBe(32768));
      expect(rt.outputTokens).toBe(4096);
      // Persisted on the session: the compaction ceiling and the output cap read
      // it from there.
      const saved = (store.saveSettings as any).mock.calls as any[];
      expect(saved.some((c: any[]) => c[1]?.contextWindow === 32768 && c[1]?.outputTokens === 4096)).toBe(true);

      // Coming BACK to the model neither re-asks nor throws the answer away.
      view.webview.postMessage.mockClear();
      await handler({ type: "setModel", model: "other.gguf", provider: "llama-cpp" });
      await handler({ type: "setModel", model: "qwen.gguf", provider: "llama-cpp" });
      await new Promise((r) => setTimeout(r, 20));
      const askedAgain = view.webview.postMessage.mock.calls
        .map((c: unknown[]) => c[0] as { title?: string; modalId?: number })
        .some((m) => m?.title === "Model limits unknown" && m.modalId !== alert.modalId);
      expect(askedAgain).toBe(false);
      expect(registry.get("s1")!.contextWindow).toBe(32768);
      expect(registry.get("s1")!.outputTokens).toBe(4096);
    } finally {
      state.noAutoAlert = false;
    }
  });

  it("defers a page rebuild while a modal is open, then applies it (the alert must not flash away)", async () => {
    state.noAutoAlert = true; // keep the "Model limits unknown" alert OPEN
    try {
      const { provider } = buildHarness({
        providerEntry: { name: "p", baseUrl: "https://x/v1", models: [] },
        fetchModelInfos: async () => [{ id: "unknown" }],
        modelsDev: { getLimits: vi.fn(async () => ({})) },
      });
      const { handler, view } = resolveWith(provider);
      await vi.waitFor(() => expect(view.webview.html).toBeTruthy()); // initial render done
      await provider.createNew();
      await handler({ type: "setModel", model: "unknown", provider: "p" });

      const posts = (): { title?: string; modalId?: number }[] =>
        view.webview.postMessage.mock.calls.map((c: unknown[]) => c[0] as { title?: string; modalId?: number });
      await vi.waitFor(() => expect(posts().some((m) => m?.title === "Model limits unknown")).toBe(true));
      const htmlBefore = view.webview.html;

      // A rebuild while the modal is open is DEFERRED: the page is NOT replaced
      // (replacing it wipes the modal DOM, which is the flash the user saw).
      provider.refresh();
      await new Promise((r) => setTimeout(r, 30));
      expect(view.webview.html).toBe(htmlBefore);

      // Answering the modal runs the deferred rebuild.
      const alert = posts().find((m) => m?.title === "Model limits unknown")!;
      await handler({ type: "modalResponse", id: alert.modalId, value: true });
      await vi.waitFor(() => expect(view.webview.html).not.toBe(htmlBefore));
    } finally {
      state.noAutoAlert = false;
    }
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
        .map(
          (c: unknown[]) =>
            c[0] as { type?: string; config?: { providerModels?: { model: string; contextLength?: number }[] } },
        )
        .filter((m) => m?.type === "config");
      const models = configs.flatMap((c) => c.config?.providerModels ?? []);
      expect(models.some((m) => m.model === "kimi-k3" && m.contextLength === 1048576)).toBe(true);
    });
    expect(getLimits).toHaveBeenCalled();
  });

  it("setCompactionThreshold stores the session override (clamped) and persists it", async () => {
    const options = { compactor: new Compactor(compactorFactory()), compaction: DEFAULT_COMPACTION };
    const { store, registry, provider } = buildHarness(options);
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;

    await handler({ type: "setCompactionThreshold", value: 65 });
    expect(rt.compactionThresholdPercent).toBe(65);
    expect(store.saveSettings as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ compactionThresholdPercent: 65 }),
    );

    // Out-of-range values are clamped host-side to 1–100.
    await handler({ type: "setCompactionThreshold", value: 150 });
    expect(rt.compactionThresholdPercent).toBe(100);

    // Invalid values fall back to the default 80.
    await handler({ type: "setCompactionThreshold", value: "abc" });
    expect(rt.compactionThresholdPercent).toBe(80);
    expect(store.saveSettings as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ compactionThresholdPercent: 80 }),
    );
  });

  it("setCompactionTarget stores the landing point (bounded by the trigger) and can be cleared", async () => {
    const options = { compactor: new Compactor(compactorFactory()), compaction: DEFAULT_COMPACTION };
    const { store, registry, provider } = buildHarness(options);
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;

    await handler({ type: "setCompactionTarget", value: 25 });
    expect(rt.compactionTargetPercent).toBe(25);
    expect(store.saveSettings as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ compactionTargetPercent: 25 }),
    );

    // The upper bound is the TRIGGER minus one (80 by default), not a fixed cap.
    await handler({ type: "setCompactionTarget", value: 95 });
    expect(rt.compactionTargetPercent).toBe(79);

    // Lowering the trigger NARROWS the range: the explicit value follows it down.
    await handler({ type: "setCompactionThreshold", value: 40 });
    expect(rt.compactionTargetPercent).toBe(39);

    // MISSING clears the override: the landing point is the DERIVED default again…
    await handler({ type: "setCompactionTarget" });
    expect(rt.compactionTargetPercent).toBeUndefined();
    expect(store.saveSettings as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("s1", {
      compactionTargetPercent: undefined,
    });

    // …while 0 is a REAL choice — "only the summary remains" — and is stored as such.
    await handler({ type: "setCompactionTarget", value: 30 });
    expect(rt.compactionTargetPercent).toBe(30);
    await handler({ type: "setCompactionTarget", value: 0 });
    expect(rt.compactionTargetPercent).toBe(0);
    expect(store.saveSettings as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("s1", {
      compactionTargetPercent: 0,
    });
  });

  it("the FLOOR comes from the session's own last turn, and anything below it collapses to 0", async () => {
    const options = { compactor: new Compactor(compactorFactory()), compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.contextWindow = 100_000;
    rt.outputTokens = 4_096;
    rt.history.replace([
      { role: "user", content: "old", timestamp: 1 },
      { role: "assistant", content: "old answer", timestamp: 2 },
      // One BIG last turn: ~50k tokens on a ~96k usable window, so no explicit landing
      // point below it can free anything.
      { role: "user", content: "do the thing", timestamp: 3 },
      { role: "assistant", content: "x".repeat(200_000), timestamp: 4 },
    ]);
    const lastPreview = (): any =>
      view.webview.postMessage.mock.calls
        .map((c) => c[0] as any)
        .filter((m) => m.type === "compactionPreview")
        .pop();

    await handler({ type: "previewCompaction", thresholdPercent: 80, targetPercent: 10 });
    const p = lastPreview();
    // The floor is DERIVED from this history, not the 1% unit.
    expect(p.minTargetPercent).toBeGreaterThan(40);
    // …and asking for less than it means "as low as the structure allows": 0.
    expect(p.targetPercent).toBe(0);

    // The SAME rule applies when the value is saved, not just previewed.
    await handler({ type: "setCompactionTarget", value: 10 });
    expect(rt.compactionTargetPercent).toBe(0);
  });

  it("a sub-agent compacts with the SESSION's landing point", async () => {
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\nsub");
    const options = { compactor: { summarize } as unknown as Compactor, compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.contextWindow = 100_000;
    rt.outputTokens = 4_096;
    const turns = (n: number) =>
      Array.from({ length: n }, (_, i) => [
        { role: "user" as const, content: `task ${i}`, timestamp: i * 2 },
        { role: "assistant" as const, content: "x".repeat(4000), timestamp: i * 2 + 1 },
      ]).flat();
    const subHistory = (n: number) => ({
      messages: turns(n) as ChatMessage[],
      conversation(): ChatMessage[] {
        return this.messages;
      },
      replace(next: ChatMessage[]): void {
        this.messages = next;
      },
    });

    // 5% of the usable window keeps a couple of turns…
    const lean = subHistory(60);
    rt.compactionTargetPercent = 5;
    expect(await provider.compactSubAgentHistory(lean as never, "s1")).toBe(true);

    // …40% keeps most of them: the policy is inherited, not re-invented per sub-agent.
    const deep = subHistory(60);
    rt.compactionTargetPercent = 40;
    expect(await provider.compactSubAgentHistory(deep as never, "s1")).toBe(true);

    expect(lean.messages.length).toBeLessThan(deep.messages.length);
    // A summary pair heads the rewritten history (nothing is persisted for a sub-agent).
    expect(lean.messages[0].synthetic).toBe(true);
  });

  it("buildConfig posts the EFFECTIVE landing point and whether AUTO is in force", async () => {
    const options = { compactor: new Compactor(compactorFactory()), compaction: DEFAULT_COMPACTION };
    const { provider } = buildHarness(options);
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    const lastConfig = (): any =>
      view.webview.postMessage.mock.calls
        .map((c) => c[0] as any)
        .filter((m) => m.type === "config")
        .pop()?.config;

    // No override: AUTO lands at an EIGHTH of the trigger (10% with the default 80).
    await handler({ type: "getConfig" });
    expect(lastConfig().compactionTargetPercent).toBe(10);
    expect(lastConfig().compactionTargetAuto).toBe(true);

    // …and it MOVES with the trigger, so the two knobs cannot go stale.
    await handler({ type: "setCompactionThreshold", value: 60 });
    await handler({ type: "getConfig" });
    expect(lastConfig().compactionTargetPercent).toBe(8);
    expect(lastConfig().compactionTargetAuto).toBe(true);

    // An explicit value is reported as such (the modal shows AUTO vs a decision).
    await handler({ type: "setCompactionTarget", value: 25 });
    await handler({ type: "getConfig" });
    expect(lastConfig().compactionTargetPercent).toBe(25);
    expect(lastConfig().compactionTargetAuto).toBe(false);
  });

  it("previewCompaction posts the plan the compaction will run (no model call)", async () => {
    const options = { compactor: new Compactor(compactorFactory()), compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.contextWindow = 100_000;
    const turns = (n: number) =>
      Array.from({ length: n }, (_, i) => [
        { role: "user" as const, content: `prompt ${i}`, timestamp: i * 2 },
        { role: "assistant" as const, content: "x".repeat(4000), timestamp: i * 2 + 1 },
      ]).flat();
    rt.history.replace(turns(60));
    const lastPreview = (): any =>
      view.webview.postMessage.mock.calls
        .map((c) => c[0] as any)
        .filter((m) => m.type === "compactionPreview")
        .pop();

    await handler({ type: "previewCompaction", thresholdPercent: 50, targetPercent: 20 });
    const p = lastPreview();
    expect(p.thresholdPercent).toBe(50);
    expect(p.targetPercent).toBe(20);
    // The target is a PERCENTAGE of the usable context: the modal can show both numbers.
    expect(p.targetTokens).toBe(Math.round(p.usableTokens * 0.2));
    expect(p.aboveThreshold).toBe(true);
    expect(p.summarizeCount).toBeGreaterThan(0);
    // The tail is what the summary does not take, so it never exceeds the landing point.
    expect(p.keepTokens).toBeLessThanOrEqual(p.targetTokens);
    expect(p.summaryBudgetTokens).toBeGreaterThan(0);
    // AUTO (an eighth of the trigger) and the derived FLOOR travel with the answer.
    expect(p.autoTargetPercent).toBe(Math.max(1, Math.round(50 / 8)));
    expect(typeof p.minTargetPercent).toBe("number");
    expect(p.minTargetPercent).toBeGreaterThanOrEqual(0);

    // Nothing to compact below the trigger: the modal says so instead of showing a plan.
    await handler({ type: "previewCompaction", thresholdPercent: 100, targetPercent: 20 });
    expect(lastPreview().aboveThreshold).toBe(false);
  });

  it("the landing point decides HOW MUCH survives (the session's own policy)", async () => {
    const options = { compactor: new Compactor(compactorFactory()), compaction: DEFAULT_COMPACTION };
    const { registry, provider } = buildHarness(options);
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    rt.contextWindow = 100_000;
    const turns = (n: number) =>
      Array.from({ length: n }, (_, i) => [
        { role: "user" as const, content: `prompt ${i}`, timestamp: i * 2 },
        { role: "assistant" as const, content: "x".repeat(4000), timestamp: i * 2 + 1 },
      ]).flat();
    rt.history.replace(turns(60));
    const lastPreview = (): any =>
      view.webview.postMessage.mock.calls
        .map((c) => c[0] as any)
        .filter((m) => m.type === "compactionPreview")
        .pop();

    await handler({ type: "previewCompaction", thresholdPercent: 90, targetPercent: 5 });
    const lean = lastPreview();
    await handler({ type: "previewCompaction", thresholdPercent: 90, targetPercent: 45 });
    const deep = lastPreview();
    // A lower landing point summarizes MORE and keeps LESS verbatim — that is the setting.
    expect(lean.summarizeCount).toBeGreaterThan(deep.summarizeCount);
    expect(lean.keepTokens).toBeLessThan(deep.keepTokens);
  });

  it("auto-compaction follows the session's custom threshold %", async () => {
    const options = {
      compactor: new Compactor(compactorFactory()),
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
      compactor: new Compactor(compactorFactory()),
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
    expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "status", active: false }));
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
    const options = { compactor: new Compactor(failingFactory), compaction: DEFAULT_COMPACTION };
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
    const options = { compactor: new Compactor(compactorFactory()), compaction: DEFAULT_COMPACTION };
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
    // Mid-run the transcript IS re-rendered now — the divider and the card have to appear
    // at once — and `ok: true` leaves the pointer to it where the reader is.
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "compactDone", ok: true });
    // The run is still going: NO status message may turn the working bar off.
    expect(view.webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "status", active: false }),
    );
  });

  it("mid-run auto-compaction is a no-op below the threshold", async () => {
    const options = { compactor: new Compactor(compactorFactory()), compaction: DEFAULT_COMPACTION };
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
      compactor: new Compactor(compactorFactory()),
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
    expect(store.saveSettings as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    // Exactly the button's visible flow: bubble -> block -> note -> release.
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "compactStart" });
    expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "refresh" }));
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "status", active: true, message: "Compacting…" }),
    );
    expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "status", active: false }));
  });

  it("does NOT auto-compact after a response that stays under the threshold", async () => {
    const options = {
      compactor: new Compactor(compactorFactory()),
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
      compactor: new Compactor(compactorFactory()),
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
      compactor: new Compactor(compactorFactory()),
      compaction: DEFAULT_COMPACTION,
    };
    const { registry, provider } = buildHarness(options);
    const { handler, view } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "m", provider: "p" });
    const rt = registry.get("s1")!;
    expect(rt.contextWindow).toBe(128000); // the DEFAULT window applies
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

  it("shows a QUEUED message in the transcript the moment it starts running", async () => {
    const attachments = {
      pick: vi.fn(async () => []),
      buildContext: vi.fn(async () => ({
        text: "FILE CONTENTS",
        images: ["data:image/png;base64,iVBORw0KGgo="],
        parts: [],
      })),
    } as unknown as AttachmentService;
    const { handler, agent, view } = await setupStreaming({ attachments });
    // Its turn has come: the previous run is over and the queued message starts.
    agent.streaming = false;
    view.webview.postMessage.mockClear();

    // The view did NOT append a bubble when this was typed (it waited in the
    // pending footer) and the host owns that list, so without this post the row
    // vanished and the transcript stayed empty until the end-of-run refresh.
    await handler({
      type: "send",
      mode: "queue",
      text: "look here",
      attachments: [{ name: "relazione.pdf", path: "/tmp/relazione.pdf", size: 42, isImage: false }],
    });

    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: "userMessage",
      content: "look here",
      attachments: [{ name: "relazione.pdf", path: "/tmp/relazione.pdf", size: 42, isImage: false }],
      images: ["data:image/png;base64,iVBORw0KGgo="],
    });
  });

  it("does NOT re-post the bubble for a direct send (the view already showed it)", async () => {
    const { handler, agent, view } = await setupStreaming();
    agent.streaming = false;
    view.webview.postMessage.mockClear();

    await handler({ type: "send", text: "hello" });

    expect(view.webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "userMessage" }));
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

  it("adopts the context window the provider STATES, so the budget math stops guessing", async () => {
    // An unknown (local) model falls back to the 128k default, which is OPTIMISTIC:
    // the compaction threshold never fires and every request risks a rejection. The
    // rejection itself names the truth, so the session adopts it — before compacting,
    // so the compaction math below already uses the real window.
    const { provider, registry, store } = buildHarness({
      providerEntry: { name: "p", baseUrl: "https://x/v1", models: [{ id: "m1" }] },
    });
    const { handler } = resolveWith(provider);
    await provider.createNew();
    await handler({ type: "setModel", model: "m1", provider: "p" });
    const rt = registry.get("s1")!;
    expect(rt.contextWindow).toBe(128000); // the fallback

    const compacted = await provider.compactForOverflow("s1", undefined, { limitTokens: 8192, signature: "llama.cpp" });

    expect(rt.contextWindow).toBe(8192);
    // Persisted: it is a property of the MODEL, so the next session with it starts
    // from the truth instead of from the fallback.
    expect(store.saveSettings).toHaveBeenCalledWith("s1", expect.objectContaining({ contextWindow: 8192 }));
    // Nothing to summarize here, so the agent is told not to retry.
    expect(compacted).toBe(false);
  });

  it("adopts a LARGER stated window too, and ignores a redundant one", async () => {
    const { provider, registry, store } = buildHarness({
      providerEntry: { name: "p", baseUrl: "https://x/v1", models: [{ id: "m1" }] },
    });
    const { handler } = resolveWith(provider);
    await provider.createNew();
    await handler({ type: "setModel", model: "m1", provider: "p" });
    const rt = registry.get("s1")!;

    await provider.compactForOverflow("s1", undefined, { limitTokens: 200000 });
    expect(rt.contextWindow).toBe(200000); // the model really is bigger: use it
    store.saveSettings.mockClear();

    await provider.compactForOverflow("s1", undefined, { limitTokens: 200000 });
    expect(store.saveSettings).not.toHaveBeenCalled(); // no redundant write
  });

  it("does NOT touch the window when the rejection stated no limit", async () => {
    const { provider, registry, store } = buildHarness({
      providerEntry: { name: "p", baseUrl: "https://x/v1", models: [{ id: "m1" }] },
    });
    const { handler } = resolveWith(provider);
    await provider.createNew();
    await handler({ type: "setModel", model: "m1", provider: "p" });
    const rt = registry.get("s1")!;
    store.saveSettings.mockClear();

    // Unrecognised wording: we compact (the caller decided it was an overflow) but we
    // do not invent a window we were not told.
    await provider.compactForOverflow("s1", undefined, { signature: "generic" });

    expect(rt.contextWindow).toBe(128000);
    expect(store.saveSettings).not.toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ contextWindow: expect.anything() }),
    );
  });

  it("a MID-RUN refresh carries the live answer (a rebuild must not eat it)", async () => {
    // Reported bug: a response began mid-word. The host was fine (the text is in the
    // session DB) and the streaming path is fine (see the webview tests); what lost it
    // was a refresh landing mid-run: the view rebuilds from committed messages, and
    // the in-flight turn is not committed. It now travels with the refresh.
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\nx");
    const { provider, registry } = buildHarness({
      compactor: { summarize } as unknown as Compactor,
      compaction: DEFAULT_COMPACTION,
      emitEvents: true,
    });
    const { view } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;
    const agent: any = rt.agent;
    rt.history.replace([
      { role: "user", content: "a", timestamp: 1 },
      { role: "assistant", content: "b", timestamp: 2 },
      { role: "user", content: "c", timestamp: 3 },
      { role: "assistant", content: "d", timestamp: 4 },
      { role: "user", content: "e", timestamp: 5 },
      { role: "assistant", content: "f", timestamp: 6 },
      { role: "user", content: "g", timestamp: 7 },
      { role: "assistant", content: "h", timestamp: 8 },
    ]);
    const sentence = "I have everything to describe them without inventing anything. Writing the section";
    agent.streaming = true;
    agent.emit({ type: "text_delta", content: sentence }); // the StreamTee accumulates it
    view.webview.postMessage.mockClear();

    const compacted = await provider.compactForOverflow("s1");

    expect(compacted).toBe(true);
    const refresh = view.webview.postMessage.mock.calls.map((c) => c[0]).find((m: any) => m?.type === "refresh");
    expect(refresh).toMatchObject({ streaming: true, liveAnswer: sentence });
  });

  it("does NOT ship a live buffer on a refresh when nothing is running", async () => {
    // The live text belongs to a RUN. A refresh at rest (a ✂ cut, a skill, the end
    // of a run) must not resurrect a bubble that is no longer being written.
    const summarize = vi.fn(async () => "Summary of past interactions\n---\n## Goal\nx");
    const { provider, registry } = buildHarness({
      compactor: { summarize } as unknown as Compactor,
      compaction: DEFAULT_COMPACTION,
      emitEvents: true,
    });
    const { view } = resolveWith(provider);
    await provider.createNew();
    const rt = registry.get("s1")!;
    rt.history.replace([
      { role: "user", content: "a", timestamp: 1 },
      { role: "assistant", content: "b", timestamp: 2 },
      { role: "user", content: "c", timestamp: 3 },
      { role: "assistant", content: "d", timestamp: 4 },
      { role: "user", content: "e", timestamp: 5 },
      { role: "assistant", content: "f", timestamp: 6 },
      { role: "user", content: "g", timestamp: 7 },
      { role: "assistant", content: "h", timestamp: 8 },
    ]);
    (rt.agent as any).streaming = false;

    await provider.compactForOverflow("s1");

    const refresh = view.webview.postMessage.mock.calls.map((c) => c[0]).find((m: any) => m?.type === "refresh");
    expect(refresh).toBeTruthy();
    expect(refresh).not.toHaveProperty("liveAnswer");
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

  it("routes a conversion to the queue: a queued message becomes a real steer", async () => {
    const { handler, agent, pending, view } = await setupStreaming();
    await handler({ type: "send", mode: "queue", id: "q1", text: "hurry" });
    expect(agent.steer).not.toHaveBeenCalled();
    view.webview.postMessage.mockClear();

    await handler({ type: "setPendingMode", id: "q1", mode: "steer" });

    // The agent now holds it as a steer draft…
    await vi.waitFor(() => expect(agent.steer).toHaveBeenCalledWith("q1", "hurry", expect.objectContaining({})));
    // …and the view is told, so the badge flips.
    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: "pending",
      items: [expect.objectContaining({ id: "q1", mode: "steer" })],
    });
    expect(pending()).toEqual([expect.objectContaining({ id: "q1", mode: "steer" })]);
  });

  it("routes a conversion to the queue: a steer is WITHDRAWN from the agent", async () => {
    const { handler, agent, pending } = await setupStreaming();
    await handler({ type: "send", mode: "steer", id: "s1x", text: "wait" });
    await vi.waitFor(() => expect(agent.steer).toHaveBeenCalled());

    await handler({ type: "setPendingMode", id: "s1x", mode: "queue" });

    expect(agent.cancelSteer).toHaveBeenCalledWith("s1x");
    expect(pending()).toEqual([expect.objectContaining({ id: "s1x", mode: "queue" })]);
  });

  it("ignores a conversion with an unknown mode or id (no crash, no state change)", async () => {
    const { handler, agent, pending } = await setupStreaming();
    await handler({ type: "send", mode: "queue", id: "q1", text: "later" });

    await handler({ type: "setPendingMode", id: "q1", mode: "sideways" });
    await handler({ type: "setPendingMode", id: "ghost", mode: "steer" });

    expect(pending()).toEqual([expect.objectContaining({ id: "q1", mode: "queue" })]);
    expect(agent.steer).not.toHaveBeenCalled();
    expect(agent.cancelSteer).not.toHaveBeenCalled();
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
    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: "steerApplied",
      ids: ["s1x"],
      content: "x",
      sessionId: "s1",
    });
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
      sessionId: "s1",
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

  it("caps a config maxTokens at the scale maximum AND at the room left in the window", async () => {
    const { provider, registry, agentConfig } = buildHarness({
      providerEntry: { name: "p", baseUrl: "https://x/v1", maxTokens: 999_999, models: [{ id: "m1" }] },
    });
    const { handler } = resolveWith(provider);
    await provider.createNew();
    await handler({ type: "setModel", model: "m1", provider: "p" });
    // The CONFIGURED budget keeps the scale cap (524 288) — that is the value the
    // UI shows and the user edits.
    expect(registry.get("s1")!.outputTokens).toBe(524_288);
    // The REQUEST budget is additionally clamped to the room left: with no measured
    // input yet, a 128k window leaves the margin. Sending 512k of output on top of
    // any input is exactly what the provider rejects.
    // The margin SCALES (min(8192, 5% of the window)): on 128k that is 6.4k, and
    // the 8192 it was tuned at only applies from 164k up — a fixed 8k would be 100%
    // of an 8k model's window, i.e. no room at all for its own answer.
    expect(agentConfig("s1")).toMatchObject({ maxTokens: 121_600 });
  });

  it("clamps the output budget to the room left: the request must FIT `input + max_tokens ≤ window`", async () => {
    const { provider, registry, agentConfig } = buildHarness({
      providerEntry: { name: "p", baseUrl: "https://x/v1", models: [{ id: "m1" }] },
    });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    await handler({ type: "setModel", model: "m1", provider: "p" });
    const rt = registry.get("s1")!;
    const lastMaxTokens = (): number | undefined => agentConfig("s1").maxTokens as number | undefined;

    // The REAL numbers of the session that failed: 1M window, 384k output, and
    // an input of 666.820 tokens. The provider counts both against the window,
    // so the un-clamped request was 1.050.820 on a 1.048.576 window → 400
    // invalid_request_error and the run died.
    rt.contextWindow = 1_048_576;
    rt.contextTokens = 666_820;
    expect(666_820 + 384_000).toBeGreaterThan(1_048_576);
    await handler({ type: "setOutputTokens", value: 384_000 });
    const clamped = lastMaxTokens();
    expect(clamped).toBe(373_564); // 1.048.576 − 666.820 input − 8.192 margin
    // The clamped request now fits the window exactly, margin included.
    expect(666_820 + clamped! + 8_192).toBe(1_048_576);
    // The UI keeps the value the USER chose: only the request is clamped.
    expect(rt.outputTokens).toBe(384_000);

    // A config that already fits is left alone (no surprise shrink).
    rt.contextWindow = 1_048_576;
    rt.contextTokens = 100_000;
    await handler({ type: "setOutputTokens", value: 16_384 });
    expect(lastMaxTokens()).toBe(16_384);

    // The session's OWN editor floors the value when it is SET from the UI
    // (toOutputTokens applies MIN_OUTPUT_TOKENS = 8): 123 is left alone, because
    // it is already above the floor. The clamp is NOT the thing that raises it —
    // and it never RAISES a value either: a provider entry declaring maxTokens:
    // 123 keeps 123 (see the setModel tests).
    rt.contextTokens = 100_000;
    await handler({ type: "setOutputTokens", value: 123 });
    expect(lastMaxTokens()).toBe(123);

    // When the context is already over the limit the clamp floors at the minimum
    // instead of going negative — the fix for that state is a compaction, not a
    // longer request (the auto-compact trigger fires on the usable budget).
    rt.contextTokens = 1_048_576;
    await handler({ type: "setOutputTokens", value: 384_000 });
    expect(lastMaxTokens()).toBe(8);
  });

  it("leaves the config chain alone for a session with NO model (an override would shadow it)", async () => {
    // The per-turn clamp writes `maxTokens` into the shared runtime overrides. On
    // a session with no model selected there is nothing to clamp — and writing
    // anything would SHADOW the provider entry / file / settings that legitimately
    // own maxTokens (a provider declaring 123 would silently become the default).
    const { provider, registry, agentConfig } = buildHarness({
      providerEntry: { name: "p", baseUrl: "https://x/v1", maxTokens: 123, models: [{ id: "m1" }] },
    });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1, no model yet
    const rt = registry.get("s1")!;
    expect(rt.model).toBeUndefined();
    const before = agentConfig("s1");

    // The turn boundary is where the clamp is applied during a run.
    await provider.maybeCompactDuringRun("s1");
    expect(agentConfig("s1")).toEqual(before);

    // Selecting a model then DOES apply it, and it honours the entry's 123.
    await handler({ type: "setModel", model: "m1", provider: "p" });
    expect(agentConfig("s1")).toMatchObject({ maxTokens: 123 });
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
        .map(
          (c: unknown[]) => c[0] as { type?: string; config?: { maxContextWindow?: number; maxOutputTokens?: number } },
        )
        .filter((m) => m?.type === "config");
      expect(configs.some((c) => c.config?.maxContextWindow === 128000 && c.config?.maxOutputTokens === 16384)).toBe(
        true,
      );
    });
  });
});

describe("ChatViewProvider models.dev unreachable warning", () => {
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

describe("ChatViewProvider adopts limits on session open", () => {
  it("adopts the model's DETECTED context/output when switching to a session that has none", async () => {
    const { registry, provider } = buildHarness({
      config: { ...CONFIG, hostModelProviders: ["opencode-go"] },
      providerEntry: { name: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1", models: [] },
      fetchModelInfos: async () => [{ id: "deepseek-v4.1-flash", contextLength: 1000000, maxOutputTokens: 262144 }],
      modelsDev: { getLimits: vi.fn(async () => ({})) },
    });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1 (active)
    await provider.createNew(); // s2 (active)
    const rt = registry.get("s1")!;
    // A session created BEFORE the limits feature: model set, no overrides.
    rt.model = "deepseek-v4.1-flash";
    rt.modelProvider = "opencode-go";
    rt.contextWindow = undefined;
    rt.outputTokens = undefined;

    await handler({ type: "switchTab", id: "s1" });

    await vi.waitFor(() => expect(rt.outputTokens).toBe(262144));
    expect(rt.contextWindow).toBe(1000000);
  });
});

describe("ChatViewProvider model/config switch hygiene", () => {
  it("refresh() re-applies the per-model overrides so a CONFIG edit takes effect", async () => {
    const { provider, agentConfig } = buildHarness({
      providerEntry: { name: "p", baseUrl: "https://x/v1", models: [{ id: "m1" }] },
    });
    const { handler } = resolveWith(provider);
    await provider.createNew();
    await handler({ type: "setModel", model: "m1", provider: "p" });
    // The derived config reads the chain on every call, so the value shown is the one
    // the next request will use — there is no copy that a stale edit could shadow.
    // (`configuredBaseUrl` is what the harness catalog reports for the entry.)
    provider.refresh(); // the config-watcher path
    expect(agentConfig("s1")).toMatchObject({ model: "m1", baseUrl: "https://x/v1" });
  });

  it("clears a stale thinking level when switching to a NON-reasoning provider", async () => {
    const entries: Record<string, unknown> = {
      reason: { name: "reason", baseUrl: "https://x/v1", thinkingMode: "effort", models: [{ id: "m1" }] },
      plain: { name: "plain", baseUrl: "https://y/v1", models: [{ id: "m1" }] },
    };
    const providers = {
      getProvider: (n: string) => entries[n],
      saveModelSelection: vi.fn(),
      readProvidersEditor: vi.fn(() => ({ providers: {} })),
      saveProvidersEditor: vi.fn(() => true),
      readMcpServers: vi.fn(() => ({})),
      saveMcpServers: vi.fn(() => true),
    } as unknown as import("../core/config/types").ProviderCatalog;
    const { registry, provider } = buildHarness({ providers });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;

    await handler({ type: "setModel", model: "m1", provider: "reason" });
    expect(rt.thinkingLevel).toBe("medium");

    await handler({ type: "setModel", model: "m1", provider: "plain" });
    expect(rt.thinkingLevel).toBeUndefined();
  });
});

describe("ChatViewProvider limits on switching to an UNKNOWN model", () => {
  it("resets context + output to the DEFAULTS (128k / 8192), not the previous model's", async () => {
    const { registry, provider } = buildHarness({
      providerEntry: { name: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1", models: [] },
      fetchModelInfos: async () => [{ id: "known", contextLength: 1000000, maxOutputTokens: 262144 }],
      modelsDev: { getLimits: vi.fn(async () => ({})) },
    });
    const { handler } = resolveWith(provider);
    await provider.createNew(); // s1
    const rt = registry.get("s1")!;

    await handler({ type: "setModel", model: "known", provider: "opencode-go" });
    expect(rt.contextWindow).toBe(1000000);
    expect(rt.outputTokens).toBe(262144);

    // A model the host does NOT report and models.dev does not know.
    await handler({ type: "setModel", model: "mystery", provider: "opencode-go" });
    await vi.waitFor(() => expect(rt.contextWindow).toBe(128000));
    expect(rt.outputTokens).toBe(8192);
  });
});

describe("ChatViewProvider config-change + enrichment robustness", () => {
  it("re-applies the model overrides when a harny.* setting changes", async () => {
    const { provider, agentConfig } = buildHarness({
      providerEntry: { name: "p", baseUrl: "https://x/v1", models: [{ id: "m1" }] },
    });
    const { handler } = resolveWith(provider);
    await provider.createNew();
    await handler({ type: "setModel", model: "m1", provider: "p" });
    // The host fires onDidChangeConfiguration for a harny.* setting.
    state.configListener?.({ affectsConfiguration: (s: string) => s === "harny" });

    expect(agentConfig("s1")).toMatchObject({ model: "m1", baseUrl: "https://x/v1" });
  });

  it("survives a models.dev failure during the background list enrichment", async () => {
    const { provider } = buildHarness({
      config: { ...CONFIG, hostModelProviders: ["opencode-go"] },
      providerEntry: { name: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1", models: [] },
      fetchModelInfos: async () => [{ id: "m1" }],
      modelsDev: {
        getLimits: vi.fn(async () => {
          throw new Error("offline");
        }),
      },
    });
    const { view } = resolveWith(provider);
    await new Promise((r) => setTimeout(r, 30));
    // No crash: the HTML was still produced (the enrichment is best-effort).
    expect(view.webview.html).toContain('id="sessions"');
  });
});
