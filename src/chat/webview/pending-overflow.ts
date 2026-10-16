/**
 * Does a rendered message need a collapse control?
 *
 * The question is about LAYOUT — "does this text take more than one line?" — so it
 * has one correct answer only for a GIVEN width: the same message fits on a wide
 * panel and wraps on a narrow one. That rules out counting characters (a guess
 * that is wrong in both directions) and makes the decision a measured one: the
 * caller reads the line height and the content height off the rendered element
 * (see view.ts: measurePendingOverflow) and asks this predicate.
 *
 * It is a separate module so the RULE is testable without a layout engine: jsdom
 * computes no layout at all, so a DOM-level test could only ever assert the
 * zero-metrics case.
 */

/** A sub-pixel difference (18 vs 18.4 on a scaled display) is NOT a second line. */
export const ONE_LINE_TOLERANCE_PX = 1;

/**
 * True when the content is taller than a single line, i.e. when the text wraps and
 * a control to fold it back is worth showing.
 *
 * A line height of 0 means "no measurement available" (an element inside a hidden
 * container reports one): then the answer is NO — never offer a control we cannot
 * justify, and the next resize/message re-measures anyway.
 */
export function needsCollapseControl(lineHeight: number, contentHeight: number): boolean {
  return lineHeight > 0 && contentHeight > lineHeight + ONE_LINE_TOLERANCE_PX;
}
