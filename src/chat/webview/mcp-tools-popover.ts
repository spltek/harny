import { analyzeToolNames, offToolNames } from "./mcp-tool-flags";
import { createSwitch, setSwitch } from "./switch";

/**
 * THE MCP TOOLS POPOVER — "which of this server's tools may the model see, and which may run in
 * Analyze? IN THIS CONVERSATION?"
 *
 * TWO SWITCHES PER TOOL, and they are THE panel's switch (`switch.ts` — the same pill the server
 * list wears) because both answer a question about THIS SESSION: the left one is exposure (the model
 * sees the tool), the right one is the Analyze declaration (the tool may run read-only in Analyze). They
 * used to be a switch and a shield glyph, which asked two questions in two visual languages and read
 * as "what is this checkbox?" — so the second one is labelled, and both follow the same rules:
 *   · a DRAFT until Save, saved in ONE write with the session's scope;
 *   · disabled when the tool is not exposed (nothing to allow) — the pill greys out, no lie;
 *   · inherited (on and not editable) when the SERVER declares every tool of it read-only, which is
 *     a fact of the install, not a choice of this conversation.
 *
 * Everything is a DRAFT until Save: the host persists it, and a save that wrote on every click would
 * respawn an MCP process per click. The module owns the draft, the filter, the counts and the
 * positioning; it reaches the rest of the panel only through `post` and a `busy()` getter.
 *
 * `busy` is a GETTER on purpose: the popover outlives the moment it was built (a run can start
 * underneath it), so a captured boolean would go stale exactly when it matters.
 */

export interface McpToolLike {
  name: string;
  description?: string;
  /** The host's flag: this session has the tool switched OFF. */
  off?: boolean;
  /** The server declares this tool read-only (its own hint). */
  readOnly?: boolean;
  /** THIS SESSION declared it read-only in Analyze (ToolScope.analyze) — what the second switch
   *  edits, and the reason `readOnly` alone is not enough: `readOnly && !analyzeFlag` is the
   *  inherited case, which this panel does not own. */
  analyzeFlag?: boolean;
}

export interface McpToolsPopoverDeps {
  /** The popover container (positioned by this module, emptied on every open). */
  popover: HTMLElement;
  /** The panel's `postMessage`. */
  post: (message: unknown) => void;
  /** Is a run in flight RIGHT NOW? A getter: the answer changes while the popover is open. */
  busy: () => boolean;
}

export interface McpToolsPopover {
  /** Open for `server`, anchored under `anchor`. */
  show(anchor: HTMLElement, server: string, tools: McpToolLike[]): void;
  hide(): void;
  /** The host's answer to a save: success closes, failure keeps the draft and says why. */
  saved(ok: boolean): void;
}

/** Two sets differ? The Save button listens to this. */
function setsDiffer(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return true;
  for (const name of a) if (!b.has(name)) return true;
  return false;
}

interface Draft {
  server: string;
  tools: McpToolLike[];
  /** OFF by name: what is being edited. */
  off: Set<string>;
  /** Declared read-only in Analyze: an INCLUDE list, the opposite polarity of `off`. */
  analyze: Set<string>;
}

