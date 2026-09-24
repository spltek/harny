// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";

const posted: unknown[] = [];

function setupDom(initOverrides: Record<string, unknown> = {}): void {
  const init = {
    sessions: [
      { id: "a", name: "Refactor", createdAt: 1, updatedAt: 2, messageCount: 3 },
      { id: "b", name: "Debug", createdAt: 2, updatedAt: 1, messageCount: 1 },
    ],
    openIds: ["a", "b"],
    activeId: "a",
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
    config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 },
    ...initOverrides,
  };
  document.body.innerHTML = `
    <div id="session-head"><span class="toggle">▼</span><span>Sessions</span><span class="spacer"></span><button id="new-session">＋</button><button id="sessions-gear-btn">⚙</button></div>
    <div id="sessions"></div>
    <div id="tabs"></div>
    <div id="messages"></div>
    <div id="working-bar" class="hidden">● Working...</div>
    <div id="input-area">
      <div id="input-main">
        <button id="attach-btn">+</button>
        <textarea id="user-input" rows="1"></textarea>
        <button id="send-btn">▶</button>
        <button id="abort-btn" disabled>⏹</button>
      </div>
      <div id="mode-select">
        <button type="button" id="mode-btn" aria-haspopup="listbox" aria-expanded="false">
          <svg id="mode-btn-icon-analyze" width="12" height="12"></svg>
          <svg id="mode-btn-icon-agent" class="hidden" width="12" height="12"></svg>
          <span id="mode-btn-label">Analyze</span>
        </button>
        <div id="mode-menu" class="hidden" role="listbox">
          <button type="button" class="mode-item is-active" data-mode="analyze" role="option" aria-selected="true">Analyze</button>
          <button type="button" class="mode-item" data-mode="agent" role="option" aria-selected="false">Agent</button>
        </div>
      </div>
      <button type="button" id="multi-btn" aria-pressed="false">multi</button>
      <div id="attach-row">
        <div id="attachment-chips" class="hidden"></div>
      </div>
    </div>
    <div id="status">AI Model: <select id="model-select"></select><button id="gear-btn">⚙</button><button id="ctx-minus">−</button><input id="ctx-input" type="text" value="128000"><button id="ctx-plus">+</button><button id="out-minus">−</button><input id="out-input" type="text" value="8192"><button id="out-plus">+</button><input id="sampler-temp" type="radio" name="sampler" checked><input id="sampler-topp" type="radio" name="sampler"><button id="samp-minus">−</button><input id="samp-input" type="text" placeholder="Auto"><button id="samp-plus">+</button><button id="samp-auto">Auto</button><button id="presence-minus">−</button><input id="presence-input" type="text" placeholder="Auto"><button id="presence-plus">+</button><button id="presence-auto">Auto</button><button id="freq-minus">−</button><input id="freq-input" type="text" placeholder="Auto"><button id="freq-plus">+</button><button id="freq-auto">Auto</button></div>
    <div id="metrics"><select id="thinking-select"><option value="off">Off</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select><span id="met-tokens"></span><span id="met-ctx"></span><span id="met-pct"></span><span id="met-cache"></span><div id="ctx-bar-wrap"><div id="ctx-bar"></div></div><button id="compact-btn">Compact</button><span id="compact-threshold-label"></span><button id="compact-settings-btn">⚙</button></div>
    <div id="compact-settings-modal" class="hidden">
      <div class="cs-backdrop"></div>
      <div class="cs-card">
        <h3>Compaction settings</h3>
        <div class="cs-field">
          <label for="compact-threshold-input">Compaction threshold (%)</label>
          <input id="compact-threshold-input" type="number" min="1" max="100" />
        </div>
        <div class="cs-actions">
          <button id="compact-settings-cancel" class="secondary">Cancel</button>
          <button id="compact-settings-save">Save</button>
        </div>
      </div>
    </div>
    <div id="model-warn"></div>
    <div id="providers-modal" class="hidden">
      <div class="providers-backdrop"></div>
      <div class="providers-card">
        <h3>Providers</h3>
        <select id="provider-select"></select>
        <input id="pe-name" type="text" />
        <input id="pe-baseurl" type="text" />
        <input id="pe-apikey" type="text" />
        <select id="pe-thinking"><option value="effort">Effort</option><option value="bool">Bool</option><option value="unspecified">Unspecified</option></select>
        <input id="pe-session-header" type="text" />
        <button id="provider-test" class="secondary">Test</button>
        <button id="provider-delete" class="secondary">Delete</button>
        <button id="provider-add" class="secondary">+ New</button>
        <div id="provider-test-result" class="hidden"></div>
        <button id="providers-save">Save</button>
        <button id="providers-cancel" class="secondary">Cancel</button>
      </div>
    </div>
    <div id="ctl-toggle"><button id="ctl-toggle-btn"></button></div>
    <div id="name-modal" class="hidden">
      <div class="name-modal-backdrop"></div>
      <div class="name-modal-card">
        <h3 id="name-modal-title">Name the new session</h3>
        <input id="name-input" type="text" />
        <div id="name-error"></div>
        <div class="name-modal-actions">
          <button id="name-cancel" class="secondary">Cancel</button>
          <button id="name-ok">Create</button>
        </div>
      </div>
    </div>
    <div id="alert-modal" class="hidden">
      <div class="alert-backdrop"></div>
      <div class="alert-card">
        <h3 id="alert-title"></h3>
        <div id="alert-message" class="alert-message"></div>
        <div class="alert-actions">
          <button id="alert-cancel" class="secondary">Cancel</button>
          <button id="alert-ok">OK</button>
        </div>
      </div>
    </div>
    <div id="openwhere-modal" class="hidden">
      <div class="ow-backdrop"></div>
      <div class="ow-card">
        <h3 id="ow-title"></h3>
        <div id="ow-message" class="ow-message"></div>
        <div class="ow-actions">
          <button id="ow-cancel" class="secondary">Cancel</button>
          <button id="ow-here" class="secondary">Here</button>
          <button id="ow-new">New window</button>
        </div>
      </div>
    </div>
    <div id="sessions-modal" class="hidden">
      <div class="sm-backdrop"></div>
      <div class="sm-card">
        <div class="sm-head">
          <h3>All sessions</h3>
          <span class="sm-hint">hint</span>
        </div>
        <div id="sessions-manager-list"></div>
        <div class="sm-footer">
          <button id="sessions-close" class="secondary">Close</button>
        </div>
      </div>
    </div>
    <script id="harny-view-init" type="application/json">${JSON.stringify(init)}</script>
  `;
  (globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
    postMessage: (m: unknown) => posted.push(m),
    getState: () => ({}),
    setState: () => {},
  });
}

async function loadView(): Promise<void> {
  vi.resetModules();
  await import("./view");
}

