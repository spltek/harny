import { tip, type Vars } from "../../i18n";

/**
 * THE HOVER EXPLANATIONS — one mechanism for the whole panel.
 *
 * The Loop Guard fields already had a good one (a floating card, not the OS tooltip: it appears
 * at once, it is styled, it can be read twice). Everything else used `title="…"`, which the OS
 * delays by about a second, cannot be reached by keyboard, cannot be styled or translated, and in
 * a dense panel is effectively invisible. This module generalises the card.
 *
 * Three decisions worth knowing:
 *
 * · DELEGATION, not per-element wiring. One listener on the document serves every control, and it
 *   keeps working for markup replaced wholesale — the session list, the tabs and the metrics are
 *   re-rendered constantly, and per-element `mouseenter` listeners would be re-attached (and
 *   leaked) on every render.
 *
 * · THE KEY, not the prose. An element carries `data-tip="lg.p.maxNudges"`, and the text is read
 *   from the catalog at hover time (`src/i18n/`). Nothing in the DOM has to be rebuilt when a
 *   translation arrives, and the markup stays reviewable.
 *
 * · A DISABLED CONTROL STILL EXPLAINS ITSELF. A disabled <button> dispatches no pointer events of
 *   its own (the event lands on its parent), which is exactly when the user most wants the reason
 *   it is greyed out. When the event target carries no key the pointer is hit-tested, so the
 *   locked control is found anyway.
 */

/** The catalog KEY. Never the prose: that lives in `src/i18n/<locale>.help.json`. */
export const KEY_ATTR = "data-tip";
/** Interpolation values, URL-encoded so any value survives (`min=1&max=10`). */
export const ARGS_ATTR = "data-tip-args";
/** The id of the shared card in the markup. */
export const TIP_ID = "tip";
/** Set by `setTip`/`installTips`, never by hand: the pointer a tipped element shows. */
export const CURSOR_ATTR = "data-tip-cursor";
/** The one element that keeps explaining itself while help is OFF: the switch that turns it on. */
export const ALWAYS_ATTR = "data-tip-always";
/** Class on `<body>` while help is ON: the stylesheet gates every cursor behind it. */
export const HELP_CLASS = "help-on";

/**
 * Is interactive help showing? OFF means: no card, no question mark, nothing to explain — except
 * the switch that turns it back on.
 *
 * This default is the MECHANISM's, not the panel's: a bare `installTips()` explains itself, which
 * keeps the module honest on its own (and the tests readable). The panel starts with help OFF and
 * says so explicitly at boot — `applyHelp()` in view.ts, driven by the host's memory.
 */
let helpEnabled = true;

/** The element may explain itself: either help is on, or it is the switch that turns help on. */
export function mayExplain(el: HTMLElement): boolean {
  return helpEnabled || el.hasAttribute(ALWAYS_ATTR);
}

/**
 * Turn interactive help on or off for `doc`. One switch, one place: the class on `<body>` removes
 * every question-mark cursor at once, and any open card is closed rather than left orphaned on
 * screen by a control that has just stopped explaining itself.
 */
export function setHelpEnabled(on: boolean, doc: Document = document): void {
  helpEnabled = on;
  doc.body?.classList.toggle(HELP_CLASS, on);
  if (!on) installed.get(doc)?.close();
}

/**
 * What a tipped element IS decides its pointer: inert text that explains itself asks a question
 * (`cursor: help`), a control keeps its own cursor. Every element the pointer can act on — the
 * button, the label that owns a radio, the row that opens a session — is in this list, so a
 * clickable thing can never be dressed up as a question.
 */
const CONTROLS =
  "button, a, input, select, textarea, label, [role='button'], [role='switch'], [role='radio'], [role='tab'], [role='link'], [role='menuitem'], [contenteditable='true']";

/**
 * Mark `el` as inert text or leave it alone, once: the cursor is a fact about the element, and the
 * element is not asked twice. `pointer` in the COMPUTED style counts as a control — the session
 * name and the tab are spans and divs, and the stylesheet already says they are clickable.
 */
function markCursor(el: HTMLElement): void {
  if (el.hasAttribute(CURSOR_ATTR)) return;
  const view = el.ownerDocument.defaultView;
  const computed = typeof view?.getComputedStyle === "function" ? view.getComputedStyle(el).cursor : "";
  const control = el.tabIndex >= 0 || !!el.closest(CONTROLS) || computed === "pointer";
  if (!control) el.setAttribute(CURSOR_ATTR, "help");
}

/** Passing over a toolbar must not flash a card: the pointer has to rest before it says anything. */
export const TIP_DELAY_MS = 350;
/** Distance between the anchor and the card. */
export const TIP_GAP = 6;
/** Minimum distance from the viewport edges. */
export const TIP_EDGE = 4;

