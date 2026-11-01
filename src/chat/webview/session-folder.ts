/**
 * "Go to this session's FOLDER" — ONE rule, two surfaces.
 *
 * Two places offer a per-session way to reach the folder a session belongs to: the
 * All-sessions form (its `.folder-btn`) and the home list shown when no folder is open
 * (its rows ARE that button). They must never disagree about what the gesture does —
 * open a usable folder in VS Code, or ask for one when the pointer is missing or
 * useless — because the difference is a window reload. The rule used to live twice,
 * inside `view.ts`, and the home list is exactly the kind of second surface that would
 * have copied it a third time.
 *
 * Pure on purpose: no DOM, no `vscode`, no globals. That is what makes the rule testable
 * without a page (`session-folder.test.ts`) and what keeps the two surfaces honest.
 */

import { sameFolder } from "../folder-path";

/** A session's folder pointer, as every surface receives it from the host. */
interface SessionFolderRef {
  /** Absolute path of the folder this session points to (absent in legacy sessions). */
  folder?: string;
  /** The path no longer exists (computed by the host at list time). */
  folderMissing?: boolean;
}

/** What the "go to the folder" affordance must do. */
type FolderAction = "open" | "pick";

/**
 * `open` = a usable folder that is NOT the one already open: opening it in VS Code
 * changes the working directory, which is the whole point.
 * `pick` = there is nothing to open (no folder stored, folder gone, or already the
 * current one): the picker is the only useful action, and it also re-points the session.
 */
export function folderAction(session: SessionFolderRef, currentFolder?: string): FolderAction {
  const usable = !!session.folder && !session.folderMissing && !sameFolder(session.folder, currentFolder);
  return usable ? "open" : "pick";
}

/** The label of that affordance — one wording for both surfaces. */
export function folderActionLabel(action: FolderAction): string {
  return action === "open" ? "Open folder" : "Change folder…";
}
