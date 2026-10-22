import { describe, it, expect } from "vitest";
import { renderViewHtml } from "./view-html";

const base = {
  cspSource: "vscode-webview://test",
  scriptUri: "https://vscode-resource.test/view.js",
};

/** The body of one CSS rule, so an assertion cannot match a DIFFERENT rule that
 * happens to share a property (several elements legitimately use ellipsis). */
function cssRule(html: string, selector: string): string {
  const start = html.indexOf(selector + " {");
  return start < 0 ? "" : html.slice(start, html.indexOf("}", start));
}

describe("renderViewHtml", () => {
  it("every modal footer follows ONE rule: drafts commit, overlays dismiss, prompts name the verb", () => {
    // The rule the modals are held to:
    //  - a modal that edits a DRAFT has a commit (Save) and an abort (Cancel);
    //  - a modal whose content is live, or that only shows something, has Close — a button
    //    called Cancel where nothing can be cancelled is a lie (the model picker applies on
    //    click, so there is nothing to abort);
    //  - a PROMPT or an ACTION names what it will do (Create / Branch / Rename / VACUUM), never
    //    a bare OK. `alert-ok` is the runtime fallback of those prompts.
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    const label = (id: string) =>
      new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(html)?.[1]?.replace(/&amp;/g, "&").trim();

    // DRAFTS — commit + abort.
    expect(label("providers-save")).toBe("Save");
    expect(label("providers-cancel")).toBe("Cancel");
    expect(label("mcp-save")).toBe("Save");
    expect(label("mcp-cancel")).toBe("Cancel");
    expect(label("compact-settings-save")).toBe("Save");
    expect(label("compact-settings-cancel")).toBe("Cancel");

    // DISMISS-ONLY — live content, nothing to abort.
    expect(label("sessions-close")).toBe("Close");
    expect(label("model-close")).toBe("Close");
    expect(label("db-vacuum-close")).toBe("Close");

    // PROMPTS / ACTIONS — a verb.
    expect(label("name-ok")).toBe("Create");
    expect(label("db-vacuum-run")).toContain("VACUUM");

    // No modal offers Cancel unless it also offers a commit.
    for (const prefix of ["providers", "mcp", "compact-settings"]) {
      expect(label(`${prefix}-cancel`)).toBe("Cancel");
      expect(label(`${prefix}-save`)).toBe("Save");
    }
    // …and the live card says so, because every other card in a modal waits for Save.
    expect(html).toMatch(/\.sm-vacuum-live\s*\{[^}]*color:\s*var\(--accent\)/s);
    expect(html).toContain("applies immediately");
  });

  it("renders the brand mark at SPLASH size, as a design token (not a favicon)", () => {
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    // The rem base is the editor font (13px by default), so the old 2.4rem was
    // ~31px — a speck in a 500px+ panel. The size now comes from the size
    // families, so the mark and its tuning live in ONE place (view-config.ts).
    expect(html).toContain("--fs-logo: 6rem"); // ~78px at a 13px base
    expect(html).toContain(".empty-hero .empty-logo img { width: var(--fs-logo); height: var(--fs-logo)");
  });

  it("lets a pending message be read WHOLE, with its actions pinned top-right", () => {
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    // Wrapping replaces the old one-line ellipsis: the user's own line breaks are
    // kept, long tokens break instead of overflowing…
    const pendingText = cssRule(html, ".pending-text");
    expect(pendingText).toContain("white-space: pre-wrap");
    expect(pendingText).toContain("overflow-wrap: anywhere");
    expect(pendingText).not.toContain("text-overflow: ellipsis");
    expect(pendingText).not.toContain("white-space: nowrap");
    expect(pendingText).toContain("line-height: 1.4;");
    // …and the FOLDED row is clipped to exactly that one line, in a way that keeps the
    // measurement possible: `max-height` (NOT `nowrap` + ellipsis, which would report a
    // single line for ever — see pending-fold.ts) and not `display: none`.
    const folded = cssRule(html, ".pending-msg.text-collapsed .pending-text");
    expect(folded).toContain("max-height: 1.4em");
    expect(folded).toContain("overflow: hidden");
    expect(folded).toContain("mask-image");
    expect(folded).not.toContain("nowrap");
    // The previews fold away WITH the text: a closed row is one line, thumbnails too.
    expect(cssRule(html, ".pending-msg.text-collapsed .pending-extras")).toContain("display: none");
    // The fold is a bare chevron like every other toggle in Harny (.tool-toggle), and it
    // is hidden with its SPACE RESERVED, so the commands sit in the same spot on every
    // row instead of moving one row to the next.
    const foldCss = cssRule(html, ".pending-toggle");
    expect(foldCss).toContain("border: none");
    expect(foldCss).toContain("background: transparent");
    expect(cssRule(html, ".pending-toggle.hidden")).toContain("visibility: hidden");
    expect(cssRule(html, ".pending-toggle.hidden")).not.toContain("display: none");
    // The SECTION owns the scroll, so a long queue cannot eat the panel…
    const section = cssRule(html, "#pending-area");
    expect(section).toContain("max-height: 30vh");
    expect(section).toContain("overflow-y: auto");
    // …and the attachments live in the middle column, under the text.
    expect(cssRule(html, ".pending-main")).toContain("flex-direction: column");
    // Actions: one group, pushed to the right, on a row aligned at the TOP (so
    // multi-line text cannot drag the buttons to the middle).
    expect(cssRule(html, ".pending-msg")).toContain("align-items: flex-start");
    expect(cssRule(html, ".pending-actions")).toContain("margin-left: auto");
    expect(cssRule(html, ".pending-convert:hover")).toContain("var(--accent)");
    // The steer/queue colors stay as they were (accent vs neutral).
    expect(html).toContain(".pending-msg.pending-steer { border-color: var(--accent);");
  });

  it("makes the queue/steer block a COLLAPSIBLE section, like the sessions list", () => {
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    // The header is a row like the sessions one: arrow + label, whole row clickable.
    expect(html).toContain('id="pending-section"');
    expect(html).toContain('id="pending-head" role="button" tabindex="0"');
    expect(html).toContain('<span class="toggle">▼</span><span id="pending-head-text">');
    expect(cssRule(html, "#pending-head")).toContain("cursor: pointer");
    expect(html).toContain(".pending-text");
    // The section appears/disappears as a unit (nothing pending = no empty header).
    expect(cssRule(html, "#pending-section.hidden")).toContain("display: none");
    expect(cssRule(html, "#pending-area.hidden")).toContain("display: none");
    // Hidden in the two shell states too (no session / no folder): a stale list
    // must never show without an input area.
    expect(html).toContain("body.no-session #pending-section");
    expect(html).toContain("body.no-workspace #pending-section");
  });

  it("makes the sub-agent GOAL the only element that gives way in its header", () => {
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    // No lower bound: it may shrink to nothing, and the ellipsis travels left with
    // it (a fixed character cut in JS could not know the panel width).
    const goal = cssRule(html, ".subagent-name");
    expect(goal).toContain("min-width: 0");
    expect(goal).toContain("text-overflow: ellipsis");
    expect(goal).toContain("flex: 0 1 auto");
    // Everything else in the header is FIXED, so the shrink can only land on the
    // goal — and the row can never be squeezed by the wrong element.
    expect(cssRule(html, ".subagent-header .tool-name")).toContain("flex: 0 0 auto");
    expect(cssRule(html, ".subagent-role")).toContain("flex: 0 0 auto");
    expect(cssRule(html, ".subagent-status")).toContain("flex-shrink: 0");
    // The status chip (running… / done) FOLLOWS the goal instead of being pinned to
    // the right edge: as the goal shrinks, the chip slides left with it.
    expect(cssRule(html, ".subagent-status")).not.toContain("margin-left: auto");
  });

  it("renders sessions, tabs, messages and input containers", () => {
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    expect(html).toContain('id="sessions"');
    expect(html).toContain('id="tabs"');
    expect(html).toContain('id="messages"');
    expect(html).toContain('id="user-input"');
    // Pending bubbles sit below the transcript; the working bar is the very
    // BOTTOM footer (below the pending bubbles).
    expect(html).toMatch(/id="messages"[\s\S]*?id="pending-area"[\s\S]*?id="working-bar"/);
    expect(html).toContain('id="attach-btn"');
    expect(html).toContain('id="attachment-chips"');
    // The paperclip file picker is the HEAD key of the input row (before the
    // textarea, same row as send/abort) and shares their exact size rule.
    expect(html).toMatch(/id="input-main"[\s\S]*?<button id="attach-btn"/);
    // The Queue/Steer pill is GONE from the model row: mode select → Parallel directly.
    expect(html).not.toContain('id="steer-btn"');
    expect(html).toMatch(/id="mode-select"[\s\S]*?<button type="button" id="parallel-btn"/);
    // The indicator lives in the control-stack strip now: LEFT side, same height as
    // "Collapse all" (right side). "Insert prompt in " + the word in a pill.
    expect(html).toMatch(/<div id="ctl-toggle"[^>]*>[\s\S]*?<span id="insert-hint"[^>]*>Insert prompt in <span id="insert-hint-word">Queue<\/span><\/span>/);
    expect(html).toMatch(/id="insert-hint"[\s\S]*?id="ctl-toggle-btn"[\s\S]*?id="collapse-all"/);
    expect(html).toMatch(/<button id="attach-btn"[\s\S]*?id="user-input"/);
    // It shows a PAPERCLIP glyph (attachment), not a bare "+".
    expect(html).toMatch(/<button id="attach-btn"[^>]*>\s*<svg[\s\S]*?<\/svg>\s*<\/button>/);
    expect(html).not.toMatch(/<button id="attach-btn"[^>]*>\s*\+\s*<\/button>/);
    expect(html).toMatch(/#input-main button\s*\{[^}]*height: 2\.31rem;[\s\S]*?min-width: 2\.77rem/s);
    // User bubbles have a MINIMUM width so the ✂ tab (~26px) never sticks out
    // of a one-character message.
    expect(html).toMatch(/\.msg\.user \{[^}]*min-width: 48px/);
    // The bubble text is centered (a single character sits in the middle of the
    // min-width bubble instead of hugging the left edge) via a shrink-to-fit,
    // LEFT-aligned inner block.
    expect(html).toMatch(/\.msg\.user \{[^}]*text-align: center/);
    expect(html).toMatch(/\.msg\.user > \.user-text \{[^}]*display: inline-block/);
    expect(html).toMatch(/\.msg\.user > \.user-text \{[^}]*text-align: left/);
    // …EXCEPT when the bubble is wide for a reason of its OWN: with an attachment the
    // shrink-to-fit block floats in the middle and the message reads as if it were
    // centred, so the marked bubble gives the text the full width.
    expect(html).toMatch(/\.msg\.user\.has-attachments > \.user-text \{[^}]*display: block/);
    // The preview caption follows the image it belongs to, not the bubble's centring.
    expect(html).toMatch(/\.msg-attach-img \.msg-attach-cap \{[^}]*text-align: left/);
    // Disabled action tabs are hidden even WITHOUT hover (the global
    // `button:disabled` opacity must not leak through during a run).
    expect(html).toMatch(/\.branch-at:disabled,\s*\.truncate-at:disabled \{[^}]*opacity: 0/);
    // The Compact key sits in the stats row, right after the cache indicator.
    expect(html).toMatch(/id="met-cache"[\s\S]*?<button id="compact-btn"/);
    // Its gear (compaction settings) sits right after Compact; the threshold
    // label (compact form: "Auto: <n>% ctx") sits between them; the modal form
    // exists and starts hidden.
    expect(html).toMatch(/<button id="compact-btn"[\s\S]*?<span id="compact-threshold-label"[\s\S]*?>Auto 80% ctx · keep 10%<\/span>[\s\S]*?<button id="compact-settings-btn"/);
    // The policy card carries BOTH knobs and the plan the host will compute.
    expect(html).toMatch(/id="compact-target-input"/);
    expect(html).toMatch(/id="compact-target-auto"/);
    expect(html).toMatch(/id="compact-preview"/);
    expect(html).toMatch(/id="compact-settings-modal"[\s\S]*?id="compact-threshold-input"/);
    expect(html).toMatch(/id="compact-settings-modal" class="hidden"/);
    expect(html).toContain(`<script src="${base.scriptUri}"></script>`);
  });

  it("renders the filterable model modal + selector button (no native <select>)", () => {
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    expect(html).toContain('id="model-btn"');
    expect(html).toContain('id="model-btn-label"');
    expect(html).toContain('id="model-modal"');
    expect(html).toContain('id="model-search"');
    expect(html).toContain('id="model-list"');
    // No ✕ in the header: the ONLY close affordance is the footer button — and it says Close,
    // because the picker applies on click, so there is nothing to cancel.
    expect(html).toContain('id="model-close" class="secondary">Close</button>');
    expect(html).not.toMatch(/mm-head[\s\S]*?✕/);
    // The old native dropdown is gone.
    expect(html).not.toContain('id="model-select"');
    // List rows are plain (no global "key" chrome) and hover is id-scoped.
    expect(html).toMatch(/#model-list \.mm-model:hover \{[^}]*filter: none/);
    // Context + output sit in fixed, RIGHT-aligned grid columns (aligned rows).
    expect(html).toMatch(/#model-list \.mm-model \{[^}]*display: grid/);
    expect(html).toMatch(/\.mm-model \.mm-ctx \{[^}]*text-align: right/);
    // The list is ONE grid and each row is a SUBGRID, so ctx | "out" | value
    // share a width across rows (the widest value) and stay right-aligned.
    expect(html).toMatch(/#model-list \{[^}]*grid-template-columns: 1fr max-content max-content max-content 1.1rem/);
    // Rows pack from the TOP (a grid would otherwise STRETCH the header row and
    // push a single filtered model to the bottom).
    expect(html).toMatch(/#model-list \{[^}]*align-content: start/);
    expect(html).toMatch(/#model-list \.mm-model \{[^}]*grid-template-columns: subgrid/);
  });

  it("masks the API key field and provides a hold-to-reveal eye", () => {
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    // Masked by default (password), with the eye button beside it.
    expect(html).toMatch(/id="pe-apikey" type="password"/);
    expect(html).toContain('id="pe-apikey-reveal"');
    expect(html).toContain('class="pe-eye"');
    // The eye sits INSIDE the field and is a plain key (no 3D chrome).
    expect(html).toMatch(/\.pe-secret \.pe-eye \{[\s\S]*?box-shadow: none/);
    expect(html).toMatch(/\.pe-secret \.pe-eye:hover \{[^}]*filter: none/);
  });

  it("labels the providers-editor export/import clearly", () => {
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    expect(html).toContain(">Export models configuration</button>");
    expect(html).toContain(">Import models configuration</button>");
  });

  it("styles the insert-in hint: left slot of the strip, pill word, red on Steer", () => {
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    // Same slot geometry as #transcript-actions, but on the LEFT: the two pills rows sit at
    // the same height and the strip's centre stays the chevron's.
    const strip = cssRule(html, "#insert-hint");
    expect(strip).toContain("position: absolute");
    expect(strip).toContain("left: 0");
    expect(strip).toContain("height: 18px");
    expect(strip).toContain("pointer-events: none"); // indicator, never a control
    expect(cssRule(html, "#ctl-toggle")).toContain("position: relative");
    expect(cssRule(html, "#transcript-actions")).toContain("right: 0");
    // The word lives in a pill, neutral for Queue…
    const word = cssRule(html, "#insert-hint-word");
    expect(word).toContain("border-radius: 999px");
    expect(word).toContain("background: var(--surface-2)");
    // …and muted red (with its glow) for Steer, the old pill's palette.
    const steer = cssRule(html, "#insert-hint.is-steer #insert-hint-word");
    expect(steer).toContain("linear-gradient(135deg, #b23b3b, #8f2d2d)");
    expect(steer).toContain("color: #ffffff");
    // Idle dims it, exactly like the disabled pill it replaced.
    expect(cssRule(html, "#insert-hint.is-idle")).toContain("opacity: 0.45");
    // The old pill's rules are GONE, not just unused.
    expect(html).not.toContain("#steer-btn");
  });

  it("styles the per-turn metrics badge under assistant bubbles", () => {
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    expect(html).toContain(".msg-meta {");
    expect(html).toMatch(/\.msg-meta \{[^}]*flex-shrink: 0/);
    expect(html).toMatch(/\.msg-meta \{[^}]*align-self: flex-start/);
    // The mode chip that leads the badge (see MessageMeta.mode): present, on the same
    // quiet bed as the rest of the line, and ONLY the word "Build" takes the accent —
    // Analyze stays gray, so the orange marks the turns that actually wrote.
    expect(html).toContain(".msg-meta .meta-mode {");
    expect(html).toMatch(/\.msg-meta \.meta-mode \{[^}]*background: rgba\(255, 255, 255, 0\.06\)/);
    expect(html).toMatch(/\.msg-meta \.meta-mode\.build \{[^}]*color: var\(--accent\)/);
    // The colour lives on the WORD only: no rule paints the whole line.
    expect(html).not.toContain(".msg-meta.build {");
    expect(html).toMatch(/\.msg-meta \{[^}]*tabular-nums/);
  });

  it("ships every id the webview looks up in the metrics row (a missing one is a null crash)", () => {
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    // view.ts resolves these ONCE at load with `as HTMLSpanElement` and writes to
    // them unconditionally, so the markup and the lookup are a contract.
    for (const id of ["met-tokens", "met-ctx", "met-pct", "met-window", "met-cache", "ctx-bar", "compact-btn", "compact-threshold-label"]) {
      expect(html).toContain(`id="${id}"`);
    }
    // The derivation note ("616k/1M") is nested INSIDE the same flex item as the
    // usable value: a wrapping row must never split them ("/1M" alone on a line
    // would be meaningless). Dim and hidden while empty — it explains the number,
    // it must not compete with it.
    expect(html).toMatch(/<span class="met"><span id="met-ctx"[^>]*>[^<]*<\/span><span class="met-note" id="met-window"/);
    expect(html).toMatch(/\.met-note \{[^}]*white-space: nowrap/);
    expect(html).toMatch(/#met-window:empty \{\s*display: none/);
  });

  it("the tab strip does not shrink tabs and hides any vertical scrollbar", () => {
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    // Horizontal scroll only (no vertical bar on a single-row strip).
    expect(html).toMatch(/#tabs \{[\s\S]*?overflow-x: auto; overflow-y: hidden/);
    // Tabs keep a readable floor and never shrink (the strip scrolls instead).
    expect(html).toMatch(/\.tab \{[\s\S]*?flex-shrink: 0/);
    expect(html).toMatch(/\.tab \{[\s\S]*?min-width: 5\.5rem/);
    // A wide markdown table scrolls INSIDE its own frame — the prose wraps, the table does
    // not — and the scrollbar must be VISIBLE: on macOS overlay scrollbars stay invisible
    // until you scroll, so a working scrollable table looked broken.
    expect(html).toMatch(/\.table-scroll \{[\s\S]*?display: block/);
    expect(html).toMatch(/\.table-scroll \{[\s\S]*?width: fit-content/);
    expect(html).toMatch(/\.table-scroll \{[\s\S]*?max-width: 100%/);
    expect(html).toMatch(/\.table-scroll \{[\s\S]*?overflow-x: auto/);
    expect(html).toMatch(/\.table-scroll::-webkit-scrollbar \{[\s\S]*?height: 9px/);
    expect(html).toMatch(/\.table-scroll table \{[\s\S]*?min-width: max-content/);
  });

  it("has NO steer-target affordance (the sub-agent target was removed)", () => {
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    expect(html).not.toContain('id="steer-target"');
    expect(html).not.toContain("subagent-steer");
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

  it("keeps Analyze colourless, paints Build orange, at ONE width for both modes", () => {
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], config: { provider: "openai", model: "gpt-4o", hasKey: true, models: [], providerModels: [], contextWindow: 128000 } },
    });
    // ANALYZE (the quiet default): both icons in the row's muted gray, hover brightens
    // them like the pills next to it.
    expect(cssRule(html, "#mode-btn-icon-analyze, #mode-btn-icon-agent")).toContain("color: var(--muted)");
    expect(html).not.toContain("#mode-btn-icon-analyze { color: var(--accent); }");
    // BUILD: the whole pill goes orange — accent gradient, white label/icon/chevron and
    // a soft glow, the same recipe as #parallel-btn.is-on.
    const build = cssRule(html, "#mode-btn.is-agent");
    expect(build).toContain("linear-gradient(135deg, var(--accent), var(--accent-strong))");
    expect(build).toContain("color: #ffffff");
    expect(cssRule(html, "#mode-btn.is-agent #mode-btn-icon-analyze,\n    #mode-btn.is-agent #mode-btn-icon-agent,\n    #mode-btn.is-agent .mode-btn-chevron")).toContain("color: #ffffff");
    // A dashed pending edge must survive the transparent border.
    expect(cssRule(html, "#mode-btn.is-agent.is-pending")).toContain("border-style: dashed");
    // The menu follows: neutral icons, and the accent marks only WHAT IS SELECTED.
    expect(cssRule(html, ".mode-item svg:not(.mode-check)")).toContain("color: var(--muted)");
    expect(html).not.toContain('.mode-item[data-mode="analyze"] svg');
    expect(html).not.toContain('.mode-item[data-mode="agent"] svg');
    expect(cssRule(html, ".mode-item.is-active .mode-check")).toContain("var(--accent)");
    expect(html).not.toContain('.mode-item[data-mode="agent"].is-active .mode-check');
    // The per-turn badge under an answer: ONLY the word "Build" takes the accent —
    // the line itself stays the badge's quiet gray.
    expect(cssRule(html, ".msg-meta .meta-mode.build")).toContain("color: var(--accent)");
    expect(html).not.toContain(".msg-meta.build {");
    // ONE width: the longest label is reserved by a zero-height ghost, so switching
    // Analyze ⇄ Build cannot move the pill (or the pills beside it).
    const ghost = cssRule(html, "#mode-btn-label::before");
    expect(ghost).toContain('content: "Analyze"');
    expect(ghost).toContain("visibility: hidden");
    expect(ghost).toContain("height: 0");
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
    expect(html).toMatch(
      /name="lg-level"[\s\S]*?id="lg-off"[\s\S]*?id="lg-low"[\s\S]*?id="lg-medium"[\s\S]*?id="lg-high"/,
    );
    // The order is the FEATURE: quietest → loudest, with Off first (the row used to read
    // High/Normal/Low, i.e. backwards). Medium is the default, and the label was renamed.
    expect(html).toMatch(/id="lg-off" value="off"/);
    expect(html).toMatch(/id="lg-low" value="low"/);
    expect(html).toMatch(/id="lg-medium" value="medium" checked/);
    expect(html).toMatch(/id="lg-high" value="high"/);
    expect(html).not.toContain('id="lg-normal"');
    expect(html).not.toContain('value="normal"');
    // Off must SAY it also drops the tool-call dedup, or "off" would be a half-truth.
    expect(html).toMatch(/id="lg-off"[\s\S]{0,40}\/>Off</);
    expect(html).toContain("no tool-call deduplication");
    // Loop Guard OFF dims the parameter block (the sliders stay in place).
    expect(cssRule(html, "#lg-fields.is-off")).toContain("opacity: 0.45");
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
    // The sensitivity row NEVER wraps: Include response stays on the radios' line.
    expect(html).toMatch(/#lg-toggle\s*\{[^}]*flex-wrap:\s*nowrap[^}]*min-height:\s*var\(--ctl-row[^)]*\)[^}]*align-items:\s*center/);
    expect(html).toMatch(/#lg-toggle \.sampler-opt\s*\{\s*white-space:\s*nowrap/);
    // The head row is measured WHOLE (radios + chevron) and the radios may only
    // clip, so the expand chevron can never be pushed out of the card.
    expect(html).toMatch(/id="lg-head"/);
    expect(html).toMatch(/\.lg-head\s*\{[^}]*min-width:\s*0/);
    expect(html).toMatch(/#lg-toggle\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden/);
    expect(html).toMatch(/\.ctl-card-wide\s*\{\s*grid-column: 1 \/ -1/);
    // Window + Sampling share the row 50/50 (responsive to resize).
    expect(html).toMatch(/\.ctl-cards\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    // The stack scrolls only past 75% of the panel height, and never so tall
    // that it squeezes the prompt/model/metrics out (the bottom goes last).
    expect(html).toMatch(/\.ctl-cards\s*\{[^}]*max-height:\s*clamp\(6rem, calc\(100vh - 20rem\), 75vh\)[^}]*overflow-y:\s*auto/);
    expect(html).toMatch(/#status\s*\{[^}]*min-height:\s*0/);
    // Narrow panel: ONE column, in DOM order (Window, Sampling, Parallel, Loop Guard).
    // Static CSS fallback; the webview then MEASURES the nowrap sensitivity row
    // and sets the exact column count (1 / 2 / 4) so the text never overflows.
    expect(html).toMatch(/@media \(max-width: 30rem\)\s*\{\s*\.ctl-cards\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(html).toMatch(/@media \(min-width: 59rem\)\s*\{\s*\.ctl-cards\s*\{\s*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
    // A minimum layout width: past it the panel scrolls horizontally instead of
    // squeezing the controls (the PANEL's minimum is VS Code's, not ours).
    // 450px is the MEASURED minimum, read off a live width readout in a real VS
    // Code panel - the narrowest width at which the prompt placeholder still fits
    // on one line and the control row is not squeezed. 500px is what ships — the
    // reference width the panel is meant to open at — with ~50px (about a ninth) of
    // margin over that measurement. The 32rem part is INDEPENDENT of it: it
    // covers larger editor fonts, where every control grows; headless
    // measurements put that side at ~22.75px per font px plus ~148px of chrome,
    // but they ran ~6% high against the real panel (480px vs the real 450px), so
    // the rem part is the conservative side. With the floor at 500px the rem side
    // takes over past a ~15.6px font (32rem === 500px exactly there).
    // It also clears the control-row overflow (~407px) and the pills reaching the
    // centred ctl-toggle chevron (~379px).
    expect(html).toMatch(/html\s*\{\s*min-width:\s*max\(500px,\s*32rem\);\s*overflow-x:\s*auto/);
    expect(html).toMatch(/body\s*\{[^}]*min-width:\s*max\(500px,\s*32rem\)/);
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
    // The CHECKPOINT (compaction summary) is its OWN colour — violet, not the
    // terracotta of a typed prompt — but only on the HEADER: the summary body stays
    // neutral, because that is the text the reader has to read.
    expect(html).toMatch(/\.msg\.user\.synthetic-summary\s*\{[^}]*background:\s*var\(--summary-msg\)/s);
    expect(html).toMatch(/--summary-msg:\s*#[0-9a-f]{6}/i);
    expect(html).toMatch(/\.msg\.assistant\.synthetic-body\s*\{[^}]*background:\s*rgba\(255,\s*255,\s*255,\s*0\.04\)/s);
    // …and the ✂ tab that slides up over that header is violet too: an orange tab on a
    // violet card would look like it belongs to another bubble.
    expect(html).toMatch(/\.msg\.user\.synthetic-summary \.truncate-at\s*\{[^}]*background:\s*var\(--summary-msg\)/s);
    expect(html).toMatch(/translateY\(-100%\)/);
    // The AI Model row (label + select + gear) lives INSIDE the ask box, just
    // below the prompt (after #input-main, before the chips row) — no longer
    // part of the collapsible block.
    expect(html).toMatch(/id="input-area"[\s\S]*?<div class="ctl-card ctl-card-model">[\s\S]*?id="model-btn"/);
    expect(html).toMatch(/id="input-main"[\s\S]*?<div class="ctl-card ctl-card-model">[\s\S]*?id="attach-row"/);
    expect(html).not.toMatch(/<div id="status">[\s\S]*?<div class="ctl-card ctl-card-model"/);
    // Empty chips row is fully hidden, so the ask box keeps the same 8px
    // internal space at top and bottom (no phantom bottom gap).
    expect(html).toMatch(/#attach-row:has\(#attachment-chips\.hidden\)[\s\S]*?display: none/);
  });
});
