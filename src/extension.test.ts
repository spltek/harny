import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** VS Code surface used by the composition root (extension.ts). */
const state = vi.hoisted(() => ({
  registerWebviewViewProvider: vi.fn(() => ({ dispose: () => {} })),
  onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: () => {} })),
  onDidGrantWorkspaceTrust: vi.fn(() => ({ dispose: () => {} })),
  onDidChangeConfiguration: vi.fn(() => ({ dispose: () => {} })),
  executeCommand: vi.fn(async () => undefined),
  registerCommand: vi.fn(() => ({ dispose: () => {} })),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(async () => undefined),
  showOpenDialog: vi.fn(async () => undefined),
  createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), dispose: vi.fn() })),
  workspaceFolders: undefined as { uri: { fsPath: string } }[] | undefined,
  /** Workspace Trust verdict: false = Restricted Mode (the panel must stay, the writes not). */
  isTrusted: true,
}));

vi.mock("vscode", () => ({
  window: {
    createOutputChannel: state.createOutputChannel,
    showErrorMessage: state.showErrorMessage,
    showInformationMessage: state.showInformationMessage,
    showWarningMessage: state.showWarningMessage,
    showOpenDialog: state.showOpenDialog,
    registerWebviewViewProvider: state.registerWebviewViewProvider,
  },
  commands: { executeCommand: state.executeCommand, registerCommand: state.registerCommand },
  workspace: {
    get workspaceFolders() {
      return state.workspaceFolders;
    },
    getConfiguration: () => ({
      get: (_key: string, fallback: unknown) => fallback,
      update: vi.fn(),
    }),
    onDidChangeConfiguration: state.onDidChangeConfiguration,
    onDidChangeWorkspaceFolders: state.onDidChangeWorkspaceFolders,
    // Workspace Trust: `isTrusted` is read LIVE before every mode decision, and granting trust
    // re-pushes the panel. The PROPERTY may be absent (undefined = trusted, which is what this
    // mock means); the SUBSCRIPTION may not — activation would throw a TypeError without it.
    get isTrusted() {
      return state.isTrusted;
    },
    onDidGrantWorkspaceTrust: state.onDidGrantWorkspaceTrust,
    fs: {
      writeFile: vi.fn(async () => {}),
      readFile: vi.fn(async () => new Uint8Array()),
    },
  },
  languages: { getDiagnostics: () => [] },
  Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) },
}));

