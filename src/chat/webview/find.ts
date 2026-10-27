/**
 * FIND IN THE TRANSCRIPT — the engine, in one module.
 *
 * It owns: the bar's state machine, the scan (capped), the two highlight layers, the navigation,
 * the debounce, and the rescan that follows the transcript while the bar is open. It owns NOTHING
 * about the rest of the panel: the bar's elements come in as parameters, and the one thing it cannot
 * do itself — opening a folded section so a match is visible — is an injected callback (`reveal`).
 * That keeps this file testable on its own and makes the boundary explicit.
 *
 * Highlights are painted with the CSS Custom Highlight API, never by touching the DOM: injecting
 * markup into a transcript that streaming repaints is how a highlight ends up eating the text. Where
 * the API is missing the selection is the fallback, used ONLY while nothing of ours has the focus
 * (moving the selection blurs the field, and the next keystroke would land in the transcript).
 */

/** The bar's own elements. Passing them in (instead of querying) is what makes this testable. */
export interface FindElements {
  bar: HTMLElement;
  input: HTMLInputElement;
  count: HTMLElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  close: HTMLButtonElement;
  /** The transcript: what is searched, and the parent the scan never walks out of. */
  transcript: HTMLElement;
}

export interface FindOptions {
  /** Open every folded section containing `node`, so the match is actually visible. */
  reveal?: (node: Node) => void;
}

export interface Find {
  /** Show the bar and put the caret in it (the ⌘F / host-message path). */
  open(): void;
  /** Remove the highlights, disarm the timers, empty the field, hide the bar. */
  close(): void;
  isOpen(): boolean;
  /** ⌘F semantics: bring the user TO the field, selecting the query; never toggles it away. */
  focusOrOpen(): void;
}

/** A search per keystroke would stutter on a long transcript. */
const DEBOUNCE_MS = 120;
/** The rescan that follows the transcript costs a full walk: let a stream settle first. */
const RESCAN_MS = 300;
/** Bounded: a one-letter query in a huge transcript must not build a million Ranges. */
const MAX_MATCHES = 500;

/** The two highlight names, so the CSS and this file cannot drift apart. */
export const HIGHLIGHT_ALL = "harny-find";
export const HIGHLIGHT_CURRENT = "harny-find-current";

