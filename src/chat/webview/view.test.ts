// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { vi } from "vitest";

const posted: unknown[] = [];

/** Config push that turns the "Parallel" toggle ON (sub-agents available). */
const PARALLEL_ON = {
  type: "config",
  config: {
    provider: "openai",
    model: "gpt-4o",
    hasKey: true,
    parallel: true,
    models: [],
    providerModels: [],
    contextWindow: 128000,
  },
};

/**
 * The webview state, as VS Code keeps it across reloads.
 *
 * `setState` USED to be a no-op here, which made the whole persistence path untestable:
 * a test could seed a state but never observe what the view wrote. Now it stores, so a
 * reload is simulated honestly — call `loadView()` twice and the second instance starts
 * from exactly what the first one persisted. That is the difference between testing the
 * save function and testing that the save/restore ROUND TRIP works.
 */
let persistedState: Record<string, unknown> = {};

function setupDom(initOverrides: Record<string, unknown> = {}, savedState: Record<string, unknown> = {}): void {
  const init = {
    sessions: [
      { id: "a", name: "Refactor", createdAt: 1, updatedAt: 2, messageCount: 3 },
      { id: "b", name: "Debug", createdAt: 2, updatedAt: 1, messageCount: 1 },
    ],
    openIds: ["a", "b"],
    activeId: "a",
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
    config: {
      provider: "openai",
      model: "gpt-4o",
      hasKey: true,
      models: [],
      providerModels: [],
      contextWindow: 128000,
    },
    ...initOverrides,
  };
  document.body.innerHTML = `
    <div id="session-head"><span class="toggle is-open"><svg class="toggle-chevron"></svg></span><span>Sessions</span><span class="spacer"></span><button id="new-session">＋</button><button id="sessions-gear-btn">⚙</button></div>
    <div id="session-search-row"><input id="session-search" type="search" placeholder="Search sessions" /></div>
    <div id="sessions"></div>
    <div id="tabs"></div>
    <div id="running" class="hidden"></div>
    <div id="messages-wrap">
      <div id="messages"></div>
      <div id="switch-veil" role="status" aria-live="polite">
        <div class="switch-card">
          <span class="switch-spinner" aria-hidden="true"></span>
          <span class="switch-label">Opening session…</span>
        </div>
      </div>
    </div>
    <div id="pending-section" class="hidden">
      <div id="pending-head" role="button" tabindex="0" aria-expanded="true"><span class="toggle is-open"><svg class="toggle-chevron"></svg></span><span id="pending-head-text"></span></div>
      <div id="pending-area" class="hidden"></div>
    </div>
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
          <button type="button" class="mode-item" data-mode="agent" role="option" aria-selected="false">Build</button>
        </div>
      </div>
      <button type="button" id="parallel-btn" aria-pressed="false">Parallel</button>
      <div id="attach-row">
        <div id="attachment-chips" class="hidden"></div>
      </div>
    </div>
    <div id="status">AI Model: <button id="model-btn"><span id="model-btn-label">Select a model</span><span id="model-warn" class="hidden"></span></button><button id="gear-btn">⚙</button><input type="range" id="ctx-range" min="1000" max="2000000" step="1000"><span id="ctx-value"></span><span id="ctx-range-label"></span><input type="range" id="out-range" min="256" max="262144" step="256"><span id="out-value"></span><span id="out-range-label"></span><input id="sampler-temp" type="radio" name="sampler" checked><input id="sampler-topp" type="radio" name="sampler"><input type="range" id="samp-range" min="0" max="2" step="0.1"><span id="samp-value">Auto</span><span id="samp-range-label"></span><button id="samp-auto">Auto</button><input type="range" id="presence-range" min="0" max="2" step="0.1"><span id="presence-value">Auto</span><button id="presence-auto">Auto</button><input type="range" id="freq-range" min="0" max="2" step="0.1"><span id="freq-value">Auto</span><button id="freq-auto">Auto</button></div>
    <div id="ctl-cards"><input type="range" id="par-range" min="0" max="100" step="1" /><span id="par-value">4</span><button id="lg-reset"></button><div id="lg-head"><div id="lg-toggle" class="sampler-toggle"><input type="radio" name="lg-level" id="lg-off" value="off" /><input type="radio" name="lg-level" id="lg-low" value="low" /><input type="radio" name="lg-level" id="lg-medium" value="medium" checked /><input type="radio" name="lg-level" id="lg-high" value="high" /><input type="checkbox" id="lg-response" /></div><button id="lg-collapse"></button></div><div id="lg-params-field"><div id="lg-fields"></div></div><div id="skills-card" class="hidden"><div id="skills-list"></div></div><div id="mcp-card" class="hidden"><div id="mcp-list"></div><button id="mcp-configure"></button></div></div>
    <div id="metrics"><input type="radio" name="thinking-level" id="thinking-off" value="off" /><input type="radio" name="thinking-level" id="thinking-low" value="low" /><input type="radio" name="thinking-level" id="thinking-medium" value="medium" /><input type="radio" name="thinking-level" id="thinking-high" value="high" /><span id="met-tokens"></span><span id="met-ctx"></span><span id="met-pct"></span><span id="met-window"></span><span id="met-cache"></span><div id="ctx-bar-wrap"><div id="ctx-bar"></div></div><button id="compact-btn">Compact</button><span id="compact-threshold-label"></span><button id="compact-settings-btn">⚙</button></div>
    <div id="compact-settings-modal" class="hidden">
      <div class="cs-backdrop"></div>
      <div class="cs-card">
        <h3>Compaction settings</h3>
        <div class="cs-field">
          <label for="compact-threshold-input">Compaction threshold (%)</label>
          <div class="cs-inline">
            <input id="compact-threshold-input" type="range" min="1" max="100" />
            <span id="compact-threshold-value" class="cs-val"></span>
          </div>
        </div>
        <div class="cs-field">
          <label for="compact-target-input">Land at (%)</label>
          <div class="cs-inline">
            <input id="compact-target-input" type="range" min="0" max="100" />
            <span id="compact-target-value" class="cs-val"></span>
            <button id="compact-target-auto" class="secondary cs-mini" type="button">Auto</button>
          </div>
        </div>
        <p id="compact-note" class="cs-hint cs-note"></p>
        <pre id="compact-preview" class="cs-preview"></pre>
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
        <input id="pe-apikey" type="password" />
        <button id="pe-apikey-reveal">eye</button>
        <select id="pe-thinking"><option value="effort">Effort</option><option value="bool">Bool</option><option value="unspecified">Unspecified</option></select>
        <input id="pe-session-header" type="text" />
        <button id="provider-test" class="secondary">Test</button>
        <button id="provider-delete" class="secondary">Delete</button>
        <button id="provider-add" class="secondary">+ New</button>
        <div id="provider-test-result" class="hidden"></div>
        <button id="providers-export" class="secondary">Export models configuration</button>
        <button id="providers-import" class="secondary">Import models configuration</button>
        <span id="providers-io-result" class="providers-io"></span>
        <button id="providers-save">Save</button>
        <button id="providers-cancel" class="secondary">Cancel</button>
      </div>
    </div>
    <div id="ctl-toggle"><span id="insert-hint">Insert in <span id="insert-hint-word">Queue</span></span><button id="ctl-toggle-btn"></button><div id="transcript-actions"><button id="collapse-all" disabled></button><button id="autoscroll" disabled></button></div></div>
    <div id="mcp-modal" class="hidden">
      <div class="mcp-backdrop"></div>
      <select id="mcp-select"></select>
      <input id="mcp-name" type="text" />
      <input id="mcp-url" type="text" />
      <input id="mcp-command" type="text" />
      <textarea id="mcp-args"></textarea>
      <textarea id="mcp-env"></textarea>
      <textarea id="mcp-headers"></textarea>
      <label class="mcp-enabled-row"><input type="checkbox" id="mcp-enabled" role="switch" /> Enabled</label>
      <button id="mcp-test"></button><span id="mcp-test-result"></span>
      <button id="mcp-add"></button><button id="mcp-delete"></button>
      <button id="mcp-save"></button><button id="mcp-cancel"></button>
    </div>
    <div id="mcp-tools-popover" class="hidden"></div>
    <div id="find-bar" class="hidden" role="search"><input id="find-input" type="search" /><span id="find-count"></span><button id="find-prev"></button><button id="find-next"></button><button id="find-close"></button></div>
    <div id="ctx-menu" class="hidden" role="menu"></div>
    <div id="tip" class="tip hidden"></div>
    <div id="slash-menu" class="hidden"></div>
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
        <div id="alert-fields" class="alert-fields hidden"></div>
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
        <div class="sm-search"><input id="sessions-search" type="search" placeholder="Search sessions" /></div>
        <div id="sessions-manager-list"></div>
        <div id="sm-vacuum">
          <input id="sm-vacuum-threshold" type="range" />
          <span id="sm-vacuum-threshold-val"></span>
          <input id="sm-vacuum-min" type="range" />
          <span id="sm-vacuum-min-val"></span>
          <button id="sm-vacuum-btn">Compact now…</button>
          <div id="sm-vacuum-stats"></div>
        </div>
        <div class="sm-footer">
          <button id="sessions-close" class="secondary">Close</button>
        </div>
      </div>
    </div>
    <div id="db-vacuum-modal" class="hidden">
      <div class="dv-backdrop"></div>
      <div class="dv-card">
        <h3>Compact sessions database</h3>
        <p id="db-vacuum-msg"></p>
        <div id="db-vacuum-stats"></div>
        <div id="db-vacuum-info"></div>
        <button id="db-vacuum-close">Close</button>
        <button id="db-vacuum-run">Compact now</button>
      </div>
    </div>
    <div id="model-modal" class="hidden">
      <div class="mm-backdrop"></div>
      <div class="mm-card">
        <div class="mm-head"><h3>Select model</h3></div>
        <div class="mm-footer"><button id="model-close">Cancel</button></div>
        <div class="mm-search"><input id="model-search" type="search" placeholder="Search models" /><div id="mm-modelsdev-warn" class="hidden"></div></div>
        <div id="model-list"></div>
      </div>
    </div>
    <script id="harny-view-init" type="application/json">${JSON.stringify(init)}</script>
  `;
  persistedState = { ...savedState };
  (globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
    postMessage: (m: unknown) => posted.push(m),
    getState: () => persistedState,
    setState: (state: unknown) => {
      persistedState = state as Record<string, unknown>;
    },
  });
}

/** Listeners the view module registered on the SHARED `window`/`document`.
 *
 * Every test re-imports the module (`vi.resetModules()`), but `window` is the same
 * object for the whole file: without detaching, each test adds one more `message`
 * listener and EVERY host message is handled once per test run SO FAR. By the end
 * of the file that is ~300 handlers, each rendering markdown into its own detached
 * transcript: the suite got slower the longer it ran (37 s in CI against 16 s
 * locally) and a late test's timing became a function of the whole file. */
let globalListeners: {
  target: Window | Document;
  type: string;
  fn: EventListener;
  options?: AddEventListenerOptions | boolean;
}[] = [];

function detachGlobalListeners(): void {
  for (const { target, type, fn, options } of globalListeners) {
    target.removeEventListener(type, fn, options);
  }
  globalListeners = [];
}

/**
 * Reload the panel the way VS Code does: a FRESH DOM, a re-imported module, and the
 * state carrying over.
 *
 * The fresh DOM is not cosmetic. Re-importing alone leaves the previous instance's
 * click listeners on the SAME buttons, so one click runs two views and the assertions
 * measure the wrong one (that is exactly how the first version of these tests failed).
 */
async function reloadView(initOverrides: Record<string, unknown> = {}): Promise<void> {
  setupDom(initOverrides, persistedState);
  await loadView();
}

/**
 * The prerequisites EVERY test in this file shares, in ONE place.
 *
 * They used to be repeated as `posted.length = 0; setupDom();` inside thirty-one `describe`s —
 * and the tests outside any `describe` got neither, so they only passed because another block had
 * run first (a shuffled order turned that into `acquireVsCodeApi is not defined`). A prerequisite
 * is a fixture, not a copy per block: one top-level `beforeEach` installs it for all of them, and
 * a test that needs more calls this with its own overrides.
 */
/**
 * The platform every test runs on unless it says otherwise.
 *
 * jsdom derives its default UA from the HOST (`darwin` here, `linux`/`win32` on CI), so anything
 * reading `navigator.userAgent` — the ⌘ vs Ctrl matrix, the Chrome-only context-menu suppression —
 * used to behave differently on the maintainer's Mac and on the build machines. Pinned, exactly like
 * the clock would be: the platform is an INPUT of these tests, never an accident of where they run.
 */
const MAC_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)";

function setupFixture(initOverrides: Record<string, unknown> = {}, savedState: Record<string, unknown> = {}): void {
  posted.length = 0;
  detachGlobalListeners();
  // THE PLATFORM IS PINNED, and for a real reason.
  //
  // This used to `delete navigator.userAgent`, which is a NO-OP: `userAgent` is a getter on the
  // prototype, so the deletion left jsdom's own value in place — and that value mirrors the HOST OS
  // (`darwin` here, `linux`/`win32` on CI). Every test that depends on the ⌘/Ctrl matrix was
  // therefore green on a Mac and red on Ubuntu and Windows, silently, while the non-macOS branch of
  // `isMacPlatform()` was never exercised at all.
  //
  // So it is set explicitly: a test that wants another platform stubs it with `setUa(...)` (see the
  // platform tests), and the rest run on ONE known OS wherever the suite happens to run.
  Object.defineProperty(window.navigator, "userAgent", { value: MAC_USER_AGENT, configurable: true });
  setupDom(initOverrides, savedState);
}

async function loadView(): Promise<void> {
  detachGlobalListeners();
  vi.resetModules();
  // The module calls `acquireVsCodeApi()` at import time: `setupDom` installs it, and this guard
  // keeps a direct `loadView()` honest even before the fixture has run.
  if (typeof (globalThis as Record<string, unknown>).acquireVsCodeApi !== "function") {
    (globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
      postMessage: (m: unknown) => posted.push(m),
      getState: () => persistedState,
      setState: (state: unknown) => {
        persistedState = state as Record<string, unknown>;
      },
    });
  }
  const targets: (Window | Document)[] = [window, document];
  const realAdd = targets.map((t) => t.addEventListener);
  try {
    targets.forEach((target, i) => {
      // Record, then register normally: the NEXT test detaches everything this
      // instance subscribed to on the shared globals.
      target.addEventListener = function (
        type: string,
        fn: EventListener,
        options?: AddEventListenerOptions | boolean,
      ) {
        globalListeners.push({ target, type, fn, options });
        return (realAdd[i] as typeof target.addEventListener).call(target, type, fn, options);
      } as typeof target.addEventListener;
    });
    await import("./view");
  } finally {
    targets.forEach((target, i) => {
      target.addEventListener = realAdd[i] as typeof target.addEventListener;
    });
  }
}

// ONE fixture for the whole file: every test starts from the same clean DOM, empty outbox and
// fresh module (see setupFixture). Nesting or ordering can no longer change the prerequisites.
beforeEach(() => {
  setupFixture();
});

describe("view webview client", () => {
  it("says 'ready' once the script has run, so the host knows its posts can land", async () => {
    // The host cannot infer this from `webview.html = …`: that only STARTS loading a document,
    // and anything posted before this line is DROPPED. Without this message the host has to
    // guess, and when it guesses wrong the page comes up with an empty transcript (see the
    // `resumeSession` regression in chat-view.test.ts).
    await loadView();
    const hellos = posted.filter((m: any) => m?.type === "ready");
    expect(hellos).toEqual([{ type: "ready" }]);
  });

  it("keeps failed providers visible in the model modal, and falls back to 'pick one' when the saved model is gone", async () => {
    await loadView();
    const btn = document.getElementById("model-btn") as HTMLButtonElement;
    const label = document.getElementById("model-btn-label") as HTMLElement;

    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "old-model",
        hasKey: true,
        hostModelErrors: [{ provider: "llamacpp", error: "HTTP 500" }],
        models: [],
        providerModels: [{ provider: "openai", model: "gpt-4o" }],
        contextWindow: 128000,
      },
    });
    // The saved model is gone: the button shows the placeholder.
    expect(label.textContent).toBe("Select a model");
    expect(btn.classList.contains("placeholder")).toBe(true);

    // Open the modal: the failed provider appears with its error.
    btn.click();
    const list = document.getElementById("model-list") as HTMLElement;
    expect(list.textContent).toContain("llamacpp");
    expect(list.textContent).toContain("HTTP 500");

    // Models available and reachable: the button shows the real model.
    hostMessage({
      type: "config",
      config: {
        provider: "openai-compatible",
        model: "qwen.gguf",
        hasKey: true,
        models: [],
        providerModels: [{ provider: "llamacpp", model: "qwen.gguf" }],
        contextWindow: 128000,
      },
    });
    expect(label.textContent).toContain("qwen.gguf");
    expect(btn.classList.contains("placeholder")).toBe(false);
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

  it("defaults to Analyze and switches Analyze / Agent / Multi Agent via the dropdown", async () => {
    await loadView();
    const btn = document.getElementById("mode-btn") as HTMLButtonElement;
    const label = document.getElementById("mode-btn-label") as HTMLSpanElement;
    const menu = document.getElementById("mode-menu") as HTMLDivElement;
    const analyze = document.querySelector('.mode-item[data-mode="analyze"]') as HTMLButtonElement;
    const agent = document.querySelector('.mode-item[data-mode="agent"]') as HTMLButtonElement;
    // Default: Analyze shown, dropdown closed, no accent.
    expect(label.textContent).toBe("Analyze");
    expect(btn.classList.contains("is-agent")).toBe(false);
    expect(menu.classList.contains("hidden")).toBe(true);
    expect(analyze.getAttribute("aria-selected")).toBe("true");

    // Pick Agent (violet).
    btn.click();
    agent.click();
    expect(posted).toContainEqual({ type: "setMode", mode: "agent" });
    expect(label.textContent).toBe("Build");
    expect(btn.classList.contains("is-agent")).toBe(true);
    expect(agent.getAttribute("aria-selected")).toBe("true");
    expect(menu.classList.contains("hidden")).toBe(true);

    // Back to Analyze.
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
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
    });
    expect(label.textContent).toBe("Analyze");

    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        mode: "agent",
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
    });
    expect(label.textContent).toBe("Build");
    expect(btn.classList.contains("is-agent")).toBe(true);
    expect(agent.classList.contains("is-active")).toBe(true);
  });

  it("Restricted Mode (untrusted folder): Build is DISABLED and Analyze is shown, whatever the host sends", async () => {
    // The host already resolves the mode (ChatViewProvider.effectiveMode) and sends the effective
    // one; this is the second half of the same promise — the panel must not OFFER a choice the
    // host will refuse, and must not paint "Build" over a read-only run if a stale "agent" ever
    // arrives (a push from another window, a reload mid-grant).
    await loadView();
    const label = document.getElementById("mode-btn-label") as HTMLSpanElement;
    const btn = document.getElementById("mode-btn") as HTMLButtonElement;
    const agent = document.querySelector('.mode-item[data-mode="agent"]') as HTMLButtonElement;
    const analyze = document.querySelector('.mode-item[data-mode="analyze"]') as HTMLButtonElement;

    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        mode: "agent", // what the user asked for before the folder was opened untrusted
        workspaceTrusted: false,
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
    });

    expect(label.textContent).toBe("Analyze");
    expect(btn.classList.contains("is-agent")).toBe(false);
    expect(analyze.classList.contains("is-active")).toBe(true);
    // The choice says it is unavailable, with the reason in the place the choice is made…
    expect(agent.disabled).toBe(true);
    expect(agent.title).toContain("Restricted Mode");
    expect(agent.title).toContain("Trust the folder");
    // …and a click can neither switch nor post (a disabled button fires nothing).
    agent.click();
    expect(posted.some((m: any) => m.type === "setMode")).toBe(false);
    // The pill carries the same reason for whoever never opens the menu.
    expect(btn.title).toContain("Restricted Mode");
  });

  it("…and a TRUSTED folder re-enables Build on the same surface (no reload needed)", async () => {
    await loadView();
    const label = document.getElementById("mode-btn-label") as HTMLSpanElement;
    const agent = document.querySelector('.mode-item[data-mode="agent"]') as HTMLButtonElement;
    const config = {
      provider: "openai",
      model: "gpt-4o",
      hasKey: true,
      models: [],
      providerModels: [],
      contextWindow: 128000,
    };
    hostMessage({ type: "config", config: { ...config, workspaceTrusted: false } });
    expect(agent.disabled).toBe(true);
    // Trust granted (extension.ts rebuilds the panel; the config arrives with the verdict).
    hostMessage({ type: "config", config: { ...config, workspaceTrusted: true, mode: "agent" } });
    expect(agent.disabled).toBe(false);
    expect(agent.hasAttribute("title")).toBe(false);
    expect(label.textContent).toBe("Build");
    // The menu is LIVE again: both halves post, so nothing was left inert by the gate.
    (document.querySelector('.mode-item[data-mode="analyze"]') as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "setMode", mode: "analyze" });
    agent.click();
    expect(posted).toContainEqual({ type: "setMode", mode: "agent" });
  });

  it("Parallel: off by default, turns blue on click and posts setParallel", async () => {
    await loadView();
    const btn = document.getElementById("parallel-btn") as HTMLButtonElement;
    expect(btn.classList.contains("is-on")).toBe(false);
    expect(btn.getAttribute("aria-pressed")).toBe("false");

    btn.click();
    expect(posted).toContainEqual({ type: "setParallel", parallel: true });
    expect(btn.classList.contains("is-on")).toBe(true);
    expect(btn.getAttribute("aria-pressed")).toBe("true");

    btn.click();
    expect(posted).toContainEqual({ type: "setParallel", parallel: false });
    expect(btn.classList.contains("is-on")).toBe(false);
    expect(btn.getAttribute("aria-pressed")).toBe("false");
  });

  it("Parallel follows the host config and is LOCKED while working (never a silent lock)", async () => {
    await loadView();
    const btn = document.getElementById("parallel-btn") as HTMLButtonElement;
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        parallel: true,
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
    });
    expect(btn.classList.contains("is-on")).toBe(true);

    // A run is in flight: the toggle is disabled — a run keeps the policy it was born with
    // (see Agent.runMode) — and the tooltip says which one, plus what Stop does instead.
    hostMessage({ type: "status", active: true });
    const before = posted.length;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toContain("locked to this run");
    expect(btn.title).toContain("Parallel ON");
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); // the guard refuses it
    expect(posted.slice(before).some((m) => (m as { type?: string }).type === "setParallel")).toBe(false);
    expect(btn.classList.contains("is-on")).toBe(true);

    // The run ends: usable again, and no stale tooltip left behind.
    hostMessage({ type: "status", active: false });
    expect(btn.disabled).toBe(false);
    expect(btn.title).toBe("");
    btn.click();
    expect(posted.slice(before)).toContainEqual({ type: "setParallel", parallel: false });
  });

  it("locks the mode button while working — with a tooltip, not a silent lock", async () => {
    // The reported bug was a lock with NO feedback: the click died in silence and the panel
    // went on showing what the user had picked. The lock stays — a run keeps the mode it was
    // born with — but it now explains itself and names the way out (Stop).
    await loadView();
    const btn = document.getElementById("mode-btn") as HTMLButtonElement;
    const menu = document.getElementById("mode-menu") as HTMLDivElement;
    const postedAt = posted.length;

    // A dropdown left OPEN when the run starts is closed by the lock: the label on screen
    // must never be the one that was already sent.
    btn.click();
    expect(menu.classList.contains("hidden")).toBe(false);
    hostMessage({ type: "status", active: true });
    expect(menu.classList.contains("hidden")).toBe(true);

    expect(btn.disabled).toBe(true);
    expect(btn.title).toContain("locked to this run");
    expect(btn.title).toContain("Analyze");
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); // the guard refuses it
    expect(menu.classList.contains("hidden")).toBe(true); // and the dropdown never opens
    expect(posted.slice(postedAt).some((m) => (m as { type?: string }).type === "setMode")).toBe(false);

    hostMessage({ type: "status", active: false });
    expect(btn.disabled).toBe(false);
    expect(btn.title).toBe("");
    btn.click();
    expect(menu.classList.contains("hidden")).toBe(false);
    (menu.querySelector('.mode-item[data-mode="agent"]') as HTMLButtonElement).click();
    expect(posted.slice(postedAt)).toContainEqual({ type: "setMode", mode: "agent" });
  });

  it("a policy changed UNDER the panel while it works is marked as PENDING", async () => {
    // The pills are disabled, so this cannot come from a click here — but the host can push a
    // config (another window, a restored session). The choice is real and pending: the run
    // keeps what it was born with, and the pill says both.
    await loadView();
    const btn = document.getElementById("mode-btn") as HTMLButtonElement;
    hostMessage({ type: "status", active: true }); // the run's mode: Analyze
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        mode: "agent",
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
    });

    expect(btn.classList.contains("is-pending")).toBe(true);
    expect(btn.textContent).toContain("Build");
    expect(btn.title).toContain("still Analyze");
    expect(btn.disabled).toBe(true); // the lock covers a pending choice too
  });

  it("reflects the host's mode + Parallel on load and does NOT reset them", async () => {
    // The view is recreated on hide/show: it must show the HOST state, never
    // force it back to defaults (that desynced the toggle from the agent).
    setupDom({
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        mode: "agent",
        parallel: true,
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
    });
    await loadView();
    expect(posted).not.toContainEqual({ type: "setMode", mode: "analyze" });
    expect(posted).not.toContainEqual({ type: "setParallel", parallel: false });
    expect(document.getElementById("mode-btn-label")?.textContent).toBe("Build");
    expect(document.getElementById("parallel-btn")?.classList.contains("is-on")).toBe(true);
  });

  it("renders the thinking level radios per provider capability", async () => {
    await loadView();
    const off = document.getElementById("thinking-off") as HTMLInputElement;
    // No thinkingMode declared → disabled, falls back to Off.
    expect(off.disabled).toBe(true);
    expect(off.checked).toBe(true);

    hostMessage({
      type: "config",
      config: {
        provider: "openai-compatible",
        model: "qwen.gguf",
        hasKey: true,
        thinkingMode: "bool",
        thinkingLevel: "high",
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
    });
    expect(off.disabled).toBe(false);
    expect((document.getElementById("thinking-high") as HTMLInputElement).checked).toBe(true);

    posted.length = 0;
    const low = document.getElementById("thinking-low") as HTMLInputElement;
    low.checked = true;
    low.dispatchEvent(new Event("change"));
    expect(posted).toContainEqual({ type: "setThinkingLevel", level: "low" });

    // effort-style providers also enable the radios
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-5",
        hasKey: true,
        thinkingMode: "effort",
        thinkingLevel: "medium",
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
    });
    expect(off.disabled).toBe(false);
    expect((document.getElementById("thinking-medium") as HTMLInputElement).checked).toBe(true);

    // DeepSeek/Anthropic toggle (OpenCode Go) also enables them
    hostMessage({
      type: "config",
      config: {
        provider: "openai-compatible",
        model: "deepseek-v4.1-flash",
        hasKey: true,
        thinkingMode: "type",
        thinkingLevel: "high",
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
    });
    expect(off.disabled).toBe(false);
    expect((document.getElementById("thinking-high") as HTMLInputElement).checked).toBe(true);
  });

  it("renders sessions, tabs and the active chat", async () => {
    await loadView();
    expect(document.querySelectorAll(".srow").length).toBe(2);
    expect(document.querySelectorAll(".tab").length).toBe(2);
    expect(document.querySelector(".msg.user")?.textContent).toBe("hello");
  });

  it("dragging a tab left or right reorders the strip and tells the host", async () => {
    await loadView();
    const order = () => [...document.querySelectorAll<HTMLElement>("#tabs .tab")].map((t) => t.dataset.id);
    expect(order()).toEqual(["a", "b"]);

    // jsdom has no layout, so every tab measures 0: a pointer past all midpoints
    // means "past the last tab" — the dragged one lands at the end.
    const first = document.querySelector<HTMLElement>('.tab[data-id="a"]')!;
    first.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10 }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 120 }));
    window.dispatchEvent(new MouseEvent("pointerup"));

    expect(order()).toEqual(["b", "a"]);
    expect(posted).toContainEqual({ type: "reorderTabs", ids: ["b", "a"] });
  });

  it("while dragging, the tab lifts into a ghost and a slot shows where it lands", async () => {
    await loadView();
    // The strip as the user reads it: the ghost is the tab in flight, so it is not
    // part of "the order"; the SLOT is the hole it left.
    const slots = () =>
      [...document.querySelectorAll<HTMLElement>("#tabs > *")]
        .filter((el) => !el.classList.contains("dragging"))
        .map((el) => (el.classList.contains("tab-placeholder") ? "SLOT" : (el.dataset.id as string)));
    expect(slots()).toEqual(["a", "b"]);

    const first = document.querySelector<HTMLElement>('.tab[data-id="a"]')!;
    first.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10 }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 120 }));

    // The tab is HELD: out of the flow, positioned at the pointer, and the strip now
    // shows the gap at the END — where it will drop.
    expect(first.classList.contains("dragging")).toBe(true);
    expect(first.style.left).not.toBe("");
    expect(slots()).toEqual(["b", "SLOT"]);

    // Dropped: the slot is gone and the tab sits exactly where it was drawn.
    window.dispatchEvent(new MouseEvent("pointerup"));
    expect(document.querySelector(".tab-placeholder")).toBeNull();
    expect(first.classList.contains("dragging")).toBe(false);
    expect(first.style.left).toBe("");
    expect(slots()).toEqual(["b", "a"]);
  });

  it("cancelling a drag snaps the strip back and posts nothing", async () => {
    await loadView();
    const first = document.querySelector<HTMLElement>('.tab[data-id="a"]')!;
    first.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10 }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 120 }));
    window.dispatchEvent(new MouseEvent("pointercancel"));

    expect(document.querySelector(".tab-placeholder")).toBeNull();
    expect([...document.querySelectorAll<HTMLElement>("#tabs .tab")].map((t) => t.dataset.id)).toEqual(["a", "b"]);
    expect(posted.some((m: any) => m?.type === "reorderTabs")).toBe(false);
  });

  it("a tab dropped where it already was posts nothing, and the trailing click does not switch", async () => {
    await loadView();
    const second = document.querySelector<HTMLElement>('.tab[data-id="b"]')!;
    second.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10 }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 120 }));
    window.dispatchEvent(new MouseEvent("pointerup"));

    // Already the last tab: nothing to report.
    expect(posted.some((m: any) => m?.type === "reorderTabs")).toBe(false);
    // The click the browser fires after a drag must NOT switch session.
    second.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(posted.some((m: any) => m?.type === "switchTab")).toBe(false);
  });

  it("clicking another tab veils the transcript until the new state arrives", async () => {
    await loadView();
    const veil = () => document.getElementById("switch-veil") as HTMLElement;
    const label = () => veil().querySelector(".switch-label")?.textContent;
    expect(veil().classList.contains("visible")).toBe(false);

    (document.querySelector('.tab[data-id="b"]') as HTMLElement).click();

    // Up immediately, named from the list the view ALREADY has (no round-trip on the
    // very click we are trying to make feel fast).
    expect(veil().classList.contains("visible")).toBe(true);
    expect(label()).toBe("Opening “Debug”…");
    expect(posted).toContainEqual({ type: "switchTab", id: "b" });

    hostMessage({
      type: "switchView",
      activeId: "b",
      openIds: ["a", "b"],
      messages: [],
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
    });
    // The state is on screen: the veil has nothing left to announce.
    expect(veil().classList.contains("visible")).toBe(false);
  });

  it("a host-initiated switch veils too, and an unlisted session falls back to a generic label", async () => {
    await loadView();
    const veil = () => document.getElementById("switch-veil") as HTMLElement;
    const label = () => veil().querySelector(".switch-label")?.textContent;

    hostMessage({ type: "switching", id: "b" });
    expect(veil().classList.contains("visible")).toBe(true);
    expect(label()).toBe("Opening “Debug”…");

    // A session the strip has never listed (opened from the manager, a branch…).
    hostMessage({ type: "switching", id: "zzz" });
    expect(label()).toBe("Opening session…");
  });

  it("a switch that never completes takes the veil down on its own", async () => {
    await loadView();
    const veil = () => document.getElementById("switch-veil") as HTMLElement;
    vi.useFakeTimers();
    try {
      (document.querySelector('.tab[data-id="b"]') as HTMLElement).click();
      expect(veil().classList.contains("visible")).toBe(true);
      // No switchView ever arrives: the safety net must not leave a spinner forever.
      vi.advanceTimersByTime(8000);
      expect(veil().classList.contains("visible")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a plain tab switch keeps the LIST and the tab NAMES (an omitted list means unchanged)", async () => {
    // The host re-sends the session list only when it really changes (create, rename,
    // branch, delete, open-from-a-row); on a tab click it posts `sessions: undefined`,
    // meaning "keep what you have". Coercing that omission to `[]` — which is TRUTHY —
    // emptied the list on EVERY click, and with no id left to look up, every tab fell
    // back to the generic "Session" label. One coercion, two very visible symptoms.
    await loadView();
    expect(document.querySelectorAll(".srow").length).toBe(2);

    // NO `sessions` key at all: exactly the payload a tab click produces.
    hostMessage({
      type: "switchView",
      activeId: "b",
      openIds: ["a", "b"],
      messages: [],
      config: {},
      workingIds: [],
      switchSeq: 2,
    });

    expect(document.querySelectorAll(".srow").length).toBe(2);
    const nameOf = (id: string) => document.querySelector(`.tab[data-id="${id}"] span:first-child`)?.textContent;
    expect(nameOf("a")).toBe("Refactor");
    expect(nameOf("b")).toBe("Debug");
  });

  it("wraps the user text in a left-aligned shrink-to-fit block (centered by the bubble)", async () => {
    await loadView();
    const bubble = document.querySelector(".msg.user") as HTMLElement;
    const text = bubble.querySelector(".user-text") as HTMLElement;
    expect(text).toBeTruthy();
    expect(text.textContent).toBe("hello");
    // The text block is the FIRST child of the bubble (attachments follow it).
    expect(bubble.firstElementChild).toBe(text);
  });

  it("shows a user bubble with attachments as one LEFT-aligned block", async () => {
    await loadView();
    // The same path a delivered queue/steer message takes.
    hostMessage({
      type: "userMessage",
      content: "look at this",
      attachments: [{ name: "shot.png", size: 10, isImage: true, dataUri: "data:image/png;base64,AAAA" }],
    });
    const bubble = document.querySelectorAll(".msg.user")[1] as HTMLElement;
    // The text is still the shrink-to-fit span (its own contract)…
    expect(bubble.querySelector(":scope > .user-text")?.textContent).toBe("look at this");
    // …but the bubble now says it is wide for a reason of its own, which is what makes the
    // CSS give the text the full width instead of letting it float in the middle.
    expect(bubble.classList.contains("has-attachments")).toBe(true);
    expect(bubble.querySelector(".msg-attachments")).not.toBeNull();
    // A bubble with no attachments keeps the centred shrink-to-fit behaviour.
    const plain = document.querySelectorAll(".msg.user")[0] as HTMLElement;
    expect(plain.classList.contains("has-attachments")).toBe(false);
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

  it("refreshes a row's dates IN PLACE when the host reports activity (sessionMeta)", async () => {
    await loadView();
    const row = document.querySelector(`.srow[data-id="a"]`) as HTMLElement;
    const meta = row.querySelector(".smeta") as HTMLElement;
    const before = meta.textContent;

    hostMessage({ type: "sessionMeta", meta: [{ id: "a", createdAt: 1, updatedAt: 1_700_000_000_000 }] });

    // Patched, not rebuilt: the very same element, so the action buttons under the
    // pointer (and the whole listing) are not thrown away mid-turn.
    expect(document.querySelector(`.srow[data-id="a"] .smeta`)).toBe(meta);
    expect(meta.textContent).not.toBe(before);
    expect(meta.textContent).toContain("created ");
    expect(meta.textContent).toContain("· updated ");
    // The tooltip carries the FULL date/time, so it has to move with the text.
    expect(meta.title).toContain(new Date(1_700_000_000_000).toLocaleString());
  });

  it("patches ONLY the main list: the All-sessions form is left alone (it reads the store on open)", async () => {
    await loadView();
    // Open the form the way the user does, so it holds its own rows.
    hostMessage({
      type: "sessionsManager",
      show: true,
      sessions: [{ id: "a", name: "A", createdAt: 1, updatedAt: 2, messageCount: 1 }],
    });
    const inForm = document.querySelector('.sm-row[data-id="a"] .sm-meta') as HTMLElement | null;
    expect(inForm).not.toBeNull();
    const before = inForm!.textContent;

    hostMessage({ type: "sessionMeta", meta: [{ id: "a", createdAt: 1, updatedAt: 1_700_000_000_000 }] });

    // The list follows live; the form keeps what it read when it opened (by design).
    expect((document.querySelector(`.srow[data-id="a"] .smeta`) as HTMLElement).textContent).toContain("· updated ");
    expect((document.querySelector('.sm-row[data-id="a"] .sm-meta') as HTMLElement).textContent).toBe(before);
  });

  it("ignores a patch for a session this list does not know (no crash, nothing touched)", async () => {
    await loadView();
    const row = document.querySelector(`.srow[data-id="a"] .smeta`) as HTMLElement;
    const before = row.textContent;

    // Another folder's session can commit while you look at this one: its id is real but
    // it has no row here.
    expect(() =>
      hostMessage({ type: "sessionMeta", meta: [{ id: "elsewhere", createdAt: 1, updatedAt: 9 }] }),
    ).not.toThrow();
    expect(row.textContent).toBe(before);
  });

  it("keeps the patched dates in the list's memory (a later re-render shows them)", async () => {
    await loadView();
    hostMessage({ type: "sessionMeta", meta: [{ id: "a", createdAt: 1, updatedAt: 1_700_000_000_000 }] });
    const patched = (document.querySelector(`.srow[data-id="a"] .smeta`) as HTMLElement).textContent;

    // Clearing the session search re-renders the list from its in-memory copy: the
    // patched date must survive, or the next keystroke would resurrect the old one.
    const search = document.getElementById("session-search") as HTMLInputElement;
    search.value = "";
    search.dispatchEvent(new Event("input"));

    expect((document.querySelector(`.srow[data-id="a"] .smeta`) as HTMLElement).textContent).toBe(patched);
  });

  /** Row ids in the order they are DRAWN (the list's visible order). */
  const rowIds = () => [...document.querySelectorAll("#sessions .srow")].map((r) => (r as HTMLElement).dataset.id);

  it("asks the host for the list when the section is OPENED (the order is re-evaluated on open)", async () => {
    // The dates follow live, the RANK does not (that is the point of patching instead of
    // re-rendering), so the order on screen is only as fresh as the last list the host
    // sent. Opening the section asks for it again: one SELECT *, no transcript rebuild.
    await loadView();
    const head = document.getElementById("session-head") as HTMLElement;
    posted.length = 0;

    head.click(); // collapse: nothing to re-evaluate, no round trip
    expect(posted).not.toContainEqual({ type: "refreshSessions" });

    head.click(); // open: re-read
    expect(posted).toContainEqual({ type: "refreshSessions" });
  });

  it("draws the fresh order the host sends back, and only the list", async () => {
    await loadView();
    expect(rowIds()).toEqual(["a", "b"]); // as the host ranked them
    const transcript = (document.getElementById("messages") as HTMLElement).innerHTML;

    // The host re-read the store on open and `b` is now the most recently touched.
    hostMessage({
      type: "sessions",
      sessions: [
        { id: "b", name: "Debug", createdAt: 2, updatedAt: 1_700_000_000_000, messageCount: 1 },
        { id: "a", name: "Refactor", createdAt: 1, updatedAt: 2, messageCount: 3 },
      ],
    });

    expect(rowIds()).toEqual(["b", "a"]);
    // A list refresh is NOT a switchView: the transcript is left alone.
    expect((document.getElementById("messages") as HTMLElement).innerHTML).toBe(transcript);
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

  it("disables the thinking radios while working (and on config pushes) but keeps sessions/tabs usable", async () => {
    await loadView();
    const off = document.getElementById("thinking-off") as HTMLInputElement;
    hostMessage({
      type: "config",
      config: {
        provider: "openai-compatible",
        model: "x",
        hasKey: true,
        thinkingMode: "bool",
        thinkingLevel: "high",
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
    });
    expect(off.disabled).toBe(false);

    hostMessage({ type: "status", active: true });
    expect(off.disabled).toBe(true);
    // sessions list / tabs / new-session stay usable during work
    expect((document.getElementById("new-session") as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelectorAll(".tab").length).toBeGreaterThan(0);
    // a config push mid-stream must NOT re-enable them
    hostMessage({
      type: "config",
      config: {
        provider: "openai-compatible",
        model: "x",
        hasKey: true,
        thinkingMode: "bool",
        thinkingLevel: "medium",
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
    });
    expect(off.disabled).toBe(true);

    hostMessage({ type: "status", active: false });
    expect(off.disabled).toBe(false);
  });

  it("locks all interaction controls while the LLM works and unlocks after", async () => {
    await loadView();
    hostMessage({ type: "status", active: true });
    // The prompt + send + attach STAY usable while working: Enter queues,
    // Ctrl/Cmd+Enter steers, attachments ride along with a pending message.
    expect((document.getElementById("send-btn") as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById("attach-btn") as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById("abort-btn") as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById("compact-btn") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("compact-settings-btn") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("model-btn") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("ctx-range") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("out-range") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("samp-range") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("samp-auto") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("sampler-temp") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("sampler-topp") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("presence-range") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("presence-auto") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("freq-range") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("freq-auto") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("user-input") as HTMLTextAreaElement).disabled).toBe(false);
    hostMessage({ type: "status", active: false });
    expect((document.getElementById("compact-btn") as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById("compact-settings-btn") as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById("model-btn") as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById("ctx-range") as HTMLInputElement).disabled).toBe(false);
    expect((document.getElementById("out-range") as HTMLInputElement).disabled).toBe(false);
    expect((document.getElementById("samp-range") as HTMLInputElement).disabled).toBe(false);
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

  it("pastes a clipboard image as an attachment and sends its data URI", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    const file = new File([new Uint8Array([1, 2, 3, 4])], "shot.png", { type: "image/png" });
    const ev = new Event("paste", { cancelable: true }) as unknown as ClipboardEvent & { clipboardData: unknown };
    (ev as unknown as { clipboardData: unknown }).clipboardData = {
      items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
    };
    input.dispatchEvent(ev);

    const chips = document.getElementById("attachment-chips") as HTMLDivElement;
    // FileReader is async: WAIT for the chip (a fixed delay is flaky on slow CI).
    await vi.waitFor(() => expect(chips.querySelectorAll(".attach-chip").length).toBe(1));
    expect(chips.querySelector(".attach-name")?.textContent).toBe("Image from clipboard");
    // The pasted image shows a preview thumbnail (its inline data URI).
    const thumb = chips.querySelector(".attach-thumb") as HTMLImageElement;
    expect(thumb).toBeTruthy();
    expect(thumb.src).toContain("data:image/png");

    // Sending carries the inline data URI (no path on disk).
    input.value = "look at this";
    posted.length = 0;
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    const sendMsg = posted.find((m) => (m as { type?: string }).type === "send") as Record<string, unknown>;
    const atts = sendMsg.attachments as Array<Record<string, unknown>>;
    expect(atts).toHaveLength(1);
    expect(String(atts[0].dataUri)).toContain("data:image/png");
    expect(atts[0].path).toBe("");
  });

  it("pastes a text file from the clipboard as an inline text attachment", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    const file = new File(["# hello"], "notes.md", { type: "text/markdown" });
    const ev = new Event("paste", { cancelable: true }) as unknown as ClipboardEvent & { clipboardData: unknown };
    (ev as unknown as { clipboardData: unknown }).clipboardData = {
      items: [{ kind: "file", type: "text/markdown", getAsFile: () => file }],
    };
    input.dispatchEvent(ev);
    const chips = document.getElementById("attachment-chips") as HTMLDivElement;
    await vi.waitFor(() => expect(chips.querySelectorAll(".attach-chip").length).toBe(1));

    input.value = "summarize";
    posted.length = 0;
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    const sendMsg = posted.find((m) => (m as { type?: string }).type === "send") as Record<string, unknown>;
    const atts = sendMsg.attachments as Array<Record<string, unknown>>;
    expect(atts[0].content).toContain("# hello");
  });

  it("names a second clipboard image 'Image from clipboard 2'", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    const paste = (): void => {
      const file = new File([new Uint8Array([1])], "x.png", { type: "image/png" });
      const ev = new Event("paste", { cancelable: true }) as unknown as ClipboardEvent & { clipboardData: unknown };
      (ev as unknown as { clipboardData: unknown }).clipboardData = {
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
      };
      input.dispatchEvent(ev);
    };
    paste();
    await vi.waitFor(() => expect(document.querySelectorAll(".attach-name").length).toBe(1));
    paste();
    await vi.waitFor(() => expect(document.querySelectorAll(".attach-name").length).toBe(2));
    const names = [...document.querySelectorAll(".attach-name")].map((e) => e.textContent);
    expect(names).toEqual(["Image from clipboard", "Image from clipboard 2"]);
  });

  it("attaches a file dropped onto the panel", async () => {
    await loadView();
    const file = new File([new Uint8Array([1, 2, 3])], "dropped.png", { type: "image/png" });
    const ev = new Event("drop", { cancelable: true }) as unknown as DragEvent & { dataTransfer: unknown };
    (ev as unknown as { dataTransfer: unknown }).dataTransfer = { files: [file], getData: () => "" };
    document.body.dispatchEvent(ev);
    await vi.waitFor(() => expect(document.querySelector(".attach-chip")).toBeTruthy());
    const chip = document.querySelector(".attach-chip") as HTMLElement;
    expect(chip).toBeTruthy();
    expect(chip.querySelector(".attach-name")?.textContent).toBe("dropped.png");
  });

  it("attaches a path dropped as text/uri-list", async () => {
    await loadView();
    const ev = new Event("drop", { cancelable: true }) as unknown as DragEvent & { dataTransfer: unknown };
    (ev as unknown as { dataTransfer: unknown }).dataTransfer = {
      files: [],
      getData: (t: string) => (t === "text/uri-list" ? "file:///Users/x/report.pdf" : ""),
    };
    posted.length = 0;
    document.body.dispatchEvent(ev);
    expect(posted).toContainEqual({ type: "attachPath", path: "file:///Users/x/report.pdf" });
  });

  it("opens a full-size lightbox when a thumbnail is clicked", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    const file = new File([new Uint8Array([1, 2, 3, 4])], "shot.png", { type: "image/png" });
    const ev = new Event("paste", { cancelable: true }) as unknown as ClipboardEvent & { clipboardData: unknown };
    (ev as unknown as { clipboardData: unknown }).clipboardData = {
      items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
    };
    input.dispatchEvent(ev);
    await vi.waitFor(() => expect(document.querySelector(".attach-thumb")).toBeTruthy());

    (document.querySelector(".attach-thumb") as HTMLImageElement).click();
    const lightbox = document.querySelector(".img-lightbox") as HTMLElement;
    expect(lightbox).toBeTruthy();
    expect(lightbox.classList.contains("hidden")).toBe(false);
    expect((lightbox.querySelector("img") as HTMLImageElement).src).toContain("data:image/png");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(lightbox.classList.contains("hidden")).toBe(true);
  });

  it("Esc stops the run while working (the textarea is disabled)", async () => {
    await loadView();
    hostMessage({ type: "status", active: true, workingIds: [] });
    posted.length = 0;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(posted).toContainEqual({ type: "abort" });
  });

  it("Esc does NOT abort when idle, nor when an overlay is open", async () => {
    await loadView();
    // Idle: the Stop button is disabled → Esc is inert.
    posted.length = 0;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(posted).not.toContainEqual({ type: "abort" });

    // Working (Stop enabled) BUT an alert modal is open: Esc closes the modal,
    // it must not abort the run.
    hostMessage({ type: "status", active: true, workingIds: [] });
    hostMessage({ type: "modal", modalId: 7, kind: "alert", alertKind: "info", title: "t", message: "m" });
    posted.length = 0;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(posted).not.toContainEqual({ type: "abort" });
  });

  it("Esc in the PROMPT does not abort while an overlay is open (textarea handler)", async () => {
    await loadView();
    hostMessage({ type: "status", active: true, workingIds: [] });
    hostMessage({ type: "modal", modalId: 9, kind: "alert", alertKind: "info", title: "t", message: "m" });
    posted.length = 0;
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    // The textarea's own Escape handler must defer to the overlay.
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(posted).not.toContainEqual({ type: "abort" });
    // The LIFO dispatcher closed the alert (response posted with its id).
    expect(
      posted.some(
        (m) => (m as { type?: string; id?: number }).type === "modalResponse" && (m as { id?: number }).id === 9,
      ),
    ).toBe(true);
  });

  it("attaches a pasted absolute path via the host", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    const ev = new Event("paste", { cancelable: true }) as unknown as ClipboardEvent & { clipboardData: unknown };
    (ev as unknown as { clipboardData: unknown }).clipboardData = {
      items: [],
      getData: (t: string) => (t === "text/plain" ? "/Users/x/report.pdf" : ""),
    };
    input.dispatchEvent(ev);
    expect(posted).toContainEqual({ type: "attachPath", path: "/Users/x/report.pdf" });
  });

  it("ignores a plain-text paste (keeps default behaviour)", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    const ev = new Event("paste", { cancelable: true }) as unknown as ClipboardEvent & { clipboardData: unknown };
    (ev as unknown as { clipboardData: unknown }).clipboardData = {
      items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
    };
    input.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 10));
    expect(document.querySelectorAll(".attach-chip").length).toBe(0);
  });

  it("keeps the attach button enabled while working (attachments on pending)", async () => {
    await loadView();
    const btn = document.getElementById("attach-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    hostMessage({ type: "status", active: true });
    expect(btn.disabled).toBe(false);
    hostMessage({ type: "done" });
    expect(btn.disabled).toBe(false);
  });

  it("drops pending attachments when switching to another session", async () => {
    await loadView(); // activeId "a"
    hostMessage({ type: "attachments", files: [{ name: "a.txt", path: "/a", size: 1, isImage: false }] });
    const chips = document.getElementById("attachment-chips") as HTMLDivElement;
    expect(chips.classList.contains("hidden")).toBe(false);

    hostMessage({
      type: "switchView",
      activeId: "b",
      sessions: [],
      openIds: ["a", "b"],
      messages: [],
      config: {},
      workingIds: [],
    });
    expect(chips.classList.contains("hidden")).toBe(true);
  });

  it("keeps the prompt AND its attachments PER SESSION (switch away and back)", async () => {
    // What you typed/picked belongs to the session, not to the panel: switching tab
    // must not throw it away (it used to drop the chips and keep the text — the
    // worst of both).
    await loadView(); // activeId "a"
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    const chips = document.getElementById("attachment-chips") as HTMLDivElement;
    hostMessage({ type: "attachments", files: [{ name: "relazione.pdf", path: "/rel", size: 2048, isImage: false }] });
    input.value = "draft for A";

    // Away: A's composition is parked and the box is CLEAN for B.
    hostMessage({
      type: "switchView",
      activeId: "b",
      sessions: [],
      openIds: ["a", "b"],
      messages: [],
      config: {},
      workingIds: [],
    });
    expect(input.value).toBe("");
    expect(chips.classList.contains("hidden")).toBe(true);

    // Back: the text AND the chip are there again.
    hostMessage({
      type: "switchView",
      activeId: "a",
      sessions: [],
      openIds: ["a", "b"],
      messages: [],
      config: {},
      workingIds: [],
    });
    expect(input.value).toBe("draft for A");
    expect(chips.classList.contains("hidden")).toBe(false);
    expect(chips.textContent).toContain("relazione.pdf");
  });

  it("restores the typed prompt after a webview reload (text only)", async () => {
    setupDom({}, { drafts: { a: "resume from here" } });
    await loadView();
    expect((document.getElementById("user-input") as HTMLTextAreaElement).value).toBe("resume from here");
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
    expect(bubble.querySelector(".msg-attach-file-name")?.textContent).toContain("a.txt");
  });

  it("attachment-only bubble shows just the file chip, never the content", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [
        {
          role: "user",
          content: 'Attached file "a.txt":\n```\nSECRET\n```',
          displayText: "",
          attachments: [{ name: "a.txt", size: 2 }],
        },
      ],
    });
    const bubble = document.querySelector(".msg.user") as HTMLElement;
    expect(bubble.textContent).not.toContain("SECRET");
    expect(bubble.querySelector(".msg-attach-file-name")?.textContent).toBe("a.txt");
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

  it("finalizes the compaction bubble — or REMOVES it when nothing was compacted", async () => {
    await loadView();
    hostMessage({ type: "compactStart" });
    const working = [...document.querySelectorAll(".working")];
    expect(working.length).toBe(1);
    expect(working[0].textContent).toContain("Compacting");
    // The defensive path: a real compaction wipes this bubble with the rebuild that shows
    // the card, so finalizing it is only a fallback — but it must stay truthful.
    hostMessage({ type: "compactDone", ok: true });
    expect(document.querySelectorAll(".working").length).toBe(0);
    const block = document.querySelector(".thinking-block");
    expect(block).not.toBeNull();
    expect(block!.textContent).toContain("Conversation compacted");
    // quiet styling: NOT an assistant result bubble (blue/result reserved to output)
    const assistantText = document.querySelector(".msg.assistant")?.textContent ?? "";
    expect(assistantText).not.toContain("Conversation compacted");
  });

  it("REMOVES the provisional bubble when nothing was compacted", async () => {
    await loadView();
    hostMessage({ type: "compactStart" });
    expect(document.querySelectorAll(".working").length).toBe(1);
    hostMessage({ type: "compactDone", ok: false });
    // Gone, not spinning — and with no claim that anything was summarized.
    expect(document.querySelectorAll(".working").length).toBe(0);
    expect(document.querySelector(".thinking-block")).toBeNull();
    expect(document.querySelector(".compacted-hint")).toBeNull();
  });

  it("the compacting bubble joins the pulse cycle instead of restarting it", async () => {
    await loadView();
    hostMessage({ type: "compactStart" });
    const bubble = document.querySelector(".working") as HTMLElement;
    expect(bubble).toBeTruthy();
    // harny-pulse is a 1.2s cycle, but a CSS animation starts when its ELEMENT is created:
    // this bubble appears MID-RUN, so without a negative delay it beats on its own phase —
    // visibly out of sync with the Working bar and the play key (the reported defect).
    // phaseLockPulse() aligns it to the clock those already share.
    expect(bubble.style.animationDelay).toMatch(/^-\d+(\.\d+)?ms$/);
  });

  it("the Working bar re-joins the cycle when the run starts (it used to keep the old one)", async () => {
    await loadView();
    const now = vi.spyOn(performance, "now");
    try {
      // Five seconds after load. The bar is created a line BEFORE the clock is reset, so with
      // the stale clock it locks some way INTO the cycle, while every bubble born later locks
      // to the new one — the two beat out of phase, and everything else stays in sync.
      now.mockReturnValue(5_000);
      const prompt = document.getElementById("user-input") as HTMLTextAreaElement;
      prompt.value = "hello";
      prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      const bar = document.getElementById("working-bar") as HTMLElement;
      // send() -> addWorking() -> setStreaming(true) resets the clock and re-locks what is
      // already pulsing: the bar sits at the START of the cycle, with everything else.
      expect(Math.abs(parseFloat(bar.style.animationDelay))).toBe(0);
    } finally {
      now.mockRestore();
    }
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

  it("does not append '(empty response)' after an error bubble when done follows", async () => {
    await loadView();
    hostMessage({ type: "error", error: "Loop not resolved [empty] after 3 intervention(s)" });
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
        { role: "assistant", content: "done", timestamp: 3 },
      ],
    });
    const blocks = document.querySelectorAll(".thinking-block");
    expect(blocks.length).toBe(1);
    // Thinking starts COLLAPSED (the chevron pointing right) and expands on click.
    expect(blocks[0].querySelector(".thinking-body")?.classList.contains("collapsed")).toBe(true);
    expect(blocks[0].querySelector(".toggle")?.classList.contains("is-open") ?? false).toBe(false);
    // Historical blocks re-rendered from the transcript are NOT live: no
    // streaming pulse, so they never keep animating.
    expect(blocks[0].classList.contains("streaming")).toBe(false);
    (blocks[0].querySelector(".thinking-header") as HTMLElement).click();
    expect(blocks[0].querySelector(".thinking-body")?.classList.contains("collapsed")).toBe(false);
    expect(blocks[0].querySelector(".toggle")?.classList.contains("is-open") ?? false).toBe(true);
    // The final textual response is the last message.
    const last = (messagesElLastContent() || "").trim();
    expect(last).toBe("done");
  });

  it("pulses the live streaming bubble with the streaming class and stops it on done", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click(); // sets the working bar

    hostMessage({ type: "textDelta", content: "hel" });
    let bubble = document.querySelector(".msg.assistant.streaming");
    expect(bubble).toBeTruthy();
    // Phase-locked to the play button: the animation starts mid-cycle so it
    // beats WITH the run key, not offset from it.
    expect((bubble as HTMLElement).style.animationDelay).toMatch(/^-\d+(\.\d+)?ms$/);
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

  it("drops a text chunk that arrives with no running turn (nothing to paint into)", async () => {
    // A chunk can land AFTER the working bar is gone: the turn was stopped or finished and a
    // delta was already in flight. `ensureResult()` then has nothing to attach a bubble to,
    // and the chunk must be dropped — the alternative the mutation run kept alive is
    // `push(null, …)`, which paints into nothing.
    await loadView();
    hostMessage({ type: "textDelta", content: "late chunk" });
    expect(document.querySelectorAll(".msg.assistant")).toHaveLength(0);
    // …and the page still works afterwards: the next turn paints normally.
    (document.getElementById("user-input") as HTMLTextAreaElement).value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    hostMessage({ type: "textDelta", content: "real" });
    expect(document.querySelector(".msg.assistant")?.textContent).toContain("real");
  });

  it("keeps ONE answer bubble when the model reasons MID-answer (the reported split)", async () => {
    // Reported: a response began mid-word. The turn carried 10.9k characters of
    // reasoning, emitted after the first half of the sentence: the view closed the
    // bubble there and opened a new one for the rest, so the answer read as if it
    // had lost its beginning. Now the answer is ONE bubble and the reasoning is a
    // collapsible line just above it.
    await loadView();
    (document.getElementById("user-input") as HTMLTextAreaElement).value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();

    hostMessage({
      type: "textDelta",
      content: "I have everything to describe them without inventing anything. Writing the se",
    });
    hostMessage({ type: "thinkingDelta", content: "sto pensando a come dirlo meglio" });
    hostMessage({ type: "textDelta", content: "ction [Unreleased] — it covers the whole cycle." });
    await new Promise((r) => setTimeout(r, 40)); // let the throttled renderer paint

    const answers = [...document.querySelectorAll(".msg.assistant")];
    expect(answers).toHaveLength(1); // ONE answer, not two
    expect(answers[0].textContent).toContain(
      "I have everything to describe them without inventing anything. Writing the section [Unreleased] — it covers the whole cycle.",
    );
    // The reasoning is still there, one line above, collapsible.
    const marker = document.querySelector(".thinking-block") as HTMLElement;
    expect(marker).toBeTruthy();
    expect(marker.textContent).toContain("Thought during this answer");
    expect(marker.compareDocumentPosition(answers[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a host refusal takes back the optimistic paint and says why (the `denied` event)", async () => {
    // The panel paints the user bubble and "Working…" BEFORE the host answers, to feel instant.
    // A refusal must undo that paint: a message shown as sent that never left, plus a working
    // bar nothing will ever clear, is exactly the hang reported from the field.
    await loadView();
    (document.getElementById("user-input") as HTMLTextAreaElement).value = "ping";
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    const sent = (): boolean =>
      [...document.querySelectorAll("#messages .msg.user")].some((e) => (e.textContent ?? "").includes("ping"));
    expect(sent()).toBe(true); // painted before the host answered
    expect(document.getElementById("working-bar")?.classList.contains("hidden")).toBe(false);

    hostMessage({ type: "denied", action: "send", reason: "Harny cannot work here: no folder." });
    await new Promise((r) => setTimeout(r, 20));

    expect(sent()).toBe(false); // the bubble is gone
    expect(document.getElementById("working-bar")?.classList.contains("hidden")).toBe(true); // and so is the bar
    const note = document.querySelector("#messages .msg.assistant.error") as HTMLElement;
    expect(note.textContent).toContain("cannot work here"); // the reason, in the transcript
    expect(document.querySelectorAll("#messages .msg.assistant.error").length).toBe(1);
  });

  it('a reasoning chunk that is only punctuation opens NO section (the stray ".")', async () => {
    // Providers sometimes emit a lone "." as a separator. It is not a thought: the block must
    // not hold a line in the transcript that says nothing, and must not stay behind either.
    await loadView();
    (document.getElementById("user-input") as HTMLTextAreaElement).value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();

    hostMessage({ type: "textDelta", content: "Answer." });
    hostMessage({ type: "thinkingDelta", content: "." });
    await new Promise((r) => setTimeout(r, 40));

    // No section AT ALL: the block is not opened until the reasoning says something. (Hiding it
    // was the first attempt and it did not work: the sheet has no generic `.hidden` rule, only
    // per-id ones — so the class was a no-op and the dot stayed on screen.)
    expect(document.querySelector(".thinking-block")).toBeNull();

    // …and still nothing once the turn closes.
    hostMessage({ type: "done" });
    await new Promise((r) => setTimeout(r, 40));
    expect(document.querySelector(".thinking-block")).toBeNull();
  });

  it("…and the same block shows up as soon as it has something to say", async () => {
    await loadView();
    (document.getElementById("user-input") as HTMLTextAreaElement).value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();

    hostMessage({ type: "textDelta", content: "Answer." });
    hostMessage({ type: "thinkingDelta", content: "." });
    hostMessage({ type: "thinkingDelta", content: " Now I check the store." });
    await new Promise((r) => setTimeout(r, 40));

    const block = document.querySelector(".thinking-block") as HTMLElement;
    expect(block).not.toBeNull(); // opened as soon as there is something to read
    expect(block.className).not.toContain("hidden");
    expect(block.textContent).toContain("Now I check the store");
  });

  it("keeps the reasoning readable: expanding the mid-answer marker shows it", async () => {
    await loadView();
    (document.getElementById("user-input") as HTMLTextAreaElement).value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();

    hostMessage({ type: "textDelta", content: "first part" });
    hostMessage({ type: "thinkingDelta", content: "il ragionamento di mezzo" });
    await new Promise((r) => setTimeout(r, 40));

    const marker = document.querySelector(".thinking-block") as HTMLElement;
    const header = marker?.querySelector(".thinking-header") as HTMLElement;
    const body = marker?.querySelector(".thinking-body") as HTMLElement;
    expect(body.classList.contains("collapsed")).toBe(true); // quiet by default
    header.click();
    expect(body.classList.contains("collapsed")).toBe(false);
    expect(body.textContent).toContain("il ragionamento di mezzo");
  });

  it("a padding chunk does NOT split one reasoning into two blocks (the second continuing the first)", async () => {
    // The reported symptom: two collapsible blocks one after the other, the second
    // completing the sentence of the first. A whitespace-only chunk cannot open an answer
    // bubble (`!currentRawText.trim()` → break), so it must not be enough to SETTLE the
    // reasoning either: one thought, one block.
    await loadView();
    (document.getElementById("user-input") as HTMLTextAreaElement).value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();

    hostMessage({ type: "thinkingDelta", content: "Devo leggere il file" });
    hostMessage({ type: "textDelta", content: "\n" }); // padding between two segments
    hostMessage({ type: "thinkingDelta", content: ", then the store." });
    await new Promise((r) => setTimeout(r, 40));

    const blocks = document.querySelectorAll(".thinking-block");
    expect(blocks.length).toBe(1);
    (blocks[0].querySelector(".thinking-header") as HTMLElement).click();
    expect(blocks[0].querySelector(".thinking-body")?.textContent).toContain("then the store");
  });

  it("keeps ONE thinking block when the reasoning RESUMES mid-answer (no second item)", async () => {
    // Reported: a "Thinking…" block, then the answer, then a SECOND "Thought during this
    // answer" block — and at the next repaint the two folded back into one. The host keeps ONE
    // `thinking` string per segment (before AND during the answer), so the finished turn and
    // the replay both render ONE block: the live view must show that same thing from the
    // start, i.e. the resumed reasoning EXTENDS the block already on screen.
    await loadView();
    (document.getElementById("user-input") as HTMLTextAreaElement).value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();

    hostMessage({ type: "thinkingDelta", content: "I look for where the skill is installed. " });
    hostMessage({ type: "textDelta", content: "Guardo il codice." });
    hostMessage({ type: "thinkingDelta", content: "Forse in ~/.pi/agent/skills. " });
    hostMessage({ type: "textDelta", content: " Rimuovo." });
    await new Promise((r) => setTimeout(r, 40));

    const blocks = document.querySelectorAll(".thinking-block");
    expect(blocks.length).toBe(1); // ONE item, not two collapsing later
    (blocks[0].querySelector(".thinking-header") as HTMLElement).click();
    const body = blocks[0].querySelector(".thinking-body")?.textContent ?? "";
    expect(body).toContain("I look for where the skill is installed"); // the first half
    expect(body).toContain("Forse in ~/.pi/agent/skills"); // the resumed half, same block

    // …and merging must not cost the answer its ONE bubble, nor reorder anything.
    const answers = [...document.querySelectorAll(".msg.assistant")];
    expect(answers).toHaveLength(1);
    expect(answers[0].textContent).toContain("Guardo il codice. Rimuovo.");
    // The block stays where the reasoning happened: above the answer.
    expect(blocks[0].compareDocumentPosition(answers[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("…but a TOOL call ends the segment: the reasoning that follows opens its own block", async () => {
    // Merging is per SEGMENT. A tool call commits the assistant message, so the reasoning that
    // comes after it is a different thought, in a different place in the story of the run —
    // extending the old block would file it before the tool output it is about.
    await loadView();
    (document.getElementById("user-input") as HTMLTextAreaElement).value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();

    hostMessage({ type: "thinkingDelta", content: "First phase" });
    hostMessage({ type: "textDelta", content: "Uso uno strumento." });
    hostMessage({ type: "toolCall", id: "c1", name: "Read", arguments: { path: "a.ts" } });
    hostMessage({ type: "thinkingDelta", content: "Second phase" });
    await new Promise((r) => setTimeout(r, 40));

    const blocks = [...document.querySelectorAll(".thinking-block")];
    expect(blocks.length).toBe(2);
    expect(blocks[1].textContent).toContain("Second phase");
    expect(blocks[0].textContent).not.toContain("Second phase");
  });

  it("a delta that carries NO text paints nothing and does not close the reasoning", async () => {
    // Providers emit a trailing/leading EMPTY chunk, and a malformed one can omit the field
    // outright: `currentRawText += undefined` would paint the word "undefined", so the guard
    // has to come first. Skipping such a chunk must not settle the block either.
    await loadView();
    (document.getElementById("user-input") as HTMLTextAreaElement).value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();

    hostMessage({ type: "thinkingDelta", content: "Sto ragionando" });
    hostMessage({ type: "textDelta" }); // no `content` field at all
    hostMessage({ type: "textDelta", content: "" }); // the ordinary empty chunk
    await new Promise((r) => setTimeout(r, 40));

    expect(document.querySelectorAll(".thinking-block").length).toBe(1);
    expect(messagesElLastContent()).not.toContain("undefined");
  });

  it("a MID-RUN rebuild keeps the working bar, and the answer keeps painting", async () => {
    // A compaction rebuilds the transcript while the run continues (refreshTranscript).
    // Without the bar, `ensureResult()` has no anchor to insert the bubble before, so the
    // answer stops painting — the reported "the bar vanished while everything kept going".
    await loadView();
    (document.getElementById("user-input") as HTMLTextAreaElement).value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    hostMessage({ type: "textDelta", content: "before" });

    hostMessage({ type: "compactStart" });
    hostMessage({ type: "refresh", messages: [], streaming: true, liveAnswer: "before" });
    const bar = document.getElementById("working-bar") as HTMLElement;
    expect(bar.classList.contains("hidden")).toBe(false);

    hostMessage({ type: "textDelta", content: " and after" });
    await new Promise((r) => setTimeout(r, 40));
    expect(messagesElLastContent()).toContain("before and after");
  });

  it("still gives reasoning its OWN block when it comes BEFORE the answer (the common case)", async () => {
    // The fix must not swallow the normal order: reason first, then answer. The
    // block stands on its own and the answer that follows is its own bubble.
    await loadView();
    (document.getElementById("user-input") as HTMLTextAreaElement).value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();

    hostMessage({ type: "thinkingDelta", content: "I think first" });
    hostMessage({ type: "textDelta", content: "the answer" });
    await new Promise((r) => setTimeout(r, 40));

    const marker = document.querySelector(".thinking-block") as HTMLElement;
    const answer = document.querySelector(".msg.assistant") as HTMLElement;
    expect(marker.textContent).toContain("Thinking");
    expect(marker.textContent).not.toContain("during this answer");
    expect(answer.textContent).toContain("the answer");
    // …and the answer is a SEPARATE bubble after it, not merged into the block.
    expect(marker.contains(answer)).toBe(false);
  });

  it("moves the pulse to the marker and KEEPS the answer streaming (mid-answer reasoning)", async () => {
    // This used to close the answer bubble on any new thinking phase. That is right
    // when the reasoning comes BEFORE the answer, and wrong while the answer is being
    // written: closing it there cut the sentence in two. The answer keeps streaming
    // and the pulse belongs to the reasoning marker until the turn ends.
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();

    hostMessage({ type: "textDelta", content: "partial" });
    expect(document.querySelector(".msg.assistant.streaming")).toBeTruthy();

    hostMessage({ type: "thinkingDelta", content: "reasoning..." });

    const answer = document.querySelector(".msg.assistant.streaming") as HTMLElement;
    expect(answer).toBeTruthy(); // the answer continues in the SAME bubble
    expect(answer.textContent).toContain("partial");
    const marker = document.querySelector(".thinking-block") as HTMLElement;
    expect(marker.classList.contains("streaming")).toBe(true); // the pulse moved here
  });

  describe("the answer never loses its beginning (reported: text starting mid-word)", () => {
    const FRASE =
      "I have everything to describe them without inventing anything. Writing the [Unreleased] section — it covers the whole unreleased cycle (16 commits), not just my part:";
    /** The real stream arrives in many small chunks, not in one piece. */
    const chunks = (text: string, size = 8): string[] => {
      const out: string[] = [];
      for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
      return out;
    };
    /** Let the throttled renderer paint (it coalesces within 16ms). */
    const frame = (): Promise<void> => new Promise((r) => setTimeout(r, 40));
    const showAssistant = (): string =>
      [...document.querySelectorAll(".msg.assistant")].map((e) => e.textContent ?? "").join("\n");

    async function startWorking(): Promise<void> {
      await loadView();
      (document.getElementById("user-input") as HTMLTextAreaElement).value = "go";
      (document.getElementById("send-btn") as HTMLButtonElement).click();
    }

    it("keeps the whole first segment when the stream is chunked and a tool follows", async () => {
      await startWorking();
      for (const c of chunks(FRASE)) hostMessage({ type: "textDelta", content: c });
      hostMessage({ type: "toolCall", id: "c1", name: "Shell", arguments: { command: "ls" } });
      await frame();

      const shown = showAssistant();
      expect(shown).toContain(FRASE);
      expect(shown).not.toMatch(/^\s*zione/);
    });

    it("keeps it across a full turn (text, tool, text)", async () => {
      await startWorking();
      for (const c of chunks(FRASE)) hostMessage({ type: "textDelta", content: c });
      hostMessage({ type: "toolCall", id: "c1", name: "Shell", arguments: { command: "ls" } });
      hostMessage({ type: "toolResult", toolCallId: "c1", output: "ok", isError: false });
      hostMessage({ type: "textDelta", content: "After the tool." });
      await frame();

      const shown = showAssistant();
      expect(shown).toContain(FRASE);
      expect(shown).toContain("After the tool.");
    });

    it("does NOT lose the live answer when a transcript REFRESH lands mid-stream", async () => {
      // A refresh rebuilds from COMMITTED messages only. The turn still streaming is
      // not committed: unless its live text travels with the refresh, the bubble is
      // rebuilt without it and the following deltas start a NEW one mid-word. The
      // host KNOWS that text (StreamTee.liveOf) — it has to come along.
      await startWorking();
      for (const c of chunks(FRASE)) hostMessage({ type: "textDelta", content: c });
      await frame();

      hostMessage({
        type: "refresh",
        messages: [{ role: "user", content: "guarda il readme", timestamp: 1 }],
        streaming: true,
        liveAnswer: FRASE,
        liveThinking: "",
      });
      await frame();

      const shown = showAssistant();
      expect(shown).toContain(FRASE); // the live text survived the rebuild
    });
  });

  it("ignores empty / whitespace-only text deltas (no empty bubble)", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();

    // Empty content delta: must NOT create a bubble.
    hostMessage({ type: "textDelta", content: "" });
    expect(document.querySelector(".msg.assistant")).toBe(null);
    // Whitespace-only delta (e.g. a lone newline): must NOT create a bubble.
    hostMessage({ type: "textDelta", content: "\n\n" });
    expect(document.querySelector(".msg.assistant")).toBe(null);
    hostMessage({ type: "thinkingDelta", content: "" });
    expect(document.querySelector(".thinking-block")).toBe(null);

    // Once real text arrives, the bubble appears with the accumulated text.
    hostMessage({ type: "textDelta", content: "hi" });
    expect(document.querySelector(".msg.assistant")?.textContent).toContain("hi");
  });

  it("does not create an empty bubble for whitespace-only text after thinking", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();

    hostMessage({ type: "thinkingDelta", content: "Let me try a different approach." });
    hostMessage({ type: "textDelta", content: "\n" }); // whitespace-only, no bubble
    hostMessage({ type: "toolCall", id: "c1", name: "Read", arguments: { path: "a.ts" } });

    expect(document.querySelector(".msg.assistant")).toBe(null);
    expect(document.querySelector(".msg.tool")).toBeTruthy();
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
    // Phase-locked: same negative-delay trick, in sync with the play button.
    expect(block.style.animationDelay).toMatch(/^-\d+(\.\d+)?ms$/);

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
    // Even live, the thinking body stays collapsed while it fills.
    expect(block.querySelector(".thinking-body")?.classList.contains("collapsed")).toBe(true);
  });

  it("settles the active areas when the run errors", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();

    hostMessage({ type: "thinkingDelta", content: "think" });
    hostMessage({ type: "textDelta", content: "answer" });
    const thinking = document.querySelector(".thinking-block") as HTMLElement;
    const bubble = document.querySelector(".msg.assistant") as HTMLElement;
    expect(thinking.classList.contains("streaming")).toBe(false); // already settled at hand-off
    expect(bubble.classList.contains("streaming")).toBe(true);

    hostMessage({ type: "error", error: "boom" });
    // Nothing keeps animating after the error.
    expect(bubble.classList.contains("streaming")).toBe(false);
    expect(bubble.classList.contains("settling")).toBe(true);
    expect(thinking.classList.contains("streaming")).toBe(false);
  });

  it("removes the settling class once the pulse fade completes", async () => {
    vi.useFakeTimers();
    try {
      await loadView();
      const input = document.getElementById("user-input") as HTMLTextAreaElement;
      input.value = "go";
      (document.getElementById("send-btn") as HTMLButtonElement).click();
      hostMessage({ type: "textDelta", content: "x" });
      hostMessage({ type: "done" });

      const final = document.querySelector(".msg.assistant") as HTMLElement;
      expect(final.classList.contains("settling")).toBe(true);
      expect(final.classList.contains("streaming")).toBe(false);

      // After the 0.7s fade the temporary settling class is cleaned up.
      vi.advanceTimersByTime(750);
      expect(final.classList.contains("settling")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders thinking as markdown (bold, code, lists)", async () => {
    await loadView();
    hostMessage({ type: "thinkingDelta", content: "Step one\n\n- item one\n- item two\n\n**important** `code`" });
    const body = document.querySelector(".thinking-body") as HTMLElement;
    expect(body.querySelector("strong")?.textContent).toBe("important");
    expect(body.querySelector("code")?.textContent).toBe("code");
    expect(body.querySelector("li")?.textContent).toBe("item one");
  });

  it("coalesces rapid renders to the next frame and flushes the LATEST text", async () => {
    await loadView();
    hostMessage({ type: "thinkingDelta", content: "**bold**" });
    const body = document.querySelector(".thinking-body") as HTMLElement;
    // Leading edge: the first delta renders immediately.
    expect(body.querySelector("strong")?.textContent).toBe("bold");

    // Rapid deltas: they coalesce into ONE paint on the next animation frame,
    // which must render the LATEST accumulated text (getText closure).
    hostMessage({ type: "thinkingDelta", content: " part" });
    hostMessage({ type: "thinkingDelta", content: " **two**" });
    expect(body.textContent).toContain("bold"); // still the leading snapshot
    // The trailing render fires on the next animation frame: WAIT for it.
    await vi.waitFor(() => expect(body.querySelectorAll("strong").length).toBe(2), { timeout: 2000 });
    expect(body.querySelector("strong:last-child")?.textContent).toBe("two");
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
    const off = document.getElementById("thinking-off") as HTMLInputElement;
    hostMessage({
      type: "switchView",
      sessions: [
        { id: "a", name: "Refactor", createdAt: 1, updatedAt: 2, messageCount: 3 },
        { id: "w", name: "Working", createdAt: 1, updatedAt: 2, messageCount: 1 },
      ],
      openIds: ["a", "w"],
      activeId: "w",
      messages: [{ role: "user", content: "go", timestamp: 1 }],
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        thinkingMode: "bool",
        thinkingLevel: "high",
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
      workingIds: ["w"],
      streaming: true,
    });
    // Live working bar restored (footer, outside the transcript flow).
    expect((document.getElementById("working-bar") as HTMLElement).classList.contains("hidden")).toBe(false);
    expect(off.disabled).toBe(true);
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
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
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
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        thinkingMode: "bool",
        thinkingLevel: "high",
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
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

  it("switchView rebuilds the in-flight TOOL and SUB-AGENT bubbles from liveTurn", async () => {
    // The history does not contain them: the assistant turn (tool calls
    // included) is committed only when the WHOLE batch ends. Before liveTurn,
    // returning to a working session showed a bare "Working…" bar until Stop.
    const frame = (): Promise<void> => new Promise((r) => setTimeout(r, 40));
    await loadView();
    hostMessage({
      type: "switchView",
      sessions: [{ id: "a", name: "A", createdAt: 1, updatedAt: 2, messageCount: 1 }],
      openIds: ["a"],
      activeId: "a",
      messages: [{ role: "user", content: "go", timestamp: 1 }],
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        thinkingMode: "bool",
        thinkingLevel: "high",
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
      workingIds: ["a"],
      streaming: true,
      liveThinking: "",
      liveAnswer: "Lancio tre sub-agent.",
      liveTurn: {
        thinking: "",
        answer: "Lancio tre sub-agent.",
        textAfterTools: false,
        toolCalls: [
          { id: "d1", name: "Delegate", args: { id: "api", goal: "read the API" }, done: false, isError: false },
          {
            id: "d2",
            name: "Delegate",
            args: { id: "db", goal: "read the schema" },
            done: true,
            isError: false,
            output: "schema letto",
          },
        ],
        subAgents: { d1: { status: "running", events: [{ type: "text_delta", content: "sto leggendo" }] } },
      },
    });
    await frame();

    const subAgents = [...document.querySelectorAll(".msg.tool.subagent")];
    expect(subAgents).toHaveLength(2);
    // Per-sub-agent status survives: one still running, one already reported.
    expect(subAgents[0].querySelector(".subagent-status")?.textContent).toBe("running…");
    expect(subAgents[1].querySelector(".subagent-status")?.textContent).toBe("done");
    expect(subAgents[1].textContent).toContain("schema letto");
    // The nested live log survived the rebuild (it is NOT in the history either).
    expect(subAgents[0].textContent).toContain("sto leggendo");

    // The preamble was written BEFORE the Delegate calls: it stays ABOVE them.
    const all = [...document.querySelectorAll("#messages > *")];
    const textIdx = all.findIndex((el) => (el.textContent || "").includes("Lancio tre sub-agent."));
    const toolIdx = all.findIndex((el) => el.classList.contains("subagent"));
    expect(textIdx).toBeGreaterThan(-1);
    expect(toolIdx).toBeGreaterThan(textIdx);

    // …and the events still arriving keep updating the REBUILT bubbles.
    hostMessage({ type: "subagentEvent", toolCallId: "d1", event: { type: "text_delta", content: " e scrivo" } });
    await frame();
    expect(subAgents[0].textContent).toContain("e scrivo");
  });

  it("places the replayed text AFTER the bubbles when it was written after a tool result", async () => {
    const frame = (): Promise<void> => new Promise((r) => setTimeout(r, 40));
    await loadView();
    hostMessage({
      type: "switchView",
      sessions: [{ id: "a", name: "A", createdAt: 1, updatedAt: 2, messageCount: 1 }],
      openIds: ["a"],
      activeId: "a",
      messages: [{ role: "user", content: "go", timestamp: 1 }],
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
      workingIds: ["a"],
      streaming: true,
      liveThinking: "",
      liveAnswer: "Ecco cosa ho letto.",
      liveTurn: {
        thinking: "",
        answer: "Ecco cosa ho letto.",
        textAfterTools: true,
        toolCalls: [{ id: "c1", name: "Read", args: { path: "a.ts" }, done: true, isError: false, output: "body" }],
        subAgents: {},
      },
    });
    await frame();

    const all = [...document.querySelectorAll("#messages > *")];
    const toolIdx = all.findIndex((el) => el.classList.contains("tool"));
    const textIdx = all.findIndex((el) => (el.textContent || "").includes("Ecco cosa ho letto."));
    expect(toolIdx).toBeGreaterThan(-1);
    expect(textIdx).toBeGreaterThan(toolIdx);
  });

  it("keeps the ⏹ of a sub-agent disabled after a rebuild (abort already pressed)", async () => {
    await loadView();
    hostMessage({
      type: "switchView",
      sessions: [{ id: "a", name: "A", createdAt: 1, updatedAt: 2, messageCount: 1 }],
      openIds: ["a"],
      activeId: "a",
      messages: [{ role: "user", content: "go", timestamp: 1 }],
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
      workingIds: ["a"],
      streaming: true,
      liveThinking: "",
      liveAnswer: "",
      liveTurn: {
        thinking: "",
        answer: "",
        textAfterTools: false,
        toolCalls: [
          {
            id: "d1",
            name: "Delegate",
            args: { id: "api", goal: "g" },
            done: false,
            isError: false,
            abortRequested: true,
          },
        ],
        subAgents: { d1: { status: "running", events: [] } },
      },
    });

    const el = document.querySelector(".msg.tool.subagent") as HTMLElement;
    expect(el.dataset.aborting).toBe("1");
    const abortBtn = el.querySelector(".subagent-abort") as HTMLButtonElement;
    expect(abortBtn.disabled).toBe(true);
    expect(abortBtn.classList.contains("pending")).toBe(true);
  });

  it("says WHY the list is empty (never claiming there are no sessions while a tab is open)", async () => {
    await loadView();
    const empty = () => (document.getElementById("sessions") as HTMLElement).textContent ?? "";
    hostMessage({
      type: "switchView",
      switchSeq: 1,
      sessions: [],
      openIds: ["b"],
      activeId: "b",
      messages: [],
      config: {},
      workingIds: [],
      streaming: false,
    });
    // "No sessions yet" was a lie in the case that actually happens — a folder switched
    // under your open tabs: there IS a session, it just is not from this folder.
    expect(empty()).toContain("No sessions in this folder");
  });

  it("lists an OPEN session of another folder, dimmed and explained", async () => {
    await loadView();
    hostMessage({
      type: "switchView",
      switchSeq: 1,
      sessions: [
        { id: "a", name: "Local", createdAt: 1, updatedAt: 3, messageCount: 1, folder: "/home/me/a" },
        {
          id: "b",
          name: "Elsewhere",
          createdAt: 1,
          updatedAt: 2,
          messageCount: 1,
          folder: "/home/me/b",
          foreign: true,
        },
      ],
      openIds: ["b"],
      activeId: "b",
      messages: [],
      config: {},
      workingIds: [],
      streaming: false,
    });

    const row = document.querySelector('.srow[data-id="b"]') as HTMLElement;
    expect(row.classList.contains("foreign")).toBe(true);
    expect(row.classList.contains("open")).toBe(true);
    // It says WHERE it lives instead of pretending to be local.
    expect(row.title).toContain("/home/me/b");
    // The folder's own session carries no such mark.
    const local = document.querySelector('.srow[data-id="a"]') as HTMLElement;
    expect(local.classList.contains("foreign")).toBe(false);
    expect(local.title).toBe("");
  });

  it("a row whose folder is GONE asks for a folder instead of doing nothing", async () => {
    // Reachable: the open workspace folder (or a foreign session's folder) is deleted on
    // disk. `openSession` is refused by the host, so that click used to show an
    // "opening…" veil and then nothing at all.
    await loadView();
    hostMessage({
      type: "switchView",
      switchSeq: 1,
      sessions: [
        { id: "a", name: "Gone", createdAt: 1, updatedAt: 2, messageCount: 1, folder: "/p/gone", folderMissing: true },
      ],
      openIds: ["a"],
      activeId: undefined,
      messages: [],
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [],
        contextWindow: 128000,
        workspaceReady: true,
      },
      workingIds: [],
    });
    const row = document.querySelector('.srow[data-id="a"]') as HTMLElement;
    expect(row.title).toContain("no longer exists");
    // Said IN the row, not only in a tooltip: a row that looks healthy is how you end up
    // clicking a session that cannot open.
    const marker = row.querySelector(".srow-folder") as HTMLElement;
    expect(marker.classList.contains("missing")).toBe(true);
    expect(marker.textContent).toBe("/p/gone — missing");
    // …and on the TAB: its transcript still opens, but the agent has nowhere to work.
    const tab = document.querySelector('.tab[data-id="a"]') as HTMLElement;
    expect(tab.classList.contains("missing")).toBe(true);
    expect(tab.title).toContain("folder no longer exists");
    (row.querySelector(".name") as HTMLElement).click();
    expect(posted).toContainEqual({ type: "openSessionFolder", id: "a" });
    expect(posted.some((m: any) => m.type === "openSession")).toBe(false);
    // No veil for something that will never open, and the list stays where it is (the
    // alert + picker are overlays, not a navigation).
    expect(document.getElementById("switch-veil")?.classList.contains("visible")).toBe(false);
    expect(document.getElementById("sessions")?.classList.contains("hidden")).toBe(false);
  });

  it("ignores a STALE switchView (two quick clicks resolving out of order)", async () => {
    // The host posts one switchView per click and each awaits a config build, so
    // the OLDER one can land last. Applying it would jump the UI back to the tab
    // the user already left.
    await loadView();
    const A = { id: "a", name: "A", createdAt: 1, updatedAt: 2, messageCount: 1 };
    const B = { id: "b", name: "B", createdAt: 1, updatedAt: 2, messageCount: 1 };
    hostMessage({
      type: "switchView",
      switchSeq: 2,
      sessions: [A, B],
      openIds: ["a", "b"],
      activeId: "b",
      messages: [],
      config: {},
      workingIds: [],
    });
    hostMessage({
      type: "switchView",
      switchSeq: 1,
      sessions: [A, B],
      openIds: ["a", "b"],
      activeId: "a",
      messages: [{ role: "user", content: "stale", timestamp: 1 }],
      config: {},
      workingIds: [],
    });
    expect(document.querySelector(".tab.active")?.getAttribute("data-id")).toBe("b");
    expect(document.getElementById("messages")?.textContent).not.toContain("stale");
  });

  it("drops a streamed message addressed to ANOTHER session", async () => {
    // A delta of the session you just switched TO can arrive before its switchView.
    // It must never be drawn into the tab you are leaving (nothing is lost: the
    // switchView replays that session's live turn).
    await loadView();
    const A = { id: "a", name: "A", createdAt: 1, updatedAt: 2, messageCount: 1 };
    hostMessage({
      type: "switchView",
      switchSeq: 1,
      sessions: [A],
      openIds: ["a"],
      activeId: "a",
      messages: [],
      config: {},
      workingIds: ["a"],
      streaming: true,
    });

    hostMessage({ type: "textDelta", sessionId: "b", content: "di B" });
    expect(document.querySelector(".msg.assistant")).toBe(null);

    hostMessage({ type: "textDelta", sessionId: "a", content: "di A" });
    expect(document.querySelector(".msg.assistant")?.textContent).toContain("di A");
  });

  it("restores the Compacting bubble on a tab switch (it used to vanish for good)", async () => {
    await loadView();
    hostMessage({ type: "compactStart" });
    expect(document.querySelector("#messages .working")?.textContent).toContain("Compacting…");

    // A switch rebuilds the transcript: the bubble is DOM-only, so it must come
    // back from the host's per-session flag.
    const A = { id: "a", name: "A", createdAt: 1, updatedAt: 2, messageCount: 1 };
    hostMessage({
      type: "switchView",
      switchSeq: 1,
      sessions: [A],
      openIds: ["a"],
      activeId: "a",
      messages: [{ role: "user", content: "go", timestamp: 1 }],
      config: {},
      workingIds: ["a"],
      streaming: false,
      compacting: true,
    });
    expect(document.querySelector("#messages .working")?.textContent).toContain("Compacting…");
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
        {
          role: "tool",
          toolCallId: "e1",
          content: "Diff (+1/-1):\n```diff\n@@ -1,2 +1,2 @@\n-old\n+new\n```",
          timestamp: 3,
        },
        { role: "assistant", content: "done", timestamp: 4 },
      ],
    });
    // the diff becomes a third section INSIDE the tool bubble (Input/Output/Diff)
    const diff = document.querySelector(".msg.tool .tool-diff");
    expect(diff).not.toBeNull();
    expect(diff?.querySelector(".fd-add")?.textContent).toBe("+new");
    expect(diff?.querySelector(".fd-del")?.textContent).toBe("-old");
  });

  it("previewReady renders a STATIC 'switch to Build' note (no button)", async () => {
    await loadView();
    hostMessage({ type: "previewReady" });
    const cta = document.querySelector(".build-cta") as HTMLElement;
    expect(cta).toBeTruthy();
    expect(cta.classList.contains("build-cta-static")).toBe(true);
    expect(cta.querySelector(".build-cta-text")?.textContent).toContain("switch to Build");
    // The ACTION is the one-shot host modal, not a persistent button.
    expect(document.querySelector(".build-cta-btn")).toBeFalsy();
  });

  it("does NOT ask to switch to Build when the user already did (a pending switch)", async () => {
    // Analyze prepared the previews and the user flipped to Build while that run worked: the
    // banner would tell them to do what they have done, so it is not shown.
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        mode: "agent",
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
    });
    hostMessage({ type: "previewReady" });
    expect(document.querySelector(".build-cta")).toBeFalsy();

    // Still in Analyze → the banner IS the point.
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        mode: "analyze",
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
    });
    hostMessage({ type: "previewReady" });
    expect(document.querySelector(".build-cta")).toBeTruthy();
  });

  it("ignores a STALE config push (out-of-order async responses)", async () => {
    await loadView();
    hostMessage({ type: "config", config: { mode: "agent" }, configSeq: 5 });
    expect(document.getElementById("mode-btn-label")?.textContent).toBe("Build");

    // A slower, OLDER response arrives late: it must NOT revert the mode.
    hostMessage({ type: "config", config: { mode: "analyze" }, configSeq: 4 });
    expect(document.getElementById("mode-btn-label")?.textContent).toBe("Build");

    // A NEWER one still applies.
    hostMessage({ type: "config", config: { mode: "analyze" }, configSeq: 6 });
    expect(document.getElementById("mode-btn-label")?.textContent).toBe("Analyze");
  });

  it("a switchView advances the config sequence (later stale configs ignored)", async () => {
    await loadView();
    hostMessage({
      type: "switchView",
      sessions: [],
      openIds: [],
      activeId: "a",
      messages: [],
      config: { mode: "agent" },
      configSeq: 10,
      workingIds: [],
    });
    expect(document.getElementById("mode-btn-label")?.textContent).toBe("Build");

    hostMessage({ type: "config", config: { mode: "analyze" }, configSeq: 9 });
    expect(document.getElementById("mode-btn-label")?.textContent).toBe("Build");
  });

  it("re-renders the static note on refresh from the message flag (no button)", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [
        { role: "user", content: "fix it", timestamp: 1 },
        {
          role: "assistant",
          // The model wrote its OWN hint line: the static note still appears
          // because the FLAG says a preview was prepared.
          content: "Done.\n\n➡️ Switch to **Build** to apply the changes.",
          previewPrepared: true,
          timestamp: 2,
        },
      ],
    });
    expect(document.querySelector(".build-cta-static")).toBeTruthy();
    expect(document.querySelector(".build-cta-btn")).toBeFalsy();
  });

  it("does NOT show the CTA from the text alone (no preview flag)", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [
        { role: "user", content: "answer", timestamp: 1 },
        { role: "assistant", content: "➡️ Switch to **Build** to apply the changes.", timestamp: 2 },
      ],
    });
    expect(document.querySelector(".build-cta")).toBeFalsy();
  });

  it("renders a loop-intervention notice as an amber (non-error) bubble", async () => {
    await loadView();
    hostMessage({
      type: "loopIntervention",
      loopType: "reasoning",
      level: 1,
      message: "reasoning loop detected — cut short and told to act.",
    });
    const el = [...document.querySelectorAll(".msg.assistant.loop")].at(-1) as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.textContent).toContain("Loop guard");
    expect(el.textContent).toContain("reasoning");
    expect(el.classList.contains("error")).toBe(false);
  });

  it("re-renders a persisted loop notice with the amber class on refresh", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [
        { role: "user", content: "q", timestamp: 1 },
        { role: "assistant", content: "🔁 **Loop guard** [empty] — empty turn nudged.", timestamp: 2, uiOnly: true },
        { role: "assistant", content: "answer", timestamp: 3 },
      ],
    });
    const el = document.querySelector(".msg.assistant.loop") as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.textContent).toContain("Loop guard");
    // Loop notices are system annotations: not branchable.
    expect(el.querySelector(".branch-at")).toBeNull();
  });

  it("on refresh keeps the assistant preamble ABOVE its sub-agent bubbles", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [
        { role: "user", content: "do the thing", timestamp: 1 },
        {
          role: "assistant",
          content: "Good idea: I'll split this into 4 independent sub-tasks.",
          timestamp: 2,
          toolCalls: [
            { id: "s1", name: "Delegate", arguments: { id: "A", goal: "Analyze a", access: "read" } },
            { id: "s2", name: "Delegate", arguments: { id: "B", goal: "Analyze b", access: "read" } },
          ],
        },
      ],
    });
    const order = [...document.querySelectorAll("#messages > *")].map((el) => el.className);
    const answerAt = order.findIndex((c) => c.includes("assistant") && !c.includes("tool"));
    const firstSubagentAt = order.findIndex((c) => c.includes("subagent"));
    expect(answerAt).toBeGreaterThanOrEqual(0);
    expect(firstSubagentAt).toBeGreaterThanOrEqual(0);
    // The preamble bubble precedes the sub-agent bubbles (chronology), matching
    // the live stream instead of jumping below them after the refresh.
    expect(answerAt).toBeLessThan(firstSubagentAt);
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

  it("returns focus to the prompt after a Stop (interrupted)", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    (document.activeElement as HTMLElement | null)?.blur();

    hostMessage({ type: "interrupted" });

    expect(document.activeElement).toBe(input);
  });

  it("focuses the prompt when opening/switching a session (switchView)", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).not.toBe(input);

    hostMessage({
      type: "switchView",
      activeId: "b",
      openIds: ["a", "b"],
      sessions: [],
      messages: [],
      config: {},
      workingIds: [],
    });

    expect(document.activeElement).toBe(input);
  });

  it("focuses the prompt on initial load when a session is active", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(input);
  });

  it("returns focus to the prompt after mode / parallel / model / attach flows", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    const blur = () => (document.activeElement as HTMLElement | null)?.blur();

    // Analyze/Build change
    blur();
    (document.querySelector('.mode-item[data-mode="agent"]') as HTMLElement).click();
    expect(document.activeElement).toBe(input);

    // Parallel toggle
    blur();
    (document.getElementById("parallel-btn") as HTMLButtonElement).click();
    expect(document.activeElement).toBe(input);

    // Model selection (modal): picking a model returns focus to the prompt.
    blur();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "m1",
        hasKey: true,
        models: ["m1"],
        providerModels: [{ provider: "openai", model: "m1" }],
      },
    });
    (document.getElementById("model-btn") as HTMLButtonElement).click();
    (document.querySelector("#model-list .mm-model") as HTMLButtonElement).click();
    expect(document.activeElement).toBe(input);

    // Attach flow finished (picker closed / cancelled)
    blur();
    hostMessage({ type: "attachments", files: [] });
    expect(document.activeElement).toBe(input);
  });

  it("Esc closes the model modal and returns focus to the prompt", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    const modal = document.getElementById("model-modal") as HTMLElement;
    (document.activeElement as HTMLElement | null)?.blur();
    (document.getElementById("model-btn") as HTMLButtonElement).click();
    expect(modal.classList.contains("hidden")).toBe(false);

    document
      .getElementById("model-search")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(modal.classList.contains("hidden")).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it("the ✕ closes the model modal", async () => {
    await loadView();
    const modal = document.getElementById("model-modal") as HTMLElement;
    (document.getElementById("model-btn") as HTMLButtonElement).click();
    expect(modal.classList.contains("hidden")).toBe(false);
    (document.getElementById("model-close") as HTMLButtonElement).click();
    expect(modal.classList.contains("hidden")).toBe(true);
  });

  it("closing the mode menu (Esc / outside click) returns focus to the prompt", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    const btn = document.getElementById("mode-btn") as HTMLButtonElement;
    const menu = document.getElementById("mode-menu") as HTMLElement;

    (document.activeElement as HTMLElement | null)?.blur();
    btn.click();
    expect(menu.classList.contains("hidden")).toBe(false);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(menu.classList.contains("hidden")).toBe(true);
    expect(document.activeElement).toBe(input);

    (document.activeElement as HTMLElement | null)?.blur();
    btn.click();
    document.body.click();
    expect(menu.classList.contains("hidden")).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it("attachment chips under the prompt show the SMALL per-type icon", async () => {
    await loadView();
    hostMessage({ type: "attachments", files: [{ name: "a.pdf", path: "/a.pdf", size: 10, isImage: false }] });
    const chip = document.querySelector(".attach-chip") as HTMLElement;
    expect(chip.querySelector(".attach-icon svg")).toBeTruthy();
    expect(chip.querySelector(".attach-name")?.textContent).toBe("a.pdf");
  });

  it("two picked files with the SAME path are one chip", async () => {
    // The host may repeat a file in one answer; the de-duplication has to hold INSIDE the
    // batch too, not only against the chips already shown.
    await loadView();
    hostMessage({
      type: "attachments",
      files: [
        { name: "a.txt", path: "/d/a.txt", size: 3 },
        { name: "a.txt", path: "/d/a.txt", size: 3 },
      ],
    });
    expect(document.querySelectorAll(".attach-chip")).toHaveLength(1); // chips mirror the list sent
  });

  it("the picker's response puts the caret back in the prompt", async () => {
    // The host answers `pickFiles` with `attachments`: the user has just chosen the files and
    // expects to keep typing, not to click the box again.
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.blur();
    expect(document.activeElement).not.toBe(input);
    hostMessage({ type: "attachments", files: [{ name: "a.txt", path: "/a.txt", size: 3 }] });
    expect(document.activeElement).toBe(input);
  });

  it("removing an attachment returns focus to the prompt", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    hostMessage({ type: "attachments", files: [{ name: "a.txt", path: "/a.txt", size: 3 }] });
    const remove = document.querySelector(".attach-remove") as HTMLButtonElement;
    expect(remove).toBeTruthy();
    (document.activeElement as HTMLElement | null)?.blur();
    remove.click();
    expect(document.activeElement).toBe(input);
  });

  it("attached images render large (half the chat), stacked, with a resize handle", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [
        {
          role: "user",
          content: "look",
          timestamp: 1,
          attachments: [
            { name: "a.png", size: 1, dataUri: "data:image/png;base64,AAAA" },
            { name: "b.png", size: 1, dataUri: "data:image/png;base64,BBBB" },
          ],
        },
      ],
    });
    const boxes = document.querySelectorAll(".msg-attach-img");
    expect(boxes.length).toBe(2);
    expect((boxes[0] as HTMLElement).querySelector("img")).toBeTruthy();
    // Sized in px (half the chat) so it can be resized; the container stacks them.
    expect((boxes[0] as HTMLElement).style.width).toMatch(/^\d+px$/);
    expect(document.querySelector(".msg-attachments") as HTMLElement).toBeTruthy();
  });

  it("the LIVE user bubble also gets the ✂ cut key (not only after a refresh)", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: { provider: "openai", model: "gpt-4o", hasKey: true, contextWindow: 128000 },
    });
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "hi";
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    const bubble = document.querySelector(".msg.user") as HTMLElement;
    expect(bubble).toBeTruthy();
    expect(bubble.querySelector(".truncate-at")).toBeTruthy();
  });

  it("attached images PERSIST across a refresh (rendered from the message images)", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [
        {
          role: "user",
          content: "look",
          timestamp: 1,
          attachments: [{ name: "a.png", path: "", size: 1, isImage: true }],
          images: ["data:image/png;base64,AAAA"],
        },
      ],
    });
    const boxes = document.querySelectorAll(".msg-attach-img");
    expect(boxes.length).toBe(1);
    expect((boxes[0] as HTMLElement).querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    // The image attachment is NOT also rendered as a file card.
    expect(document.querySelectorAll(".msg-attach-file").length).toBe(0);
    // The ✂ cut tab must be present on the user bubble.
    expect(document.querySelector(".msg.user .truncate-at")).toBeTruthy();
  });

  it("synthetic compacted messages keep their ✂ cut / ⎇ branch key", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [
        { role: "user", content: "Summary of past interactions", timestamp: 1, synthetic: true },
        { role: "assistant", content: "## Goal\nDid X", timestamp: 2, synthetic: true },
      ],
    });
    const userBubble = document.querySelector(".msg.user") as HTMLElement;
    expect(userBubble.textContent).toContain("Summary of past interactions");
    // A recognizable icon precedes the synthetic marker.
    expect(userBubble.querySelector(".synthetic-icon")).toBeTruthy();
    // The bubbles behave like normal ones: ✂ cut and ⎇ branch are present.
    expect(userBubble.querySelector(".truncate-at")).toBeTruthy();
    const assistantBubble = document.querySelector(".msg.assistant") as HTMLElement;
    expect(assistantBubble.querySelector(".branch-at")).toBeTruthy();
  });

  it("Esc closes the slash menu without posting abort", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        contextWindow: 128000,
        skills: [{ name: "pptx", description: "d" }],
      },
    });
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "/";
    input.dispatchEvent(new Event("input"));
    const menu = document.getElementById("slash-menu") as HTMLElement;
    expect(menu.classList.contains("hidden")).toBe(false);
    posted.length = 0;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu.classList.contains("hidden")).toBe(true);
    expect(posted.some((m) => (m as { type?: string }).type === "abort")).toBe(false);
  });

  it("returns focus to the prompt after a transcript refresh (e.g. a cut)", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).not.toBe(input);

    hostMessage({ type: "refresh", messages: [{ role: "user", content: "hi", timestamp: 1 }] });

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
    await vi.waitFor(
      () => {
        const a = [...document.querySelectorAll("#messages .msg.assistant")];
        expect(a.length).toBe(2);
        expect(a[1].textContent).toContain("answer two");
      },
      { timeout: 2000 },
    );

    const assistants = [...document.querySelectorAll("#messages .msg.assistant")];
    expect(assistants[0].textContent).toContain("answer one more");

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
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
      streaming: false,
    });
    // The selected session starts pinned at the bottom.
    expect(msgs.scrollTop).toBe(500);
    // A subsequent delta stays at the bottom (auto-scroll was re-enabled).
    hostMessage({ type: "thinkingDelta", content: "thinking" });
    expect(msgs.scrollTop).toBe(500);
  });

  it("restores the reading position of a session you come back to", async () => {
    await loadView(); // activeId "a"
    const msgs = document.getElementById("messages") as HTMLElement;
    Object.defineProperty(msgs, "scrollHeight", { configurable: true, value: 900 });
    Object.defineProperty(msgs, "clientHeight", { configurable: true, value: 300 });
    Object.defineProperty(msgs, "scrollTop", { configurable: true, writable: true, value: 120 });
    msgs.dispatchEvent(new Event("scroll")); // the user scrolled UP: not following

    const A = { id: "a", name: "A", createdAt: 1, updatedAt: 2, messageCount: 1 };
    const B = { id: "b", name: "B", createdAt: 1, updatedAt: 2, messageCount: 1 };
    const go = (id: string, seq: number) =>
      hostMessage({
        type: "switchView",
        switchSeq: seq,
        sessions: [A, B],
        openIds: ["a", "b"],
        activeId: id,
        messages: [{ role: "user", content: "go", timestamp: 1 }],
        config: {},
        workingIds: [],
        streaming: false,
      });

    go("b", 1); // leave A…
    expect(msgs.scrollTop).toBe(900); // B is a first visit: pinned to its end
    go("a", 2); // …and come back

    // Back where the reader was, not yanked to the end.
    expect(msgs.scrollTop).toBe(120);
  });

  it("keeps following the stream when the session was PINNED when you left it", async () => {
    await loadView();
    const msgs = document.getElementById("messages") as HTMLElement;
    Object.defineProperty(msgs, "scrollHeight", { configurable: true, value: 900 });
    Object.defineProperty(msgs, "clientHeight", { configurable: true, value: 300 });
    Object.defineProperty(msgs, "scrollTop", { configurable: true, writable: true, value: 900 });
    msgs.dispatchEvent(new Event("scroll")); // at the bottom → following ON

    const A = { id: "a", name: "A", createdAt: 1, updatedAt: 2, messageCount: 1 };
    const B = { id: "b", name: "B", createdAt: 1, updatedAt: 2, messageCount: 1 };
    const go = (id: string, seq: number) =>
      hostMessage({
        type: "switchView",
        switchSeq: seq,
        sessions: [A, B],
        openIds: ["a", "b"],
        activeId: id,
        messages: [{ role: "user", content: "go", timestamp: 1 }],
        config: {},
        workingIds: [],
        streaming: true,
      });

    go("b", 1);
    go("a", 2);
    expect(msgs.scrollTop).toBe(900); // still pinned: the live turn keeps growing
  });

  it("keeps the sections you had opened across a tab switch (and the ones you had not)", async () => {
    const messages = [
      { role: "user", content: "go", timestamp: 1 },
      { role: "assistant", content: "answer", timestamp: 2, thinking: "deep thought" },
      {
        role: "assistant",
        content: "🔧 Tools: Read",
        timestamp: 3,
        toolCalls: [{ id: "c1", name: "Read", arguments: { path: "a.ts" } }],
      },
      { role: "tool", toolCallId: "c1", content: "body", timestamp: 4 },
    ];
    await loadView();
    const A = { id: "a", name: "A", createdAt: 1, updatedAt: 2, messageCount: 4 };
    const B = { id: "b", name: "B", createdAt: 1, updatedAt: 2, messageCount: 1 };
    const go = (id: string, seq: number) =>
      hostMessage({
        type: "switchView",
        switchSeq: seq,
        sessions: [A, B],
        openIds: ["a", "b"],
        activeId: id,
        messages: id === "a" ? messages : [{ role: "user", content: "other", timestamp: 9 }],
        config: {},
        workingIds: [],
        streaming: false,
      });

    go("a", 1);
    const thinkingBody = document.querySelector(".thinking-body") as HTMLElement;
    const toolBody = document.querySelector(".tool-details") as HTMLElement;
    expect(thinkingBody.classList.contains("collapsed")).toBe(true);
    expect(toolBody.classList.contains("collapsed")).toBe(true);

    // The user opens the THINKING block only.
    (thinkingBody.parentElement!.querySelector(".thinking-header") as HTMLElement).click();
    expect(thinkingBody.classList.contains("collapsed")).toBe(false);

    go("b", 2); // away…
    go("a", 3); // …and back: the transcript is rebuilt from the same history

    const thinkingAfter = document.querySelector(".thinking-body") as HTMLElement;
    const toolAfter = document.querySelector(".tool-details") as HTMLElement;
    expect(thinkingAfter.classList.contains("collapsed")).toBe(false); // still open
    expect(thinkingAfter.parentElement!.querySelector(".toggle")?.classList.contains("is-open") ?? false).toBe(true);
    expect(toolAfter.classList.contains("collapsed")).toBe(true); // never opened: stays closed
  });

  it("keeps the open sections across a run-end refresh too", async () => {
    const messages = [
      { role: "user", content: "go", timestamp: 1 },
      { role: "assistant", content: "answer", timestamp: 2, thinking: "deep thought" },
    ];
    await loadView();
    hostMessage({ type: "refresh", messages });
    const body = document.querySelector(".thinking-body") as HTMLElement;
    (body.parentElement!.querySelector(".thinking-header") as HTMLElement).click();
    expect(body.classList.contains("collapsed")).toBe(false);

    // The host refreshes the transcript (a completed turn): folding everything back
    // would be the same loss as on a switch.
    hostMessage({ type: "refresh", messages });
    const after = document.querySelector(".thinking-body") as HTMLElement;
    expect(after.classList.contains("collapsed")).toBe(false);
  });

  // ── Drafts that survive a webview RELOAD (state round-trip) ──
  // `loadView()` twice is a reload: the second instance starts from what the first
  // persisted (see `persistedState` in the harness).
  it("an attachment picked before a reload is still attached after it", async () => {
    await loadView();
    hostMessage({
      type: "attachments",
      files: [{ name: "relazione.pdf", path: "/tmp/relazione.pdf", size: 4096, isImage: false }],
    });
    (document.getElementById("user-input") as HTMLTextAreaElement).value = "summarize this";
    // Switching tab is what parks the composition (and persists it).
    hostMessage({
      type: "switchView",
      switchSeq: 1,
      sessions: [
        { id: "a", name: "A", createdAt: 1, updatedAt: 2, messageCount: 1 },
        { id: "b", name: "B", createdAt: 1, updatedAt: 2, messageCount: 1 },
      ],
      openIds: ["a", "b"],
      activeId: "b",
      messages: [{ role: "user", content: "go", timestamp: 1 }],
      config: {},
      workingIds: [],
      streaming: false,
    });

    await reloadView();

    // Session "a" is not the active one, but its composition is intact…
    expect(JSON.stringify(persistedState.draftFiles)).toContain("relazione.pdf");
    // …and going back brings the chip and the text with it.
    hostMessage({
      type: "switchView",
      switchSeq: 2,
      sessions: [
        { id: "a", name: "A", createdAt: 1, updatedAt: 2, messageCount: 1 },
        { id: "b", name: "B", createdAt: 1, updatedAt: 2, messageCount: 1 },
      ],
      openIds: ["a", "b"],
      activeId: "a",
      messages: [{ role: "user", content: "go", timestamp: 1 }],
      config: {},
      workingIds: [],
      streaming: false,
    });
    const chips = document.querySelectorAll(".attach-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toContain("relazione.pdf");
    expect((document.getElementById("user-input") as HTMLTextAreaElement).value).toBe("summarize this");
  });

  it("a SMALL pasted image keeps its data across a reload (and is sent with it)", async () => {
    await loadView();
    const dataUri = "data:image/png;base64," + "A".repeat(2048); // ~2KB: under the budget
    hostMessage({ type: "attachments", files: [{ name: "shot.png", path: "", size: 2048, isImage: true, dataUri }] });
    hostMessage({
      type: "switchView",
      switchSeq: 1,
      sessions: [
        { id: "a", name: "A", createdAt: 1, updatedAt: 2, messageCount: 1 },
        { id: "b", name: "B", createdAt: 1, updatedAt: 2, messageCount: 1 },
      ],
      openIds: ["a", "b"],
      activeId: "b",
      messages: [],
      config: {},
      workingIds: [],
      streaming: false,
    });

    await reloadView();
    // Back to "a", type something and send: the payload must travel again.
    hostMessage({
      type: "switchView",
      switchSeq: 2,
      sessions: [
        { id: "a", name: "A", createdAt: 1, updatedAt: 2, messageCount: 1 },
        { id: "b", name: "B", createdAt: 1, updatedAt: 2, messageCount: 1 },
      ],
      openIds: ["a", "b"],
      activeId: "a",
      messages: [],
      config: {},
      workingIds: [],
      streaming: false,
    });
    (document.getElementById("user-input") as HTMLTextAreaElement).value = "che cos'è?";
    (document.getElementById("send-btn") as HTMLButtonElement).click();

    const send = posted.find((m) => (m as { type?: string }).type === "send") as
      { attachments?: { name: string; dataUri?: string }[] } | undefined;
    expect(send).toBeDefined();
    expect(send!.attachments?.[0].dataUri).toBe(dataUri);
  });

  it("a LARGE pasted image is marked instead of bloating the state, and is refused instead of sent empty", async () => {
    await loadView();
    const huge = "data:image/png;base64," + "B".repeat(300 * 1024); // over the 256KB budget
    hostMessage({
      type: "attachments",
      files: [{ name: "big.png", path: "", size: huge.length, isImage: true, dataUri: huge }],
    });
    hostMessage({
      type: "switchView",
      switchSeq: 1,
      sessions: [
        { id: "a", name: "A", createdAt: 1, updatedAt: 2, messageCount: 1 },
        { id: "b", name: "B", createdAt: 1, updatedAt: 2, messageCount: 1 },
      ],
      openIds: ["a", "b"],
      activeId: "b",
      messages: [],
      config: {},
      workingIds: [],
      streaming: false,
    });

    // The state must NOT carry the payload: that is the whole point of the budget.
    expect(JSON.stringify(persistedState.draftFiles)).not.toContain("BBBB");
    expect(JSON.stringify(persistedState.draftFiles).length).toBeLessThan(4096);

    await reloadView();
    hostMessage({
      type: "switchView",
      switchSeq: 2,
      sessions: [
        { id: "a", name: "A", createdAt: 1, updatedAt: 2, messageCount: 1 },
        { id: "b", name: "B", createdAt: 1, updatedAt: 2, messageCount: 1 },
      ],
      openIds: ["a", "b"],
      activeId: "a",
      messages: [],
      config: {},
      workingIds: [],
      streaming: false,
    });
    // The chip is still there, marked…
    const chip = document.querySelector(".attach-chip") as HTMLElement;
    expect(chip.textContent).toContain("big.png");
    expect(chip.textContent).toContain("⚠");

    posted.length = 0;
    (document.getElementById("user-input") as HTMLTextAreaElement).value = "describe";
    (document.getElementById("send-btn") as HTMLButtonElement).click();

    // …and NOTHING was sent: an empty attachment must never reach the model silently.
    expect(posted.some((m) => (m as { type?: string }).type === "send")).toBe(false);
    const bodies = [...document.querySelectorAll("#messages .msg")].map((el) => el.textContent ?? "");
    expect(bodies.some((t) => t.includes("Re-attach") && t.includes("big.png"))).toBe(true);
  });

  it("clears the persisted draft (attachments included) once the message is sent", async () => {
    await loadView();
    hostMessage({ type: "attachments", files: [{ name: "a.ts", path: "/w/a.ts", size: 10, isImage: false }] });
    (document.getElementById("user-input") as HTMLTextAreaElement).value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();

    expect(posted.some((m) => (m as { type?: string }).type === "send")).toBe(true);
    expect(JSON.stringify(persistedState.draftFiles ?? {})).not.toContain("a.ts");
  });

  it("still restores the TEXT from a state written by an older version (files map absent)", async () => {
    setupDom({}, { drafts: { a: "draft written by the old version" } });
    await loadView();

    expect((document.getElementById("user-input") as HTMLTextAreaElement).value).toBe(
      "draft written by the old version",
    );
    expect(document.querySelectorAll(".attach-chip")).toHaveLength(0);
  });

  it("a malformed persisted attachment is ignored instead of crashing the panel", async () => {
    setupDom({}, { draftFiles: { a: [{ name: 42 }, null, { path: "nameless" }] } });
    await loadView();

    expect(document.querySelectorAll(".attach-chip")).toHaveLength(0);
  });

  it("a transcript that SHRANK (a compaction) drops the open sections instead of guessing", async () => {
    // The open sections are keyed by document order: after a compaction the kept
    // messages slide down, so index 3 stops being the section you opened. Closed is the
    // honest default — opening a section nobody asked for is the one outcome to avoid.
    const long = [
      { role: "user", content: "go", timestamp: 1 },
      { role: "assistant", content: "a1", timestamp: 2, thinking: "deep thought" },
      { role: "assistant", content: "a2", timestamp: 3, thinking: "second thought" },
    ];
    await loadView();
    hostMessage({ type: "refresh", messages: long });
    const bodies = () => [...document.querySelectorAll(".thinking-body")] as HTMLElement[];
    (bodies()[0].parentElement!.querySelector(".thinking-header") as HTMLElement).click();
    (bodies()[1].parentElement!.querySelector(".thinking-header") as HTMLElement).click();
    expect(bodies().every((b) => !b.classList.contains("collapsed"))).toBe(true);

    // FOLDED: the head became a summary, so the transcript is shorter.
    hostMessage({
      type: "refresh",
      messages: [
        { role: "user", content: "## Goal\nsummary", timestamp: 9 },
        { role: "assistant", content: "a2", timestamp: 3, thinking: "second thought" },
      ],
    });

    const after = bodies();
    expect(after.length).toBe(1);
    expect(after[0].classList.contains("collapsed")).toBe(true); // closed, not random
  });

  it("a transcript that GREW keeps them (the append case is what the keys are for)", async () => {
    const messages = [
      { role: "user", content: "go", timestamp: 1 },
      { role: "assistant", content: "a1", timestamp: 2, thinking: "deep thought" },
    ];
    await loadView();
    hostMessage({ type: "refresh", messages });
    const body = () => document.querySelector(".thinking-body") as HTMLElement;
    (body().parentElement!.querySelector(".thinking-header") as HTMLElement).click();
    expect(body().classList.contains("collapsed")).toBe(false);

    hostMessage({
      type: "refresh",
      messages: [...messages, { role: "user", content: "next", timestamp: 3 }],
    });

    expect(body().classList.contains("collapsed")).toBe(false); // still open
  });

  it("does not confuse a SMALLER session with a rewritten one (the size is per session)", async () => {
    // A global counter would read "A had 4 messages, B has 1" as a rewrite and wipe B's
    // open sections every time you switch to it.
    const A = { id: "a", name: "A", createdAt: 1, updatedAt: 2, messageCount: 4 };
    const B = { id: "b", name: "B", createdAt: 1, updatedAt: 2, messageCount: 1 };
    const bigA = [
      { role: "user", content: "go", timestamp: 1 },
      { role: "assistant", content: "a1", timestamp: 2, thinking: "A thought" },
      { role: "assistant", content: "a2", timestamp: 3 },
      { role: "user", content: "more", timestamp: 4 },
    ];
    const smallB = [
      { role: "user", content: "go", timestamp: 1 },
      { role: "assistant", content: "b1", timestamp: 2, thinking: "B thought" },
    ];
    const go = (id: string, seq: number) =>
      hostMessage({
        type: "switchView",
        switchSeq: seq,
        sessions: [A, B],
        openIds: ["a", "b"],
        activeId: id,
        messages: id === "a" ? bigA : smallB,
        config: {},
        workingIds: [],
        streaming: false,
      });

    await loadView();
    go("b", 1);
    const bBody = () => document.querySelector(".thinking-body") as HTMLElement;
    (bBody().parentElement!.querySelector(".thinking-header") as HTMLElement).click();
    expect(bBody().classList.contains("collapsed")).toBe(false);

    go("a", 2); // a BIGGER session
    go("b", 3); // back to the small one: 4 -> 2 messages, but not a rewrite

    expect(bBody().classList.contains("collapsed")).toBe(false);
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

  it("a task row is a checkbox and its text — no number, no index column", async () => {
    // A checklist, not a table: the order of the rows IS the plan, and an index adds a column nobody
    // reads (it was there for one day). The count in the header carries the progress.
    await loadView();
    hostMessage({ type: "status", active: true });
    hostMessage({ type: "toolCall", id: "t1", name: "TodoWrite", arguments: { todos: [], merge: false } });
    hostMessage({
      type: "toolResult",
      toolCallId: "t1",
      output: "## Task List\n\n⏳ [pending] one\n✅ [completed] two",
      isError: false,
    });
    const rows = [...document.querySelectorAll(".todo-block .todo-item")];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect([...row.children].map((c) => c.className)).toEqual(["todo-check", "todo-text"]);
    }
    expect(document.querySelector(".todo-num")).toBeNull();
    expect(document.querySelector(".todo-block .todo-head")!.textContent).toBe("1/2Tasks");
  });

  it("a SUB-AGENT's TodoWrite never touches the pinned footer (the plan pinned is the orchestrator's)", async () => {
    // Sub-agents get TodoWrite (their tool list is everything but Delegate), and their events arrive
    // as `subagent_event` — a nested log line, not a tool result. That is the right ownership, but it
    // was ACCIDENTAL: this test makes it a rule, so a future refactor that funnels sub-agent results
    // through the common path cannot silently hand the footer to a sub-agent's plan.
    await loadView();
    hostMessage({ type: "status", active: true });
    hostMessage({ type: "toolCall", id: "d1", name: "Delegate", arguments: { goal: "do things" } });
    hostMessage({
      type: "subagentEvent",
      toolCallId: "d1",
      event: { type: "tool_call", toolCall: { id: "s1", name: "TodoWrite", arguments: {} } },
    });
    hostMessage({
      type: "subagentEvent",
      toolCallId: "d1",
      event: {
        type: "tool_result",
        toolResult: { toolCallId: "s1", output: "## Task List\n\n⏳ [pending] sub task", isError: false },
      },
    });
    // Not a list anywhere: no block in the transcript, and (with the footer gone) nothing else that
    // could claim to be "the plan of this conversation".
    expect(document.querySelectorAll(".todo-block")).toHaveLength(0);
    // …and it is not lost either: the call is visible as a nested line in the sub-agent log.
    expect(document.querySelector(".sa-tool")).toBeTruthy();
  });

  it("a DESTRUCTIVE answer asks once more, in the same dialog, and only then posts it", async () => {
    // The trash asks delete / rewind / empty — three answers that cannot be undone. Picking one is
    // not an answer any more: it turns the dialog into "are you sure?", with the consequences named
    // and the SAFE button focused, so a doubled Enter cannot confirm.
    await loadView();
    hostMessage({
      type: "modal",
      kind: "alert",
      modalId: 7,
      alertKind: "confirm",
      title: "Delete or empty session",
      message: "What do you want to do?",
      confirmText: "Delete",
      danger: true,
      confirm: {
        title: "Delete the session permanently?",
        message: "There is no undo.",
        confirmText: "Yes, delete it",
      },
      extraActions: [
        {
          value: "empty",
          text: "Empty",
          confirm: { title: "Empty the transcript?", message: "There is no undo.", confirmText: "Yes, empty it" },
        },
        { value: "keep", text: "Keep", title: "no consequences" },
      ],
    });
    const ok = document.getElementById("alert-ok") as HTMLButtonElement;
    const cancel = document.getElementById("alert-cancel") as HTMLButtonElement;
    const extras = (): HTMLButtonElement[] => [
      ...document.querySelectorAll<HTMLButtonElement>("#alert-modal .alert-extra"),
    ];
    const title = (): string => document.getElementById("alert-title")!.textContent ?? "";
    const byText = (t: string): HTMLButtonElement => extras().find((b) => b.textContent === t)!;

    posted.length = 0;
    // 1. A DESTRUCTIVE answer does not execute: the dialog changes question.
    byText("Empty").click();
    expect(posted).toHaveLength(0); // nothing answered yet
    expect(title()).toBe("Empty the transcript?");
    expect(ok.textContent).toBe("Yes, empty it");
    expect(extras()).toHaveLength(0); // the other answers are gone: it is a different question
    expect(document.activeElement).toBe(cancel); // the safe choice has the focus

    // 2. Confirming posts THAT answer (not `true`).
    ok.click();
    expect(posted).toContainEqual({ type: "modalResponse", id: 7, value: "empty" });

    // 3. Cancelling the second step answers nothing at all: the host sees `false` and leaves the
    //    session alone. It must NOT fall back to the previous answer.
    hostMessage({
      type: "modal",
      kind: "alert",
      modalId: 8,
      alertKind: "confirm",
      title: "Delete or empty session",
      message: "What do you want to do?",
      confirmText: "Delete",
      danger: true,
      extraActions: [{ value: "empty", text: "Empty", confirm: { title: "Empty?", message: "No undo." } }],
    });
    posted.length = 0;
    byText("Empty").click();
    cancel.click();
    expect(posted).toContainEqual({ type: "modalResponse", id: 8, value: false });
  });

  it("an alert can ASK for numbers: two sliders, answered as an object", async () => {
    await loadView();
    const reset = (): void => {
      posted.length = 0;
    };
    hostMessage({
      type: "modal",
      kind: "alert",
      modalId: 21,
      alertKind: "info",
      title: "Model limits unknown",
      message: "set the two values",
      confirmText: "Apply",
      fields: [
        { key: "contextWindow", label: "Context window", min: 1000, max: 2_048_000, step: 1000, value: 128_000 },
        { key: "outputTokens", label: "Max output tokens", min: 256, max: 512_000, step: 256, value: 16_384 },
      ],
    });
    const ok = document.getElementById("alert-ok") as HTMLButtonElement;
    const ranges = [...document.querySelectorAll<HTMLInputElement>("#alert-fields .num-range")];
    const values = (): string[] =>
      [...document.querySelectorAll("#alert-fields .num-value")].map((e) => e.textContent ?? "");
    const labels = (): string[] =>
      [...document.querySelectorAll("#alert-fields .alert-field-label")].map((e) => e.textContent ?? "");

    // Two sliders, each pre-filled with the value IN USE and showing its scale.
    expect(ranges).toHaveLength(2);
    expect(ranges[0].min).toBe("1000");
    expect(ranges[0].max).toBe("2048000");
    expect(ranges[1].min).toBe("256");
    expect(ranges[1].max).toBe("512000");
    expect(values()).toEqual(["128000", "16384"]);
    expect(labels()[0]).toContain("Context window");
    expect(labels()[0]).toContain("→");

    // Dragging updates the label live; OK answers with the TWO numbers, keyed as asked.
    ranges[0].value = "32000";
    ranges[0].dispatchEvent(new Event("input"));
    ranges[1].value = "4096";
    ranges[1].dispatchEvent(new Event("input"));
    expect(values()).toEqual(["32000", "4096"]);
    reset();
    ok.click();
    expect(posted).toContainEqual({
      type: "modalResponse",
      id: 21,
      value: { contextWindow: 32000, outputTokens: 4096 },
    });

    // The rows belong to the ALERT: the next plain one must not re-use them.
    hostMessage({ type: "modal", kind: "alert", modalId: 22, alertKind: "info", title: "Heads up", message: "done" });
    expect(document.querySelectorAll("#alert-fields .num-range")).toHaveLength(0);
    expect(document.getElementById("alert-fields")!.classList.contains("hidden")).toBe(true);
    reset();
    ok.click();
    expect(posted).toContainEqual({ type: "modalResponse", id: 22, value: true });
  });

  it("the PRIMARY answer has its second step too — and a plain alert keeps the old behaviour", async () => {
    await loadView();
    hostMessage({
      type: "modal",
      kind: "alert",
      modalId: 9,
      alertKind: "confirm",
      title: "Delete session",
      message: "Are you sure?",
      confirmText: "Delete",
      danger: true,
      confirm: { title: "Delete permanently?", message: "No undo.", confirmText: "Yes, delete it" },
    });
    const ok = document.getElementById("alert-ok") as HTMLButtonElement;
    posted.length = 0;
    ok.click();
    expect(posted).toHaveLength(0); // the first click only asks
    expect(document.getElementById("alert-title")!.textContent).toBe("Delete permanently?");
    ok.click();
    expect(posted).toContainEqual({ type: "modalResponse", id: 9, value: true });

    // No `confirm` declared = one click, as before: not every question is destructive.
    hostMessage({
      type: "modal",
      kind: "alert",
      modalId: 10,
      alertKind: "confirm",
      title: "Rename?",
      message: "sure?",
      confirmText: "OK",
    });
    posted.length = 0;
    (document.getElementById("alert-ok") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "modalResponse", id: 10, value: true });
  });

  it("shows chips for TodoWrite / WebSearch / WebFetch / ReadLints", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    hostMessage({
      type: "toolCall",
      id: "tdo",
      name: "TodoWrite",
      arguments: { todos: [{ id: "1", content: "fix parser", status: "pending" }], merge: false },
    });
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

  it("renders a TodoWrite result as a readable task list — one block, the newest state", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();

    hostMessage({
      type: "toolCall",
      id: "td1",
      name: "TodoWrite",
      arguments: { todos: [{ id: "1", content: "fix parser", status: "pending" }], merge: false },
    });
    hostMessage({
      type: "toolResult",
      toolCallId: "td1",
      output: "## Task List\n\n⏳ [pending] fix parser",
      isError: false,
    });

    const first = document.querySelector(".todo-block") as HTMLElement;
    expect(first).toBeTruthy();
    // The raw output stays behind the collapsed details — the LIST does not.
    expect(document.querySelector(".msg.tool .tool-details")?.classList.contains("collapsed")).toBe(true);
    expect(first.previousElementSibling?.classList.contains("tool-header")).toBe(true);
    expect(first.querySelector(".todo-count")?.textContent).toBe("0/1");
    expect(first.querySelectorAll(".todo-item")).toHaveLength(1);
    expect(first.querySelector(".todo-item")?.classList.contains("status-pending")).toBe(true);
    expect(first.querySelector(".todo-check")).toBeTruthy();
    expect(first.querySelector(".todo-text")?.textContent).toBe("fix parser");

    // A second update REPLACES the block: five stale copies is what made the list
    // invisible in the first place.
    hostMessage({ type: "toolCall", id: "td2", name: "TodoWrite", arguments: { todos: [], merge: true } });
    hostMessage({
      type: "toolResult",
      toolCallId: "td2",
      output: "## Task List\n\n✅ [completed] fix parser\n🔄 [in_progress] ship it",
      isError: false,
    });

    expect(document.querySelectorAll(".todo-block")).toHaveLength(1);
    const second = document.querySelector(".todo-block") as HTMLElement;
    expect(second.querySelector(".todo-count")?.textContent).toBe("1/2");
    expect(second.querySelectorAll(".todo-item")).toHaveLength(2);
    expect(second.querySelectorAll(".todo-item.status-completed")).toHaveLength(1);
    expect(second.querySelectorAll(".todo-item.status-in_progress")).toHaveLength(1);
    // The task text is MODEL data: it lands as text, never as markup.
    expect(second.querySelectorAll(".todo-text")[0].textContent).toBe("fix parser");
    expect(second.querySelectorAll(".todo-check")).toHaveLength(2);
    // Ticked only where it is completed; the in-progress box stays empty (its dot is CSS).
    expect(second.querySelectorAll(".todo-check svg")).toHaveLength(1);
  });

  it("does not turn another tool's output into a task list", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    // The text LOOKS like a list: only the tool NAME decides.
    hostMessage({ type: "toolCall", id: "rd1", name: "Read", arguments: { path: "a.ts" } });
    hostMessage({ type: "toolResult", toolCallId: "rd1", output: "## Task List\n\n✅ [completed] x", isError: false });
    expect(document.querySelector(".todo-block")).toBeNull();
  });

  it("rebuilds ONE task list from a replayed transcript (the newest call wins)", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [
        {
          role: "assistant",
          content: "🔧 Tools: TodoWrite",
          timestamp: 1,
          toolCalls: [
            {
              id: "td1",
              name: "TodoWrite",
              arguments: { todos: [{ id: "1", content: "fix parser", status: "pending" }] },
            },
          ],
        },
        { role: "tool", toolCallId: "td1", content: "## Task List\n\n⏳ [pending] fix parser", timestamp: 2 },
        {
          role: "assistant",
          content: "🔧 Tools: TodoWrite",
          timestamp: 3,
          toolCalls: [{ id: "td2", name: "TodoWrite", arguments: { todos: [], merge: true } }],
        },
        {
          role: "tool",
          toolCallId: "td2",
          content: "## Task List\n\n✅ [completed] fix parser\n⏳ [pending] ship it",
          timestamp: 4,
        },
      ],
    });
    // The same rule as the live path: a reload must not resurrect five stale lists.
    expect(document.querySelectorAll(".todo-block")).toHaveLength(1);
    const block = document.querySelector(".todo-block") as HTMLElement;
    expect(block.querySelector(".todo-count")?.textContent).toBe("1/2");
    expect(block.querySelectorAll(".todo-item")).toHaveLength(2);
    expect(block.querySelectorAll(".todo-item.status-completed")).toHaveLength(1);
  });

  it("keeps a task's text as TEXT — a todo is model data, never markup", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    hostMessage({ type: "toolCall", id: "td5", name: "TodoWrite", arguments: { todos: [] } });
    hostMessage({
      type: "toolResult",
      toolCallId: "td5",
      output: '## Task List\n\n[pending] <img src=x onerror="boom()"> **not bold**',
      isError: false,
    });
    const block = document.querySelector(".todo-block") as HTMLElement;
    expect(block.querySelector("img")).toBeNull();
    expect(block.querySelector("strong")).toBeNull();
    expect(block.querySelector(".todo-text")?.textContent).toBe('<img src=x onerror="boom()"> **not bold**');
  });

  it("shows no task list when the result has no recognisable status", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    // A changed result shape must degrade to "no list", never to a broken one.
    hostMessage({ type: "toolCall", id: "td6", name: "TodoWrite", arguments: { todos: [] } });
    hostMessage({ type: "toolResult", toolCallId: "td6", output: "## Task List\n\nnothing to do", isError: false });
    expect(document.querySelector(".todo-block")).toBeNull();
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
    const liveBlock = document.querySelector(".thinking-block") as HTMLElement;
    // Live: the collapsed thinking block pulses while it reasons.
    expect(liveBlock.classList.contains("streaming")).toBe(true);
    hostMessage({ type: "toolCall", id: "c1", name: "read_file", arguments: { path: "/x" } });
    // Switching to a tool phase settles the thinking (no more animation).
    expect(liveBlock.classList.contains("streaming")).toBe(false);
    expect(liveBlock.classList.contains("settling")).toBe(true);
    hostMessage({ type: "toolResult", toolCallId: "c1", output: "content", isError: false });
    hostMessage({ type: "textDelta", content: "Answers" });
    hostMessage({ type: "done" });

    // Thinking stays as a collapsed block even while/after streaming,
    // tool details collapsed, result last.
    const thinking = document.querySelector(".thinking-block .thinking-body") as HTMLElement;
    expect(thinking.classList.contains("collapsed")).toBe(true);
    expect((document.querySelector(".thinking-header .toggle") as HTMLElement).classList.contains("is-open")).toBe(
      false,
    );
    const tool = document.querySelector(".msg.tool") as HTMLElement;
    expect(tool.textContent).toContain("read_file");
    expect(tool.querySelector(".tool-details")?.classList.contains("collapsed")).toBe(true);
    expect(tool.querySelector(".tool-name")?.textContent).toContain("read_file");
    // …and the unknown mark is DRAWN now, not an emoji: one artwork family, same 13px box.
    expect(tool.querySelector(".tool-name svg")).toBeTruthy();
    expect(tool.querySelector(".tool-name")?.textContent).not.toContain("🔧");
    // final answer is the last assistant bubble
    expect(messagesElLastContent()).toContain("Answers");
  });

  it("gives a tool call the mark of ITS tool, not a generic wrench", async () => {
    await loadView();
    hostMessage({ type: "toolCall", id: "t1", name: "StrReplace", arguments: { path: "a.ts" } });
    hostMessage({ type: "toolCall", id: "t2", name: "mcp__fs__read_file", arguments: { path: "b.ts" } });
    const [swap, plug] = Array.from(document.querySelectorAll(".msg.tool .tool-name")) as HTMLElement[];

    // A known tool wears its own artwork and no emoji at all…
    expect(swap.querySelector("svg")).toBeTruthy();
    expect(swap.textContent).toContain("StrReplace");
    expect(swap.textContent).not.toContain("🔧");

    // …every MCP tool wears the same plug, whatever the server calls it…
    expect(plug.querySelector("svg")).toBeTruthy();
    expect(plug.querySelector("svg")?.innerHTML).toContain("M5.5 7.5h13"); // the plug body
    expect(plug.textContent).toContain("mcp__fs__read_file");
  });

  it("marks a name that carried the ARGUMENTS instead of painting it as a tool", async () => {
    // A real transcript: a provider handed over a second call named `Greplike" string="true`
    // (the arguments landed in the name field). Painted like any other tool, that bubble read
    // as "Grep has no icon" — it is not Grep, and it is not a tool at all.
    await loadView();
    hostMessage({ type: "toolCall", id: "bad", name: 'Greplike" string="true', arguments: {} });
    const card = document.querySelector(".msg.tool") as HTMLElement;
    const name = card.querySelector(".tool-name") as HTMLElement;

    // The wrongness is said in the header itself, not only in the output.
    expect(card.dataset.toolInvalid).toBe("1");
    expect(name.textContent).toContain('Greplike" string="true');
    // A real tool is NOT marked: the rule must not leak onto every bubble.
    hostMessage({ type: "toolCall", id: "good", name: "Grep", arguments: { pattern: "x" } });
    const cards = document.querySelectorAll(".msg.tool");
    expect((cards[cards.length - 1] as HTMLElement).dataset.toolInvalid).toBeUndefined();
  });

  it("clamps a runaway name but keeps the whole text in the title", async () => {
    // Unclamped, a 200-char "name" pushes the header apart and the reader cannot tell where
    // the name ends; the title is where the exact emission stays available.
    await loadView();
    const long = "Grep" + "x".repeat(200);
    hostMessage({ type: "toolCall", id: "long", name: long, arguments: {} });
    const name = document.querySelector(".msg.tool .tool-name") as HTMLElement;

    expect(name.textContent).toContain("…");
    expect(name.textContent).not.toContain(long);
    expect(name.getAttribute("title")).toBe(long);
  });

  it("renders a dedicated sub-agent bubble for Delegate calls with a live status", async () => {
    await loadView();
    hostMessage(PARALLEL_ON);
    hostMessage({
      type: "toolCall",
      id: "s1",
      name: "Delegate",
      arguments: {
        id: "A",
        goal: "Analyze src/fetch.ts",
        access: "read",
        resources: ["src/fetch.ts"],
        parallel: "yes",
        role: "analyst",
      },
    });
    const bubble = document.querySelector(".msg.tool.subagent") as HTMLElement;
    expect(bubble).toBeTruthy();
    // A placeholder id ("A") is REPLACED by the goal snippet, so the header
    // says what the sub-agent does; the full goal stays in the title.
    expect(bubble.querySelector(".tool-name")?.textContent).toContain('Sub-agent "Analyze src/fetch.ts"');
    expect(bubble.querySelector(".subagent-name")?.textContent).toContain("Analyze src/fetch.ts");
    expect(bubble.querySelector(".subagent-role")?.textContent).toBe("analyst");
    expect(bubble.querySelector(".subagent-goal")?.textContent).toContain("Analyze src/fetch.ts");
    // A freshly-planned delegate is QUEUED (the cap may hold it back); it only
    // flips to running when the host says it actually started.
    expect(bubble.querySelector(".subagent-status")?.classList.contains("queued")).toBe(true);
    expect(bubble.querySelector(".subagent-chip.access-read")).toBeTruthy();
    expect(bubble.querySelector(".subagent-chip.parallel")).toBeTruthy();
    expect([...bubble.querySelectorAll(".subagent-chip.res")].map((c) => c.textContent)).toEqual(["src/fetch.ts"]);

    hostMessage({ type: "subagentStart", toolCallId: "s1" });
    expect(bubble.querySelector(".subagent-status")?.classList.contains("running")).toBe(true);
    // The BUBBLE pulses while running (phase-locked to the shared clock), not
    // the status chip.
    expect(bubble.classList.contains("subagent-running")).toBe(true);
    expect(bubble.style.animationDelay).not.toBe("");

    hostMessage({ type: "toolResult", toolCallId: "s1", output: '🔁 Sub-agent "A" report:\nfindings', isError: false });
    expect(bubble.querySelector(".subagent-status")?.classList.contains("done")).toBe(true);
    // Pulse settled: no longer running, fading back to its resting edge.
    expect(bubble.classList.contains("subagent-running")).toBe(false);
    expect(bubble.classList.contains("subagent-settling")).toBe(true);
    expect(bubble.style.animationDelay).toBe("");
    expect(bubble.querySelector(".tool-result")?.textContent).toContain("findings");
  });

  it("streams a sub-agent's live thinking/text/tools into its bubble", async () => {
    await loadView();
    hostMessage(PARALLEL_ON);
    hostMessage({
      type: "toolCall",
      id: "s1",
      name: "Delegate",
      arguments: { id: "A", goal: "g", access: "read", resources: ["a.ts"] },
    });
    hostMessage({ type: "subagentStart", toolCallId: "s1" });
    hostMessage({ type: "subagentEvent", toolCallId: "s1", event: { type: "thinking_delta", content: "reasoning" } });
    hostMessage({
      type: "subagentEvent",
      toolCallId: "s1",
      event: { type: "tool_call", toolCall: { id: "t1", name: "Read", arguments: { path: "a.ts" } } },
    });
    hostMessage({
      type: "subagentEvent",
      toolCallId: "s1",
      event: { type: "tool_result", toolResult: { toolCallId: "t1", output: "data", isError: false } },
    });
    hostMessage({ type: "subagentEvent", toolCallId: "s1", event: { type: "text_delta", content: "partial answer" } });

    const bubble = document.querySelector(".msg.tool.subagent") as HTMLElement;
    expect(bubble.querySelector(".sa-thinking")?.textContent).toContain("reasoning");
    const tool = bubble.querySelector(".sa-tool") as HTMLElement;
    expect(tool.textContent).toContain("Read");
    expect(tool.classList.contains("ok")).toBe(true);
    expect(bubble.querySelector(".sa-answer")?.textContent).toContain("partial answer");
  });

  it("keeps the nested answer in ONE block when the sub-agent reasons mid-answer (same rule as the chat)", async () => {
    // The nested stream and the main transcript must follow the SAME rule: a reasoning
    // phase never splits an answer. This one was already right (it accumulates into one
    // .sa-answer); the chat stream was not. Pinned here so they cannot drift apart again.
    await loadView();
    hostMessage(PARALLEL_ON);
    hostMessage({
      type: "toolCall",
      id: "s1",
      name: "Delegate",
      arguments: { id: "A", goal: "g", access: "read", resources: ["a.ts"] },
    });
    hostMessage({ type: "subagentStart", toolCallId: "s1" });

    hostMessage({
      type: "subagentEvent",
      toolCallId: "s1",
      event: { type: "text_delta", content: "I read the files and " },
    });
    hostMessage({
      type: "subagentEvent",
      toolCallId: "s1",
      event: { type: "thinking_delta", content: "now let me sort out my thoughts" },
    });
    hostMessage({
      type: "subagentEvent",
      toolCallId: "s1",
      event: { type: "text_delta", content: "I conclude it is fine." },
    });

    const answers = document.querySelectorAll(".sa-answer");
    expect(answers).toHaveLength(1);
    expect(answers[0].textContent).toContain("I read the files and I conclude it is fine.");
    expect(document.querySelector(".sa-thinking")?.textContent).toContain("now let me sort out my thoughts");
  });

  it("sub-agent bubbles are collapsed by default and expand on click", async () => {
    await loadView();
    hostMessage(PARALLEL_ON);
    hostMessage({
      type: "toolCall",
      id: "s1",
      name: "Delegate",
      arguments: { id: "A", goal: "g", access: "read", resources: ["a.ts"] },
    });
    const bubble = document.querySelector(".msg.tool.subagent") as HTMLElement;
    const body = bubble.querySelector(".subagent-body") as HTMLElement;
    expect(body.classList.contains("collapsed")).toBe(true);
    expect(bubble.querySelector(".tool-toggle")?.classList.contains("is-open") ?? false).toBe(false);

    (bubble.querySelector(".subagent-header") as HTMLElement).click();
    expect(body.classList.contains("collapsed")).toBe(false);
    expect(bubble.querySelector(".tool-toggle")?.classList.contains("is-open") ?? false).toBe(true);
  });

  it("marks a failed nested tool line in red", async () => {
    await loadView();
    hostMessage(PARALLEL_ON);
    hostMessage({
      type: "toolCall",
      id: "s1",
      name: "Delegate",
      arguments: { id: "A", goal: "g", access: "read", resources: ["a.ts"] },
    });
    hostMessage({
      type: "subagentEvent",
      toolCallId: "s1",
      event: { type: "tool_call", toolCall: { id: "t1", name: "Read", arguments: {} } },
    });
    hostMessage({
      type: "subagentEvent",
      toolCallId: "s1",
      event: { type: "tool_result", toolResult: { toolCallId: "t1", output: "boom", isError: true } },
    });
    const tool = document.querySelector(".sa-tool") as HTMLElement;
    expect(tool.classList.contains("err")).toBe(true);
  });

  it("ignores nested events for an unknown sub-agent (no crash, no log)", async () => {
    await loadView();
    expect(() =>
      hostMessage({ type: "subagentEvent", toolCallId: "nope", event: { type: "text_delta", content: "x" } }),
    ).not.toThrow();
    expect(document.querySelector(".sa-log")).toBe(null);
  });

  it("routes nested events to the right bubble when several sub-agents run", async () => {
    await loadView();
    hostMessage(PARALLEL_ON);
    hostMessage({
      type: "toolCall",
      id: "s1",
      name: "Delegate",
      arguments: { id: "A", goal: "a", access: "read", resources: ["a.ts"] },
    });
    hostMessage(PARALLEL_ON);
    hostMessage({
      type: "toolCall",
      id: "s2",
      name: "Delegate",
      arguments: { id: "B", goal: "b", access: "read", resources: ["b.ts"] },
    });
    hostMessage({ type: "subagentEvent", toolCallId: "s1", event: { type: "text_delta", content: "alpha" } });
    hostMessage({ type: "subagentEvent", toolCallId: "s2", event: { type: "text_delta", content: "beta" } });
    const bubbles = document.querySelectorAll(".msg.tool.subagent");
    expect(bubbles[0].querySelector(".sa-answer")?.textContent?.trim()).toBe("alpha");
    expect(bubbles[1].querySelector(".sa-answer")?.textContent?.trim()).toBe("beta");
  });

  it("flips a sub-agent to done as soon as its own done event arrives", async () => {
    await loadView();
    hostMessage(PARALLEL_ON);
    hostMessage({
      type: "toolCall",
      id: "s1",
      name: "Delegate",
      arguments: { id: "A", goal: "a", access: "read", resources: ["a.ts"] },
    });
    hostMessage({ type: "subagentStart", toolCallId: "s1" });
    const bubble = document.querySelector(".msg.tool.subagent") as HTMLElement;
    expect(bubble.querySelector(".subagent-status")?.classList.contains("running")).toBe(true);
    // No parent toolResult yet — the sub-agent's own done flips it.
    hostMessage({ type: "subagentEvent", toolCallId: "s1", event: { type: "done" } });
    expect(bubble.querySelector(".subagent-status")?.classList.contains("done")).toBe(true);
  });

  it("marks each sub-agent done individually when its own done arrives", async () => {
    await loadView();
    hostMessage(PARALLEL_ON);
    hostMessage({
      type: "toolCall",
      id: "s1",
      name: "Delegate",
      arguments: { id: "A", goal: "a", access: "read", resources: ["a.ts"] },
    });
    hostMessage(PARALLEL_ON);
    hostMessage({
      type: "toolCall",
      id: "s2",
      name: "Delegate",
      arguments: { id: "B", goal: "b", access: "read", resources: ["b.ts"] },
    });
    hostMessage({ type: "subagentStart", toolCallId: "s1" });
    hostMessage({ type: "subagentStart", toolCallId: "s2" });
    const bubbles = document.querySelectorAll(".msg.tool.subagent");
    hostMessage({ type: "subagentEvent", toolCallId: "s2", event: { type: "done" } });
    expect(bubbles[0].querySelector(".subagent-status")?.classList.contains("running")).toBe(true);
    expect(bubbles[1].querySelector(".subagent-status")?.classList.contains("done")).toBe(true);
  });

  it("marks a sub-agent failed on its own error event", async () => {
    await loadView();
    hostMessage(PARALLEL_ON);
    hostMessage({
      type: "toolCall",
      id: "s1",
      name: "Delegate",
      arguments: { id: "A", goal: "a", access: "read", resources: ["a.ts"] },
    });
    hostMessage({ type: "subagentEvent", toolCallId: "s1", event: { type: "error", error: "boom" } });
    const bubble = document.querySelector(".msg.tool.subagent") as HTMLElement;
    expect(bubble.querySelector(".subagent-status")?.classList.contains("failed")).toBe(true);
  });

  it("pulses a running sub-agent's bubble (phase-locked) and settles it on a terminal state", async () => {
    vi.useFakeTimers();
    try {
      await loadView();
      hostMessage(PARALLEL_ON);
      hostMessage({
        type: "toolCall",
        id: "s1",
        name: "Delegate",
        arguments: { id: "A", goal: "g", access: "read", resources: ["a.ts"] },
      });
      const bubble = document.querySelector(".msg.tool.subagent") as HTMLElement;
      // Queued: the bubble does NOT pulse yet.
      expect(bubble.classList.contains("subagent-running")).toBe(false);
      expect(bubble.classList.contains("subagent-settling")).toBe(false);

      hostMessage({ type: "subagentStart", toolCallId: "s1" });
      expect(bubble.classList.contains("subagent-running")).toBe(true);
      expect(bubble.style.animationDelay).not.toBe(""); // phase-locked to the shared clock

      // A terminal state (here: its own error) settles the pulse.
      hostMessage({ type: "subagentEvent", toolCallId: "s1", event: { type: "error", error: "boom" } });
      expect(bubble.classList.contains("subagent-running")).toBe(false);
      expect(bubble.classList.contains("subagent-settling")).toBe(true);
      expect(bubble.style.animationDelay).toBe("");

      // The settling class is removed once the ~0.7s fade is over.
      vi.advanceTimersByTime(750);
      expect(bubble.classList.contains("subagent-settling")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders markdown inside the sub-agent live stream (thinking + answer)", async () => {
    await loadView();
    hostMessage(PARALLEL_ON);
    hostMessage({
      type: "toolCall",
      id: "s1",
      name: "Delegate",
      arguments: { id: "A", goal: "g", access: "read", resources: ["a.ts"] },
    });
    hostMessage({ type: "subagentEvent", toolCallId: "s1", event: { type: "thinking_delta", content: "**plan**" } });
    hostMessage({
      type: "subagentEvent",
      toolCallId: "s1",
      event: { type: "text_delta", content: "result: `x`\n\n- a\n- b" },
    });

    const bubble = document.querySelector(".msg.tool.subagent") as HTMLElement;
    // Thinking + answer are rendered as Markdown (strong / inline code / list).
    expect(bubble.querySelector(".sa-thinking strong")?.textContent).toBe("plan");
    expect(bubble.querySelector(".sa-answer code")?.textContent).toBe("x");
    expect(bubble.querySelectorAll(".sa-answer li").length).toBe(2);
  });

  it("renders the sub-agent REPORT as markdown", async () => {
    await loadView();
    hostMessage(PARALLEL_ON);
    hostMessage({
      type: "toolCall",
      id: "s1",
      name: "Delegate",
      arguments: { id: "A", goal: "g", access: "read", resources: ["a.ts"] },
    });
    hostMessage({
      type: "toolResult",
      toolCallId: "s1",
      output: '🔁 Sub-agent "A" report:\n**findings** with `code` and\n\n- one\n- two',
      isError: false,
    });
    const bubble = document.querySelector(".msg.tool.subagent") as HTMLElement;
    const report = bubble.querySelector(".subagent-report") as HTMLElement;
    expect(report.querySelector("strong")?.textContent).toBe("findings");
    expect(report.querySelector("code")?.textContent).toBe("code");
    expect(report.querySelectorAll("li").length).toBe(2);
  });

  it("renders a Delegate call as a sub-agent bubble even before the Parallel config arrives (no race)", async () => {
    await loadView();
    // No config push yet: the Delegate call must STILL be a sub-agent bubble
    // (the host hides the tool when Parallel is off, so the UI never gates on it).
    hostMessage({
      type: "toolCall",
      id: "s1",
      name: "Delegate",
      arguments: { id: "A", goal: "g", access: "read", resources: ["a.ts"] },
    });
    expect(document.querySelector(".msg.tool.subagent")).toBeTruthy();
  });

  it("keeps the FULL sub-agent stream text (never trims from the top)", async () => {
    await loadView();
    hostMessage(PARALLEL_ON);
    hostMessage({
      type: "toolCall",
      id: "s1",
      name: "Delegate",
      arguments: { id: "A", goal: "g", access: "read", resources: ["a.ts"] },
    });
    hostMessage({
      type: "subagentEvent",
      toolCallId: "s1",
      event: { type: "text_delta", content: "HEAD-MARKER" + "x".repeat(3000) },
    });
    const a = document.querySelector(".sa-answer") as HTMLElement;
    expect(a.textContent).toContain("HEAD-MARKER");
    expect(a.textContent!.length).toBeGreaterThan(3000);
  });

  it("maps a stopped sub-agent to the single terminal 'aborted' state (legacy 'interrupted' too)", async () => {
    await loadView();
    hostMessage(PARALLEL_ON);
    hostMessage({
      type: "toolCall",
      id: "s1",
      name: "Delegate",
      arguments: { id: "A", goal: "g", access: "read", resources: ["a.ts"] },
    });
    hostMessage({ type: "subagentStart", toolCallId: "s1" });
    hostMessage({ type: "toolResult", toolCallId: "s1", output: '⏹ Sub-agent "A" interrupted.', isError: true });
    const bubble = document.querySelector(".msg.tool.subagent") as HTMLElement;
    expect(bubble.querySelector(".subagent-status")?.classList.contains("aborted")).toBe(true);
    // Terminal states settle the pulse too (it was running before the stop).
    expect(bubble.classList.contains("subagent-running")).toBe(false);
    expect(bubble.classList.contains("subagent-settling")).toBe(true);
  });

  it("marks an INDIVIDUALLY aborted sub-agent as aborted (not interrupted)", async () => {
    await loadView();
    hostMessage(PARALLEL_ON);
    hostMessage({
      type: "toolCall",
      id: "s1",
      name: "Delegate",
      arguments: { id: "A", goal: "g", access: "read", resources: ["a.ts"] },
    });
    hostMessage({ type: "subagentStart", toolCallId: "s1" });
    hostMessage({
      type: "toolResult",
      toolCallId: "s1",
      output: '⏹ Sub-agent "A" aborted by the user.',
      isError: true,
    });
    const bubble = document.querySelector(".msg.tool.subagent") as HTMLElement;
    expect(bubble.querySelector(".subagent-status")?.classList.contains("aborted")).toBe(true);
  });

  it("abort button on a running sub-agent posts abortSubAgent with its tool-call id", async () => {
    await loadView();
    hostMessage(PARALLEL_ON);
    hostMessage({
      type: "toolCall",
      id: "s1",
      name: "Delegate",
      arguments: { id: "A", goal: "g", access: "read", resources: ["a.ts"] },
    });
    hostMessage({ type: "subagentStart", toolCallId: "s1" });
    const bubble = document.querySelector(".msg.tool.subagent") as HTMLElement;
    const body = bubble.querySelector(".subagent-body") as HTMLElement;
    const btn = bubble.querySelector(".subagent-abort") as HTMLButtonElement;
    expect(btn.hidden).toBe(false);
    expect(body.classList.contains("collapsed")).toBe(true);
    btn.click();
    // Targets this sub-agent only, and does NOT toggle the collapsible body.
    expect(posted).toContainEqual({ type: "abortSubAgent", toolCallId: "s1" });
    expect(body.classList.contains("collapsed")).toBe(true);
    expect(btn.disabled).toBe(true);
  });

  it("hides the abort button once the sub-agent reaches a terminal state", async () => {
    await loadView();
    hostMessage(PARALLEL_ON);
    hostMessage({
      type: "toolCall",
      id: "s1",
      name: "Delegate",
      arguments: { id: "A", goal: "g", access: "read", resources: ["a.ts"] },
    });
    hostMessage({ type: "subagentStart", toolCallId: "s1" });
    hostMessage({ type: "toolResult", toolCallId: "s1", output: '🔁 Sub-agent "A" report:\ndone', isError: false });
    const bubble = document.querySelector(".msg.tool.subagent") as HTMLElement;
    expect((bubble.querySelector(".subagent-abort") as HTMLButtonElement).hidden).toBe(true);
  });

  it("shows the abort button while a sub-agent is still queued (before it starts)", async () => {
    await loadView();
    hostMessage(PARALLEL_ON);
    hostMessage({
      type: "toolCall",
      id: "s1",
      name: "Delegate",
      arguments: { id: "A", goal: "g", access: "read", resources: ["a.ts"] },
    });
    const bubble = document.querySelector(".msg.tool.subagent") as HTMLElement;
    const btn = bubble.querySelector(".subagent-abort") as HTMLButtonElement;
    expect(bubble.querySelector(".subagent-status")?.classList.contains("queued")).toBe(true);
    expect(btn.hidden).toBe(false);
    btn.click();
    expect(posted).toContainEqual({ type: "abortSubAgent", toolCallId: "s1" });
  });

  it("marks a queued (never-started) sub-agent as aborted", async () => {
    await loadView();
    hostMessage(PARALLEL_ON);
    hostMessage({
      type: "toolCall",
      id: "s1",
      name: "Delegate",
      arguments: { id: "A", goal: "g", access: "read", resources: ["a.ts"] },
    });
    // No subagentStart: it stayed queued, then Stop arrived.
    hostMessage({
      type: "toolResult",
      toolCallId: "s1",
      output: "⏹ aborted before running (Parallel stopped).",
      isError: true,
    });
    const bubble = document.querySelector(".msg.tool.subagent") as HTMLElement;
    expect(bubble.querySelector(".subagent-status")?.classList.contains("aborted")).toBe(true);
  });

  it("after Stop: finished -> done, running/queued -> aborted", async () => {
    await loadView();
    hostMessage(PARALLEL_ON);
    for (const id of ["s1", "s2", "s3"]) {
      hostMessage({
        type: "toolCall",
        id,
        name: "Delegate",
        arguments: { id, goal: "g", access: "read", resources: ["a.ts"] },
      });
    }
    hostMessage({ type: "subagentStart", toolCallId: "s1" });
    hostMessage({ type: "subagentStart", toolCallId: "s2" });
    // s1 finished before Stop; s2 was running; s3 was queued.
    hostMessage({ type: "toolResult", toolCallId: "s1", output: '🔁 Sub-agent "s1" report:\ndone', isError: false });
    hostMessage({ type: "toolResult", toolCallId: "s2", output: '⏹ Sub-agent "s2" interrupted.', isError: true });
    hostMessage({
      type: "toolResult",
      toolCallId: "s3",
      output: "⏹ aborted before running (Parallel stopped).",
      isError: true,
    });

    const bubbles = document.querySelectorAll(".msg.tool.subagent");
    expect(bubbles[0].querySelector(".subagent-status")?.classList.contains("done")).toBe(true);
    expect(bubbles[1].querySelector(".subagent-status")?.classList.contains("aborted")).toBe(true);
    expect(bubbles[2].querySelector(".subagent-status")?.classList.contains("aborted")).toBe(true);
  });

  it("uses a robot SVG icon in the sub-agent bubble header", async () => {
    await loadView();
    hostMessage(PARALLEL_ON);
    hostMessage({
      type: "toolCall",
      id: "s1",
      name: "Delegate",
      arguments: { id: "A", goal: "g", access: "read", resources: ["a.ts"] },
    });
    const bubble = document.querySelector(".msg.tool.subagent") as HTMLElement;
    const icon = bubble.querySelector(".tool-name .subagent-icon");
    expect(icon).toBeTruthy();
    expect(icon?.querySelector("rect")).toBeTruthy(); // robot body
  });

  it("keeps a DESCRIPTIVE sub-agent id and still shows its goal in the header", async () => {
    await loadView();
    hostMessage({
      type: "toolCall",
      id: "s2",
      name: "Delegate",
      arguments: { id: "login-ui", goal: "Build the login form", access: "create", resources: ["src/login.tsx"] },
    });
    const bubble = document.querySelector(".msg.tool.subagent") as HTMLElement;
    expect(bubble.querySelector(".tool-name")?.textContent).toContain('Sub-agent "login-ui"');
    // ...and the goal is right there, so it is clear what it does.
    expect(bubble.querySelector(".subagent-name")?.textContent).toContain("Build the login form");
  });

  it("shows the WHOLE goal in the header: no fixed character cut, the CSS clips it", async () => {
    // How much of the goal fits is a question about the PANEL width, so the preview
    // carries the full text and the ellipsis decides where to stop (it travels left
    // as the panel narrows). A 60-character cut would clip a wide panel for nothing
    // and still overflow a narrow one.
    await loadView();
    hostMessage(PARALLEL_ON);
    const goal =
      "Refactor the authentication module, extract the token store, add refresh-token support " +
      "and update every caller across the workspace including the tests";
    hostMessage({
      type: "toolCall",
      id: "s1",
      name: "Delegate",
      arguments: { id: "auth", goal, access: "write", resources: ["src/auth"] },
    });

    const preview = document.querySelector(".subagent-name") as HTMLElement;
    expect(preview.textContent).toBe(goal); // nothing removed, no ellipsis added
    expect(preview.textContent).not.toContain("…");
    // The full text stays one hover away.
    expect(preview.getAttribute("title")).toBe(goal);
  });

  it("marks a failed sub-agent as failed", async () => {
    await loadView();
    hostMessage(PARALLEL_ON);
    hostMessage({
      type: "toolCall",
      id: "s1",
      name: "Delegate",
      arguments: { id: "A", goal: "edit", access: "write", resources: ["a.ts"] },
    });
    hostMessage({ type: "toolResult", toolCallId: "s1", output: '🔁 Sub-agent "A" failed: boom', isError: true });
    const bubble = document.querySelector(".msg.tool.subagent") as HTMLElement;
    expect(bubble.querySelector(".subagent-status")?.classList.contains("failed")).toBe(true);
  });

  it("re-renders sub-agent bubbles from the transcript with a done status", async () => {
    await loadView();
    hostMessage(PARALLEL_ON);
    hostMessage({
      type: "refresh",
      messages: [
        { role: "user", content: "go", timestamp: 1 },
        {
          role: "assistant",
          content: "🔧 Tools: Delegate",
          timestamp: 2,
          toolCalls: [
            { id: "s1", name: "Delegate", arguments: { id: "A", goal: "do it", access: "read", resources: ["a.ts"] } },
          ],
        },
        { role: "tool", toolCallId: "s1", content: '🔁 Sub-agent "A" report:\ndone', timestamp: 3 },
        { role: "assistant", content: "final", timestamp: 4 },
      ],
    });
    const bubble = document.querySelector(".msg.tool.subagent") as HTMLElement;
    expect(bubble).toBeTruthy();
    expect(bubble.querySelector(".subagent-status")?.classList.contains("done")).toBe(true);
    expect(bubble.querySelector(".tool-result")?.textContent).toContain("done");
  });

  it("hides the abort button when replaying a finished sub-agent from the transcript", async () => {
    await loadView();
    hostMessage(PARALLEL_ON);
    hostMessage({
      type: "refresh",
      messages: [
        {
          role: "assistant",
          content: "🔧 Tools: Delegate",
          timestamp: 1,
          toolCalls: [
            { id: "s1", name: "Delegate", arguments: { id: "A", goal: "do it", access: "read", resources: ["a.ts"] } },
          ],
        },
        { role: "tool", toolCallId: "s1", content: '🔁 Sub-agent "A" report:\ndone', timestamp: 2 },
      ],
    });
    const bubble = document.querySelector(".msg.tool.subagent") as HTMLElement;
    expect(bubble.querySelector(".subagent-status")?.classList.contains("done")).toBe(true);
    expect((bubble.querySelector(".subagent-abort") as HTMLButtonElement).hidden).toBe(true);
  });

  it("renders the model modal grouped by provider and posts setModel on click", async () => {
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
    // The selector BUTTON names the GATEWAY first, then the model it serves.
    const label = document.getElementById("model-btn-label") as HTMLElement;
    expect(label.querySelector(".mb-provider")?.textContent).toBe("opencode-go");
    expect(label.textContent).toBe("opencode-go · deepseek-v4-flash · - · out -");
    expect((document.getElementById("model-btn") as HTMLButtonElement).title).toContain(
      "opencode-go · deepseek-v4-flash",
    );

    (document.getElementById("model-btn") as HTMLButtonElement).click();
    const list = document.getElementById("model-list") as HTMLElement;
    const names = [...list.querySelectorAll(".mm-model")].map((m) => m.querySelector(".mm-model-name")?.textContent);
    expect(names).toEqual(["LLM/gemma.gguf", "deepseek-v4-flash", "deepseek-v4-pro"]);
    expect(list.querySelector(".mm-model.is-current")?.textContent).toContain("deepseek-v4-flash");

    const local = [...list.querySelectorAll<HTMLButtonElement>(".mm-model")].find((m) =>
      m.textContent?.includes("LLM/gemma.gguf"),
    )!;
    local.click();
    expect(posted).toContainEqual({ type: "setModel", model: "LLM/gemma.gguf", provider: "llamacpp" });
    expect((document.getElementById("model-modal") as HTMLElement).classList.contains("hidden")).toBe(true);
  });

  it("the button names the provider that WILL serve, not the one the last session used", async () => {
    // `activeProvider` is authoritative when the model exists there, but a model saved on another
    // gateway must name THAT gateway: the button is a promise about who answers the next message.
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai-compatible",
        activeProvider: "openrouter",
        model: "LLM/gemma.gguf",
        hasKey: true,
        providerModels: [
          { provider: "openrouter", model: "qwen/qwen3.8" },
          { provider: "llamacpp", model: "LLM/gemma.gguf", contextLength: 32768 },
        ],
      },
    });
    const label = document.getElementById("model-btn-label") as HTMLElement;
    expect(label.querySelector(".mb-provider")?.textContent).toBe("llamacpp");
    expect(label.textContent).toBe("llamacpp · LLM/gemma.gguf · 33k · out -");
  });

  it("a flat model list has no provider to name, so the label starts with the model", async () => {
    // The pre-`providerModels` hosts send one bare list: no provider, and above all no dangling
    // separator in front of the model name.
    await loadView();
    hostMessage({
      type: "config",
      config: { provider: "openai-compatible", model: "gpt-4o", hasKey: true, models: ["gpt-4o", "gpt-4o-mini"] },
    });
    const label = document.getElementById("model-btn-label") as HTMLElement;
    expect(label.querySelector(".mb-provider")).toBeNull();
    expect(label.textContent).toBe("gpt-4o · - · out -");
  });

  it("filters the model modal keeping the provider tree (only matches remain)", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai-compatible",
        activeProvider: "openrouter",
        model: "qwen/qwen3.8",
        hasKey: true,
        models: [],
        providerModels: [
          { provider: "openrouter", model: "deepseek/deepseek-v4" },
          { provider: "openrouter", model: "qwen/qwen3.8" },
          { provider: "llamacpp", model: "Qwen3.6-35B" },
          { provider: "openai", model: "gpt-4o" },
        ],
      },
    });
    (document.getElementById("model-btn") as HTMLButtonElement).click();
    const list = document.getElementById("model-list") as HTMLElement;
    expect(list.querySelectorAll(".mm-provider").length).toBe(3);

    const filter = document.getElementById("model-search") as HTMLInputElement;
    filter.value = "qwen";
    filter.dispatchEvent(new Event("input"));

    // Tree preserved: only providers WITH a match remain, and only the matching models.
    const headers = [...list.querySelectorAll(".mm-provider")].map((h) => h.firstChild?.textContent);
    expect(headers).toEqual(["llamacpp", "openrouter"]);
    const names = [...list.querySelectorAll(".mm-model")].map((m) => m.querySelector(".mm-model-name")?.textContent);
    expect(names).toEqual(["Qwen3.6-35B", "qwen/qwen3.8"]);

    // No match -> empty hint.
    filter.value = "zzz";
    filter.dispatchEvent(new Event("input"));
    expect(list.textContent).toContain("No model matches");
  });

  it("filtering by the PROVIDER name keeps ALL its models", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai-compatible",
        activeProvider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [
          { provider: "openai", model: "gpt-4o" },
          { provider: "openai", model: "gpt-4o-mini" },
          { provider: "openrouter", model: "qwen/qwen3.8" },
        ],
      },
    });
    (document.getElementById("model-btn") as HTMLButtonElement).click();
    const list = document.getElementById("model-list") as HTMLElement;
    const filter = document.getElementById("model-search") as HTMLInputElement;
    filter.value = "openai";
    filter.dispatchEvent(new Event("input"));

    const headers = [...list.querySelectorAll(".mm-provider")].map((h) => h.firstChild?.textContent);
    expect(headers).toEqual(["openai"]);
    const names = [...list.querySelectorAll(".mm-model")].map((m) => m.querySelector(".mm-model-name")?.textContent);
    expect(names).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });

  it("navigates the model modal with the keyboard (ArrowDown/Up, Esc)", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        activeProvider: "openai",
        model: "m1",
        hasKey: true,
        models: [],
        providerModels: [
          { provider: "openai", model: "m1" },
          { provider: "openai", model: "m2" },
        ],
      },
    });
    (document.getElementById("model-btn") as HTMLButtonElement).click();
    const modal = document.getElementById("model-modal") as HTMLElement;
    const filter = document.getElementById("model-search") as HTMLInputElement;
    const list = document.getElementById("model-list") as HTMLElement;
    const rows = [...list.querySelectorAll<HTMLButtonElement>(".mm-model")];

    // ArrowDown from the filter focuses the first row.
    filter.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(rows[0]);
    // ArrowDown / ArrowUp move between rows; ArrowUp from the first returns to the filter.
    rows[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(rows[1]);
    rows[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(rows[0]);
    rows[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(filter);
    // Esc from a row closes the modal.
    filter.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    rows[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(modal.classList.contains("hidden")).toBe(true);
  });

  it("shows the host-reported context window next to each model", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai-compatible",
        activeProvider: "openrouter",
        model: "openrouter/x",
        hasKey: true,
        models: [],
        providerModels: [
          { provider: "openrouter", model: "openrouter/x", contextLength: 128000, maxOutputTokens: 16384 },
          { provider: "openrouter", model: "openrouter/big", contextLength: 1000000, maxOutputTokens: 32000 },
          { provider: "openrouter", model: "openrouter/plain" },
        ],
      },
    });
    (document.getElementById("model-btn") as HTMLButtonElement).click();
    const list = document.getElementById("model-list") as HTMLElement;
    const row = (name: string) =>
      [...list.querySelectorAll<HTMLButtonElement>(".mm-model")].find(
        (m) => m.querySelector(".mm-model-name")?.textContent === name,
      )!;
    expect(row("openrouter/x").querySelector(".mm-ctx-value")?.textContent).toBe("128k");
    expect(row("openrouter/big").querySelector(".mm-ctx-value")?.textContent).toBe("1M");
    expect(row("openrouter/plain").querySelector(".mm-ctx-value")?.textContent).toBe("-");
    // Output tokens next to the context: NO labels, just the two right-aligned
    // values in their own shared columns.
    expect(row("openrouter/x").querySelector(".mm-out-label")?.textContent).toBe("out");
    expect(row("openrouter/x").querySelector(".mm-out-value")?.textContent).toBe("16k");
    expect(row("openrouter/big").querySelector(".mm-out-value")?.textContent).toBe("32k");
    expect(row("openrouter/plain").querySelector(".mm-out-value")?.textContent).toBe("-");
    // Only the "out" label is back; there is NO "ctx" label.
    expect(row("openrouter/x").querySelector(".mm-ctx-label")).toBeNull();
    // The check cell is ALWAYS present (empty when not current) so the value
    // columns line up across rows.
    expect(row("openrouter/plain").querySelector(".mm-check")).toBeTruthy();
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
    (document.getElementById("model-btn") as HTMLButtonElement).click();
    const list = document.getElementById("model-list") as HTMLElement;
    const labels = [...list.querySelectorAll(".mm-provider")].map((h) => h.firstChild?.textContent);
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
    (document.getElementById("model-btn") as HTMLButtonElement).click();
    const list = document.getElementById("model-list") as HTMLElement;
    const headers = [...list.querySelectorAll(".mm-provider")].map((h) => h.firstChild?.textContent);
    expect(headers).toContain("llamacpp");
    const err = list.querySelector(".mm-error") as HTMLElement;
    expect(err).toBeTruthy();
    expect(err.textContent).toContain("HTTP 500");
    expect(err.textContent).toContain("host unreachable");
  });

  it("refreshes the provider list when the model modal is opened", async () => {
    await loadView();
    posted.length = 0;
    (document.getElementById("model-btn") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "getConfig" });
  });

  it("masks the API key and reveals it ONLY while the eye is held", async () => {
    await loadView();
    const key = document.getElementById("pe-apikey") as HTMLInputElement;
    const eye = document.getElementById("pe-apikey-reveal") as HTMLButtonElement;
    expect(key.type).toBe("password");

    eye.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(key.type).toBe("text");
    eye.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(key.type).toBe("password");

    // Leaving the button while held also re-masks.
    eye.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    eye.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    expect(key.type).toBe("password");
  });

  it("reveals the API key on TOUCH and re-masks on release / window blur", async () => {
    await loadView();
    const key = document.getElementById("pe-apikey") as HTMLInputElement;
    const eye = document.getElementById("pe-apikey-reveal") as HTMLButtonElement;

    eye.dispatchEvent(new Event("touchstart", { cancelable: true, bubbles: true }));
    expect(key.type).toBe("text");
    eye.dispatchEvent(new Event("touchend", { bubbles: true }));
    expect(key.type).toBe("password");

    // Losing the window focus while held re-masks too.
    eye.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(key.type).toBe("text");
    window.dispatchEvent(new Event("blur"));
    expect(key.type).toBe("password");
  });

  it("re-masks the API key when another provider is selected", async () => {
    await loadView();
    hostMessage({
      type: "providersEditor",
      data: { activeProvider: "a", providers: { a: { apiKey: "sk-a" }, b: { apiKey: "sk-b" } } },
    });
    const key = document.getElementById("pe-apikey") as HTMLInputElement;
    const eye = document.getElementById("pe-apikey-reveal") as HTMLButtonElement;
    eye.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(key.type).toBe("text");

    const sel = document.getElementById("provider-select") as HTMLSelectElement;
    sel.value = "b";
    sel.dispatchEvent(new Event("change"));
    expect(key.type).toBe("password");
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

  it("switching provider KEEPS the edit as a draft instead of throwing it away", async () => {
    // The form is a draft: moving the selection used to load the other entry straight over the
    // edit, with no warning and nothing to undo. Now the edit is committed into the DRAFT first,
    // so it is still there when you come back — and NOTHING is written until Save.
    await loadView();
    hostMessage({
      type: "providersEditor",
      data: { providers: { a: { baseUrl: "http://a/v1" }, b: { baseUrl: "http://b/v1" } } },
    });
    const baseUrl = document.getElementById("pe-baseurl") as HTMLInputElement;
    const sel = document.getElementById("provider-select") as HTMLSelectElement;
    posted.length = 0;

    baseUrl.value = "typed.example:9000"; // edit "a"
    sel.value = "b"; // …then look at "b"
    sel.dispatchEvent(new Event("change"));
    expect(baseUrl.value).toBe("http://b/v1");

    sel.value = "a"; // …and come back
    sel.dispatchEvent(new Event("change"));
    expect(baseUrl.value).toBe("http://typed.example:9000/v1");
    expect(posted.filter((m) => (m as { type?: string }).type === "saveProviders")).toEqual([]);

    (document.getElementById("providers-save") as HTMLButtonElement).click();
    const sent = posted.find((m) => (m as { type?: string }).type === "saveProviders") as {
      data: { providers: Record<string, { baseUrl?: string }> };
    };
    expect(sent.data.providers.a!.baseUrl).toBe("http://typed.example:9000/v1");
  });

  it("a pending RENAME survives a selection change and lands in the draft", async () => {
    // Renaming is part of the draft too: switching to another provider used to leave the renamed
    // entry behind (the name in the form was simply dropped).
    await loadView();
    hostMessage({
      type: "providersEditor",
      data: { providers: { a: { baseUrl: "http://a/v1" }, b: { baseUrl: "http://b/v1" } } },
    });
    const name = document.getElementById("pe-name") as HTMLInputElement;
    const sel = document.getElementById("provider-select") as HTMLSelectElement;
    name.value = "renamed";
    sel.value = "b";
    sel.dispatchEvent(new Event("change"));
    // The list is rebuilt with the new name and the entry kept its value.
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(["b", "renamed"]);
    sel.value = "renamed";
    sel.dispatchEvent(new Event("change"));
    expect((document.getElementById("pe-baseurl") as HTMLInputElement).value).toBe("http://a/v1");
    // Nothing reached the host yet.
    expect(posted.filter((m) => (m as { type?: string }).type === "saveProviders")).toEqual([]);
  });

  it("the providers Save button comes back by itself if the host never answers", async () => {
    await loadView();
    hostMessage({ type: "providersEditor", data: { providers: { a: { baseUrl: "http://a/v1" } } } });
    const save = document.getElementById("providers-save") as HTMLButtonElement;
    vi.useFakeTimers();
    try {
      save.click();
      expect(save.disabled).toBe(true);
      vi.advanceTimersByTime(8000);
      expect(save.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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

  it("Parallel card: the cap slider renders and posts setMaxParallelSubAgents", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: { provider: "openai", model: "gpt-4o", hasKey: true, contextWindow: 128000, maxParallelSubAgents: 6 },
    });
    const range = document.getElementById("par-range") as HTMLInputElement;
    const label = document.getElementById("par-value") as HTMLElement;
    expect(range.value).toBe("6");
    expect(range.max).toBe("100");
    expect(label.textContent).toBe("6");
    expect(range.disabled).toBe(false);

    posted.length = 0;
    range.value = "7";
    range.dispatchEvent(new Event("input"));
    expect(label.textContent).toBe("7"); // live mirror
    range.dispatchEvent(new Event("change"));
    const msg = posted.at(-1) as { type: string; value: number };
    expect(msg.type).toBe("setMaxParallelSubAgents");
    expect(msg.value).toBe(7);
  });

  it("Parallel card: 0 means NO cap and shows 'Off'", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: { provider: "openai", model: "gpt-4o", hasKey: true, contextWindow: 128000, maxParallelSubAgents: 4 },
    });
    const range = document.getElementById("par-range") as HTMLInputElement;
    const label = document.getElementById("par-value") as HTMLElement;
    posted.length = 0;
    range.value = "0";
    range.dispatchEvent(new Event("input"));
    expect(label.textContent).toBe("Off");
    range.dispatchEvent(new Event("change"));
    const msg = posted.find((m) => (m as { type?: string }).type === "setMaxParallelSubAgents") as { value: number };
    expect(msg.value).toBe(0);
  });

  it("Guardrails card: Loop Guard level radios post setLoopGuard and reflect the config", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: { provider: "openai", model: "gpt-4o", hasKey: true, contextWindow: 128000, loopGuard: "high" },
    });
    const high = document.getElementById("lg-high") as HTMLInputElement;
    const medium = document.getElementById("lg-medium") as HTMLInputElement;
    const low = document.getElementById("lg-low") as HTMLInputElement;
    const off = document.getElementById("lg-off") as HTMLInputElement;
    expect(high.checked).toBe(true);
    expect(medium.checked).toBe(false);

    posted.length = 0;
    low.checked = true;
    low.dispatchEvent(new Event("change"));
    const msg = posted.at(-1) as { type: string; value: string };
    expect(msg.type).toBe("setLoopGuard");
    expect(msg.value).toBe("low");

    // Off is a real level and posts as such.
    posted.length = 0;
    off.checked = true;
    off.dispatchEvent(new Event("change"));
    expect((posted.at(-1) as { type: string; value: string }).value).toBe("off");

    // The "Include response" flag posts its own message.
    posted.length = 0;
    const response = document.getElementById("lg-response") as HTMLInputElement;
    expect(response.checked).toBe(false); // off by default
    response.checked = true;
    response.dispatchEvent(new Event("change"));
    const respMsg = posted.at(-1) as { type: string; value: boolean };
    expect(respMsg.type).toBe("setLoopGuardResponse");
    expect(respMsg.value).toBe(true);

    // An undefined config (no override) selects the MEDIUM preset (the default).
    hostMessage({
      type: "config",
      config: { provider: "openai", model: "gpt-4o", hasKey: true, contextWindow: 128000 },
    });
    expect(medium.checked).toBe(true);
    expect(response.checked).toBe(false);

    // A session persisted under the old name ("normal") lands on Medium, not on Off.
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        contextWindow: 128000,
        loopGuard: "normal" as never,
      },
    });
    expect(medium.checked).toBe(true);
  });

  it("Loop Guard fields: built from the ranges, filled from the preset, post live overrides", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        contextWindow: 128000,
        loopGuard: "high",
        loopGuardRanges: [
          { key: "maxNudges", min: 1, max: 10, step: 1, integer: true },
          { key: "reasoningThreshold", min: 0.05, max: 1, step: 0.05, integer: false },
        ],
        loopGuardPresets: {
          high: { maxNudges: 3, reasoningThreshold: 0.45 },
          medium: { maxNudges: 2, reasoningThreshold: 0.5 },
          low: { maxNudges: 2, reasoningThreshold: 0.65 },
        },
      },
    });
    const nudges = document.getElementById("lgr-maxNudges") as HTMLInputElement;
    const nudgesVal = document.getElementById("lgv-maxNudges") as HTMLElement;
    const theta = document.getElementById("lgr-reasoningThreshold") as HTMLInputElement;
    expect(nudges).toBeTruthy();
    expect(nudges.type).toBe("range");
    expect(nudges.min).toBe("1");
    expect(nudges.max).toBe("10");
    // Filled from the ACTIVE level's preset (high).
    expect(nudges.value).toBe("3");
    expect(nudgesVal.textContent).toBe("3");
    expect(theta.value).toBe("0.45");
    // The value is a read-only LABEL: no editable number box exists.
    expect(document.getElementById("lgf-maxNudges")).toBeNull();

    // Dragging a slider mirrors the value live and posts on release.
    posted.length = 0;
    nudges.value = "7";
    nudges.dispatchEvent(new Event("input"));
    expect(nudgesVal.textContent).toBe("7");
    nudges.dispatchEvent(new Event("change"));
    const msg = posted.at(-1) as { type: string; overrides: Record<string, number> };
    expect(msg.type).toBe("setLoopGuardOverrides");
    expect(msg.overrides.maxNudges).toBe(7);
    expect(msg.overrides.reasoningThreshold).toBe(0.45);

    // Switching the level resets the sliders + labels to that preset's values.
    const low = document.getElementById("lg-low") as HTMLInputElement;
    low.checked = true;
    low.dispatchEvent(new Event("change"));
    expect(nudges.value).toBe("2");
    expect(nudgesVal.textContent).toBe("2");
    expect(theta.value).toBe("0.65");
  });

  it("Loop Guard fields show the SAVED per-session values over the preset", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        contextWindow: 128000,
        loopGuard: "medium",
        loopGuardRanges: [
          { key: "maxNudges", min: 1, max: 10, step: 1, integer: true },
          { key: "reasoningThreshold", min: 0.05, max: 1, step: 0.05, integer: false },
        ],
        loopGuardPresets: { medium: { maxNudges: 2, reasoningThreshold: 0.5 } },
        loopGuardParams: { maxNudges: 7 },
      },
    });
    // The saved value wins; a key with no saved value falls back to the preset.
    expect((document.getElementById("lgr-maxNudges") as HTMLInputElement).value).toBe("7");
    expect((document.getElementById("lgv-maxNudges") as HTMLElement).textContent).toBe("7");
    expect((document.getElementById("lgr-reasoningThreshold") as HTMLInputElement).value).toBe("0.5");
  });

  it("Loop Guard parameter names carry a hover tooltip explaining them", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        contextWindow: 128000,
        loopGuard: "medium",
        loopGuardRanges: [{ key: "maxNudges", min: 1, max: 10, step: 1, integer: true }],
        loopGuardPresets: { medium: { maxNudges: 2 } },
      },
    });
    const tip = document.getElementById("tip") as HTMLElement;
    const name = document.querySelector(".lg-name") as HTMLElement;
    expect(tip.classList.contains("hidden")).toBe(true);

    name.dispatchEvent(new MouseEvent("mouseenter"));
    expect(tip.classList.contains("hidden")).toBe(false);
    expect(tip.textContent).toContain("Nudges — How many corrective nudges");
    expect(tip.textContent).toContain("before the guard stops the run");
    expect(tip.textContent).toContain("range 1–10");

    name.dispatchEvent(new MouseEvent("mouseleave"));
    expect(tip.classList.contains("hidden")).toBe(true);
  });

  it("picks the control columns from the MEASURED sensitivity row", async () => {
    await loadView();
    /** The resize handlers are COALESCED to one pass per frame (a gesture fires
     * dozens of events), so the layout lands on the next frame. */
    const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
    const cards = document.getElementById("ctl-cards") as HTMLElement;
    const toggle = document.getElementById("lg-toggle") as HTMLElement;
    const fields = document.getElementById("lg-fields") as HTMLElement;
    // Simulate a 500px stack whose radios' intrinsic row is 190px wide:
    // row = 190 + chevron(0 in jsdom) + 8 = 198 -> need = 222;
    // 2 columns need 222*2 + 8 = 452 <= 500.
    Object.defineProperty(cards, "clientWidth", { value: 500, configurable: true });
    Object.defineProperty(toggle, "scrollWidth", { value: 190, configurable: true });
    window.dispatchEvent(new Event("resize"));
    await frame();
    expect(cards.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
    expect(fields.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");

    // A wide stack fits FOUR cards; a narrow one falls back to a single column.
    Object.defineProperty(cards, "clientWidth", { value: 1200, configurable: true });
    window.dispatchEvent(new Event("resize"));
    await frame();
    expect(cards.style.gridTemplateColumns).toBe("repeat(4, minmax(0, 1fr))");
    Object.defineProperty(cards, "clientWidth", { value: 300, configurable: true });
    window.dispatchEvent(new Event("resize"));
    await frame();
    expect(cards.style.gridTemplateColumns).toBe("repeat(1, minmax(0, 1fr))");
    expect(fields.style.gridTemplateColumns).toBe("minmax(0, 1fr)");
  });

  it("Loop Guard parameters start COLLAPSED and the corner chevron toggles them", async () => {
    await loadView();
    const field = document.getElementById("lg-params-field") as HTMLElement;
    const btn = document.getElementById("lg-collapse") as HTMLButtonElement;
    // Collapsed by default (the card keeps its minimum height).
    expect(field.classList.contains("hidden")).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("false");

    btn.click();
    expect(field.classList.contains("hidden")).toBe(false);
    expect(btn.getAttribute("aria-expanded")).toBe("true");

    btn.click();
    expect(field.classList.contains("hidden")).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("Guardrails card reflects the initial session config on load (no config push)", async () => {
    setupDom({
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [],
        contextWindow: 128000,
        maxParallelSubAgents: 7,
        loopGuard: "low",
        loopGuardResponse: true,
      },
    });
    await loadView();
    expect((document.getElementById("par-range") as HTMLInputElement).value).toBe("7");
    expect((document.getElementById("par-value") as HTMLElement).textContent).toBe("7");
    expect((document.getElementById("lg-low") as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById("lg-response") as HTMLInputElement).checked).toBe(true);
  });

  it("Guardrails card locks its controls while the session is working", async () => {
    await loadView();
    hostMessage({ type: "status", active: true });
    expect((document.getElementById("par-range") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("lg-high") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("lg-off") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("lg-response") as HTMLInputElement).disabled).toBe(true);
    hostMessage({ type: "status", active: false });
    expect((document.getElementById("lg-high") as HTMLInputElement).disabled).toBe(false);
    expect((document.getElementById("lg-response") as HTMLInputElement).disabled).toBe(false);
  });

  it("Loop Guard OFF dims and disables its parameters and the answer checkbox", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        contextWindow: 128000,
        loopGuard: "off",
        loopGuardRanges: [{ key: "maxNudges", min: 1, max: 10, step: 1, integer: true }],
        loopGuardPresets: { off: { maxNudges: 2 }, medium: { maxNudges: 2 } },
      },
    });
    const off = document.getElementById("lg-off") as HTMLInputElement;
    const medium = document.getElementById("lg-medium") as HTMLInputElement;
    const response = document.getElementById("lg-response") as HTMLInputElement;
    const nudges = document.getElementById("lgr-maxNudges") as HTMLInputElement;
    const fields = document.getElementById("lg-fields") as HTMLElement;
    expect(off.checked).toBe(true);
    // Inert, but still THERE (hiding them would change the card's height).
    expect(nudges).toBeTruthy();
    expect(nudges.disabled).toBe(true);
    expect(response.disabled).toBe(true);
    expect(fields.classList.contains("is-off")).toBe(true);
    // …and a new level wakes them up again (the run lock is not on).
    medium.checked = true;
    medium.dispatchEvent(new Event("change"));
    expect(nudges.disabled).toBe(false);
    expect(response.disabled).toBe(false);
    expect(fields.classList.contains("is-off")).toBe(false);

    // OFF + a run: the lock wins, and when the run ENDS the parameters must stay inert
    // (the release of the lock must not re-enable a guard that is switched off).
    off.checked = true;
    off.dispatchEvent(new Event("change"));
    hostMessage({ type: "status", active: true });
    expect(nudges.disabled).toBe(true);
    expect(response.disabled).toBe(true);
    hostMessage({ type: "status", active: false });
    expect(nudges.disabled).toBe(true);
    expect(response.disabled).toBe(true);
    expect(off.checked).toBe(true);
  });

  it("Skills card lists installed skills; a chip click fills the prompt with /skill <name>", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        contextWindow: 128000,
        skills: [
          { name: "pdf", description: "PDFs" },
          { name: "code-review", description: "Review a diff" },
        ],
      },
    });
    const card = document.getElementById("skills-card") as HTMLElement;
    const list = document.getElementById("skills-list") as HTMLElement;
    expect(card.classList.contains("hidden")).toBe(false);
    const chips = list.querySelectorAll<HTMLElement>(".skill-item");
    expect(chips.length).toBe(2);
    expect(chips[0].textContent).toContain("pdf");

    chips[0].click();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    expect(input.value).toBe("/skill pdf ");
    expect(document.activeElement).toBe(input);
  });

  it("Skills card is hidden when no skills are installed", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: { provider: "openai", model: "gpt-4o", hasKey: true, contextWindow: 128000, skills: [] },
    });
    expect((document.getElementById("skills-card") as HTMLElement).classList.contains("hidden")).toBe(true);
  });

  it("a transcript refresh carrying skills re-renders the Skills card", async () => {
    await loadView();
    hostMessage({ type: "refresh", messages: [], skills: [{ name: "pdf", description: "PDFs" }] });
    const card = document.getElementById("skills-card") as HTMLElement;
    expect(card.classList.contains("hidden")).toBe(false);
    expect(document.querySelectorAll("#skills-list .skill-item").length).toBe(1);
  });

  it("a `skills` message re-renders the Skills card", async () => {
    await loadView();
    hostMessage({ type: "skills", skills: [{ name: "pdf", description: "PDFs" }] });
    expect((document.getElementById("skills-card") as HTMLElement).classList.contains("hidden")).toBe(false);
    expect(document.querySelectorAll("#skills-list .skill-item").length).toBe(1);
  });

  it("expanding the control stack requests a fresh skills list", async () => {
    await loadView();
    posted.length = 0;
    (document.getElementById("ctl-toggle") as HTMLElement).click(); // default collapsed → expands
    expect(posted.some((m) => (m as { type?: string }).type === "getSkills")).toBe(true);
  });

  it("regaining focus re-reads the skills list (install/remove shows up)", async () => {
    await loadView();
    posted.length = 0;
    window.dispatchEvent(new Event("focus"));
    expect(posted.some((m) => (m as { type?: string }).type === "getSkills")).toBe(true);
  });

  it("the MCP editor is hidden until Configure… is clicked", async () => {
    await loadView();
    expect((document.getElementById("mcp-modal") as HTMLElement).classList.contains("hidden")).toBe(true);
    (document.getElementById("mcp-configure") as HTMLButtonElement).click();
    hostMessage({ type: "mcpServers", data: { servers: {}, statuses: [] }, open: true });
    expect((document.getElementById("mcp-modal") as HTMLElement).classList.contains("hidden")).toBe(false);
    (document.getElementById("mcp-cancel") as HTMLButtonElement).click();
    expect((document.getElementById("mcp-modal") as HTMLElement).classList.contains("hidden")).toBe(true);
  });

  it("switching MCP server keeps the edit as a draft too", async () => {
    await loadView();
    hostMessage({
      type: "mcpServers",
      data: { servers: { one: { command: "node" }, two: { command: "npx" } }, statuses: [] },
      open: true,
    });
    const command = document.getElementById("mcp-command") as HTMLInputElement;
    const sel = document.getElementById("mcp-select") as HTMLSelectElement;
    posted.length = 0;

    command.value = "typed-binary";
    sel.value = "two";
    sel.dispatchEvent(new Event("change"));
    expect(command.value).toBe("npx");

    sel.value = "one";
    sel.dispatchEvent(new Event("change"));
    expect(command.value).toBe("typed-binary");
    expect(posted.filter((m) => (m as { type?: string }).type === "saveMcpServers")).toEqual([]);

    (document.getElementById("mcp-save") as HTMLButtonElement).click();
    const sent = posted.find((m) => (m as { type?: string }).type === "saveMcpServers") as {
      servers: Record<string, { command?: string }>;
    };
    expect(sent.servers.one!.command).toBe("typed-binary");
  });

  it("MCP + New keeps the edit you were typing", async () => {
    await loadView();
    hostMessage({
      type: "mcpServers",
      data: { servers: { one: { command: "node" } }, statuses: [] },
      open: true,
    });
    const command = document.getElementById("mcp-command") as HTMLInputElement;
    const name = document.getElementById("mcp-name") as HTMLInputElement;
    const sel = document.getElementById("mcp-select") as HTMLSelectElement;

    command.value = "typed-binary";
    (document.getElementById("mcp-add") as HTMLButtonElement).click();
    // A fresh entry is open…
    expect(name.value).toMatch(/^server/);
    // …and the one you were editing kept what you typed.
    sel.value = "one";
    sel.dispatchEvent(new Event("change"));
    expect(command.value).toBe("typed-binary");
    expect(posted.filter((m) => (m as { type?: string }).type === "saveMcpServers")).toEqual([]);
  });

  it("MCP card lists configured servers with their status", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        contextWindow: 128000,
        mcp: { servers: { test: { command: "node" } }, statuses: [{ name: "test", ok: true, toolCount: 2 }] },
      },
    });
    const card = document.getElementById("mcp-card") as HTMLElement;
    expect(card.classList.contains("hidden")).toBe(false);
    expect(document.getElementById("mcp-list")!.textContent).toContain("test");
    expect(document.getElementById("mcp-list")!.textContent).toContain("2 tools");
  });

  it("the MCP card: clicking the server name toggles it (posts toggleMcpServer)", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        contextWindow: 128000,
        mcp: {
          servers: { test: { command: "node" } },
          statuses: [{ name: "test", ok: true, enabled: true, toolCount: 2 }],
        },
      },
    });
    const nameEl = document.querySelector(".mcp-name") as HTMLElement;
    expect(nameEl.textContent).toContain("test");
    posted.length = 0;
    nameEl.click();
    const msg = posted.find((m) => (m as { type?: string }).type === "toggleMcpServer") as any;
    expect(msg.name).toBe("test");
    expect(msg.enabled).toBe(false);
  });

  it("the MCP name toggle is inert while the session is working", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        contextWindow: 128000,
        mcp: {
          servers: { test: { command: "node" } },
          statuses: [{ name: "test", ok: true, enabled: true, toolCount: 1 }],
        },
      },
    });
    hostMessage({ type: "status", active: true });
    const nameEl = document.querySelector(".mcp-name") as HTMLElement;
    posted.length = 0;
    nameEl.click();
    expect(posted.some((m) => (m as { type?: string }).type === "toggleMcpServer")).toBe(false);
  });

  it("a disabled MCP server shows an 'off' state (no tools button)", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        contextWindow: 128000,
        mcp: {
          servers: { off: { command: "node", enabled: false } },
          statuses: [{ name: "off", ok: true, enabled: false, toolCount: 0 }],
        },
      },
    });
    expect(document.querySelector(".mcp-tools-btn")).toBeNull();
    expect(document.querySelector(".mcp-status.off")).toBeTruthy();
    expect(document.getElementById("mcp-list")!.textContent).toContain("off");
  });

  it("the MCP modal shows the enabled flag, aligned with the config", async () => {
    await loadView();
    hostMessage({
      type: "mcpServers",
      data: { servers: { off: { command: "node", enabled: false } }, statuses: [] },
      open: true,
    });
    expect((document.getElementById("mcp-enabled") as HTMLInputElement).checked).toBe(false);
    posted.length = 0;
    (document.getElementById("mcp-save") as HTMLButtonElement).click();
    const saved = posted.find((m) => (m as { type?: string }).type === "saveMcpServers") as any;
    expect(saved.servers.off.enabled).toBe(false);
  });

  it("Configure… requests the MCP servers and opens the editor", async () => {
    await loadView();
    posted.length = 0;
    (document.getElementById("mcp-configure") as HTMLButtonElement).click();
    expect(posted.some((m) => (m as { type?: string }).type === "getMcpServers")).toBe(true);

    hostMessage({
      type: "mcpServers",
      data: { servers: { test: { command: "node", args: ["s.js"] } }, statuses: [] },
      open: true,
    });
    expect((document.getElementById("mcp-modal") as HTMLElement).classList.contains("hidden")).toBe(false);
    expect((document.getElementById("mcp-name") as HTMLInputElement).value).toBe("test");
    expect((document.getElementById("mcp-command") as HTMLInputElement).value).toBe("node");
    expect((document.getElementById("mcp-args") as HTMLTextAreaElement).value).toBe("s.js");
  });

  it("saving the MCP editor posts saveMcpServers and closes on success", async () => {
    await loadView();
    hostMessage({ type: "mcpServers", data: { servers: { test: { command: "node" } }, statuses: [] }, open: true });
    posted.length = 0;
    (document.getElementById("mcp-save") as HTMLButtonElement).click();
    const msg = posted.find((m) => (m as { type?: string }).type === "saveMcpServers") as any;
    expect(msg.servers.test.command).toBe("node");
    hostMessage({ type: "mcpSaved", ok: true });
    expect((document.getElementById("mcp-modal") as HTMLElement).classList.contains("hidden")).toBe(true);
  });

  it("mcpTested shows the connection result", async () => {
    await loadView();
    hostMessage({ type: "mcpServers", data: { servers: { test: { command: "node" } }, statuses: [] } });
    hostMessage({ type: "mcpTested", ok: true, toolCount: 3, tools: ["a", "b", "c"] });
    const res = document.getElementById("mcp-test-result") as HTMLElement;
    expect(res.textContent).toContain("3 tool");
    expect(res.className).toContain("ok");
  });

  it("mcpTested shows a failure with the error", async () => {
    await loadView();
    hostMessage({ type: "mcpServers", data: { servers: { test: { command: "node" } }, statuses: [] } });
    hostMessage({ type: "mcpTested", ok: false, error: "boom" });
    const res = document.getElementById("mcp-test-result") as HTMLElement;
    expect(res.textContent).toContain("boom");
    expect(res.className).toContain("err");
  });

  it("the MCP card is hidden when no servers are configured", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        contextWindow: 128000,
        mcp: { servers: {}, statuses: [] },
      },
    });
    expect((document.getElementById("mcp-card") as HTMLElement).classList.contains("hidden")).toBe(true);
  });

  it("clicking (N tools) opens a popover with the tool names + descriptions", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        contextWindow: 128000,
        mcp: {
          servers: { test: { command: "node" } },
          statuses: [
            {
              name: "test",
              ok: true,
              toolCount: 2,
              tools: [{ name: "echo", description: "Echo text" }, { name: "ping" }],
            },
          ],
        },
      },
    });
    const btn = document.querySelector(".mcp-tools-btn") as HTMLButtonElement;
    expect(btn.textContent).toBe("(2 tools)");
    btn.click();
    const pop = document.getElementById("mcp-tools-popover") as HTMLElement;
    expect(pop.classList.contains("hidden")).toBe(false);
    expect(pop.textContent).toContain("echo");
    expect(pop.textContent).toContain("Echo text");
    expect(pop.textContent).toContain("ping");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(pop.classList.contains("hidden")).toBe(true);
  });

  /** The panel's Save button (the footer has All / None / Cancel / Save). */
  const mcpPanelSave = () =>
    [...document.querySelectorAll<HTMLButtonElement>("#mcp-tools-popover button")].find(
      (b) => b.textContent === "Save",
    )!;

  /** Config push with one MCP server advertising `tools`. */
  /**
   * Push one server's tools. `excluded` is a TEST affordance that now becomes what it really is:
   * the SESSION's scope (`off` in `mcp__server__tool` form) — the panel reads the off list from
   * there, because that is where the decision lives.
   */
  function pushMcpTools(
    tools: { name: string; description?: string; excluded?: boolean; readOnly?: boolean; analyzeFlag?: boolean }[],
    toolCount?: number,
  ): void {
    const off = tools.filter((t) => t.excluded).map((t) => `mcp__test__${t.name}`);
    // The panel reads the HOST's flag (it owns the name spelling); `excluded` stays the test's word
    // for "this session has it off", and becomes both the flag and the scope entry.
    const flagged = tools.map((t) => ({ ...t, ...(t.excluded ? { off: true } : {}) }));
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        contextWindow: 128000,
        // The scope rides on the config, like the host sends it.
        toolScope: { mcp: ["test"], off },
        mcp: {
          servers: { test: { command: "node" } },
          statuses: [
            {
              name: "test",
              ok: true,
              enabled: true,
              toolCount: toolCount ?? tools.length - off.length,
              tools: flagged,
            },
          ],
        },
      },
    });
  }

  it("a refused MCP save says WHY and leaves the editor open with its draft", async () => {
    // The removal was blocked because a running session uses that server: closing the editor would
    // look like success and hide the reason.
    await loadView();
    hostMessage({ type: "mcpServers", data: { servers: { used: { command: "node" } }, statuses: [] }, open: true });
    const editor = document.getElementById("mcp-modal") as HTMLElement;
    expect(editor.classList.contains("hidden")).toBe(false);

    hostMessage({ type: "mcpSaved", ok: false, reason: 'Stop the run first — a session is using "used" right now' });
    expect(editor.classList.contains("hidden")).toBe(false);
    const status = document.getElementById("mcp-test-result") as HTMLElement;
    expect(status.textContent).toContain("Stop the run first");
    expect(status.className).toContain("err");

    // A successful save still closes it.
    hostMessage({ type: "mcpSaved", ok: true });
    expect(editor.classList.contains("hidden")).toBe(true);
  });

  it("the card counts what THIS session can use, not what the registry holds", async () => {
    // Every tool is registered now (a server is installed once, used per session), so `toolCount`
    // alone said "(2 tools)" while the model could only see one.
    await loadView();
    pushMcpTools([
      { name: "echo", description: "Echo text" },
      { name: "ping", excluded: true },
    ]);
    expect((document.querySelector(".mcp-tools-btn") as HTMLButtonElement).textContent).toBe("(1/2 tools)");

    // All on again (the host re-sends the tools with no flag): the quiet form comes back.
    pushMcpTools([{ name: "echo", description: "Echo text" }, { name: "ping" }]);
    expect((document.querySelector(".mcp-tools-btn") as HTMLButtonElement).textContent).toBe("(2 tools)");
  });

  it("the tools panel edits what the model sees, and Save posts the selection", async () => {
    await loadView();
    pushMcpTools([
      { name: "echo", description: "Echo text" },
      { name: "ping", excluded: true },
    ]);
    // The card says something is hidden BEFORE the panel is open.
    const btn = document.querySelector(".mcp-tools-btn") as HTMLButtonElement;
    expect(btn.textContent).toBe("(1/2 tools)");
    btn.click();

    const rows = [...document.querySelectorAll<HTMLElement>("#mcp-tools-popover .mcp-pop-row")];
    // The EXPOSURE switch is the row's own child; the Analyze one lives inside its labelled cluster.
    const switches = rows.map((r) => r.querySelector(":scope > .harny-switch") as HTMLButtonElement);
    // ON = exposed; the excluded one starts OFF and dimmed. The state is `aria-checked`: these are
    // switches, the same pill the server rows wear, not checkboxes.
    expect(switches.map((s) => s.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(rows[1].classList.contains("off")).toBe(true);
    expect(document.querySelector(".mcp-pop-count")!.textContent).toBe("1 of 2 enabled");
    expect(mcpPanelSave().disabled).toBe(true); // nothing edited yet
    // A short list does not get a search box: the filter only appears past 8 tools.
    expect(document.querySelector(".mcp-pop-filter")).toBeNull();

    switches[0].click(); // hide echo
    switches[1].click(); // expose ping
    expect(document.querySelector(".mcp-pop-count")!.textContent).toBe("1 of 2 enabled");
    expect(rows[0].classList.contains("off")).toBe(true);
    expect(mcpPanelSave().disabled).toBe(false);

    posted.length = 0;
    mcpPanelSave().click();
    // ONE message: the session's scope holds BOTH answers (`off` and `analyze`), so they are written
    // together — and the config file is not touched at all (the file only seeds a new session).
    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({ type: "setMcpToolSelection", server: "test", enabled: ["ping"], analyze: [] });

    // The host's answer closes the panel (it has already re-pushed the fresh state).
    hostMessage({ type: "mcpToolSelectionSaved", server: "test", ok: true });
    expect((document.getElementById("mcp-tools-popover") as HTMLElement).classList.contains("hidden")).toBe(true);
  });

  it("All / None flip the whole list, and All on a clean server disables Save again", async () => {
    await loadView();
    pushMcpTools([{ name: "echo" }, { name: "ping" }]); // nothing excluded: the default
    (document.querySelector(".mcp-tools-btn") as HTMLButtonElement).click();
    const pseudo = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>("#mcp-tools-popover button")].find(
        (b) => b.textContent === label,
      )!;

    pseudo("None").click();
    expect(document.querySelector(".mcp-pop-count")!.textContent).toBe("0 of 2 enabled");
    expect(mcpPanelSave().disabled).toBe(false);

    pseudo("All").click();
    expect(document.querySelector(".mcp-pop-count")!.textContent).toBe("2 of 2 enabled");
    // Back to what is saved: nothing to write.
    expect(mcpPanelSave().disabled).toBe(true);

    pseudo("Cancel").click();
    expect((document.getElementById("mcp-tools-popover") as HTMLElement).classList.contains("hidden")).toBe(true);
  });

  it("the per-tool control IS the server's switch — same class, same role, same meaning", async () => {
    // The report: the popover asked "is this tool on in this conversation?" with a checkbox while the
    // card above asked the SAME question with a pill. Two visual languages for one question, three
    // rows apart. They now share `harny-switch` outright, so they cannot drift back — and BOTH pills of
    // a row are that same switch, one per question.
    await loadView();
    pushMcpTools([{ name: "echo" }, { name: "ping", excluded: true }]);
    const serverSwitch = document.querySelector("#mcp-list .harny-switch") as HTMLButtonElement;
    expect(serverSwitch).toBeTruthy();

    (document.querySelector(".mcp-tools-btn") as HTMLButtonElement).click();
    const all = [...document.querySelectorAll<HTMLButtonElement>("#mcp-tools-popover .harny-switch")];
    expect(all).toHaveLength(4); // two rows × (exposure + Analyze)
    for (const sw of all) {
      // The CLASS is the contract (it brings the pill, the knob, the accent, the disabled state):
      // asserting it per element is what makes "identical to the server toggle" a testable claim.
      expect(sw.className).toBe(serverSwitch.className);
      expect(sw.getAttribute("role")).toBe(serverSwitch.getAttribute("role"));
      expect(sw.hasAttribute("aria-checked")).toBe(true);
    }
    // …and no checkbox is left anywhere in the form.
    expect(document.querySelectorAll("#mcp-tools-popover input[type=checkbox]")).toHaveLength(0);
  });

  it("a refused save keeps the panel open with the draft intact", async () => {
    await loadView();
    pushMcpTools([{ name: "echo" }, { name: "ping" }]);
    (document.querySelector(".mcp-tools-btn") as HTMLButtonElement).click();
    (document.querySelector("#mcp-tools-popover .mcp-pop-row .harny-switch") as HTMLButtonElement).click();
    mcpPanelSave().click();
    hostMessage({ type: "mcpToolSelectionSaved", server: "test", ok: false });
    const pop = document.getElementById("mcp-tools-popover") as HTMLElement;
    expect(pop.classList.contains("hidden")).toBe(false);
    expect(document.querySelector(".mcp-pop-status")!.textContent).toContain("Save failed");
    // The choice is still there: losing the draft on a write error would be cruel.
    const sw = document.querySelector("#mcp-tools-popover .mcp-pop-row .harny-switch") as HTMLButtonElement;
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });

  it("Save is refused while a run is working (a reconnect would swap the live tool list)", async () => {
    await loadView();
    pushMcpTools([{ name: "echo" }, { name: "ping" }]);
    (document.querySelector(".mcp-tools-btn") as HTMLButtonElement).click();
    (document.querySelector("#mcp-tools-popover .mcp-pop-row .harny-switch") as HTMLButtonElement).click();
    hostMessage({ type: "status", active: true });
    posted.length = 0;
    mcpPanelSave().click();
    expect(posted.some((m) => (m as { type?: string }).type === "setMcpToolSelection")).toBe(false);
    expect(document.querySelector(".mcp-pop-status")!.textContent).toContain("Stop the run first");
  });

  it("a long tool list gets a filter, and typing narrows the rows", async () => {
    await loadView();
    const many = Array.from({ length: 10 }, (_, i) => ({
      name: `tool_${i}`,
      description: i === 3 ? "special needle" : "plain",
    }));
    pushMcpTools(many);
    (document.querySelector(".mcp-tools-btn") as HTMLButtonElement).click();
    const filter = document.querySelector("#mcp-tools-popover .mcp-pop-filter") as HTMLInputElement;
    expect(filter).toBeTruthy();
    expect(document.querySelectorAll("#mcp-tools-popover .mcp-pop-row")).toHaveLength(10);

    const shownNames = () =>
      [...document.querySelectorAll("#mcp-tools-popover .mcp-pop-name")].map((n) => n.textContent);
    filter.value = "tool_1";
    filter.dispatchEvent(new Event("input"));
    expect(shownNames()).toEqual(["tool_1"]);

    // The description is searched too, not just the name.
    filter.value = "needle";
    filter.dispatchEvent(new Event("input"));
    expect(shownNames()).toEqual(["tool_3"]);

    filter.value = "zzz";
    filter.dispatchEvent(new Event("input"));
    expect(document.querySelector(".mcp-pop-empty")!.textContent).toContain("No tool matches");

    // The draft lives OUTSIDE the DOM, so a toggle survives the rows being rebuilt.
    filter.value = "";
    filter.dispatchEvent(new Event("input"));
    (document.querySelector("#mcp-tools-popover .mcp-pop-row .harny-switch") as HTMLButtonElement).click();
    filter.value = "tool_4";
    filter.dispatchEvent(new Event("input"));
    expect(document.querySelector(".mcp-pop-count")!.textContent).toBe("9 of 10 enabled");
    expect(mcpPanelSave().disabled).toBe(false);
  });

  it("a server with no tools shows the empty state instead of a broken list", async () => {
    await loadView();
    pushMcpTools([], 0);
    const btn = document.querySelector(".mcp-tools-btn") as HTMLButtonElement;
    expect(btn.textContent).toBe("(0 tools)");
    btn.click();
    expect(document.querySelector("#mcp-tools-popover .mcp-pop-empty")!.textContent).toBe("(no tools)");
    expect(document.querySelector(".mcp-pop-count")!.textContent).toBe("0 of 0 enabled");
    expect(mcpPanelSave().disabled).toBe(true);
  });

  it("a save from the MCP editor keeps the keys the form does not edit", async () => {
    await loadView();
    hostMessage({
      type: "mcpServers",
      data: {
        servers: {
          stdio: {
            command: "node",
            args: ["s.js"],
            analyze: "read-only",
            excludeTools: ["drop"],
            analyzeTools: ["read_query"],
          },
          remote: { url: "https://x/mcp", headers: { A: "1" } },
        },
        statuses: [],
      },
      open: true,
    });
    posted.length = 0;
    (document.getElementById("mcp-save") as HTMLButtonElement).click();
    const first = posted.find((m) => (m as { type?: string }).type === "saveMcpServers") as any;
    // Neither list has a control in THIS form: they must survive it untouched (a save from here
    // used to rebuild the server and drop the keys it did not know about).
    expect(first.servers.stdio).toEqual({
      command: "node",
      args: ["s.js"],
      analyze: "read-only",
      excludeTools: ["drop"],
      analyzeTools: ["read_query"],
      enabled: true,
    });

    // The HTTP server has no command: saving must not turn it into a broken stdio one,
    // and its URL/headers now have controls — they come back from their own fields.
    const sel = document.getElementById("mcp-select") as HTMLSelectElement;
    sel.value = "remote";
    sel.dispatchEvent(new Event("change"));
    posted.length = 0;
    (document.getElementById("mcp-save") as HTMLButtonElement).click();
    const second = posted.find((m) => (m as { type?: string }).type === "saveMcpServers") as any;
    expect(second.servers.remote).toEqual({ url: "https://x/mcp", headers: { A: "1" }, enabled: true });
    expect(second.servers.remote.command).toBeUndefined();
    expect(second.servers.remote.args).toBeUndefined();
  });

  it("an HTTP server is created from the URL field, and the stdio keys are dropped", async () => {
    await loadView();
    hostMessage({
      type: "mcpServers",
      data: { servers: { local: { command: "node", args: ["s.js"] } }, statuses: [] },
      open: true,
    });
    const url = document.getElementById("mcp-url") as HTMLInputElement;
    const command = document.getElementById("mcp-command") as HTMLInputElement;
    // A stdio server loads with its URL box empty…
    expect(url.value).toBe("");
    expect(command.value).toBe("node");

    // …and typing a URL turns it into an HTTP one: the leftover command MUST go, or the
    // normalizer (which prefers `command`) would keep reading it as stdio.
    url.value = "https://mcp.deepwiki.com/mcp";
    posted.length = 0;
    (document.getElementById("mcp-save") as HTMLButtonElement).click();
    const saved = posted.find((m) => (m as { type?: string }).type === "saveMcpServers") as any;
    expect(saved.servers.local).toEqual({ url: "https://mcp.deepwiki.com/mcp", enabled: true });
  });

  it("headers are edited as KEY=VALUE (or KEY: VALUE) and an emptied box clears them", async () => {
    await loadView();
    hostMessage({
      type: "mcpServers",
      data: { servers: { remote: { url: "https://x/mcp", headers: { A: "1" } } }, statuses: [] },
      open: true,
    });
    const headers = document.getElementById("mcp-headers") as HTMLTextAreaElement;
    expect(headers.value).toBe("A=1"); // what was saved is what you edit

    headers.value = "Authorization: Bearer abc\nX-Trace=on";
    posted.length = 0;
    (document.getElementById("mcp-save") as HTMLButtonElement).click();
    const saved = posted.find((m) => (m as { type?: string }).type === "saveMcpServers") as any;
    expect(saved.servers.remote.headers).toEqual({ Authorization: "Bearer abc", "X-Trace": "on" });

    // Empty box = no headers at all (not an empty object in the file).
    headers.value = "";
    posted.length = 0;
    (document.getElementById("mcp-save") as HTMLButtonElement).click();
    const cleared = posted.find((m) => (m as { type?: string }).type === "saveMcpServers") as any;
    expect(cleared.servers.remote.headers).toBeUndefined();
  });

  it("a new server with NEITHER a URL nor a command is kept as it was (no transport to write)", async () => {
    await loadView();
    hostMessage({
      type: "mcpServers",
      data: { servers: { only: { url: "https://x/mcp" } }, statuses: [] },
      open: true,
    });
    // Clear the URL without typing a command: writing `{}` would delete the server.
    (document.getElementById("mcp-url") as HTMLInputElement).value = "";
    posted.length = 0;
    (document.getElementById("mcp-save") as HTMLButtonElement).click();
    const saved = posted.find((m) => (m as { type?: string }).type === "saveMcpServers") as any;
    expect(saved.servers.only).toEqual({ url: "https://x/mcp", enabled: true });
  });

  it("the MCP editor's Save is refused while a run is working (it reconnects the servers)", async () => {
    await loadView();
    hostMessage({ type: "mcpServers", data: { servers: { one: { command: "node" } }, statuses: [] }, open: true });
    hostMessage({ type: "status", active: true });
    posted.length = 0;
    (document.getElementById("mcp-save") as HTMLButtonElement).click();
    // No save went out, and the reason is on screen (the Test line is the modal's status).
    expect(posted.some((m) => (m as { type?: string }).type === "saveMcpServers")).toBe(false);
    expect((document.getElementById("mcp-test-result") as HTMLElement).textContent).toContain(
      "Stop the run before saving",
    );
  });

  it("Test works for an HTTP server: a URL needs no command", async () => {
    // The bug this pins down: Test required a `command`, so every remote server — the form
    // filled in correctly, command legitimately empty — was told "Enter a command first".
    await loadView();
    hostMessage({ type: "mcpServers", data: { servers: {}, statuses: [] }, open: true });
    (document.getElementById("mcp-name") as HTMLInputElement).value = "complex";
    (document.getElementById("mcp-url") as HTMLInputElement).value =
      "https://mcpplaygroundonline.com/mcp-complex-server";
    posted.length = 0;
    (document.getElementById("mcp-test") as HTMLButtonElement).click();
    const msg = posted.find((m) => (m as { type?: string }).type === "testMcpServer") as any;
    expect(msg).toBeTruthy();
    expect(msg.server.url).toBe("https://mcpplaygroundonline.com/mcp-complex-server");
    expect(msg.server.command).toBeUndefined();
    expect((document.getElementById("mcp-test-result") as HTMLElement).textContent).toBe("Testing…");
  });

  it("Test refuses a server with NEITHER a command nor a URL", async () => {
    await loadView();
    hostMessage({ type: "mcpServers", data: { servers: {}, statuses: [] }, open: true });
    posted.length = 0;
    (document.getElementById("mcp-test") as HTMLButtonElement).click();
    expect(posted.some((m) => (m as { type?: string }).type === "testMcpServer")).toBe(false);
    const text = (document.getElementById("mcp-test-result") as HTMLElement).textContent ?? "";
    expect(text).toContain("command");
    expect(text).toContain("URL");
  });

  it("each MCP row has a SWITCH for THIS SESSION, and clicking it edits that session's scope", async () => {
    // Two different facts: `enabled: false` in the config is the MACHINE's (not installed here),
    // the switch is the CONVERSATION's. It must not write the config, and it must not depend on it
    // for the ON state — that is what the scope adds.
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        contextWindow: 128000,
        mcp: {
          servers: { a: { command: "node" }, b: { command: "node", enabled: false } },
          statuses: [
            { name: "a", ok: true, enabled: true, toolCount: 2 },
            { name: "b", ok: true, enabled: false, toolCount: 0 },
          ],
        },
      },
    });
    // The host says: this session uses `a` and not `b`.
    hostMessage({ type: "toolScope", scope: { mcp: ["a"], off: [] } });
    const sw = [...document.querySelectorAll<HTMLButtonElement>("#mcp-list .harny-switch")];
    expect(sw.map((s) => s.getAttribute("role"))).toEqual(["switch", "switch"]);
    // The knob position IS the state (the CSS reads aria-checked), so the switch cannot lie.
    expect(sw.map((s) => s.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    // A server the CONFIG disables cannot be switched on here: it is not installed.
    expect(sw.map((s) => s.disabled)).toEqual([false, true]);
    // …and the name carries no state of its own any more: the leading ● is gone.
    expect(document.querySelector("#mcp-list .mcp-name")!.textContent).toBe("a");

    posted.length = 0;
    sw[0].click();
    expect(posted).toContainEqual({ type: "setToolScope", scope: { mcp: [], off: [], analyze: [] } });
    // Nothing global is written by the switch.
    expect(posted.some((m) => (m as { type?: string }).type === "toggleMcpServer")).toBe(false);
  });

  it("the MCP switches dim while a run is working and come back when it stops", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        contextWindow: 128000,
        mcp: {
          servers: { a: { command: "node" } },
          statuses: [{ name: "a", ok: true, enabled: true, toolCount: 1 }],
        },
      },
    });
    const sw = () => document.querySelector("#mcp-list .harny-switch") as HTMLButtonElement;
    expect(sw().disabled).toBe(false);

    hostMessage({ type: "status", active: true });
    expect(sw().disabled).toBe(true);
    expect(sw().title).toContain("Stop the run first");
    posted.length = 0;
    sw().click();
    expect(posted.some((m) => (m as { type?: string }).type === "toggleMcpServer")).toBe(false);

    hostMessage({ type: "status", active: false });
    expect(sw().disabled).toBe(false);
    expect(sw().title).toContain("Use a in this session");
  });

  it("the MCP card keeps its rows when nothing changed (they used to be rebuilt under the cursor)", async () => {
    await loadView();
    const push = (statuses: unknown[]) =>
      hostMessage({
        type: "config",
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          contextWindow: 128000,
          mcp: { servers: { a: { command: "node" } }, statuses },
        },
      });
    push([{ name: "a", ok: true, enabled: true, toolCount: 2 }]);
    const row = document.querySelector("#mcp-list .mcp-status") as HTMLElement;
    // A config push arrives often (metrics, tokens): the same mcp section must not replace
    // the nodes, or a click lands on a row that was removed a millisecond earlier.
    push([{ name: "a", ok: true, enabled: true, toolCount: 2 }]);
    expect(document.querySelector("#mcp-list .mcp-status")).toBe(row);

    // A real change (the server failed) still redraws.
    push([{ name: "a", ok: false, enabled: true, toolCount: 0, error: "boom" }]);
    expect(document.querySelector("#mcp-list .mcp-status")).not.toBe(row);
  });

  it("a long MCP error stays ONE element with the full text in the tooltip", async () => {
    // The row is one line (CSS): a whole npm log used to wrap to three lines and change the
    // card's height, moving the control stack while the user was clicking.
    await loadView();
    const long = "npm error " + "x".repeat(400);
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        contextWindow: 128000,
        mcp: {
          servers: { a: { command: "node" } },
          statuses: [{ name: "a", ok: false, enabled: true, toolCount: 0, error: long }],
        },
      },
    });
    const details = document.querySelectorAll("#mcp-list .mcp-detail");
    expect(details).toHaveLength(1);
    expect(details[0].textContent).toBe(long);
    expect((details[0] as HTMLElement).title).toBe(long);
  });

  it("a slider paints the accent fill under its knob (--fill follows the value)", async () => {
    await loadView();
    const par = document.getElementById("par-range") as HTMLInputElement;
    // The initial state comes from a config push, which sets .value PROGRAMMATICALLY: no input
    // event fires, so the render pass has to paint it (the fill would otherwise sit at 0%).
    expect(par.style.getPropertyValue("--fill")).not.toBe("");

    par.value = "40";
    par.dispatchEvent(new Event("input", { bubbles: true }));
    expect(par.style.getPropertyValue("--fill")).toBe("40%");

    par.value = "100";
    par.dispatchEvent(new Event("input", { bubbles: true }));
    expect(par.style.getPropertyValue("--fill")).toBe("100%");
  });

  it("a PARTIAL config push repaints the fill too (this is what changing the model sends)", async () => {
    // The bug on screen: after a model change the context slider's knob sat at 100% while the
    // orange fill stopped at 67%. That push writes `.value` from its own handler, never through
    // renderViewState — so the reconciliation must also hang off the message itself.
    await loadView();
    const range = document.getElementById("ctx-range") as HTMLInputElement;

    hostMessage({ type: "config", config: { contextWindow: 1000000, maxContextWindow: 1000000 } });

    const min = Number(range.min || 0);
    const pct = ((Number(range.value) - min) / (Number(range.max || 100) - min)) * 100;
    expect(range.value).toBe("1000000");
    expect(range.style.getPropertyValue("--fill")).toBe(`${pct}%`);
  });

  it("dragging a slider still drives the panel (value → label), whatever the CSS does", async () => {
    // The mechanics, end to end: `input` on the range must reach the app's own handler. This is
    // the guard against a styling change quietly killing the control.
    await loadView();
    const range = document.getElementById("ctx-range") as HTMLInputElement;
    const label = document.getElementById("ctx-value") as HTMLElement;
    range.value = "32000";
    range.dispatchEvent(new Event("input", { bubbles: true }));
    expect(label.textContent).toContain("32");
    expect(range.style.getPropertyValue("--fill")).not.toBe("");
  });

  it("a slider with a non-zero min paints its fill from the min, not from zero", async () => {
    await loadView();
    // #out-range starts well above 0: a naive (value / max) would pin it to the top instead of
    // showing the real position — the classic range-fill bug.
    const out = document.getElementById("out-range") as HTMLInputElement;
    expect(Number(out.min)).toBeGreaterThan(0);
    out.value = out.min;
    out.dispatchEvent(new Event("input", { bubbles: true }));
    expect(out.style.getPropertyValue("--fill")).toBe("0%");
    out.value = out.max;
    out.dispatchEvent(new Event("input", { bubbles: true }));
    expect(out.style.getPropertyValue("--fill")).toBe("100%");
  });

  it("a modal opener repaints the fill of the sliders whose values it just wrote", async () => {
    // The compaction opener writes .value from the DRAFT (no input event fires, and no config
    // push follows), so without its own paint the track would keep the previous fill. Stale
    // state is simulated by removing the variable, which is exactly what "never painted" means.
    await loadView();
    const thr = document.getElementById("compact-threshold-input") as HTMLInputElement;
    thr.style.removeProperty("--fill");
    (document.getElementById("compact-settings-btn") as HTMLButtonElement).click();
    const min = Number(thr.min || 0);
    const pct = ((Number(thr.value) - min) / (Number(thr.max || 100) - min)) * 100;
    expect(thr.style.getPropertyValue("--fill")).toBe(`${pct}%`);
  });

  it("the two compaction knobs are INDEPENDENT: moving the trigger leaves the landing one alone", async () => {
    // The bug: the landing slider's max was derived from the trigger, so shrinking it made the
    // browser clamp the WIDGET while the draft kept the old value — the label and the knob
    // disagreed, and every later write put the knob back where the stale draft pointed.
    await loadView();
    (document.getElementById("compact-settings-btn") as HTMLButtonElement).click();
    const trigger = document.getElementById("compact-threshold-input") as HTMLInputElement;
    const landing = document.getElementById("compact-target-input") as HTMLInputElement;
    expect(landing.max).toBe("100");

    // Take MANUAL control first: in AUTO the landing point follows the trigger by definition.
    landing.value = "30";
    landing.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.getElementById("compact-target-value")?.textContent).toBe("30%");

    trigger.value = "20";
    trigger.dispatchEvent(new Event("input", { bubbles: true }));

    expect(landing.value).toBe("30"); // untouched by the other knob
    expect(landing.max).toBe("100"); // …and its range never shrinks under the finger
  });

  it("a landing point at or above the trigger is said in the label and clamped when saved", async () => {
    await loadView();
    (document.getElementById("compact-settings-btn") as HTMLButtonElement).click();
    const trigger = document.getElementById("compact-threshold-input") as HTMLInputElement;
    const landing = document.getElementById("compact-target-input") as HTMLInputElement;
    const label = document.getElementById("compact-target-value") as HTMLElement;

    trigger.value = "40";
    trigger.dispatchEvent(new Event("input", { bubbles: true }));
    landing.value = "90";
    landing.dispatchEvent(new Event("input", { bubbles: true }));

    // The consequence is visible BEFORE saving…
    expect(label.textContent).toContain("→ saved as 39%");
    posted.length = 0;
    (document.getElementById("compact-settings-save") as HTMLButtonElement).click();
    // …and that is exactly what is stored.
    expect(posted).toContainEqual({ type: "setCompactionTarget", value: 39 });
  });

  it("the note under the knobs follows the EFFECTS, at both limits", async () => {
    // The sliders are free, so the consequences are told here — before Save, not after.
    await loadView();
    (document.getElementById("compact-settings-btn") as HTMLButtonElement).click();
    const trigger = document.getElementById("compact-threshold-input") as HTMLInputElement;
    const landing = document.getElementById("compact-target-input") as HTMLInputElement;
    const note = document.getElementById("compact-note") as HTMLElement;

    // Everything compatible: nothing to say.
    trigger.value = "60";
    trigger.dispatchEvent(new Event("input", { bubbles: true }));
    landing.value = "20";
    landing.dispatchEvent(new Event("input", { bubbles: true }));
    expect(note.textContent).toBe("");

    // Above the trigger: says it frees nothing and what will be stored.
    landing.value = "90";
    landing.dispatchEvent(new Event("input", { bubbles: true }));
    expect(note.textContent).toContain("would free nothing");
    expect(note.textContent).toContain("saved as 59%");

    // Below the floor the host reported (8%): the other limit.
    hostMessage({
      type: "compactionPreview",
      thresholdPercent: 60,
      targetPercent: 20,
      minTargetPercent: 8,
      aboveThreshold: true,
    });
    landing.value = "4";
    landing.dispatchEvent(new Event("input", { bubbles: true }));
    expect(note.textContent).toContain("nothing left to free");
    expect(note.textContent).toContain("saved as 0%");

    // …and it clears again as soon as the pair makes sense.
    landing.value = "20";
    landing.dispatchEvent(new Event("input", { bubbles: true }));
    expect(note.textContent).toBe("");
  });

  it("what Save stores is what the next open shows: the EFFECTIVE landing point, not the draft", async () => {
    // The whole rule, one round trip: pick a landing point above the trigger, save, reopen.
    await loadView();
    const open = () => (document.getElementById("compact-settings-btn") as HTMLButtonElement).click();
    open();
    const trigger = document.getElementById("compact-threshold-input") as HTMLInputElement;
    const landing = document.getElementById("compact-target-input") as HTMLInputElement;
    const label = document.getElementById("compact-target-value") as HTMLElement;

    trigger.value = "40";
    trigger.dispatchEvent(new Event("input", { bubbles: true }));
    landing.value = "90";
    landing.dispatchEvent(new Event("input", { bubbles: true }));
    (document.getElementById("compact-settings-save") as HTMLButtonElement).click();

    expect(posted).toContainEqual({ type: "setCompactionTarget", value: 39 });
    open();
    expect(landing.value).toBe("39"); // the stored (effective) value, not the 90 you dragged
    expect(label.textContent).toBe("39%");
    expect(document.getElementById("compact-note")?.textContent).toBe(""); // nothing to warn about now
  });

  it("Cancel throws the draft away: nothing of the pair survives", async () => {
    // The promise the modal makes ("nothing here applies until you press Save") must hold for the
    // landing knob too now that the two are independent.
    await loadView();
    const open = () => (document.getElementById("compact-settings-btn") as HTMLButtonElement).click();
    open();
    const trigger = document.getElementById("compact-threshold-input") as HTMLInputElement;
    const landing = document.getElementById("compact-target-input") as HTMLInputElement;
    trigger.value = "50";
    trigger.dispatchEvent(new Event("input", { bubbles: true }));
    landing.value = "25";
    landing.dispatchEvent(new Event("input", { bubbles: true }));
    (document.getElementById("compact-settings-cancel") as HTMLButtonElement).click();

    open();
    expect(trigger.value).toBe("80"); // the stored trigger
    expect(landing.value).toBe("10"); // …and AUTO, an eighth of it
  });

  it("Save stores the DRAFT, never the widget: a stray .value cannot override your choice", async () => {
    // Reading the widget was how an AUTO value got stored as an explicit choice once the old code
    // had rewritten the slider behind the draft. A programmatic write must count for nothing.
    await loadView();
    (document.getElementById("compact-settings-btn") as HTMLButtonElement).click();
    const landing = document.getElementById("compact-target-input") as HTMLInputElement;
    landing.value = "30";
    landing.dispatchEvent(new Event("input", { bubbles: true }));
    landing.value = "5"; // no event: not a decision, just a stray write
    posted.length = 0;
    (document.getElementById("compact-settings-save") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "setCompactionTarget", value: 30 });
  });

  it("the tools panel has a SECOND switch per tool: declared read-only in Analyze", async () => {
    // Two questions, two switches — the SAME pill for both, the second one labelled "Analyze": what
    // the model sees, and what may run in ANALYZE (an include list: default-deny).
    await loadView();
    pushMcpTools([{ name: "read_query", readOnly: true, analyzeFlag: true }, { name: "drop_table" }]);
    (document.querySelector(".mcp-tools-btn") as HTMLButtonElement).click();
    const runs = [...document.querySelectorAll<HTMLButtonElement>("#mcp-tools-popover .mcp-pop-analyze .harny-switch")];
    expect(runs).toHaveLength(2);
    // The first is declared by THIS session (on), the second is refused in Analyze (off).
    expect(runs.map((s) => s.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(runs.map((s) => s.disabled)).toEqual([false, false]);

    posted.length = 0;
    runs[1].click(); // declare drop_table read-only: legal, it is this session's word
    const saveBtn = document.querySelector(
      "#mcp-tools-popover .mcp-pop-actions button:last-child",
    ) as HTMLButtonElement;
    saveBtn.click();
    expect(posted).toEqual([
      {
        type: "setMcpToolSelection",
        server: "test",
        enabled: ["read_query", "drop_table"],
        analyze: ["read_query", "drop_table"],
      },
    ]);
  });

  it("a tool allowed by the SERVER declaration shows an INHERITED Analyze switch (not a rule of ours)", async () => {
    await loadView();
    // The server is declared read-only, so every tool of it runs: `readOnly` is true and there is
    // NO per-session entry (`analyzeFlag` absent). The switch must say so, not fake a rule of ours.
    pushMcpTools([{ name: "read_query", readOnly: true }]);
    (document.querySelector(".mcp-tools-btn") as HTMLButtonElement).click();
    const run = document.querySelector("#mcp-tools-popover .mcp-pop-analyze .harny-switch") as HTMLButtonElement;
    expect(run.getAttribute("aria-checked")).toBe("true");
    // Inherited, so it is locked and says where it comes from.
    expect(run.disabled).toBe(true);
    expect(run.title).toContain("declares every tool of it read-only");
  });

  it("a tool hidden from the model has an INERT Analyze switch: nothing to allow", async () => {
    // A hidden tool is not offered to the model at all, so its Analyze flag cannot do anything.
    // Showing a live switch there would promise a policy that does not exist.
    await loadView();
    pushMcpTools([{ name: "read_query", readOnly: true, analyzeFlag: true }]);
    (document.querySelector(".mcp-tools-btn") as HTMLButtonElement).click();
    const sw = document.querySelector("#mcp-tools-popover .mcp-pop-row > .harny-switch") as HTMLButtonElement;
    const run = document.querySelector("#mcp-tools-popover .mcp-pop-analyze .harny-switch") as HTMLButtonElement;
    expect(run.disabled).toBe(false);
    expect(run.getAttribute("aria-checked")).toBe("true");

    sw.click(); // hide it from the model
    expect(run.disabled).toBe(true);
    expect(run.getAttribute("aria-checked")).toBe("false"); // nothing runs: not read-only
    expect(run.title).toContain("switch the tool on first");

    sw.click(); // show it again: the switch comes back with the SAVED declaration
    expect(run.disabled).toBe(false);
    expect(run.getAttribute("aria-checked")).toBe("true");
  });

  it("text that is still streaming can be SELECTED: the repaint waits for the selection", async () => {
    // The bubble is repainted per delta with `innerHTML = renderMarkdown(...)`, which drops a
    // selection under the cursor: copying a passage while the answer arrived was impossible.
    await loadView();
    // A run in progress: the answer bubble is created under the working bar.
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    hostMessage({ type: "textDelta", content: "first part " });
    for (let i = 0; i < 40; i++) hostMessage({ type: "textDelta", content: `word${i} ` });
    await new Promise((r) => setTimeout(r, 40)); // let the throttled renderer paint
    const bubble = document.querySelector(".msg.assistant.streaming") as HTMLElement;
    expect(bubble.textContent).toContain("word0");

    // The user drags a selection INSIDE it…
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(bubble);
    sel.removeAllRanges();
    sel.addRange(range);
    const before = bubble.textContent;

    // …and the stream keeps arriving: the DOM must NOT be rebuilt under the selection.
    hostMessage({ type: "textDelta", content: "ULTIMO-CIUFFO" });
    await new Promise((r) => setTimeout(r, 40));
    expect(bubble.textContent).toBe(before);
    expect(sel.toString()).toBe(before); // the selection survived, intact

    // Releasing it lets the deferred paint land, with everything that arrived meanwhile.
    sel.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    await new Promise((r) => setTimeout(r, 10));
    expect(document.getElementById("messages")!.textContent).toContain("ULTIMO-CIUFFO");
    // …and normal streaming is back to being live.
    hostMessage({ type: "textDelta", content: "-AFTER" });
    await new Promise((r) => setTimeout(r, 40));
    expect(document.getElementById("messages")!.textContent).toContain("-AFTER");
  });

  it("⌘F / Ctrl+F opens find in the transcript: count, next/prev with wrap, Esc closes", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [
        { role: "user", content: "alpha beta alpha", timestamp: 1 },
        { role: "assistant", content: "gamma ALPHA delta", timestamp: 2 },
      ],
    });
    const bar = document.getElementById("find-bar") as HTMLElement;
    const input = document.getElementById("find-input") as HTMLInputElement;
    const count = document.getElementById("find-count") as HTMLElement;
    expect(bar.classList.contains("hidden")).toBe(true);

    // macOS: ⌘F. (On Windows/Linux it is Ctrl+F — covered by the OS matrix test.)
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      configurable: true,
    });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }));
    expect(bar.classList.contains("hidden")).toBe(false);
    expect(document.activeElement).toBe(input);

    // Case-insensitive, across bubbles: 3 occurrences (alpha, alpha, ALPHA).
    input.value = "alpha";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 150)); // the debounce
    expect(count.textContent).toBe("1/3");
    // The highlight is NOT a document selection (that would blur the field): see the caret test.
    // Here, without the Highlight API, the fallback deliberately paints nothing while we type.
    expect(window.getSelection()!.toString()).toBe("");
    expect(document.activeElement).toBe(input);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(count.textContent).toBe("2/3");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(count.textContent).toBe("3/3");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(count.textContent).toBe("1/3"); // wraps
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    expect(count.textContent).toBe("3/3"); // …backwards too

    // A query that matches nothing says so, in the warning colour, and selects nothing.
    input.value = "zzz";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 150));
    expect(count.textContent).toBe("no match");
    expect(count.classList.contains("none")).toBe(true);

    // Esc closes it and clears the highlight…
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(bar.classList.contains("hidden")).toBe(true);
    expect(input.value).toBe("");
    // …and Esc while find is open never reaches Stop.
    expect(posted.some((m: any) => m.type === "abort")).toBe(false);
  });

  it("finding a match does NOT steal the caret: you keep typing in the find field", async () => {
    // The reported bug: type one character, the match scrolls into view and you can no longer type
    // — setting a document SELECTION blurs the field in Chromium. The highlight is therefore
    // painted with the CSS Custom Highlight API, which needs no selection at all.
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [
        { role: "user", content: "alpha beta alpha", timestamp: 1 },
        { role: "assistant", content: "gamma alpha", timestamp: 2 },
      ],
    });
    // jsdom has no Highlight API: give it one, and make `addRange` behave like Chromium (it drops
    // the focus), so a regression that goes back to the selection cannot pass silently.
    const registered = new Map<string, { size: number }>();
    (window as any).Highlight = class {
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
      get size(): number {
        return this.ranges.length;
      }
    };
    (window as any).CSS = { ...((window as any).CSS ?? {}), highlights: registered };
    const makeHighlights = (): Map<string, unknown> => new Map();
    (window as any).CSS.highlights = makeHighlights();
    const seen = (window as any).CSS.highlights as Map<string, unknown>;
    const realAddRange = Selection.prototype.addRange;
    Selection.prototype.addRange = function (this: Selection, r: Range): void {
      realAddRange.call(this, r);
      (document.activeElement as HTMLElement | null)?.blur?.(); // what Chromium does
    };
    try {
      const input = document.getElementById("find-input") as HTMLInputElement;
      // Both modifiers: the test must open the bar on any host (macOS wants ⌘, Windows/Linux
      // Ctrl) without depending on the UA jsdom happens to report.
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, ctrlKey: true }));
      input.focus();
      input.value = "alpha";
      input.selectionStart = input.selectionEnd = input.value.length;
      input.dispatchEvent(new Event("input"));
      await new Promise((r) => setTimeout(r, 150)); // the debounce

      // The three matches are highlighted, the current one separately…
      expect(seen.size).toBe(2);
      expect((seen.get("harny-find") as { size: number }).size).toBe(3);
      expect((seen.get("harny-find-current") as { size: number }).size).toBe(1);
      // …NO selection was made, so the caret never left the field…
      expect(window.getSelection()!.toString()).toBe("");
      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(5);
      input.value += "x"; // …and the next keystroke lands where you are typing
      expect(input.value).toBe("alphax");
      // Nothing was injected into the transcript: highlights are painted, not DOM.
      expect(document.getElementById("messages")!.textContent).not.toContain("<mark");

      // Closing removes them (no stale paint left behind).
      document.getElementById("find-close")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(seen.size).toBe(0);
    } finally {
      Selection.prototype.addRange = realAddRange;
      delete (window as any).Highlight;
      delete (window as any).CSS;
    }
  });

  it("without the Highlight API it falls back to the selection — and never steals the caret", async () => {
    // An older host: the selection is the only highlight available. It is used ONLY when nothing
    // of ours has the focus, because moving it is what broke typing.
    await loadView();
    hostMessage({ type: "refresh", messages: [{ role: "assistant", content: "beta beta", timestamp: 1 }] });
    const input = document.getElementById("find-input") as HTMLInputElement;
    expect((window as any).Highlight).toBeUndefined(); // jsdom: no API
    // Open through the HOST route, which is a real path (VS Code owns ⌘F and posts this): the chord
    // itself is covered by the platform tests, and computing its modifier here with a different
    // regex than the app's `isMacPlatform` (which also knows `darwin`) made this test green while
    // never opening the bar at all.
    hostMessage({ type: "openFind" });
    input.focus();
    input.value = "beta";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 150));
    // The caret stayed in the field: the fallback refused to move the selection.
    expect(document.activeElement).toBe(input);
    expect(window.getSelection()!.toString()).toBe("");
    // Scrolling still happened through the match itself (no selection involved).
    expect(document.getElementById("find-count")!.textContent).toBe("1/2");
  });

  it("EVERY change recomputes the highlights: no stale paint on 'no match' or an emptied field", async () => {
    // The paint used to live inside showMatch, which returns early when there is no match: the
    // previous query's highlights stayed on screen, marking text that no longer matched.
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [
        { role: "user", content: "alpha beta", timestamp: 1 },
        { role: "assistant", content: "gamma alpha", timestamp: 2 },
      ],
    });
    const highlights = new Map<string, { size: number }>();
    (window as any).Highlight = class {
      size: number;
      constructor(...ranges: Range[]) {
        this.size = ranges.length;
      }
    };
    (window as any).CSS = { ...((window as any).CSS ?? {}), highlights };
    try {
      const input = document.getElementById("find-input") as HTMLInputElement;
      const count = document.getElementById("find-count") as HTMLElement;
      // Both modifiers: the test must open the bar on any host (macOS wants ⌘, Windows/Linux
      // Ctrl) without depending on the UA jsdom happens to report.
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, ctrlKey: true }));
      const type = async (text: string): Promise<void> => {
        input.value = text;
        input.dispatchEvent(new Event("input"));
        await new Promise((r) => setTimeout(r, 150));
      };

      await type("alpha");
      expect(highlights.get("harny-find")!.size).toBe(2);
      expect(highlights.get("harny-find-current")!.size).toBe(1);

      // One character less (a BACKSPACE, or the ✕ in a search field): recomputed, not stale.
      await type("alph");
      expect(highlights.get("harny-find")!.size).toBe(2);

      // …and a query that matches nothing CLEARS them instead of leaving the old ones.
      await type("zzz");
      expect(count.textContent).toBe("no match");
      expect(highlights.has("harny-find")).toBe(false);
      expect(highlights.has("harny-find-current")).toBe(false);

      // Emptying the field clears them too (the counter goes away with them).
      await type("alpha");
      expect(highlights.get("harny-find")!.size).toBe(2);
      await type("");
      expect(count.textContent).toBe("");
      expect(highlights.has("harny-find")).toBe(false);
    } finally {
      delete (window as any).Highlight;
      delete (window as any).CSS;
    }
  });

  it("the highlights follow the transcript as it grows, without moving the view", async () => {
    await loadView();
    hostMessage({ type: "refresh", messages: [{ role: "assistant", content: "one two", timestamp: 1 }] });
    const highlights = new Map<string, { size: number }>();
    (window as any).Highlight = class {
      size: number;
      constructor(...ranges: Range[]) {
        this.size = ranges.length;
      }
    };
    (window as any).CSS = { ...((window as any).CSS ?? {}), highlights };
    const list = document.getElementById("messages") as HTMLElement;
    Object.defineProperty(list, "scrollHeight", { value: 5000, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: 800, configurable: true });
    list.scrollTop = 1000;
    list.dispatchEvent(new Event("scroll")); // reading above the bottom, not following
    try {
      const input = document.getElementById("find-input") as HTMLInputElement;
      const count = document.getElementById("find-count") as HTMLElement;
      // Both modifiers: the test must open the bar on any host (macOS wants ⌘, Windows/Linux
      // Ctrl) without depending on the UA jsdom happens to report.
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, ctrlKey: true }));
      input.value = "two";
      input.dispatchEvent(new Event("input"));
      await new Promise((r) => setTimeout(r, 150));
      expect(count.textContent).toBe("1/1");

      // A run streams more text with the same word: the Ranges we hold point at replaced nodes, so
      // the scan follows the DOM — the count grows, and the reader is NOT dragged to the bottom.
      const prompt = document.getElementById("user-input") as HTMLTextAreaElement;
      prompt.value = "go";
      (document.getElementById("send-btn") as HTMLButtonElement).click(); // a run starts (it may park)
      list.scrollTop = 1000; // now park the reader above the bottom…
      list.dispatchEvent(new Event("scroll"));
      hostMessage({ type: "textDelta", content: " and still two" });
      await new Promise((r) => setTimeout(r, 400)); // the rescan debounce
      expect(count.textContent).toBe("1/2");
      expect(highlights.get("harny-find")!.size).toBe(2);
      expect(list.scrollTop).toBe(1000); // no jump: recomputing is not navigating
    } finally {
      delete (window as any).Highlight;
      delete (window as any).CSS;
    }
  });

  it("find follows the host OS, and rebuilds a stale list while the run streams", async () => {
    await loadView();
    const bar = document.getElementById("find-bar") as HTMLElement;
    const input = document.getElementById("find-input") as HTMLInputElement;
    const count = document.getElementById("find-count") as HTMLElement;
    hostMessage({ type: "refresh", messages: [{ role: "assistant", content: "one two", timestamp: 1 }] });

    // Windows: ⌘ (Meta) is the OS key, Ctrl+F is find; and Ctrl+F does NOT open it while… it does.
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      configurable: true,
    });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }));
    expect(bar.classList.contains("hidden")).toBe(true); // Win key: not ours
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }));
    expect(bar.classList.contains("hidden")).toBe(false);

    input.value = "two";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 150));
    expect(count.textContent).toBe("1/1");

    // More text arrives: navigated from a stale list, the scan is rebuilt instead of pointing at
    // ranges that no longer exist.
    const prompt = document.getElementById("user-input") as HTMLTextAreaElement;
    prompt.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click(); // a run is now working
    hostMessage({ type: "textDelta", content: " and still two" });
    await new Promise((r) => setTimeout(r, 40));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(count.textContent).toMatch(/^[12]\/2$/);
  });

  it("right-click on the transcript offers OUR Copy and Select all, on every OS", async () => {
    await loadView();
    hostMessage({ type: "refresh", messages: [{ role: "assistant", content: "text to copy", timestamp: 1 }] });
    const menu = document.getElementById("ctx-menu") as HTMLElement;
    const bubble = document.querySelector("#messages .msg") as HTMLElement;
    const sel = window.getSelection()!;
    sel.removeAllRanges();

    // No selection: the menu exists, Copy is offered but disabled (as in any editor).
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 30 });
    bubble.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true); // no dependence on the host's menu
    expect(menu.classList.contains("hidden")).toBe(false);
    const [copy, all] = [...menu.querySelectorAll("button")] as HTMLButtonElement[];
    expect(copy.textContent).toBe("Copy");
    expect(copy.disabled).toBe(true);
    expect(all.textContent).toBe("Select all");

    // Select all → Copy writes the transcript text to the clipboard.
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (t: string) => void written.push(t) },
      configurable: true,
    });
    all.click();
    expect(sel.toString()).toContain("text to copy");
    expect(menu.classList.contains("hidden")).toBe(true); // a choice closes it

    bubble.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    const [copy2] = [...menu.querySelectorAll("button")] as HTMLButtonElement[];
    expect(copy2.disabled).toBe(false); // the selection from "Select all" is still there
    copy2.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(written[0]).toContain("text to copy");
  });

  it("the context menu closes on Esc, on a click elsewhere, and on scroll", async () => {
    await loadView();
    hostMessage({ type: "refresh", messages: [{ role: "assistant", content: "line", timestamp: 1 }] });
    const menu = document.getElementById("ctx-menu") as HTMLElement;
    const bubble = document.querySelector("#messages .msg") as HTMLElement;
    const open = (): void => {
      bubble.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    };

    open();
    expect(menu.classList.contains("hidden")).toBe(false);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(menu.classList.contains("hidden")).toBe(true);
    expect(posted.some((m: any) => m.type === "abort")).toBe(false); // Esc closed the menu, not the run

    open();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(menu.classList.contains("hidden")).toBe(true);

    open();
    (document.getElementById("messages") as HTMLElement).dispatchEvent(new Event("scroll"));
    expect(menu.classList.contains("hidden")).toBe(true);
  });

  it("the host's openFind message opens the bar and puts the caret in it", async () => {
    // The path taken when VS Code consumes ⌘F first: its keybinding (scoped to our view) runs a
    // command that posts this message. The panel must end up focused in the find field — not in
    // VS Code's own find widget, which is what happened before the chord was claimed.
    await loadView();
    const bar = document.getElementById("find-bar") as HTMLElement;
    const input = document.getElementById("find-input") as HTMLInputElement;
    expect(bar.classList.contains("hidden")).toBe(true);
    hostMessage({ type: "openFind" });
    expect(bar.classList.contains("hidden")).toBe(false);
    expect(document.activeElement).toBe(input);
    // With text already there, opening again SELECTS it (typing replaces the query).
    input.value = "alpha";
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, ctrlKey: true }));
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(5);
  });

  it("a fold shows the SAME chevron open and closed: only its class (and rotation) changes", async () => {
    // The old triangle was swapped for another triangle: two glyphs, two shapes. A fold now holds
    // ONE svg; the state is a class, so the drawing (and the box) never changes.
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [{ role: "assistant", content: "", thinking: "un pensiero", toolCalls: [], timestamp: 1 }],
    });
    const thinking = document.querySelector(".thinking-header") as HTMLElement;
    const toggle = thinking.querySelector(".toggle") as HTMLElement;
    const svgBefore = toggle.innerHTML;
    expect(toggle.querySelector(".toggle-chevron")).not.toBe(null);
    expect(toggle.classList.contains("is-open")).toBe(false);

    thinking.click(); // open it
    expect(toggle.classList.contains("is-open")).toBe(true);
    // Byte-identical markup: the same chevron, rotated by CSS.
    expect(toggle.innerHTML).toBe(svgBefore);
    // …and no triangle glyph is left behind in the transcript.
    expect(document.getElementById("messages")!.textContent).not.toContain("▶");
    expect(document.getElementById("messages")!.textContent).not.toContain("▼");
  });

  it("typing '/' at the start of the prompt shows the skill list", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        contextWindow: 128000,
        skills: [{ name: "pptx", description: "Make decks" }],
      },
    });
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "/";
    input.dispatchEvent(new Event("input"));
    const menu = document.getElementById("slash-menu") as HTMLElement;
    expect(menu.classList.contains("hidden")).toBe(false);
    expect(menu.textContent).toContain("/skill pptx");
    expect(menu.textContent).toContain("/skills");

    const items = [...menu.querySelectorAll(".slash-item")] as HTMLElement[];
    const pptxItem = items.find((el) => el.textContent?.includes("pptx"))!;
    pptxItem.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(input.value).toBe("/skill pptx ");
    expect(menu.classList.contains("hidden")).toBe(true);
  });

  it("the slash menu only triggers at the START and with no spaces", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    const menu = document.getElementById("slash-menu") as HTMLElement;
    input.value = "see /path"; // "/" mid-text → no menu
    input.dispatchEvent(new Event("input"));
    expect(menu.classList.contains("hidden")).toBe(true);
    input.value = "/skill pptx done"; // space → no menu
    input.dispatchEvent(new Event("input"));
    expect(menu.classList.contains("hidden")).toBe(true);
  });

  it("Enter picks the highlighted slash item instead of sending", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        contextWindow: 128000,
        skills: [{ name: "pptx", description: "d" }],
      },
    });
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "/";
    input.dispatchEvent(new Event("input"));
    posted.length = 0;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(input.value).toBe("/skills "); // first item
    expect(posted.some((m) => (m as { type?: string }).type === "send")).toBe(false);
  });

  it("MCP editor: + New adds a server that is then saved", async () => {
    await loadView();
    hostMessage({ type: "mcpServers", data: { servers: {}, statuses: [] }, open: true });
    (document.getElementById("mcp-add") as HTMLButtonElement).click();
    expect((document.getElementById("mcp-name") as HTMLInputElement).value).toBe("server");
    (document.getElementById("mcp-name") as HTMLInputElement).value = "mine";
    posted.length = 0;
    (document.getElementById("mcp-save") as HTMLButtonElement).click();
    const saved = posted.find((m) => (m as { type?: string }).type === "saveMcpServers") as any;
    expect(saved.servers.mine.command).toBe("npx");
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

  it("posts exportProviders / importProviders from the editor and shows the result", async () => {
    await loadView();
    posted.length = 0;
    (document.getElementById("providers-export") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "exportProviders" });
    (document.getElementById("providers-import") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "importProviders" });

    hostMessage({ type: "providersExported", ok: true, path: "/tmp/p.json" });
    expect(document.getElementById("providers-io-result")?.textContent).toContain("Exported");
    hostMessage({ type: "providersImported", ok: false, error: "bad file" });
    expect(document.getElementById("providers-io-result")?.textContent).toContain("Import failed");
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
    const data = (
      saveMsg.data as {
        providers: Record<string, { extra?: unknown; thinkingLevel?: string }>;
      }
    ).providers;
    expect(data.custom).toBeUndefined();
    expect(data.renamed).toBeTruthy();
    expect(data.renamed.extra).toEqual({ models: [{ id: "m1" }], customAnything: 7 });
    expect(data.renamed.thinkingLevel).toBe("high");
  });

  it("renaming the ACTIVE provider sends the NEW name, so the file cannot keep the old one", async () => {
    // Reported from real use: the dropdown realigned, then the first turn dialed the FIRST
    // provider in the file (`ECONNREFUSED 127.0.0.1:8090`) because the config kept naming the
    // provider by a key that no longer existed.
    await loadView();
    hostMessage({
      type: "providersEditor",
      data: {
        activeProvider: "or",
        providers: { local: { baseUrl: "http://127.0.0.1:8090/v1" }, or: { baseUrl: "https://openrouter.ai/api/v1" } },
      },
    });
    const select = document.getElementById("provider-select") as HTMLSelectElement;
    select.value = "or";
    select.dispatchEvent(new Event("change"));
    (document.getElementById("pe-name") as HTMLInputElement).value = "OPENROUTER";
    posted.length = 0;
    (document.getElementById("providers-save") as HTMLButtonElement).click();

    const sent = posted.find((m) => (m as { type?: string }).type === "saveProviders") as {
      data: { activeProvider?: string; providers: Record<string, unknown> };
    };
    expect(Object.keys(sent.data.providers)).toEqual(["local", "OPENROUTER"]);
    expect(sent.data.activeProvider).toBe("OPENROUTER");
  });

  it("renaming a provider that is NOT active says nothing about the active one", async () => {
    // The editor does not own that choice — it only repairs it when a rename breaks it.
    await loadView();
    hostMessage({
      type: "providersEditor",
      data: {
        activeProvider: "local",
        providers: { local: { baseUrl: "http://127.0.0.1:8090/v1" }, or: { baseUrl: "https://openrouter.ai/api/v1" } },
      },
    });
    const select = document.getElementById("provider-select") as HTMLSelectElement;
    select.value = "or";
    select.dispatchEvent(new Event("change"));
    (document.getElementById("pe-name") as HTMLInputElement).value = "openrouter";
    posted.length = 0;
    (document.getElementById("providers-save") as HTMLButtonElement).click();

    const sent = posted.find((m) => (m as { type?: string }).type === "saveProviders") as {
      data: { activeProvider?: string };
    };
    expect(sent.data.activeProvider).toBeUndefined();
  });

  it("deleting the ACTIVE provider hands over a surviving name", async () => {
    await loadView();
    hostMessage({
      type: "providersEditor",
      data: { activeProvider: "a", providers: { a: { baseUrl: "http://a/v1" }, b: { baseUrl: "http://b/v1" } } },
    });
    const del = document.getElementById("provider-delete") as HTMLButtonElement;
    del.click();
    del.click();
    posted.length = 0;
    (document.getElementById("providers-save") as HTMLButtonElement).click();

    const sent = posted.find((m) => (m as { type?: string }).type === "saveProviders") as {
      data: { activeProvider?: string; providers: Record<string, unknown> };
    };
    expect(Object.keys(sent.data.providers)).toEqual(["b"]);
    expect(sent.data.activeProvider).toBe("b");
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
    const label = document.getElementById("model-btn-label") as HTMLElement;
    const btn = document.getElementById("model-btn") as HTMLButtonElement;
    expect(label.textContent).toBe("Select a model");
    expect(btn.classList.contains("placeholder")).toBe(true);
  });

  it("scrolls the tab strip sideways on a vertical wheel", async () => {
    await loadView();
    const tabs = document.getElementById("tabs") as HTMLElement;
    let left = 0;
    Object.defineProperty(tabs, "scrollLeft", {
      configurable: true,
      get: () => left,
      set: (v: number) => {
        left = v;
      },
    });
    tabs.dispatchEvent(new WheelEvent("wheel", { deltaY: 40, bubbles: true, cancelable: true }));
    expect(left).toBe(40);
  });

  it("scrolls the ACTIVE tab into view when the active tab changes", async () => {
    await loadView();
    const spy = vi.fn();
    const proto = HTMLElement.prototype as unknown as { scrollIntoView?: () => void };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = spy;
    try {
      hostMessage({
        type: "switchView",
        activeId: "b",
        openIds: ["a", "b"],
        sessions: [
          { id: "a", name: "Refactor", createdAt: 1, updatedAt: 2, messageCount: 3 },
          { id: "b", name: "Debug", createdAt: 2, updatedAt: 1, messageCount: 1 },
        ],
        messages: [],
        config: {},
        workingIds: [],
      });
      expect(spy).toHaveBeenCalled();
    } finally {
      if (original) proto.scrollIntoView = original;
      else delete proto.scrollIntoView;
    }
  });

  it("locks Mode and Parallel while the session works — like the request parameters, but it says why", async () => {
    // Reported: a click on Analyze → Build (and Parallel → OFF) during a run did nothing at
    // all, so the UI showed one thing and the run did another. Two ways out of that lie: let
    // the click land, or lock it AND say so. The lock wins — the policies are decided once per
    // run (Agent.runMode), so nothing can be switched under a run — and the tooltip carries
    // the reason, which is what the silent lock never did.
    await loadView();
    hostMessage({ type: "status", active: true });

    const modeBtn = document.getElementById("mode-btn") as HTMLButtonElement;
    const parallelBtn = document.getElementById("parallel-btn") as HTMLButtonElement;
    const modelBtn = document.getElementById("model-btn") as HTMLButtonElement;
    // The two behaviour pills are locked exactly like the request parameters…
    expect(modeBtn.disabled).toBe(true);
    expect(parallelBtn.disabled).toBe(true);
    expect(modelBtn.disabled).toBe(true);
    expect((document.getElementById("ctx-range") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("compact-btn") as HTMLButtonElement).disabled).toBe(true);
    // …but they are NOT locked in silence: each names the policy the run is using and the way
    // out, so the row can never disagree with the run behind the user's back.
    expect(modeBtn.title).toContain("locked to this run");
    expect(modeBtn.title).toContain("Stop");
    expect(parallelBtn.title).toContain("locked to this run");
    expect(parallelBtn.title).toContain("Stop");

    // And no click reaches the host while the run is going.
    posted.length = 0;
    parallelBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    modeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(posted.some((m) => /setParallel|setMode/.test((m as { type?: string }).type ?? ""))).toBe(false);
  });

  it("a session switch re-reads the run's policies (a marker for the OLD run would be a lie)", async () => {
    // The pending marker describes the run the panel is following. Switching to another
    // session that is working in Build must not carry the previous one's Analyze over: the
    // pill would say "applies to the next run — this one is still Analyze" about a run that
    // IS Build.
    await loadView();
    const btn = document.getElementById("mode-btn") as HTMLButtonElement;
    hostMessage({ type: "status", active: true }); // session A works, in Analyze
    // A pending choice can only arrive from the HOST while it works (the pill is disabled),
    // so that is what a stale marker would have been built from.
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        mode: "agent",
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
    });
    expect(btn.classList.contains("is-pending")).toBe(true);

    hostMessage({
      type: "switchView",
      sessions: [{ id: "b", name: "B", createdAt: 1, updatedAt: 2, messageCount: 1 }],
      openIds: ["b"],
      activeId: "b",
      messages: [{ role: "user", content: "go", timestamp: 1 }],
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        mode: "agent",
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
      workingIds: ["b"],
      streaming: true,
    });

    expect(btn.textContent).toContain("Build"); // the new session's mode
    expect(btn.classList.contains("is-pending")).toBe(false);
    // Still working — but now on THIS run's policy, so the marker is gone on both counts.
    expect(btn.title).toContain("locked to this run");
    expect(btn.title).toContain("Build");
  });

  it("disables the tab × of a WORKING session (switching stays allowed)", async () => {
    await loadView();
    hostMessage({ type: "status", active: true, workingIds: ["b"] });
    const tabB = document.querySelector('.tab[data-id="b"]') as HTMLElement;
    const closeB = tabB.querySelector(".close") as HTMLElement;
    expect(closeB.classList.contains("disabled")).toBe(true);
    posted.length = 0;
    closeB.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(posted.some((m) => (m as { type?: string }).type === "closeTab")).toBe(false);
    // Switching the working tab is still allowed.
    tabB.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(posted).toContainEqual({ type: "switchTab", id: "b" });
    // A non-working tab can still be closed.
    const tabA = document.querySelector('.tab[data-id="a"]') as HTMLElement;
    (tabA.querySelector(".close") as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(posted).toContainEqual({ type: "closeTab", id: "a" });
  });

  it("re-enables the tab × once the session stops working", async () => {
    await loadView();
    hostMessage({ type: "status", active: true, workingIds: ["b"] });
    const closeB = document.querySelector('.tab[data-id="b"] .close') as HTMLElement;
    expect(closeB.classList.contains("disabled")).toBe(true);
    hostMessage({ type: "status", active: false, workingIds: [] });
    expect(closeB.classList.contains("disabled")).toBe(false);
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
    hostMessage({
      type: "refresh",
      messages: [
        { role: "user", content: "q", timestamp: 1 },
        { role: "assistant", content: "a", timestamp: 2 },
      ],
    });
    const key = document.querySelector(".msg.assistant .branch-at") as HTMLButtonElement;
    expect(key.disabled).toBe(false);
    hostMessage({ type: "status", active: true });
    expect(key.disabled).toBe(true);
    hostMessage({ type: "status", active: false });
    expect(key.disabled).toBe(false);
  });
});

describe("cut from user prompt bubble", () => {
  it("adds a ✂ key to every USER prompt bubble and posts truncateAt with its index", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [
        { role: "user", content: "q1", timestamp: 1 },
        { role: "assistant", content: "a1", timestamp: 2 },
        { role: "user", content: "q2", timestamp: 3 },
        { role: "assistant", content: "a2", timestamp: 4 },
      ],
    });
    const keys = document.querySelectorAll(".msg.user .truncate-at");
    // The prompt bubbles: q1 at index 0, q2 at index 2.
    expect(keys.length).toBe(2);
    expect(keys[0].querySelector("svg")).toBeTruthy(); // inline scissors icon
    // Assistant replies keep the ⎇ but must NOT carry the ✂.
    expect(document.querySelector(".msg.assistant .truncate-at")).toBeNull();
    (keys[0] as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "truncateAt", index: 0 });
    (keys[1] as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "truncateAt", index: 2 });
  });

  it("does not add the ✂ key to assistant loop notices (system annotations)", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [
        { role: "assistant", content: "🔁 **Loop guard** [empty] — empty turn nudged.", timestamp: 1, uiOnly: true },
      ],
    });
    const el = document.querySelector(".msg.assistant.loop") as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.querySelector(".truncate-at")).toBeNull();
  });

  it("disables the ✂ key while the session is working", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [
        { role: "user", content: "q", timestamp: 1 },
        { role: "assistant", content: "a", timestamp: 2 },
      ],
    });
    const key = document.querySelector(".msg.user .truncate-at") as HTMLButtonElement;
    expect(key.disabled).toBe(false);
    hostMessage({ type: "status", active: true });
    expect(key.disabled).toBe(true);
    hostMessage({ type: "status", active: false });
    expect(key.disabled).toBe(false);
  });
});

describe("harness-injected prompts", () => {
  it("renders ONLY the non-typed (harness) messages as light-blue 'Nudge' bubbles", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [
        { role: "user", harness: true, content: "**Parallel is ON** but you did NOT delegate.", timestamp: 1 },
        { role: "user", content: "a normal message I typed", timestamp: 2 },
      ],
    });
    const harnessEl = document.querySelector(".msg.user.harness") as HTMLElement;
    expect(harnessEl).toBeTruthy();
    expect(harnessEl.querySelector(".harness-robot")).toBeNull();
    expect(harnessEl.querySelector(".harness-label")?.textContent).toBe("Nudge");
    // Markdown is rendered (not plain text) and there is NO ✂ cut key.
    expect(harnessEl.querySelector(".harness-md strong")?.textContent).toContain("Parallel is ON");
    expect(harnessEl.querySelector(".harness-md")?.textContent).toContain("did NOT delegate");
    expect(harnessEl.querySelector(".truncate-at")).toBeNull();
    // The typed message keeps the NORMAL orange bubble (no harness marker).
    const typed = document.querySelector(".msg.user:not(.harness)") as HTMLElement;
    expect(typed).toBeTruthy();
    expect(typed.querySelector(".harness-label")).toBeNull();
    expect(document.querySelectorAll(".msg.user.harness").length).toBe(1);
  });

  it("renders a harness nudge LIVE from the harnessNudge message", async () => {
    await loadView();
    hostMessage({ type: "harnessNudge", content: "**Stop** repeating and act." });
    const el = document.querySelector(".msg.user.harness") as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.querySelector(".harness-label")?.textContent).toBe("Nudge");
    expect(el.querySelector(".harness-md strong")?.textContent).toContain("Stop");
  });
});

describe("the context-window checkpoint in the transcript", () => {
  // Everything before the pair is out of the window; everything after it is in.
  const PAST = [
    { role: "user", content: "first question", timestamp: 1 },
    { role: "assistant", content: "first answer", timestamp: 2 },
  ];
  const CHECKPOINT = [
    { role: "user", content: "Summary of past interactions", timestamp: 3, synthetic: true },
    { role: "assistant", content: "## Goal\ncarried", timestamp: 4, synthetic: true },
  ];

  it("marks where the window starts, saying how much sits above it", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [...PAST, ...CHECKPOINT, { role: "user", content: "after", timestamp: 5 }],
    });

    const divider = document.querySelector(".ctx-divider") as HTMLElement;
    expect(divider).toBeTruthy();
    expect(divider.textContent).toContain("2 messages above");
    // It sits immediately ABOVE the checkpoint: the line the window opens under.
    expect(divider.nextElementSibling?.classList.contains("synthetic-summary")).toBe(true);
  });

  it("renders the checkpoint pair as ONE object: a label and its summary body", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [...PAST, ...CHECKPOINT, { role: "user", content: "after", timestamp: 5 }],
    });

    const label = document.querySelector(".msg.user.synthetic-summary") as HTMLElement;
    expect(label).toBeTruthy();
    expect(label.querySelector(".synthetic-icon")).toBeTruthy();
    // The summary is the BODY of that card, not an answer the model just gave.
    const body = document.querySelector(".msg.assistant.synthetic-body") as HTMLElement;
    expect(body).toBeTruthy();
    expect(body.textContent).toContain("carried");
    // Exactly one card, and the body is the message right after the label.
    expect(document.querySelectorAll(".msg.assistant.synthetic-body").length).toBe(1);
    expect(label.nextElementSibling).toBe(body);
    // The message after the checkpoint is a NORMAL bubble again.
    expect(document.querySelectorAll(".msg.assistant.synthetic-body").length).toBe(1);
  });

  it("renders none of it while no compaction has happened", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [
        ...PAST,
        { role: "user", content: "after", timestamp: 5 },
        { role: "assistant", content: "ok", timestamp: 6 },
      ],
    });

    expect(document.querySelector(".ctx-divider")).toBeNull();
    expect(document.querySelector(".msg.assistant.synthetic-body")).toBeNull();
    expect(document.querySelector(".msg.user.synthetic-summary")).toBeNull();
  });

  it("counts only what is ABOVE the checkpoint (and never the checkpoint itself)", async () => {
    await loadView();
    // A second compaction folded the first pair in: the transcript now holds the
    // whole past, ONE pair, and the active tail.
    hostMessage({
      type: "refresh",
      messages: [
        { role: "user", content: "antichissima", timestamp: 1 },
        { role: "assistant", content: "old answer", timestamp: 2 },
        { role: "user", content: "Vecchio riepilogo", timestamp: 3, synthetic: true },
        { role: "assistant", content: "old state", timestamp: 4, synthetic: true },
        { role: "user", content: "in mezzo", timestamp: 5 },
        { role: "assistant", content: "replica", timestamp: 6 },
        { role: "user", content: "Summary of past interactions", timestamp: 7, synthetic: true },
        { role: "assistant", content: "## Goal\nnew", timestamp: 8, synthetic: true },
        { role: "user", content: "last", timestamp: 9 },
      ],
    });

    const dividers = document.querySelectorAll(".ctx-divider");
    expect(dividers.length).toBe(1); // ONE marker: only the newest checkpoint bounds the window
    // 4 non-synthetic messages sit above the newest pair (the old pair is not counted).
    expect(dividers[0].textContent).toContain("4 messages above");
    expect(document.querySelectorAll(".msg.assistant.synthetic-body").length).toBe(1);
    // The OLD pair is folded into ONE dim row instead of being rendered as a card again:
    // its content already lives in the newest summary, and the pile of half-cards was
    // exactly what a session that shrank several times built up.
    expect(document.querySelectorAll(".msg.user.synthetic-summary").length).toBe(1);
    expect(document.querySelector(".old-summaries")?.textContent).toContain("1 earlier summary");
  });

  it("leaves a pointer to the card where the reader is — and none when nothing compacted", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [...PAST, ...CHECKPOINT, { role: "user", content: "after", timestamp: 5 }],
    });

    // The card opens the window, which puts it several screens ABOVE the bottom: the
    // compaction would otherwise have no visible effect where the reader is looking.
    hostMessage({ type: "compactDone", ok: true });
    const hint = document.querySelector(".compacted-hint button") as HTMLElement;
    expect(hint).toBeTruthy();
    expect(hint.textContent).toContain("the summary is above");

    // A compaction that moved nothing must not leave that claim behind.
    document.querySelector(".compacted-hint")?.remove();
    hostMessage({ type: "compactDone", ok: false });
    expect(document.querySelector(".compacted-hint")).toBeNull();
  });
});

describe("version in the main screen", () => {
  it("shows the version in the empty hero", async () => {
    setupDom({ openIds: [], activeId: undefined, messages: [], version: "0.1.0" });
    await loadView();
    expect(document.querySelector(".empty-hero .empty-version")?.textContent).toBe("v0.1.0");
  });

  it("omits the version line when unknown", async () => {
    setupDom({ openIds: [], activeId: undefined, messages: [] });
    await loadView();
    expect(document.querySelector(".empty-hero .empty-version")).toBeNull();
  });
});

describe("in-panel alert modal", () => {
  it("shows the alert and OK responds true", async () => {
    await loadView();
    hostMessage({
      type: "modal",
      modalId: 7,
      kind: "alert",
      alertKind: "info",
      title: "Name already in use",
      message: "A session named X already exists.",
    });
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
    hostMessage({
      type: "modal",
      modalId: 3,
      kind: "alert",
      alertKind: "confirm",
      title: "Delete session",
      message: "Delete session X?",
      confirmText: "Delete",
    });
    expect((document.getElementById("alert-ok") as HTMLButtonElement).textContent).toBe("Delete");
    (document.getElementById("alert-cancel") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "modalResponse", id: 3, value: false });

    hostMessage({
      type: "modal",
      modalId: 4,
      kind: "alert",
      alertKind: "confirm",
      title: "T",
      message: "M",
      confirmText: "OK",
    });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(posted).toContainEqual({ type: "modalResponse", id: 4, value: false });
  });

  it("single-button alerts hide the Cancel key", async () => {
    await loadView();
    hostMessage({ type: "modal", modalId: 1, kind: "alert", alertKind: "error", title: "E", message: "M" });
    expect((document.getElementById("alert-cancel") as HTMLButtonElement).style.display).toBe("none");
  });

  it("extra answers come from the HOST and respond with their own value", async () => {
    await loadView();
    // The trash asks three things at once: the modal has to relay WHICH one was
    // clicked, not just "confirmed".
    hostMessage({
      type: "modal",
      modalId: 11,
      kind: "alert",
      alertKind: "confirm",
      title: "Delete or empty session",
      message: "What do you want to do?",
      confirmText: "Delete",
      extraActions: [
        { value: "rewind", text: "Rewind", title: "no summary yet", disabled: true },
        { value: "empty", text: "Empty", title: "drop the transcript" },
      ],
    });
    const extras = document.querySelectorAll<HTMLButtonElement>("#alert-modal .alert-extra");
    expect(extras).toHaveLength(2);
    expect(extras[0].textContent).toBe("Rewind");
    // Disabled, not hidden: a choice that cannot apply still names itself.
    expect(extras[0].disabled).toBe(true);
    expect(extras[0].title).toBe("no summary yet");
    extras[0].click(); // a disabled button answers nothing
    expect(posted.some((m: any) => m.type === "modalResponse")).toBe(false);
    extras[1].click();
    expect(posted).toContainEqual({ type: "modalResponse", id: 11, value: "empty" });
    expect((document.getElementById("alert-modal") as HTMLDivElement).classList.contains("hidden")).toBe(true);
  });

  it("a later alert does not inherit the previous question's extra answers", async () => {
    await loadView();
    hostMessage({
      type: "modal",
      modalId: 12,
      kind: "alert",
      alertKind: "confirm",
      title: "T",
      message: "M",
      extraActions: [{ value: "empty", text: "Empty" }],
    });
    expect(document.querySelectorAll("#alert-modal .alert-extra")).toHaveLength(1);
    (document.getElementById("alert-cancel") as HTMLButtonElement).click();
    hostMessage({ type: "modal", modalId: 13, kind: "alert", alertKind: "confirm", title: "T2", message: "M2" });
    expect(document.querySelectorAll("#alert-modal .alert-extra")).toHaveLength(0);
    // …and the plain confirm still answers true/false.
    (document.getElementById("alert-ok") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "modalResponse", id: 13, value: true });
  });
});

it("updates the context-window slider + label from the host-pushed value", async () => {
  await loadView();
  const label = document.getElementById("ctx-value") as HTMLElement;
  expect(label.textContent).toBe("128000");
  hostMessage({
    type: "config",
    config: { provider: "openai", model: "m", hasKey: true, models: [], providerModels: [], contextWindow: 131072 },
  });
  // The LABEL keeps the EXACT value; the slider sits on the nearest step.
  expect(label.textContent).toBe("131072");
});

it("presence/frequency sliders render, post on drag and reset to Auto", async () => {
  await loadView();
  hostMessage({
    type: "config",
    config: {
      provider: "openai",
      model: "gpt-4o",
      hasKey: true,
      models: [],
      providerModels: [],
      presencePenalty: 1.5,
      frequencyPenalty: 0.5,
    },
  });
  const p = document.getElementById("presence-range") as HTMLInputElement;
  const pv = document.getElementById("presence-value") as HTMLElement;
  const fv = document.getElementById("freq-value") as HTMLElement;
  expect(pv.textContent).toBe("1.5");
  expect(fv.textContent).toBe("0.5");
  p.value = "1.6";
  p.dispatchEvent(new Event("input"));
  expect(pv.textContent).toBe("1.6"); // live mirror
  p.dispatchEvent(new Event("change"));
  expect(posted).toContainEqual({ type: "setPresencePenalty", value: 1.6 });
  (document.getElementById("freq-auto") as HTMLButtonElement).click();
  expect(posted).toContainEqual({ type: "setFrequencyPenalty", value: null });
  expect(fv.textContent).toBe("Auto");
  // Auto SNAPS the slider to the knob's default (0 for a penalty).
  expect((document.getElementById("freq-range") as HTMLInputElement).value).toBe("0");
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
  it("shows tokens, percent and bar, and posts compact", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [],
        contextWindow: 200000,
        contextTokens: 100000,
      },
    });
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
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [],
        contextWindow: 100000,
        contextTokens: 95000,
      },
    });
    expect((document.getElementById("ctx-bar") as HTMLDivElement).classList.contains("warn")).toBe(true);
  });

  it("measures the fill against the USABLE budget (window − reserve), not the raw window", async () => {
    await loadView();
    // The exact state that killed a real session: 1M window, 384k of output
    // reserved, 663.3k of input. Against the window it reads a harmless 66%,
    // while the provider was already rejecting the request (666.820 + 384.000
    // = 1.050.820 > 1.048.576). The usable budget is what must be shown.
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "deepseek-v4.1-flash",
        hasKey: true,
        models: [],
        providerModels: [],
        contextWindow: 1_048_576,
        contextUsable: 664_576,
        contextTokens: 663_300,
      },
    });
    expect(document.getElementById("met-ctx")?.textContent).toBe("664.6k");
    expect(document.getElementById("met-pct")?.textContent).toBe("(100%)");
    expect((document.getElementById("ctx-bar") as HTMLDivElement).style.width).toBe("100%");
    // …and the DECLARED window stays attached to the usable value, so "616k" is
    // never a number out of nowhere. Most contracted form: no connector words.
    expect(document.getElementById("met-window")?.textContent).toBe("/1M");
    // The breakdown stays reachable: window − reserved = usable.
    const title = document.getElementById("met-ctx")?.getAttribute("title") ?? "";
    expect(title).toContain("1M context window");
    expect(title).toContain("384k reserved for the response");
    expect(title).toContain("664.6k usable tokens");
  });

  it("shows no window suffix when nothing is reserved (no pointless '/1M')", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [],
        // usable === window: host pushed no reserve (older payload, or a session
        // whose output budget is not set yet).
        contextWindow: 200000,
        contextUsable: 200000,
        contextTokens: 50000,
      },
    });
    const note = document.getElementById("met-window") as HTMLSpanElement;
    expect(note.textContent).toBe("");
    expect(note.getAttribute("title")).toBe("");
    // The empty span is hidden by CSS (#met-window:empty).
    expect(document.getElementById("met-ctx")?.textContent).toBe("200k");
    expect(document.getElementById("met-pct")?.textContent).toBe("(25%)");
  });

  it("gear opens the threshold form, prefills the current %, saves and posts", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [],
        contextWindow: 200000,
        compactionThresholdPercent: 60,
      },
    });
    const modal = document.getElementById("compact-settings-modal") as HTMLDivElement;
    expect(modal.classList.contains("hidden")).toBe(true);
    // The label already shows the session's saved threshold from the config push.
    expect(document.getElementById("compact-threshold-label")?.textContent).toBe("Auto 60% ctx · keep 8%");
    (document.getElementById("compact-settings-btn") as HTMLButtonElement).click();
    expect(modal.classList.contains("hidden")).toBe(false);
    const input = document.getElementById("compact-threshold-input") as HTMLInputElement;
    expect(input.value).toBe("60");
    input.value = "75";
    (document.getElementById("compact-settings-save") as HTMLButtonElement).click();
    expect(modal.classList.contains("hidden")).toBe(true);
    expect(posted).toContainEqual({ type: "setCompactionThreshold", value: 75 });
    // The label between Compact and the gear reflects the saved value.
    expect(document.getElementById("compact-threshold-label")?.textContent).toBe("Auto 75% ctx · keep 9%");

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

  it("the gear also sets the LANDING point, with its own range", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [],
        contextWindow: 200000,
        compactionThresholdPercent: 60,
        compactionTargetPercent: 20,
        compactionTargetAuto: false,
      },
    });
    // The label shows the whole policy: the AUTO-compaction trigger, then how much survives.
    expect(document.getElementById("compact-threshold-label")?.textContent).toBe("Auto 60% ctx · keep 20%");

    (document.getElementById("compact-settings-btn") as HTMLButtonElement).click();
    const target = document.getElementById("compact-target-input") as HTMLInputElement;
    expect(target.value).toBe("20");
    // Its own range now: the knobs do not constrain each other, and the one rule between them
    // (landing < trigger) is applied when you save and stated in the label.
    expect(target.max).toBe("100");

    target.value = "55";
    target.dispatchEvent(new Event("input"));
    (document.getElementById("compact-settings-save") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "setCompactionTarget", value: 55 });
    expect(document.getElementById("compact-threshold-label")?.textContent).toBe("Auto 60% ctx · keep 55%");

    // Default: back to an eighth of the trigger (8 with 60). The SLIDER follows the derived
    // value and the label marks it as the default; Save posts no explicit value.
    (document.getElementById("compact-settings-btn") as HTMLButtonElement).click();
    (document.getElementById("compact-target-auto") as HTMLButtonElement).click();
    expect(target.value).toBe("8");
    expect(document.getElementById("compact-target-value")?.textContent).toBe("8% (default)");
    (document.getElementById("compact-settings-save") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "setCompactionTarget", value: undefined });
    expect(document.getElementById("compact-threshold-label")?.textContent).toBe("Auto 60% ctx · keep 8%");
  });

  it("CANCEL throws the draft away: reopening shows the stored policy, not the edit", async () => {
    // The sliders used to mutate the LIVE state, so a cancelled edit stayed behind and reopening
    // showed a policy that was never saved.
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [],
        contextWindow: 200000,
        compactionThresholdPercent: 60,
      },
    });
    const label = () => document.getElementById("compact-threshold-label")?.textContent;
    expect(label()).toBe("Auto 60% ctx · keep 8%");
    const threshold = document.getElementById("compact-threshold-input") as HTMLInputElement;
    const target = document.getElementById("compact-target-input") as HTMLInputElement;

    (document.getElementById("compact-settings-btn") as HTMLButtonElement).click();
    threshold.value = "90";
    threshold.dispatchEvent(new Event("input"));
    (document.getElementById("compact-target-auto") as HTMLButtonElement).click();
    expect(threshold.value).toBe("90");
    (document.getElementById("compact-settings-cancel") as HTMLButtonElement).click();

    // Nothing was written…
    expect(posted.filter((m) => (m as { type: string }).type === "setCompactionThreshold")).toEqual([]);
    // …the footer still describes the STORED policy…
    expect(label()).toBe("Auto 60% ctx · keep 8%");
    // …and reopening starts from the stored values, not from the cancelled edit.
    (document.getElementById("compact-settings-btn") as HTMLButtonElement).click();
    expect(threshold.value).toBe("60");
    expect(target.value).toBe("8");
    expect(document.getElementById("compact-target-value")?.textContent).toBe("8% (default)");
  });

  it("the landing slider reaches 0 (minimum) and the Default button restores the derived one", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [],
        contextWindow: 200000,
        compactionThresholdPercent: 80,
      },
    });
    (document.getElementById("compact-settings-btn") as HTMLButtonElement).click();
    const threshold = document.getElementById("compact-threshold-input") as HTMLInputElement;
    const target = document.getElementById("compact-target-input") as HTMLInputElement;
    const targetValue = document.getElementById("compact-target-value") as HTMLSpanElement;
    // No override in the config: the slider shows the DERIVED default (an eighth of 80) and
    // the label says so — "Auto" belongs to the trigger, not to this knob.
    expect(target.value).toBe("10");
    expect(targetValue.textContent).toBe("10% (default)");
    expect(document.getElementById("compact-threshold-value")?.textContent).toBe("80%");

    // Moving the trigger moves the DEFAULT with it — AUTO is the one mode that follows — but the
    // landing slider's own range never shrinks.
    threshold.value = "50";
    threshold.dispatchEvent(new Event("input"));
    expect(target.value).toBe("6");
    expect(targetValue.textContent).toBe("6% (default)");
    expect(target.max).toBe("100");

    // 0 is a POSITION, not a mode: it means "only the summary remains".
    target.value = "0";
    target.dispatchEvent(new Event("input"));
    expect(targetValue.textContent).toBe("0% (min)");
    expect(document.getElementById("compact-target-auto")?.classList.contains("is-on")).toBe(false);
    threshold.value = "90";
    threshold.dispatchEvent(new Event("input"));
    expect(target.value).toBe("0"); // an explicit choice does not follow the trigger

    // Default puts it back on the derived value for the CURRENT trigger (round(90/8) = 11).
    (document.getElementById("compact-target-auto") as HTMLButtonElement).click();
    expect(target.value).toBe("11");
    expect(targetValue.textContent).toBe("11% (default)");
    expect(document.getElementById("compact-target-auto")?.classList.contains("is-on")).toBe(true);
  });

  it("renders the host's compaction plan in the modal", async () => {
    await loadView();
    (document.getElementById("compact-settings-btn") as HTMLButtonElement).click();
    hostMessage({
      type: "compactionPreview",
      thresholdPercent: 80,
      targetPercent: 20,
      minTargetPercent: 4,
      autoTargetPercent: 20,
      usableTokens: 100000,
      targetTokens: 20000,
      fillTokens: 90000,
      fillPercent: 90,
      aboveThreshold: true,
      summarizeCount: 12,
      summarizeTokens: 60000,
      keepCount: 5,
      keepTokens: 20000,
      summaryBudgetTokens: 6000,
      deferredCount: 2,
    });
    const text = (document.getElementById("compact-preview") as HTMLPreElement).textContent ?? "";
    expect(text).toContain("now 90%");
    expect(text).toContain("12 message(s) → summary");
    expect(text).toContain("5 kept verbatim");
    expect(text).toContain("Lands at ~20k");
    // A deferred span is NOT hidden: the reader learns that one pass cannot read it all.
    expect(text).toContain("cannot be read in one request");
    // Both derived bounds are reported: the DEFAULT and the smallest explicit value.
    expect(text).toContain("Auto = 20%");
    expect(text).toContain("smallest explicit = 4%");
    expect((document.getElementById("compact-target-input") as HTMLInputElement).value).toBe("10");
  });

  it("says there is nothing to compact yet when the fill is under the trigger", async () => {
    await loadView();
    (document.getElementById("compact-settings-btn") as HTMLButtonElement).click();
    hostMessage({
      type: "compactionPreview",
      thresholdPercent: 80,
      targetPercent: 20,
      minTargetPercent: 4,
      autoTargetPercent: 20,
      usableTokens: 100000,
      targetTokens: 20000,
      fillTokens: 41000,
      fillPercent: 41,
      aboveThreshold: false,
      summarizeCount: 0,
      keepCount: 0,
      summaryBudgetTokens: 0,
      deferredCount: 0,
    });
    const text = (document.getElementById("compact-preview") as HTMLPreElement).textContent ?? "";
    expect(text).toContain("Nothing to compact yet");
    expect(text).toContain("41%");
    expect(text).toContain("trigger 80%");
  });

  it("a slider position below the derived floor means 0", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [],
        contextWindow: 200000,
        compactionThresholdPercent: 80,
      },
    });
    (document.getElementById("compact-settings-btn") as HTMLButtonElement).click();
    const target = document.getElementById("compact-target-input") as HTMLInputElement;
    const value = document.getElementById("compact-target-value") as HTMLSpanElement;
    // The host's plan carries the floor: below it there is nothing left to free.
    hostMessage({
      type: "compactionPreview",
      thresholdPercent: 80,
      targetPercent: 10,
      minTargetPercent: 8,
      autoTargetPercent: 10,
      usableTokens: 100000,
      targetTokens: 10000,
      fillTokens: 90000,
      fillPercent: 90,
      aboveThreshold: true,
      summarizeCount: 10,
      summarizeTokens: 80000,
      keepCount: 4,
      keepTokens: 9000,
      summaryBudgetTokens: 8000,
      deferredCount: 0,
    });

    // Below the floor the SLIDER keeps the position you chose (nothing jumps under your finger),
    // and the label states what will be stored: the floor rule is applied at save time.
    target.value = "4";
    target.dispatchEvent(new Event("input"));
    expect(target.value).toBe("4");
    expect(value.textContent).toContain("→ saved as 0%");
    posted.length = 0;
    (document.getElementById("compact-settings-save") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "setCompactionTarget", value: 0 });

    // A value AT the floor is a real choice and is kept as it is.
    (document.getElementById("compact-settings-btn") as HTMLButtonElement).click();
    target.value = "8";
    target.dispatchEvent(new Event("input"));
    expect(target.value).toBe("8");
    expect(value.textContent).toBe("8%");
  });

  it("Escape closes the policy card, and the sliders do not post until Save", async () => {
    await loadView();
    const modal = document.getElementById("compact-settings-modal") as HTMLDivElement;
    (document.getElementById("compact-settings-btn") as HTMLButtonElement).click();
    const input = document.getElementById("compact-threshold-input") as HTMLInputElement;
    input.value = "90";
    // With sliders there is no Enter-to-save: the value is applied by Save only.
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(posted).not.toContainEqual({ type: "setCompactionThreshold", value: 90 });
    expect(modal.classList.contains("hidden")).toBe(false);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(modal.classList.contains("hidden")).toBe(true);
    expect(posted).not.toContainEqual({ type: "setCompactionThreshold", value: 80 }); // no extra post on Escape
  });
});

describe("context window slider", () => {
  it("renders the context value from config and posts on drag", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [],
        contextWindow: 200000,
      },
    });
    const range = document.getElementById("ctx-range") as HTMLInputElement;
    const label = document.getElementById("ctx-value") as HTMLElement;
    expect(label.textContent).toBe("200000");

    range.value = "300000";
    range.dispatchEvent(new Event("input"));
    expect(label.textContent).toBe("300000"); // live mirror
    range.dispatchEvent(new Event("change"));
    expect(posted).toContainEqual({ type: "setContextWindow", value: 300000 });
  });

  it("clamps an out-of-range slider value to the window bounds", async () => {
    await loadView();
    const range = document.getElementById("ctx-range") as HTMLInputElement;
    range.value = "10"; // below min -> 1000
    range.dispatchEvent(new Event("change"));
    expect(posted).toContainEqual({ type: "setContextWindow", value: 1000 });
  });
});

describe("output tokens slider", () => {
  it("renders the value from config (default 8192) and posts on drag", async () => {
    await loadView();
    const range = document.getElementById("out-range") as HTMLInputElement;
    const label = document.getElementById("out-value") as HTMLElement;
    expect(label.textContent).toBe("8192");

    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [],
        outputTokens: 32768,
      },
    });
    expect(label.textContent).toBe("32768");

    range.value = "20000";
    range.dispatchEvent(new Event("input"));
    expect(label.textContent).toBe("20000");
    range.dispatchEvent(new Event("change"));
    expect(posted).toContainEqual({ type: "setOutputTokens", value: 20000 });
  });

  it("clamps an out-of-range slider value to the output bounds", async () => {
    await loadView();
    const range = document.getElementById("out-range") as HTMLInputElement;
    range.value = "100"; // below min -> 256
    range.dispatchEvent(new Event("change"));
    expect(posted).toContainEqual({ type: "setOutputTokens", value: 256 });
  });
});

describe("sampler (radio + slider)", () => {
  it("renders the ACTIVE sampler value and posts on drag", async () => {
    await loadView();
    const range = document.getElementById("samp-range") as HTMLInputElement;
    const label = document.getElementById("samp-value") as HTMLElement;
    // Temperature by default, no value -> Auto.
    expect(label.textContent).toBe("Auto");
    // Auto snaps the slider to the default (1.0).
    expect(range.value).toBe("1");
    expect((document.getElementById("sampler-temp") as HTMLInputElement).checked).toBe(true);

    hostMessage({
      type: "config",
      config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], temperature: 0.7 },
    });
    expect(label.textContent).toBe("0.7");

    range.value = "1.5";
    range.dispatchEvent(new Event("input"));
    expect(label.textContent).toBe("1.5");
    range.dispatchEvent(new Event("change"));
    expect(posted).toContainEqual({ type: "setSamplerValue", value: 1.5 });
  });

  it("clamps to the ACTIVE scale and the Auto button resets to null", async () => {
    await loadView();
    const range = document.getElementById("samp-range") as HTMLInputElement;
    const label = document.getElementById("samp-value") as HTMLElement;
    const auto = document.getElementById("samp-auto") as HTMLButtonElement;

    range.value = "2"; // temperature scale cap
    range.dispatchEvent(new Event("change"));
    expect(posted).toContainEqual({ type: "setSamplerValue", value: 2 });
    expect(label.textContent).toBe("2");

    // Switch to Top-P: the radio posts the mode AND the scale re-adapts
    // IMMEDIATELY (before the host config push), so the whole track is usable.
    (document.getElementById("sampler-topp") as HTMLInputElement).click();
    expect(posted).toContainEqual({ type: "setSamplerMode", mode: "topP" });
    expect(range.max).toBe("1");
    expect((document.getElementById("samp-range-label") as HTMLElement).textContent).toBe("(0.0 → 1.0)");

    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [],
        sampler: "topP",
        topP: 0.9,
      },
    });
    expect(label.textContent).toBe("0.9");
    expect((document.getElementById("sampler-topp") as HTMLInputElement).checked).toBe(true);

    auto.click();
    expect(posted).toContainEqual({ type: "setSamplerValue", value: null });
    expect(label.textContent).toBe("Auto");
    // Auto SNAPS the slider to the sampler default (1.0).
    expect(range.value).toBe("1");
  });
});
describe("empty shell (no open session)", () => {
  it("hides the control stack and shows the hero when no session is active", async () => {
    setupDom({ sessions: [], openIds: [], activeId: undefined, messages: [] });
    await loadView();
    expect(document.body.classList.contains("no-session")).toBe(true);
    expect((document.getElementById("input-area") as HTMLElement).style.display).toBe(""); // hidden via CSS class
    expect(document.querySelector(".empty-hero")).not.toBeNull();
    expect(document.querySelector(".empty-hero h2")?.textContent).toContain("Harny");
  });

  it("loads the brand mark from the external media/icon.svg URI", async () => {
    setupDom({
      sessions: [],
      openIds: [],
      activeId: undefined,
      messages: [],
      logoUri: "vscode-webview://x/media/icon.svg?v=42",
    });
    await loadView();
    const img = document.querySelector<HTMLImageElement>(".empty-hero .empty-logo img");
    expect(img?.getAttribute("src")).toBe("vscode-webview://x/media/icon.svg?v=42");
  });

  it("inlines NOTHING when the host sends no logo URI", async () => {
    setupDom({ sessions: [], openIds: [], activeId: undefined, messages: [] });
    await loadView();
    expect(document.querySelector(".empty-hero .empty-logo img")).toBeNull();
    expect(document.querySelector(".empty-hero .empty-logo svg")).toBeNull();
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
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
      workingIds: [],
    });
    expect(document.body.classList.contains("no-session")).toBe(false);
    expect(document.querySelector(".empty-hero")).toBeNull();
    expect(document.querySelector("#messages .msg.user")?.textContent).toBe("hello");
  });

  describe("home shell (no single folder open)", () => {
    /** What the host sends when there is no usable root: `workspaceReady: false`. */
    const HOME_CONFIG = {
      provider: "openai",
      model: "gpt-4o",
      hasKey: true,
      models: [],
      providerModels: [],
      contextWindow: 128000,
      workspaceReady: false,
    };
    /** Two sessions of two DIFFERENT workspaces, most recent first. */
    const TWO_FOLDERS = [
      { id: "a", name: "Casa", createdAt: 1, updatedAt: 9, messageCount: 25, folder: "/p/harny" },
      { id: "b", name: "Test", createdAt: 2, updatedAt: 8, messageCount: 6, folder: "/p/test" },
    ];

    function setupHome(overrides: Record<string, unknown> = {}, config: Record<string, unknown> = {}): void {
      setupDom({
        sessions: TWO_FOLDERS,
        openIds: [],
        activeId: undefined,
        messages: [],
        ...overrides,
        config: { ...HOME_CONFIG, ...config },
      });
    }

    it("keeps the sessions list on screen: the history says WHICH workspace to open", async () => {
      setupHome();
      await loadView();
      expect(document.body.classList.contains("no-workspace")).toBe(true);
      expect(document.body.classList.contains("no-session")).toBe(false);
      // The card and its search field are NOT hidden: they are the picker now.
      expect(document.getElementById("sessions")!.classList.contains("hidden")).toBe(false);
      expect(document.getElementById("session-search-row")!.classList.contains("hidden")).toBe(false);
      // Every folder's sessions, and each row names its folder.
      expect(document.querySelectorAll(".srow.home").length).toBe(2);
      expect(document.querySelector('.srow[data-id="a"] .srow-folder')?.textContent).toBe("/p/harny");
      expect(document.querySelector('.srow[data-id="b"] .srow-folder')?.textContent).toBe("/p/test");
    });

    it("a row opens its FOLDER, never the session (no root means no working directory)", async () => {
      setupHome();
      await loadView();
      const row = document.querySelector('.srow[data-id="b"]') as HTMLElement;
      row.click();
      expect(posted).toContainEqual({ type: "openSessionFolder", id: "b" });
      expect(posted.some((m: any) => m.type === "openSession")).toBe(false);
      // The whole row is a real control, so the keyboard must work too.
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      expect(posted.filter((m: any) => m.type === "openSessionFolder").length).toBe(2);
    });

    it("offers the PICKER when the folder is gone, and says so in red", async () => {
      setupHome({
        sessions: [
          {
            id: "g",
            name: "Gone",
            createdAt: 1,
            updatedAt: 2,
            messageCount: 1,
            folder: "/p/gone",
            folderMissing: true,
          },
        ],
      });
      await loadView();
      const row = document.querySelector('.srow[data-id="g"]') as HTMLElement;
      // "Open folder" would reload the window onto a path that does not exist.
      expect(row.querySelector(".srow-open")?.textContent).toBe("Change folder…");
      expect((row.querySelector(".srow-folder") as HTMLElement).classList.contains("missing")).toBe(true);
      expect(row.title).toContain("not available");
      row.click();
      // One message either way: the HOST decides (open vs pick) for both surfaces.
      expect(posted).toContainEqual({ type: "openSessionFolder", id: "g" });
    });

    it("ignores keys that are not Enter/Space (typing must not reload the window)", async () => {
      setupHome();
      await loadView();
      const row = document.querySelector('.srow[data-id="a"]') as HTMLElement;
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
      expect(posted.some((m: any) => m.type === "openSessionFolder")).toBe(false);
    });

    it("carries rename and delete, but NOT branch: a copy needs a folder, and home IS 'no folder'", async () => {
      setupHome();
      await loadView();
      const row = document.querySelector('.srow[data-id="a"]') as HTMLElement;
      expect(row.getAttribute("role")).toBe("button");
      // The two keys that act BY ID on the stored row need no working directory: they are
      // what you want when you land here and notice a session you would rather not keep.
      expect(row.querySelector(".srow-actions .rename")).toBeTruthy();
      expect(row.querySelector(".srow-actions .del")).toBeTruthy();
      // …branch does: the store stamps the CURRENT root on `create`, so a copy made in this
      // state would be born outside every workspace and live nowhere. All sessions has it.
      expect(row.querySelector(".srow-actions .branch")).toBeNull();
      expect(row.querySelectorAll("button").length).toBe(2);
    });

    it("rename/delete act on the row WITHOUT choosing the folder — by click and by keyboard", async () => {
      setupHome();
      await loadView();
      const row = document.querySelector('.srow[data-id="a"]') as HTMLElement;
      const rename = row.querySelector(".srow-actions .rename") as HTMLButtonElement;
      const del = row.querySelector(".srow-actions .del") as HTMLButtonElement;
      rename.click();
      expect(posted).toContainEqual({ type: "renameSession", id: "a" });
      del.click();
      expect(posted).toContainEqual({ type: "deleteSession", id: "a" });
      // ⏎ on ✎ bubbles to the row, which would pick a WORKSPACE instead of renaming: a
      // write gesture disguised as another one. The row listens to its own keys only.
      rename.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      del.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      expect(posted.filter((m: any) => m.type === "openSessionFolder").length).toBe(0);
    });

    it("a WORKING session's keys are disabled here too (one rule for both lists)", async () => {
      setupHome({ workingIds: ["a"] });
      await loadView();
      const row = document.querySelector('.srow[data-id="a"]') as HTMLElement;
      const del = row.querySelector(".srow-actions .del") as HTMLButtonElement;
      const rename = row.querySelector(".srow-actions .rename") as HTMLButtonElement;
      expect(del.disabled).toBe(true);
      expect(del.title).toContain("stop it before deleting");
      expect(rename.disabled).toBe(true);
      expect(rename.title).toContain("stop it before renaming");
    });

    it("names WHY it cannot work: no folder, or more than one", async () => {
      setupHome();
      await loadView();
      expect(document.querySelector(".empty-hero p")?.textContent).toBe("No folder is open.");

      // Telling someone with three open roots that no folder is open reads like a bug.
      setupHome({}, { workspaceFolderCount: 3 });
      await loadView();
      expect(document.querySelector(".empty-hero p")?.textContent).toContain("3 folders are open");
    });

    it("keeps the CHAT — and its STOP — when a session is open and the folder is gone", async () => {
      // Seen in the field: the watcher rebuilt the panel while a run was streaming, the
      // panel became the workspace picker, and a LIVE turn was left with no way to stop it
      // (the control stack is hidden there) while the stream drew over the hero.
      setupHome(
        {
          sessions: [
            {
              id: "a",
              name: "Working",
              createdAt: 1,
              updatedAt: 9,
              messageCount: 3,
              folder: "/p/gone",
              folderMissing: true,
            },
          ],
          openIds: ["a"],
          activeId: "a",
          messages: [{ role: "user", content: "hi" }],
          workingIds: ["a"],
        },
        { workspaceFolderCount: 1, workspaceFolder: "/p/gone" },
      );
      await loadView();
      // A session is open: the CHAT is the screen, not the picker…
      expect(document.body.classList.contains("no-workspace")).toBe(false);
      expect(document.body.classList.contains("no-session")).toBe(false);
      expect(document.querySelector(".empty-hero")).toBeNull();
      expect(document.querySelector("#messages .msg.user")?.textContent).toBe("hi");
      // The prompt stays YOURS (typing and attaching are allowed — the decision may be "later"),
      // but PLAY cannot start a run: it opens the re-point dialog instead of painting an
      // optimistic "Working…" that nothing would ever clear.
      expect((document.getElementById("user-input") as HTMLTextAreaElement).disabled).toBe(false);
      (document.getElementById("user-input") as HTMLTextAreaElement).value = "hello";
      document.getElementById("send-btn")?.click();
      expect(posted).toContainEqual({ type: "openSessionFolder", id: "a" });
      expect(posted.some((m) => (m as { type: string }).type === "send")).toBe(false);
      // …and no "Working…" was painted: the run never started.
      expect(document.querySelector(".working")).toBeNull();
      // The NOTICE is the host's dialog (`warnLostFolder` → the same "Folder no longer
      // available" alert as the red row), not a banner drawn here: one voice, and the panel
      // stays readable. What stays local is the inert prompt.
      expect(document.querySelector(".ws-gone")).toBeNull();
    });

    it("names a workspace folder that is GONE, and offers another one", async () => {
      // `workspaceReady: false` with ONE folder means exactly one thing: it no longer
      // exists. Reporting that as "no folder is open" reads like a bug.
      setupHome({}, { workspaceFolderCount: 1, workspaceFolder: "/p/gone" });
      await loadView();
      expect(document.querySelector(".empty-hero p")?.textContent).toBe(
        "The workspace folder /p/gone no longer exists.",
      );
      // The path is the one fact that says WHAT is missing.
      expect(document.querySelector(".empty-hero .folder-path")?.textContent).toBe("/p/gone");
      expect(document.querySelector(".empty-hero .empty-hint")?.textContent).toContain("Your sessions are safe");
      expect(document.getElementById("home-open-folder")?.textContent).toBe("Open another folder…");
    });

    it("asks the host for a folder from the hero's CTA (and nothing else)", async () => {
      setupHome();
      await loadView();
      const cta = document.getElementById("home-open-folder") as HTMLButtonElement;
      expect(cta).not.toBeNull();
      expect(cta.textContent).toBe("Open folder…");
      cta.click();
      expect(posted).toContainEqual({ type: "openWorkspace" });
      // No session is created from here: the folder comes first.
      expect(posted.some((m: any) => m.type === "newSession")).toBe(false);
    });

    it("an empty history still points at the folder instead of claiming there is nothing", async () => {
      setupHome({ sessions: [] });
      await loadView();
      expect(document.querySelector("#sessions .empty")?.textContent).toContain("Open a folder to start one");
    });

    it("goes back to normal rows as soon as a folder IS open (the mode is per render)", async () => {
      setupHome();
      await loadView();
      expect(document.querySelector(".srow.home")).not.toBeNull();

      hostMessage({
        type: "switchView",
        switchSeq: 1,
        sessions: [{ id: "a", name: "Casa", createdAt: 1, updatedAt: 9, messageCount: 25, folder: "/p/harny" }],
        openIds: [],
        activeId: undefined,
        messages: [],
        config: { ...HOME_CONFIG, workspaceReady: true, workspaceFolderCount: 1 },
        workingIds: [],
      });
      expect(document.body.classList.contains("no-workspace")).toBe(false);
      expect(document.querySelector(".srow.home")).toBeNull();
      // …and the row is a SESSION control again.
      (document.querySelector(".srow .name") as HTMLElement).click();
      expect(posted).toContainEqual({ type: "openSession", id: "a" });
    });
  });

  it("credits the publisher next to the version, linked to the repository", async () => {
    setupDom({
      sessions: [],
      openIds: [],
      activeId: undefined,
      messages: [],
      version: "0.2.1",
      brand: { name: "SPLTek", url: "https://github.com/spltek/harny" },
    });
    await loadView();
    const line = document.querySelector(".empty-hero .empty-version");
    expect(line?.textContent).toBe("v0.2.1 · by SPLTek");
    expect(line!.querySelector<HTMLAnchorElement>("a.brand-link")?.getAttribute("href")).toBe(
      "https://github.com/spltek/harny",
    );
  });

  it("shows the publisher as plain text when the manifest has no repository", async () => {
    setupDom({
      sessions: [],
      openIds: [],
      activeId: undefined,
      messages: [],
      version: "0.2.1",
      brand: { name: "SPLTek" },
    });
    await loadView();
    const line = document.querySelector(".empty-hero .empty-version");
    expect(line?.textContent).toBe("v0.2.1 · by SPLTek");
    expect(line!.querySelector("a")).toBeNull();
  });

  it("omits the meta line entirely with neither version nor brand", async () => {
    setupDom({ sessions: [], openIds: [], activeId: undefined, messages: [] });
    await loadView();
    expect(document.querySelector(".empty-hero .empty-version")).toBeNull();
  });
});

describe("welcome greeting (open session, no messages)", () => {
  it("shows the real brand mark instead of the 👋 emoji", async () => {
    setupDom({ messages: [], logoUri: "vscode-webview://x/media/icon.svg?v=7" });
    await loadView();
    const welcome = document.querySelector(".msg.welcome");
    expect(welcome).not.toBeNull();
    expect(welcome!.textContent).not.toContain("👋");
    const img = welcome!.querySelector<HTMLImageElement>("img.welcome-logo");
    expect(img?.getAttribute("src")).toBe("vscode-webview://x/media/icon.svg?v=7");
  });

  it("renders plain text (no stray markup) when the host sends no logo URI", async () => {
    setupDom({ messages: [] });
    await loadView();
    const welcome = document.querySelector(".msg.welcome");
    expect(welcome!.querySelector("img")).toBeNull();
    expect(welcome!.textContent).toBe("HarnyWrite a message and press Enter");
  });
});

describe("session name modal (unique names)", () => {
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

describe("main sessions list search", () => {
  it("filters the MAIN list by full-text search and clears it", async () => {
    await loadView(); // init sessions: a (Refactor), b (Debug)
    expect(document.querySelectorAll("#sessions .srow").length).toBe(2);

    const input = document.getElementById("session-search") as HTMLInputElement;
    input.value = "debug";
    input.dispatchEvent(new Event("input"));
    // Debounced: asks the host with scope "main".
    await vi.waitFor(() =>
      expect(posted.some((m: any) => m.type === "searchSessions" && m.scope === "main" && m.query === "debug")).toBe(
        true,
      ),
    );

    // Host replies: only the matching session stays visible.
    hostMessage({
      type: "sessionsSearchResult",
      scope: "main",
      query: "debug",
      matches: [{ sessionId: "b", snippet: "x" }],
    });
    const rows = document.querySelectorAll("#sessions .srow");
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain("Debug");

    // Clearing the field restores the whole (current-folder) list.
    input.value = "";
    input.dispatchEvent(new Event("input"));
    expect(document.querySelectorAll("#sessions .srow").length).toBe(2);
  });

  it("hides the search field when the sessions section is collapsed", async () => {
    await loadView();
    const row = document.getElementById("session-search-row") as HTMLElement;
    const head = document.getElementById("session-head") as HTMLElement;
    const arrow = document.querySelector("#session-head .toggle") as HTMLElement;
    expect(row.classList.contains("hidden")).toBe(false);
    expect(arrow.classList.contains("is-open")).toBe(true);

    head.click(); // collapse
    expect(row.classList.contains("hidden")).toBe(true);
    expect(arrow.classList.contains("is-open")).toBe(false); // the arrow never contradicts the list

    head.click(); // expand again
    expect(row.classList.contains("hidden")).toBe(false);
    expect(arrow.classList.contains("is-open")).toBe(true);
  });

  it("collapses the sessions section when a session is picked, and the header reopens it", async () => {
    await loadView();
    const list = document.getElementById("sessions") as HTMLElement;
    const searchRow = document.getElementById("session-search-row") as HTMLElement;
    const arrow = document.querySelector("#session-head .toggle") as HTMLElement;
    expect(list.classList.contains("hidden")).toBe(false);

    (document.querySelector("#sessions .srow .name") as HTMLElement).click();

    // The click still opens the session…
    expect(posted).toContainEqual({ type: "openSession", id: "a" });
    // …and the list gets out of the way, search field and arrow included.
    expect(list.classList.contains("hidden")).toBe(true);
    expect(searchRow.classList.contains("hidden")).toBe(true);
    expect(arrow.classList.contains("is-open")).toBe(false);

    (document.getElementById("session-head") as HTMLElement).click();
    expect(list.classList.contains("hidden")).toBe(false);
    expect(searchRow.classList.contains("hidden")).toBe(false);
    expect(arrow.classList.contains("is-open")).toBe(true);
  });

  it("leaves the sessions section OPEN for a row action: only PICKING a session collapses", async () => {
    await loadView();
    const list = document.getElementById("sessions") as HTMLElement;
    const buttons = document.querySelectorAll("#sessions .srow-actions button");
    // Branch/rename/delete act ON a row without choosing it, so the list must
    // stay where it is — collapsing here would hide the list mid-management.
    (buttons[1] as HTMLElement).click(); // rename
    expect(posted).toContainEqual({ type: "renameSession", id: "a" });
    expect(list.classList.contains("hidden")).toBe(false);
  });
});

describe("all-sessions manager (gear)", () => {
  it("filters sessions by a full-text search (host FTS) and clears it", async () => {
    await loadView();
    hostMessage({
      type: "sessionsManager",
      show: true,
      currentFolder: "/home/me/a",
      sessions: [
        {
          id: "x",
          name: "Rome trip",
          createdAt: 1,
          updatedAt: 9,
          messageCount: 2,
          folder: "/home/me/a",
          folderMissing: false,
        },
        {
          id: "y",
          name: "Florence trip",
          createdAt: 1,
          updatedAt: 5,
          messageCount: 1,
          folder: "/home/me/b",
          folderMissing: false,
        },
      ],
    });
    expect(document.querySelectorAll("#sessions-manager-list .sm-row").length).toBe(2);

    const input = document.getElementById("sessions-search") as HTMLInputElement;
    input.value = "rome";
    input.dispatchEvent(new Event("input"));
    // Debounced: the host is asked for the FTS matches.
    await vi.waitFor(() =>
      expect(posted.some((m: any) => m.type === "searchSessions" && m.query === "rome")).toBe(true),
    );

    // Host replies with the matching ids + snippet: only that row remains.
    hostMessage({
      type: "sessionsSearchResult",
      query: "rome",
      matches: [{ sessionId: "x", snippet: "in [Rome] today" }],
    });
    const rows = document.querySelectorAll("#sessions-manager-list .sm-row");
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain("Rome trip");
    expect(rows[0].querySelector(".sm-snippet")?.textContent).toContain("in Rome today");

    // A stale reply for a different query is ignored.
    hostMessage({ type: "sessionsSearchResult", query: "florence", matches: [{ sessionId: "y", snippet: "x" }] });
    expect(document.querySelectorAll("#sessions-manager-list .sm-row").length).toBe(1);

    // Clearing the field shows every session again.
    input.value = "";
    input.dispatchEvent(new Event("input"));
    expect(document.querySelectorAll("#sessions-manager-list .sm-row").length).toBe(2);
  });

  it("the gear button asks the host for every session", async () => {
    await loadView();
    (document.getElementById("sessions-gear-btn") as HTMLButtonElement).click();
    expect(posted.some((m: any) => m.type === "getAllSessions")).toBe(true);
  });

  it("renders rows with folder + actions (open / change folder / delete)", async () => {
    await loadView();
    hostMessage({
      type: "sessionsManager",
      currentFolder: "/home/me/a",
      sessions: [
        {
          id: "x",
          name: "Local",
          createdAt: 1,
          updatedAt: 9,
          messageCount: 2,
          folder: "/home/me/a",
          folderMissing: false,
        },
        {
          id: "b",
          name: "Foreign",
          createdAt: 1,
          updatedAt: 7,
          messageCount: 1,
          folder: "/home/me/b",
          folderMissing: false,
        },
        {
          id: "d",
          name: "Gone",
          createdAt: 1,
          updatedAt: 5,
          messageCount: 1,
          folder: "/home/me/gone",
          folderMissing: true,
        },
        {
          id: "c",
          name: "NoFolder",
          createdAt: 1,
          updatedAt: 3,
          messageCount: 0,
          folder: undefined,
          folderMissing: false,
        },
      ],
    });
    const rows = document.querySelectorAll("#sessions-manager-list .sm-row");
    expect(rows.length).toBe(4);
    // Current-folder row carries the "this folder" tag.
    expect(rows[0].textContent).toContain("this folder");
    // KNOWN but missing folder: red row with "— missing".
    expect(rows[2].textContent).toContain("missing");
    // UNKNOWN folder: neutral "folder not set", NOT red.
    const unknownFolder = rows[3].querySelector(".sm-folder") as HTMLElement;
    expect(unknownFolder.classList.contains("unset")).toBe(true);
    expect(unknownFolder.classList.contains("missing")).toBe(false);
    expect(unknownFolder.textContent).toContain("folder not set");
    // Existing folder that is NOT the open one: Open folder (no picker).
    const openBtn = rows[1].querySelector("button.folder-btn") as HTMLButtonElement;
    expect(openBtn.textContent).toBe("Open folder");
    openBtn.click();
    expect(posted.some((m: any) => m.type === "sessionsManagerOpenFolder" && m.id === "b")).toBe(true);
    // Missing / unset / current folder: Change folder… (picker).
    for (const i of [0, 2, 3]) {
      const btn = rows[i].querySelector("button.folder-btn") as HTMLButtonElement;
      expect(btn.textContent).toBe("Change folder…");
    }
    (rows[2].querySelector("button.folder-btn") as HTMLButtonElement).click();
    expect(posted.some((m: any) => m.type === "sessionsManagerChangeFolder" && m.id === "d")).toBe(true);
    (rows[2].querySelector("button.del-btn") as HTMLButtonElement).click(); // delete
    expect(posted.some((m: any) => m.type === "deleteSession" && m.id === "d")).toBe(true);
  });

  it("matches the current folder cross-platform (Windows separators/case, POSIX case-sensitive)", async () => {
    await loadView();
    // Windows: same folder despite `\` vs `/` and case; a different folder opens.
    hostMessage({
      type: "sessionsManager",
      currentFolder: "C:\\Users\\Me\\Proj",
      sessions: [
        {
          id: "w1",
          name: "WinSame",
          createdAt: 1,
          updatedAt: 9,
          messageCount: 0,
          folder: "c:/users/me/proj/",
          folderMissing: false,
        },
        {
          id: "w2",
          name: "WinOther",
          createdAt: 1,
          updatedAt: 5,
          messageCount: 0,
          folder: "C:\\Users\\Me\\Other",
          folderMissing: false,
        },
      ],
    });
    let rows = document.querySelectorAll("#sessions-manager-list .sm-row");
    expect(rows[0].textContent).toContain("this folder");
    expect((rows[0].querySelector("button.folder-btn") as HTMLButtonElement).textContent).toBe("Change folder…");
    expect(rows[1].textContent).not.toContain("this folder");
    expect((rows[1].querySelector("button.folder-btn") as HTMLButtonElement).textContent).toBe("Open folder");

    // POSIX: case matters, so a case-different path is NOT the current folder.
    hostMessage({
      type: "sessionsManager",
      currentFolder: "/home/me/proj",
      sessions: [
        {
          id: "p1",
          name: "PosixSame",
          createdAt: 1,
          updatedAt: 9,
          messageCount: 0,
          folder: "/home/me/proj/",
          folderMissing: false,
        },
        {
          id: "p2",
          name: "PosixCase",
          createdAt: 1,
          updatedAt: 5,
          messageCount: 0,
          folder: "/home/me/Proj",
          folderMissing: false,
        },
      ],
    });
    rows = document.querySelectorAll("#sessions-manager-list .sm-row");
    expect(rows[0].textContent).toContain("this folder");
    expect(rows[1].textContent).not.toContain("this folder");
  });

  it("the MCP gear is inert while THIS session works: a reconnect would swap the tools mid-turn", async () => {
    // The MCP editor edits the MACHINE (install/edit/delete, each save reconnecting and rebuilding
    // the registry). Started from the panel — the path that never sends a `status` message — the
    // lock must already be on, and another session's run must not freeze it.
    await loadView();
    const mcpGear = document.getElementById("mcp-configure") as HTMLButtonElement;
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    expect(mcpGear.disabled).toBe(false);

    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    expect(mcpGear.disabled).toBe(true);
    expect(mcpGear.title).toContain("Stop the run first");

    hostMessage({ type: "status", active: false });
    expect(mcpGear.disabled).toBe(false);
    expect(mcpGear.title).toBe("Configure MCP servers");

    // ANOTHER session works while this one is idle: the MCP editor stays reachable — it is not a
    // per-session control, and a blanket lock would make it unreachable on a busy day.
    hostMessage({ type: "status", active: false, workingIds: ["other"] });
    expect(mcpGear.disabled).toBe(false);
  });

  it("starting a run FROM this panel locks the models gear immediately (no status message needed)", async () => {
    // The reported bug, reproduced: the optimistic send path (typing + Play) never goes through a
    // `status` message, so the lock that lived only there never ran and the gear stayed clickable.
    await loadView();
    const gear = document.getElementById("gear-btn") as HTMLButtonElement;
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    expect(gear.disabled).toBe(true);

    // The run ends (the host reports it): the gear comes back.
    hostMessage({ type: "status", active: false });
    expect(gear.disabled).toBe(false);
  });

  it("the session manager stays reachable while sessions work; the per-session gear follows ITS run", async () => {
    // Two axes. A blanket lock meant that with several concurrent runs you could never open the
    // managers again — so the MANAGERS stay usable. The models gear acts on the session you are
    // LOOKING AT, so it follows that session's run: opening it mid-stream offers a model switch
    // for a request already sent, which the model dropdown and the mode pills already refuse.
    setupDom({ workingIds: ["a"] }); // "a" is the ACTIVE session, and it is working
    await loadView();
    const sessGear = document.getElementById("sessions-gear-btn") as HTMLButtonElement;
    const provGear = document.getElementById("gear-btn") as HTMLButtonElement;
    expect(sessGear.disabled).toBe(false);
    expect(provGear.disabled).toBe(true); // this session streams
    expect(sessGear.title).toContain("the working ones are locked");
    expect(provGear.title).toContain("keeps the model it started with");

    // Nothing working: the titles go back to neutral.
    hostMessage({ type: "status", active: false, workingIds: [] });
    expect(sessGear.title).toBe("Manage all sessions (every folder)");
    expect(provGear.title).toBe("Configure providers & models");

    // ANOTHER session works while this one is idle: the manager stays usable and the models gear
    // comes back — the case a global lock punished.
    hostMessage({ type: "status", active: false, workingIds: ["b"] });
    expect(sessGear.disabled).toBe(false);
    expect(sessGear.title).toContain("the working ones are locked");
    expect(provGear.disabled).toBe(false);
    expect(provGear.title).toBe("Configure providers & models");

    // Row buttons in the manage form stay ENABLED regardless (only the gear locks
    // were ever about the gears — the rows are the host's business).
    hostMessage({
      type: "sessionsManager",
      currentFolder: "/home/me/a",
      sessions: [
        {
          id: "a",
          name: "Local",
          createdAt: 1,
          updatedAt: 5,
          messageCount: 0,
          folder: "/home/me/a",
          folderMissing: false,
        },
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
    expect(document.querySelector("#sessions-manager-list .sm-empty")?.textContent).toContain("No sessions yet");
    (document.getElementById("sessions-close") as HTMLButtonElement).click();
    expect(modal.classList.contains("hidden")).toBe(true);
  });

  it("a silent sessionsManager refresh never opens the form — only show:true does", async () => {
    await loadView();
    const modal = document.getElementById("sessions-modal") as HTMLDivElement;
    const data = {
      type: "sessionsManager",
      currentFolder: "/home/me/a",
      sessions: [
        {
          id: "x",
          name: "Local",
          createdAt: 1,
          updatedAt: 5,
          messageCount: 0,
          folder: "/home/me/a",
          folderMissing: false,
        },
      ],
    };
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

describe("soft steering + pending bubbles (webview)", () => {
  function startWorking(): void {
    hostMessage({ type: "status", active: true });
  }

  it("holding Ctrl/Cmd to COPY does not yank the viewport down nor steal the focus", async () => {
    // The reported bug: reading above the bottom during a run, press ⌘ (half of ⌘C) and the
    // transcript jumped to the last message and the pill lit up. The modifier is an INDICATOR:
    // it must never move the view or focus the prompt.
    await loadView();
    startWorking();
    const list = document.getElementById("messages")!;
    // Park the reader above the bottom.
    Object.defineProperty(list, "scrollHeight", { value: 5000, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: 800, configurable: true });
    list.scrollTop = 1000;
    list.dispatchEvent(new Event("scroll")); // the listener derives "not following" from it
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.blur();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", bubbles: true }));

    expect(list.scrollTop).toBe(1000); // no jump to the bottom
    expect(document.activeElement).not.toBe(input); // no focus stolen from the selection
    // The indicator still does its job.
    expect(document.getElementById("insert-hint")!.classList.contains("is-steer")).toBe(true);
  });

  it("with text selected, a bare modifier is a COPY, not a steer: the pill stays quiet", async () => {
    await loadView();
    startWorking();
    const first = document.querySelector("#messages .msg")!;
    // A real selection over the transcript, exactly what a user drags before ⌘C.
    const range = document.createRange();
    range.selectNodeContents(first);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(sel.toString().trim().length).toBeGreaterThan(0);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", bubbles: true }));
    expect(document.getElementById("insert-hint")!.classList.contains("is-steer")).toBe(false);
    // …and the selection survives the keystroke, which is the point.
    expect(window.getSelection()!.toString()).toBe(sel.toString());
  });

  it("Copy reports the truth when the clipboard API is missing (no silent 'done')", async () => {
    // `navigator.clipboard?.writeText(...)` awaited resolves to undefined: reporting success there
    // meant claiming a copy that never happened, and skipping the legacy path.
    await loadView();
    const bubble = document.querySelector("#messages .msg")!;
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(bubble);
    sel.removeAllRanges();
    sel.addRange(range);

    const legacy: boolean[] = [];
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const realExec = document.execCommand;
    (document as unknown as { execCommand: (c: string) => boolean }).execCommand = (c: string) => {
      legacy.push(c === "copy");
      return true;
    };
    try {
      bubble.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      const [copy] = [...document.querySelectorAll("#ctx-menu button")] as HTMLButtonElement[];
      copy.click();
      await new Promise((r) => setTimeout(r, 10));
      expect(legacy).toEqual([true]); // the fallback ran…
      // …and with NO way to copy at all, the menu still closes without pretending anything.
      (document as unknown as { execCommand: () => boolean }).execCommand = () => false;
      bubble.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      const [copy2] = [...document.querySelectorAll("#ctx-menu button")] as HTMLButtonElement[];
      copy2.click();
      await new Promise((r) => setTimeout(r, 10));
      expect(document.getElementById("ctx-menu")!.classList.contains("hidden")).toBe(true);
    } finally {
      (document as unknown as { execCommand: unknown }).execCommand = realExec;
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    }
  });

  it("a fold header is a disclosure BUTTON: role, tab stop, keyboard and announced state", async () => {
    // `aria-expanded` on a bare div is announced to nobody, and a click-only div is unreachable
    // from the keyboard: the three transcript folds were both.
    await loadView();
    hostMessage({ type: "refresh", messages: [{ role: "assistant", content: "", thinking: "penso", timestamp: 1 }] });
    const header = document.querySelector(".thinking-header") as HTMLElement;
    const toggle = header.querySelector(".toggle") as HTMLElement;
    const body = document.querySelector(".thinking-body") as HTMLElement;
    expect(header.getAttribute("role")).toBe("button");
    expect(header.getAttribute("tabindex")).toBe("0");
    expect(header.getAttribute("aria-expanded")).toBe("false");

    // Enter opens it (space too), and the state follows both the click and the key.
    header.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(body.classList.contains("collapsed")).toBe(false);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.classList.contains("is-open")).toBe(true);
    header.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(body.classList.contains("collapsed")).toBe(true);
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("closing find disarms the debounce: nothing runs after the bar is gone", async () => {
    // Type, then Esc within the 120ms debounce: the timer stayed armed and fired after the close,
    // re-scanning the transcript and clearing a selection made in the meantime.
    await loadView();
    hostMessage({ type: "refresh", messages: [{ role: "assistant", content: "alpha beta", timestamp: 1 }] });
    const input = document.getElementById("find-input") as HTMLInputElement;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, ctrlKey: true }));
    input.value = "alpha";
    input.dispatchEvent(new Event("input")); // the debounce starts…
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); // …and we close

    // A selection made right after closing must survive the (cancelled) timer.
    const bubble = document.querySelector("#messages .msg")!;
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(bubble);
    sel.removeAllRanges();
    sel.addRange(range);
    await new Promise((r) => setTimeout(r, 250)); // well past the debounce

    expect(window.getSelection()!.toString()).toContain("alpha beta");
    expect(document.getElementById("find-bar")!.classList.contains("hidden")).toBe(true);
  });

  it("finding text inside a FOLDED section opens it — the jump must land on something visible", async () => {
    // A folded body is display:none: the count was right and the scroll went nowhere.
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    // The payload is FLAT (id / name / arguments), as the host sends it.
    hostMessage({ type: "toolCall", id: "t1", name: "Read", arguments: { file_path: "a.ts" } });
    hostMessage({ type: "toolResult", toolCallId: "t1", output: "contenuto SEGRETO del file", isError: false });
    await new Promise((r) => setTimeout(r, 30));
    const card = document.querySelector(".msg.tool") as HTMLElement;
    const details = card.querySelector(".tool-details") as HTMLElement;
    const toggle = card.querySelector(".tool-toggle") as HTMLElement;
    const header = card.querySelector(".tool-header") as HTMLElement;
    expect(details.classList.contains("collapsed")).toBe(true); // born folded
    // The state lives on the CONTROL (the header), which is a disclosure button for AT.
    expect(header.getAttribute("role")).toBe("button");
    expect(header.getAttribute("aria-expanded")).toBe("false");

    const find = document.getElementById("find-input") as HTMLInputElement;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, ctrlKey: true }));
    find.value = "SEGRETO";
    find.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 150));

    // Opening it is what makes the match visible at all…
    expect(details.classList.contains("collapsed")).toBe(false);
    // …and the header follows: chevron turned, state announced.
    expect(toggle.classList.contains("is-open")).toBe(true);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("find-count")!.textContent).toBe("1/1");
  });

  it("a query of only spaces is not a search: no 'no match', no stale count", async () => {
    await loadView();
    hostMessage({ type: "refresh", messages: [{ role: "assistant", content: "alpha", timestamp: 1 }] });
    const input = document.getElementById("find-input") as HTMLInputElement;
    const count = document.getElementById("find-count") as HTMLElement;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, ctrlKey: true }));
    input.value = "alpha";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 150));
    expect(count.textContent).toBe("1/1");

    input.value = "   ";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 150));
    expect(count.textContent).toBe(""); // a blank query says nothing at all
    expect(count.classList.contains("none")).toBe(false);
  });

  it("a right-click on a selection shows OUR menu with Copy enabled", async () => {
    // The transcript's prose menu is ours (the host's is not a contract): a right-click on a
    // selection must offer Copy, and it must never be swallowed.
    await loadView();
    const menu = document.getElementById("ctx-menu") as HTMLElement;
    const bubble = document.querySelector("#messages .msg")!;
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(bubble);
    sel.removeAllRanges();
    sel.addRange(range);

    const onSelection = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    bubble.dispatchEvent(onSelection);
    expect(onSelection.defaultPrevented).toBe(true); // we own the menu here
    expect(menu.classList.contains("hidden")).toBe(false);
    const [copy] = [...menu.querySelectorAll("button")] as HTMLButtonElement[];
    expect(copy.disabled).toBe(false); // a selection is there: Copy is live
    expect(sel.toString().length).toBeGreaterThan(0);

    // …and the same on a CONTROL inside the transcript when the selection is over it: the
    // everyday case (select a line in a tool card, right-click to copy).
    menu.classList.add("hidden");
    const header = document.createElement("div");
    header.className = "tool-header";
    header.textContent = "read_file";
    document.getElementById("messages")!.appendChild(header);
    const r2 = document.createRange();
    r2.selectNodeContents(header);
    sel.removeAllRanges();
    sel.addRange(r2);
    const onControl = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    header.dispatchEvent(onControl);
    // A control header keeps the host's menu (it is chrome, not prose).
    expect(onControl.defaultPrevented).toBe(false);
    expect(menu.classList.contains("hidden")).toBe(true);
  });

  it("while working, Enter queues the message (no optimistic user bubble)", async () => {
    await loadView();
    startWorking();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    const before = document.querySelectorAll("#messages .msg.user").length;
    input.value = "then also check Milan";

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    const send = posted.find((m: any) => m.type === "send") as any;
    expect(send).toMatchObject({ type: "send", mode: "queue", text: "then also check Milan" });
    expect(typeof send.id).toBe("string");
    // No optimistic user bubble: the host owns the pending bubble.
    expect(document.querySelectorAll("#messages .msg.user").length).toBe(before);
    expect(input.value).toBe("");
  });

  it("while working, Ctrl+Enter steers", async () => {
    await loadView();
    startWorking();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "no, use Rome";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    expect(posted.find((m: any) => m.type === "send")).toMatchObject({ mode: "steer", text: "no, use Rome" });
  });

  it("while idle, Enter sends normally (no mode)", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "hello";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const send = posted.find((m: any) => m.type === "send") as any;
    expect(send.text).toBe("hello");
    expect(send.mode).toBeUndefined();
    // Idle sends are optimistic: the user bubble appears at once.
    expect(document.querySelectorAll("#messages .msg.user").length).toBeGreaterThan(0);
  });

  it("renders pending bubbles and cancels them", async () => {
    await loadView();
    hostMessage({
      type: "pending",
      items: [
        { id: "q1", mode: "queue", text: "later" },
        { id: "s1", mode: "steer", text: "not Florence" },
      ],
    });
    const area = document.getElementById("pending-area") as HTMLElement;
    expect(area.classList.contains("hidden")).toBe(false);
    const rows = area.querySelectorAll(".pending-msg");
    expect(rows.length).toBe(2);
    // Steer group first, queue group below — even though q1 arrived first.
    expect(rows[0].classList.contains("pending-steer")).toBe(true);
    expect(rows[0].textContent).toContain("Steer");
    expect(rows[1].textContent).toContain("Queued");

    (rows[1].querySelector(".pending-cancel") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "cancelPending", id: "q1" });

    hostMessage({ type: "pending", items: [] });
    // With nothing pending the whole SECTION goes away (header included).
    expect((document.getElementById("pending-section") as HTMLElement).classList.contains("hidden")).toBe(true);
  });

  it("a CHANGE in the pending footer brings the caret back to the prompt", async () => {
    await loadView();
    const prompt = document.getElementById("user-input") as HTMLTextAreaElement;
    const two = [
      { id: "q1", mode: "queue" as const, text: "later" },
      { id: "s1", mode: "steer" as const, text: "not Florence" },
    ];
    // Prime the baseline, then move the caret away: a RE-PUSH of the SAME list is what a
    // reload sends, and it must leave the reader exactly where they are.
    hostMessage({ type: "pending", items: two });
    prompt.blur();
    hostMessage({ type: "pending", items: two });
    expect(document.activeElement).not.toBe(prompt);

    // ADDING one: the user is talking about the run in progress.
    prompt.blur();
    hostMessage({ type: "pending", items: [...two, { id: "q2", mode: "queue" as const, text: "also" }] });
    expect(document.activeElement).toBe(prompt);

    // CONVERTING one (same id, other mode) is a Queue <-> Steer switch.
    prompt.blur();
    hostMessage({ type: "pending", items: [{ ...two[0], mode: "steer" as const }, two[1]] });
    expect(document.activeElement).toBe(prompt);

    // CANCELLING one.
    prompt.blur();
    hostMessage({ type: "pending", items: [two[1]] });
    expect(document.activeElement).toBe(prompt);
  });

  it("holding the modifier lights the hint but does NOT bring the caret back", async () => {
    // It used to focus the prompt here, to "bring the caret where the next keystroke belongs" —
    // but that same keystroke is ⌘C, and focusing the prompt discarded the selection being
    // copied. The caret returns when the user actually SENDS (or a pending item changes), not
    // when a modifier is merely held.
    await loadView();
    hostMessage({ type: "status", active: true }); // a run is in progress
    const prompt = document.getElementById("user-input") as HTMLTextAreaElement;
    prompt.blur();
    // Holding Ctrl really flips the mode: the next message becomes a STEER.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }));
    expect(document.getElementById("insert-hint")!.classList.contains("is-steer")).toBe(true);
    expect(document.activeElement).not.toBe(prompt);
    // Release it, so the module state does not leak into the next test.
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
  });

  it("the Steer modifier is the OS's own: ⌘ on macOS, Ctrl on Windows/Linux", async () => {
    const setUa = (ua: string): void => {
      Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
    };
    const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
    const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
    const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";
    const isSteer = () => document.getElementById("insert-hint")!.classList.contains("is-steer");
    /** Hold the key, READ the hint, then release: the state exists only while it is held. */
    const holdAndRead = (key: string): boolean => {
      window.getSelection()?.removeAllRanges(); // a leftover selection reads as a copy gesture
      window.dispatchEvent(new Event("blur")); // start from "nothing held"
      window.dispatchEvent(new KeyboardEvent("keydown", { key }));
      const lit = isSteer();
      window.dispatchEvent(new KeyboardEvent("keyup", { key }));
      return lit;
    };

    // macOS: ⌘ works, and Ctrl is an accepted alias (the hint says "Ctrl/Cmd").
    setUa(MAC);
    await loadView();
    hostMessage({ type: "status", active: true });
    expect(holdAndRead("Meta")).toBe(true);
    expect(holdAndRead("Control")).toBe(true);

    // Windows/Linux: Ctrl works, but a bare Win/Super key belongs to the OS, not to us.
    for (const ua of [WIN, LINUX]) {
      setUa(ua);
      await loadView();
      hostMessage({ type: "status", active: true });
      expect(holdAndRead("Meta")).toBe(false);
      expect(holdAndRead("Control")).toBe(true);
    }
    setUa(MAC);
  });

  it("Ctrl/Cmd+Enter steers on every OS; Shift+Enter is always a newline", async () => {
    // ONE loaded view: reloading it per platform would leave the previous instances (which still
    // own the session's activeId) answering the keystrokes with their own stale state.
    const setUa = (ua: string): void => {
      Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
    };
    const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
    const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
    setUa(MAC);
    await loadView();
    window.getSelection()?.removeAllRanges();
    hostMessage({ type: "status", active: true });

    const sendMode = (init: KeyboardEventInit): string | undefined => {
      window.dispatchEvent(new Event("blur")); // nothing held ("blur" is the app's own reset)
      posted.length = 0;
      const input = document.getElementById("user-input") as HTMLTextAreaElement;
      input.value = "no, use Rome";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...init }));
      return (posted.find((m: any) => m.type === "send") as any)?.mode;
    };

    setUa(MAC);
    expect(sendMode({ metaKey: true })).toBe("steer");
    setUa(WIN);
    expect(sendMode({ ctrlKey: true })).toBe("steer");
    // Shift+Enter never sends, anywhere: the browser inserts the newline.
    expect(sendMode({ shiftKey: true })).toBeUndefined();
    expect(sendMode({ metaKey: true, shiftKey: true })).toBeUndefined();
    // The Windows/Super key is the OS's: ⌘+Enter is not a steer there.
    expect(sendMode({ metaKey: true })).toBe("queue");
    setUa(MAC);
  });

  it("a right-click on a control is suppressed only on macOS (Ctrl+click is a click there)", async () => {
    const setUa = (ua: string): void => {
      Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
    };
    const rightClickControl = (): boolean => {
      const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      (document.querySelector("button") as HTMLElement).dispatchEvent(ev);
      return ev.defaultPrevented;
    };

    setUa("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    await loadView();
    window.getSelection()?.removeAllRanges();
    expect(rightClickControl()).toBe(true);

    setUa("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    await loadView();
    window.getSelection()?.removeAllRanges();
    expect(rightClickControl()).toBe(false); // native menu, nothing hijacked
    setUa("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
  });

  it("offers a convert button on each bubble, labelled with the EFFECT it will have", async () => {
    await loadView();
    hostMessage({
      type: "pending",
      items: [
        { id: "q1", mode: "queue", text: "later" },
        { id: "s1", mode: "steer", text: "not Florence" },
      ],
    });
    const rows = [...document.querySelectorAll("#pending-area .pending-msg")];
    const steer = rows[0].querySelector(".pending-convert") as HTMLButtonElement;
    const queued = rows[1].querySelector(".pending-convert") as HTMLButtonElement;

    // On a steer: the button OFFERS the queue, and says what that means.
    expect(steer.textContent).toBe("→ Queued");
    expect(steer.title).toMatch(/after the run/i);
    // On a queued message: the button OFFERS the steer, i.e. delivery FIRST.
    expect(queued.textContent).toBe("→ Steer");
    expect(queued.title).toMatch(/first/i);
    // The row is badge + message + commands, and the FOLD sits with the commands at
    // the END — never in front of the text.
    const row = rows[0];
    expect(row.firstElementChild).toBe(row.querySelector(".pending-badge"));
    const actions = row.querySelector(".pending-actions");
    expect(actions?.contains(steer)).toBe(true);
    expect(actions?.contains(row.querySelector(".pending-toggle"))).toBe(true);
    // The text is the middle column, so the attachments can sit under it.
    expect(row.querySelector(".pending-main > .pending-text")).toBeTruthy();
  });

  it("posts the conversion, asking for the OPPOSITE mode", async () => {
    await loadView();
    hostMessage({
      type: "pending",
      items: [
        { id: "q1", mode: "queue", text: "later" },
        { id: "s1", mode: "steer", text: "not Florence" },
      ],
    });
    const rows = [...document.querySelectorAll("#pending-area .pending-msg")];

    (rows[0].querySelector(".pending-convert") as HTMLButtonElement).click();
    (rows[1].querySelector(".pending-convert") as HTMLButtonElement).click();

    expect(posted).toContainEqual({ type: "setPendingMode", id: "s1", mode: "queue" });
    expect(posted).toContainEqual({ type: "setPendingMode", id: "q1", mode: "steer" });
  });

  it("shows the WHOLE pending text: multi-line, no truncation", async () => {
    await loadView();
    const long = "first line\nsecond line\n" + "x".repeat(300);
    hostMessage({ type: "pending", items: [{ id: "q1", mode: "queue", text: long }] });
    const body = document.querySelector("#pending-area .pending-text") as HTMLElement;

    // The full text is in the DOM (the earlier version ellipsised it after one
    // line); wrapping and the section scroll are CSS, asserted in view-html.test.ts.
    expect(body.textContent).toBe(long);
    expect(body.textContent).toContain("\n");
  });

  it("shows a message's attachments INSIDE its bubble, as a user bubble does", async () => {
    await loadView();
    hostMessage({
      type: "pending",
      items: [
        {
          id: "q1",
          mode: "queue",
          text: "look at these",
          attachments: [
            { name: "shot.png", size: 10, isImage: true, dataUri: "data:image/png;base64,AAAA" },
            { name: "notes.txt", size: 5 },
          ],
        },
      ],
    });
    const row = document.querySelector("#pending-area .pending-msg") as HTMLElement;
    const extras = row.querySelector(".pending-extras") as HTMLElement;
    // The SAME row a user bubble renders: the image as a clickable thumbnail…
    expect((extras.querySelector("img") as HTMLImageElement).getAttribute("src")).toBe("data:image/png;base64,AAAA");
    // …and the non-image as a card carrying its name.
    expect(extras.textContent).toContain("notes.txt");
    // The paperclip still leads the text (the row says WHAT is attached at a glance).
    expect(row.querySelector(".pending-text")?.textContent).toContain("📎");
    // There IS something inside, so the fold is offered with no measurement needed —
    // and the row is still born folded.
    const fold = row.querySelector(".pending-toggle") as HTMLElement;
    expect(fold.classList.contains("hidden")).toBe(false);
    expect(row.classList.contains("text-collapsed")).toBe(true);
  });

  /**
   * The DECISION ("does this text wrap?") is measured on the rendered element, and
   * jsdom computes no layout — so its rule lives in a pure module with its own tests
   * (pending-fold.test.ts). What is tested here is the WIRING: one fold per bubble,
   * born folded, offered only where a measurement (or the previews) justifies it.
   */
  describe("per-bubble fold", () => {
    const rowsHere = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("#pending-area .pending-msg")];

    it("is born folded, one line per message, with its own fold next to the commands", async () => {
      await loadView();
      hostMessage({
        type: "pending",
        items: [
          { id: "q1", mode: "queue", text: "short" },
          { id: "s1", mode: "steer", text: "also short" },
        ],
      });
      const rows = rowsHere();
      expect(rows).toHaveLength(2);
      // Every row starts folded — the one just typed included.
      expect(rows.every((r) => r.classList.contains("text-collapsed"))).toBe(true);
      const folds = rows.map((r) => r.querySelector<HTMLButtonElement>(".pending-toggle")!);
      // jsdom reports no line height: the fold exists but is NOT offered (hidden with
      // its space reserved — see the CSS contract), and it belongs to the commands.
      expect(folds.every((f) => f.classList.contains("hidden"))).toBe(true);
      expect(folds.every((f) => !f.classList.contains("is-open"))).toBe(true);
      for (const fold of folds) {
        expect(fold.parentElement?.classList.contains("pending-actions")).toBe(true);
      }
    });

    it("opens and folds the bubble, announcing which way it goes", async () => {
      await loadView();
      hostMessage({ type: "pending", items: [{ id: "q1", mode: "queue", text: "a rather long message" }] });
      const row = rowsHere()[0];
      const fold = row.querySelector(".pending-toggle") as HTMLButtonElement;

      fold.click();
      expect(row.classList.contains("text-collapsed")).toBe(false);
      expect(fold.classList.contains("is-open")).toBe(true);
      expect(fold.title).toMatch(/collapse/i);
      // It is a disclosure control: its state is announced, not just drawn.
      expect(fold.getAttribute("aria-expanded")).toBe("true");
      expect(fold.getAttribute("aria-label")).toMatch(/collapse/i);

      fold.click();
      expect(row.classList.contains("text-collapsed")).toBe(true);
      expect(fold.classList.contains("is-open")).toBe(false);
      expect(fold.title).toMatch(/whole/i);
      expect(fold.getAttribute("aria-expanded")).toBe("false");
      expect(fold.getAttribute("aria-label")).toMatch(/whole/i);
    });

    it("offers the fold when a resize gives the message a second line", async () => {
      await loadView();
      hostMessage({ type: "pending", items: [{ id: "q1", mode: "queue", text: "wraps only when narrow" }] });
      const row = rowsHere()[0];
      const body = row.querySelector(".pending-text") as HTMLElement;
      const fold = row.querySelector(".pending-toggle") as HTMLButtonElement;
      expect(fold.classList.contains("hidden")).toBe(true);

      // jsdom lays nothing out, so the measurement is fed the way a layout engine
      // would answer it: a real line height, and content taller than one line.
      body.style.lineHeight = "18px";
      Object.defineProperty(body, "scrollHeight", { value: 36, configurable: true });
      window.dispatchEvent(new Event("resize"));
      await new Promise((r) => requestAnimationFrame(() => r(null)));

      expect(fold.classList.contains("hidden")).toBe(false);
    });
  });

  describe("the pending section collapses like the sessions list", () => {
    it("starts expanded, and the header collapses/expands the list", async () => {
      await loadView();
      hostMessage({
        type: "pending",
        items: [
          { id: "q1", mode: "queue", text: "later" },
          { id: "s1", mode: "steer", text: "now" },
        ],
      });
      const head = document.getElementById("pending-head") as HTMLElement;
      const area = document.getElementById("pending-area") as HTMLElement;
      expect(area.classList.contains("hidden")).toBe(false);
      expect(head.getAttribute("aria-expanded")).toBe("true");

      head.click();

      expect(area.classList.contains("hidden")).toBe(true);
      expect(head.getAttribute("aria-expanded")).toBe("false");
      expect(head.querySelector(".toggle")?.classList.contains("is-open") ?? false).toBe(false);

      head.click();
      expect(area.classList.contains("hidden")).toBe(false);
      expect(head.querySelector(".toggle")?.classList.contains("is-open") ?? false).toBe(true);
    });

    it("answers to Enter/Space too (a header that is a control, not a decoration)", async () => {
      await loadView();
      hostMessage({ type: "pending", items: [{ id: "q1", mode: "queue", text: "later" }] });
      const head = document.getElementById("pending-head") as HTMLElement;
      const area = document.getElementById("pending-area") as HTMLElement;

      head.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(area.classList.contains("hidden")).toBe(true);
      head.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      expect(area.classList.contains("hidden")).toBe(false);
    });

    it("shows the counts in the header, so a collapsed section still says what is waiting", async () => {
      await loadView();
      hostMessage({
        type: "pending",
        items: [
          { id: "q1", mode: "queue", text: "a" },
          { id: "q2", mode: "queue", text: "b" },
          { id: "s1", mode: "steer", text: "c" },
        ],
      });

      expect((document.getElementById("pending-head-text") as HTMLElement).textContent).toBe("Steer (1) · Queued (2)");
    });

    it("keeps the counts header VISIBLE while the section is collapsed", async () => {
      // The header is the stable label of the area, not an artefact of collapsing:
      // it stays put, so a collapsed block still says what is waiting.
      await loadView();
      hostMessage({
        type: "pending",
        items: [
          { id: "q1", mode: "queue", text: "a" },
          { id: "s1", mode: "steer", text: "b" },
        ],
      });
      const section = document.getElementById("pending-section") as HTMLElement;
      const head = document.getElementById("pending-head") as HTMLElement;
      const area = document.getElementById("pending-area") as HTMLElement;

      head.click();

      expect(section.classList.contains("hidden")).toBe(false); // still there
      expect(head.textContent).toContain("Steer (1)"); // the count sits in parentheses
      expect(head.textContent).toContain("Queued (1)");
      expect(area.classList.contains("hidden")).toBe(true); // only the items fold
    });

    it("re-opens a collapsed section when a NEW message arrives", async () => {
      await loadView();
      hostMessage({ type: "pending", items: [{ id: "q1", mode: "queue", text: "one" }] });
      const head = document.getElementById("pending-head") as HTMLElement;
      const area = document.getElementById("pending-area") as HTMLElement;
      head.click();
      expect(area.classList.contains("hidden")).toBe(true);

      hostMessage({
        type: "pending",
        items: [
          { id: "q1", mode: "queue", text: "one" },
          { id: "q2", mode: "queue", text: "two" },
        ],
      });

      expect(area.classList.contains("hidden")).toBe(false);
    });

    it("keeps a deliberate collapse when an item is DELIVERED (only new ones re-open)", async () => {
      await loadView();
      hostMessage({
        type: "pending",
        items: [
          { id: "q1", mode: "queue", text: "one" },
          { id: "q2", mode: "queue", text: "two" },
        ],
      });
      const head = document.getElementById("pending-head") as HTMLElement;
      const area = document.getElementById("pending-area") as HTMLElement;
      head.click();

      hostMessage({ type: "pending", items: [{ id: "q2", mode: "queue", text: "two" }] });

      expect(area.classList.contains("hidden")).toBe(true);
    });
  });

  it("groups steers above queued messages, each group in arrival order", async () => {
    await loadView();
    hostMessage({
      type: "pending",
      items: [
        { id: "q1", mode: "queue", text: "queue one" },
        { id: "s1", mode: "steer", text: "steer one" },
        { id: "q2", mode: "queue", text: "queue two" },
        { id: "s2", mode: "steer", text: "steer two" },
      ],
    });
    const rows = [...document.querySelectorAll("#pending-area .pending-msg")].map((r) => r.textContent);
    expect(rows).toEqual([
      expect.stringContaining("steer one"),
      expect.stringContaining("steer two"),
      expect.stringContaining("queue one"),
      expect.stringContaining("queue two"),
    ]);
  });

  it("turns a steer into a real user bubble when the host reports it applied", async () => {
    await loadView();
    hostMessage({ type: "pending", items: [{ id: "s1", mode: "steer", text: "not Florence" }] });
    hostMessage({ type: "steerApplied", ids: ["s1"], content: "not Florence" });
    const last = document.querySelector("#messages .msg.user:last-of-type") as HTMLElement;
    expect(last.textContent).toContain("not Florence");
    expect(last.classList.contains("steer-msg")).toBe(true);
  });

  it("renders a QUEUED message's bubble when the host says it started running", async () => {
    await loadView();
    // The view never appends a bubble for a queued message: it waits in the
    // pending footer, and the host tells the view when it actually runs.
    hostMessage({ type: "pending", items: [{ id: "q1", mode: "queue", text: "look here" }] });
    hostMessage({
      type: "userMessage",
      content: "look here",
      images: ["data:image/png;base64,iVBORw0KGgo="],
      attachments: [{ name: "relazione.pdf", path: "/tmp/relazione.pdf", size: 42, isImage: false }],
    });
    const last = document.querySelector("#messages .msg.user:last-of-type") as HTMLElement;
    expect(last.textContent).toContain("look here");
    expect(last.querySelector(".msg-attachments")).not.toBeNull();
    expect(last.querySelector(".msg-attach-file-name")?.textContent).toBe("relazione.pdf");
  });

  it("renders a STEERED message's attachments in the live bubble", async () => {
    await loadView();
    hostMessage({
      type: "steerApplied",
      ids: ["s1"],
      content: "look at this",
      images: ["data:image/png;base64,iVBORw0KGgo="],
      attachments: [
        { name: "report.pdf", path: "/tmp/report.pdf", size: 12, isImage: false },
        { name: "shot.png", path: "", size: 3, isImage: true },
      ],
    });
    const last = document.querySelector("#messages .msg.user:last-of-type") as HTMLElement;
    // The bug: the files reached the model but the bubble was built with the
    // text alone, so no attachment row was rendered at all.
    expect(last.querySelector(".msg-attachments")).not.toBeNull();
    expect(last.querySelector(".msg-attach-file-name")?.textContent).toBe("report.pdf");
    expect(last.textContent).toContain("look at this");
  });

  it("shows a paperclip in a pending row that carries attachments, even with text", async () => {
    await loadView();
    hostMessage({
      type: "pending",
      items: [
        { id: "q1", mode: "queue", text: "andrea", attachments: [{ name: "relazione.pdf", size: 10 }] },
        { id: "q2", mode: "queue", text: "no attachments" },
        { id: "q3", mode: "queue", text: "", attachments: [{ name: "foto.png", size: 4 }] },
      ],
    });
    const rows = [...document.querySelectorAll("#pending-area .pending-msg")];
    const text = (i: number) => rows[i].querySelector(".pending-text") as HTMLElement;
    // Text AND a file: the paperclip is what makes the file visible at all.
    expect(text(0).textContent).toBe("📎 andrea");
    // …and the names stay reachable through the tooltip.
    expect(text(0).getAttribute("title")).toBe("andrea\nrelazione.pdf");
    // No attachments: no paperclip.
    expect(text(1).textContent).toBe("no attachments");
    // Attachment-only still shows the names as the body, now behind the clip.
    expect(text(2).textContent).toBe("📎 foto.png");
  });

  it("marks a historical steer message with the steer class", async () => {
    setupDom({
      messages: [
        { role: "user", content: "start", timestamp: 1 },
        { role: "assistant", content: "working", timestamp: 2 },
        { role: "user", content: "correction", timestamp: 3, steer: true },
      ],
    });
    await loadView();
    const steers = document.querySelectorAll("#messages .msg.user.steer-msg");
    expect(steers.length).toBe(1);
    expect(steers[0].textContent).toContain("correction");
  });
});

describe("the test platform is PINNED (otherwise the suite mirrors the host OS)", () => {
  it("jsdom would report the HOST's OS — the fixture overrides it with a known one", async () => {
    // Why this test exists: the CI runs on Ubuntu and Windows, where jsdom's own UA says `linux` /
    // `win32`. Anything reading `navigator.userAgent` (the ⌘/Ctrl matrix, the Chrome-only
    // context-menu suppression) then behaves one way on the maintainer's Mac and another on the
    // build machines — which is exactly how four tests were green here and red there, while the
    // non-macOS branches were never executed anywhere.
    //
    // `setupFixture` pins it. This asserts the PIN, not the value jsdom would have chosen, so it is
    // deterministic on every OS: remove the pin and it fails wherever it runs.
    setupFixture();
    expect(navigator.userAgent).toContain("Macintosh");
    // …and the app reads the SAME source it is pinned to.
    expect(navigator.userAgent).toMatch(/Macintosh|Mac OS X/);
  });
});

describe("Insert-in hint — Queue/Steer (webview)", () => {
  const hint = () => document.getElementById("insert-hint") as HTMLElement;
  const word = () => document.getElementById("insert-hint-word") as HTMLElement;
  const input = () => document.getElementById("user-input") as HTMLTextAreaElement;

  it("defaults to Queue and is dim while idle", async () => {
    await loadView();
    expect(word().textContent).toBe("Queue");
    // Not a button any more: idleness is the dimmed class, not `disabled`.
    expect(hint().classList.contains("is-idle")).toBe(true);
    expect(hint().classList.contains("is-steer")).toBe(false);
    hostMessage({ type: "status", active: true });
    expect(hint().classList.contains("is-idle")).toBe(false);
    expect(word().textContent).toBe("Queue");
    hostMessage({ type: "status", active: false });
    expect(hint().classList.contains("is-idle")).toBe(true);
  });

  it("is a plain indicator: it is not a button and has no click handler", async () => {
    await loadView();
    hostMessage({ type: "status", active: true });
    expect(hint().querySelector("button")).toBe(null);
    hint().click();
    expect(word().textContent).toBe("Queue");
    hint().click();
    expect(word().textContent).toBe("Queue");
  });

  it("shows Steer ONLY while working with Ctrl/Cmd held, reverts on release", async () => {
    await loadView();
    // idle: the modifier has no effect
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control" }));
    expect(word().textContent).toBe("Queue");
    // working: the already-held modifier now shows Steer
    hostMessage({ type: "status", active: true });
    expect(word().textContent).toBe("Steer");
    expect(hint().classList.contains("is-steer")).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
    expect(word().textContent).toBe("Queue");
    expect(hint().classList.contains("is-steer")).toBe(false);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta" }));
    expect(word().textContent).toBe("Steer");
    // the run ends while the modifier is held → back to Queue
    hostMessage({ type: "status", active: false });
    expect(word().textContent).toBe("Queue");
  });

  it("suppresses the native context menu on controls but keeps it in the prompt", async () => {
    await loadView();
    const onButton = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    (document.getElementById("ctl-toggle-btn") as HTMLButtonElement).dispatchEvent(onButton);
    expect(onButton.defaultPrevented).toBe(true);

    const onInput = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    input().dispatchEvent(onInput);
    expect(onInput.defaultPrevented).toBe(false);
  });

  it("blur releases the Ctrl/Cmd override", async () => {
    await loadView();
    hostMessage({ type: "status", active: true });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta" }));
    expect(word().textContent).toBe("Steer");
    window.dispatchEvent(new Event("blur"));
    expect(word().textContent).toBe("Queue");
  });

  it("a sent steer stays Steer while the key is held, Queue once released", async () => {
    await loadView();
    hostMessage({ type: "status", active: true });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control" }));
    input().value = "use Rome";
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    expect(posted.find((m: any) => m.type === "send")).toMatchObject({ mode: "steer" });
    expect(word().textContent).toBe("Steer"); // still held
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
    expect(word().textContent).toBe("Queue");
  });

  it("the working bar NAMES the tool that is running — and keeps it until the LAST one lands", async () => {
    // The rule, in one place: the name belongs to a call that has NOT finished. It used to be
    // cleared by ANY result, so with two calls in flight (Parallel, or a sub-agent's own tools) the
    // bar dropped the name while work was still happening — which read as random.
    await loadView();
    const bar = document.getElementById("working-bar") as HTMLElement;
    hostMessage({ type: "status", active: true });
    expect(bar.textContent).toBe("● Working...");

    // A call starts: the name appears.
    hostMessage({ type: "toolCall", id: "c1", name: "Shell", arguments: {} });
    expect(bar.textContent).toContain("Shell");

    // A SECOND call starts before the first lands: the newest name wins.
    hostMessage({ type: "toolCall", id: "c2", name: "Read", arguments: {} });
    expect(bar.textContent).toContain("Read");

    // The FIRST result lands: `Read` may still be running, so the name does not vanish.
    hostMessage({ type: "toolResult", toolCallId: "c1", output: "ok", isError: false });
    expect(bar.textContent).toContain("Read");
    // The last one lands: back to plain, and no leftover name.
    hostMessage({ type: "toolResult", toolCallId: "c2", output: "ok", isError: false });
    expect(bar.textContent).toBe("● Working...");
  });

  it("a Delegate call says sub-agent, not the tool name", async () => {
    await loadView();
    const bar = document.getElementById("working-bar") as HTMLElement;
    hostMessage({ type: "status", active: true });
    hostMessage({ type: "toolCall", id: "d1", name: "Delegate", arguments: {} });
    expect(bar.textContent).toContain("sub-agent");
    expect(bar.textContent).not.toContain("Delegate");
  });

  it("a result for an UNKNOWN call does not disturb the name of the real one", async () => {
    // The host can deliver a result for an id this panel never saw (a rebuild raced it). It must be
    // inert: the map is the truth for the bar, so the pending call keeps its name and the stray id
    // does not clear it. (The `delete` outside the `if` is DEFENSIVE — see the comment there: it
    // cannot be reached through the public events, because `get` and `delete` share the same map.)
    await loadView();
    const bar = document.getElementById("working-bar") as HTMLElement;
    hostMessage({ type: "status", active: true });
    hostMessage({ type: "toolCall", id: "c1", name: "Shell", arguments: {} });
    expect(bar.textContent).toContain("Shell");
    hostMessage({ type: "toolResult", toolCallId: "something-else", output: "ok", isError: false });
    expect(bar.textContent).toContain("Shell"); // c1 is still pending: the name is still true
    hostMessage({ type: "toolResult", toolCallId: "c1", output: "ok", isError: false });
    expect(bar.textContent).toBe("● Working...");
  });

  it("shows the working bar when a run starts without an optimistic send (queued dispatch)", async () => {
    await loadView();
    const bar = document.getElementById("working-bar") as HTMLElement;
    expect(bar.classList.contains("hidden")).toBe(true);
    // A queued message the host dispatches only sends `status`, not a local
    // send: the bar must still appear.
    hostMessage({ type: "status", active: true });
    expect(bar.classList.contains("hidden")).toBe(false);
    hostMessage({ type: "done" });
    expect(bar.classList.contains("hidden")).toBe(true);
  });

  it("Enter steers while Ctrl/Cmd is held", async () => {
    await loadView();
    hostMessage({ type: "status", active: true });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control" }));
    input().value = "use Rome";
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    expect(posted.find((m: any) => m.type === "send")).toMatchObject({ mode: "steer", text: "use Rome" });
  });

  it("the play key steers while Ctrl/Cmd is held", async () => {
    await loadView();
    hostMessage({ type: "status", active: true });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta" }));
    input().value = "use Rome";
    (document.getElementById("send-btn") as HTMLButtonElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(posted.find((m: any) => m.type === "send")).toMatchObject({ mode: "steer", text: "use Rome" });
  });

  it("a keyup swallowed by a system overlay does not leave Steer stuck (macOS ⌘⇧4 / ⌘⇧5)", async () => {
    // The screenshot / screen-recording overlay takes Cmd's keyup for itself, and the VS Code window
    // is never deactivated — so neither `keyup` nor `blur` ever reaches this page (field report: "the
    // steer state stays stuck"). The next ordinary KEY carries the real modifier state, so the
    // pill cannot stay lit until the user happens to tap Ctrl/Cmd again.
    await loadView();
    hostMessage({ type: "status", active: true });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }));
    expect(word().textContent).toBe("Steer");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", metaKey: false, ctrlKey: false }));

    expect(word().textContent).toBe("Queue");
    expect(hint().classList.contains("is-steer")).toBe(false);
  });

  it("…and it is corrected BEFORE Enter reads it: a plain ⏎ QUEUES", async () => {
    // The damage of a stuck flag is not the pill: `effectiveSendMode()` reads the same value, so the
    // next plain Enter would have STEERED into the running loop. The correction listener runs in the
    // CAPTURE phase for exactly this reason — a bubble listener on window fires after the
    // textarea's own handler, one event too late.
    await loadView();
    hostMessage({ type: "status", active: true });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }));

    input().value = "andrea";
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: false, bubbles: true }));

    expect(posted.find((m: any) => m.type === "send")).toMatchObject({ mode: "queue", text: "andrea" });
  });

  it("a mouse move, a click or coming back into the panel also clears it (all three OSes)", async () => {
    await loadView();
    hostMessage({ type: "status", active: true });
    const stuck = (): void => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }));
      expect(word().textContent).toBe("Steer");
    };
    // Motion carries the real modifier state.
    stuck();
    window.dispatchEvent(new MouseEvent("mousemove", { metaKey: false, ctrlKey: false }));
    expect(word().textContent).toBe("Queue");
    // …and so does a press, for a pointer that never moved (a click, a pen, a touch tap).
    stuck();
    window.dispatchEvent(new MouseEvent("mousedown", { metaKey: false, ctrlKey: false }));
    expect(word().textContent).toBe("Queue");
    // Back from another app: the state is UNKNOWABLE, so it starts clean.
    stuck();
    window.dispatchEvent(new Event("focus"));
    expect(word().textContent).toBe("Queue");
  });

  it("while the modifier IS held none of those events clear it (the fix only ever releases)", async () => {
    await loadView();
    hostMessage({ type: "status", active: true });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }));
    // A ⌘C copy is a keystroke WITH the modifier: it must keep Steer lit.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", metaKey: true }));
    expect(word().textContent).toBe("Steer");
    window.dispatchEvent(new MouseEvent("mousemove", { metaKey: true, ctrlKey: false }));
    expect(word().textContent).toBe("Steer");
  });

  // ── the OTHER platform, tested on purpose ──
  //
  // Everything above runs with the UA pinned to macOS (see `MAC_USER_AGENT`): the fixture used to
  // `delete navigator.userAgent`, a NO-OP that left jsdom's host-derived value in place, so these
  // tests were green on a Mac and RED on Ubuntu and Windows — and the non-macOS branches of
  // `isMacPlatform()` were never executed anywhere. They are executed here.
  describe("off macOS: Ctrl only, and the native menu is kept", () => {
    const setUa = (ua: string): void => {
      Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
    };
    const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)";
    const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)";

    for (const [name, ua] of [
      ["Windows", WINDOWS],
      ["Linux", LINUX],
    ] as const) {
      it(`on ${name} the modifier is Ctrl, and Meta does nothing`, async () => {
        setupFixture();
        setUa(ua);
        await loadView();
        hostMessage({ type: "status", active: true });
        // Meta is NOT the modifier there: the hint stays Queue.
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta" }));
        expect(word().textContent).toBe("Queue");
        expect(hint().classList.contains("is-steer")).toBe(false);
        // Ctrl is.
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }));
        expect(word().textContent).toBe("Steer");
        expect(hint().classList.contains("is-steer")).toBe(true);
      });

      it(`on ${name} a stuck Ctrl is released exactly the same way`, async () => {
        setupFixture();
        setUa(ua);
        await loadView();
        hostMessage({ type: "status", active: true });
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }));
        expect(word().textContent).toBe("Steer");
        // The keyup went to another window/app (Alt+Tab, a system tool): the next mouse move knows.
        window.dispatchEvent(new MouseEvent("mousemove", { ctrlKey: false, metaKey: false }));
        expect(word().textContent).toBe("Queue");
        // …and here Meta is the SUPER key: a tap of it must not light the pill (it never did).
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }));
        expect(word().textContent).toBe("Queue");
      });
    }

    it("on Windows/Linux the native context menu on a CONTROL is kept (the suppression is Chrome's)", async () => {
      setupFixture();
      setUa(WINDOWS);
      await loadView();
      const onButton = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      (document.getElementById("ctl-toggle-btn") as HTMLButtonElement).dispatchEvent(onButton);
      // Not prevented: there the native menu is the one that knows Cut/Copy/Paste.
      expect(onButton.defaultPrevented).toBe(false);
      // The transcript's PROSE still uses our menu: that part is not platform-specific.
      const onProse = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      (document.querySelector("#messages .msg") as HTMLElement).dispatchEvent(onProse);
      expect(onProse.defaultPrevented).toBe(true);
    });
  });

  it("keeps the prompt enabled while working with a mode hint", async () => {
    await loadView();
    hostMessage({ type: "status", active: true });
    expect(input().disabled).toBe(false);
    expect(input().placeholder.toLowerCase()).toContain("steer");
    hostMessage({ type: "status", active: false });
    expect(input().placeholder).toContain("Enter to send");
  });
});

describe("steer target removed (webview)", () => {
  it("a Delegate bubble has the abort key but NO steer-target key", async () => {
    await loadView();
    hostMessage({
      type: "toolCall",
      id: "tc-1",
      name: "Delegate",
      arguments: { id: "f", goal: "temperature of Florence" },
    });
    const header = document.querySelector(".subagent-header") as HTMLElement;
    expect(header.querySelector(".subagent-abort")).toBeTruthy();
    expect(header.querySelector(".subagent-steer")).toBeNull();
    expect(document.getElementById("steer-target")).toBeNull();
  });
});

describe("per-turn metrics badge (webview)", () => {
  it("renders a compact badge under an assistant bubble (real usage + timings)", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [
        { role: "user", content: "hi", timestamp: 1 },
        {
          role: "assistant",
          content: "hello",
          timestamp: 2,
          meta: {
            inputTokens: 1200,
            outputTokens: 340,
            totalTokens: 1540,
            cachedTokens: 800,
            cachedWriteTokens: 100,
            durationMs: 3400,
            ttftMs: 800,
          },
        },
      ],
    });
    const badge = document.querySelector(".msg-meta") as HTMLElement;
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain("1.2k in");
    expect(badge.textContent).toContain("340 out");
    expect(badge.textContent).toContain("⚡ 800");
    expect(badge.textContent).toContain("elapsed 3.4s");
    expect(badge.textContent).toContain("first token 800ms");
    expect(badge.title).toContain("input: 1200 tokens");
    expect(badge.title).toContain("cache write: 100 tokens");
    // The badge sits right AFTER the assistant bubble.
    expect(badge.previousElementSibling!.classList.contains("assistant")).toBe(true);
  });

  it("renders no badge when a message carries no meta", async () => {
    await loadView();
    hostMessage({ type: "refresh", messages: [{ role: "assistant", content: "hello", timestamp: 2 }] });
    expect(document.querySelector(".msg-meta")).toBeNull();
  });

  it("shows WHICH model served the turn, first on the line, with the budget in the tooltip", async () => {
    await loadView();
    // A session that switches model mid-flight: the two turns differ only in the
    // meta, and the badge must make that visible — otherwise the token counts
    // have no unit (32k llama-local vs 1M opencode in the same transcript).
    hostMessage({
      type: "refresh",
      messages: [
        { role: "user", content: "go", timestamp: 1 },
        {
          role: "assistant",
          content: "first",
          timestamp: 2,
          meta: {
            model: "qwen3-32b",
            provider: "llama-local",
            contextWindow: 32768,
            maxTokens: 8192,
            inputTokens: 12000,
            durationMs: 900,
          },
        },
        {
          role: "assistant",
          content: "second",
          timestamp: 3,
          meta: {
            model: "deepseek-v4.1-flash",
            provider: "opencode-go",
            contextWindow: 1_048_576,
            maxTokens: 377_084,
            inputTokens: 663_300,
            durationMs: 2200,
          },
        },
      ],
    });
    const badges = Array.from(document.querySelectorAll(".msg-meta")) as HTMLElement[];
    expect(badges.length).toBe(2);
    expect(badges[0].textContent).toContain("qwen3-32b");
    expect(badges[0].textContent).toContain("12k in");
    expect(badges[1].textContent).toContain("deepseek-v4.1-flash");
    // The model is the FIRST part: the row is nowrap + ellipsized, so whatever
    // gets cut has to be the least important thing.
    expect(badges[1].textContent!.indexOf("deepseek-v4.1-flash")).toBe(0);
    // The provider is NOT on the row — it is one hover away.
    expect(badges[1].textContent).not.toContain("opencode-go");
    // The full budget of the turn stays one hover away.
    expect(badges[1].title).toContain("model: deepseek-v4.1-flash");
    expect(badges[1].title).toContain("provider: opencode-go");
    expect(badges[1].title).toContain("context window: 1048576 tokens");
    expect(badges[1].title).toContain("output budget: 377084 tokens");
    expect(badges[1].title).toContain("input: 663300 tokens");
  });
});

describe("per-turn metrics badge — tool-only turns", () => {
  it("shows a badge for a TOOL-ONLY assistant turn (no text bubble)", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [
        { role: "user", content: "go", timestamp: 1 },
        {
          role: "assistant",
          content: "🔧 Tool: Read",
          timestamp: 2,
          meta: { inputTokens: 900, outputTokens: 12, durationMs: 1500 },
          toolCalls: [{ id: "t1", name: "Read", arguments: {} }],
        },
        { role: "tool", content: "out", toolCallId: "t1", timestamp: 3 },
      ],
    });
    const badges = document.querySelectorAll(".msg-meta");
    expect(badges.length).toBe(1);
    expect(badges[0].textContent).toContain("900 in");
    expect(badges[0].textContent).toContain("elapsed 1.5s");
  });
});

describe("per-turn metrics badge — live turnMeta", () => {
  it("appends a badge IMMEDIATELY on turnMeta, with no re-render", async () => {
    await loadView();
    hostMessage({ type: "refresh", messages: [{ role: "user", content: "q", timestamp: 1 }] });
    expect(document.querySelectorAll(".msg-meta").length).toBe(0);

    hostMessage({ type: "turnMeta", meta: { inputTokens: 1500, outputTokens: 30, durationMs: 1200, ttftMs: 300 } });

    const badge = document.querySelector(".msg-meta") as HTMLElement;
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain("1.5k in");
    expect(badge.textContent).toContain("elapsed 1.2s");
    expect(badge.textContent).toContain("first token 300ms");
  });

  it("leads the badge with the mode the turn ran in", async () => {
    // Reported as a want: which turns WROTE and which only prepared previews is not
    // something you should have to dig out of Output > Harny. The mode leads the badge,
    // as a chip you can scan a long transcript for.
    await loadView();
    hostMessage({
      type: "turnMeta",
      meta: { model: "gpt-4o", provider: "openai", mode: "agent", inputTokens: 1000, durationMs: 900 },
    });

    const chip = document.querySelector(".msg-meta .meta-mode") as HTMLElement;
    expect(chip).toBeTruthy();
    expect(chip.textContent).toBe("Build");
    expect(chip.classList.contains("build")).toBe(true);
    expect(chip.title).toContain("wrote for real");
    // The rest of the row follows, and the mode is in the tooltip too.
    expect((document.querySelector(".msg-meta") as HTMLElement).textContent).toContain("gpt-4o");
    expect((document.querySelector(".msg-meta") as HTMLElement).title).toContain("mode: Build");
  });

  it("keeps the provider OFF the badge line, in the tooltip only", async () => {
    // The row repeats under every turn and is nowrap + ellipsized: the gateway (which the model
    // selector already names) would cost width and say nothing new. One hover keeps it available.
    await loadView();
    hostMessage({ type: "turnMeta", meta: { model: "openrouter/free", provider: "openrouter", inputTokens: 10 } });
    const badge = document.querySelector(".msg-meta") as HTMLElement;
    expect(badge.textContent).toContain("openrouter/free");
    expect(badge.textContent).not.toContain("openrouter ·");
    expect(badge.title).toContain("provider: openrouter");
  });

  it("marks an Analyze turn as such, and shows NO chip on turns recorded before the mode existed", async () => {
    await loadView();
    hostMessage({ type: "turnMeta", meta: { mode: "analyze", inputTokens: 10, durationMs: 100 } });
    const chip = document.querySelector(".msg-meta .meta-mode") as HTMLElement;
    expect(chip.textContent).toBe("Analyze");
    expect(chip.classList.contains("analyze")).toBe(true);
    // Analyze keeps the quiet gray chip: no .build on it, and the line is never tinted.
    expect(chip.classList.contains("build")).toBe(false);
    expect((document.querySelector(".msg-meta") as HTMLElement).classList.contains("build")).toBe(false);

    // An old transcript has no mode in its meta: the chip is simply absent (no
    // placeholder, no "unknown") and so is the Build tint.
    hostMessage({ type: "turnMeta", meta: { inputTokens: 20, durationMs: 200 } });
    const badges = document.querySelectorAll(".msg-meta");
    expect(badges[1].querySelector(".meta-mode")).toBe(null);
    expect(badges[1].textContent).toContain("20 in");
    expect(badges[1].classList.contains("build")).toBe(false);
  });

  it("puts the accent on the WORD Build only, never on the whole badge line", async () => {
    await loadView();
    hostMessage({ type: "turnMeta", meta: { mode: "agent", model: "gpt-4o", inputTokens: 1000, durationMs: 900 } });
    // The chip carries the flag the CSS colours; the line around it stays gray.
    const badge = document.querySelector(".msg-meta") as HTMLElement;
    const chip = badge.querySelector(".meta-mode") as HTMLElement;
    expect(chip.classList.contains("build")).toBe(true);
    expect(chip.textContent).toBe("Build");
    expect(badge.classList.contains("build")).toBe(false);
  });
});

describe("DB vacuum modal (webview)", () => {
  const stats = { pageCount: 100, freePages: 50, pageSize: 4096, bytesFree: 204800, bytesTotal: 409600, ratio: 0.5 };

  it("opens on the dbVacuum modal kind, rendering the stats and the threshold", async () => {
    await loadView();
    hostMessage({ type: "modal", modalId: 7, kind: "dbVacuum", threshold: 20, minFreeMB: 10, stats });
    expect((document.getElementById("db-vacuum-modal") as HTMLElement).classList.contains("hidden")).toBe(false);
    expect((document.getElementById("db-vacuum-stats") as HTMLElement).textContent).toContain("50%");
    expect((document.getElementById("db-vacuum-info") as HTMLElement).textContent).toContain("20%");
    expect((document.getElementById("db-vacuum-info") as HTMLElement).textContent).toContain("10 MB");
  });

  it("Close posts modalResponse for the modal id", async () => {
    await loadView();
    hostMessage({ type: "modal", modalId: 7, kind: "dbVacuum", stats });
    (document.getElementById("db-vacuum-close") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "modalResponse", id: 7, value: true });
  });

  it("Compact now posts runVacuum and shows the before → after result", async () => {
    await loadView();
    hostMessage({ type: "modal", modalId: 7, kind: "dbVacuum", stats });
    (document.getElementById("db-vacuum-run") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "runVacuum" });

    hostMessage({
      type: "dbVacuumResult",
      result: {
        vacuumed: true,
        before: stats,
        after: { ...stats, freePages: 0, bytesFree: 0, ratio: 0 },
        durationMs: 1200,
      },
    });
    expect((document.getElementById("db-vacuum-msg") as HTMLElement).textContent).toContain("1.2s");
    expect((document.getElementById("db-vacuum-run") as HTMLButtonElement).textContent).toBe("VACUUM & optimize again");
  });

  it("the All-Sessions footer renders the stats + both settings and posts the manual open", async () => {
    await loadView();
    hostMessage({
      type: "sessionsManager",
      sessions: [],
      vacuum: { stats, threshold: 25, minFreeMB: 15 },
      show: false,
    });
    expect((document.getElementById("sm-vacuum-stats") as HTMLElement).textContent).toContain("50%");
    expect((document.getElementById("sm-vacuum-threshold") as HTMLInputElement).value).toBe("25");
    expect((document.getElementById("sm-vacuum-min") as HTMLInputElement).value).toBe("15");
    (document.getElementById("sm-vacuum-btn") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "openVacuumModal" });
  });
});

describe("DB vacuum — sliders, info-only modal, live settings", () => {
  const stats = { pageCount: 100, freePages: 50, pageSize: 4096, bytesFree: 204800, bytesTotal: 409600, ratio: 0.5 };

  it("sliders update their value labels live and persist on change", async () => {
    await loadView();
    const th = document.getElementById("sm-vacuum-threshold") as HTMLInputElement;
    const thVal = document.getElementById("sm-vacuum-threshold-val") as HTMLElement;
    const min = document.getElementById("sm-vacuum-min") as HTMLInputElement;
    const minVal = document.getElementById("sm-vacuum-min-val") as HTMLElement;

    th.value = "42";
    th.dispatchEvent(new Event("input", { bubbles: true }));
    expect(thVal.textContent).toBe("42%");
    th.dispatchEvent(new Event("change", { bubbles: true }));
    expect(posted).toContainEqual({ type: "setVacuumThreshold", percent: 42 });

    min.value = "33";
    min.dispatchEvent(new Event("input", { bubbles: true }));
    expect(minVal.textContent).toBe("33 MB");
    min.dispatchEvent(new Event("change", { bubbles: true }));
    expect(posted).toContainEqual({ type: "setVacuumMinFreeMB", mb: 33 });
  });

  it("dbVacuumSettings updates both sliders + their labels", async () => {
    await loadView();
    hostMessage({ type: "dbVacuumSettings", threshold: 30, minFreeMB: 40 });
    expect((document.getElementById("sm-vacuum-threshold") as HTMLInputElement).value).toBe("30");
    expect((document.getElementById("sm-vacuum-threshold-val") as HTMLElement).textContent).toBe("30%");
    expect((document.getElementById("sm-vacuum-min") as HTMLInputElement).value).toBe("40");
    expect((document.getElementById("sm-vacuum-min-val") as HTMLElement).textContent).toBe("40 MB");
  });

  it("the dbVacuum modal is INFO ONLY (no editable input inside it)", async () => {
    await loadView();
    hostMessage({ type: "modal", modalId: 7, kind: "dbVacuum", threshold: 20, minFreeMB: 10, stats });
    expect(document.querySelector("#db-vacuum-modal input")).toBeNull();
    // The message says it OPTIMIZES the indexes, not only compacts.
    expect((document.getElementById("db-vacuum-msg") as HTMLElement).textContent).toContain("OPTIMIZES");
    expect((document.getElementById("db-vacuum-info") as HTMLElement).textContent).toContain("All sessions");
  });

  it("dbVacuumRunning shows the waiting message", async () => {
    await loadView();
    hostMessage({ type: "modal", modalId: 7, kind: "dbVacuum", stats });
    hostMessage({ type: "dbVacuumRunning" });
    expect((document.getElementById("db-vacuum-msg") as HTMLElement).textContent).toContain("idle");
  });
});

describe("slider maxima follow the model's detected limits", () => {
  it("sets the slider MAX (and value) to the detected limits (so you can only decrease)", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "m",
        hasKey: true,
        models: [],
        providerModels: [],
        contextWindow: 128000,
        maxContextWindow: 128000,
        outputTokens: 16384,
        maxOutputTokens: 16384,
      },
    });
    const ctx = document.getElementById("ctx-range") as HTMLInputElement;
    const out = document.getElementById("out-range") as HTMLInputElement;
    expect(ctx.max).toBe("128000");
    expect(ctx.value).toBe("128000");
    expect(out.max).toBe("16384");
    expect(out.value).toBe("16384");
  });

  it("falls back to the GLOBAL maxima when the model is unknown", async () => {
    await loadView();
    hostMessage({
      type: "config",
      config: {
        provider: "openai",
        model: "m",
        hasKey: true,
        models: [],
        providerModels: [],
        contextWindow: 128000,
        maxContextWindow: 2000000,
        outputTokens: 16384,
        maxOutputTokens: 262144,
      },
    });
    expect((document.getElementById("ctx-range") as HTMLInputElement).max).toBe("2000000");
    expect((document.getElementById("out-range") as HTMLInputElement).max).toBe("262144");
  });
});

describe("slider step makes the exact model maximum reachable", () => {
  const cfg = (o: Record<string, unknown>) => ({
    type: "config",
    config: { provider: "openai", model: "m", hasKey: true, models: [], providerModels: [], ...o },
  });

  it("drops the step to 1 when the nominal step does NOT divide the range (out 7963, ctx 131072)", async () => {
    await loadView();
    hostMessage(cfg({ contextWindow: 131072, maxContextWindow: 131072, outputTokens: 7963, maxOutputTokens: 7963 }));
    const ctx = document.getElementById("ctx-range") as HTMLInputElement;
    const out = document.getElementById("out-range") as HTMLInputElement;
    expect(ctx.max).toBe("131072");
    expect(ctx.step).toBe("1"); // 131072 - 1000 = 130072, not a multiple of 1000
    expect(ctx.value).toBe("131072");
    expect(out.max).toBe("7963");
    expect(out.step).toBe("1"); // 7963 - 8 = 7955, not a multiple of 8
    expect(out.value).toBe("7963");
  });

  it("keeps the nominal step when it divides the range", async () => {
    await loadView();
    hostMessage(cfg({ contextWindow: 128000, maxContextWindow: 128000, outputTokens: 16384, maxOutputTokens: 16384 }));
    expect((document.getElementById("ctx-range") as HTMLInputElement).step).toBe("1000");
    expect((document.getElementById("out-range") as HTMLInputElement).step).toBe("8");
  });
});

describe("control range labels + sampler scale", () => {
  const cfg = (o: Record<string, unknown>) => ({
    type: "config",
    config: { provider: "openai", model: "m", hasKey: true, models: [], providerModels: [], ...o },
  });

  it("adapts the sampler scale to the selected control and shows its (min → max)", async () => {
    await loadView();
    hostMessage(
      cfg({
        sampler: "temperature",
        temperature: 0.7,
        contextWindow: 128000,
        maxContextWindow: 128000,
        outputTokens: 16384,
        maxOutputTokens: 16384,
      }),
    );
    const samp = document.getElementById("samp-range") as HTMLInputElement;
    expect(samp.max).toBe("2");
    expect(samp.value).toBe("0.7");
    expect((document.getElementById("samp-range-label") as HTMLElement).textContent).toBe("(0.0 → 2.0)");

    // Switching to Top-P re-adapts the scale to the WHOLE track (0.0–1.0).
    hostMessage(
      cfg({
        sampler: "topP",
        topP: 0.9,
        contextWindow: 128000,
        maxContextWindow: 128000,
        outputTokens: 16384,
        maxOutputTokens: 16384,
      }),
    );
    expect(samp.max).toBe("1");
    expect(samp.value).toBe("0.9");
    expect((document.getElementById("samp-range-label") as HTMLElement).textContent).toBe("(0.0 → 1.0)");
  });

  it("shows (min → max) for the context and output controls (model max included)", async () => {
    await loadView();
    hostMessage(cfg({ contextWindow: 131072, maxContextWindow: 131072, outputTokens: 7963, maxOutputTokens: 7963 }));
    expect((document.getElementById("ctx-range-label") as HTMLElement).textContent).toBe("(1k → 131k)");
    expect((document.getElementById("out-range-label") as HTMLElement).textContent).toBe("(8 → 8k)");
  });
});

describe("model selector button shows the limits", () => {
  const cfg = (pm: Record<string, unknown>) => ({
    type: "config",
    config: { provider: "openai", activeProvider: "p", model: "m1", hasKey: true, models: [], providerModels: [pm] },
  });

  it("shows the detected context + output next to the model", async () => {
    await loadView();
    hostMessage(cfg({ provider: "p", model: "m1", contextLength: 128000, maxOutputTokens: 16384 }));
    expect((document.getElementById("model-btn-label") as HTMLElement).textContent).toBe("p · m1 · 128k · out 16k");
  });

  it("shows '-' for an unrecognized model (unknown limits)", async () => {
    await loadView();
    hostMessage(cfg({ provider: "p", model: "m1" }));
    expect((document.getElementById("model-btn-label") as HTMLElement).textContent).toBe("p · m1 · - · out -");
  });
});

describe("models.dev unreachable warning", () => {
  const cfg = (extra: Record<string, unknown>) => ({
    type: "config",
    config: {
      provider: "openai",
      model: "m",
      hasKey: true,
      models: [],
      providerModels: [{ provider: "p", model: "m" }],
      ...extra,
    },
  });

  it("shows the ⚠ badge and the modal warning row when modelsDevError is set", async () => {
    await loadView();
    hostMessage(cfg({ modelsDevError: true }));
    expect((document.getElementById("model-warn") as HTMLElement).classList.contains("hidden")).toBe(false);
    (document.getElementById("model-btn") as HTMLButtonElement).click();
    expect((document.getElementById("mm-modelsdev-warn") as HTMLElement).classList.contains("hidden")).toBe(false);
  });

  it("hides BOTH when the fallback is fine (no noise)", async () => {
    await loadView();
    hostMessage(cfg({}));
    expect((document.getElementById("model-warn") as HTMLElement).classList.contains("hidden")).toBe(true);
    (document.getElementById("model-btn") as HTMLButtonElement).click();
    expect((document.getElementById("mm-modelsdev-warn") as HTMLElement).classList.contains("hidden")).toBe(true);
  });
});

describe("Esc closes the TOP-MOST overlay (LIFO)", () => {
  const stats = { pageCount: 100, freePages: 50, pageSize: 4096, bytesFree: 204800, bytesTotal: 409600, ratio: 0.5 };

  it("closes the Compact modal, NOT the All-sessions modal underneath it", async () => {
    await loadView();
    // Open All sessions, then the shared Compact modal ON TOP of it.
    hostMessage({ type: "sessionsManager", sessions: [], show: true });
    hostMessage({ type: "modal", modalId: 5, kind: "dbVacuum", threshold: 20, minFreeMB: 128, stats });
    const sessions = document.getElementById("sessions-modal") as HTMLElement;
    const vacuum = document.getElementById("db-vacuum-modal") as HTMLElement;
    expect(sessions.classList.contains("hidden")).toBe(false);
    expect(vacuum.classList.contains("hidden")).toBe(false);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    // The LAST opened (Compact) closes; the one underneath stays.
    expect(vacuum.classList.contains("hidden")).toBe(true);
    expect(sessions.classList.contains("hidden")).toBe(false);

    // A second Esc then closes All sessions.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(sessions.classList.contains("hidden")).toBe(true);
  });
});

describe("the reading position survives a transcript rebuild", () => {
  const MSGS = [
    { role: "user", content: "first question", timestamp: 1 },
    { role: "assistant", content: "first answer", timestamp: 2 },
    { role: "user", content: "second question", timestamp: 3 },
  ];

  const box = () => document.getElementById("messages") as HTMLElement;
  const rect = (top: number, height = 50) =>
    ({ top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

  /** jsdom has no layout: EVERY rect is zero, so the anchor code would always conclude
   *  "nothing spans the edge". Fake the geometry on the prototype, and distinguish the
   *  OLD nodes from the ones the rebuild creates: the capture reads the old tree, the
   *  restore reads the new one, and only the difference between the two is the bug. */
  let topsBefore: number[] = [];
  let topsAfter: number[] = [];
  let oldNodes = new WeakSet<Element>();
  let scrollTop = 0;
  let originalRect: typeof HTMLElement.prototype.getBoundingClientRect;

  /** Lay the transcript out before the rebuild (`before`) and after it (`after`). */
  function setHeights(before: number[], after: number[]): void {
    topsBefore = before;
    topsAfter = after;
    oldNodes = new WeakSet<Element>();
    Array.from(box().children).forEach((el) => oldNodes.add(el));
  }

  beforeEach(() => {
    topsBefore = [];
    topsAfter = [];
    oldNodes = new WeakSet<Element>();
    scrollTop = 0;
    originalRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.id === "messages") return rect(0);
      const parent = this.parentElement;
      if (parent && parent.id === "messages") {
        // Old node → the layout as the reader sees it; anything else was built by the
        // rebuild that is running right now.
        const tops = oldNodes.has(this) ? topsBefore : topsAfter;
        const i = Array.from(parent.children).indexOf(this);
        return rect(tops[i] ?? -9999);
      }
      return originalRect.call(this);
    };
  });

  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  });

  /** Scroll metrics: a 1000px transcript in a 200px viewport. */
  function tether(at: number): void {
    scrollTop = at;
    const el = box();
    Object.defineProperty(el, "scrollHeight", { get: () => 1000, configurable: true });
    Object.defineProperty(el, "clientHeight", { get: () => 200, configurable: true });
    Object.defineProperty(el, "scrollTop", {
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
      configurable: true,
    });
  }

  const scrollTo = (at: number) => {
    scrollTop = at;
    box().dispatchEvent(new Event("scroll"));
  };

  it("keeps the reader on the same bubble when the rebuild changes the height", async () => {
    await loadView();
    tether(1000);
    hostMessage({ type: "refresh", messages: MSGS });

    // Scroll up: 1000 - 300 - 200 is far from the bottom, so autoScroll goes false.
    tether(300);
    scrollTo(300);
    // The first child is entirely above the edge; the SECOND starts 100px above it —
    // and after the rebuild that same bubble sits 300px lower (content was inserted).
    setHeights([-100, 100, 200], [-100, 400, 500]);
    hostMessage({ type: "refresh", messages: MSGS });

    // The reader was at 300; the content above grew by 300 → 600 keeps them on the
    // SAME bubble. (The old behaviour left scrollTop at 300, i.e. a different place.)
    expect(box().scrollTop).toBe(600);
  });

  it("does NOTHING when the transcript grew but the list changed under the anchor", async () => {
    await loadView();
    tether(1000);
    hostMessage({ type: "refresh", messages: MSGS });
    tether(300);
    scrollTo(300);
    // The rebuild produces FEWER children (a cut): children[1] no longer exists.
    setHeights([-100, 100, 200], [-100]);
    hostMessage({ type: "refresh", messages: [{ role: "user", content: "solo", timestamp: 1 }] });

    // A wrong scroll would be worse than none: the position is left as the render left it.
    expect(box().scrollTop).toBe(300);
  });

  it("does NOTHING when the reader sits in the bottom padding (no bubble spans the edge)", async () => {
    await loadView();
    tether(1000);
    hostMessage({ type: "refresh", messages: MSGS });
    tether(300);
    scrollTo(300);
    // Every bubble ends above the edge: there is nothing to anchor to.
    setHeights([-300, -200, -100], [-300, 400, 500]);
    hostMessage({ type: "refresh", messages: MSGS });

    expect(box().scrollTop).toBe(300);
  });

  it("leaves FOLLOWING alone: a refresh still pins the transcript to the end", async () => {
    await loadView();
    tether(1000);
    hostMessage({ type: "refresh", messages: MSGS });
    // Still following (no scroll): autoScroll is true, so no anchor is captured.
    setHeights([-100, 100, 200], [-100, 400, 500]);

    hostMessage({ type: "refresh", messages: MSGS });

    expect(box().scrollTop).toBe(1000); // scrollHeight — unchanged behaviour
  });

  it("survives an empty transcript", async () => {
    await loadView();
    tether(1000);
    expect(() => hostMessage({ type: "refresh", messages: [] })).not.toThrow();
  });
});

describe("transcript action pills (collapse all + autoscroll)", () => {
  /** One section of each kind: a thinking block, a tool bubble, a sub-agent. */
  async function withAllSections(): Promise<void> {
    await loadView();
    hostMessage({
      type: "switchView",
      sessions: [{ id: "a", name: "S", createdAt: 1, updatedAt: 2, messageCount: 2 }],
      openIds: ["a"],
      activeId: "a",
      messages: [
        { role: "user", content: "hi", timestamp: 1 },
        { role: "assistant", content: "ok", thinking: "deep thought", timestamp: 2 },
      ],
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
      workingIds: [],
    });
    hostMessage(PARALLEL_ON);
    hostMessage({ type: "toolCall", id: "t1", name: "Read", arguments: { path: "a.ts" } });
    hostMessage({
      type: "toolCall",
      id: "s1",
      name: "Delegate",
      arguments: { id: "A", goal: "g", access: "read", resources: ["a.ts"] },
    });
  }

  const tab = () => document.getElementById("collapse-all") as HTMLButtonElement;
  const auto = () => document.getElementById("autoscroll") as HTMLButtonElement;
  const strip = () => document.getElementById("ctl-toggle") as HTMLElement;
  const openCount = () =>
    document.querySelectorAll(
      ".thinking-body:not(.collapsed), .tool-details:not(.collapsed), .subagent-body:not(.collapsed)",
    ).length;

  /** jsdom does no layout: fake the scroll metrics so the scroll listener can be
   * driven, and return a setter the tests use as the user's wheel position. */
  function tetherScroll(): (top: number) => void {
    const messages = document.getElementById("messages") as HTMLElement;
    let top = 0;
    Object.defineProperty(messages, "scrollHeight", { get: () => 1000, configurable: true });
    Object.defineProperty(messages, "clientHeight", { get: () => 200, configurable: true });
    Object.defineProperty(messages, "scrollTop", {
      get: () => top,
      set: (v: number) => {
        top = v;
      },
      configurable: true,
    });
    return (v) => {
      top = v;
    };
  }

  const emitScroll = () => (document.getElementById("messages") as HTMLElement).dispatchEvent(new Event("scroll"));

  it("ships both pills present, and disabled is the only thing that changes", async () => {
    await withAllSections();
    // One of each kind, all created collapsed.
    expect(document.querySelector(".thinking-body.collapsed")).not.toBeNull();
    expect(document.querySelector(".msg.tool:not(.subagent) .tool-details.collapsed")).not.toBeNull();
    expect(document.querySelector(".subagent-body.collapsed")).not.toBeNull();
    // Both live in the right-aligned group, both disabled, neither hidden: the
    // row must never reflow, so visibility is never toggled.
    expect(document.querySelectorAll("#transcript-actions > button").length).toBe(2);
    expect(tab().disabled).toBe(true);
    expect(auto().disabled).toBe(true);
    expect(tab().classList.contains("hidden")).toBe(false);
    expect(auto().classList.contains("hidden")).toBe(false);
  });

  it("Collapse all also folds the pending bubbles (and the pill watches them)", async () => {
    await loadView();
    hostMessage({ type: "pending", items: [{ id: "q1", mode: "queue", text: "queued while it works" }] });
    const row = document.querySelector("#pending-area .pending-msg") as HTMLElement;
    const fold = row.querySelector(".pending-toggle") as HTMLButtonElement;

    // Born folded: there is nothing to close yet.
    expect(tab().disabled).toBe(true);

    fold.click();
    expect(row.classList.contains("text-collapsed")).toBe(false);
    // An OPEN pending bubble is exactly what the pill is for.
    expect(tab().disabled).toBe(false);

    tab().click();
    expect(row.classList.contains("text-collapsed")).toBe(true);
    expect(fold.classList.contains("is-open")).toBe(false);
    expect(tab().disabled).toBe(true);
  });

  it("Collapse all enables when a section is expanded and disables when it closes", async () => {
    await withAllSections();
    const header = document.querySelector(".thinking-header") as HTMLElement;
    header.click();
    expect(tab().disabled).toBe(false);
    header.click();
    expect(tab().disabled).toBe(true);
  });

  it("closes thinking, tool and sub-agent sections at once, resetting every arrow", async () => {
    await withAllSections();
    (document.querySelector(".thinking-header") as HTMLElement).click();
    const tool = document.querySelector(".msg.tool:not(.subagent)") as HTMLElement;
    (tool.querySelector(".tool-header") as HTMLElement).click();
    const sub = document.querySelector(".msg.tool.subagent") as HTMLElement;
    (sub.querySelector(".subagent-header") as HTMLElement).click();
    expect(openCount()).toBe(3);

    tab().click();

    expect(openCount()).toBe(0);
    expect(document.querySelector(".thinking-header .toggle")?.classList.contains("is-open") ?? false).toBe(false);
    expect(tool.querySelector(".tool-toggle")?.classList.contains("is-open") ?? false).toBe(false);
    expect(sub.querySelector(".tool-toggle")?.classList.contains("is-open") ?? false).toBe(false);
    expect(tab().disabled).toBe(true);
  });

  it("Collapse all never toggles the control stack: the whole strip is a click target", async () => {
    await withAllSections();
    (document.querySelector(".thinking-header") as HTMLElement).click();

    tab().click();

    // The strip's own handler must NOT have run: it is what toggles the stack.
    expect(document.body.classList.contains("controls-collapsed")).toBe(true);
    expect(strip().getAttribute("aria-expanded")).toBe("false");
    // Positive control, so the assertions above cannot pass vacuously.
    strip().click();
    expect(document.body.classList.contains("controls-collapsed")).toBe(false);
  });

  it("Collapse all is disabled again after a transcript rebuild", async () => {
    await withAllSections();
    (document.querySelector(".thinking-header") as HTMLElement).click();
    expect(tab().disabled).toBe(false);

    hostMessage({
      type: "switchView",
      sessions: [{ id: "a", name: "S", createdAt: 1, updatedAt: 2, messageCount: 1 }],
      openIds: ["a"],
      activeId: "a",
      messages: [{ role: "user", content: "again", timestamp: 3 }],
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
      workingIds: [],
    });

    expect(tab().disabled).toBe(true);
  });

  it("Autoscroll is disabled while the user follows the bottom", async () => {
    await loadView();
    const setTop = tetherScroll();
    // scrollHeight 1000, clientHeight 200 → 800 is the bottom.
    setTop(800);
    emitScroll();
    expect(auto().disabled).toBe(true);
  });

  it("Autoscroll enables as soon as the user scrolls away from the bottom", async () => {
    await loadView();
    const setTop = tetherScroll();
    setTop(400); // 1000 - 400 - 200 = 400px from the bottom
    emitScroll();
    expect(auto().disabled).toBe(false);
    // Coming back within SCROLL_BOTTOM_TOLERANCE re-arms it by itself.
    setTop(790);
    emitScroll();
    expect(auto().disabled).toBe(true);
  });

  it("clicking Autoscroll jumps to the latest and re-disables itself", async () => {
    await loadView();
    const setTop = tetherScroll();
    const messages = document.getElementById("messages") as HTMLElement;
    setTop(400);
    emitScroll();
    expect(auto().disabled).toBe(false);

    auto().click();

    expect(messages.scrollTop).toBe(1000);
    expect(messages.scrollTop).toBe(messages.scrollHeight);
    expect(auto().disabled).toBe(true);
  });

  it("Autoscroll never toggles the control stack either", async () => {
    await loadView();
    const setTop = tetherScroll();
    setTop(400);
    emitScroll();

    auto().click();

    expect(document.body.classList.contains("controls-collapsed")).toBe(true);
    expect(strip().getAttribute("aria-expanded")).toBe("false");
    // Positive control.
    strip().click();
    expect(document.body.classList.contains("controls-collapsed")).toBe(false);
  });
});

// ── Streaming paint coalescing (the "frozen panel" regression) ──
// Symptom: the panel went unresponsive when the window was resized during a run
// with parallel sub-agents. Two causes, both pinned here:
//  1. every sub-agent delta re-rendered its WHOLE log as markdown on the spot
//     (hundreds of O(log) renders + forced layouts per second) instead of
//     coalescing into a frame: the message backlog never drained;
//  2. the only paint channel was requestAnimationFrame, which Chromium starves
//     for the entire duration of a resize (visibly so on Windows) — buffered
//     text had no way to land.
//
// These tests are DELIBERATELY clock-free: no "not painted yet within X ms" —
// that encodes a race, and a loaded runner can legitimately paint after a quiet
// gap. What is asserted instead is countable (how many paints a burst triggers,
// all inside ONE synchronous block) or eventual (the text does land, within a
// generous bound), so the only thing that can fail them is the behaviour itself.
describe("streaming paint coalescing (resize / parallel sub-agents)", () => {
  /** Long enough to leave the "cheap render" fast path (> FAST_PAINT_CHARS). */
  const LONG = "x".repeat(4200);

  /**
   * Count the PAINTS of a node. Every paint is a full markdown render of the whole
   * accumulated log — the cost this regression is about — so counting them IS the
   * property under test. The accessor is installed on the node itself (the real
   * descriptor stays on Element.prototype), which makes it exact and clock-free:
   * everything read around it happens in one synchronous block.
   */
  function countPaints(node: HTMLElement): () => number {
    let paints = 0;
    for (let proto: object | null = node; proto; proto = Object.getPrototypeOf(proto)) {
      const desc = Object.getOwnPropertyDescriptor(proto, "innerHTML");
      if (!desc?.get || !desc.set) continue;
      Object.defineProperty(node, "innerHTML", {
        configurable: true,
        get: () => desc.get!.call(node) as string,
        set: (value: string) => {
          paints++;
          desc.set!.call(node, value);
        },
      });
      return () => paints;
    }
    throw new Error("innerHTML accessor not found");
  }

  /** Wait (generous, bounded) for the coalesced text to LAND. It only asks that a
   * paint happens at all — never that it happens within some narrow window — so a
   * slow machine cannot make it flaky: the frame and the timer both satisfy it. */
  const eventually = (read: () => string, needle: string): Promise<void> =>
    vi.waitFor(() => expect(read()).toContain(needle), { timeout: 2000 });

  const startRun = (): void => {
    (document.getElementById("user-input") as HTMLTextAreaElement).value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();
  };
  /** A Delegate bubble, already marked as running. */
  const streamDelegate = (id: string): void => {
    hostMessage({
      type: "toolCall",
      id,
      name: "Delegate",
      arguments: { id, goal: "g", access: "read", resources: ["a.ts"] },
    });
    hostMessage({ type: "subagentStart", toolCallId: id });
  };
  const subAgentEvent = (id: string, event: unknown): void => {
    hostMessage({ type: "subagentEvent", toolCallId: id, event });
  };

  it("paints a SHORT chunk immediately (the stream stays live)", async () => {
    await loadView();
    startRun();

    // Under the cheap-render threshold the paint is immediate — no frame, no
    // timer, no clock: asserting it synchronously is exact.
    hostMessage({ type: "textDelta", content: "hello" });
    const bubble = document.querySelector(".msg.assistant") as HTMLElement;
    expect(bubble.textContent).toContain("hello");
  });

  it("renders a long answer AT MOST once per burst of deltas", async () => {
    await loadView();
    startRun();
    hostMessage({ type: "textDelta", content: LONG + "HEAD" });
    const bubble = document.querySelector(".msg.assistant") as HTMLElement;
    await eventually(() => bubble.textContent ?? "", "HEAD");

    // 30 chunks in ONE synchronous block: a whole-log markdown render per delta is
    // exactly what pinned the panel. At most one paint may happen here (the leading
    // edge, when a stall made the gap look quiet) — never thirty.
    const paints = countPaints(bubble);
    for (let i = 0; i < 30; i++) hostMessage({ type: "textDelta", content: "." });
    expect(paints()).toBeLessThanOrEqual(1);

    // …and every buffered character still lands, in order.
    await eventually(() => bubble.textContent ?? "", "HEAD" + ".".repeat(30));
  });

  it("renders a sub-agent's log AT MOST once per burst of deltas", async () => {
    await loadView();
    hostMessage(PARALLEL_ON);
    streamDelegate("s1");
    subAgentEvent("s1", { type: "text_delta", content: LONG + "HEAD" });
    const answer = document.querySelector(".sa-answer") as HTMLElement;
    await eventually(() => answer.textContent ?? "", "HEAD");

    const paints = countPaints(answer);
    for (let i = 0; i < 30; i++) subAgentEvent("s1", { type: "text_delta", content: "." });
    expect(paints()).toBeLessThanOrEqual(1);

    await eventually(() => answer.textContent ?? "", "HEAD" + ".".repeat(30));
  });

  it("keeps a pending paint per sub-agent (parallel streams never overwrite each other)", async () => {
    await loadView();
    hostMessage(PARALLEL_ON);
    streamDelegate("s1");
    streamDelegate("s2");
    subAgentEvent("s1", { type: "text_delta", content: LONG + "A" });
    subAgentEvent("s2", { type: "text_delta", content: LONG + "B" });
    const logs = [...document.querySelectorAll(".sa-answer")] as HTMLElement[];
    expect(logs).toHaveLength(2);
    await eventually(() => logs[0].textContent ?? "", "A");
    await eventually(() => logs[1].textContent ?? "", "B");

    const paints1 = countPaints(logs[0]);
    const paints2 = countPaints(logs[1]);
    // Alternating chunks in ONE tick, for two different bubbles: with a SHARED
    // coalescer the last push would clobber the other bubble's pending paint, and
    // its tail would be lost for good (the `eventually` calls below would hang).
    for (let i = 0; i < 20; i++) {
      subAgentEvent("s1", { type: "text_delta", content: "1" });
      subAgentEvent("s2", { type: "text_delta", content: "2" });
    }
    expect(paints1()).toBeLessThanOrEqual(1);
    expect(paints2()).toBeLessThanOrEqual(1);

    await eventually(() => logs[0].textContent ?? "", "A" + "1".repeat(20));
    await eventually(() => logs[1].textContent ?? "", "B" + "2".repeat(20));
  });

  it("a terminal event paints what is still buffered, at once", async () => {
    await loadView();
    hostMessage(PARALLEL_ON);
    streamDelegate("s1");
    subAgentEvent("s1", { type: "text_delta", content: LONG + "HEAD" });
    const answer = document.querySelector(".sa-answer") as HTMLElement;
    await eventually(() => answer.textContent ?? "", "HEAD");

    // The last chunk is buffered (nothing can paint it in between: no time passes,
    // and the counter is not involved). The terminal event must paint it
    // SYNCHRONOUSLY, or a finished sub-agent looks like it stopped mid-sentence.
    subAgentEvent("s1", { type: "text_delta", content: "-end" });
    subAgentEvent("s1", { type: "done" });
    expect(answer.textContent).toContain("HEAD-end");
  });

  it("paints buffered text with the TIMER when requestAnimationFrame never fires", async () => {
    // Windows resize: for the whole duration of a drag Chromium delivers no frame.
    // After the last chunk nothing else will push, so if the timer fallback were
    // missing the buffered text would never appear — the wait below would hang.
    const realRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = () => 0;
    try {
      await loadView();
      startRun();
      hostMessage({ type: "textDelta", content: LONG + "HEAD" });
      for (let i = 0; i < 5; i++) hostMessage({ type: "textDelta", content: "." });

      const bubble = document.querySelector(".msg.assistant") as HTMLElement;
      await eventually(() => bubble.textContent ?? "", "HEAD" + ".".repeat(5));
    } finally {
      window.requestAnimationFrame = realRaf;
    }
  });
});

/**
 * THE LOCK TABLE — one row per control, one column per scenario.
 *
 * This exists because the same bug was reported four times in two days (the models gear twice, the
 * MCP gear once, and each time the rule was right but applied on ONE path): the "what is blocked
 * while a session works" policy lived in seven functions with no single owner. As a TABLE it is
 * read once, and every future control is three cells — not a search through the file.
 *
 * Scenarios, exactly as the panel can meet them:
 *   · idle     — nothing runs anywhere
 *   · thisBusy — the session ON SCREEN runs (what the per-session locks follow)
 *   · otherBusy— another session runs; this one is idle
 */
describe("the lock table (what is inert while a session works)", () => {
  type Cell = "enabled" | "disabled";
  interface Row {
    /** A stable name, used in the failure message. */
    what: string;
    /** The id of the control (or the selector for the ones rendered per row). */
    id: string;
    idle: Cell;
    thisBusy: Cell;
    otherBusy: Cell;
    /** Why the cell is what it is — the part that stops the next regression. */
    why: string;
  }

  const ROWS: Row[] = [
    // ── the three gears: two axes, decided once, and the bug that started this table ──
    {
      what: "models gear",
      id: "gear-btn",
      idle: "enabled",
      thisBusy: "disabled",
      otherBusy: "enabled",
      why: "offers a model switch for a request already sent",
    },
    {
      what: "MCP gear",
      id: "mcp-configure",
      idle: "enabled",
      thisBusy: "disabled",
      otherBusy: "enabled",
      why: "saving a server reconnects and swaps the tool list mid-turn",
    },
    {
      what: "sessions gear",
      id: "sessions-gear-btn",
      idle: "enabled",
      thisBusy: "enabled",
      otherBusy: "enabled",
      why: "a blanket lock would make the managers unreachable on a busy day",
    },
    // ── per-run policy: a run is born with its mode and Parallel, so switching promises nothing ──
    {
      what: "model dropdown",
      id: "model-btn",
      idle: "enabled",
      thisBusy: "disabled",
      otherBusy: "enabled",
      why: "the run keeps the model it started with",
    },
    {
      what: "mode pill",
      id: "mode-btn",
      idle: "enabled",
      thisBusy: "disabled",
      otherBusy: "enabled",
      why: "decided once per run (see Agent.runMode)",
    },
    {
      what: "parallel pill",
      id: "parallel-btn",
      idle: "enabled",
      thisBusy: "disabled",
      otherBusy: "enabled",
      why: "same: the run keeps its setting to the last tool result",
    },
    // ── compaction ──
    {
      what: "compact button",
      id: "compact-btn",
      idle: "enabled",
      thisBusy: "disabled",
      otherBusy: "enabled",
      why: "compacting under a live turn is what mid-run compaction avoids",
    },
    {
      what: "compaction settings",
      id: "compact-settings-btn",
      idle: "enabled",
      thisBusy: "disabled",
      otherBusy: "enabled",
      why: "same",
    },
    // ── request parameters ──
    {
      what: "context window",
      id: "ctx-range",
      idle: "enabled",
      thisBusy: "disabled",
      otherBusy: "enabled",
      why: "the request envelope is fixed for the run",
    },
    {
      what: "output tokens",
      id: "out-range",
      idle: "enabled",
      thisBusy: "disabled",
      otherBusy: "enabled",
      why: "same",
    },
    {
      what: "sampler range",
      id: "samp-range",
      idle: "enabled",
      thisBusy: "disabled",
      otherBusy: "enabled",
      why: "same",
    },
    {
      what: "temperature",
      id: "sampler-temp",
      idle: "enabled",
      thisBusy: "disabled",
      otherBusy: "enabled",
      why: "same",
    },
    { what: "top-p", id: "sampler-topp", idle: "enabled", thisBusy: "disabled", otherBusy: "enabled", why: "same" },
    {
      what: "presence penalty",
      id: "presence-range",
      idle: "enabled",
      thisBusy: "disabled",
      otherBusy: "enabled",
      why: "same",
    },
    {
      what: "frequency penalty",
      id: "freq-range",
      idle: "enabled",
      thisBusy: "disabled",
      otherBusy: "enabled",
      why: "same",
    },
    { what: "parallel cap", id: "par-range", idle: "enabled", thisBusy: "disabled", otherBusy: "enabled", why: "same" },
    // ── the prompt is NEVER locked per session: Enter queues, Ctrl/Cmd steers ──
    {
      what: "prompt",
      id: "user-input",
      idle: "enabled",
      thisBusy: "enabled",
      otherBusy: "enabled",
      why: "queueing and steering are the point of a live run",
    },
    // ── the controls that only need a session ──
    {
      what: "send/play",
      id: "send-btn",
      idle: "enabled",
      thisBusy: "enabled",
      otherBusy: "enabled",
      why: "queues or steers",
    },
    {
      what: "stop",
      id: "abort-btn",
      idle: "disabled",
      thisBusy: "enabled",
      otherBusy: "disabled",
      why: "only a run can be stopped",
    },
  ];

  const cellOf = (id: string): Cell => {
    const el = document.getElementById(id) as HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | null;
    expect(el, `#${id} missing from the fixture`).not.toBeNull();
    return el!.disabled ? "disabled" : "enabled";
  };

  for (const [scenario, apply] of [
    ["idle", (): void => hostMessage({ type: "status", active: false, workingIds: [] })],
    ["thisBusy", (): void => hostMessage({ type: "status", active: true, workingIds: ["a"] })], // "a" is the fixture's active session
    ["otherBusy", (): void => hostMessage({ type: "status", active: false, workingIds: ["other"] })],
  ] as const) {
    it(`matches the table when ${scenario}`, async () => {
      await loadView();
      apply();
      const wrong = ROWS.filter((r) => cellOf(r.id) !== r[scenario]).map(
        (r) => `${r.what} (#${r.id}): expected ${r[scenario]}, got ${cellOf(r.id)} — ${r.why}`,
      );
      expect(wrong).toEqual([]);
    });
  }

  it("ALSO holds for a run started from the panel (no status message at all)", async () => {
    // The path that produced two of the four reports: typing + Play never sends `status`, so a lock
    // living only in that handler never ran.
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    const wrong = ROWS.filter((r) => cellOf(r.id) !== r.thisBusy && r.id !== "abort-btn").map(
      (r) => `${r.what} (#${r.id}): expected ${r.thisBusy} while THIS session runs — ${r.why}`,
    );
    expect(wrong).toEqual([]);
  });
});

describe("⌘C / Ctrl+C: the OS copy shortcut (webview)", () => {
  // A webview has no native Copy we can rely on: the browser copies the FOCUSED frame's selection,
  // and here that frame is the panel — where the caret lives in the prompt as often as in the
  // transcript. Reported from the field: the first ⌘C loaded the clipboard, every one after it
  // kept the FIRST capture. The chord is owned now (see `copyableSelection`), and these tests pin
  // both halves of it: it reads the selection at every keystroke, and it still finds the passage
  // when the DOM selection has been collapsed by the caret coming back to the prompt.
  const COPY = { key: "c", metaKey: true, ctrlKey: true };

  /** A clipboard that records what reached it, and the undo for it. */
  function spyClipboard(): { written: string[]; restore: () => void } {
    const before = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (t: string) => void written.push(t) },
      configurable: true,
    });
    return {
      written,
      restore: () => {
        if (before) Object.defineProperty(navigator, "clipboard", before);
        else Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
      },
    };
  }

  /** Select one rendered message, exactly as a drag would, and let the panel notice (jsdom does
   *  not fire `selectionchange` on its own; every real browser does). */
  function selectMessage(index: number): string {
    const bubble = document.querySelectorAll("#messages .msg")[index]!;
    const range = document.createRange();
    range.selectNodeContents(bubble);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    return sel.toString();
  }

  function pressCopy(target: EventTarget = window): KeyboardEvent {
    const ev = new KeyboardEvent("keydown", { ...COPY, bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    return ev;
  }

  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

  it("copies the selection at EVERY keystroke — the second copy replaces the first", async () => {
    await loadView();
    hostMessage({
      type: "refresh",
      messages: [
        { role: "assistant", content: "first passage", timestamp: 1 },
        { role: "assistant", content: "second passage", timestamp: 2 },
      ],
    });
    const clip = spyClipboard();
    try {
      const first = selectMessage(0);
      const ev1 = pressCopy();
      await settle();
      expect(ev1.defaultPrevented).toBe(true); // the chord is ours, not the host's
      expect(clip.written).toEqual([first]);
      // The selection SURVIVES the copy: it can be repeated, and it is still what the user sees.
      expect(window.getSelection()!.toString()).toBe(first);

      const second = selectMessage(1);
      expect(second).not.toBe(first);
      pressCopy();
      await settle();
      expect(clip.written).toEqual([first, second]); // NOT stuck on the first capture
    } finally {
      clip.restore();
    }
  });

  it("still copies the passage when the caret went back to the prompt (selection collapsed)", async () => {
    // The field bug, exactly: the live DOM selection is gone (a repaint, or the caret returning to
    // the prompt after a `done`), the focus is in the textarea — and the native copy then copies
    // the TEXTAREA's (empty) selection, so the clipboard keeps the previous content for ever.
    await loadView();
    hostMessage({ type: "refresh", messages: [{ role: "assistant", content: "the passage", timestamp: 1 }] });
    const clip = spyClipboard();
    try {
      const passage = selectMessage(0);
      const prompt = document.getElementById("user-input") as HTMLTextAreaElement;
      prompt.focus();
      window.getSelection()!.removeAllRanges(); // Chromium: the textarea owns the selection now
      expect(window.getSelection()!.isCollapsed).toBe(true);

      const ev = pressCopy(prompt);
      await settle();
      // The textarea has NO selection of its own, so the gesture is the transcript's.
      expect(ev.defaultPrevented).toBe(true);
      expect(clip.written).toEqual([passage]);
    } finally {
      clip.restore();
    }
  });

  it("leaves a copy of the PROMPT's own text to the browser", async () => {
    await loadView();
    hostMessage({ type: "refresh", messages: [{ role: "assistant", content: "the passage", timestamp: 1 }] });
    selectMessage(0); // a transcript selection is still around, and must not win
    const clip = spyClipboard();
    try {
      const prompt = document.getElementById("user-input") as HTMLTextAreaElement;
      prompt.value = "typed by the user";
      prompt.focus();
      prompt.setSelectionRange(0, 5);

      const ev = pressCopy(prompt);
      await settle();
      expect(ev.defaultPrevented).toBe(false); // the browser's copy, as in any text field
      expect(clip.written).toEqual([]); // we did not put the transcript on the clipboard
    } finally {
      clip.restore();
    }
  });

  it("does nothing at all when there is no selection anywhere", async () => {
    await loadView();
    hostMessage({ type: "refresh", messages: [{ role: "assistant", content: "the passage", timestamp: 1 }] });
    window.getSelection()!.removeAllRanges();
    const clip = spyClipboard();
    try {
      const ev = pressCopy();
      await settle();
      expect(ev.defaultPrevented).toBe(false);
      expect(clip.written).toEqual([]);
    } finally {
      clip.restore();
    }
  });
});