describe("view webview client", () => {
  beforeEach(() => {
    posted.length = 0;
    setupDom();
  });

  it("keeps failed providers visible in the model dropdown, and falls back to 'pick one' when the saved model is gone", async () => {
    await loadView();
    const select = document.getElementById("model-select") as HTMLSelectElement;

    // Host fetch failures: the provider STILL appears (red group + error), and
    // the saved model that is no longer served shows the splash placeholder.
    hostMessage({
      type: "config",
      config: { provider: "openai", model: "old-model", hasKey: true, hostModelErrors: [{ provider: "llamacpp", error: "HTTP 500" }], models: [], providerModels: [{ provider: "openai", model: "gpt-4o" }], contextWindow: 128000 },
    });

    // The failed provider's own optgroup exists with the error message.
    const failedGroup = [...select.querySelectorAll<HTMLOptGroupElement>("optgroup")].find(
      (g) => g.label === "llamacpp",
    );
    expect(failedGroup).toBeTruthy();
    expect(failedGroup!.textContent).toContain("HTTP 500");

    // The saved model is gone from the list: pick-one placeholder is shown.
    const placeholder = select.querySelector<HTMLOptionElement>('option[value=""]');
    expect(placeholder).toBeTruthy();
    expect(placeholder!.textContent).toContain("Select a model");

    // Models available and reachable: no placeholder, real model selected.
    hostMessage({
      type: "config",
      config: { provider: "openai-compatible", model: "qwen.gguf", hasKey: true, models: [], providerModels: [{ provider: "llamacpp", model: "qwen.gguf" }], contextWindow: 128000 },
    });
    expect(select.querySelector('option[value=""]')).toBeFalsy();
    expect(select.value).toBe("qwen.gguf");
  });

  it("collapses and expands the control stack via the toggle (collapsed by default)", async () => {
    await loadView();
    const strip = document.getElementById("ctl-toggle") as HTMLDivElement;
    // Default: the control stack starts COLLAPSED.
    expect(document.body.classList.contains("controls-collapsed")).toBe(true);
    expect(strip.getAttribute("aria-expanded")).toBe("false");

    strip.click();
    expect(document.body.classList.contains("controls-collapsed")).toBe(false);
    expect(strip.getAttribute("aria-expanded")).toBe("true");

    strip.click();
    expect(document.body.classList.contains("controls-collapsed")).toBe(true);
    expect(strip.getAttribute("aria-expanded")).toBe("false");
  });

  it("defaults the mode button to Analyze and switches modes via its vertical dropdown", async () => {
    await loadView();
    const btn = document.getElementById("mode-btn") as HTMLButtonElement;
    const label = document.getElementById("mode-btn-label") as HTMLSpanElement;
    const menu = document.getElementById("mode-menu") as HTMLDivElement;
    const analyze = document.querySelector('.mode-item[data-mode="analyze"]') as HTMLButtonElement;
    const agent = document.querySelector('.mode-item[data-mode="agent"]') as HTMLButtonElement;
    // Default: Analyze shown, dropdown closed, agent accent off.
    expect(label.textContent).toBe("Analyze");
    expect(btn.classList.contains("is-agent")).toBe(false);
    expect(menu.classList.contains("hidden")).toBe(true);
    expect(analyze.getAttribute("aria-selected")).toBe("true");
    expect(btn.getAttribute("aria-expanded")).toBe("false");

    // Open the dropdown (vertical menu) and pick Agent.
    btn.click();
    expect(menu.classList.contains("hidden")).toBe(false);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    agent.click();
    expect(posted).toContainEqual({ type: "setMode", mode: "agent" });
    expect(label.textContent).toBe("Agent");
    expect(btn.classList.contains("is-agent")).toBe(true);
    expect(analyze.getAttribute("aria-selected")).toBe("false");
    expect(agent.getAttribute("aria-selected")).toBe("true");
    // Picking closed the dropdown.
    expect(menu.classList.contains("hidden")).toBe(true);

    // Back to Analyze via the dropdown.
    btn.click();
    analyze.click();
    expect(posted).toContainEqual({ type: "setMode", mode: "analyze" });
    expect(label.textContent).toBe("Analyze");
    expect(btn.classList.contains("is-agent")).toBe(false);
  });

  it("closes the mode dropdown on outside click", async () => {
    await loadView();
    const btn = document.getElementById("mode-btn") as HTMLButtonElement;
    const menu = document.getElementById("mode-menu") as HTMLDivElement;
    btn.click();
    expect(menu.classList.contains("hidden")).toBe(false);
    document.body.click(); // click outside #mode-select
    expect(menu.classList.contains("hidden")).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("follows the host's per-session mode pushed in the config", async () => {
    await loadView();
    const label = document.getElementById("mode-btn-label") as HTMLSpanElement;
    const btn = document.getElementById("mode-btn") as HTMLButtonElement;
    const agent = document.querySelector('.mode-item[data-mode="agent"]') as HTMLButtonElement;
    // No mode in config → stays on the default.
    hostMessage({ type: "config", config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } });
    expect(label.textContent).toBe("Analyze");

    // Host says this session is in Agent mode → the button follows.
    hostMessage({ type: "config", config: { provider: "openai", model: "gpt-4o", hasKey: true, mode: "agent", models: [], providerModels: [], contextWindow: 128000 } });
    expect(label.textContent).toBe("Agent");
    expect(btn.classList.contains("is-agent")).toBe(true);
    expect(agent.classList.contains("is-active")).toBe(true);
  });

  it("locks the mode button while working and ignores clicks", async () => {
    await loadView();
    const btn = document.getElementById("mode-btn") as HTMLButtonElement;
    const menu = document.getElementById("mode-menu") as HTMLDivElement;
    const postedAtLock = posted.length;

    hostMessage({ type: "status", active: true });
    expect(btn.disabled).toBe(true);
    btn.click();
    expect(menu.classList.contains("hidden")).toBe(true); // stays closed while locked
    expect(posted.slice(postedAtLock)).not.toContainEqual({ type: "setMode", mode: "agent" });

    hostMessage({ type: "status", active: false });
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(menu.classList.contains("hidden")).toBe(false);
  });

  it("multi toggle: off by default, turns blue (pressed) on click and posts setMulti", async () => {
    await loadView();
    const btn = document.getElementById("multi-btn") as HTMLButtonElement;
    expect(btn.classList.contains("is-on")).toBe(false);
    expect(btn.getAttribute("aria-pressed")).toBe("false");

    btn.click();
    expect(posted).toContainEqual({ type: "setMulti", multi: true });
    expect(btn.classList.contains("is-on")).toBe(true);
    expect(btn.getAttribute("aria-pressed")).toBe("true");

    btn.click();
    expect(posted).toContainEqual({ type: "setMulti", multi: false });
    expect(btn.classList.contains("is-on")).toBe(false);
    expect(btn.getAttribute("aria-pressed")).toBe("false");
  });

  it("multi toggle follows the host config and locks while working", async () => {
    await loadView();
    const btn = document.getElementById("multi-btn") as HTMLButtonElement;
    hostMessage({ type: "config", config: { provider: "openai", model: "gpt-4o", hasKey: true, multi: true, models: [], providerModels: [], contextWindow: 128000 } });
    expect(btn.classList.contains("is-on")).toBe(true);

    hostMessage({ type: "status", active: true });
    btn.click();
    expect(posted).not.toContainEqual({ type: "setMulti", multi: false });
    hostMessage({ type: "status", active: false });
    btn.click();
    expect(posted).toContainEqual({ type: "setMulti", multi: false });
  });

  it("renders the thinking level dropdown per provider capability", async () => {
    await loadView();
    const sel = document.getElementById("thinking-select") as HTMLSelectElement;
    // No thinkingMode declared → disabled, value falls back to Off.
    expect(sel.disabled).toBe(true);
    expect(sel.value).toBe("off");

    hostMessage({
      type: "config",
      config: { provider: "openai-compatible", model: "qwen.gguf", hasKey: true, thinkingMode: "bool", thinkingLevel: "high", models: [], providerModels: [], contextWindow: 128000 },
    });
    expect(sel.disabled).toBe(false);
    expect(sel.value).toBe("high");

    sel.value = "low";
    sel.dispatchEvent(new Event("change"));
    expect(posted).toContainEqual({ type: "setThinkingLevel", level: "low" });

    // effort-style providers also enable the dropdown
    hostMessage({
      type: "config",
      config: { provider: "openai", model: "gpt-5", hasKey: true, thinkingMode: "effort", thinkingLevel: "medium", models: [], providerModels: [], contextWindow: 128000 },
    });
    expect(sel.disabled).toBe(false);
    expect(sel.value).toBe("medium");

    // DeepSeek/Anthropic toggle (OpenCode Go) also enables the dropdown
    hostMessage({
      type: "config",
      config: { provider: "openai-compatible", model: "deepseek-v4.1-flash", hasKey: true, thinkingMode: "type", thinkingLevel: "high", models: [], providerModels: [], contextWindow: 128000 },
    });
    expect(sel.disabled).toBe(false);
    expect(sel.value).toBe("high");
  });

  it("renders sessions, tabs and the active chat", async () => {
    await loadView();
    expect(document.querySelectorAll(".srow").length).toBe(2);
    expect(document.querySelectorAll(".tab").length).toBe(2);
    expect(document.querySelector(".msg.user")?.textContent).toBe("hello");
  });

  it("shows creation and last-modified dates BEFORE the session name", async () => {
    await loadView();
    const row = document.querySelector(".srow") as HTMLElement;
    const meta = row.querySelector(".smeta") as HTMLElement;
    const name = row.querySelector(".name") as HTMLElement;
    expect(meta).toBeTruthy();
    // The dates are the FIRST element of the row: before the name.
    expect(row.firstElementChild).toBe(meta);
    expect(name).toBeTruthy();
    expect(meta.textContent).toContain("created");
    expect(meta.textContent).toContain("updated");
    expect(meta.title).toContain("Created:");
  });

  it("refreshes the meta dates on rename when timestamps are provided", async () => {
    await loadView();
    const row = document.querySelector(".srow") as HTMLElement;
    const id = row.dataset.id ?? "";
    const before = (row.querySelector(".smeta") as HTMLElement).textContent;
    hostMessage({ type: "renameSession", id, name: "New", createdAt: 1, updatedAt: 300000 });
    const after = (row.querySelector(".smeta") as HTMLElement).textContent;
    expect(before).not.toBe(after);
    expect(after).toContain("· updated ");
  });

  it("renames a session row and tab in place without rebuild", async () => {
    await loadView();
    const row = document.querySelector(".srow") as HTMLElement;
    const id = row.dataset.id ?? "";
    expect(id).not.toBe("");
    hostMessage({ type: "renameSession", id, name: "New Name" });
    expect(document.querySelector(`.srow[data-id="${id}"] .name`)?.textContent).toBe("New Name");
    expect(document.querySelector(`.tab[data-id="${id}"] span:first-child`)?.textContent).toBe("New Name");
    // no DOM rebuild → streaming state untouched implicitly (elements kept)
  });

  it("disables the thinking selector while working (and on config pushes) but keeps sessions/tabs usable", async () => {
    await loadView();
    const sel = document.getElementById("thinking-select") as HTMLSelectElement;
    hostMessage({ type: "config", config: { provider: "openai-compatible", model: "x", hasKey: true, thinkingMode: "bool", thinkingLevel: "high", models: [], providerModels: [], contextWindow: 128000 } });
    expect(sel.disabled).toBe(false);

    hostMessage({ type: "status", active: true });
    expect(sel.disabled).toBe(true);
    // sessions list / tabs / new-session stay usable during work
    expect((document.getElementById("new-session") as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelectorAll(".tab").length).toBeGreaterThan(0);
    // a config push mid-stream must NOT re-enable it
    hostMessage({ type: "config", config: { provider: "openai-compatible", model: "x", hasKey: true, thinkingMode: "bool", thinkingLevel: "medium", models: [], providerModels: [], contextWindow: 128000 } });
    expect(sel.disabled).toBe(true);

    hostMessage({ type: "status", active: false });
    expect(sel.disabled).toBe(false);
  });

  it("locks all interaction controls while the LLM works and unlocks after", async () => {
    await loadView();
    hostMessage({ type: "status", active: true });
    expect((document.getElementById("send-btn") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("abort-btn") as HTMLButtonElement).disabled).toBe(false); // only abort stays
    expect((document.getElementById("compact-btn") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("compact-settings-btn") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("model-select") as HTMLSelectElement).disabled).toBe(true);
    expect((document.getElementById("ctx-input") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("ctx-minus") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("ctx-plus") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("out-input") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("out-minus") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("out-plus") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("samp-input") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("samp-minus") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("samp-plus") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("samp-auto") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("sampler-temp") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("sampler-topp") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("presence-input") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("presence-auto") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("freq-input") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("freq-auto") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("user-input") as HTMLTextAreaElement).disabled).toBe(true);
    hostMessage({ type: "status", active: false });
    expect((document.getElementById("compact-btn") as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById("compact-settings-btn") as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById("model-select") as HTMLSelectElement).disabled).toBe(false);
    expect((document.getElementById("ctx-input") as HTMLInputElement).disabled).toBe(false);
    expect((document.getElementById("out-input") as HTMLInputElement).disabled).toBe(false);
    expect((document.getElementById("samp-input") as HTMLInputElement).disabled).toBe(false);
    expect((document.getElementById("samp-plus") as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById("samp-auto") as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById("sampler-topp") as HTMLInputElement).disabled).toBe(false);
    expect((document.getElementById("user-input") as HTMLTextAreaElement).disabled).toBe(false);
  });

  it("attaches files via the + button and sends them with the message", async () => {
    await loadView();
    posted.length = 0;
    (document.getElementById("attach-btn") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "pickFiles" });

    // Host returns the picked files -> chips appear below the textarea.
    hostMessage({
      type: "attachments",
      files: [
        { name: "notes.txt", path: "/tmp/notes.txt", size: 2048, isImage: false },
        { name: "shot.png", path: "/tmp/shot.png", size: 1048576, isImage: true },
      ],
    });
    const chips = document.getElementById("attachment-chips") as HTMLDivElement;
    expect(chips.classList.contains("hidden")).toBe(false);
    expect(chips.querySelectorAll(".attach-chip").length).toBe(2);
    expect(chips.querySelector(".attach-name")?.textContent).toBe("notes.txt");

    // Removing a chip drops just that file.
    (chips.querySelectorAll(".attach-remove")[1] as HTMLButtonElement).click();
    expect(chips.querySelectorAll(".attach-chip").length).toBe(1);

    // Sending posts the remaining attachment and clears the chips.
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "look";
    posted.length = 0;
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    const sendMsg = posted.find((m) => (m as { type?: string }).type === "send") as Record<string, unknown>;
    expect(sendMsg.text).toBe("look");
    expect((sendMsg.attachments as unknown[]).length).toBe(1);
    expect(chips.classList.contains("hidden")).toBe(true);
  });

  it("accumulates attachments across picks (dedup by path)", async () => {
    await loadView();
    hostMessage({ type: "attachments", files: [{ name: "a.txt", path: "/a", size: 1, isImage: false }] });
    hostMessage({
      type: "attachments",
      files: [
        { name: "a.txt", path: "/a", size: 1, isImage: false }, // duplicate path
        { name: "b.txt", path: "/b", size: 2, isImage: false },
      ],
    });
    const chips = document.getElementById("attachment-chips") as HTMLDivElement;
    expect(chips.querySelectorAll(".attach-chip").length).toBe(2);
    // A cancelled pick (empty list) must NOT clear the current selection.
    hostMessage({ type: "attachments", files: [] });
    expect(chips.querySelectorAll(".attach-chip").length).toBe(2);
  });

  it("disables the attach button while working", async () => {
    await loadView();
    const btn = document.getElementById("attach-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    hostMessage({ type: "status", active: true });
    expect(btn.disabled).toBe(true);
    hostMessage({ type: "done" });
    expect(btn.disabled).toBe(false);
  });

  it("drops pending attachments when switching to another session", async () => {
    await loadView(); // activeId "a"
    hostMessage({ type: "attachments", files: [{ name: "a.txt", path: "/a", size: 1, isImage: false }] });
    const chips = document.getElementById("attachment-chips") as HTMLDivElement;
    expect(chips.classList.contains("hidden")).toBe(false);

    hostMessage({ type: "switchView", activeId: "b", sessions: [], openIds: ["a", "b"], messages: [], config: {}, workingIds: [] });
    expect(chips.classList.contains("hidden")).toBe(true);
  });

  it("sends an attachment-only message (no text typed)", async () => {
    await loadView();
    hostMessage({
      type: "attachments",
      files: [{ name: "only.txt", path: "/tmp/only.txt", size: 10, isImage: false }],
    });
    (document.getElementById("user-input") as HTMLTextAreaElement).value = "";
    posted.length = 0;
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    const sendMsg = posted.find((m) => (m as { type?: string }).type === "send") as Record<string, unknown>;
    expect(sendMsg.text).toBe("");
    expect((sendMsg.attachments as unknown[]).length).toBe(1);
  });

  it("renders attached files as chips in the user bubble, not the inlined content", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [
        {
          role: "user",
          content: 'Attached file "a.txt":\n```\nSECRET\n```\n\nlook',
          displayText: "look",
          attachments: [{ name: "a.txt", size: 2048 }],
        },
      ],
    });
    const bubble = document.querySelector(".msg.user") as HTMLElement;
    expect(bubble.textContent).toContain("look");
    expect(bubble.textContent).not.toContain("SECRET");
    expect(bubble.querySelector(".msg-attach")?.textContent).toContain("a.txt");
  });

  it("attachment-only bubble shows just the file chip, never the content", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [
        { role: "user", content: 'Attached file "a.txt":\n```\nSECRET\n```', displayText: "", attachments: [{ name: "a.txt", size: 2 }] },
      ],
    });
    const bubble = document.querySelector(".msg.user") as HTMLElement;
    expect(bubble.textContent).not.toContain("SECRET");
    expect(bubble.querySelector(".msg-attach")?.textContent).toBe("📎 a.txt");
  });

  it("blinks the PLAY button while working and stops after", async () => {
    await loadView();
    const btn = document.getElementById("send-btn") as HTMLButtonElement;
    expect(btn.classList.contains("blinking")).toBe(false);

    // Working -> the play button pulses (same animation as the chat bubble),
    // and stays locked/blinking for the whole run.
    hostMessage({ type: "status", active: true });
    expect(btn.classList.contains("blinking")).toBe(true);
    // Error / interrupt / clean finish all leave the working state.
    hostMessage({ type: "error", error: "boom" });
    expect(btn.classList.contains("blinking")).toBe(false);

    hostMessage({ type: "status", active: true });
    expect(btn.classList.contains("blinking")).toBe(true);
    hostMessage({ type: "interrupted" });
    expect(btn.classList.contains("blinking")).toBe(false);

    hostMessage({ type: "status", active: true });
    expect(btn.classList.contains("blinking")).toBe(true);
    hostMessage({ type: "done" });
    expect(btn.classList.contains("blinking")).toBe(false);
  });

  it("clamps the cache % to 100 when cached exceeds the context estimate", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [],
        contextWindow: 128000,
        contextTokens: 1815,
        cachedTokens: 8253,
      },
    });
    const el = document.getElementById("met-cache") as HTMLSpanElement;
    expect(el.textContent).toContain("(100%)");
  });

  it("shows an animated compaction bubble and finalizes it into a thinking-style block", async () => {
    await loadView();
    hostMessage({ type: "compactStart" });
    const working = [...document.querySelectorAll(".working")];
    expect(working.length).toBe(1);
    expect(working[0].textContent).toContain("Compacting");
    hostMessage({ type: "compactDone" });
    expect(document.querySelectorAll(".working").length).toBe(0);
    const block = document.querySelector(".thinking-block");
    expect(block).not.toBeNull();
    expect(block!.textContent).toContain("Conversation compacted");
    // quiet styling: NOT an assistant result bubble (blue/result reserved to output)
    const assistantText = document.querySelector(".msg.assistant")?.textContent ?? "";
    expect(assistantText).not.toContain("Conversation compacted");
  });

  it("shows a red interrupted bubble on abort", async () => {
    await loadView();
    hostMessage({ type: "interrupted" });
    const bubbles = [...document.querySelectorAll(".msg.assistant.error")];
    expect(bubbles.length).toBe(1);
    expect(bubbles[0].textContent).toContain("Processing interrupted");
    // no stray "(empty response)" appended later by done
    hostMessage({ type: "done" });
    expect(document.querySelectorAll(".msg.assistant.error").length).toBe(1);
    expect([...document.querySelectorAll(".msg")].some((m) => m.textContent?.includes("(empty response)"))).toBe(false);
  });

  it("renders thinking blocks collapsed on initial load", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [
        { role: "user", content: "x", timestamp: 1 },
        { role: "assistant", content: "", thinking: "let me think", toolCalls: [], timestamp: 2 },
        { role: "assistant", content: "fine", timestamp: 3 },
      ],
    });
    const blocks = document.querySelectorAll(".thinking-block");
    expect(blocks.length).toBe(1);
    // Thinking starts COLLAPSED (▶) and expands on click.
    expect(blocks[0].querySelector(".thinking-body")?.classList.contains("collapsed")).toBe(true);
    expect(blocks[0].querySelector(".toggle")?.textContent).toBe("▶");
    // Historical blocks re-rendered from the transcript are NOT live: no
    // streaming pulse, so they never keep animating.
    expect(blocks[0].classList.contains("streaming")).toBe(false);
    (blocks[0].querySelector(".thinking-header") as HTMLElement).click();
    expect(blocks[0].querySelector(".thinking-body")?.classList.contains("collapsed")).toBe(false);
    expect(blocks[0].querySelector(".toggle")?.textContent).toBe("▼");
    // The final textual response is the last message.
    const last = (messagesElLastContent() || "").trim();
    expect(last).toBe("fine");
  });

  it("pulses the live streaming bubble with the streaming class and stops it on done", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click(); // sets the working bar

    hostMessage({ type: "textDelta", content: "hel" });
    let bubble = document.querySelector(".msg.assistant.streaming");
    expect(bubble).toBeTruthy();
    hostMessage({ type: "textDelta", content: "lo" });
    // still the same pulsing bubble (throttled render may lag a beat).
    expect(document.querySelector(".msg.assistant.streaming")).toBe(bubble);

    // done: the bubble stops pulsing (class removed) and settles out
    // gracefully; it stays in the chat with the FULL flushed text.
    hostMessage({ type: "done" });
    expect(document.querySelector(".msg.assistant.streaming")).toBe(null);
    const final = document.querySelector(".msg.assistant");
    expect(final?.textContent).toContain("hello");
    // the pulse fades out rather than snapping: settling class is applied.
    expect(final?.classList.contains("settling")).toBe(true);
  });

  it("stops the streaming pulse when a new thinking phase starts", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();

    hostMessage({ type: "textDelta", content: "partial" });
    expect(document.querySelector(".msg.assistant.streaming")).toBeTruthy();
    hostMessage({ type: "thinkingDelta", content: "reasoning..." });
    expect(document.querySelector(".msg.assistant.streaming")).toBe(null);
  });

  it("pulses the live thinking block while streaming and stops the pulse on done", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();

    hostMessage({ type: "thinkingDelta", content: "think..." });
    const block = document.querySelector(".thinking-block") as HTMLElement;
    expect(block).toBeTruthy();
    expect(block.classList.contains("streaming")).toBe(true);

    hostMessage({ type: "done" });
    expect(block.classList.contains("streaming")).toBe(false);
    // the thinking block settles out (pulse fades) instead of snapping off.
    expect(block.classList.contains("settling")).toBe(true);
  });

  it("stops the thinking pulse as soon as the answer starts streaming (not only on done)", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();

    hostMessage({ type: "thinkingDelta", content: "reasoning" });
    const block = document.querySelector(".thinking-block") as HTMLElement;
    expect(block.classList.contains("streaming")).toBe(true);

    // Answer starts streaming: the thinking block must stop animating NOW.
    hostMessage({ type: "textDelta", content: "answer" });
    expect(block.classList.contains("streaming")).toBe(false);
    expect(block.classList.contains("settling")).toBe(true);
    // …while the answer bubble takes over the pulse.
    expect(document.querySelector(".msg.assistant.streaming")).toBeTruthy();
  });

  it("renders thinking as markdown (bold, code, lists)", async () => {
    await loadView();
    hostMessage({ type: "thinkingDelta", content: "Step one\n\n- item one\n- item two\n\n**important** `code`" });
    const body = document.querySelector(".thinking-body") as HTMLElement;
    expect(body.querySelector("strong")?.textContent).toBe("important");
    expect(body.querySelector("code")?.textContent).toBe("code");
    expect(body.querySelector("li")?.textContent).toBe("item one");
  });

  it("throttles thinking renders (leading edge) and flushes the LATEST text on the trailing timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    try {
      await loadView();
      hostMessage({ type: "thinkingDelta", content: "**bold**" });
      const body = document.querySelector(".thinking-body") as HTMLElement;
      // Leading edge: the first delta renders immediately.
      expect(body.querySelector("strong")?.textContent).toBe("bold");

      // Rapid deltas within the window: the trailing timer must render the
      // LATEST accumulated text (getText closure), not a stale snapshot.
      hostMessage({ type: "thinkingDelta", content: " part" });
      hostMessage({ type: "thinkingDelta", content: " **two**" });
      expect(body.textContent).toContain("bold"); // still the leading snapshot
      vi.advanceTimersByTime(200);
      expect(body.querySelectorAll("strong").length).toBe(2);
      expect(body.querySelector("strong:last-child")?.textContent).toBe("two");
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the in-panel name modal, submits and closes", async () => {
    await loadView();
    const modal = document.getElementById("name-modal") as HTMLElement;
    const input = document.getElementById("name-input") as HTMLInputElement;
    expect(modal.classList.contains("hidden")).toBe(true);

    hostMessage({ type: "modal", modalId: 1, kind: "name", mode: "create", current: undefined });
    expect(modal.classList.contains("hidden")).toBe(false);
    expect(input.value).toBe("New Session");
    input.value = "Cool Project";
    (document.getElementById("name-ok") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "modalResponse", id: 1, value: "Cool Project" });
    expect(modal.classList.contains("hidden")).toBe(true);
  });

  it("rename modal is prefilled and cancel responds undefined", async () => {
    await loadView();
    const modal = document.getElementById("name-modal") as HTMLElement;
    const input = document.getElementById("name-input") as HTMLInputElement;
    hostMessage({ type: "modal", modalId: 2, kind: "name", mode: "rename", id: "a", current: "Old Name" });
    expect(input.value).toBe("Old Name");
    (document.getElementById("name-cancel") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "modalResponse", id: 2, value: undefined });
    expect(modal.classList.contains("hidden")).toBe(true);
  });

  it("Enter submits the modal name, Escape cancels it", async () => {
    await loadView();
    const input = document.getElementById("name-input") as HTMLInputElement;
    const modal = document.getElementById("name-modal") as HTMLElement;
    hostMessage({ type: "modal", modalId: 3, kind: "name", mode: "rename", id: "a", current: "X" });
    input.value = "Entered Name";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(posted).toContainEqual({ type: "modalResponse", id: 3, value: "Entered Name" });
    expect(modal.classList.contains("hidden")).toBe(true);

    hostMessage({ type: "modal", modalId: 4, kind: "name", mode: "create", current: undefined });
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(posted).toContainEqual({ type: "modalResponse", id: 4, value: undefined });
    expect(modal.classList.contains("hidden")).toBe(true);
  });

  it("shows the working bar as a glued footer (outside the transcript) and hides it on done", async () => {
    await loadView();
    const bar = document.getElementById("working-bar") as HTMLElement;
    const msgs = document.getElementById("messages") as HTMLElement;
    expect(bar.classList.contains("hidden")).toBe(true);

    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click(); // shows the footer bar
    expect(bar.classList.contains("hidden")).toBe(false);

    hostMessage({ type: "thinkingDelta", content: "thinking" });
    hostMessage({ type: "textDelta", content: "answer" });
    hostMessage({ type: "toolCall", id: "c1", name: "Read", arguments: {} });
    hostMessage({ type: "thinkingDelta", content: "more thinking" });
    // The bar is NOT part of the transcript flow…
    expect(msgs.querySelector(".working")).toBeNull();
    // …and sections stay in arrival order (the last thinking block arrived
    // after the tool section, since toolCall resets the thinking state).
    expect(msgs.lastElementChild?.classList.contains("thinking-block")).toBe(true);

    hostMessage({ type: "done" });
    expect(bar.classList.contains("hidden")).toBe(true);
  });

  it("re-pins to the bottom even when the trailing throttled render fires later", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    try {
      await loadView();
      const msgs = document.getElementById("messages") as HTMLElement;
      Object.defineProperty(msgs, "scrollHeight", { configurable: true, value: 500 });
      Object.defineProperty(msgs, "scrollTop", { configurable: true, value: 0, writable: true });
      hostMessage({ type: "thinkingDelta", content: "**one**" }); // leading render → pinned bottom
      expect(msgs.scrollTop).toBe(500);

      // The viewport drifts up during the trailing window (rendered content
      // grows below the anchor) — the trailing render must re-pin it.
      Object.defineProperty(msgs, "scrollTop", { configurable: true, value: 100, writable: true });
      hostMessage({ type: "thinkingDelta", content: " **two**" }); // queued trailing render
      vi.advanceTimersByTime(200);
      expect(msgs.scrollTop).toBe(500);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies a switchView in place: restores the working state and locks delete for working sessions", async () => {
    await loadView();
    const sel = document.getElementById("thinking-select") as HTMLSelectElement;
    hostMessage({
      type: "switchView",
      sessions: [
        { id: "a", name: "Refactor", createdAt: 1, updatedAt: 2, messageCount: 3 },
        { id: "w", name: "Working", createdAt: 1, updatedAt: 2, messageCount: 1 },
      ],
      openIds: ["a", "w"],
      activeId: "w",
      messages: [{ role: "user", content: "go", timestamp: 1 }],
      config: { provider: "openai", model: "gpt-4o", hasKey: true, thinkingMode: "bool", thinkingLevel: "high", models: [], providerModels: [], contextWindow: 128000 },
      workingIds: ["w"],
      streaming: true,
    });
    // Live working bar restored (footer, outside the transcript flow).
    expect((document.getElementById("working-bar") as HTMLElement).classList.contains("hidden")).toBe(false);
    expect(sel.disabled).toBe(true);
    // The working session keeps its rename/delete buttons disabled; the idle one not.
    expect((document.querySelector('.srow[data-id="w"] .del') as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector('.srow[data-id="w"] .rename') as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector('.srow[data-id="a"] .del') as HTMLButtonElement).disabled).toBe(false);
    expect((document.querySelector('.srow[data-id="a"] .rename') as HTMLButtonElement).disabled).toBe(false);
    // A status update that clears workingIds re-enables the buttons.
    hostMessage({ type: "status", active: false, workingIds: [] });
    expect((document.querySelector('.srow[data-id="w"] .del') as HTMLButtonElement).disabled).toBe(false);
    expect((document.querySelector('.srow[data-id="w"] .rename') as HTMLButtonElement).disabled).toBe(false);
  });

  it("clears stale live tool sections when switching sessions (re-renders committed history only)", async () => {
    await loadView();
    // a LIVE (uncommitted) tool section exists on the current view
    hostMessage({ type: "toolCall", id: "c1", name: "Read", arguments: {} });
    expect(document.querySelectorAll(".msg.tool").length).toBe(1);

    hostMessage({
      type: "switchView",
      sessions: [{ id: "b", name: "B", createdAt: 1, updatedAt: 2, messageCount: 0 }],
      openIds: ["b"],
      activeId: "b",
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
      config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 },
      workingIds: [],
      streaming: false,
    });
    // the stale live tool section is gone; only committed history is shown
    expect(document.querySelectorAll(".msg.tool").length).toBe(0);
    expect(document.querySelector(".msg.user")?.textContent).toBe("hi");
  });

  it("switchView replays the live thinking/answer of a still-working session", async () => {
    await loadView();
    hostMessage({
      type: "switchView",
      sessions: [{ id: "a", name: "A", createdAt: 1, updatedAt: 2, messageCount: 1 }],
      openIds: ["a"],
      activeId: "a",
      messages: [{ role: "user", content: "go", timestamp: 1 }],
      config: { provider: "openai", model: "gpt-4o", hasKey: true, thinkingMode: "bool", thinkingLevel: "high", models: [], providerModels: [], contextWindow: 128000 },
      workingIds: ["a"],
      streaming: true,
      liveThinking: "**thinking** about this",
      liveAnswer: "partial answer",
    });
    // The pre-existing thinking is replayed (markdown included) + working bubble.
    const body = document.querySelector(".thinking-body") as HTMLElement;
    expect(body.querySelector("strong")?.textContent).toBe("thinking");
    expect((document.getElementById("working-bar") as HTMLElement).classList.contains("hidden")).toBe(false);
    // Subsequent deltas continue the restored buffers (thinking and answer).
    hostMessage({ type: "thinkingDelta", content: " more" });
    expect(body.textContent).toContain("thinking");
    hostMessage({ type: "textDelta", content: " more" });
    const bubbles = [...document.querySelectorAll(".msg.assistant")];
    expect(bubbles[bubbles.length - 1].textContent).toContain("partial answer more");
  });

  it("renders the Diff section after a refresh re-render of tool results", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [
        { role: "user", content: "edit this", timestamp: 1 },
        {
          role: "assistant",
          content: "🔧 Tools: Edit",
          timestamp: 2,
          toolCalls: [{ id: "e1", name: "Edit", arguments: { path: "a.js" } }],
        },
        { role: "tool", toolCallId: "e1", content: "Diff (+1/-1):\n```diff\n@@ -1,2 +1,2 @@\n-old\n+new\n```", timestamp: 3 },
        { role: "assistant", content: "done", timestamp: 4 },
      ],
    });
    // the diff becomes a third section INSIDE the tool bubble (Input/Output/Diff)
    const diff = document.querySelector(".msg.tool .tool-diff");
    expect(diff).not.toBeNull();
    expect(diff?.querySelector(".fd-add")?.textContent).toBe("+new");
    expect(diff?.querySelector(".fd-del")?.textContent).toBe("-old");
  });

  it("returns focus to the prompt when the agent finishes (done)", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).not.toBe(input);

    hostMessage({ type: "done" });

    expect(document.activeElement).toBe(input);
  });

  it("also returns focus after an in-run error", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    (document.activeElement as HTMLElement | null)?.blur();

    hostMessage({ type: "error", error: "boom" });

    expect(document.activeElement).toBe(input);
  });

  it("creates a NEW blue bubble per emission segment, in chronological order (never moves)", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    const order = () => [...document.querySelectorAll("#messages > *")].map((el) => el.className);

    hostMessage({ type: "thinkingDelta", content: "think" });
    hostMessage({ type: "textDelta", content: "answer one" }); // segment after thinking
    hostMessage({ type: "textDelta", content: " more" }); // contiguous → SAME bubble
    hostMessage({ type: "toolCall", id: "c1", name: "Edit", arguments: {} }); // closes the segment
    hostMessage({ type: "textDelta", content: "answer two" }); // NEW bubble after tools

    // let the throttled (trailing) render of the second segment fire
    await new Promise((r) => setTimeout(r, 160));

    const assistants = [...document.querySelectorAll("#messages .msg.assistant")];
    expect(assistants.length).toBe(2);
    expect(assistants[0].textContent).toContain("answer one more");
    expect(assistants[1].textContent).toContain("answer two");

    // Pure chronology: thought, answer1, tool, answer2 — nothing moved.
    const cls = order();
    expect(cls[cls.length - 1].includes("msg assistant")).toBe(true);
    const toolIdx = cls.findIndex((c) => c.includes("msg tool"));
    expect(toolIdx).toBeGreaterThan(cls.findIndex((c) => c.includes("thinking")));
    expect(toolIdx).toBeGreaterThan(cls.findIndex((c) => c.includes("msg assistant")));
  });

  it("pins the transcript to the bottom with auto-scroll when switching sessions", async () => {
    await loadView();
    const msgs = document.getElementById("messages") as HTMLElement;
    Object.defineProperty(msgs, "scrollHeight", { configurable: true, value: 500 });
    Object.defineProperty(msgs, "scrollTop", { configurable: true, value: 10, writable: true });
    msgs.dispatchEvent(new Event("scroll")); // user scrolled up → auto-scroll off
    const initTop = msgs.scrollTop;
    expect(initTop).toBeLessThan(500); // simulated scroll-up state

    hostMessage({
      type: "switchView",
      sessions: [{ id: "a", name: "A", createdAt: 1, updatedAt: 2, messageCount: 1 }],
      openIds: ["a"],
      activeId: "a",
      messages: [{ role: "user", content: "go", timestamp: 1 }],
      config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 },
      streaming: false,
    });
    // The selected session starts pinned at the bottom.
    expect(msgs.scrollTop).toBe(500);
    // A subsequent delta stays at the bottom (auto-scroll was re-enabled).
    hostMessage({ type: "thinkingDelta", content: "thinking" });
    expect(msgs.scrollTop).toBe(500);
  });

  it("disables auto-scroll when scrolled up and re-enables at the bottom", async () => {
    await loadView();
    const msgs = document.getElementById("messages") as HTMLElement;
    // mock a scrollable container: emulate big content so positions are meaningful
    Object.defineProperty(msgs, "scrollHeight", { configurable: true, value: 500 });
    Object.defineProperty(msgs, "clientHeight", { configurable: true, value: 100 });
    // user scrolls UP → autoScroll off
    Object.defineProperty(msgs, "scrollTop", { configurable: true, value: 10, writable: true });
    msgs.dispatchEvent(new Event("scroll"));
    hostMessage({ type: "thinkingDelta", content: "first line" }); // would force scroll at bottom
    expect(msgs.scrollTop).toBe(10); // NOT forced to the bottom
    // back to the bottom → autoScroll on again
    Object.defineProperty(msgs, "scrollTop", { configurable: true, value: 400, writable: true });
    msgs.dispatchEvent(new Event("scroll"));
    hostMessage({ type: "thinkingDelta", content: "new line" });
    expect(msgs.scrollTop).toBe(msgs.scrollHeight); // forced to bottom
  });

  it("renders the diff as a third section (Diff) inside the tool bubble", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    hostMessage({ type: "toolCall", id: "d1", name: "Edit", arguments: { path: "/workspace/src/a.js" } });
    hostMessage({
      type: "toolResult",
      toolCallId: "d1",
      output: "Applied edit a.js.\n\nDiff (+1/-1):\n```diff\n@@ -1,2 +1,2 @@\n-old\n+new\n```",
      isError: false,
    });
    // The OUTPUT pre keeps the plain feedback text, with the diff fence removed.
    const result = document.querySelector(".msg.tool .tool-result") as HTMLElement;
    expect(result?.textContent).toContain("Applied edit a.js.");
    expect(result?.textContent).not.toContain("```diff");
    // The Diff section sits INSIDE the tool bubble, in the collapsed details.
    const details = document.querySelector(".msg.tool .tool-details");
    const diff = details?.querySelector(".tool-diff");
    expect(diff).not.toBeNull();
    expect(diff?.querySelector(".fd-stat")?.textContent).toBe("+1/-1");
    expect(diff?.querySelector(".fd-add")?.textContent).toBe("+new");
    expect(diff?.querySelector(".fd-del")?.textContent).toBe("-old");
    expect(diff?.querySelector(".fd-hunk")?.textContent).toContain("@@");
    // Ordering inside the bubble: Input → Output → Diff.
    const sections = [...(details?.querySelectorAll(".tool-label") ?? [])].map((l) => l.textContent);
    expect(sections).toEqual(["Input", "Output", "Diff"]);
    // the tool header shows the target file path after the tool name
    const toolEl = document.querySelector(".msg.tool");
    expect(toolEl?.querySelector(".tool-path")?.textContent).toBe("/workspace/src/a.js");
    // NO separate diff bubble anymore
    expect(document.querySelector(".msg.file-diff")).toBeNull();
  });

  it("does NOT colorize a plain output that merely starts with '-' and adds no bubble", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    hostMessage({ type: "toolCall", id: "l1", name: "Shell", arguments: { command: "ls -la" } });
    hostMessage({
      type: "toolResult",
      toolCallId: "l1",
      output: "-rw-r--r-- 1 user staff 123 file.txt\n-rw-r--r-- 1 user staff 456 other.ts",
      isError: false,
    });
    const result = document.querySelector(".msg.tool .tool-result") as HTMLElement;
    expect(result?.textContent).toContain("-rw-r--r--");
    expect(document.querySelector(".tool-diff")).toBeNull();
    // a Shell call shows its command in the header chip
    expect(document.querySelector(".msg.tool .tool-path")?.textContent).toBe("ls -la");
  });

  it("shows the glob pattern after the tool name for Glob", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    hostMessage({ type: "toolCall", id: "g1", name: "Glob", arguments: { glob_pattern: "**/*.ts" } });
    hostMessage({
      type: "toolResult",
      toolCallId: "g1",
      output: "/w/a.ts\n/w/b.ts",
      isError: false,
    });
    expect(document.querySelector(".msg.tool .tool-path")?.textContent).toBe("**/*.ts");
  });

  it("shows chips for TodoWrite / WebSearch / WebFetch / ReadLints", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    hostMessage({ type: "toolCall", id: "tdo", name: "TodoWrite", arguments: { todos: [{ id: "1", content: "fix parser", status: "pending" }], merge: false } });
    hostMessage({ type: "toolResult", toolCallId: "tdo", output: "## Task List", isError: false });
    hostMessage({ type: "toolCall", id: "ws", name: "WebSearch", arguments: { search_term: "harny vs code" } });
    hostMessage({ type: "toolResult", toolCallId: "ws", output: "results", isError: false });
    hostMessage({ type: "toolCall", id: "wf", name: "WebFetch", arguments: { url: "https://example.com" } });
    hostMessage({ type: "toolResult", toolCallId: "wf", output: "<html>", isError: false });
    hostMessage({ type: "toolCall", id: "rl", name: "ReadLints", arguments: { paths: ["a.ts", "b.ts"] } });
    hostMessage({ type: "toolResult", toolCallId: "rl", output: "No linter errors found.", isError: false });

    const chips = [...document.querySelectorAll(".msg.tool .tool-path")].map((c) => c.textContent);
    expect(chips).toEqual(["1 - fix parser - pending", "harny vs code", "https://example.com", "a.ts, b.ts"]);
  });

  it("renders a Write preview as an all-additions diff bubble", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    hostMessage({ type: "toolCall", id: "w1", name: "Write", arguments: { path: "/w/style.css" } });
    hostMessage({
      type: "toolResult",
      toolCallId: "w1",
      output:
        "Successfully wrote 12 bytes to /w/style.css\n\nDiff (+3/-0):\n```diff\n@@ -0,0 +1,3 @@\n+.a {}\n+.b {}\n+.c {}\n```",
      isError: false,
    });
    const diff = document.querySelector(".msg.tool .tool-diff");
    expect(diff).not.toBeNull();
    expect(diff?.querySelectorAll(".fd-add").length).toBe(3);
    expect(diff?.querySelectorAll(".fd-del").length).toBe(0);
    // the target path appears in the tool header path chip (not in a bubble header)
    expect(document.querySelector(".msg.tool .tool-path")?.textContent).toBe("/w/style.css");
  });

  it("applies syntax highlighting to code lines for a known language (.ts)", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    hostMessage({ type: "toolCall", id: "h1", name: "Edit", arguments: { path: "/w/component.ts" } });
    hostMessage({
      type: "toolResult",
      toolCallId: "h1",
      output: "Diff (+1/-1):\n```diff\n@@ -1,1 +1,1 @@\n-const old: number = 1;\n+const fresh: number = 2;\n```",
      isError: false,
    });
    const add = document.querySelector(".msg.tool .tool-diff .fd-add");
    expect(add).not.toBeNull();
    // the diff prefix stays plain text, the code is tokenized by Prism
    expect(add?.textContent).toContain("+const");
    expect(add?.querySelector(".token.keyword")?.textContent).toBe("const");
    expect(add?.querySelectorAll(".token").length ?? 0).toBeGreaterThan(1);
  });

  it("keeps plain text (no token spans) for unknown languages", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    hostMessage({ type: "toolCall", id: "t1", name: "Edit", arguments: { path: "/w/notes.txt" } });
    hostMessage({
      type: "toolResult",
      toolCallId: "t1",
      output: "Diff (+1/-1):\n```diff\n@@ -1,1 +1,1 @@\n-hello\n+world\n```",
      isError: false,
    });
    const add = document.querySelector(".msg.tool .tool-diff .fd-add") as HTMLElement;
    expect(add?.textContent).toBe("+world");
    expect(add?.querySelector(".token")).toBeNull();
  });

  it("keeps thinking collapsed and renders the tool name with collapsed details", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    expect((document.getElementById("working-bar") as HTMLElement).classList.contains("hidden")).toBe(false);

    hostMessage({ type: "thinkingDelta", content: "thinking" });
    hostMessage({ type: "toolCall", id: "c1", name: "read_file", arguments: { path: "/x" } });
    hostMessage({ type: "toolResult", toolCallId: "c1", output: "content", isError: false });
    hostMessage({ type: "textDelta", content: "Answers" });
    hostMessage({ type: "done" });

    // Thinking stays as a collapsed block (▶) even while/after streaming,
    // tool details collapsed, result last.
    const thinking = document.querySelector(".thinking-block .thinking-body") as HTMLElement;
    expect(thinking.classList.contains("collapsed")).toBe(true);
    expect((document.querySelector(".thinking-header .toggle") as HTMLElement).textContent).toBe("▶");
    const tool = document.querySelector(".msg.tool") as HTMLElement;
    expect(tool.textContent).toContain("read_file");
    expect(tool.querySelector(".tool-details")?.classList.contains("collapsed")).toBe(true);
    expect(tool.querySelector(".tool-name")?.textContent).toContain("🔧 read_file");
    // final answer is the last assistant bubble
    expect(messagesElLastContent()).toContain("Answers");
  });

  it("renders a model dropdown grouped by provider and posts setModel on change", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai-compatible",
        activeProvider: "opencode-go",
        model: "deepseek-v4-flash",
        hasKey: true,
        models: ["deepseek-v4-flash"],
        providerModels: [
          { provider: "opencode-go", model: "deepseek-v4-flash" },
          { provider: "opencode-go", model: "deepseek-v4-pro" },
          { provider: "llamacpp", model: "LLM/gemma.gguf" },
        ],
      },
    });

    const select = document.getElementById("model-select") as HTMLSelectElement;
    expect(select.options.length).toBe(3);
    expect(select.querySelector("optgroup[label='llamacpp']")?.textContent).toContain("LLM/gemma.gguf");
    expect(select.value).toBe("deepseek-v4-flash");

    const local = [...select.options].find((o) => o.value === "LLM/gemma.gguf") as HTMLOptionElement;
    select.value = local.value;
    select.dispatchEvent(new Event("change"));
    expect(posted).toContainEqual({ type: "setModel", model: "LLM/gemma.gguf", provider: "llamacpp" });
  });

  it("orders provider groups alphabetically and merges failed providers into their sorted position", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai-compatible",
        activeProvider: "openrouter",
        model: "deepseek/deepseek-chat-v3",
        hasKey: true,
        models: [],
        providerModels: [
          // Deliberately NOT in alphabetical order in the payload.
          { provider: "openrouter", model: "deepseek/deepseek-chat-v3" },
          { provider: "llamacpp", model: "LLM/gemma.gguf" },
          { provider: "opencode-go", model: "deepseek-v4-flash" },
        ],
        // llamacpp failed its fetch: it must still sit BEFORE opencode-go /
        // openrouter (l < o) instead of being appended at the end.
        hostModelErrors: [{ provider: "llamacpp", error: "HTTP 500" }],
      },
    });
    const select = document.getElementById("model-select") as HTMLSelectElement;
    const labels = [...select.querySelectorAll<HTMLOptGroupElement>("optgroup")].map((g) => g.label);
    expect(labels).toEqual(["llamacpp", "opencode-go", "openrouter"]);
  });

  it("marks a failed provider red with the error message inside its group", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai-compatible",
        activeProvider: "llamacpp",
        model: "",
        hasKey: true,
        models: [],
        providerModels: [{ provider: "opencode-go", model: "deepseek-v4-flash" }],
        hostModelErrors: [{ provider: "llamacpp", error: "GET /v1/models → HTTP 500" }],
      },
    });
    const select = document.getElementById("model-select") as HTMLSelectElement;
    const failed = select.querySelector<HTMLOptGroupElement>("optgroup[label='llamacpp']");
    expect(failed).toBeTruthy();
    expect(failed!.className).toContain("optgroup-failed");
    const err = [...failed!.querySelectorAll<HTMLOptionElement>("option")].find((o) => o.className.includes("option-error"));
    expect(err).toBeTruthy();
    expect(err!.textContent).toContain("HTTP 500");
    expect(err!.textContent).toContain("host unreachable");
    expect(err!.disabled).toBe(true);
  });

  it("refreshes the provider list when the model dropdown is opened", async () => {
    await loadView();
    posted.length = 0;
    const select = document.getElementById("model-select") as HTMLSelectElement;
    select.dispatchEvent(new MouseEvent("mousedown"));
    expect(posted).toContainEqual({ type: "getConfig" });

    posted.length = 0;
    select.dispatchEvent(new FocusEvent("focus"));
    expect(posted).toContainEqual({ type: "getConfig" });
  });

  it("gear button opens the providers editor and save posts normalized providers", async () => {
    await loadView();
    const gear = document.getElementById("gear-btn") as HTMLButtonElement;
    gear.click();
    expect(posted).toContainEqual({ type: "getProvidersEditor" });

    hostMessage({
      type: "providersEditor",
      data: {
        activeProvider: "llamacpp",
        providers: {
          llamacpp: { baseUrl: "http://localhost:8090/v1", apiKey: "local", thinking: "bool" },
          openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or", thinking: "effort" },
        },
      },
    });
    const providersModal = document.getElementById("providers-modal") as HTMLDivElement;
    expect(providersModal.classList.contains("hidden")).toBe(false);
    const select = document.getElementById("provider-select") as HTMLSelectElement;
    expect(select.options.length).toBe(2);
    expect(select.options[0].textContent).toContain("llamacpp");

    // Edit the first provider (llamacpp): shorten baseUrl, expect normalization.
    const baseUrlInput = document.getElementById("pe-baseurl") as HTMLInputElement;
    baseUrlInput.value = "localhost:8090";
    const nameInput = document.getElementById("pe-name") as HTMLInputElement;
    nameInput.value = "llamacpp";
    const save = document.getElementById("providers-save") as HTMLButtonElement;
    save.click();
    const saveMsg = posted.find((m) => (m as { type?: string }).type === "saveProviders") as Record<string, unknown>;
    expect(saveMsg).toBeTruthy();
    // Every provider is active: the editor must NOT send an activeProvider.
    expect((saveMsg.data as { activeProvider?: string }).activeProvider).toBeUndefined();
    const data = (saveMsg.data as { providers: Record<string, { baseUrl?: string }> }).providers;
    expect(data.llamacpp!.baseUrl).toBe("http://localhost:8090/v1");
    expect(data.openrouter!.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("test connection posts testProvider and renders the result", async () => {
    await loadView();
    hostMessage({
      type: "providersEditor",
      data: { activeProvider: "llamacpp", providers: { llamacpp: { baseUrl: "http://localhost:8090/v1" } } },
    });
    posted.length = 0;
    const test = document.getElementById("provider-test") as HTMLButtonElement;
    test.click();
    expect(posted).toContainEqual({
      type: "testProvider",
      data: { baseUrl: "http://localhost:8090/v1", apiKey: undefined },
    });

    hostMessage({ type: "providersTested", ok: true, models: ["LLM/qwen.gguf"] });
    const result = document.getElementById("provider-test-result") as HTMLDivElement;
    expect(result.classList.contains("hidden")).toBe(false);
    expect(result.textContent).toContain("Connection OK");
    expect(result.textContent).toContain("LLM/qwen.gguf");

    hostMessage({ type: "providersTested", ok: false, error: "HTTP 500" });
    expect(result.textContent).toContain("HTTP 500");
    expect(result.className).toContain("err");
  });

  it("adds a new provider with + New and keeps a complete URL untouched", async () => {
    await loadView();
    hostMessage({
      type: "providersEditor",
      data: { providers: { openrouter: { baseUrl: "https://openrouter.ai/api/v1" } } },
    });
    const add = document.getElementById("provider-add") as HTMLButtonElement;
    add.click();
    const select = document.getElementById("provider-select") as HTMLSelectElement;
    expect(select.options.length).toBe(2);
    const nameInput = document.getElementById("pe-name") as HTMLInputElement;
    expect(nameInput.value).toBe("new-provider");

    // Complete URL: normalization leaves it as-is.
    const baseUrlInput = document.getElementById("pe-baseurl") as HTMLInputElement;
    baseUrlInput.value = "https://openrouter.ai/api/v1";
    posted.length = 0;
    const save = document.getElementById("providers-save") as HTMLButtonElement;
    save.click();
    const saveMsg = posted.find((m) => (m as { type?: string }).type === "saveProviders") as Record<string, unknown>;
    const data = (saveMsg.data as { providers: Record<string, { baseUrl?: string }> }).providers;
    expect(data["new-provider"]!.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("renames a provider on save and maps thinking unspecified to undefined", async () => {
    await loadView();
    hostMessage({
      type: "providersEditor",
      data: { providers: { llamacpp: { baseUrl: "http://localhost:8090/v1", thinking: "bool" } } },
    });
    const nameInput = document.getElementById("pe-name") as HTMLInputElement;
    nameInput.value = "llamacpp-2";
    const thinking = document.getElementById("pe-thinking") as HTMLSelectElement;
    thinking.value = "unspecified";
    posted.length = 0;
    const save = document.getElementById("providers-save") as HTMLButtonElement;
    save.click();
    const saveMsg = posted.find((m) => (m as { type?: string }).type === "saveProviders") as Record<string, unknown>;
    const data = (saveMsg.data as { providers: Record<string, { thinking?: string }> }).providers;
    expect(data["llamacpp-2"]).toBeTruthy();
    expect(data.llamacpp).toBeUndefined();
    expect(data["llamacpp-2"]!.thinking).toBeUndefined(); // "unspecified" → omitted
  });

  it("carries unmanaged provider keys through save and rename (lossless)", async () => {
    await loadView();
    hostMessage({
      type: "providersEditor",
      data: {
        providers: {
          custom: {
            baseUrl: "http://x/v1",
            thinking: "bool",
            thinkingLevel: "high",
            extra: { models: [{ id: "m1" }], customAnything: 7 },
          },
        },
      },
    });
    (document.getElementById("pe-name") as HTMLInputElement).value = "renamed";
    posted.length = 0;
    (document.getElementById("providers-save") as HTMLButtonElement).click();
    const saveMsg = posted.find((m) => (m as { type?: string }).type === "saveProviders") as Record<string, unknown>;
    const data = (saveMsg.data as {
      providers: Record<string, { extra?: unknown; thinkingLevel?: string }>;
    }).providers;
    expect(data.custom).toBeUndefined();
    expect(data.renamed).toBeTruthy();
    expect(data.renamed.extra).toEqual({ models: [{ id: "m1" }], customAnything: 7 });
    expect(data.renamed.thinkingLevel).toBe("high");
  });

  it("deletes a provider after the two-step confirmation", async () => {
    await loadView();
    hostMessage({
      type: "providersEditor",
      data: { providers: { a: { baseUrl: "http://a/v1" }, b: { baseUrl: "http://b/v1" } } },
    });
    const select = document.getElementById("provider-select") as HTMLSelectElement;
    const del = document.getElementById("provider-delete") as HTMLButtonElement;
    // First click arms the delete; second click actually removes it.
    del.click();
    expect(del.textContent).toBe("Really delete?");
    del.click();
    expect(select.options.length).toBe(1);
    const nameInput = document.getElementById("pe-name") as HTMLInputElement;
    expect(nameInput.value).toBe("b"); // selection moved to the remaining one

    posted.length = 0;
    const save = document.getElementById("providers-save") as HTMLButtonElement;
    save.click();
    const saveMsg = posted.find((m) => (m as { type?: string }).type === "saveProviders") as Record<string, unknown>;
    const data = (saveMsg.data as { providers: Record<string, unknown> }).providers;
    expect(data.a).toBeUndefined();
    expect(data.b).toBeTruthy();
  });

  it("keeps the modal open and reports an error when saving fails", async () => {
    await loadView();
    hostMessage({
      type: "providersEditor",
      data: { providers: { a: { baseUrl: "http://a/v1" } } },
    });
    const providersModal = document.getElementById("providers-modal") as HTMLDivElement;
    const save = document.getElementById("providers-save") as HTMLButtonElement;
    save.click();
    hostMessage({ type: "providersSaved", ok: false });
    expect(providersModal.classList.contains("hidden")).toBe(false);
    const result = document.getElementById("provider-test-result") as HTMLDivElement;
    expect(result.textContent).toContain("Could not write the config file");
    expect(result.className).toContain("err");
  });

  it("closes the providers editor on Cancel and on Escape", async () => {
    await loadView();
    hostMessage({
      type: "providersEditor",
      data: { providers: { a: { baseUrl: "http://a/v1" } } },
    });
    const providersModal = document.getElementById("providers-modal") as HTMLDivElement;
    const cancel = document.getElementById("providers-cancel") as HTMLButtonElement;
    cancel.click();
    expect(providersModal.classList.contains("hidden")).toBe(true);

    hostMessage({
      type: "providersEditor",
      data: { providers: { a: { baseUrl: "http://a/v1" } } },
    });
    expect(providersModal.classList.contains("hidden")).toBe(false);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(providersModal.classList.contains("hidden")).toBe(true);
  });

  it("fresh install (no providers): shows placeholder, disables actions, + New enables saving", async () => {
    await loadView();
    // Host has NO config file yet: empty provider map.
    hostMessage({ type: "providersEditor", data: { providers: {} } });
    const providersModal = document.getElementById("providers-modal") as HTMLDivElement;
    expect(providersModal.classList.contains("hidden")).toBe(false);
    const select = document.getElementById("provider-select") as HTMLSelectElement;
    expect(select.options.length).toBe(1);
    expect(select.options[0].textContent).toContain("No providers yet");

    const save = document.getElementById("providers-save") as HTMLButtonElement;
    const test = document.getElementById("provider-test") as HTMLButtonElement;
    const del = document.getElementById("provider-delete") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(test.disabled).toBe(true);
    expect(del.disabled).toBe(true);

    // + New creates the first provider and enables editing/saving.
    const add = document.getElementById("provider-add") as HTMLButtonElement;
    add.click();
    expect(select.options.length).toBe(1);
    expect(select.options[0].value).toBe("new-provider");
    const nameInput = document.getElementById("pe-name") as HTMLInputElement;
    nameInput.value = "llamacpp";
    const baseUrlInput = document.getElementById("pe-baseurl") as HTMLInputElement;
    baseUrlInput.value = "http://localhost:8090/v1";
    expect(save.disabled).toBe(false);
    posted.length = 0;
    save.click();
    const saveMsg = posted.find((m) => (m as { type?: string }).type === "saveProviders") as Record<string, unknown>;
    const data = (saveMsg.data as { providers: Record<string, { baseUrl?: string }> }).providers;
    expect(data.llamacpp!.baseUrl).toBe("http://localhost:8090/v1");
  });

  it("shows a placeholder and selects nothing when the active session has no model", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai-compatible",
        model: "", // new session: no model chosen yet
        hasKey: true,
        models: [],
        providerModels: [
          { provider: "opencode-go", model: "deepseek-v4-flash" },
          { provider: "openrouter", model: "deepseek/deepseek-chat-v3" },
        ],
      },
    });
    const select = document.getElementById("model-select") as HTMLSelectElement;
    expect(select.options[0].textContent).toContain("Select a model");
    expect(select.options[0].disabled).toBe(true);
    // placeholder selected, no real model auto-selected
    expect(select.value).toBe("");
  });

  it("posts send / switchTab / newSession / rename / delete / closeTab", async () => {
    await loadView();
    (document.getElementById("new-session") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "newSession" });

    const tabs = document.querySelectorAll(".tab");
    (tabs[1] as HTMLDivElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(posted).toContainEqual({ type: "switchTab", id: "b" });
    (tabs[0].querySelector(".close") as HTMLSpanElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(posted).toContainEqual({ type: "closeTab", id: "a" });

    const rows = document.querySelectorAll(".srow");
    (rows[0].querySelector(".name") as HTMLSpanElement).click();
    expect(posted).toContainEqual({ type: "openSession", id: "a" });
    const btns = rows[0].querySelectorAll("button");
    (btns[0] as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "branchSession", id: "a" });
    (btns[1] as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "renameSession", id: "a" });
    (btns[2] as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "deleteSession", id: "a" });

    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "do something";
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "send", text: "do something" });
  });
});

