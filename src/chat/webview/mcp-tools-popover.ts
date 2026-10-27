/**
 * THE MCP TOOLS POPOVER — "which of this server's tools may the model see, here?"
 *
 * Two controls per tool, two different questions:
 *   · the CHECKBOX is the session's scope (the model sees it in this conversation);
 *   · the SHIELD is the Analyze declaration (`analyzeTools`, an INCLUDE list — Analyze is denied by
 *     default, so a tool has to be named), and when the server's own `analyze` declaration already
 *     allows everything the shield says so instead of pretending a per-tool rule did it.
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
  /** YOU declared it read-only in Analyze (`analyzeTools`). */
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

/** The tools this session has OFF, by name (the host's flag). */
function savedOff(tools: McpToolLike[]): Set<string> {
  return new Set(tools.filter((t) => t.off).map((t) => t.name));
}

/** The tools declared read-only in Analyze. */
function savedAnalyze(tools: McpToolLike[]): Set<string> {
  return new Set(tools.filter((t) => t.analyzeFlag).map((t) => t.name));
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
    !!draft && (setsDiffer(draft.off, savedOff(draft.tools)) || setsDiffer(draft.analyze, savedAnalyze(draft.tools)));

  /** The counts and the Save button — the only things a toggle changes besides its row. */
  function updateHead(): void {
    if (!draft) return;
    if (countEl) {
      const total = draft.tools.length;
      const readOnly = draft.analyze.size;
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
      const row = document.createElement("label");
      row.className = "mcp-pop-row" + (off() ? " off" : "");
      row.title = off() ? "Excluded: the model does not see this tool" : "Included: the model can call this tool";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !off();
      box.setAttribute("aria-label", t.name);
      box.addEventListener("change", () => {
        if (!draft) return;
        if (box.checked) draft.off.delete(t.name);
        else draft.off.add(t.name);
        row.classList.toggle("off", !box.checked);
        row.title = box.checked
          ? "Included: the model can call this tool"
          : "Excluded: the model does not see this tool";
        syncShield();
        updateHead();
      });
      row.appendChild(box);

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

      // The second control: this tool runs in ANALYZE (declared read-only by YOU). The narrowest
      // statement available, and the only way to allow one safe tool of an otherwise refused server.
      const shield = document.createElement("button");
      shield.type = "button";
      /** Allowed because the SERVER says so, not because of a per-tool rule. */
      const inherited = t.readOnly === true && t.analyzeFlag !== true;
      const syncShield = (): void => {
        // A tool the model cannot see is not registered at all, so its Analyze flag is inert:
        // saying "read-only in Analyze" there would be a lie.
        const isOff = off();
        const on = !isOff && (!!draft?.analyze.has(t.name) || inherited);
        shield.className =
          "mcp-pop-shield" + (on ? " on" : "") + (inherited ? " inherited" : "") + (isOff ? " inert" : "");
        shield.textContent = on ? "🛡" : "·";
        shield.setAttribute("aria-pressed", String(on));
        shield.setAttribute("aria-label", `${t.name}: ${on ? "read-only" : "not allowed"} in Analyze`);
        shield.disabled = inherited || isOff;
        shield.title = isOff
          ? "The model does not see this tool, so there is nothing to allow in Analyze — include it first"
          : inherited
            ? "Allowed by the server's own Analyze declaration — every tool of it runs in Analyze"
            : draft?.analyze.has(t.name)
              ? "Read-only in Analyze because YOU said so — click to take it back"
              : "Does NOT run in Analyze. Click to declare this tool read-only there";
      };
      shield.addEventListener("click", (e) => {
        e.preventDefault(); // the row is a <label>: do not forward the click to the checkbox
        e.stopPropagation();
        if (!draft || inherited || off()) return;
        if (draft.analyze.has(t.name)) draft.analyze.delete(t.name);
        else draft.analyze.add(t.name);
        syncShield();
        updateHead();
      });
      syncShield(); // paint the initial state: a shield without a class is not a shield
      row.appendChild(shield);
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
    draft = { server, tools, off: savedOff(tools), analyze: savedAnalyze(tools) };
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
      "Apply to this session (and to the server's config)",
      () => {
        // Captured once: a call in between resets TS's narrowing on the outer `let`.
        const d = draft;
        if (!d) return;
        // Reconnecting mid-run would swap the tool list under a live turn (and kill any in-flight
        // MCP call): the same reason the server's name toggle is locked. Read NOW, not at build.
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
        deps.post({
          type: "setMcpToolExclusions",
          server: d.server,
          exclude: [...d.off],
          // The opposite polarity rides along: the tools declared read-only in Analyze.
          analyze: [...d.analyze],
        });
        // …and this SESSION's selection for the same server, sent as INTENT: the names it wants
        // ENABLED. Turning that into scope names (sanitized prefix, merged with every other
        // decision) is the host's job — one spelling of the rule, on the side that owns it.
        deps.post({
          type: "setMcpToolSelection",
          server: d.server,
          enabled: d.tools.filter((t) => !d.off.has(t.name)).map((t) => t.name),
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