/** A teardown: removes every listener this module added. */
export type Cleanup = () => void;

/** Give `el` an explanation, by catalog key, with optional `{placeholder}` values. */
export function setTip(el: HTMLElement, key: string, vars?: Vars): void {
  if (!key) {
    el.removeAttribute(KEY_ATTR);
    el.removeAttribute(ARGS_ATTR);
    return;
  }
  el.setAttribute(KEY_ATTR, key);
  const args = encodeArgs(vars);
  if (args) el.setAttribute(ARGS_ATTR, args);
  else el.removeAttribute(ARGS_ATTR);
  markCursor(el);
}

/** Drop the explanation (the control is now self-explanatory). */
export function clearTip(el: HTMLElement): void {
  setTip(el, "");
}

/** The text this element would show, resolved now. `""` when it has no key or the key is unknown. */
export function tipTextOf(el: HTMLElement): string {
  const key = el.getAttribute(KEY_ATTR);
  if (!key) return "";
  return tip(key, decodeArgs(el.getAttribute(ARGS_ATTR)));
}

function encodeArgs(vars?: Vars): string {
  if (!vars) return "";
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(vars)) params.set(name, String(value));
  return params.toString();
}

function decodeArgs(raw: string | null): Vars | undefined {
  if (!raw) return undefined;
  const vars: Vars = {};
  for (const [name, value] of new URLSearchParams(raw)) vars[name] = value;
  return vars;
}

/** What is installed on a document: the card it speaks through, and its teardown. */
interface Installed {
  card: HTMLElement;
  cleanup: Cleanup;
  /** Close whatever is on screen: `setHelpEnabled(false)` must not leave a card behind. */
  close: () => void;
}

/** One installed document, so a second call is not a second set of listeners. */
const installed = new WeakMap<Document, Installed>();

/**
 * Turn the shared card on for `doc`. Idempotent: the first call wins and its teardown is returned
 * to everyone. Without a `#tip` element nothing is installed and nothing throws — a markup change
 * must not take the panel down.
 *
 * If the card that was installed is no longer in the document (the shell was re-rendered), the
 * stale listeners are torn down and a fresh set is installed: a module that keeps talking to a
 * detached element is a tooltip that has silently stopped working.
 */