describe("extension activate (smoke)", () => {
  let home: string;
  let savedHarnyHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "harny-ext-"));
    state.workspaceFolders = [{ uri: { fsPath: "/workspace" } }];
    state.isTrusted = true;
    savedHarnyHome = process.env.HARNY_HOME;
    delete process.env.HARNY_HOME; // always use the temp globalStorage
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (savedHarnyHome === undefined) delete process.env.HARNY_HOME;
    else process.env.HARNY_HOME = savedHarnyHome;
    rmSync(home, { recursive: true, force: true });
  });

  // It boots the REAL composition root (the whole core is imported, a SQLite database is
  // opened in a temp home), so it is an integration test living in the unit suite: the 5s
  // default is a unit-test default and Windows runners need more than that (it timed out
  // at 5.75s there while ubuntu and macos passed).
  /**
   * An ExtensionContext with the two pieces that survive a WINDOW RELOAD: the temp
   * globalStorage (the database) and `globalState` (the gesture marker, see
   * pending-open.ts). Calling `dispose()` is the honest "window is going away".
   */
  function makeContext(): {
    context: Record<string, unknown>;
    globalState: Map<string, unknown>;
    dispose: () => void;
  } {
    const subscriptions: { dispose(): void }[] = [];
    const globalState = new Map<string, unknown>();
    const context = {
      globalStorageUri: { fsPath: home },
      extensionUri: { fsPath: "/ext" },
      subscriptions,
      globalState: {
        get: (key: string, fallback: unknown) => globalState.get(key) ?? fallback,
        update: async (key: string, value: unknown) => {
          globalState.set(key, value);
        },
      },
    };
    const dispose = (): void => {
      for (const d of [...subscriptions].reverse()) {
        try {
          d.dispose();
        } catch {
          /* best-effort */
        }
      }
    };
    return { context, globalState, dispose };
  }

  /** A WebviewView good enough for `resolveWebviewView` (the panel, stubbed). */
  function makePanel(opts: { visible?: boolean } = {}): {
    view: Record<string, unknown>;
    postMessage: ReturnType<typeof vi.fn>;
  } {
    const postMessage = vi.fn();
    return {
      postMessage,
      view: {
        visible: opts.visible === true,
        webview: {
          html: "",
          cspSource: "vscode-webview://test",
          options: {},
          onDidReceiveMessage: vi.fn(),
          postMessage,
          asWebviewUri: () => ({
            with: (opts: { query: string }) => ({ toString: () => "https://r/view.js?" + opts.query }),
            toString: () => "https://r/view.js",
          }),
        },
      },
    };
  }

  /** The provider the composition root registered (there is exactly one per activation). */
  function registeredProvider(): any {
    return state.registerWebviewViewProvider.mock.calls.at(-1)?.[1];
  }

  /** The marker the provider writes BEFORE `vscode.openFolder` tears the host down. */
  async function rememberGesture(context: Record<string, unknown>, value: unknown): Promise<void> {
    const memento = context.globalState as { update: (key: string, value: unknown) => Promise<void> };
    await memento.update("harny.pendingOpen", value);
  }

  it("activates without errors: opens the DB, wires the view provider and returns the sessions manager", async () => {
    const { activate } = await import("./extension");
    const { context, dispose } = makeContext();

    const sessions = await activate(context as never);

    // The composition root returned the SessionManager…
    expect(sessions).toBeTruthy();
    // …it created the session database in the (temp) home…
    expect(existsSync(join(home, "sessions.db"))).toBe(true);
    // …and registered the chat view provider.
    expect(state.registerWebviewViewProvider).toHaveBeenCalledWith(
      "harny.chatView",
      expect.anything(),
      expect.anything(),
    );
    // No startup error was surfaced.
    expect(state.showErrorMessage).not.toHaveBeenCalled();

    // Clean shutdown: dispose everything the extension registered (closes the DB).
    dispose();
  }, 30_000);

  it("Restricted Mode (untrusted folder): the panel IS resolved, and its state says so", async () => {
    // The field report was an empty side bar: without `capabilities.untrustedWorkspaces` the
    // extension is DISABLED in Restricted Mode and contributes no view at all. The manifest is
    // pinned in package-manifest.test.ts; this asserts the OTHER half — the view really resolves
    // in that state, and the panel is TOLD the truth (`workspaceTrusted: false`), which is what
    // disables Build and keeps the pill on Analyze.
    const { activate } = await import("./extension");
    const { context, dispose } = makeContext();
    state.isTrusted = false;

    await activate(context as never);
    // Granting trust has to reach the panel without a reload (the handler rebuilds it).
    expect(state.onDidGrantWorkspaceTrust).toHaveBeenCalled();

    const panel = makePanel();
    registeredProvider().resolveWebviewView(panel.view, {}, {});
    await vi.waitFor(() => expect(String((panel.view.webview as any).html)).toContain('"workspaceTrusted":false'), {
      timeout: 5000,
    });

    // …and the same page, after “Trust” at the top of the window, carries the new verdict: the
    // whole panel (mode, Build choice, skills catalog) follows from this one live value.
    state.isTrusted = true;
    const onGrant = state.onDidGrantWorkspaceTrust.mock.calls[0]?.[0] as (() => void) | undefined;
    expect(typeof onGrant).toBe("function");
    onGrant!();
    await vi.waitFor(() => expect(String((panel.view.webview as any).html)).toContain('"workspaceTrusted":true'), {
      timeout: 5000,
    });
    dispose();
  }, 30_000);

  it("finishes a 'New session' gesture: the naming modal is waiting after the reload", async () => {
    const { activate } = await import("./extension");
    const { context, globalState, dispose } = makeContext();
    // The workspace root must be a REAL folder: a session whose folder is gone is never
    // opened (see openSessionId), and these tests are about the gesture, not about that guard.
    state.workspaceFolders = [{ uri: { fsPath: home } }];
    // What the click wrote BEFORE the folder opened (the host is about to be torn down).
    await rememberGesture(context, { folder: home, action: { kind: "create" }, at: Date.now() });

    await activate(context as never);
    // The panel appears (it is restored by VS Code after the reload): the gesture runs.
    const panel = makePanel();
    registeredProvider().resolveWebviewView(panel.view, {}, {});
    await vi.waitFor(
      () =>
        expect(panel.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: "modal", kind: "name", mode: "create" }),
        ),
      { timeout: 2000 },
    );
    // Consume-once: the marker is gone, so the next activation has nothing to do.
    expect(globalState.get("harny.pendingOpen")).toBeUndefined();
    dispose();
  }, 30_000);

  it("finishes an 'open that session' gesture across a REAL reload (two hosts, one database)", async () => {
    const { activate } = await import("./extension");
    // A folder that really exists: the temp home IS the workspace root here.
    state.workspaceFolders = [{ uri: { fsPath: home } }];
    // FIRST host: the session exists in this workspace.
    const first = makeContext();
    const sessions = await activate(first.context as never);
    const created = sessions.create("Casa");
    sessions.saveSettings(created.id, { folder: home });
    first.dispose(); // the window reloads on the folder the user chose

    // SECOND host: the marker is all that survived, and it names the folder + session.
    const second = makeContext();
    await rememberGesture(second.context, {
      folder: home,
      action: { kind: "session", sessionId: created.id },
      at: Date.now(),
    });
    await activate(second.context as never);

    const panel = makePanel();
    registeredProvider().resolveWebviewView(panel.view, {}, {});
    await vi.waitFor(
      () =>
        expect(panel.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: "switchView", activeId: created.id }),
        ),
      { timeout: 5000 },
    );
    second.dispose();
  }, 30_000);

  it("a workspace whose FOLDER was deleted is not ready, and the panel offers another one", async () => {
    const { activate } = await import("./extension");
    const { context, dispose } = makeContext();
    // VS Code keeps such a workspace open: the folder is the root, but it is not on disk.
    state.workspaceFolders = [{ uri: { fsPath: join(home, "gone-folder") } }];

    await activate(context as never);
    const panel = makePanel();
    registeredProvider().resolveWebviewView(panel.view, {}, {});
    const html = () => (panel.view.webview as { html: string }).html;
    await vi.waitFor(() => expect(html()).toContain('id="harny-view-init"'), { timeout: 2000 });
    const raw = html().match(/id="harny-view-init" type="application\/json">([\s\S]*?)<\/script>/);
    const init = JSON.parse(raw![1] as string);
    // Not usable → the home screen, and the hero can name the path it lost.
    expect(init.config.workspaceReady).toBe(false);
    expect(init.config.workspaceFolderCount).toBe(1);
    expect(init.config.workspaceFolder).toBe(join(home, "gone-folder"));
    dispose();
  }, 30_000);

  it("notices the workspace folder DISAPPEARING while the panel sits still", async () => {
    const { activate } = await import("./extension");
    const { context, dispose } = makeContext();
    // A real folder we can delete from outside, the way a `rm -rf` would.
    const rootDir = mkdtempSync(join(home, "ws-"));
    state.workspaceFolders = [{ uri: { fsPath: rootDir } }];
    // Only the INTERVAL is faked (the watcher polls on it): activation and `waitFor` keep
    // their real timers, so nothing else about the boot changes.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await activate(context as never);
      const panel = makePanel();
      registeredProvider().resolveWebviewView(panel.view, {}, {});
      const html = () => (panel.view.webview as { html: string }).html;
      await vi.waitFor(() => expect(html()).toContain('"workspaceReady":true'), { timeout: 2000 });

      // Nobody clicks anything: the folder simply goes away.
      rmSync(rootDir, { recursive: true, force: true });
      vi.advanceTimersByTime(6000); // one poll

      // The panel rebuilds itself into the home screen (and names the folder).
      await vi.waitFor(
        () => {
          expect(html()).toContain('"workspaceReady":false');
          // The folder travels JSON-ENCODED in the page, so the expectation must be encoded the
          // same way: on Windows `rootDir` is `C:\Users\…` and the page carries `C:\\Users\\…`,
          // which is why a raw path substring failed there and only there.
          expect(html()).toContain('"workspaceFolder":' + JSON.stringify(rootDir));
        },
        { timeout: 2000 },
      );
      // …and the user is TOLD, where the eye is: a native non-modal toast carrying the one
      // action that fixes it (a modal would block the panel).
      expect(state.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("no longer exists"),
        "Change folder…",
      );
    } finally {
      vi.useRealTimers();
      dispose();
    }
  }, 30_000);

  it("does NOT shout twice: with the panel on screen the banner is the notice, not a toast", async () => {
    const { activate } = await import("./extension");
    const { context, dispose } = makeContext();
    state.showWarningMessage.mockClear();
    const rootDir = mkdtempSync(join(home, "ws-"));
    state.workspaceFolders = [{ uri: { fsPath: rootDir } }];
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await activate(context as never);
      const panel = makePanel({ visible: true }); // the view IS on screen (the field case)
      registeredProvider().resolveWebviewView(panel.view, {}, {});
      const html = () => (panel.view.webview as { html: string }).html;
      await vi.waitFor(() => expect(html()).toContain('"workspaceReady":true'), { timeout: 2000 });

      rmSync(rootDir, { recursive: true, force: true });
      vi.advanceTimersByTime(6000);

      // The panel rebuilt itself and says it in the transcript…
      await vi.waitFor(() => expect(html()).toContain('"workspaceReady":false'), { timeout: 2000 });
      // …and no toast repeated the same fact in the corner of the screen.
      expect(state.showWarningMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      dispose();
    }
  }, 30_000);

  it("discards a marker that belongs to ANOTHER folder (it must never fire in the wrong project)", async () => {
    const { activate } = await import("./extension");
    const { context, globalState, dispose } = makeContext();
    state.workspaceFolders = [{ uri: { fsPath: home } }];
    await rememberGesture(context, { folder: "/somewhere/else", action: { kind: "create" }, at: Date.now() });

    await activate(context as never);
    const panel = makePanel();
    registeredProvider().resolveWebviewView(panel.view, {}, {});
    // Consumed and dropped, without opening anything.
    await vi.waitFor(() => expect(globalState.get("harny.pendingOpen")).toBeUndefined(), { timeout: 2000 });
    expect(panel.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "modal" }));
    dispose();
  }, 30_000);
});
