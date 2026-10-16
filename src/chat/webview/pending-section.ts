import { needsCollapseControl } from "./pending-fold";

/**
 * The queue/steer footer: the messages the user typed WHILE the session works.
 *
 * It owns the whole concern — the collapsible section, its counts, the per-bubble
 * fold, and the two commands each bubble offers (convert, cancel) — and owns
 * nothing else: the host is the source of truth for the ITEMS (it re-pushes them on
 * reload) and the only way out of here is the injected `post`, so this module holds
 * no messaging code and no session knowledge (DIP).
 */

/** What the host sends for one pending message. */
export interface PendingViewItem {
  id: string;
  mode: "queue" | "steer";
  text: string;
  attachments?: { name: string; size: number; isImage?: boolean; dataUri?: string }[];
}

export interface PendingSectionDeps {
  /** The section wrapper (hidden when there is nothing to show). */
  section: HTMLElement;
  /** The header row: click/Enter toggles the list, `headText` carries the counts. */
  head: HTMLElement;
  headText: HTMLElement;
  /** The list itself (it owns the scroll; the header stays visible). */
  area: HTMLElement;
  /** Send a message to the host (the only external effect this module has). */
  post: (message: unknown) => void;
}

export interface PendingSection {
  /** Render the items the host just pushed. */
  render(items: PendingViewItem[]): void;
}