describe("branch from assistant bubble", () => {
  beforeEach(() => { posted.length = 0; setupDom(); });

  it("adds a ⎇ key to every visible assistant bubble and posts branchAt with its index", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [
        { role: "user", content: "q1", timestamp: 1 },
        { role: "assistant", content: "a1", timestamp: 2 },
        { role: "user", content: "q2", timestamp: 3 },
        { role: "assistant", content: "a2", timestamp: 4 },
        { role: "assistant", content: "", thinking: "thought", toolCalls: [], timestamp: 5 },
      ],
    });
    const keys = document.querySelectorAll(".msg.assistant .branch-at");
    // Two visible bubbles (a1 at index 1, a2 at index 3); the thinking-only
    // bubble renders blocks but no answer bubble, so no key there.
    expect(keys.length).toBe(2);
    // Inline SVG icon (not a text glyph).
    expect(keys[0].querySelector("svg path")).toBeTruthy();
    (keys[0] as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "branchAt", index: 1 });
    (keys[1] as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "branchAt", index: 3 });
  });

  it("disables the branch keys while the session is working", async () => {
    await loadView();
    hostMessage({ type: "refresh", messages: [{ role: "user", content: "q", timestamp: 1 }, { role: "assistant", content: "a", timestamp: 2 }] });
    const key = document.querySelector(".msg.assistant .branch-at") as HTMLButtonElement;
    expect(key.disabled).toBe(false);
    hostMessage({ type: "status", active: true });
    expect(key.disabled).toBe(true);
    hostMessage({ type: "status", active: false });
    expect(key.disabled).toBe(false);
  });
});

