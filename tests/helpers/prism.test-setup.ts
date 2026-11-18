/**
 * Vitest setup: expose the bundled Prism instance as a GLOBAL before any test
 * file imports view.ts. The Prism grammar components (imported statically by
 * prism.ts) attach to the bare global `Prism`; in the real webview that global
 * is rewired at build time (define+inject), in vitest we mirror it here.
 */
import Prism from "prismjs";

(globalThis as { Prism?: unknown }).Prism = Prism;

/**
 * jsdom has no ResizeObserver. In the real webview the browser provides one, and view.ts's geometry
 * net watches the transcript AND every bubble in it: anything that changes a height (a delta, a
 * re-render, a fold, a late image, a font swap, the panel narrowing) resizes one of them, and the
 * notification lands after layout and before paint — which is when the Follow re-takes the end.
 * This stub only RECORDS. Nothing fires unless a test asks for it (`__fireResize`), so no existing
 * test changes behaviour by its own — and `__observed` is what proves the watch list covers the
 * bubbles a rebuild just landed: an unwatched bubble is a Follow that dies silently.
 */
type Watching = { cb: () => void; targets: Element[] };
const watching: Watching[] = [];

(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  private readonly record: Watching;
  constructor(cb: () => void) {
    this.record = { cb, targets: [] };
    watching.push(this.record);
  }
  observe(el: Element): void {
    this.record.targets.push(el);
  }
  unobserve(): void {}
  disconnect(): void {}
};

/** Delivers a geometry notification: with an element, only the observers watching THAT box (one
 * resize); without one, every recorded observer — which is what the frame delivers after a batch of
 * changes. The browser runs these after layout and before paint; in jsdom there is no layout, so a
 * test is the one that says "the box has been laid out". */
globalThis.__fireResize = (el?: Element): void => {
  for (const w of watching) if (!el || w.targets.includes(el)) w.cb();
};

/** Every box currently under watch, across every observer the panel created. */
globalThis.__observed = (): Element[] => watching.flatMap((w) => w.targets);
