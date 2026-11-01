/**
 * THE MCP SERVER EDITOR — the install/edit/delete form.
 *
 * This is the MACHINE's side of MCP (a server is installed once), as opposed to the card's switch
 * and the tools panel (a decision of one conversation). Saving posts the WHOLE map, so the editor
 * owns a local draft of it: a selection change, "+ New" or Delete must never drop what was typed.
 *
 * Two rules that are easy to lose and are pinned by tests:
 *   · the keys the form does NOT edit SURVIVE a save (`analyze`, `excludeTools`, …) — the file is
 *     the user's too, and rebuilding an entry from the form's fields silently stripped them;
 *   · a server is EITHER stdio (`command`) OR HTTP (`url`), so switching to one DELETES the other,
 *     or the normalizer (which prefers `command`) would silently ignore the switch.
 *
 * `busy` is a getter: the modal can be open when a run starts, and saving reconnects every server —
 * which would swap the tool list under a live turn.
 */

interface McpEditorServerLike {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  /** Unknown keys belong to the user and survive a save. */
  [key: string]: unknown;
}

interface McpEditorDeps {
  modal: HTMLElement;
  backdrop: HTMLElement | null;
  select: HTMLSelectElement;
  name: HTMLInputElement;
  url: HTMLInputElement;
  command: HTMLInputElement;
  args: HTMLTextAreaElement;
  env: HTMLTextAreaElement;
  headers: HTMLTextAreaElement;
  enabled: HTMLInputElement;
  add: HTMLButtonElement;
  del: HTMLButtonElement;
  save: HTMLButtonElement;
  cancel: HTMLButtonElement;
  test: HTMLButtonElement;
  testResult: HTMLElement;
  /** The panel's `postMessage`. */
  post: (message: unknown) => void;
  /** Is a run in flight RIGHT NOW? A getter: the modal can be open when one starts. */
  busy: () => boolean;
}

export interface McpEditor {
  /** The gear's handler: refuse mid-run, clear the result line, ask the host for the servers. */
  open(): void;
  /** The host's answer (`mcpServers`): adopt the map, and open the modal when `open` is true. */
  render(data: { servers?: Record<string, McpEditorServerLike> } | undefined, open: boolean): void;
  /** Why a save was refused — on the same line Test uses. */
  error(reason: string): void;
  close(): void;
}

/** `KEY=VALUE` (or `KEY: VALUE`, the HTTP convention) lines → a map. */
export function parseMcpPairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    // Whichever separator comes FIRST wins, so `SOME_URL=http://x:1234` keeps its colon inside the
    // value and `Authorization: Bearer a=b` keeps its `=`.
    const eq = t.indexOf("=");
    const colon = t.indexOf(":");
    const sep = eq > 0 && (colon < 0 || eq < colon) ? eq : colon;
    if (sep <= 0) continue;
    out[t.slice(0, sep).trim()] = t.slice(sep + 1).trim();
  }
  return out;
}

