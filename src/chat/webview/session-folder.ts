/**
 * "Open this session" — ONE rule, two surfaces.
 *
 * Two places offer a per-session way to reach where a session lives: the All-sessions form
 * (its `.folder-btn`) and the home list shown when no folder is open (its rows ARE that
 * button). They must never disagree about what the gesture does — open the SESSION, which
 * costs a window reload when the folder is another one, or ask for a folder when the pointer
 * is missing or useless — because the difference is a window reload. The rule used to live
 * twice, inside `view.ts`, and the home list is exactly the kind of second surface that would
 * have copied it a third time.
 *
 * The label says what the user GETS, not what the machinery does: the host opens the session
 * and, when its folder is not this window's workspace, switches the workspace first (the
 * session is already open when the window comes back). It used to be called "Open folder",
 * which described the reload as if it were the point.
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

/** What the per-session affordance must do. */
type FolderAction = "open" | "pick";

/**
 * `open` = a usable folder that is NOT the one already open: the session is opened, and the
 * window moves to that folder first (a reload) so it can run there.
 * `pick` = there is nothing to open (no folder stored, folder gone, or already the current
 * one): the picker re-points the session first and the session is opened right after, so the
 * click still ends where it was aimed.
 */
export function folderAction(session: SessionFolderRef, currentFolder?: string): FolderAction {
  const usable = !!session.folder && !session.folderMissing && !sameFolder(session.folder, currentFolder);
  return usable ? "open" : "pick";
}

/**
 * The label of that affordance — one wording for both surfaces, describing the OUTCOME.
 *
 * "Open session" and not "Open folder": what the user asked for is the session, and the
 * workspace switch is how the host gets there (see `openSessionFolder`). "Change folder & open…"
 * says the same for a pointer that has to be repaired first — the picker is the DETOUR, the
 * session is still the destination (the host opens it as soon as the pointer is saved).
 */
export function folderActionLabel(action: FolderAction): string {
  return action === "open" ? "Open session" : "Change folder & open…";
}