interface HighlightApi {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

export function createFind(els: FindElements, opts: FindOptions = {}): Find {
  let matches: Range[] = [];
  let index = -1;
  /** The transcript's text length when the list was built: a cheap "has it changed?" probe. */
  let scanLength = -1;
  let debounce: number | undefined;
  let rescanTimer: number | undefined;
  let observer: MutationObserver | null = null;

  const open = (): boolean => !els.bar.classList.contains("hidden");
  const textLength = (): number => els.transcript.textContent?.length ?? 0;

  function collect(query: string): Range[] {
    const out: Range[] = [];
    if (!query) return out;
    const needle = query.toLowerCase();
    const walker = els.transcript.ownerDocument.createTreeWalker(els.transcript, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && out.length < MAX_MATCHES; n = walker.nextNode()) {
      const text = n.textContent ?? "";
      const hay = text.toLowerCase();
      let at = hay.indexOf(needle);
      while (at >= 0) {
        const range = els.transcript.ownerDocument.createRange();
        range.setStart(n, at);
        range.setEnd(n, at + needle.length);
        out.push(range);
        if (out.length >= MAX_MATCHES) break;
        at = hay.indexOf(needle, at + needle.length);
      }
    }
    return out;
  }

  function updateCount(): void {
    const total = matches.length;
    // TRIM: a query of spaces matches nothing, but it is not a query at all — showing "no match"
    // for it (and keeping a stale count) reads like the search is broken.
    if (!els.input.value.trim()) {
      els.count.textContent = "";
      els.count.classList.remove("none");
      return;
    }
    els.count.textContent = total === 0 ? "no match" : `${index + 1}/${total}`;
    els.count.classList.toggle("none", total === 0);
  }

  function highlightApi(): HighlightApi | undefined {
    const w = window as unknown as { CSS?: { highlights?: HighlightApi }; Highlight?: unknown };
    const Ctor = w.Highlight as (new (...ranges: Range[]) => unknown) | undefined;
    if (!w.CSS?.highlights || !Ctor) return undefined;
    return {
      set: (name, highlight) => {
        w.CSS!.highlights!.set(name, highlight);
      },
      delete: (name) => {
        w.CSS!.highlights!.delete(name);
      },
    };
  }

  function paint(): void {
    const api = highlightApi();
    const Ctor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (!api || !Ctor) return; // no API: the fallback in show() decides, caret first
    api.delete(HIGHLIGHT_ALL);
    api.delete(HIGHLIGHT_CURRENT);
    if (matches.length > 0) api.set(HIGHLIGHT_ALL, new Ctor(...matches));
    const current = matches[index];
    if (current) api.set(HIGHLIGHT_CURRENT, new Ctor(current));
  }

  function clearHighlights(): void {
    const api = highlightApi();
    if (!api) return;
    api.delete(HIGHLIGHT_ALL);
    api.delete(HIGHLIGHT_CURRENT);
  }

  function show(scroll: boolean): void {
    const m = matches[index];
    if (!m) return;
    // A match inside a FOLDED section is invisible: open it first (the count was right, the jump
    // went nowhere). Before scrolling, so the scroll lands on something the user can see.
    opts.reveal?.(m.startContainer);
    // Was the user typing in one of our fields? Then the selection must NOT be moved: it would blur
    // the field and the next keystroke would go to the transcript.
    const wasTyping = els.bar.contains(els.bar.ownerDocument.activeElement);
    const caret = [els.input.selectionStart, els.input.selectionEnd] as const;
    const hasApi = Boolean((window as unknown as { Highlight?: unknown }).Highlight);
    const sel = window.getSelection?.();
    if (sel && !hasApi && !wasTyping) {
      // Fallback for a host without the Highlight API: the selection is the only highlight left, and
      // it is used ONLY while nothing of ours is focused (so nothing can lose the caret).
      sel.removeAllRanges();
      sel.addRange(m);
    }
    if (scroll) {
      const node = m.startContainer;
      const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
      el?.scrollIntoView?.({ block: "center", inline: "nearest" });
    }
    // Fallback path only: take the caret back where it was.
    if (wasTyping && els.bar.ownerDocument.activeElement !== els.input) {
      els.input.focus();
      const [start, end] = caret;
      if (start !== null && end !== null) els.input.setSelectionRange(start, end);
    }
  }

  /**
   * Recompute EVERY highlight from the current query.
   *
   * Called on every change of the text (and when the transcript grows while the bar is open): the
   * paint is unconditional, so `no match` and an empty field clear what the previous query drew — a
   * highlight left over an old query points at text that no longer matches.
   */
  function refresh(keepIndex = false, scroll = true): void {
    // NEVER paint for a bar that is not on screen: the highlights would mark the transcript with
    // nothing to explain them (a programmatic write to the field, or a debounce that lands after
    // Esc). `open()` un-hides the bar BEFORE it calls this, so the legitimate path is unaffected.
    if (!open()) return;
    const previous = index;
    matches = collect(els.input.value.trim());
    scanLength = textLength();
    if (matches.length === 0) {
      index = -1;
    } else if (keepIndex && previous >= 0) {
      index = Math.min(previous, matches.length - 1);
    } else {
      index = 0;
    }
    updateCount();
    paint(); // always: an empty result is a paint of nothing, not a skipped paint
    if (matches.length > 0) show(scroll);
    else window.getSelection()?.removeAllRanges(); // the fallback highlight is gone with them
  }

  /** Enter/Shift+Enter (or the arrows): move through the matches, wrapping at the ends. */
  function step(delta: number): void {
    if (matches.length === 0 || textLength() !== scanLength) {
      // The transcript changed (a delta arrived): the Ranges may point at replaced nodes.
      refresh(true);
      if (matches.length === 0) return;
      if (delta > 0) return; // a fresh scan already landed on the first match
    }
    index = (index + delta + matches.length) % matches.length;
    updateCount();
    paint(); // the CURRENT match moved: repaint both layers
    show(true);
  }

  /**
   * While the bar is open the transcript keeps changing (a run streams, a section folds, a message
   * lands) and every Range held points into nodes that may have been REPLACED: the highlight then
   * paints nothing, or the wrong span. So the scan follows the DOM — debounced, and WITHOUT
   * scrolling: recomputing must never pull the reader away from what they are looking at.
   */
  function watch(): void {
    if (observer || typeof MutationObserver === "undefined") return;
    observer = new MutationObserver(() => {
      if (rescanTimer !== undefined) window.clearTimeout(rescanTimer);
      rescanTimer = window.setTimeout(() => {
        rescanTimer = undefined;
        if (!open() || !els.input.value.trim()) return;
        refresh(true, false);
      }, RESCAN_MS);
    });
    observer.observe(els.transcript, { childList: true, subtree: true, characterData: true });
  }

  function unwatch(): void {
    observer?.disconnect();
    observer = null;
    if (rescanTimer !== undefined) window.clearTimeout(rescanTimer);
    rescanTimer = undefined;
  }

  function close(): void {
    clearHighlights();
    unwatch();
    // A debounced search still armed is a LEAK: a keystroke followed by Esc within the debounce left
    // the timer running, and it fired after the bar was gone — re-scanning the transcript and
    // clearing a selection the user had made in the meantime.
    if (debounce !== undefined) window.clearTimeout(debounce);
    debounce = undefined;
    els.bar.classList.add("hidden");
    matches = [];
    index = -1;
    scanLength = -1;
    els.input.value = "";
    els.count.textContent = "";
    els.count.classList.remove("none");
    window.getSelection()?.removeAllRanges();
  }

  els.input.addEventListener("input", () => {
    if (debounce !== undefined) window.clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      debounce = undefined;
      refresh();
    }, DEBOUNCE_MS);
  });

  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
      return;
    }
    // Keep the other global shortcuts (Esc = Stop, ⌘F = close) from firing from in here.
    e.stopPropagation();
  });

  els.next.addEventListener("click", () => step(1));
  els.prev.addEventListener("click", () => step(-1));
  els.close.addEventListener("click", () => close());

  return {
    open(): void {
      els.bar.classList.remove("hidden");
      els.input.focus();
      els.input.select();
      watch();
      if (els.input.value.trim()) refresh();
    },
    close,
    isOpen: open,
    focusOrOpen(): void {
      // Standard behaviour: ⌘F brings you TO the field (selecting what is there), it does not
      // toggle the bar away — Esc is the way out.
      if (open()) {
        els.input.focus();
        els.input.select();
      } else {
        this.open();
      }
    },
  };
}