export function createMcpEditor(deps: McpEditorDeps): McpEditor {
  let servers: Record<string, McpEditorServerLike> = {};
  let selected = "";

  function refreshSelect(): void {
    deps.select.innerHTML = "";
    for (const name of Object.keys(servers)) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      deps.select.appendChild(opt);
    }
    deps.select.value = selected;
  }

  function loadIntoForm(name: string): void {
    selected = name;
    const s = servers[name] ?? {};
    deps.name.value = name;
    deps.url.value = s.url ?? "";
    deps.command.value = s.command ?? "";
    deps.args.value = (s.args ?? []).join("\n");
    deps.env.value = Object.entries(s.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    deps.headers.value = Object.entries(s.headers ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    deps.enabled.checked = s.enabled !== false;
    deps.testResult.textContent = "";
    deps.testResult.className = "mcp-io";
  }

  function clearForm(): void {
    selected = "";
    deps.name.value = "";
    deps.url.value = "";
    deps.command.value = "";
    deps.args.value = "";
    deps.env.value = "";
    deps.headers.value = "";
    deps.enabled.checked = true;
  }

  /** Read the form into a server config (args one per line, env/headers KEY=VALUE). */
  function formServer(): McpEditorServerLike {
    // The keys this form does NOT edit SURVIVE the save: the config file is the user's too. It used
    // to rebuild the entry from its own fields, so editing a server here silently stripped
    // `analyze` and `excludeTools`, and an HTTP server came back as a stdio one with no `command`.
    const prev = servers[selected] ?? {};
    const url = deps.url.value.trim();
    const next: McpEditorServerLike = { ...prev, enabled: deps.enabled.checked };
    if (url) {
      // A server is EITHER stdio OR HTTP, and the normalizer prefers `command`: writing a leftover
      // command here would make "switch it to HTTP" silently do nothing.
      delete next.command;
      delete next.args;
      delete next.env;
      next.url = url;
      const headers = parseMcpPairs(deps.headers.value);
      if (Object.keys(headers).length > 0) next.headers = headers;
      else delete next.headers;
      return next;
    }
    const command = deps.command.value.trim();
    // No command typed = keep the one it has. Neither a URL nor a command means there is no server
    // to write (the normalizer would drop it): keep the entry as it was.
    if (!command && !prev.command) return next;
    if (command) next.command = command;
    delete next.url;
    delete next.headers;
    next.args = deps.args.value
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    // `env` IS edited here, so an emptied box clears it (spreading `prev` alone would make "remove
    // every variable" impossible).
    const env = parseMcpPairs(deps.env.value);
    if (Object.keys(env).length > 0) next.env = env;
    else delete next.env;
    return next;
  }

  /**
   * Commit the FORM into the local DRAFT (no message): a selection change, + New or Delete must not
   * silently drop what was just typed. Returns the name the entry has after the commit, because the
   * form can RENAME it.
   */
  function commit(): string {
    const old = selected;
    const name = deps.name.value.trim() || old;
    if (!name) return "";
    if (old && name !== old) delete servers[old];
    servers[name] = formServer();
    selected = name;
    return name;
  }

  // ── wiring ──────────────────────────────────────────────────────────────
  deps.cancel.addEventListener("click", () => close());
  deps.backdrop?.addEventListener("click", () => close());
  deps.select.addEventListener("change", () => {
    const target = deps.select.value;
    if (!servers[target]) return;
    // Commit what is on screen FIRST: switching server must not throw away an edit that was typed
    // but not saved (it stays a draft — Cancel still discards the whole thing). The refresh
    // REBUILDS the options, so the target has to be selected again before it is loaded.
    commit();
    refreshSelect();
    deps.select.value = target;
    loadIntoForm(target);
  });
  deps.add.addEventListener("click", () => {
    // Same rule as a selection change: the form in front of you is kept before a new entry opens.
    commit();
    let name = "server";
    let i = 1;
    while (servers[name]) name = `server-${++i}`;
    servers[name] = { command: "npx", args: [] };
    selected = name;
    refreshSelect();
    loadIntoForm(name);
    deps.name.focus();
    deps.name.select();
  });
  deps.del.addEventListener("click", () => {
    // The form may have RENAMED this server: commit it so Delete hits the entry you see.
    const name = commit() || selected;
    if (!name) return;
    delete servers[name];
    selected = Object.keys(servers)[0] ?? "";
    refreshSelect();
    if (selected) loadIntoForm(selected);
    else clearForm();
  });
  deps.test.addEventListener("click", () => {
    const s = formServer();
    // A server is EITHER a command (stdio) OR a URL (HTTP): requiring a command here made Test
    // unusable for every remote server, with the form filled in correctly.
    if (!s.command && !s.url) {
      deps.testResult.textContent = "Enter a command (stdio) or a URL (HTTP)";
      deps.testResult.className = "mcp-io err";
      return;
    }
    deps.testResult.textContent = "Testing…";
    deps.testResult.className = "mcp-io";
    deps.post({ type: "testMcpServer", server: s });
  });
  deps.save.addEventListener("click", () => {
    // Saving RECONNECTS every server (that is how the tool list is rebuilt), which kills any
    // in-flight MCP call and swaps the tools under a live turn: the same guard the server's name
    // toggle and the tools panel already had.
    if (deps.busy()) {
      deps.testResult.textContent = "Stop the run before saving — it reconnects the servers";
      deps.testResult.className = "mcp-io err";
      return;
    }
    const old = selected;
    const name = deps.name.value.trim() || old;
    if (old && name !== old) delete servers[old];
    if (name) servers[name] = formServer();
    selected = name;
    deps.post({ type: "saveMcpServers", servers });
  });

  function close(): void {
    deps.modal.classList.add("hidden");
  }

  return {
    open(): void {
      // The gear is already disabled mid-run; this is the same rule one level down, for any future
      // caller (a menu, a shortcut, a host route).
      if (deps.busy()) return;
      deps.testResult.textContent = "";
      deps.testResult.className = "mcp-io";
      deps.post({ type: "getMcpServers" });
    },
    render(data, openIt: boolean): void {
      servers = data?.servers ?? {};
      if (openIt) {
        const names = Object.keys(servers);
        selected = names[0] ?? "";
        refreshSelect();
        if (selected) loadIntoForm(selected);
        else clearForm();
        deps.modal.classList.remove("hidden");
      } else if (!deps.modal.classList.contains("hidden")) {
        // A background change (e.g. the card toggle): refresh the open editor list.
        refreshSelect();
      }
    },
    error(reason: string): void {
      deps.testResult.className = "mcp-io err";
      deps.testResult.textContent = `❌ ${reason}`;
    },
    close,
  };
}
