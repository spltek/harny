import { offToolNames } from "./mcp-tool-flags";
import { createSwitch, setSwitch, switchIsOn } from "./switch";

/**
 * THE MCP CARD — one row per installed server, in the control strip.
 *
 * It owns the row's whole vocabulary: the SESSION switch (installing a server is global, USING it
 * is a decision of this conversation), the name shortcut, the `(N/M tools)` button that opens the
 * tools panel, and the status line (off / error / connected). It owns the redraw signature too, so a
 * config push that changed nothing costs no DOM.
 *
 * What it does NOT own, deliberately: the tools popover (a draft with its own state, injected as a
 * callback) and every message. Rendering here is pure, except for the two things the user CLICKS,
 * which go out through `post`.
 */

/** The shape the host sends for one server, as far as this card needs it. */
interface McpServerStatusLike {
  name: string;
  ok?: boolean;
  /** `false` = not installed/enabled on this machine: a fact, not a session choice. */
  enabled?: boolean;
  error?: string;
  toolCount?: number;
  tools?: { name: string; off?: boolean }[];
}

interface McpCardConfig {
  servers?: Record<string, unknown>;
  statuses?: McpServerStatusLike[];
}

interface ToolScopeLike {
  mcp: string[];
  off: string[];
}

/**
 * How long an optimistic switch flip waits for the host to confirm it.
 *
 * The pill moves on click (waiting for the round trip made it feel broken — the config push
 * re-fetches every provider's model list first). That paint is a PROMISE, and nothing else would keep
 * it honest: the rows are rebuilt only when the payload's signature changes, so a failed
 * `saveSettings` produces no new payload and the pill would sit on a state the session does not have.
 * After this window, with no redraw, the pill goes back to the scope it was built from.
 *
 * 3s: longer than a healthy round trip (milliseconds) plus a full `buildConfig` behind a slow host,
 * shorter than a user's patience for a switch that lied.
 */
const PENDING_REVERT_MS = 3_000;

export interface McpCardDeps {
  /** The card element (hidden when no server is installed). */
  card: HTMLElement;
  /** The rows container. */
  list: HTMLElement;
  /** Where the messages go (the panel's `vscode.postMessage`). */
  post: (message: unknown) => void;
  /** Open the tools panel anchored to the `(N/M tools)` button. Injected: it is another module's
   *  job (a draft with its own state), and the card only needs to point at it. */
  openTools: (anchor: HTMLElement, server: string, tools: { name: string; off?: boolean }[]) => void;
}

export interface McpCard {
  /** Redraw from the payload, the session's scope and whether a run is in flight. */
  render(mcp: McpCardConfig | undefined, scope: ToolScopeLike, busy: boolean): void;
  /** Re-apply only the switches' availability (a run started or ended between two pushes). */
  refreshSwitches(busy: boolean): void;
  /** The last statuses drawn — other panels read them for tool lists. */
  statuses(): McpServerStatusLike[];
}

