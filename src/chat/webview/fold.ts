import { icon } from "../icons";

/**
 * How a FOLD looks, in one place.
 *
 * Every collapsible header in Harny used to write the TEXT glyph `"▶"` when closed and `"▼"` when
 * open, in six files' worth of places. That reads heavier than the chevrons the rest of the panel
 * uses (#ctl-toggle-btn, .mode-btn-chevron, .lg-collapse) and changes SHAPE and weight on every
 * open. Here the state is a class on ONE svg and the CSS turns it — right when closed, down when
 * open, the same 0.15s the other folds follow — so the box never changes and no call site holds a
 * copy of the drawing.
 */

/** The markup of a fold's toggle: `<span class="tool-toggle">[chevron]</span>`. */
export function toggleMarkup(cls: string, open = false): string {
  return `<span class="${cls}${open ? " is-open" : ""}">${icon("chevronDown", 11, 'class="toggle-chevron"')}</span>`;
}

/** Paint a toggle from a header that already exists: the CSS carries the rest. */
export function setToggle(el: Element | null | undefined, open: boolean): void {
  el?.classList.toggle("is-open", open);
}

/**
 * Sync a FOLD from its header: the chevron and the announced state together.
 *
 * The chevron alone told sighted users only: `aria-expanded` was on the control strip, the mode
 * button and the pending list, but not on a tool card, a thinking block or a sub-agent — the three
 * folds a reader meets most often.
 */
export function setFold(header: Element | null | undefined, open: boolean): void {
  setToggle(header?.querySelector(".toggle, .tool-toggle"), open);
  header?.setAttribute("aria-expanded", String(open));
}
