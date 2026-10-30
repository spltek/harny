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
}));

vi.mock("vscode", () => ({
  window: { showOpenDialog: state.showOpenDialog },
  commands: { executeCommand: state.executeCommand },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

/** Ports that record what they were asked, with a scripted answer. */
function fakePorts(picked: string | undefined): {
  ports: WorkspacePorts;
  pickFolder: ReturnType<typeof vi.fn>;
  openFolder: ReturnType<typeof vi.fn>;
} {
  const pickFolder = vi.fn(async () => picked);
  const openFolder = vi.fn(async () => undefined);
  return { ports: { pickFolder, openFolder } as WorkspacePorts, pickFolder, openFolder };
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

  it("opens the folder in the CURRENT window (forceNewWindow = false)", async () => {
    await new VscodeWorkspacePorts().openFolder("/p/b");
    expect(state.executeCommand).toHaveBeenCalledWith("vscode.openFolder", { fsPath: "/p/b" }, false);
  });

  it("wires the real ports by default (the production path is exercised)", async () => {
    state.showOpenDialog.mockResolvedValue([{ fsPath: "/p/z" }]);
    // No injected ports: this is exactly what ChatViewProvider builds.
    const actions = new WorkspaceActions();
    const folder = await actions.pick({ title: "T" });
    if (folder) await actions.open(folder);
    expect(state.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ title: "T" }));
    expect(state.executeCommand).toHaveBeenCalledWith("vscode.openFolder", { fsPath: "/p/z" }, false);
  });
});