export function createMcpToolsPopover(deps: McpToolsPopoverDeps): McpToolsPopover {
  let draft: Draft | null = null;
  let filter = "";
  let listEl: HTMLDivElement | null = null;
  let countEl: HTMLSpanElement | null = null;
  let saveEl: HTMLButtonElement | null = null;
  let statusEl: HTMLSpanElement | null = null;

  const dirty = (): boolean =>
    !!draft &&
    (setsDiffer(draft.off, offToolNames(draft.tools)) || setsDiffer(draft.analyze, analyzeToolNames(draft.tools)));

  /** The counts and the Save button — the only things a toggle changes besides its row. */
  function updateHead(): void {
    if (!draft) return;
    if (countEl) {
      const total = draft.tools.length;
      // Only the EXPOSED ones: a declaration about a tool the model cannot see has no effect in
      // Analyze, so counting it would promise something the run will not do.
      const readOnly = draft.tools.filter((t) => draft?.analyze.has(t.name) && !draft?.off.has(t.name)).length;
      countEl.textContent =
        `${total - draft.off.size} of ${total} enabled` + (readOnly > 0 ? ` · ${readOnly} read-only in Analyze` : "");
    }
    if (saveEl) saveEl.disabled = !dirty();
  }

  /** Rows only: rebuilt when the FILTER changes, so typing never replaces the input in use. */
  function renderRows(): void {
    const list = listEl;
    if (!draft || !list) return;
    list.innerHTML = "";
    const needle = filter.trim().toLowerCase();
    const shown = needle
      ? draft.tools.filter(
          (t) => t.name.toLowerCase().includes(needle) || (t.description ?? "").toLowerCase().includes(needle),
        )
      : draft.tools;
    if (shown.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mcp-pop-empty";
      empty.textContent = draft.tools.length === 0 ? "(no tools)" : "No tool matches the filter.";
      list.appendChild(empty);
      return;
    }
    for (const t of shown) {
      const off = (): boolean => !!draft?.off.has(t.name);
      const declared = (): boolean => !!draft?.analyze.has(t.name);
      /** The server declares EVERY tool of it read-only: there is nothing per-tool to decide here. */
      const inherited = t.readOnly === true && t.analyzeFlag !== true;

      // A <div>, not a <label>: the row used to wrap a checkbox, which is what made a click anywhere
      // in it a press of that box. Each control is a BUTTON of its own, and the row is a shortcut for
      // the FIRST one (a bigger target, the way the server list treats its name).
      const row = document.createElement("div");
      row.className = "mcp-pop-row" + (off() ? " off" : "");

      // ── SWITCH 1 of 2 · EXPOSURE: does the model SEE this tool in this conversation? The panel's
      // one switch (src/chat/webview/switch.ts).
      const sw = createSwitch(`${t.name}: exposed to the model`);
      sw.addEventListener("click", (e) => {
        e.stopPropagation(); // the row is a shortcut for THIS: one press, one flip
        flip();
      });
      row.appendChild(sw);

      const text = document.createElement("span");
      text.className = "mcp-pop-text";
      const name = document.createElement("span");
      name.className = "mcp-pop-name";
      name.textContent = t.name;
      text.appendChild(name);
      if (t.description) {
        const desc = document.createElement("span");
        desc.className = "mcp-pop-desc";
        desc.textContent = t.description;
        text.appendChild(desc);
      }
      row.appendChild(text);

      // ── SWITCH 2 of 2 · ANALYZE: may it RUN in Analyze? The SAME control, LABELLED — two
      // identical pills with no words are a guessing game, and this one has no state a reader could
      // infer from the row.
      const analyzeBox = document.createElement("span");
      analyzeBox.className = "mcp-pop-analyze";
      const analyzeLabel = document.createElement("span");
      analyzeLabel.className = "mcp-pop-analyze-label";
      analyzeLabel.textContent = "Analyze";
      analyzeBox.appendChild(analyzeLabel);
      const run = createSwitch(`${t.name}: runs in Analyze`);
      analyzeBox.appendChild(run);
      row.appendChild(analyzeBox);

      /** One writer for every visible trace of the ANALYZE state: the pill, the box, both titles. */
      const syncAnalyze = (): void => {
        const inert = off();
        const on = !inert && (declared() || inherited);
        setSwitch(run, on);
        // DISABLED, not merely dimmed, in the two cases where a press must do nothing: there is
        // nothing to allow (the model does not see the tool) and nothing to decide (the server
        // declared every tool read-only). Same rule as the exposure switch on a busy run.
        run.disabled = inert || inherited;
        analyzeBox.classList.toggle("on", on);
        analyzeBox.classList.toggle("inherited", inherited);
        const say = inert
          ? "Hidden from the model, so there is nothing to allow in Analyze — switch the tool on first"
          : inherited
            ? "The server declares every tool of it read-only: this one runs in Analyze by the SERVER's statement, not this conversation's"
            : declared()
              ? "Runs in Analyze: this conversation declares it read-only. Click to take it back"
              : "Refused in Analyze: it may modify resources, and an external call cannot be previewed. Click to declare it read-only";
        analyzeBox.title = say;
        run.title = say;
      };
      const flipAnalyze = (): void => {
        if (!draft || off() || inherited) return;
        if (draft.analyze.has(t.name)) draft.analyze.delete(t.name);
        else draft.analyze.add(t.name);
        syncAnalyze();
        updateHead();
      };
      // ONE handler on the whole cluster, so the WORD is as clickable as the pill (the way the row's
      // name toggles exposure) — and it stops there, or the press would reach the row and flip the
      // OTHER switch. A disabled button also swallows its own clicks: the guard is the second belt.
      analyzeBox.addEventListener("click", (e) => {
        e.stopPropagation();
        flipAnalyze();
      });

      /** Every visible trace of the EXPOSURE state — and it re-derives the other switch, because a
       *  hidden tool cannot be declared read-only: two controls, two states, ONE row. */
      const paint = (): void => {
        const on = !off();
        setSwitch(sw, on);
        row.classList.toggle("off", !on);
        const say = on
          ? "The model can call this tool in this conversation"
          : "Hidden: the model does not see this tool in this conversation";
        row.title = say;
        sw.title = say;
      };
      const flip = (): void => {
        if (!draft) return;
        if (draft.off.has(t.name)) draft.off.delete(t.name);
        else draft.off.add(t.name);
        paint();
        syncAnalyze();
        updateHead();
      };
      // The row stays a shortcut for EXPOSURE (a bigger target than a 26px pill), exactly like the
      // server list, where the NAME toggles too. The Analyze cluster stops its own clicks above.
      row.addEventListener("click", flip);

      paint();
      syncAnalyze();
      list.appendChild(row);
    }
  }

  function hide(): void {
    deps.popover.classList.add("hidden");
    deps.popover.dataset.server = "";
    draft = null;
    filter = "";
    listEl = null;
    countEl = null;
    saveEl = null;
    statusEl = null;
  }

  function show(anchor: HTMLElement, server: string, tools: McpToolLike[]): void {
    draft = { server, tools, off: offToolNames(tools), analyze: analyzeToolNames(tools) };
    filter = "";
    deps.popover.innerHTML = "";

    const head = document.createElement("div");
    head.className = "mcp-pop-head";
    const title = document.createElement("span");
    title.className = "mcp-pop-title";
    title.textContent = `🧩 ${server}`;
    head.appendChild(title);
    countEl = document.createElement("span");
    countEl.className = "mcp-pop-count";
    head.appendChild(countEl);
    deps.popover.appendChild(head);

    // One line that says what the two pills do, because they are identical by design and the WORD
    // next to the second one is the only thing that tells them apart.
    const legend = document.createElement("div");
    legend.className = "mcp-pop-legend";
    legend.textContent =
      "Left: the model sees the tool · Analyze: it may run read-only · Both for this conversation only";
    deps.popover.appendChild(legend);

    // Only worth a filter when the list is long enough to scroll: a two-tool server does not need
    // a search box.
    if (tools.length > 8) {
      const box = document.createElement("input");
      box.type = "search";
      box.className = "mcp-pop-filter";
      box.placeholder = "Filter tools";
      box.spellcheck = false;
      box.setAttribute("aria-label", "Filter tools");
      box.addEventListener("input", () => {
        filter = box.value;
        renderRows();
      });
      deps.popover.appendChild(box);
    }

    listEl = document.createElement("div");
    listEl.className = "mcp-pop-list";
    deps.popover.appendChild(listEl);
    renderRows();

    const actions = document.createElement("div");
    actions.className = "mcp-pop-actions";
    statusEl = document.createElement("span");
    statusEl.className = "mcp-pop-status";
    actions.appendChild(statusEl);

    const mini = (label: string, title: string, onClick: () => void, extra = "secondary"): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `${extra} mcp-pop-mini`;
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener("click", onClick);
      return btn;
    };

    const all = mini("All", "Include every tool of this server", () => {
      draft?.off.clear();
      renderRows();
      updateHead();
    });
    const none = mini("None", "Expose no tool of this server", () => {
      if (draft) draft.off = new Set(draft.tools.map((t) => t.name));
      renderRows();
      updateHead();
    });
    const cancel = mini("Cancel", "Discard these changes", () => hide());
    saveEl = mini(
      "Save",
      "Apply to THIS conversation: which tools the model sees, and which run in Analyze",
      () => {
        // Captured once: a call in between resets TS's narrowing on the outer `let`.
        const d = draft;
        if (!d) return;
        // Writing mid-run would swap the tool list under a live turn (and kill any in-flight MCP
        // call): the same reason the server's own switch is locked. Read NOW, not at build.
        if (deps.busy()) {
          if (statusEl) {
            statusEl.textContent = "Stop the run first";
            statusEl.className = "mcp-pop-status err";
          }
          return;
        }
        if (statusEl) {
          statusEl.textContent = "Saving…";
          statusEl.className = "mcp-pop-status";
        }
        // ONE message, ONE write: the session's scope holds BOTH answers (`off` and `analyze`), so
        // sending them apart is how the two halves could disagree for a moment. Sent as INTENT: the
        // names the session wants exposed and the name it declares read-only. Turning them into scope
        // names (sanitized prefix, merged with the other decisions) is the host's job — one spelling
        // of the rule, on the side that owns it. Nothing in the config file is written.
        deps.post({
          type: "setMcpToolSelection",
          server: d.server,
          enabled: d.tools.filter((t) => !d.off.has(t.name)).map((t) => t.name),
          analyze: [...d.analyze],
        });
      },
      "",
    );
    actions.appendChild(all);
    actions.appendChild(none);
    actions.appendChild(cancel);
    actions.appendChild(saveEl);
    deps.popover.appendChild(actions);
    updateHead();

    deps.popover.dataset.server = server;
    deps.popover.classList.remove("hidden");
    // Anchor below-left of the key, clamped to the viewport.
    const rect = anchor.getBoundingClientRect();
    const w = deps.popover.offsetWidth;
    const h = deps.popover.offsetHeight;
    let left = rect.left;
    let top = rect.bottom + 4;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
    if (top + h > window.innerHeight - 8) top = rect.top - h - 4;
    deps.popover.style.left = Math.max(8, left) + "px";
    deps.popover.style.top = Math.max(8, top) + "px";
  }

  return {
    show,
    hide,
    saved(ok: boolean): void {
      // On success the host has already re-pushed the statuses and the config (the card re-renders
      // with the new counts), so the panel can close; on failure it must STAY OPEN with the draft
      // intact, or the choice is lost.
      if (ok) hide();
      else if (statusEl) {
        statusEl.textContent = "Save failed — see Output > Harny";
        statusEl.className = "mcp-pop-status err";
      }
    },
  };
}