describe("in-panel alert modal", () => {
  beforeEach(() => { posted.length = 0; setupDom(); });

  it("shows the alert and OK responds true", async () => {
    await loadView();
    hostMessage({ type: "modal", modalId: 7, kind: "alert", alertKind: "info", title: "Name already in use", message: "A session named X already exists." });
    const modal = document.getElementById("alert-modal") as HTMLDivElement;
    expect(modal.classList.contains("hidden")).toBe(false);
    expect(document.getElementById("alert-title")?.textContent).toBe("Name already in use");
    expect(document.getElementById("alert-message")?.textContent).toContain("already exists");
    (document.getElementById("alert-ok") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "modalResponse", id: 7, value: true });
    expect(modal.classList.contains("hidden")).toBe(true);
  });

  it("confirm shows Cancel; cancel and Escape respond false", async () => {
    await loadView();
    hostMessage({ type: "modal", modalId: 3, kind: "alert", alertKind: "confirm", title: "Delete session", message: "Delete session X?", confirmText: "Delete" });
    expect((document.getElementById("alert-ok") as HTMLButtonElement).textContent).toBe("Delete");
    (document.getElementById("alert-cancel") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "modalResponse", id: 3, value: false });

    hostMessage({ type: "modal", modalId: 4, kind: "alert", alertKind: "confirm", title: "T", message: "M", confirmText: "OK" });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(posted).toContainEqual({ type: "modalResponse", id: 4, value: false });
  });

  it("single-button alerts hide the Cancel key", async () => {
    await loadView();
    hostMessage({ type: "modal", modalId: 1, kind: "alert", alertKind: "error", title: "E", message: "M" });
    expect((document.getElementById("alert-cancel") as HTMLButtonElement).style.display).toBe("none");
  });
});

