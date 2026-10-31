import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  VscodeWorkspacePorts,
  WorkspaceActions,
  type FolderPickOptions,
  type WorkspacePorts,
} from "./workspace-actions";

/**
 * The folder-opening flows, WITHOUT a host.
 *
 * `WorkspaceActions` is the thin seam over two capabilities, so what is tested here is
 * what a regression would break silently: the options a flow passes are the options the
 * dialog receives, a cancel answers `undefined` (the caller stops), and the folder is
 * opened in the CURRENT window. The sequencing around it ("pick, remember, open") lives
 * in the provider, which is where it can be tested as a whole.
 */

const state = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  executeCommand: vi.fn(async () => undefined),
  /** What THIS window has open — the fact `isCurrent` reads (see the class). */
  workspaceFolders: undefined as { uri: { fsPath: string } }[] | undefined,
}));

vi.mock("vscode", () => ({
  window: { showOpenDialog: state.showOpenDialog },
  commands: { executeCommand: state.executeCommand },
  get workspace() {
    // A GETTER on purpose: the folders change between tests (home mode → a folder → another).
    return { workspaceFolders: state.workspaceFolders };
  },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

/** Ports that record what they were asked, with a scripted answer. */
function fakePorts(
  picked: string | undefined,
  current?: string,
): {
  ports: WorkspacePorts;
  pickFolder: ReturnType<typeof vi.fn>;
  openFolder: ReturnType<typeof vi.fn>;
} {
  const pickFolder = vi.fn(async () => picked);
  const openFolder = vi.fn(async () => undefined);
  const currentFolder = vi.fn(async () => current);
  return { ports: { pickFolder, openFolder, currentFolder } as WorkspacePorts, pickFolder, openFolder };
}

describe("WorkspaceActions", () => {
  it("pick() hands the folder back and does NOT reopen the window", async () => {
    // The caller decides what happens between asking and opening (it may have to write a
    // marker first): that is why there is no "pick and open" shortcut here.
    const { ports, pickFolder, openFolder } = fakePorts("/p/new");
    const opts: FolderPickOptions = { title: "Choose the folder", openLabel: "Select folder", defaultFolder: "/p/old" };
    const folder = await new WorkspaceActions(ports).pick(opts);
    expect(folder).toBe("/p/new");
    expect(pickFolder).toHaveBeenCalledWith(opts);
    expect(openFolder).not.toHaveBeenCalled();
  });

  it("pick() answers undefined when the dialog is cancelled (nothing happens)", async () => {
    const { ports, openFolder } = fakePorts(undefined);
    expect(await new WorkspaceActions(ports).pick({ title: "T" })).toBeUndefined();
    expect(openFolder).not.toHaveBeenCalled();
  });

  it("open() delegates with the folder it was given", async () => {
    const { ports, openFolder } = fakePorts(undefined);
    await new WorkspaceActions(ports).open("/p/a");
    expect(openFolder).toHaveBeenCalledWith("/p/a");
  });

  it("open() does NOTHING when the folder is already this window's workspace", async () => {
    // The field report: from the Extension Development Host, choosing the folder the MAIN window
    // has open threw the user into that window. The dev host had that folder open too — so the
    // request was "re-open the workspace I am in", and VS Code answered it by focusing the other
    // window that shows it. There is nothing to open: no command, no reload, no window dance.
    const { ports, openFolder } = fakePorts(undefined, "/p/a");
    await new WorkspaceActions(ports).open("/p/a");
    expect(openFolder).not.toHaveBeenCalled();
  });

  it("open() still opens a DIFFERENT folder, and compares the way the OS does", async () => {
    const { ports, openFolder } = fakePorts(undefined, "/p/a");
    await new WorkspaceActions(ports).open("/p/b");
    expect(openFolder).toHaveBeenCalledWith("/p/b");
    // A trailing slash is the same folder, not a different one (folder-path.sameFolder).
    await new WorkspaceActions(ports).open("/p/a/");
    expect(openFolder).toHaveBeenCalledTimes(1);
  });

  it("isCurrent() answers the question the flows ask, and never guesses", async () => {
    expect(await new WorkspaceActions(fakePorts(undefined, "/p/a").ports).isCurrent("/p/a")).toBe(true);
    expect(await new WorkspaceActions(fakePorts(undefined, "/p/a").ports).isCurrent("/p/b")).toBe(false);
    // No root (home mode) or no folder asked about: never "current".
    expect(await new WorkspaceActions(fakePorts(undefined).ports).isCurrent("/p/a")).toBe(false);
    expect(await new WorkspaceActions(fakePorts(undefined, "/p/a").ports).isCurrent(undefined)).toBe(false);
    // A port that cannot tell (a fake) must not block a real open: undefined is not "current".
    const blind: WorkspacePorts = { pickFolder: async () => undefined, openFolder: async () => undefined };
    expect(await new WorkspaceActions(blind).isCurrent("/p/a")).toBe(false);
  });
});

describe("VscodeWorkspacePorts (the real ports)", () => {
  it("asks for exactly one FOLDER, with the caller's wording", async () => {
    state.showOpenDialog.mockResolvedValue([{ fsPath: "/p/a" }]);
    const folder = await new VscodeWorkspacePorts().pickFolder({ title: "T", openLabel: "Go" });
    expect(folder).toBe("/p/a");
    expect(state.showOpenDialog).toHaveBeenCalledWith({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: "T",
      openLabel: "Go",
    });
  });

  it("starts from the session's folder when there is one, and from nowhere when there is not", async () => {
    state.showOpenDialog.mockResolvedValue(undefined);
    await new VscodeWorkspacePorts().pickFolder({ title: "T", defaultFolder: "/p/old" });
    expect(state.showOpenDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ defaultUri: { fsPath: "/p/old" } }),
    );

    await new VscodeWorkspacePorts().pickFolder({ title: "T" });
    expect(state.showOpenDialog.mock.calls.at(-1)?.[0]).not.toHaveProperty("defaultUri");
  });

  it("reports a cancelled dialog as undefined", async () => {
    state.showOpenDialog.mockResolvedValue(undefined);
    expect(await new VscodeWorkspacePorts().pickFolder({ title: "T" })).toBeUndefined();
    state.showOpenDialog.mockResolvedValue([]);
    expect(await new VscodeWorkspacePorts().pickFolder({ title: "T" })).toBeUndefined();
  });

  it("opens the folder in the CURRENT window — explicitly, not by VS Code's heuristic", async () => {
    // The bare boolean `false` (deprecated) only meant "do not FORCE a new window": with two
    // instances on one profile — the real one and the Extension Development Host — VS Code then
    // chose the window that already showed the workspace and brought THAT forward, instead of
    // loading the folder where the click happened. `forceReuseWindow` names the intent.
    await new VscodeWorkspacePorts().openFolder("/p/b");
    expect(state.executeCommand).toHaveBeenCalledWith(
      "vscode.openFolder",
      { fsPath: "/p/b" },
      {
        forceReuseWindow: true,
      },
    );
  });

  it("knows which folder THIS window has open — and refuses to reopen it", async () => {
    // The whole guard end to end (real ports, mocked host): no command is issued for the folder the
    // window already shows, which is what used to hand the request to VS Code's window heuristic.
    await new VscodeWorkspacePorts().currentFolder().then((f) => expect(f).toBeUndefined());
    state.workspaceFolders = [{ uri: { fsPath: "/p/b" } }];
    expect(await new VscodeWorkspacePorts().currentFolder()).toBe("/p/b");

    await new WorkspaceActions().open("/p/b");
    expect(state.executeCommand).not.toHaveBeenCalled();

    await new WorkspaceActions().open("/p/z");
    expect(state.executeCommand).toHaveBeenCalledWith(
      "vscode.openFolder",
      { fsPath: "/p/z" },
      {
        forceReuseWindow: true,
      },
    );
  });

  it("wires the real ports by default (the production path is exercised)", async () => {
    state.showOpenDialog.mockResolvedValue([{ fsPath: "/p/z" }]);
    // No injected ports: this is exactly what ChatViewProvider builds.
    const actions = new WorkspaceActions();
    const folder = await actions.pick({ title: "T" });
    if (folder) await actions.open(folder);
    expect(state.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ title: "T" }));
    expect(state.executeCommand).toHaveBeenCalledWith(
      "vscode.openFolder",
      { fsPath: "/p/z" },
      {
        forceReuseWindow: true,
      },
    );
  });
});
