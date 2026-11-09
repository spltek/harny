/**
 * "Open this session" — ONE rule, two surfaces.
 *
 * Two places offer a per-session way to reach where a session lives: the All-sessions form
 * (its `.folder-btn`) and the home list shown when no folder is open (its rows ARE that
 * button). They must never disagree about what the gesture does — open the SESSION, which
 * costs a window reload when the folder is another one — because the difference is a window
 * reload. The rule used to live twice, inside `view.ts`, and the home list is exactly the kind
 * of second surface that would have copied it a third time.
 *
 * The label says what the user GETS, not what the machinery does: the host opens the session
 * and, when its folder is not this window's workspace, switches the workspace first (the
 * session is already open when the window comes back). It used to be called "Open folder",
 * which described the reload as if it were the point.
 *
 * THREE cases, not two. "Already in this folder" used to answer `pick` like a broken pointer
 * does, which made the All-sessions row offer the picker as its ONLY action: opening a session
 * of the current folder began by choosing a folder — the same one. But that picker is not a
 * detour, it is a DIFFERENT gesture, and only that row can offer it: taking the session to
 * another folder (a session on disk is a transcript, and `folder` is only where it RUNS —
 * re-pointing it from inside its own folder is a legitimate thing to want). So `here` keeps
 * both: open it with one click, or open it somewhere else on purpose.
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
type FolderAction = "open" | "here" | "pick";

/**
 * `open` = a usable folder that is NOT the one already open: the session is opened, and the
 * window moves to that folder first (a reload) so it can run there.
 * `here` = the session already points at THIS window's folder: open it here, now — no reload
 * and no marker to survive. The row also carries the "elsewhere" gesture (`showsMove`),
 * because re-pointing a session from inside its own folder is a real thing to want.
 * `pick` = there is nothing to open (no folder stored, or the folder is gone): the picker
 * re-points the session first and the session is opened right after, so the click still ends
 * where it was aimed.
 */
export function folderAction(session: SessionFolderRef, currentFolder?: string): FolderAction {
  if (!session.folder || session.folderMissing) return "pick";
  return sameFolder(session.folder, currentFolder) ? "here" : "open";
}

/**
 * The label of that affordance — one wording for both surfaces, describing the OUTCOME.
 *
 * "Open session" and not "Open folder": what the user asked for is the session, and the
 * workspace switch is how the host gets there (see `openSessionFolder`). Both `open` and
 * `here` end in the same place — the session on screen — so they share the label; the
 * difference (a reload or not) is in the tooltip, where the cost of the click belongs.
 * "Change folder & open…" says the whole outcome for a pointer that has to be repaired
 * first: the picker is the DETOUR, the session is still the destination (the host opens it
 * as soon as the pointer is saved).
 */
export function folderActionLabel(action: FolderAction): string {
  return action === "pick" ? "Change folder & open…" : "Open session";
}

/**
 * Does this row ALSO carry the "somewhere else" gesture? Only `here`: that is the row whose
 * only action used to be the picker, so "open here" and "open elsewhere" must be two buttons
 * there. `open` needs nothing (the session is one click away, and moving it can wait until it
 * is open) and `pick` already IS the re-pointing (there is no session to open until the
 * pointer is repaired).
 */
export function showsMove(action: FolderAction): boolean {
  return action === "here";
}

/**
 * The label of that second gesture: "Open elsewhere…" — the same verb and the same subject as
 * the button next to it, differing only in WHERE, which is the only thing the user is choosing.
 *
 * Not "Move…"/"Move to folder…": nothing moves. The transcript stays on disk; what changes is
 * the one field saying where the session runs, and the session then opens there — so the
 * outcome is an OPENING, in another folder, and the label says that.
 */
export function folderMoveLabel(): string {
  return "Open elsewhere…";
}
