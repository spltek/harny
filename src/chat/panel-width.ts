/**
 * The chat panel's REFERENCE width: the floor below which the layout stops
 * compressing and scrolls sideways instead of squeezing the controls.
 *
 * Layout, not taste: 450px is the MEASURED minimum (read off a live width readout
 * in a real VS Code panel) at which the ask box keeps its placeholder on one line
 * and the control row (Analyze / Queue / Parallel / AI Model) is not squeezed.
 * This reference ships with ~150px (a third) of margin over that measurement,
 * which is the tolerance you feel when DRAGGING the panel narrower: the controls
 * stay intact and the horizontal scrollbar does not appear straight away.
 *
 * How wide the panel OPENS is NOT ours and NOT a default: VS Code persists the
 * width you last left it at (per window), and exposes no API to read or set it.
 * This floor is therefore the only thing Harny controls about the panel's size —
 * the guarantee that whatever width you come back to, the controls are intact.
 *
 * SINGLE SOURCE OF TRUTH: the CSS floor on `html` and `body` reads the number
 * from here, so the intended tolerance can never drift from what the stylesheet
 * actually enforces.
 */
export const PANEL_REFERENCE_WIDTH = 600;

/**
 * The `min-width` expression for `html` and `body`. The px part is the reference
 * above (a measured floor); the rem part is INDEPENDENT of it and covers LARGER
 * editor fonts, where every control grows — with the floor at 600px it takes over
 * past a ~18.75px font (32rem === 600px exactly there). Raise the reference, and
 * the tolerated shrink grows with it; the rem side only ever raises the floor for
 * big fonts.
 */
export function panelMinWidthCss(width: number = PANEL_REFERENCE_WIDTH): string {
  return `max(${Math.max(0, Math.round(width))}px, 32rem)`;
}