it("the shared sampler input accepts digits and ONE decimal separator only", async () => {
    await loadView();
    const input = document.getElementById("samp-input") as HTMLInputElement;
    input.value = "1,5.3";
    input.dispatchEvent(new Event("input"));
    expect(input.value).toBe("1.53"); // comma -> dot, extra dots stripped
    input.value = "abc12.";
    input.dispatchEvent(new Event("input"));
    expect(input.value).toBe("12."); // letters stripped, a single trailing dot kept
  });

  it("context window and output tokens accept integers only", async () => {
    await loadView();
    const ctx = document.getElementById("ctx-input") as HTMLInputElement;
    ctx.value = "12.5e3";
    ctx.dispatchEvent(new Event("input"));
    expect(ctx.value).toBe("1253");
    const out = document.getElementById("out-input") as HTMLInputElement;
    out.value = "8.5";
    out.dispatchEvent(new Event("input"));
    expect(out.value).toBe("85");
  });

it("presence/frequency steppers render, step and reset to Auto like temperature", async () => {
    await loadView();
    hostMessage({ type: "config", config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], presencePenalty: 1.5, frequencyPenalty: 0.5 } });
    const p = document.getElementById("presence-input") as HTMLInputElement;
    const f = document.getElementById("freq-input") as HTMLInputElement;
    expect(p.value).toBe("1.5");
    expect(f.value).toBe("0.5");
    (document.getElementById("presence-plus") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "setPresencePenalty", value: 1.6 });
    (document.getElementById("freq-auto") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "setFrequencyPenalty", value: null });
    expect(f.value).toBe("");
  });

