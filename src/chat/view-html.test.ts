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

  it("collapsing the control stack hides only the Window/Sampling cards", () => {
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    // The collapsible container exists and is the only thing hidden on collapse.
    expect(html).toContain('id="ctl-cards"');
    expect(html).toMatch(/body\.controls-collapsed\s+#ctl-cards\s*\{\s*display:\s*none/);
    // The collapse arrow is centered and the gap around it is symmetric: 8px
    // above (toggle margin-top; the chat scroller adds no bottom padding of
    // its own anymore) and the same 8px below (the ask card's margin-top).
    expect(html).toMatch(/#ctl-toggle\s*\{[^}]*margin: 8px 10px 0/s);
    expect(html).toMatch(/#messages\s*\{[^}]*padding: 10px 0 0 10px/s);
    // The model card, ask card and metrics must NOT disappear when collapsed.
    expect(html).not.toMatch(/body\.controls-collapsed[^}]*#status/);
    expect(html).not.toMatch(/body\.controls-collapsed[^}]*#metrics/);
  });
});
