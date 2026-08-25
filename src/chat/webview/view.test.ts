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
    <div id="session-head"><span class="toggle">▼</span><span>Sessions</span><span class="spacer"></span><button id="new-session">＋</button></div>
    <div id="sessions"></div>
    <div id="tabs"></div>
    <div id="messages"></div>
    <div id="working-bar" class="hidden">● Working...</div>
    <div id="input-area">
      <textarea id="user-input" rows="1"></textarea>
      <button id="send-btn">▶</button>
      <button id="abort-btn" disabled>⏹</button>
    </div>
    <div id="status">AI Model: <select id="model-select"></select><button id="ctx-minus">−</button><input id="ctx-input" type="number" value="128000"><button id="ctx-plus">+</button><button id="out-minus">−</button><input id="out-input" type="number" value="8192"><button id="out-plus">+</button><button id="temp-minus">−</button><input id="temp-input" type="number" placeholder="Auto"><button id="temp-plus">+</button><button id="temp-auto">Auto</button></div>
    <div id="metrics"><select id="thinking-select"><option value="off">Off</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select><span id="met-tokens"></span><span id="met-ctx"></span><span id="met-pct"></span><span id="met-cache"></span><div id="ctx-bar-wrap"><div id="ctx-bar"></div></div><button id="compact-btn">Compact</button></div>
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
    expect((document.getElementById("model-select") as HTMLSelectElement).disabled).toBe(true);
    expect((document.getElementById("ctx-input") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("ctx-minus") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("ctx-plus") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("out-input") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("out-minus") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("out-plus") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("temp-input") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("temp-minus") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("temp-plus") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("temp-auto") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("user-input") as HTMLTextAreaElement).disabled).toBe(true);
    hostMessage({ type: "status", active: false });
    expect((document.getElementById("compact-btn") as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById("model-select") as HTMLSelectElement).disabled).toBe(false);
    expect((document.getElementById("ctx-input") as HTMLInputElement).disabled).toBe(false);
    expect((document.getElementById("out-input") as HTMLInputElement).disabled).toBe(false);
    expect((document.getElementById("temp-input") as HTMLInputElement).disabled).toBe(false);
    expect((document.getElementById("temp-plus") as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById("temp-auto") as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById("user-input") as HTMLTextAreaElement).disabled).toBe(false);
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
    // Thinking is open by default (down arrow) and can be collapsed.
    expect(blocks[0].querySelector(".thinking-body")?.classList.contains("collapsed")).toBe(false);
    (blocks[0].querySelector(".thinking-header") as HTMLElement).click();
    expect(blocks[0].querySelector(".thinking-body")?.classList.contains("collapsed")).toBe(true);
    // The final textual response is the last message.
    const last = (messagesElLastContent() || "").trim();
    expect(last).toBe("fine");
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

    hostMessage({ type: "promptName", mode: "create" });
    expect(modal.classList.contains("hidden")).toBe(false);
    expect(input.value).toBe("New Session");
    input.value = "Cool Project";
    (document.getElementById("name-ok") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "sessionName", mode: "create", name: "Cool Project" });
    expect(modal.classList.contains("hidden")).toBe(true);
  });

  it("rename modal is prefilled and cancel posts cancelNamePrompt", async () => {
    await loadView();
    const modal = document.getElementById("name-modal") as HTMLElement;
    const input = document.getElementById("name-input") as HTMLInputElement;
    hostMessage({ type: "promptName", mode: "rename", id: "a", current: "Old Name" });
    expect(input.value).toBe("Old Name");
    (document.getElementById("name-cancel") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "cancelNamePrompt" });
    expect(modal.classList.contains("hidden")).toBe(true);
  });

  it("Enter submits the modal name, Escape cancels it", async () => {
    await loadView();
    const input = document.getElementById("name-input") as HTMLInputElement;
    const modal = document.getElementById("name-modal") as HTMLElement;
    hostMessage({ type: "promptName", mode: "rename", id: "a", current: "X" });
    input.value = "Entered Name";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(posted).toContainEqual({ type: "sessionName", mode: "rename", id: "a", name: "Entered Name" });
    expect(modal.classList.contains("hidden")).toBe(true);

    hostMessage({ type: "promptName", mode: "create" });
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(posted).toContainEqual({ type: "cancelNamePrompt" });
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

  it("keeps diff colors after a refresh re-render of tool results", async () => {
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
    const add = document.querySelector(".msg.tool .tool-result .diff-add");
    const del = document.querySelector(".msg.tool .tool-result .diff-del");
    expect(add?.textContent).toBe("+new");
    expect(del?.textContent).toBe("-old");
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

  it("colorizes a diff tool result (edit preview) with remove/add classes", async () => {
    await loadView();
    const input = document.getElementById("user-input") as HTMLTextAreaElement;
    input.value = "go";
    (document.getElementById("send-btn") as HTMLButtonElement).click();
    hostMessage({ type: "toolCall", id: "d1", name: "Edit", arguments: { path: "/x" } });
    hostMessage({
      type: "toolResult",
      toolCallId: "d1",
      output: "Diff (+1/-1):\n```diff\n@@ -1,2 +1,2 @@\n-old\n+new\n```",
      isError: false,
    });
    const result = document.querySelector(".msg.tool .tool-result") as HTMLElement;
    expect(result).not.toBeNull();
    const add = result.querySelector(".diff-add");
    const del = result.querySelector(".diff-del");
    const hunk = result.querySelector(".diff-hunk");
    expect(add?.textContent).toBe("+new");
    expect(del?.textContent).toBe("-old");
    expect(hunk?.textContent).toContain("@@");
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

    // Thinking stays as a collapsed block, tool details collapsed, result last.
    const thinking = document.querySelector(".thinking-block .thinking-body") as HTMLElement;
    // Open by default while streaming.
    expect(thinking.classList.contains("collapsed")).toBe(false);
    expect((document.querySelector(".thinking-header .toggle") as HTMLElement).textContent).toBe("▼");
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
    expect(keys[0].textContent).toBe("⎇");
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

describe("temperature control", () => {
  beforeEach(() => { posted.length = 0; setupDom(); });

  it("renders the session value from config and posts changes on typing", async () => {
    await loadView();
    const input = document.getElementById("temp-input") as HTMLInputElement;
    // No session value -> Auto (empty).
    expect(input.value).toBe("");

    hostMessage({ type: "config", config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], temperature: 0.7 } });
    expect(input.value).toBe("0.7");

    input.value = "1.5";
    input.dispatchEvent(new Event("change"));
    expect(posted).toContainEqual({ type: "setTemperature", value: 1.5 });
  });

  it("clamps out-of-range values; empty input and the Auto button reset to Auto", async () => {
    await loadView();
    const input = document.getElementById("temp-input") as HTMLInputElement;
    const auto = document.getElementById("temp-auto") as HTMLButtonElement;

    input.value = "9"; // above max -> clamp to 2
    input.dispatchEvent(new Event("change"));
    expect(posted).toContainEqual({ type: "setTemperature", value: 2 });
    expect(input.value).toBe("2");

    // Empty input = Auto (not sent, clears the session value).
    input.value = "";
    input.dispatchEvent(new Event("change"));
    expect(posted).toContainEqual({ type: "setTemperature", value: null });

    input.value = "0.5";
    input.dispatchEvent(new Event("change"));
    auto.click();
    expect(posted).toContainEqual({ type: "setTemperature", value: null });
    expect(input.value).toBe("");
  });

  it("steps the value with the − / + buttons and clamps at the edges", async () => {
    await loadView();
    hostMessage({ type: "config", config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], temperature: 0.7 } });
    const input = document.getElementById("temp-input") as HTMLInputElement;
    const minus = document.getElementById("temp-minus") as HTMLButtonElement;
    const plus = document.getElementById("temp-plus") as HTMLButtonElement;

    plus.click();
    expect(posted).toContainEqual({ type: "setTemperature", value: 0.8 });
    expect(input.value).toBe("0.8");

    minus.click();
    expect(posted).toContainEqual({ type: "setTemperature", value: 0.7 });

    // From Auto (empty) the minus clamps at 0 instead of going negative.
    (document.getElementById("temp-auto") as HTMLButtonElement).click();
    minus.click();
    expect(posted).toContainEqual({ type: "setTemperature", value: 0 });
    expect(input.value).toBe("0");
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
});

describe("session name modal (unique names)", () => {
  beforeEach(() => { posted.length = 0; setupDom(); });

  it("blocks duplicate names for create and lets unique ones pass", async () => {
    await loadView();
    hostMessage({ type: "promptName", mode: "create" });
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
    expect(posted).toContainEqual({ type: "sessionName", mode: "create", id: undefined, name: "Refactor 2" });
  });

  it("rename keeps its own name valid and Enter cannot bypass a duplicate", async () => {
    await loadView();
    hostMessage({ type: "promptName", mode: "rename", id: "a", current: "Refactor" });
    const input = document.getElementById("name-input") as HTMLInputElement;
    const ok = document.getElementById("name-ok") as HTMLButtonElement;
    // Own current name stays valid (self excluded from the check).
    expect(ok.disabled).toBe(false);
    // Renaming to the OTHER session's name is blocked.
    input.value = "Debug";
    input.dispatchEvent(new Event("input"));
    expect(ok.disabled).toBe(true);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(posted.some((m: any) => m.type === "sessionName")).toBe(false);
  });

  it("defaults a branch to the original name and requires it to be unique", async () => {
    await loadView();
    hostMessage({ type: "promptName", mode: "branch", id: "a", current: "Refactor" });
    const input = document.getElementById("name-input") as HTMLInputElement;
    expect(input.value).toBe("Refactor");
    expect((document.getElementById("name-ok") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("name-modal-title") as HTMLElement).textContent).toBe("Branch session");
  });
});

function messagesElLastUserContent(): string {
  const els = document.querySelectorAll("#messages .msg.user");
  const last = els[els.length - 1];
  return last ? (last.textContent || "") : "";
}