function messagesElLastContent(): string {
  const els = document.querySelectorAll("#messages > *");
  const last = els[els.length - 1];
  // Strip the branch-from-this-point key (⎇) from the bubble text.
  return last ? (last.textContent || "").replace(/⎇/g, "") : "";
}

function hostMessage(data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data }));
}

describe("context metrics line", () => {
  beforeEach(() => { posted.length = 0; setupDom(); });

  it("shows tokens, percent and bar, and posts compact", async () => {
    await loadView();
    hostMessage({ type: "config", config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 200000, contextTokens: 100000 } });
    expect(document.getElementById("met-tokens")?.textContent).toBe("100k");
    expect(document.getElementById("met-ctx")?.textContent).toBe("200k");
    expect(document.getElementById("met-pct")?.textContent).toBe("(50%)");
    expect((document.getElementById("ctx-bar") as HTMLDivElement).style.width).toBe("50%");
    // The cache badge always occupies its slot (idle when not reported).
    const cache = document.getElementById("met-cache") as HTMLSpanElement;
    expect(cache.textContent).toContain("cache");
    expect(cache.classList.contains("idle")).toBe(true);

    (document.getElementById("compact-btn") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "compact" });
  });

  it("flags >= 90% usage as warning", async () => {
    await loadView();
    hostMessage({ type: "config", config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 100000, contextTokens: 95000 } });
    expect((document.getElementById("ctx-bar") as HTMLDivElement).classList.contains("warn")).toBe(true);
  });

  it("gear opens the threshold form, prefills the current %, saves and posts", async () => {
    await loadView();
    hostMessage({ type: "config", config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 200000, compactionThresholdPercent: 60 } });
    const modal = document.getElementById("compact-settings-modal") as HTMLDivElement;
    expect(modal.classList.contains("hidden")).toBe(true);
    // The label already shows the session's saved threshold from the config push.
    expect(document.getElementById("compact-threshold-label")?.textContent).toBe("Auto Compact threshold: 60%");
    (document.getElementById("compact-settings-btn") as HTMLButtonElement).click();
    expect(modal.classList.contains("hidden")).toBe(false);
    const input = document.getElementById("compact-threshold-input") as HTMLInputElement;
    expect(input.value).toBe("60");
    input.value = "75";
    (document.getElementById("compact-settings-save") as HTMLButtonElement).click();
    expect(modal.classList.contains("hidden")).toBe(true);
    expect(posted).toContainEqual({ type: "setCompactionThreshold", value: 75 });
    // The label between Compact and the gear reflects the saved value.
    expect(document.getElementById("compact-threshold-label")?.textContent).toBe("Auto Compact threshold: 75%");

    // Reopening shows the value saved last (not the config one again).
    (document.getElementById("compact-settings-btn") as HTMLButtonElement).click();
    expect(input.value).toBe("75");
  });

  it("clamps an out-of-range typed threshold and cancels without posting", async () => {
    await loadView();
    const modal = document.getElementById("compact-settings-modal") as HTMLDivElement;
    (document.getElementById("compact-settings-btn") as HTMLButtonElement).click();
    const input = document.getElementById("compact-threshold-input") as HTMLInputElement;
    input.value = "250";
    (document.getElementById("compact-settings-save") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "setCompactionThreshold", value: 100 });
    (document.getElementById("compact-settings-btn") as HTMLButtonElement).click();
    input.value = "0";
    (document.getElementById("compact-settings-cancel") as HTMLButtonElement).click();
    expect(modal.classList.contains("hidden")).toBe(true);
    expect(posted).not.toContainEqual({ type: "setCompactionThreshold", value: 1 });
  });

  it("Enter saves and Escape closes the threshold form", async () => {
    await loadView();
    const modal = document.getElementById("compact-settings-modal") as HTMLDivElement;
    (document.getElementById("compact-settings-btn") as HTMLButtonElement).click();
    const input = document.getElementById("compact-threshold-input") as HTMLInputElement;
    input.value = "90";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(posted).toContainEqual({ type: "setCompactionThreshold", value: 90 });
    expect(modal.classList.contains("hidden")).toBe(true);

    (document.getElementById("compact-settings-btn") as HTMLButtonElement).click();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(modal.classList.contains("hidden")).toBe(true);
    expect(posted).not.toContainEqual({ type: "setCompactionThreshold", value: 80 }); // no extra post on Escape
  });
});

