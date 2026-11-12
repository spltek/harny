import { setToggle } from "./fold";
import { icon } from "../icons";
import { setTip } from "./tips";

/**
 * The queue/steer footer: the messages the user typed WHILE the session works.
 *
 * It owns the whole concern — the collapsible section, its counts and the two commands
 * each bubble offers (convert, cancel) — and owns nothing else: the host is the source of
 * truth for the ITEMS (it re-pushes them on reload) and the only way out of here is the
 * injected `post`, so this module holds no messaging code and no session knowledge (DIP).
 *
 * A bubble is ALWAYS WHOLE. It used to be one line with a per-row fold in front of it; the
 * fold is gone and the row shows the whole message, every time:
 *   - what you type while an agent works is short by nature — a steering order or a
 *     correction, not a document. The clamp was paying a chevron on EVERY row (12px of
 *     leading ink, plus a second one after the badge in the first version) to hide two
 *     lines that were usually there anyway;
 *   - and a row you cannot collapse needs no state: no `text-collapsed`, no measurement,
 *     no ResizeObserver, nothing to re-take when the panel is resized. Four moving parts
 *     and their delightful edge cases (a row born folded that had nothing to unfold, a
 *     fold that had to be re-measured while hidden) simply do not exist any more.
 * ONE fold is left, and it is the one worth having: the section header, because a long
 * queue is what can eat the transcript — and the section is what scrolls.
 */

/** What the host sends for one pending message. */
export interface PendingViewItem {
  id: string;
  mode: "queue" | "steer";
  text: string;
  attachments?: { name: string; size: number; isImage?: boolean; dataUri?: string }[];
}

interface PendingSectionDeps {
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

interface PendingSection {
  /** Render the items the host just pushed. */
  render(items: PendingViewItem[]): void;
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
    setToggle(head.querySelector(".toggle"), next);
  }

  /** One bubble: the mode mark, the badge, the text (with its attachments) and, at the END,
   * the two commands. No fold, by design — see the module comment. */
  function renderRow(it: PendingViewItem): HTMLElement {
    const row = document.createElement("div");
    row.className = "pending-msg " + (it.mode === "steer" ? "pending-steer" : "pending-queue");

    // The mark of the MODE, in the place a tool call wears its own: it LEADS the row, before the
    // pill it makes redundant on purpose. Steer cuts the line (`list-start`, the arrow reaches the
    // top), queue waits at its end (`list-end`) — the same twin drawings, so the two rows read as
    // two delivery modes of one control.
    const mark = document.createElement("span");
    mark.className = "pending-mark";
    mark.innerHTML = icon(it.mode === "steer" ? "listStart" : "listEnd", 13);

    const badge = document.createElement("span");
    badge.className = "pending-badge";
    // ONE WIDTH FOR BOTH LABELS, MEASURED instead of guessed: a hidden sizer holds a copy of BOTH
    // labels — stacked in one grid cell, so it reports the WIDER of them — and shares the badge's
    // single cell (see .mode-pill-sizer), so the pill is exactly as wide as that label in ANY font,
    // at any zoom, with no number to keep in sync: converting a message never resizes the badge, so
    // the text never shifts under the pointer. The `#insert-hint-word` pill of the footer uses the
    // SAME recipe, which is what makes the two boxes the same width on screen.
    const sizer = document.createElement("span");
    sizer.className = "mode-pill-sizer";
    sizer.setAttribute("aria-hidden", "true");
    for (const label of ["Queue", "Steer"]) {
      const copy = document.createElement("span");
      copy.textContent = label;
      sizer.appendChild(copy);
    }
    const badgeLabel = document.createElement("span");
    badgeLabel.className = "mode-pill-label";
    // "Queue", not "Queued": the mode is a NAME, the word the footer hint and this pill both use,
    // and the one the buttons that CONVERT say ("→ Queue"). A past participle described the state
    // of a message you had already stopped typing; the label is what the mode IS.
    badgeLabel.textContent = it.mode === "steer" ? "Steer" : "Queue";
    badge.append(sizer, badgeLabel);

    const body = document.createElement("span");
    body.className = "pending-text";
    // A paperclip prefix whenever at least one file is attached. The names alone
    // used to be swallowed as soon as the message ALSO had text, so the row said
    // nothing about them. Names stay in the tooltip, and become the body when there
    // is no text at all (as before). The row shows the whole text now, so the tooltip
    // is not carrying a hidden half — it still names the files beside the text.
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

    // Convert between the two delivery modes. The label states the EFFECT, not the
    // mode: they are not two views of the same message, they are delivered at
    // different moments (a steer joins the running loop at its next step and goes
    // first at the end; a queued message waits for the run and keeps FIFO order).
    // SAME RULER AS THE BADGE: the button carries a hidden sizer holding BOTH directions
    // ("→ Queue" and "→ Steer", stacked in one grid cell, so it reports the WIDER) and reads out
    // only its own. Without it a steer row's `→ Queue` was wider than a queued row's `→ Steer`,
    // so the two commands did not line up down the column — and converting a message resized the
    // button under the pointer.
    const convert = document.createElement("button");
    convert.type = "button";
    convert.className = "pending-convert";
    const convertSizer = document.createElement("span");
    convertSizer.className = "mode-pill-sizer";
    convertSizer.setAttribute("aria-hidden", "true");
    for (const label of ["→ Queue", "→ Steer"]) {
      const copy = document.createElement("span");
      copy.textContent = label;
      convertSizer.appendChild(copy);
    }
    const convertLabel = document.createElement("span");
    convertLabel.className = "mode-pill-label";
    convertLabel.textContent = it.mode === "steer" ? "→ Queue" : "→ Steer";
    convert.append(convertSizer, convertLabel);
    setTip(convert, it.mode === "steer" ? "pending.toQueue" : "pending.toSteer");
    convert.addEventListener("click", () =>
      post({ type: "setPendingMode", id: it.id, mode: it.mode === "steer" ? "queue" : "steer" }),
    );

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "pending-cancel";
    cancel.textContent = "×";
    setTip(cancel, it.mode === "steer" ? "pending.cancelSteer" : "pending.cancelQueued");
    cancel.addEventListener("click", () => post({ type: "cancelPending", id: it.id }));

    // The commands sit TOP-RIGHT (pinned with margin-left: auto, so a long message
    // never drags them to the middle).
    const actions = document.createElement("span");
    actions.className = "pending-actions";
    actions.append(convert, cancel);

    // The mark opens the row and the commands close it: nothing between the mark and the text
    // but the pill, exactly as a tool call is `>` + icon + name.
    row.append(mark, badge, main, actions);
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
      // waiting: "Steer (1) · Queue (2)". The number sits in PARENTHESES so the label reads as a
      // name with a count beside it, not as "Steer 1" (which looks like a bahn number).
      const steers = ordered.filter((it) => it.mode === "steer").length;
      const queued = ordered.length - steers;
      headText.textContent = [steers > 0 ? `Steer (${steers})` : "", queued > 0 ? `Queue (${queued})` : ""]
        .filter(Boolean)
        .join(" · ");
      area.replaceChildren(...ordered.map(renderRow));
    },
  };
}
