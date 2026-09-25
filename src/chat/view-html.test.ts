import { describe, it, expect } from "vitest";
import { renderViewHtml } from "./view-html";

const base = {
  cspSource: "vscode-webview://test",
  scriptUri: "https://vscode-resource.test/view.js",
};

describe("renderViewHtml", () => {
  it("renders sessions, tabs, messages and input containers", () => {
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    expect(html).toContain('id="sessions"');
    expect(html).toContain('id="tabs"');
    expect(html).toContain('id="messages"');
    expect(html).toContain('id="user-input"');
    expect(html).toContain('id="attach-btn"');
    expect(html).toContain('id="attachment-chips"');
    // The "+" file picker is the HEAD key of the input row (before the
    // textarea, same row as send/abort) and shares their exact size rule.
    expect(html).toMatch(/id="input-main"[\s\S]*?<button id="attach-btn"/);
    expect(html).toMatch(/<button id="attach-btn"[\s\S]*?id="user-input"/);
    expect(html).toMatch(/#input-main button\s*\{[^}]*height: 2\.31rem;[\s\S]*?min-width: 2\.77rem/s);
    // The Compact key sits in the stats row, right after the cache indicator.
    expect(html).toMatch(/id="met-cache"[\s\S]*?<button id="compact-btn"/);
    // Its gear (compaction settings) sits right after Compact; the threshold
    // label sits between them; the modal form exists and starts hidden.
    expect(html).toMatch(/<button id="compact-btn"[\s\S]*?<span id="compact-threshold-label"[\s\S]*?>Auto Compact threshold: 80%<\/span>[\s\S]*?<button id="compact-settings-btn"/);
    expect(html).toMatch(/id="compact-settings-modal"[\s\S]*?id="compact-threshold-input"/);
    expect(html).toMatch(/id="compact-settings-modal" class="hidden"/);
    expect(html).toContain(`<script src="${base.scriptUri}"></script>`);
  });

  it("injects sessions, open ids, active id and messages into the init payload", () => {
    const html = renderViewHtml({
      ...base,
      state: {
        sessions: [{ id: "a", name: "Refactor", createdAt: 1, updatedAt: 2, messageCount: 3 }],
        openIds: ["a"],
        activeId: "a",
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
        config: { provider: "openai-compatible", model: "deepseek", hasKey: true, models: [], providerModels: [], contextWindow: 128000 },
      },
    });
    expect(html).toContain('"activeId":"a"');
    expect(html).toContain('"openIds":["a"]');
    expect(html).toContain('"content":"hello"');
  });

  it("uses the editor font size from the host as the rem root", () => {
    const html = renderViewHtml({
      ...base,
      editorFontSizePx: 16,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    expect(html).toMatch(/--font-size: 16px;/);
    // Without a host value it falls back to the UI-font var chain (webviews
    // expose --vscode-font-size but NOT --vscode-editor-font-size).
    const fallback = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    expect(fallback).toMatch(/--font-size: var\(--vscode-font-size, 13px\);/);
    expect(fallback).not.toMatch(/vscode-editor-font-size/);
  });

  it("defines the streaming pulse and graceful settle animations", () => {
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    // Active areas (answer bubble + live thinking block) pulse with accent
    // edges on the SAME 1.2s ease-in-out cadence as the play button.
    expect(html).toMatch(/@keyframes stream-border-pulse/);
    // IN PHASE with the play button (harny-pulse peaks at 0%/100%): the area
    // pulse must peak (full accent) at 0%/100% and dim at 50% — not inverted.
    expect(html).toMatch(/@keyframes stream-border-pulse[\s\S]*0%, 100% \{\s*border-color: #d95f27/);
    expect(html).toMatch(/@keyframes stream-border-pulse[\s\S]*50% \{\s*border-color: rgba\(217, 95, 39, 0\.4\)/);
    expect(html).toMatch(/\.msg\.assistant\.streaming\s*\{[^}]*animation\s*:\s*stream-border-pulse 1\.2s ease-in-out infinite/s);
    expect(html).toMatch(/\.thinking-block\.streaming\s*\{[^}]*animation\s*:\s*stream-border-pulse 1\.2s ease-in-out infinite/s);
    // …and they SETTLE OUT (fade the border back) when the stream ends,
    // instead of snapping off.
    expect(html).toMatch(/\.msg\.assistant\.settling\s*\{[^}]*transition\s*:\s*border-color 0\.7s ease/s);
    expect(html).toMatch(/\.thinking-block\.settling\s*\{[^}]*transition\s*:\s*border-color 0\.7s ease/s);
    // The multi toggle exists on the AI Model row after the model dropdown,
    // with the press/release (aria-pressed) state.
    // Two modes + the Parallel toggle right after the mode button.
    expect(html).toMatch(/data-mode="analyze"/);
    expect(html).toMatch(/data-mode="agent"/);
    expect(html).toMatch(/id="mode-select"[\s\S]*?<\/div>[\s\S]*?<button type="button" id="parallel-btn"/);
    expect(html).toMatch(/id="parallel-btn"[\s\S]*?aria-pressed="false"[\s\S]*?Parallel/);
  });

  it("styles the sub-agent bubble with its status states", () => {
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    expect(html).toMatch(/\.msg\.tool\.subagent\s*\{/);
    expect(html).toMatch(/\.subagent-status\.running\s*\{[^}]*animation:\s*harny-pulse/s);
    expect(html).toMatch(/\.subagent-status\.done\s*\{/);
    expect(html).toMatch(/\.subagent-status\.failed\s*\{/);
    expect(html).toMatch(/\.subagent-goal\s*\{/);
    // Nested live-stream styles.
    expect(html).toMatch(/\.sa-log\s*\{/);
    expect(html).toMatch(/\.sa-thinking\s*\{/);
    expect(html).toMatch(/\.sa-tool\.ok\s*\{/);
  });

  it("renders the max-parallel sub-agents flag + stepper in the providers form", () => {
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    expect(html).toMatch(/<input type="checkbox" id="pe-maxparallel-enabled"/);
    expect(html).toMatch(/id="pe-maxparallel-minus"[\s\S]*?id="pe-maxparallel-input"[\s\S]*?id="pe-maxparallel-plus"/);
    expect(html).toMatch(/id="pe-maxparallel-input"[\s\S]*?disabled/);
    expect(html).toMatch(/\.providers-settings\s*\{/);
  });

  it("collapsing the control stack hides only the Window/Sampling cards", () => {
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    // The collapsible container exists and is the only thing hidden on collapse.
    expect(html).toContain('id="ctl-cards"');
    expect(html).toMatch(/body\.controls-collapsed\s+#ctl-cards\s*\{\s*display:\s*none/);
    // #status wraps only the collapsible cards (the model row lives in the ask
    // box): it disappears on collapse so the gap to the metrics is a single 8px.
    expect(html).toMatch(/body\.controls-collapsed\s+#status\s*\{\s*display:\s*none/);
    expect(html).toMatch(/body\.controls-collapsed\s+#metrics\s*\{\s*margin-top: 8px/);
    // The ask card and metrics stay visible when collapsed.
    expect(html).not.toMatch(/body\.controls-collapsed[^}]*#input-area/);
    expect(html).not.toMatch(/body\.controls-collapsed[^}]*#metrics[^}]*display:\s*none/);
    // The collapse arrow is centered and the gap around it is symmetric: 8px
    // above (toggle margin-top; the chat scroller adds no bottom padding of
    // its own anymore) and the same 8px below (the ask card's margin-top).
    expect(html).toMatch(/#ctl-toggle\s*\{[^}]*margin: 8px 10px 0/s);
    expect(html).toMatch(/#messages\s*\{[^}]*padding: 10px 0 0 10px/s);
    // The AI Model row (label + select + gear) lives INSIDE the ask box, just
    // below the prompt (after #input-main, before the chips row) — no longer
    // part of the collapsible block.
    expect(html).toMatch(/id="input-area"[\s\S]*?<div class="ctl-card ctl-card-model">[\s\S]*?id="model-select"/);
    expect(html).toMatch(/id="input-main"[\s\S]*?<div class="ctl-card ctl-card-model">[\s\S]*?id="attach-row"/);
    expect(html).not.toMatch(/<div id="status">[\s\S]*?<div class="ctl-card ctl-card-model"/);
    // Empty chips row is fully hidden, so the ask box keeps the same 8px
    // internal space at top and bottom (no phantom bottom gap).
    expect(html).toMatch(/#attach-row:has\(#attachment-chips\.hidden\)[\s\S]*?display: none/);
  });
});