describe("context window spinner", () => {
  beforeEach(() => { posted.length = 0; setupDom(); });

  it("renders the context value from config and posts changes via + / -", async () => {
    await loadView();
    hostMessage({ type: "config", config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 200000 } });
    const input = document.getElementById("ctx-input") as HTMLInputElement;
    expect(input.value).toBe("200000");

    (document.getElementById("ctx-plus") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "setContextWindow", value: 216000 });
    expect(input.value).toBe("216000");

    (document.getElementById("ctx-minus") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "setContextWindow", value: 200000 });
  });

  it("clamps a manually typed value and posts it on change", async () => {
    await loadView();
    const input = document.getElementById("ctx-input") as HTMLInputElement;
    input.value = "999999";
    input.dispatchEvent(new Event("change"));
    expect(posted).toContainEqual({ type: "setContextWindow", value: 999999 });

    input.value = "1000"; // below min -> clamp to 32000
    input.dispatchEvent(new Event("change"));
    expect(posted).toContainEqual({ type: "setContextWindow", value: 32000 });
  });
});

describe("output tokens spinner", () => {
  beforeEach(() => { posted.length = 0; setupDom(); });

  it("renders the value from config (default 8192) and posts changes via + / -", async () => {
    await loadView();
    const input = document.getElementById("out-input") as HTMLInputElement;
    expect(input.value).toBe("8192");

    hostMessage({ type: "config", config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], outputTokens: 16384 } });
    expect(input.value).toBe("16384");

    (document.getElementById("out-plus") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "setOutputTokens", value: 16896 });
    expect(input.value).toBe("16896");

    (document.getElementById("out-minus") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "setOutputTokens", value: 16384 });
  });

  it("clamps a manually typed value and posts it on change", async () => {
    await loadView();
    const input = document.getElementById("out-input") as HTMLInputElement;
    input.value = "100"; // below min -> clamp to 256
    input.dispatchEvent(new Event("change"));
    expect(posted).toContainEqual({ type: "setOutputTokens", value: 256 });
  });
});

