import { needsCollapseControl } from "./pending-fold";

/**
 * The queue/steer footer: the messages the user typed WHILE the session works.
 *
 * It owns the whole concern — the collapsible section, its counts, the per-bubble fold
 * and the two commands each bubble offers (convert, cancel) — and owns nothing else:
 * the host is the source of truth for the ITEMS (it re-pushes them on reload) and the
 * only way out of here is the injected `post`, so this module holds no messaging code
 * and no session knowledge (DIP).
 *
 * A bubble is ONE LINE by default — it is a queued intention, not a document: the whole
 * text travels in its tooltip — and opens on demand, with a fold offered only where
 * there is really more to see. The SECTION is what scrolls, so a long queue can never
 * eat the transcript.
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
  /** Render a message's attachments INSIDE its bubble, exactly as a user bubble does
   * (thumbnails + file chips). Injected, because the SAME renderer is what keeps the
   * two identical — and this module stays free of markup it does not own. */
  renderAttachments?: (host: HTMLElement, item: PendingViewItem) => void;
}

export interface PendingSection {
  /** Render the items the host just pushed. */
  render(items: PendingViewItem[]): void;
  /** How many rows are OPEN: the transcript's "Collapse all" is only meaningful while
   * something is. */
  openCount(): number;
  /** Fold every open row (the same "Collapse all"). Returns how many it closed, so the
   * caller can report the effect instead of reaching into the DOM. */
  collapseAll(): number;
}

export function createPendingSection(deps: PendingSectionDeps): PendingSection {
  const { section, head, headText, area, post, renderAttachments } = deps;
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
    // Nothing can be measured inside a hidden container (it reports no line height),
    // so the fold decisions are re-taken once the list is on screen again.
    if (next) remeasureSoon();
  }

  /**
   * Is there more to this row than its one line? MEASURED, never guessed — the rule
   * lives in pending-fold.ts. The folded clip keeps `scrollHeight` reporting the FULL
   * content height, so the answer does not depend on the row being open: that is what
   * makes stranding impossible (a row that needs opening always offers the fold).
   * Attachments count as content: they live inside the bubble, so opening it is the
   * only way to see them.
   */
  function needsFold(row: HTMLElement): boolean {
    const body = row.querySelector<HTMLElement>(".pending-text");
    const lineHeight = body ? parseFloat(getComputedStyle(body).lineHeight) || 0 : 0;
    const wraps = needsCollapseControl(lineHeight, body?.scrollHeight ?? 0);
    return wraps || row.querySelector(".pending-extras .msg-attachments") !== null;
  }

  /**
   * Offer the fold WHERE there is something to open, and reserve its place on every
   * row (see the CSS): the two commands then sit at the same spot on every row, so
   * they can be hit without aiming.
   */
  function syncFolds(): void {
    for (const row of area.querySelectorAll<HTMLElement>(".pending-msg")) {
      const toggle = row.querySelector<HTMLButtonElement>(".pending-toggle");
      if (toggle) toggle.classList.toggle("hidden", !needsFold(row));
    }
  }

  /** ONE measurement pass per frame: each pass reads layout for every row, and a
   * resize gesture fires these events dozens of times per second. Skipped off screen. */
  let measuring = false;
  function remeasureSoon(): void {
    if (measuring) return;
    measuring = true;
    requestAnimationFrame(() => {
      measuring = false;
      if (section.classList.contains("hidden") || area.classList.contains("hidden")) return;
      syncFolds();
    });
  }

  /** ONE path for a row's fold state: the class, the arrow and the announcement. */
  function setRowCollapsed(row: HTMLElement, collapsed: boolean): void {
    row.classList.toggle("text-collapsed", collapsed);
    const toggle = row.querySelector<HTMLButtonElement>(".pending-toggle");
    if (!toggle) return;
    const label = collapsed ? "Show the whole message" : "Collapse this message";
    toggle.textContent = collapsed ? "▶" : "▼";
    toggle.title = label;
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-label", label);
  }

  /** One bubble: the badge, the text (with its attachments) and, at the END, the fold
   * and the two commands. */
  function renderRow(it: PendingViewItem): HTMLElement {
    const row = document.createElement("div");
    // BORN COLLAPSED — every row, the one just typed included: the queue stays one
    // line per message, whatever was pasted into it.
    row.className = "pending-msg text-collapsed " + (it.mode === "steer" ? "pending-steer" : "pending-queue");

    const badge = document.createElement("span");
    badge.className = "pending-badge";
    badge.textContent = it.mode === "steer" ? "Steer" : "Queued";

    const body = document.createElement("span");
    body.className = "pending-text";
    // A paperclip prefix whenever at least one file is attached. The names alone
    // used to be swallowed as soon as the message ALSO had text, so the row said
    // nothing about them. Names stay in the tooltip, and become the body when there
    // is no text at all (as before) — the tooltip carries the WHOLE text of a folded
    // row too, which is what makes one line enough.
    const files = it.attachments ?? [];
    const names = files.map((a) => a.name).join(", ");
    body.textContent = (files.length > 0 ? "📎 " : "") + (it.text || names || "(empty)");
    body.title = files.length > 0 && it.text ? `${it.text}\n${names}` : body.textContent;

    // Text and attachments share a column, so the previews land UNDER the text as in
    // a user bubble while the commands stay pinned to the top-right corner.
    const main = document.createElement("div");
    main.className = "pending-main";
    main.appendChild(body);
    if (renderAttachments && files.length > 0) {
      const extras = document.createElement("div");
      extras.className = "pending-extras";
      renderAttachments(extras, it);
      main.appendChild(extras);
    }

    // The fold is an ACTION on this bubble, so it sits WITH the two commands — never
    // in front of the text — and looks like every other toggle in Harny: a bare
    // chevron, no box (see .tool-toggle).
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "pending-toggle hidden";
    toggle.addEventListener("click", () => setRowCollapsed(row, !row.classList.contains("text-collapsed")));

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
    // never drags them to the middle).
    const actions = document.createElement("span");
    actions.className = "pending-actions";
    actions.append(toggle, convert, cancel);

    row.append(badge, main, actions);
    // The row is BORN folded, and it says so on its arrow — set once the parts are IN
    // the row (the state lives on the row and on its fold together).
    setRowCollapsed(row, true);
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
  // A width change flips the answer ("does it still fit one line?"), and the panel is
  // resized far more often than the messages change. A ResizeObserver catches
  // container-only resizes (dragging the panel edge); the window event covers engines
  // without it.
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(remeasureSoon).observe(area);
  }
  window.addEventListener("resize", remeasureSoon);

  return {
    render(items: PendingViewItem[]): void {
      // Steers ALWAYS above queued ones (they are applied ASAP at the next turn
      // boundary); within each group, arrival order is preserved.
      const ordered = [...(items || [])].sort((a, b) => (a.mode === b.mode ? 0 : a.mode === "steer" ? -1 : 1));
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
      // Decide AFTER the rows exist which ones actually have something to open.
      syncFolds();
    },
    openCount(): number {
      return area.querySelectorAll(".pending-msg:not(.text-collapsed)").length;
    },
    collapseAll(): number {
      let folded = 0;
      for (const row of area.querySelectorAll<HTMLElement>(".pending-msg")) {
        if (row.classList.contains("text-collapsed")) continue;
        setRowCollapsed(row, true);
        folded += 1;
      }
      return folded;
    },
  };
}
