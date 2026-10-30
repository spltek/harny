/**
 * Opening a FOLDER as the window's workspace — the one thing Harny needs a folder for.
 *
 * The extension works per workspace (`singleWorkspaceRoot`): the root decides where the
 * tools read and write and which bucket a session belongs to. So every flow that needs a
 * folder ends up here, and there are three of them today:
 *   · the home screen's "Open folder…" (no folder open: the first need is a workspace);
 *   · "New session" pressed with no folder open (same need, same answer);
 *   · a session row whose folder must become the workspace.
 * What they share is exactly two decisions — WHICH folders the dialog offers, and HOW a
 * chosen folder becomes the workspace — and that is all this module owns. Two copies of
 * `commands.executeCommand("vscode.openFolder", …)` would be two chances to pass a
 * different `forceNewWindow`, i.e. two different behaviours for the same gesture.
 *
 * The VS Code API sits behind `WorkspacePorts` (dependency inversion): the flows above
 * are testable without a host, and a NEW flow (e.g. "open the folder and resume a
 * session") is a call, never another copy of the command string.
 */

/** What the folder dialog should say and where it should start. */
export interface FolderPickOptions {
  /** Dialog title (says WHAT the folder is for, not just "open a folder"). */
  title: string;
  /** Confirm button; omitted = VS Code's own wording. */
  openLabel?: string;
  /** Folder to start from; omitted = the OS's default location. */
  defaultFolder?: string;
}

/** The two capabilities this module needs from the host. */
export interface WorkspacePorts {
  /** Ask the user for a folder. `undefined` = the dialog was cancelled. */
  pickFolder(opts: FolderPickOptions): Promise<string | undefined>;
  /** Open that folder as the window's workspace. */
  openFolder(folder: string): Promise<void>;
}

/**
 * The real ports: VS Code's own dialog and the built-in `vscode.openFolder`.
 *
 * `vscode` is imported LAZILY, like the rest of the host calls this replaces: this
 * module is also loaded by tests, and a static import would drag the editor API into
 * every consumer.
 */
export class VscodeWorkspacePorts implements WorkspacePorts {
  async pickFolder(opts: FolderPickOptions): Promise<string | undefined> {
    const { window, Uri } = await import("vscode");
    const uris = await window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: opts.title,
      ...(opts.openLabel ? { openLabel: opts.openLabel } : {}),
      // A folder that is known and still available is the default, so the common case
      // (re-pointing a session, opening a session's own folder) is one click.
      ...(opts.defaultFolder ? { defaultUri: Uri.file(opts.defaultFolder) } : {}),
    });
    const picked = uris?.[0];
    return picked ? picked.fsPath : undefined;
  }

  async openFolder(folder: string): Promise<void> {
    const { commands, Uri } = await import("vscode");
    // forceNewWindow = false: reuse the current window. The extension host reloads and
    // re-derives its root from the newly opened folder, which is exactly the point — a
    // new window would leave the panel the user is looking at untouched.
    await commands.executeCommand("vscode.openFolder", Uri.file(folder), false);
  }
}

/**
 * The use cases, over an injected set of ports.
 *
 * Two primitives, because the sequencing between them is NOT the same for every flow:
 * “pick a folder and open it” is a one-liner here, but a flow that must leave a note for
 * the NEXT activation writes it between the two (see `chat-view.chooseFolder`). Each one
 * returns what it did (`undefined` when the user cancelled) so a caller can decide what
 * to say or whether to continue, instead of guessing from a side effect.
 */
export class WorkspaceActions {
  constructor(private readonly ports: WorkspacePorts = new VscodeWorkspacePorts()) {}

  /** Ask for a folder WITHOUT opening it (the caller decides, and may need a step between). */
  async pick(opts: FolderPickOptions): Promise<string | undefined> {
    return this.ports.pickFolder(opts);
  }

  /** Open a folder as the workspace (the window reloads onto it). */
  async open(folder: string): Promise<void> {
    return this.ports.openFolder(folder);
  }
}