describe("sampler (radio + shared stepper)", () => {
  beforeEach(() => { posted.length = 0; setupDom(); });

  it("renders the ACTIVE sampler value and posts changes via the shared stepper", async () => {
    await loadView();
    const input = document.getElementById("samp-input") as HTMLInputElement;
    // Temperature by default, no value -> Auto (empty).
    expect(input.value).toBe("");
    expect((document.getElementById("sampler-temp") as HTMLInputElement).checked).toBe(true);

    hostMessage({ type: "config", config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], temperature: 0.7 } });
    expect(input.value).toBe("0.7");

    input.value = "1.5";
    input.dispatchEvent(new Event("change"));
    expect(posted).toContainEqual({ type: "setSamplerValue", value: 1.5 });
  });

  it("clamps to the ACTIVE scale (0–2 temperature, 0–1 top-p) and Auto resets", async () => {
    await loadView();
    const input = document.getElementById("samp-input") as HTMLInputElement;
    const auto = document.getElementById("samp-auto") as HTMLButtonElement;

    input.value = "9"; // temperature scale -> clamp to 2
    input.dispatchEvent(new Event("change"));
    expect(posted).toContainEqual({ type: "setSamplerValue", value: 2 });
    expect(input.value).toBe("2");

    // Switch to Top-P: radio change posts the mode; the host resets value to Auto.
    (document.getElementById("sampler-topp") as HTMLInputElement).click();
    expect(posted).toContainEqual({ type: "setSamplerMode", mode: "topP" });

    hostMessage({ type: "config", config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], sampler: "topP", topP: 0.9 } });
    expect(input.value).toBe("0.9");
    expect((document.getElementById("sampler-topp") as HTMLInputElement).checked).toBe(true);

    input.value = "5"; // top-p scale -> clamp to 1
    input.dispatchEvent(new Event("change"));
    expect(posted).toContainEqual({ type: "setSamplerValue", value: 1 });
    expect(input.value).toBe("1");

    // Empty input and Auto reset to Auto (null).
    input.value = "";
    input.dispatchEvent(new Event("change"));
    expect(posted).toContainEqual({ type: "setSamplerValue", value: null });
    input.value = "0.5";
    input.dispatchEvent(new Event("change"));
    auto.click();
    expect(posted).toContainEqual({ type: "setSamplerValue", value: null });
    expect(input.value).toBe("");
  });

  it("steps with − / + using the active scale", async () => {
    await loadView();
    hostMessage({ type: "config", config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], sampler: "topP", topP: 0.9 } });
    const input = document.getElementById("samp-input") as HTMLInputElement;
    (document.getElementById("samp-plus") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "setSamplerValue", value: 1 }); // 0.9+0.1 -> 1.0 (cap)
    expect(input.value).toBe("1");
    (document.getElementById("samp-minus") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "setSamplerValue", value: 0.9 });
  });
});

describe("empty shell (no open session)", () => {
  beforeEach(() => { posted.length = 0; });

  it("hides the control stack and shows the hero when no session is active", async () => {
    setupDom({ sessions: [], openIds: [], activeId: undefined, messages: [] });
    await loadView();
    expect(document.body.classList.contains("no-session")).toBe(true);
    expect((document.getElementById("input-area") as HTMLElement).style.display).toBe(""); // hidden via CSS class
    expect(document.querySelector(".empty-hero")).not.toBeNull();
    expect(document.querySelector(".empty-hero h2")?.textContent).toContain("Harny");
  });

  it("creates a new session from the hero CTA", async () => {
    setupDom({ sessions: [], openIds: [], activeId: undefined, messages: [] });
    await loadView();
    (document.getElementById("empty-new-session") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "newSession" });
  });

  it("restores controls and chat when a session becomes active", async () => {
    setupDom({ sessions: [], openIds: [], activeId: undefined, messages: [] });
    await loadView();
    expect(document.body.classList.contains("no-session")).toBe(true);

    hostMessage({
      type: "switchView",
      sessions: [{ id: "a", name: "Refactor", createdAt: 1, updatedAt: 2, messageCount: 1 }],
      openIds: ["a"],
      activeId: "a",
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 },
      workingIds: [],
    });
    expect(document.body.classList.contains("no-session")).toBe(false);
    expect(document.querySelector(".empty-hero")).toBeNull();
    expect(document.querySelector("#messages .msg.user")?.textContent).toBe("hello");
  });

  it("shows the folder hero when no single workspace is open", async () => {
    setupDom({
      sessions: [],
      openIds: [],
      activeId: undefined,
      messages: [],
      config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000, workspaceReady: false },
    });
    await loadView();
    expect(document.body.classList.contains("no-workspace")).toBe(true);
    expect(document.body.classList.contains("no-session")).toBe(false);
    expect(document.querySelector(".empty-hero")).not.toBeNull();
    expect(document.querySelector(".empty-hero p")?.textContent).toContain("single open folder");
  });
});

describe("session name modal (unique names)", () => {
  beforeEach(() => { posted.length = 0; setupDom(); });

  it("blocks duplicate names for create and lets unique ones pass", async () => {
    await loadView();
    hostMessage({ type: "modal", modalId: 10, kind: "name", mode: "create", current: undefined });
    const input = document.getElementById("name-input") as HTMLInputElement;
    const ok = document.getElementById("name-ok") as HTMLButtonElement;
    const err = document.getElementById("name-error") as HTMLDivElement;
    // Fixture sessions: a = Refactor, b = Debug.
    input.value = "Refactor"; // duplicates session a
    input.dispatchEvent(new Event("input"));
    expect(ok.disabled).toBe(true);
    expect(err.textContent).toContain("already exists");
    input.value = "Refactor 2";
    input.dispatchEvent(new Event("input"));
    expect(ok.disabled).toBe(false);
    expect(err.textContent).toBe("");
    ok.click();
    expect(posted).toContainEqual({ type: "modalResponse", id: 10, value: "Refactor 2" });
  });

  it("rename keeps its own name valid and Enter cannot bypass a duplicate", async () => {
    await loadView();
    hostMessage({ type: "modal", modalId: 11, kind: "name", mode: "rename", id: "a", current: "Refactor" });
    const input = document.getElementById("name-input") as HTMLInputElement;
    const ok = document.getElementById("name-ok") as HTMLButtonElement;
    // Own current name stays valid (self excluded from the check).
    expect(ok.disabled).toBe(false);
    // Renaming to the OTHER session's name is blocked.
    input.value = "Debug";
    input.dispatchEvent(new Event("input"));
    expect(ok.disabled).toBe(true);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(posted.some((m: any) => m.type === "modalResponse")).toBe(false);
  });

  it("defaults a branch to the original name and requires it to be unique", async () => {
    await loadView();
    hostMessage({ type: "modal", modalId: 12, kind: "name", mode: "branch", id: "a", current: "Refactor" });
    const input = document.getElementById("name-input") as HTMLInputElement;
    expect(input.value).toBe("Refactor");
    expect((document.getElementById("name-ok") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("name-modal-title") as HTMLElement).textContent).toBe("Branch session");
  });
});

describe("all-sessions manager (gear)", () => {
  beforeEach(() => {
    posted.length = 0;
    setupDom();
  });

  it("the gear button asks the host for every session", async () => {
    await loadView();
    (document.getElementById("sessions-gear-btn") as HTMLButtonElement).click();
    expect(posted.some((m: any) => m.type === "getAllSessions")).toBe(true);
  });

  it("renders rows with folder + actions (change folder / delete only — no Open)", async () => {
    await loadView();
    hostMessage({
      type: "sessionsManager",
      currentFolder: "/home/me/a",
      sessions: [
        { id: "x", name: "Local", createdAt: 1, updatedAt: 9, messageCount: 2, folder: "/home/me/a", folderMissing: false },
        { id: "b", name: "Foreign", createdAt: 1, updatedAt: 5, messageCount: 1, folder: "/home/me/b", folderMissing: true },
        { id: "c", name: "NoFolder", createdAt: 1, updatedAt: 3, messageCount: 0, folder: undefined, folderMissing: false },
      ],
    });
    const rows = document.querySelectorAll("#sessions-manager-list .sm-row");
    expect(rows.length).toBe(3);
    // NO Open button anywhere: opening other folders happens in VS Code.
    expect(document.querySelectorAll("#sessions-manager-list button.open-btn").length).toBe(0);
    // Current-folder row carries the "this folder" tag.
    expect(rows[0].textContent).toContain("this folder");
    // KNOWN but missing folder: red row with "— missing".
    expect(rows[1].textContent).toContain("missing");
    // UNKNOWN folder: neutral "folder not set", NOT red.
    const unknownFolder = rows[2].querySelector(".sm-folder") as HTMLElement;
    expect(unknownFolder.classList.contains("unset")).toBe(true);
    expect(unknownFolder.classList.contains("missing")).toBe(false);
    expect(unknownFolder.textContent).toContain("folder not set");
    // Per-row actions post the right messages.
    (rows[1].querySelector("button.folder-btn") as HTMLButtonElement).click(); // Change folder…
    expect(posted.some((m: any) => m.type === "sessionsManagerChangeFolder" && m.id === "b")).toBe(true);
    (rows[1].querySelector("button.del-btn") as HTMLButtonElement).click(); // delete
    expect(posted.some((m: any) => m.type === "deleteSession" && m.id === "b")).toBe(true);
  });

  it("disables ONLY the two setup gears while any session is working", async () => {
    // Init already has a working session: both gears start locked.
    setupDom({ workingIds: ["a"] });
    await loadView();
    const sessGear = document.getElementById("sessions-gear-btn") as HTMLButtonElement;
    const provGear = document.getElementById("gear-btn") as HTMLButtonElement;
    expect(sessGear.disabled).toBe(true);
    expect(provGear.disabled).toBe(true);
    expect(provGear.title).toContain("Stop the current work");
    // All work finished: both gears unlock.
    hostMessage({ type: "status", active: false, workingIds: [] });
    expect(sessGear.disabled).toBe(false);
    expect(provGear.disabled).toBe(false);
    expect(sessGear.title).toContain("Manage all sessions");
    // A new working session locks them again.
    hostMessage({ type: "status", active: true, workingIds: ["b"] });
    expect(sessGear.disabled).toBe(true);
    expect(provGear.disabled).toBe(true);
    // Row buttons in the manage form stay ENABLED regardless (only the gears lock).
    hostMessage({
      type: "sessionsManager",
      currentFolder: "/home/me/a",
      sessions: [
        { id: "a", name: "Local", createdAt: 1, updatedAt: 5, messageCount: 0, folder: "/home/me/a", folderMissing: false },
      ],
    });
    const row = document.querySelector<HTMLElement>(".sm-row");
    expect(row!.querySelector<HTMLButtonElement>("button.folder-btn")!.disabled).toBe(false);
    expect(row!.querySelector<HTMLButtonElement>("button.del-btn")!.disabled).toBe(false);
  });

  it("an empty form shows the empty hint and Close hides it", async () => {
    await loadView();
    hostMessage({ type: "sessionsManager", show: true, sessions: [] });
    const modal = document.getElementById("sessions-modal") as HTMLDivElement;
    expect(modal.classList.contains("hidden")).toBe(false);
    expect(document.querySelector("#sessions-manager-list .sm-empty")?.textContent).toContain(
      "No sessions yet",
    );
    (document.getElementById("sessions-close") as HTMLButtonElement).click();
    expect(modal.classList.contains("hidden")).toBe(true);
  });

  it("a silent sessionsManager refresh never opens the form — only show:true does", async () => {
    await loadView();
    const modal = document.getElementById("sessions-modal") as HTMLDivElement;
    const data = { type: "sessionsManager", currentFolder: "/home/me/a", sessions: [
      { id: "x", name: "Local", createdAt: 1, updatedAt: 5, messageCount: 0, folder: "/home/me/a", folderMissing: false },
    ] };
    // Silent refresh (open/close/delete paths): rows are rendered, modal stays closed.
    hostMessage(data);
    expect(modal.classList.contains("hidden")).toBe(true);
    expect(document.querySelectorAll(".sm-row").length).toBe(1);
    // Gear click path (show:true): the modal opens with the fresh data.
    hostMessage({ ...data, show: true });
    expect(modal.classList.contains("hidden")).toBe(false);
    expect(document.querySelectorAll(".sm-row").length).toBe(1);
  });



});
