/**
 * THE SWITCH — the panel's ONE on/off control.
 *
 * A 26px pill with a 12px knob that slides right when the answer is "on". The MCP server list was
 * the reference for it; the point of this module is that it is not the reference any more — it IS the
 * control. The same question ("is this on?") used to be asked by a native checkbox in the MCP form,
 * a smaller tick next to the Loop Guard's "Include response", and a pill in the tools popover: three
 * looks for one answer. Now a fourth one cannot be born: there is a single appearance (one
 * `.harny-switch` block in the stylesheet) and a single way to build it.
 *
 * TWO DOM shapes, ONE control:
 *   · `createSwitch()` — a `<button role="switch" aria-checked>`: everything the view builds;
 *   · a native `<input type="checkbox" class="harny-switch">` where the markup is static HTML and
 *     the webview script already reads `.checked` (the MCP form's `enabled`, the Loop Guard flag).
 * The stylesheet answers `aria-checked="true"` and `:checked` with the same rule, so the two shapes
 * cannot drift; `setSwitch()`/`switchIsOn()` are the one way to write and read the state.
 *
 * The class name is spelled here and in `view-html.ts` — the two shapes cannot share a variable
 * (the markup module is compiled for the extension host, without the DOM lib, and `dom-contract`
 * reads class names as LITERALS: a constant would be invisible to it). One test pins the pair.
 *
 * Colours are the shared tokens (`--overlay-3`, `--accent`, `--knob-sphere`, `--knob-shadow`), so a
 * theme change moves every toggle at once.
 */

/** A switch as a button — the shape for anything this code builds. */
export function createSwitch(ariaLabel: string, on = false): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "harny-switch";
  el.setAttribute("role", "switch");
  el.setAttribute("aria-label", ariaLabel);
  el.setAttribute("aria-checked", String(on));
  return el;
}

/**
 * Paint a switch of EITHER shape. The state is the only thing that changes, which is why there is no
 * second function for the native input: the caller should not have to know which shape it holds.
 */
export function setSwitch(el: HTMLElement, on: boolean): void {
  if (el instanceof HTMLInputElement) el.checked = on;
  else el.setAttribute("aria-checked", String(on));
}

/** Read a switch of either shape back — the counterpart of `setSwitch`. */
export function switchIsOn(el: HTMLElement): boolean {
  return el instanceof HTMLInputElement ? el.checked : el.getAttribute("aria-checked") === "true";
}