export function installTips(doc: Document = document): Cleanup {
  const card = doc.getElementById(TIP_ID);
  if (!card) return () => undefined;

  const already = installed.get(doc);
  if (already?.card === card && already.card.isConnected) return already.cleanup;
  already?.cleanup();

  // The markup's own `data-tip` never goes through `setTip`, so its cursor is decided here, once —
  // and again on hover for anything a re-render slipped in (see `onOver`).
  for (const el of doc.querySelectorAll<HTMLElement>(`[${KEY_ATTR}]`)) markCursor(el);

  const win = doc.defaultView;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Waiting out the delay on this anchor. */
  let pending: HTMLElement | null = null;
  /** The anchor the card is currently speaking for. */
  let shown: HTMLElement | null = null;
  /** What `aria-describedby` said before we borrowed it. */
  let describedBefore: string | null = null;

  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = null;
  };

  /** Hand `aria-describedby` back exactly as it was found. */
  const release = (): void => {
    if (!shown) return;
    if (describedBefore === null) shown.removeAttribute("aria-describedby");
    else shown.setAttribute("aria-describedby", describedBefore);
    shown = null;
    describedBefore = null;
  };

  const hide = (): void => {
    release();
    card.classList.add("hidden");
  };

  /** Below the anchor; flipped above when there is no room; clamped to the viewport otherwise. */
  const place = (anchor: HTMLElement): void => {
    const a = anchor.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    const width = win?.innerWidth ?? 0;
    const height = win?.innerHeight ?? 0;
    let top = a.bottom + TIP_GAP;
    if (top + c.height > height - TIP_EDGE) top = a.top - c.height - TIP_GAP;
    // Neither side fits (a very short viewport): pin it to the top rather than off-screen.
    if (top < TIP_EDGE) top = TIP_EDGE;
    const left = Math.min(Math.max(TIP_EDGE, a.left), Math.max(TIP_EDGE, width - c.width - TIP_EDGE));
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
  };

  const show = (anchor: HTMLElement): void => {
    const text = tipTextOf(anchor);
    // A key that resolves to nothing opens NOTHING: an empty card reads as a broken control.
    if (!text) {
      hide();
      return;
    }
    if (shown !== anchor) {
      release();
      describedBefore = anchor.getAttribute("aria-describedby");
      anchor.setAttribute("aria-describedby", describedBefore ? `${describedBefore} ${TIP_ID}` : TIP_ID);
      shown = anchor;
    }
    card.textContent = text;
    card.classList.remove("hidden");
    place(anchor);
  };

  const schedule = (anchor: HTMLElement): void => {
    cancel();
    pending = anchor;
    timer = setTimeout(() => {
      timer = null;
      const target = pending;
      pending = null;
      if (target) show(target);
    }, TIP_DELAY_MS);
  };

  const closest = (node: EventTarget | null): HTMLElement | null => {
    const el = node as Element | null;
    if (!el || typeof el.closest !== "function") return null;
    return el.closest(`[${KEY_ATTR}]`) as HTMLElement | null;
  };

  /** A box you TYPE INTO (not a slider, a switch or a radio): focusing it is how you start editing. */
  const isTypingField = (node: EventTarget | null): boolean => {
    const el = node as Element | null;
    if (!el || typeof el.matches !== "function") return false;
    return el.matches("input:not([type=range]):not([type=checkbox]):not([type=radio]), textarea");
  };

  /** What the pointer is over, even when the control itself cannot report it (disabled). */
  const underPointer = (event: Event): HTMLElement | null => {
    const { clientX, clientY } = event as PointerEvent;
    if (typeof clientX !== "number" || typeof clientY !== "number") return null;
    if (typeof doc.elementFromPoint !== "function") return null;
    return closest(doc.elementFromPoint(clientX, clientY));
  };

  const anchorFor = (event: Event): HTMLElement | null => {
    const direct = closest(event.target);
    if (direct?.getAttribute(KEY_ATTR)) return direct;
    const hit = underPointer(event);
    return hit?.getAttribute(KEY_ATTR) ? hit : null;
  };

  const related = (event: Event): Node | null => (event as PointerEvent).relatedTarget as Node | null;

  const onOver = (event: Event): void => {
    const anchor = anchorFor(event);
    if (!anchor || !mayExplain(anchor)) {
      cancel();
      hide();
      return;
    }
    markCursor(anchor);
    // Moving between children of the same anchor is not a new question.
    if (anchor === pending || anchor === shown) return;
    schedule(anchor);
  };

  const onOut = (event: Event): void => {
    const to = related(event);
    if (pending && !pending.contains(to)) cancel();
    if (shown && !shown.contains(to)) hide();
  };

  const onFocusIn = (event: Event): void => {
    const anchor = anchorFor(event);
    if (!anchor || !mayExplain(anchor)) return;
    // A TEXT FIELD asks no question when it is focused: the focus is how you START TYPING, and a
    // card that opened on every click into a number would sit on top of the very row being edited.
    // Hovering it still explains (`pointerover` is a separate path), so nothing is lost.
    if (isTypingField(event.target)) return;
    // From the keyboard there is no "passing over": the focus IS the question, so no delay.
    cancel();
    show(anchor);
  };

  const onFocusOut = (event: Event): void => {
    const to = related(event);
    if (pending && !pending.contains(to)) cancel();
    if (shown && !shown.contains(to)) hide();
  };

  const dismiss = (): void => {
    cancel();
    hide();
  };

  const onKeyDown = (event: Event): void => {
    if ((event as KeyboardEvent).key === "Escape") dismiss();
  };

  doc.addEventListener("pointerover", onOver, true);
  doc.addEventListener("pointerout", onOut, true);
  doc.addEventListener("focusin", onFocusIn, true);
  doc.addEventListener("focusout", onFocusOut, true);
  // The click answers the question; a scroll or an Escape means the user moved on. A card that
  // outlives its trigger floats over content it does not describe.
  doc.addEventListener("pointerdown", dismiss, true);
  doc.addEventListener("scroll", dismiss, true);
  doc.addEventListener("keydown", onKeyDown);
  win?.addEventListener("resize", dismiss);

  const cleanup: Cleanup = () => {
    dismiss();
    doc.removeEventListener("pointerover", onOver, true);
    doc.removeEventListener("pointerout", onOut, true);
    doc.removeEventListener("focusin", onFocusIn, true);
    doc.removeEventListener("focusout", onFocusOut, true);
    doc.removeEventListener("pointerdown", dismiss, true);
    doc.removeEventListener("scroll", dismiss, true);
    doc.removeEventListener("keydown", onKeyDown);
    win?.removeEventListener("resize", dismiss);
    // Only clear the slot if it is still OURS: a re-install may already own it.
    if (installed.get(doc)?.cleanup === cleanup) installed.delete(doc);
  };
  installed.set(doc, { card, cleanup, close: dismiss });
  return cleanup;
}
