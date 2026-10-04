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
    // The paperclip file picker is the HEAD key of the input row (before the
    // textarea, same row as send/abort) and shares their exact size rule.
    expect(html).toMatch(/id="input-main"[\s\S]*?<button id="attach-btn"/);
    expect(html).toMatch(/<button id="attach-btn"[\s\S]*?id="user-input"/);
    // It shows a PAPERCLIP glyph (attachment), not a bare "+".
    expect(html).toMatch(/<button id="attach-btn"[^>]*>\s*<svg[\s\S]*?<\/svg>\s*<\/button>/);
    expect(html).not.toMatch(/<button id="attach-btn"[^>]*>\s*\+\s*<\/button>/);
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

  it("does NOT show the version in the sessions header (kept only in the empty hero)", () => {
    const state = { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } };
    const withV = renderViewHtml({ ...base, state: { ...state, version: "0.1.0" } });
    expect(withV).not.toContain("harny-version");
    // The version still reaches the webview via the init payload (empty hero).
    expect(withV).toContain('"version":"0.1.0"');
  });

  it("uses ONE gear graphic + size across the cards (sessions, model, compaction, MCP)", () => {
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    // All four gear keys share the class and the SAME 14×14 icon.
    expect((html.match(/class="gear-btn"/g) ?? []).length).toBe(4);
    expect(html).toMatch(/id="sessions-gear-btn" class="gear-btn"[^>]*><svg width="14" height="14"/);
    expect(html).toMatch(/id="gear-btn" class="gear-btn"[^>]*><svg width="14" height="14"/);
    expect(html).toMatch(/id="compact-settings-btn" class="gear-btn"[^>]*><svg width="14" height="14"/);
    expect(html).toMatch(/id="mcp-configure" class="gear-btn"[^>]*><svg width="14" height="14"/);
    // One shared rule sizes them; the old one-off (big/small) styles are gone.
    expect(html).toMatch(/\.gear-btn, #session-head \.gear-btn\s*\{/);
    expect(html).not.toMatch(/#compact-settings-btn\s*\{/);
    expect(html).not.toContain("icon-btn");
  });

  it("keeps the per-sub-agent abort button SQUARE and as tall as the status chip", () => {
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    const block = html.match(/\.subagent-abort\s*\{([^}]*)\}/s);
    expect(block).toBeTruthy();
    const css = block![1];
    expect(css).toMatch(/width:\s*var\(--sa-chip-h\)/);
    expect(css).toMatch(/height:\s*var\(--sa-chip-h\)/);
    expect(css).toMatch(/min-height:\s*var\(--sa-chip-h\)/);
    // Shared height variable defined on the header, used by BOTH the chip
    // (border-box) and the square button so their heights match exactly.
    expect(html).toMatch(/\.subagent-header\s*\{[^}]*--sa-chip-h:\s*1\.3rem/);
    expect(html).toMatch(/\.subagent-status\s*\{[^}]*height:\s*var\(--sa-chip-h\)[^}]*box-sizing:\s*border-box/s);
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
    // The status chip is STATIC; the BUBBLE carries the synchronized pulse.
    expect(html).not.toMatch(/\.subagent-status\.running\s*\{[^}]*animation/s);
    expect(html).toMatch(/\.msg\.tool\.subagent\.subagent-running\s*\{[^}]*animation:\s*stream-border-pulse-violet/s);
    expect(html).toMatch(/@keyframes stream-border-pulse-violet\s*\{[^}]*rgba\(124, 92, 255/s);
    expect(html).toMatch(/\.msg\.tool\.subagent\.subagent-settling\s*\{/);
    expect(html).toMatch(/\.subagent-status\.done\s*\{/);
    expect(html).toMatch(/\.subagent-status\.failed\s*\{/);
    expect(html).toMatch(/\.subagent-goal\s*\{/);
    // Nested live-stream styles.
    expect(html).toMatch(/\.sa-log\s*\{/);
    expect(html).toMatch(/\.sa-thinking\s*\{/);
    expect(html).toMatch(/\.sa-answer\s*\{/);
    expect(html).toMatch(/\.sa-answer code/);
    expect(html).toMatch(/\.sa-answer pre/);
    expect(html).toMatch(/\.subagent-report\s*\{/);
    expect(html).toMatch(/\.sa-tool\.ok\s*\{/);
    // Long content WRAPS at the bubble width instead of overflowing it.
    expect(html).toMatch(/\.msg\s*\{[^}]*min-width:\s*0/s);
    expect(html).toMatch(/\.subagent-goal\s*\{[^}]*overflow-wrap:\s*anywhere/s);
    expect(html).toMatch(/\.tool-args\s*\{[^}]*white-space:\s*pre-wrap[^}]*word-break:\s*break-all/s);
    // The Task/Input block GROWS with the wrapped content (no scrollbar).
    expect(html).not.toMatch(/\.tool-args\s*\{[^}]*max-height/s);
    expect(html).not.toMatch(/\.tool-args\s*\{[^}]*overflow-y/s);
    expect(html).toMatch(/\.subagent-chip\s*\{[^}]*max-width:\s*100%/s);
  });

  it("renders the Parallel + Loop Guard cards side by side in the control stack", () => {
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    // TWO equal cards, side by side (each one grid column, NOT full width).
    expect(html).toContain('<span class="card-title">Parallel</span>');
    expect(html).toContain('<span class="card-title">Loop Guard</span>');
    // Window + Sampling numerics are SLIDERS with a read-only value label (no
    // more text inputs or +/- spinner buttons).
    for (const id of ["ctx-range", "out-range", "samp-range", "presence-range", "freq-range"]) {
      expect(html).toMatch(new RegExp(`type="range" id="${id}"`));
    }
    expect(html).toMatch(/\.num-range\s*\{/);
    // Every LABEL row inside the control cards matches a control row's height,
    // so the left/right columns' controls line up horizontally.
    expect(html).toMatch(/#ctl-cards \.field-label\s*\{[^}]*min-height:\s*var\(--ctl-row\)/);
    expect(html).toMatch(/#ctl-cards\s*\{\s*--ctl-row:\s*1\.4rem/);
    expect(html).not.toContain('id="ctx-input"');
    expect(html).not.toContain('id="samp-input"');
    expect(html).toMatch(/type="range" id="par-range"[\s\S]*?id="par-value"/);
    expect(html).toMatch(/name="thinking-level"[\s\S]*?id="thinking-off"[\s\S]*?id="thinking-high"/);
    expect(html).toMatch(/name="lg-level"[\s\S]*?id="lg-high"[\s\S]*?id="lg-normal"[\s\S]*?id="lg-low"/);
    expect(html).toContain('id="lg-response"');
    // Below the sensitivity row: the editable Loop Guard fields (filled at
    // runtime from the host-provided ranges + presets).
    expect(html).toMatch(/id="lg-fields"[^>]*class="lg-fields"/);
    // The parameters section starts COLLAPSED, toggled by the corner chevron.
    expect(html).toMatch(/id="lg-params-field"/);
    expect(html).toMatch(/id="lg-collapse"[^>]*aria-expanded="false"/);
    expect(html).toMatch(/#lg-params-field\.hidden\s*\{\s*display:\s*none/);
    expect(html).toMatch(/\.lg-range\s*\{/);
    // Neither card spans the full row any more.
    expect(html).not.toMatch(/<span class="card-title">Parallel<\/span>\s*<div class="ctl-controls"/);
    // Skills card: a full-width, initially-hidden card with a chips list.
    expect(html).toMatch(/class="ctl-card ctl-card-wide hidden" id="skills-card"/);
    expect(html).toContain('id="skills-list"');
    expect(html).toMatch(/\.skill-item\s*\{/);
    // MCP card + editor modal.
    expect(html).toMatch(/class="ctl-card ctl-card-wide hidden" id="mcp-card"/);
    expect(html).toMatch(/<button id="mcp-configure" class="gear-btn"/);
    expect(html).toContain('id="mcp-modal"');
    expect(html).toContain('id="mcp-command"');
    expect(html).toMatch(/\.mcp-card\s*\{/);
    // Tool-list popover.
    expect(html).toContain('id="mcp-tools-popover"');
    expect(html).toMatch(/#mcp-tools-popover\.hidden\s*\{\s*display:\s*none/);
    // Slash menu (skill autocomplete).
    expect(html).toContain('id="slash-menu"');
    expect(html).toMatch(/#slash-menu\.hidden\s*\{\s*display:\s*none/);
    // The MCP editor modal starts hidden (it must not open on load).
    expect(html).toMatch(/#mcp-modal\.hidden\s*\{\s*display:\s*none/);
    // Guardrails + Loop Guard are two EQUAL cards, side by side: each is a
    // plain .ctl-card (one grid column of #ctl-cards), so the inner
    // .ctl-controls mirror grid is gone.
    expect(html).not.toContain('class="ctl-controls"');
    // The Loop Guard sensitivity row wraps inside its half-width card and uses
    // the SHARED control-row height so the labels line up across columns.
    expect(html).toMatch(/#lg-toggle\s*\{[^}]*flex-wrap:\s*wrap[^}]*min-height:\s*var\(--ctl-row[^)]*\)[^}]*align-items:\s*center/);
    expect(html).toMatch(/\.ctl-card-wide\s*\{\s*grid-column: 1 \/ -1/);
    // Window + Sampling share the row 50/50 (responsive to resize).
    expect(html).toMatch(/\.ctl-cards\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    // The stack scrolls only past 75% of the panel height, and never so tall
    // that it squeezes the prompt/model/metrics out (the bottom goes last).
    expect(html).toMatch(/\.ctl-cards\s*\{[^}]*max-height:\s*clamp\(6rem, calc\(100vh - 20rem\), 75vh\)[^}]*overflow-y:\s*auto/);
    expect(html).toMatch(/#status\s*\{[^}]*min-height:\s*0/);
    // Narrow panel: ONE column, in DOM order (Window, Sampling, Parallel, Loop Guard).
    expect(html).toMatch(/@media \(max-width: 22rem\)\s*\{\s*\.ctl-cards\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
    // Wide panel: all four cards on ONE line.
    expect(html).toMatch(/@media \(min-width: 48rem\)\s*\{\s*\.ctl-cards\s*\{\s*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
    // The old providers-form flag is gone (moved to the per-session Parallel card).
    expect(html).not.toContain("pe-maxparallel");
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
    // The extra top padding leaves room for the action tabs (⎇/✂) that slide
    // UP out of the first bubble on hover; too little clips them.
    expect(html).toMatch(/#messages\s*\{[^}]*padding: 24px 0 0 10px/s);
    // The branch/cut keys are TOP-RIGHT "tabs" that slide UP out of the bubble
    // on hover (visible instead of blending into the text).
    expect(html).toMatch(/\.branch-at,\s*\.truncate-at\s*\{[^}]*top:\s*0[^}]*right:\s*8px/s);
    // The ✂ tab on the orange user bubble uses the bubble's own orange.
    expect(html).toMatch(/\.truncate-at\s*\{[^}]*background:\s*var\(--user-msg\)/s);
    expect(html).toMatch(/translateY\(-100%\)/);
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