export function createPendingSection(deps: PendingSectionDeps): PendingSection {
  const { section, head, headText, area, post } = deps;
  /** Collapsed by the user? (A NEW message re-opens it; see render.) */
  let expanded = true;
  /** Item count at the last render, to detect arrival. */
  let count = 0;

  /**
   * Expand/collapse the list, keeping the header arrow and `aria-expanded` in sync.
   * ONE path for every visibility change (the header click, the keyboard, the
   * auto-expand), so what is on screen can never contradict the state — the rule the
   * sessions header follows too.
   */
  function setExpanded(next: boolean): void {
    expanded = next;
    area.classList.toggle("hidden", !next);
    head.setAttribute("aria-expanded", String(next));
    const toggle = head.querySelector(".toggle");
    if (toggle) toggle.textContent = next ? "▼" : "▶";
  }

  /**
   * Offer the per-bubble fold ONLY where the text really overflows one line, and
   * withdraw it where it fits. MEASURED on the rendered element, because the answer
   * depends on the panel WIDTH too: narrowing the panel wraps a message that used to
   * fit, and a character-count guess would be wrong in both directions.
   */
  function measureOverflow(): void {
    for (const row of area.querySelectorAll<HTMLElement>(".pending-msg")) {
      const body = row.querySelector<HTMLElement>(".pending-text");
      const fold = row.querySelector<HTMLButtonElement>(".pending-more");
      if (!body || !fold) continue;
      // While collapsed, `scrollHeight` still reports the FULL content height (the
      // cap only clips the view), so "does it overflow?" keeps the same answer.
      const lineHeight = parseFloat(getComputedStyle(body).lineHeight) || 0;
      const overflows = needsCollapseControl(lineHeight, body.scrollHeight);
      // Never hide the control while the bubble IS collapsed: that would strand the
      // text with no way back.
      fold.classList.toggle("hidden", !(overflows || row.classList.contains("text-collapsed")));
    }
  }

  /** One bubble: the fold control, the badge, the text and the two commands. */
  function renderRow(it: PendingViewItem): HTMLElement {
    const row = document.createElement("div");
    row.className = "pending-msg " + (it.mode === "steer" ? "pending-steer" : "pending-queue");

    const badge = document.createElement("span");
    badge.className = "pending-badge";
    badge.textContent = it.mode === "steer" ? "Steer" : "Queued";

    const body = document.createElement("span");
    body.className = "pending-text";
    // A paperclip prefix whenever at least one file is attached. The names alone
    // used to be swallowed as soon as the message ALSO had text, so the row said
    // nothing about them. Names stay in the tooltip, and become the body when there
    // is no text at all (as before).
    const files = it.attachments ?? [];
    const names = files.map((a) => a.name).join(", ");
    body.textContent = (files.length > 0 ? "📎 " : "") + (it.text || names || "(empty)");
    body.title = files.length > 0 && it.text ? `${it.text}\n${names}` : body.textContent;

    // The disclosure arrow goes at the START of what it opens, like every other
    // toggle in Harny (thinking, tool, subagent) and with their exact look
    // (.tool-toggle): a bare chevron, never a second action button.
    const fold = document.createElement("button");
    fold.type = "button";
    fold.className = "pending-more hidden";
    fold.textContent = "▼";
    fold.title = "Collapse this message";
    fold.setAttribute("aria-expanded", "true");
    fold.setAttribute("aria-label", "Collapse this message");
    fold.addEventListener("click", () => {
      const collapsed = row.classList.toggle("text-collapsed");
      fold.textContent = collapsed ? "▶" : "▼";
      const label = collapsed ? "Show the whole message" : "Collapse this message";
      fold.title = label;
      fold.setAttribute("aria-expanded", String(!collapsed));
      fold.setAttribute("aria-label", label);
    });

    // Convert between the two delivery modes. The label states the EFFECT, not the
    // mode: they are not two views of the same message, they are delivered at
    // different moments (a steer joins the running loop at its next step and goes
    // first at the end; a queued message waits for the run and keeps FIFO order).
    const convert = document.createElement("button");
    convert.type = "button";
    convert.className = "pending-convert";
    convert.textContent = it.mode === "steer" ? "→ Queued" : "→ Steer";
    convert.title =
      it.mode === "steer"
        ? "Deliver it after the run: it waits in the queue with the other messages"
        : "Deliver it first: injected into the running loop at its next step";
    convert.addEventListener("click", () =>
      post({ type: "setPendingMode", id: it.id, mode: it.mode === "steer" ? "queue" : "steer" }),
    );

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "pending-cancel";
    cancel.textContent = "×";
    cancel.title = it.mode === "steer" ? "Cancel this steer" : "Cancel this queued message";
    cancel.addEventListener("click", () => post({ type: "cancelPending", id: it.id }));

    // The commands sit TOP-RIGHT (pinned with margin-left: auto, so multi-line text
    // never drags them to the middle), the fold arrow at the start of the row.
    const actions = document.createElement("span");
    actions.className = "pending-actions";
    actions.append(convert, cancel);

    row.append(fold, badge, body, actions);
    return row;
  }

  head.addEventListener("click", () => setExpanded(!expanded));
  // The header is a control, so it answers to the keyboard like one (a div with a
  // click handler is otherwise mouse-only).
  head.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    setExpanded(!expanded);
  });
  // Re-evaluate on every resize: the fold appears/disappears as the text starts or
  // stops wrapping. A ResizeObserver catches container-only resizes (dragging the
  // panel edge); the window event covers engines without it.
  // Both are COALESCED to one pass per frame: every pass reads getComputedStyle
  // and scrollHeight for each bubble (a forced layout), and a resize gesture
  // fires these handlers dozens of times per second.
  let measurePending = false;
  const measureOverflowSoon = (): void => {
    if (measurePending) return;
    measurePending = true;
    requestAnimationFrame(() => {
      measurePending = false;
      measureOverflow();
    });
  };
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(measureOverflowSoon).observe(area);
  }
  window.addEventListener("resize", measureOverflowSoon);

  return {
    render(items: PendingViewItem[]): void {
      // Steers ALWAYS above queued ones (they are applied ASAP at the next turn
      // boundary); within each group, arrival order is preserved.
      const ordered = [...(items || [])].sort((a, b) =>
        a.mode === b.mode ? 0 : a.mode === "steer" ? -1 : 1,
      );
      // The section appears only when there is something to show (and disappears
      // when the last item is delivered or cancelled).
      section.classList.toggle("hidden", ordered.length === 0);
      // A NEW message re-opens a collapsed section: the user just typed it and must
      // see it. Collapsing is for getting the block out of the way, not for hiding
      // the next thing you send — while a DELIVERED item leaves the choice alone.
      if (ordered.length > count) setExpanded(true);
      count = ordered.length;
      setExpanded(expanded);
      // The header carries the COUNTS, so a collapsed section still says what is
      // waiting: "Steer 1 · Queued 2".
      const steers = ordered.filter((it) => it.mode === "steer").length;
      const queued = ordered.length - steers;
      headText.textContent = [steers > 0 ? `Steer ${steers}` : "", queued > 0 ? `Queued ${queued}` : ""]
        .filter(Boolean)
        .join(" · ");
      area.replaceChildren(...ordered.map(renderRow));
      // Decide AFTER the rows exist which bubbles actually need the fold control.
      measureOverflow();
    },
  };
}
