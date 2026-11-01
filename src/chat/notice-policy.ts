/**
 * One fact, ONE surface.
 *
 * The panel can say something in five places: the hero (home screen), a row in the sessions
 * list, a dialog inside the panel, a note in the transcript, and — when the panel is not on
 * screen at all — a native toast. Every one of them was chosen ad hoc, and that is how a single
 * fact ended up announced three times at once (a banner pinned above the transcript, the red
 * row, and a toast in the corner, for a state the user was already looking at).
 *
 * This table is the counterpart of the LOCK TABLE in the webview: the decision stops being an
 * aesthetic choice at the call site and becomes a lookup. The HOST only owns the part the panel
 * cannot do by itself — a dialog (which needs a user response) and a toast (which needs the
 * panel to be hidden) — so the answer here is what the HOST must do, not how it looks.
 */

/** The facts that need a voice outside the panel's own rendering. */
type Notice = "workspace-gone";

/** What the panel is showing right now. */
export interface ViewState {
  /** Is the webview on screen? A dialog cannot be shown at all when it is not. */
  panelVisible: boolean;
  /** Is a session open, so there is something to ask about? (home = the picker already) */
  sessionOpen: boolean;
}

/** What the host must do about it. */
type HostAction = "ask" | "toast" | "silent";

const ROUTES: Record<Notice, (state: ViewState) => HostAction> = {
  /**
   * The workspace folder disappeared.
   *
   * · panel visible, a session on screen → ASK. The run is already stopped by the time this
   *   runs (`stopAllForLostRoot` comes first), so a dialog interrupts nothing: it is a
   *   question ("which folder now?"), and the answer is the picker.
   * · panel visible, no session → SILENT. The home already names the missing folder and its
   *   list IS the picker; a dialog would repeat what the screen says.
   * · panel hidden → TOAST. It is the only surface left: no panel, no dialog.
   */
  "workspace-gone": (s) => (s.panelVisible ? (s.sessionOpen ? "ask" : "silent") : "toast"),
};

/** Route one fact to the one surface that can carry it. */
export function routeNotice(notice: Notice, state: ViewState): HostAction {
  return ROUTES[notice](state);
}