export function createMcpCard(deps: McpCardDeps): McpCard {
  let drawn = "";
  /**
   * How many times the rows were REBUILT. An optimistic flip captures it and gives up if it has not
   * moved: a rebuild re-derives every pill from the payload, which is the only thing that can confirm
   * or overrule the paint. A push with an UNCHANGED signature does not count — the rows were not
   * rebuilt, `refreshSwitches` only touches availability, so the promise is still unconfirmed.
   */
  let builds = 0;
  let statuses: McpServerStatusLike[] = [];
  /**
   * The busy flag the CLICK handlers read.
   *
   * The rows are built once per signature, so a handler capturing `busy` would keep the value of the
   * moment the row was built — a run starting later would not lock it. This is the CURRENT one:
   * every render/refresh writes it, and the handlers read it when the click happens.
   */
  let busyAtClick = false;

  function refreshSwitches(busy: boolean): void {
    for (const sw of deps.list.querySelectorAll<HTMLButtonElement>(".harny-switch")) {
      // Three reasons a switch cannot be flipped, in order of fatality: the server is not installed
      // here (a machine fact), a run is in flight (a mid-run toggle would only land on the next
      // turn), or it is simply available.
      const installed = sw.dataset.installed !== "0";
      sw.disabled = !installed || busy;
      const name = sw.dataset.name ?? "this server";
      sw.title = !installed
        ? "Not installed/enabled in the config: turn it on there first"
        : busy
          ? "Stop the run first — a mid-run toggle only lands on the next turn"
          : `Use ${name} in this session (installing it is global, using it is per conversation)`;
    }
  }

  function render(mcp: McpCardConfig | undefined, scope: ToolScopeLike, busy: boolean): void {
    // The SESSION's scope is part of what the rows show (the switch is on/off for THIS conversation),
    // so it belongs in the signature: without it, flipping a switch would not redraw anything.
    const signature = JSON.stringify({ servers: mcp?.servers ?? {}, statuses: mcp?.statuses ?? [], scope });
    if (signature === drawn) {
      // Nothing changed in the payload — but the RUN may have: a run can start or stop between two
      // config pushes, and the switches must look unavailable either way.
      busyAtClick = busy;
      refreshSwitches(busy);
      return;
    }
    drawn = signature;
    builds++;
    statuses = mcp?.statuses ?? [];
    const names = Object.keys(mcp?.servers ?? {});
    deps.card.classList.toggle("hidden", names.length === 0);
    deps.list.innerHTML = "";
    for (const name of names) {
      const st = statuses.find((s) => s.name === name);
      const enabled = st?.enabled !== false;
      // TWO facts, two controls' worth of meaning: `enabled: false` in the config is the MACHINE's
      // (uninstalled/unavailable here); the SWITCH is THIS conversation's, and a new session starts
      // with every server off.
      const onInSession = scope.mcp.includes(name);
      const row = document.createElement("div");
      row.className = "mcp-status " + (!enabled ? "off" : onInSession && st?.ok ? "ok" : onInSession ? "err" : "off");

      // The SWITCH is the control: THE panel's on/off pill (src/chat/webview/switch.ts, one look
      // everywhere). It exists because the affordance was invisible — the name was the toggle and
      // nothing said so.
      const sw = createSwitch(`${onInSession ? "Stop using" : "Use"} ${name} in this session`, onInSession);
      /** The pending confirmation of THIS row's last flip (one per row, so a new click supersedes it). */
      let pendingRevert: ReturnType<typeof setTimeout> | undefined;
      sw.title = enabled
        ? "Use this server in THIS session (installing it is global, using it is per conversation)"
        : "Not installed/enabled in the config: turn it on there first";
      sw.dataset.name = name;
      sw.dataset.installed = enabled ? "1" : "0";
      sw.disabled = !enabled;
      sw.addEventListener("click", () => {
        if (busyAtClick || !enabled) return;
        // The session's scope is the ONE thing written here: adding or dropping this server while
        // leaving every other decision (another server, a built-in) exactly as it was.
        //
        // The NEXT state is read from the PILL, not from the `onInSession` captured when this row was
        // built. Two reasons, and the second is why a test exists: the paint is optimistic (see
        // below), so the DOM is ahead of the payload; and rows survive until the next render, so a
        // quick second click on a captured `onInSession` would post the OLD direction again and leave
        // the user pressing a switch that never comes back.
        const turningOn = !switchIsOn(sw);
        const mcp = scope.mcp.filter((s) => s !== name);
        if (turningOn) mcp.push(name);
        // ANSWER NOW. The pill used to wait for the host's next config push to move, and that push
        // re-fetches every provider's model list first: with one slow or unreachable host the switch
        // sat there for seconds and read as broken. The write is a message away and the host
        // re-states the truth immediately after it (`setToolScope` answers with a config), so the
        // paint is optimistic and not a lie for longer than one round trip — a failed write is
        // corrected by the config that follows.
        setSwitch(sw, turningOn);
        deps.post({ type: "setToolScope", scope: { ...scope, mcp } });
        // …and the promise has an expiry. A rebuild of the rows re-derives the pill from the payload,
        // so it is the ONLY event that confirms this flip; if none comes, the write did not land and
        // the pill returns to the scope this row was built from. `isConnected` covers the other exit:
        // a rebuild REPLACES this node, so a late timer must not paint a detached one.
        if (pendingRevert !== undefined) clearTimeout(pendingRevert);
        const builtAt = builds;
        pendingRevert = setTimeout(() => {
          pendingRevert = undefined;
          if (builds === builtAt && sw.isConnected) setSwitch(sw, onInSession);
        }, PENDING_REVERT_MS);
      });
      row.appendChild(sw);

      // The name is just the name: the switch carries the state, so the leading ● is gone.
      const nameEl = document.createElement("span");
      nameEl.className = "mcp-name";
      nameEl.textContent = name;
      nameEl.title = enabled ? "Click to disable this server" : "Click to enable this server";
      nameEl.addEventListener("click", () => {
        // Not while the session is working: the current run's tool list is already fixed, so a
        // mid-run disable would only take effect on the NEXT turn.
        if (busyAtClick) return;
        deps.post({ type: "toggleMcpServer", name, enabled: !enabled });
      });
      row.appendChild(nameEl);
      row.appendChild(document.createTextNode(" "));

      if (!enabled) {
        const detail = document.createElement("span");
        detail.className = "mcp-detail";
        detail.textContent = "off";
        row.appendChild(detail);
      } else if (st?.ok) {
        const total = st.tools?.length ?? st.toolCount ?? 0;
        // The count is THIS SESSION's, not the registry's: the tools are all registered (a server is
        // installed once), so what tells the user something is off is the scope. Reading
        // `st.toolCount` here said "(2 tools)" while the model could only see one.
        const hidden = offToolNames(st.tools).size;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "mcp-tools-btn";
        // `(5/8 tools)` says at a glance that something is off; `(8 tools)` when nothing is, so the
        // common case stays quiet.
        btn.textContent = hidden > 0 ? `(${total - hidden}/${total} tools)` : `(${total} tools)`;
        btn.title =
          hidden > 0
            ? `${hidden} of ${total} tool(s) switched off in this session — click to choose`
            : "Choose which of this server's tools the model sees";
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          deps.openTools(btn, name, st.tools ?? []);
        });
        row.appendChild(btn);
      } else {
        const detail = document.createElement("span");
        detail.className = "mcp-detail";
        detail.textContent = st?.error ?? "not connected";
        // The row is ONE line, always: the full error (npm's log path, an HTTP body) stays in the
        // tooltip, so the card's height never changes under the cursor.
        detail.title = detail.textContent;
        row.appendChild(detail);
      }
      deps.list.appendChild(row);
    }
    busyAtClick = busy;
    refreshSwitches(busy);
  }

  return {
    render,
    refreshSwitches(busy: boolean): void {
      busyAtClick = busy;
      refreshSwitches(busy);
    },
    statuses(): McpServerStatusLike[] {
      return statuses;
    },
  };
}
