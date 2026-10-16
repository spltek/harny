import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** VS Code surface used by the composition root (extension.ts). */
const state = vi.hoisted(() => ({
  registerWebviewViewProvider: vi.fn(() => ({ dispose: () => {} })),
  onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: () => {} })),
  onDidChangeConfiguration: vi.fn(() => ({ dispose: () => {} })),
  executeCommand: vi.fn(async () => undefined),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showOpenDialog: vi.fn(async () => undefined),
  createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), dispose: vi.fn() })),
  workspaceFolders: undefined as { uri: { fsPath: string } }[] | undefined,
}));

vi.mock("vscode", () => ({
  window: {
    createOutputChannel: state.createOutputChannel,
    showErrorMessage: state.showErrorMessage,
    showInformationMessage: state.showInformationMessage,
    showOpenDialog: state.showOpenDialog,
    registerWebviewViewProvider: state.registerWebviewViewProvider,
  },
  commands: { executeCommand: state.executeCommand },
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
  it("activates without errors: opens the DB, wires the view provider and returns the sessions manager", async () => {
    const { activate } = await import("./extension");
    const subscriptions: { dispose(): void }[] = [];
    const context = {
      globalStorageUri: { fsPath: home },
      extensionUri: { fsPath: "/ext" },
      subscriptions,
    };

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
    for (const d of [...subscriptions].reverse()) {
      try {
        d.dispose();
      } catch {
        /* best-effort */
      }
    }
  }, 30_000);
});
