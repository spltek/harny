import { describe, it, expect } from "vitest";
import { renderViewHtml } from "./view-html";

const base = {
  cspSource: "vscode-webview://test",
  scriptUri: "https://vscode-resource.test/view.js",
};

/** The declarations of the rule for SELECTOR that ALSO declares DECL.
 *
 *  A selector can own more than one rule — a shared recipe (`.a, .b { … }`) plus a per-site
 *  correction further down — and {@link cssRule} returns the FIRST match, which would make a pin on
 *  the correction test the recipe. This finds the rule that actually carries the declaration. */
function cssRuleWith(html: string, selector: string, decl: string): string {
  const compact = flat(html);
  const key = selector.replace(/\s+/g, " ").trim();
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const members = new RegExp(`(^|[},])\\s*[^,{}]*${escaped}\\s*[,{]`, "g");
  for (const m of compact.matchAll(members)) {
    const open = compact.indexOf("{", m.index + m[0].length - 1);
    const body = compact.slice(open, compact.indexOf("}", open));
    if (body.includes(decl)) return body;
  }
  return "";
}

/** The body of one CSS rule, so an assertion cannot match a DIFFERENT rule that
 * happens to share a property (several elements legitimately use ellipsis).
 *
 * Whitespace is normalised on BOTH sides: the sheet is a real .css file now, so its line
 * breaks and indentation are a formatter's business — a test that pins them breaks for a
 * reason that has nothing to do with the rule. */
function cssRule(html: string, selector: string): string {
  const compact = flat(html);
  const key = selector.replace(/\s+/g, " ").trim();
  // The selector may be a MEMBER of a group (`.a, .b { … }`, `button.off, .a:checked { … }`): the
  // declarations belong to the whole group, so a comma after the key is a match too — otherwise a
  // DRY grouped rule would look like a missing one and push a copy of the declarations into the
  // sheet just to satisfy the pin.
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`${escaped}\\s*[,{]`).exec(compact);
  if (!m) return "";
  const open = compact.indexOf("{", m.index);
  return compact.slice(m.index, compact.indexOf("}", open));
}

/** CSS whitespace collapsed: media/view.css is formatted by prettier, so the line breaks and
 *  the indentation inside a rule are NOT part of what a test pins. Structure, selectors and
 *  declarations are — those survive this. */
function flat(s: string): string {
  return s.replace(/\s+/g, " ");
}

/** One at-rule's own body, braces balanced: `indexOf("}")` stops at the first inner stop of a
 *  keyframes block, which is exactly the part that has to be inspected. */
function blockOf(css: string, at: string): string {
  const start = css.indexOf(at);
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  return css.slice(start);
}

describe("renderViewHtml", () => {
  it("a fold is ONE chevron that ROTATES — no triangle glyphs anywhere", () => {
    // The folds used to swap "▶" for "▼": a filled triangle changes shape and weight as it opens.
    // Now one svg turns, carried by a class — so this pins the mechanism, not just the state.
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], activeId: undefined, config: {} } as never,
    });
    // No swapped glyph anywhere in the page (the Play/Stop keys are CSS-drawn shapes, see their rule).
    expect(html).not.toMatch(/<span[^>]*class="[^"]*toggle[^"]*"[^>]*>\s*[▶▼]/);
    // The toggle carries the same svg, and the OPEN state is a class on it.
    expect(html).toContain('<span class="toggle is-open"><svg');
    expect(html).toContain('class="toggle-chevron"');
    // Closed by default is the RESTING rotation: pointing right — one rule, one svg.
    // (the rules share a selector list, so the slice starts at the selector and ends at the brace)
    const ruleOf = (sel: string): string => {
      const page = flat(html);
      const at = page.indexOf(sel);
      return at < 0 ? "" : page.slice(at, page.indexOf("}", at));
    };
    const chevron = ruleOf(".toggle > .toggle-chevron");
    expect(chevron).toContain("rotate(-90deg)");
    expect(chevron).toContain("transition: transform");
    expect(ruleOf(".toggle.is-open > .toggle-chevron")).toContain("rotate(0deg)");
    // …and the box does not change size: one width, no per-state dimensions.
    const box = cssRule(html, ".toggle, .tool-toggle");
    expect(box).toContain("width: 12px");
    expect(box).not.toMatch(/height:/);
  });
  it("the icons IN TESTA to a bubble are a quarter larger — through a transform, so nothing grows", () => {
    // The marks at the head of a bubble: tool card, thinking, sub-agent, synthetic summary. The size
    // is a TRANSFORM on purpose: `width`/`height` would enter the layout and make the bubble taller,
    // which is exactly what was asked not to happen. 1.5× was too big; 1.25 is the chosen step.
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], activeId: undefined, config: {} } as never,
    });
    const start = html.indexOf(".tool-name > svg,");
    expect(start).toBeGreaterThan(-1);
    const rule = html.slice(start, html.indexOf("}", start));
    expect(rule).toContain("transform: scale(1.25)");
    // All the heads are in the same rule, and every one of them is artwork now: the unknown-tool
    // fallback used to be an EMOJI in a span, which is why this list had a `.tool-emoji` entry.
    // It is an SVG in the same family since media/icons/unknown.svg, so the rule needs no hook
    // for a glyph — and a class-based one would only come back with another emoji.
    expect(rule).not.toContain(".tool-emoji");
    expect(rule).toContain(".thinking-header > svg");
    expect(rule).toContain(".subagent-header .subagent-icon");
    expect(rule).toContain(".synthetic-icon");
    // The mark of a pending message's DELIVERY MODE heads that bubble too (it is the first drawn
    // thing after the fold), so it is in the same rule and not at a size of its own.
    expect(rule).toContain(".pending-msg .pending-mark");
    // …and the LAYOUT is untouched: no width/height in that block.
    expect(rule).not.toMatch(/\bwidth:/);
    expect(rule).not.toMatch(/\bheight:/);
  });

  it("the explanation card floats ABOVE every modal that can carry a `data-tip`", () => {
    // The tips batch replaced every `title` with a card, and the card was left at z-index 60 —
    // below `#compact-settings-modal` (100). That is not "slightly behind": the modal paints a
    // semi-transparent backdrop over the panel, so the explanation of the `Default` button in
    // the compact card was ON SCREEN and unreadable, where the old OS tooltip had worked fine.
    // The pin is the INVARIANT, not the number: read every surface's z-index out of the sheet
    // and fail if one of them can sit above the card.
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], activeId: undefined, config: {} } as never,
    });
    const card = Number(/z-index:\s*(\d+)/.exec(cssRule(html, ".tip"))?.[1]);
    expect(card, "the card declares a z-index").toBeGreaterThan(0);
    const surfaces = [...flat(html).matchAll(/#([a-z-]+-modal)\s*\{[^}]*z-index:\s*(\d+)/g)].map((m) => ({
      id: m[1],
      z: Number(m[2]),
    }));
    expect(surfaces.length, "the modal ladder is found in the sheet").toBeGreaterThan(4);
    const covered = surfaces.filter((s) => s.z >= card);
    expect(covered, "these modals would hide the card: raise `.tip` above them").toEqual([]);
    // …and it must not swallow a click meant for the modal underneath.
    expect(cssRule(html, ".tip")).toContain("pointer-events: none");
  });

  it("a call site may SIZE the slider — it may not repaint it", () => {
    // The sliders are already one control: `input[type="range"]` plus the five engine pseudo-
    // elements, defined once. What was NOT unified was the temptation to restyle at the call site:
    // three blocks carried `accent-color: var(--accent)` (dead, since the thumb is drawn by us and
    // `appearance` is none) plus copies of `height`, `margin`, `cursor` and `:disabled`. This pins
    // the rule that keeps it true: a site rule owns the ROW, never the control.
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], activeId: undefined, config: {} } as never,
    });
    // One appearance, both engines: exactly one rule per part, and nothing per-site.
    for (const part of [
      "::-webkit-slider-runnable-track",
      "::-webkit-slider-thumb",
      "::-moz-range-track",
      "::-moz-range-progress",
      "::-moz-range-thumb",
    ]) {
      expect(html.split(`input[type="range"]${part}`).length - 1).toBe(1);
    }
    // No site paints a slider: no `accent-color` on any range rule, no `appearance` re-declared.
    expect(html).not.toMatch(/input\[type="range"\][^{]*\{[^}]*accent-color/);
    for (const sel of [".num-range", ".lg-range", '.sm-vacuum-slider input[type="range"]']) {
      // Comments are prose (they may NAME the properties this rule refuses to set): stripped first.
      const rule = cssRule(html, sel).replace(/\/\*[\s\S]*?\*\//g, "");
      expect(rule, `${sel} must exist`).not.toBe("");
      expect(rule, `${sel} must not repaint the control`).not.toMatch(
        /accent-color|appearance|background|border-radius|box-shadow|height:|::-webkit/,
      );
    }
    // …and the shared rule still IS the painting (so "unified" is not "deleted").
    expect(cssRule(html, 'input[type="range"]::-webkit-slider-thumb')).toContain("var(--knob-shadow)");
    expect(cssRule(html, 'input[type="range"]::-webkit-slider-runnable-track')).toContain("var(--fill");
  });

  it("every native toggle wears the SAME switch the view builds (one control, two shapes)", () => {
    // `switch.ts` builds the pill as a button; the two static toggles of the markup are native
    // checkboxes (their modules read `.checked`). The class name is therefore written in more than
    // one place, and nothing links them at compile time — the stylesheet answers `:checked` and
    // `aria-checked` with ONE rule, so a typo here would not break the build, only the look. This is
    // the pin, and `switch.test.ts` pins the module's side (createSwitch().className).
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], activeId: undefined, config: {} } as never,
    });
    expect(html).toContain('<input type="checkbox" class="harny-switch" id="mcp-enabled" role="switch"');
    expect(html).toContain('<input type="checkbox" class="harny-switch" id="lg-response" role="switch"');
    // No OTHER checkbox is left in the page: a native tick beside a pill is the drift this ends.
    // Comments are prose (the stylesheet is inlined in this same string and NAMES the markup it
    // dresses), so they are stripped before counting.
    const page = html.replace(/\/\*[\s\S]*?\*\//g, "");
    expect([...page.matchAll(/<input[^>]*type="checkbox"/g)].length).toBe(2);
    for (const m of page.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)) {
      expect(m[0]).toContain('class="harny-switch"');
      expect(m[0]).toContain('role="switch"');
    }
  });

  it("the per-tool switch of the MCP form only PLACES the server pill — it never restyles it", () => {
    // The two controls answer one question ("is this ON in this conversation?"), so they share
    // `.harny-switch` outright. The rule for the popover may position it and NOTHING else: a width,
    // a height or a background here would be a second control wearing the same name — which is
    // exactly what the checkbox it replaced was.
    const html = renderViewHtml({
      ...base,
      state: { sessions: [], openIds: [], messages: [], activeId: undefined, config: {} } as never,
    });
    const rule = cssRule(html, ".mcp-pop-row .harny-switch");
    expect(rule).toContain("margin-top");
    expect(rule).not.toMatch(/width:|height:|background|border-radius|box-shadow:/);
    // …and the old checkbox hook is gone, or a checkbox would still be styled for a row that no
    // longer has one.
    expect(cssRule(html, ".mcp-pop-row input")).toBe("");
  });

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
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
    });
    const label = (id: string) => new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(html)?.[1]?.replace(/&amp;/g, "&").trim();

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

  it("the alert can carry the SAME sliders as the Window/Output card (the model-limits form)", () => {
    // The rows are built by the view (the host decides WHICH numbers to ask for); the
    // CARD must reserve the slot, or the sliders would land outside the dialog and
    // there would be no way to answer except by cancelling.
    const html = renderViewHtml({
      ...base,
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
    });
    expect(html).toContain('<div id="alert-fields" class="alert-fields hidden"></div>');
    // Hidden until the host asks for numbers (a plain alert keeps its old height).
    expect(cssRule(html, "#alert-modal .alert-fields.hidden")).toContain("display: none");
    expect(cssRule(html, "#alert-modal .alert-fields")).toContain("display: flex");
  });

  it("renders the brand mark at SPLASH size, as a design token (not a favicon)", () => {
    const html = renderViewHtml({
      ...base,
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
    });
    // The rem base is the editor font (13px by default), so the old 2.4rem was
    // ~31px — a speck in a 500px+ panel. The size now comes from the size
    // families, so the mark and its tuning live in ONE place (view-config.ts).
    expect(html).toContain("--fs-logo: 6rem"); // ~78px at a 13px base
    // Only the HEIGHT is named, and the width is `auto`: the artwork is the WHOLE logo on a 15:11
    // canvas with its ink touching all four edges, so a square box would hold it with air above
    // and below (a 6rem box drew a 52px-tall mark) and the hero would sit a few pixels low. Same
    // rule as the sign-off beside a bubble: the box takes the file's proportion, it does not
    // impose one.
    expect(flat(html)).toContain(".empty-hero .empty-logo img { width: auto; height: var(--fs-logo)");
  });

  it("lets a pending message be read WHOLE, with its actions pinned top-right", () => {
    const html = renderViewHtml({
      ...base,
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
    });
    // Wrapping replaces the old one-line ellipsis: the user's own line breaks are
    // kept, long tokens break instead of overflowing…
    const pendingText = cssRule(html, ".pending-text");
    expect(pendingText).toContain("white-space: pre-wrap");
    expect(pendingText).toContain("overflow-wrap: anywhere");
    expect(pendingText).not.toContain("text-overflow: ellipsis");
    expect(pendingText).not.toContain("white-space: nowrap");
    expect(pendingText).toContain("line-height: 1.4;");
    // …and NOTHING clips it: the row is always whole. The per-row fold is gone — its state class,
    // its chevron, its quiet variant, its clamp and its mask are all deleted from the stylesheet,
    // not merely left unused (see the module comment in pending-section.ts).
    expect(flat(html)).not.toContain("text-collapsed");
    expect(flat(html)).not.toContain("pending-toggle");
    expect(flat(html)).not.toContain("fold-off");
    expect(flat(html)).not.toContain("mask-image");
    // The commands are the only buttons in the row, so their pill chrome needs no `:not()` guard
    // to keep a bare chevron from wearing it (the guard died with the chevron).
    expect(cssRule(html, ".pending-actions button")).toContain("border: 1px solid var(--border)");
    // The mode's MARK LEADS the row, where a tool call wears its own icon: it is an "in testa"
    // mark, so it takes that family's ink — muted on the row, accent only where the row IS a
    // steer — and one text line tall, so its ink lands on the first line.
    const markCss = cssRule(html, ".pending-mark");
    expect(markCss).toContain("flex: 0 0 auto");
    expect(markCss).toContain("color: var(--muted-2)");
    expect(markCss).toContain("min-height: 1.4em");
    // `inline-flex` is not decoration: the shared 1.25 transform does NOTHING on a plain inline
    // box, and the mark would silently render a quarter smaller than every other head mark.
    expect(markCss).toContain("display: inline-flex");
    expect(cssRule(html, ".pending-msg.pending-steer .pending-mark")).toContain("color: var(--accent)");
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
    // The convert pill is the second pill of the family: uppercase letters like the badge, and its
    // width MEASURED by the same ruler (both directions in one cell), so "→ Queue" and "→ Steer"
    // are the same box and a steer row lines up with a queued one.
    const convertCss = cssRule(html, ".pending-convert");
    expect(convertCss).toContain("text-transform: uppercase");
    expect(convertCss).toContain("display: inline-grid");
    expect(
      cssRuleWith(html, ".mode-pill-sizer, .mode-pill-label, .mode-pill-sizer > span", "grid-area: 1 / 1"),
    ).toContain("grid-area: 1 / 1");
    // The two modes are told apart by TONE, not by hue (the mark keeps the accent).
    expect(flat(html)).toContain(
      ".pending-msg.pending-steer { background: var(--tool-bg); border-color: var(--overlay-3);",
    );
    // The two delivery modes are TWO GREYS, and the order is the point: the steer pill is one step
    // LIGHTER than the queued one (surface-2 vs tool-bg) and so is its edge (overlay-3 vs border),
    // while its bubble steps DOWN to make room for that pill. Both are in the pending block and
    // repeated verbatim by the insert-in hint — the indicator cannot describe a different steer
    // than the row it describes.
    expect(flat(html)).toContain(".pending-msg.pending-steer .pending-badge { background: var(--surface-2);");
    expect(flat(html)).toContain(".pending-badge {");
    expect(cssRule(html, ".pending-badge")).toContain("background: var(--tool-bg)");
  });

  it("makes the queue/steer block a COLLAPSIBLE section, like the sessions list", () => {
    const html = renderViewHtml({
      ...base,
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
    });
    // The header is a row like the sessions one: arrow + label, whole row clickable.
    expect(html).toContain('id="pending-section"');
    expect(html).toContain('id="pending-head" role="button" tabindex="0"');
    // ONE chevron, rotated by a class — no swapped glyphs anywhere (see the fold CSS).
    expect(html).toContain('<span class="toggle is-open">');
    expect(html).toContain('class="toggle-chevron"');
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
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
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
    // The status chip (running… / done) is PINNED to the right edge — it and the abort button are
    // the row's fixed marks — and the goal, the only element that may give way, absorbs the slack:
    // a fan-out then shows its states in one readable column instead of a staircase.
    expect(cssRule(html, ".subagent-status")).toContain("margin-left: auto");
  });

  it("gives the queue/steer badge a box exactly one TEXT LINE tall", () => {
    const html = renderViewHtml({
      ...base,
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
    });
    // Measured in Chromium: with the inherited default line-height the pill came out
    // 14px against a 16.38px text line, and because the row aligns its children
    // to the top (align-items: flex-start) all of the 3px padding ended up below
    // it — 3 above, 5.38 below, on the Steer pill and on the Queue one alike.
    // Matching the line box is what makes the two gaps equal without centring the
    // label in a bubble that can grow to four lines. The badge owns more than one
    // rule (the shared pill recipe + this height), so the pin names the declaration.
    const badge = cssRuleWith(html, ".pending-badge", "line-height:");
    expect(badge).toContain("line-height: calc(var(--fs-md) * 1.4)");
    expect(badge).not.toMatch(/padding:/); // no vertical padding: the line IS the height
    // Steer and Queue are ONE pill of ONE width, and the width is MEASURED, not guessed: a hidden
    // sizer holds BOTH labels stacked in one cell (so it reports the wider one) and shares the
    // visible label's cell, so the box is as wide as that label in whatever font the panel uses.
    expect(cssRule(html, ".mode-pill-label")).toContain("grid-area: 1 / 1");
    expect(cssRuleWith(html, ".mode-pill-sizer", "visibility: hidden")).toContain("display: grid");
    // The FOOTER pill wears the SAME recipe — this is what makes the two widths equal on screen,
    // so a copy of the declarations grown locally in either place fails here.
    const pill = cssRule(html, ".pending-badge, #insert-hint-word");
    expect(pill).toContain("padding: 0 5px");
    expect(pill).toContain("letter-spacing: 0.04em");
    expect(pill).toContain("font-size: var(--fs-sm)");
    expect(pill).toContain("text-transform: uppercase");
    expect(pill).toContain("display: inline-grid");
    expect(cssRuleWith(html, "#insert-hint-word", "height:")).toContain("height: 18px");
    expect(cssRule(html, ".pending-text")).toContain("line-height: 1.4"); // the value the badge mirrors
  });

  it("styles the Tasks block as a scannable list, not a wall of text", () => {
    const html = renderViewHtml({
      ...base,
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
    });
    // The block hangs off the tool header with a rule on the left: it reads as a
    // continuation of the tool, not as another tool.
    const block = cssRule(html, ".todo-block");
    expect(block).toContain("border-left: 2px solid var(--border)");
    expect(block).toContain("padding-left: 8px");
    // The two ways a list like this breaks: the leading box shrinking under a long task, and
    // the text refusing to wrap. Both are pinned here.
    expect(cssRule(html, ".todo-check")).toContain("flex: none");
    const text = cssRule(html, ".todo-text");
    expect(text).toContain("min-width: 0");
    expect(text).toContain("overflow-wrap: anywhere");
    // Rows align to the TOP: a task that wraps to two lines must not push its box
    // down to the middle (the pending-badge lesson, one year of pixel grief ago).
    expect(cssRule(html, ".todo-item")).toContain("align-items: flex-start");
    // The states must be readable without reading: a TICKED green box for done, an accent dot for the
    // running one, nothing inside the box for pending. DONE is BOLD — never struck through (a line
    // across the words is the sign of "deleted", and a finished task is the opposite of that).
    expect(cssRule(html, ".todo-item.status-completed .todo-text")).toContain("font-weight: 600");
    expect(cssRule(html, ".todo-item.status-completed .todo-text")).not.toContain("line-through");
    expect(cssRule(html, ".todo-item.status-completed .todo-check")).toContain("background: var(--ok)");
    expect(cssRule(html, ".todo-item.status-cancelled .todo-text")).toContain("line-through");
    expect(cssRule(html, ".todo-item.status-in_progress .todo-check")).toContain("border-color: var(--accent)");
  });

  it("renders sessions, tabs, messages and input containers", () => {
    const html = renderViewHtml({
      ...base,
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
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
    // "Collapse all" (right side). "Insert prompt in " + the word in a pill. The pill carries a
    // hidden sizer with BOTH labels (see .mode-pill-sizer) — that is what gives it the width of a
    // pending badge — so the visible word is the .mode-pill-label inside it.
    expect(html).toMatch(
      /<div id="ctl-toggle"[^>]*>[\s\S]*?<span id="insert-hint"[^>]*>Insert prompt in <span id="insert-hint-word"><span class="mode-pill-sizer" aria-hidden="true">[\s\S]*?<\/span><span class="mode-pill-label">Queue<\/span><\/span><\/span>/,
    );
    expect(html).toMatch(/id="insert-hint"[\s\S]*?id="ctl-toggle-btn"[\s\S]*?id="collapse-all"/);
    // "Focus" is the THIRD pill of the same strip, and the only one that is a MODE rather than an
    // action: it ships enabled (nothing to disable) and declares its state with aria-pressed, which
    // is what its CSS paints. Order matters — it sits leftmost, next to "Collapse all".
    expect(html).toMatch(
      /<button id="focus-mode" type="button" aria-pressed="false" data-tip="transcript\.focus">Focus<\/button>/,
    );
    expect(html).toMatch(/id="focus-mode"[\s\S]*?id="collapse-all"[\s\S]*?id="autoscroll"/);
    expect(html).not.toMatch(/<button id="focus-mode"[^>]*disabled/);
    // ARMED must not look HOVERED: the two used to be the same pixels (armed was painted with the
    // hover recipe held steady — accent text, accent edge, accent wash), so a pill you had just
    // switched on was indistinguishable from one the pointer rested on. ON wears the panel's LIT
    // recipe instead, the one "Build" and "Parallel" wear: accent gradient, white, halo.
    const armed = cssRule(html, '#transcript-actions > button[aria-pressed="true"]');
    expect(armed).toContain("background: linear-gradient(135deg, var(--accent), var(--accent-strong))");
    expect(armed).toContain("color: #ffffff");
    expect(armed).toContain("0 0 12px var(--accent-glow)");
    const hovered = cssRule(html, "#transcript-actions > button:not(:disabled):hover");
    expect(hovered).toContain("background: var(--accent-surface)");
    expect(armed).not.toBe(hovered);
    // …and the hover half may not take the light away under the pointer: it DEEPENS it (the same
    // move `Parallel` makes) instead of washing back to the unarmed look.
    const armedHover = cssRule(html, '#transcript-actions > button[aria-pressed="true"]:not(:disabled):hover');
    expect(armedHover).toContain("linear-gradient(135deg, var(--accent), var(--accent-strong))");
    expect(armedHover).toContain("0 0 16px var(--accent-glow-strong)");
    expect(armedHover).not.toContain("accent-surface");
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
    // ── THE SHAPE: a plain lozenge, like every other bubble ──
    // The mark hangs OUTSIDE the bubble (below), never cut into its outline: the top-right of a
    // prompt has no rule of its own ANYWHERE — not as a longhand, not as a four-value shorthand
    // (that is the `.msg.user {` pin), not on the harness/checkpoint exclusions. One place owns
    // the shape, and it is `.msg`. (The checkpoint DOES square its bottom corners, to sit flush
    // on what follows — positive pin, pre-existing, bottom-only.)
    expect(html).not.toMatch(/\.msg\.user[^{]*\{[^}]*border-top-right-radius/);
    expect(html).toMatch(/\.msg \{[^}]*border-radius: 8px/);
    expect(html).not.toMatch(/\.msg\.user \{[^}]*border/);
    expect(html).toMatch(/\.msg\.user\.synthetic-summary \{[^}]*border-bottom-right-radius: 0/);
    expect(html).toMatch(/\.msg\.assistant\.synthetic-body \{[^}]*border-top-right-radius: 0/);
    // ── THE SIGN-OFF (the Harny mark beside a typed prompt) ──
    // It hangs OUTSIDE the bubble's right edge, and the bubble pays for the column with a
    // margin: `left: 100%` is what puts it outside, and the margin is the mark plus the gap.
    // Both are the SAME expression as the mark's own size, so mark, gap and column cannot
    // drift apart — a wider mark than its margin would sit on the panel's edge.
    expect(html).toMatch(/\.msg\.user > \.user-avatar \{[^}]*left: 100%/);
    expect(html).toMatch(/\.msg\.user > \.user-avatar \{[^}]*margin-left: 6px/);
    expect(html).toMatch(/\.msg\.user\.has-avatar \{[^}]*margin-right: calc\(var\(--mark-w\) \+ 6px\)/);
    // …and the column is SUBTRACTED from the 92% cap at the same time: `.msg` caps a bubble at 92%
    // of `#messages`, and 92% + the column does not fit in a narrow panel (the logo is 11:15 wide,
    // so the column is wider than the bubble's own padding) — the shortfall would land on the
    // bubble's left, because `align-self: flex-end` aligns the MARGIN box.
    expect(html).toMatch(/\.msg\.user\.has-avatar \{[^}]*max-width: calc\(92% - \(var\(--mark-w\) \+ 6px\)\)/);
    // As tall as the STRAIGHT PART of the bubble's right edge — the vertical run between the two
    // rounded corners — and not as tall as the bubble. The radius is 8px and so is the padding, so
    // that run starts 8px down and lasts one line box on a one-line prompt: `top: 8px` with
    // `height: 1.4em`. That also keeps the mark level with the FIRST line by construction, so a
    // four-line prompt keeps it next to the words instead of floating beside line three. A
    // `top: 50%` would silently re-centre it on the bubble.
    expect(html).toMatch(/\.msg\.user > \.user-avatar \{[^}]*top: 8px/);
    // The WIDTH is 15/11 of that height: the artwork is the whole logo (bubble + answering
    // caret), so the file's canvas is 15:11 and the BOX must be the same shape — a square box
    // letterboxes the drawing, which is how the mark ended up sitting a couple of pixels lower
    // than the line it signs.
    expect(html).toMatch(/\.msg\.user > \.user-avatar \{[^}]*width: var\(--mark-w\)/);
    expect(html).toMatch(/\.msg\.user > \.user-avatar \{[^}]*height: var\(--mark-h\)/);
    // The measure itself is declared ONCE, on the bubble: the height is one line box and the
    // width follows the artwork's canvas. `calc(1.4em * 15 / 11)` used to be written three
    // times (mark, margin, 92% cap), so redrawing at another proportion meant finding all three.
    expect(html).toMatch(/\.msg\.user \{[^}]*--mark-h: 1\.4em/);
    expect(html).toMatch(/\.msg\.user \{[^}]*--mark-w: calc\(var\(--mark-h\) \* 15 \/ 11\)/);
    expect(html).not.toContain("1.4em * 15");
    // …and NOT the whole bubble any more: the 16px of padding is no longer part of the measure.
    expect(html).not.toMatch(/\.msg\.user > \.user-avatar \{[^}]*16px/);
    expect(html).not.toMatch(/\.msg\.user > \.user-avatar \{[^}]*top: 50%/);
    // The svg fills the box the CSS measured for it (the artwork cannot own the size).
    expect(html).toMatch(/\.msg\.user > \.user-avatar > svg \{[^}]*width: 100%/);
    // Decoration: it never takes a click and never joins a text selection.
    expect(html).toMatch(/\.msg\.user > \.user-avatar \{[^}]*pointer-events: none/);
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
    expect(html).toMatch(
      /<button id="compact-btn"[\s\S]*?<span id="compact-threshold-label"[\s\S]*?>Auto 80% ctx · keep 10%<\/span>[\s\S]*?<button id="compact-settings-btn"/,
    );
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
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
    });
    expect(html).toContain('id="model-btn"');
    expect(html).toContain('id="model-btn-label"');
    expect(html).toContain('id="model-modal"');
    expect(html).toContain('id="model-search"');
    expect(html).toContain('id="model-list"');
    // No ✕ in the header: the ONLY close affordance is the footer button — and it says Close,
    // because the picker applies on click, so there is nothing to cancel. Scoped to the MODAL:
    // the panel has other ✕-shaped controls (the find bar's) further down the page.
    expect(html).toContain('id="model-close" class="secondary">Close</button>');
    const modalHtml = html.slice(html.indexOf('id="model-modal"'), html.indexOf('id="model-file"') + 1);
    expect(modalHtml).not.toMatch(/mm-head[\s\S]*?✕/);
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
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
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
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
    });
    expect(html).toContain(">Export models configuration</button>");
    expect(html).toContain(">Import models configuration</button>");
  });

  it("styles the insert-in hint: left slot of the strip, pill word, red on Steer", () => {
    const html = renderViewHtml({
      ...base,
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
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
    // The word lives in a pill, neutral for Queue… — the SHARED mode pill (same recipe as the
    // pending badge, which is what makes the two widths identical: pinned with the badge above).
    const word = cssRuleWith(html, "#insert-hint-word", "height: 18px");
    expect(word).toContain("border: 1px solid var(--border)");
    const recipe = cssRule(html, ".pending-badge, #insert-hint-word");
    expect(recipe).toContain("border-radius: 999px");
    // The quiet grey is QUEUE, the raised one is STEER — the same pairing, in the same order, as
    // the pending bubbles above (`.pending-badge` / `.pending-msg.pending-steer`).
    expect(recipe).toContain("background: var(--tool-bg)");
    expect(recipe).toContain("color: var(--muted)");
    const steer = cssRule(html, "#insert-hint.is-steer #insert-hint-word");
    expect(steer).toContain("background: var(--surface-2)");
    expect(steer).toContain("border-color: var(--overlay-3)");
    expect(steer).toContain("color: var(--fg)");
    // NO red, NO glow: steer is not an alarm, and the roles that painted it are gone from the
    // palette instead of sitting there unused (a dead role with a comment is a lie).
    expect(flat(html)).not.toContain("var(--steer");
    expect(steer).not.toContain("box-shadow");
    // Idle dims it, exactly like the disabled pill it replaced.
    expect(cssRule(html, "#insert-hint.is-idle")).toContain("opacity: 0.45");
    // The old pill's rules are GONE, not just unused.
    expect(html).not.toContain("#steer-btn");
  });

  it("every slider thumb is the SAME sphere as the MCP switch's dot", () => {
    // `accent-color` colours the native thumb but cannot shade it, so the parts are drawn by
    // hand — in both engines, or the slider looks native in one and custom in the other.
    const html = renderViewHtml({
      ...base,
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      } as never,
    });
    for (const sel of ['input[type="range"]::-webkit-slider-thumb', 'input[type="range"]::-moz-range-thumb']) {
      const thumb = cssRule(html, sel);
      // A plain orange circle…
      expect(thumb).toContain("background: var(--accent)");
      // …wearing the SAME shadow as the switch's dot.
      expect(thumb).toContain("box-shadow: var(--knob-shadow)");
      expect(thumb).toContain("border-radius: 50%");
      expect(thumb).toContain("width: 14px");
    }
    // The bar is the thin rounded one, with the ORANGE fill left of the knob…
    const track = cssRule(html, 'input[type="range"]::-webkit-slider-runnable-track');
    expect(track).toContain("height: 4px");
    expect(track).toContain("border-radius: 999px");
    expect(track).toContain("var(--accent) 0 var(--fill, 0%)");
    // …and Firefox draws that same fill with its native progress pseudo-element.
    expect(cssRule(html, 'input[type="range"]::-moz-range-progress')).toContain("background: var(--accent)");
    // Nothing composed: a gradient-on-gradient custom property was dropped as invalid at
    // computed-value time and the ball disappeared, leaving only its rim.
    expect(html).not.toContain("--knob-sphere-accent");
    expect(html).not.toContain("color-mix");
  });

  it("the MCP switch slides its knob, and the track is exactly as tall as it", () => {
    const html = renderViewHtml({
      ...base,
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      } as never,
    });
    const track = cssRule(html, ".harny-switch");
    const knob = cssRule(html, ".harny-switch::after");
    const px = (rule: string, prop: string) => Number(new RegExp(`(?:^|[\\s;])${prop}:\\s*(\\d+)px`).exec(rule)?.[1]);
    // "the seat must be as tall as the knob": no slack above or below it, so the switch reads
    // as one object (14px track with a 10px knob looked like a hobby project).
    expect(px(knob, "height")).toBeGreaterThan(0);
    expect(px(track, "height")).toBe(px(knob, "height"));
    // …which only WORKS if the global `button` rule is neutralized here: `min-height: 1.54rem`
    // wins over `height`, and that is what left the knob sitting at the top of a taller pill
    // with empty space below it.
    expect(track).toContain("min-height: 0");
    expect(track).toContain("padding: 0");
    expect(track).toContain("box-shadow: none"); // no "key" bevel on a switch
    expect(px(track, "width")).toBeGreaterThan(px(knob, "width"));
    expect(knob).toContain("border-radius: 50%");
    // …and the knob travels exactly the leftover track, so nothing pokes out on either side.
    expect(cssRule(html, '.harny-switch[aria-checked="true"]::after')).toContain(
      `translateX(${px(track, "width") - px(knob, "width")}px)`,
    );
    // OFF: a white veil (overlay-3 is white-alpha on the dark theme, black-alpha on paper) and
    // a grey dot — the "disabled" look; ON: accent track + a WHITE sphere (see below).
    expect(track).toContain("background: var(--overlay-3)");
    expect(knob).toContain("background: var(--muted-2)");
    expect(cssRule(html, '.harny-switch[aria-checked="true"]')).toContain("background: var(--accent)");
    const onDot = cssRule(html, '.harny-switch[aria-checked="true"]::after');
    // A LITERAL colour, not a themed role: the dot must look the same on both themes, so no
    // var() it could re-resolve into…
    expect(onDot).not.toContain("var(--bg)");
    // …and it wears the panel's ONE sphere, defined once in :root.
    expect(onDot).toContain("background: var(--knob-sphere)");
    expect(onDot).toContain("box-shadow: var(--knob-shadow)");
    // The sphere itself: white, but NOT flat — the radial gradient (lighter top-left, darker
    // bottom-right) is what makes it read as a tiny ball.
    expect(html).toContain("--knob-sphere: radial-gradient(circle at 34% 30%");
    expect(html).toContain("--knob-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);");
    // The theme-dependent role from an earlier attempt is GONE, not orphaned in the palette.
    expect(html).not.toContain("switch-dot");
    // …and it is visibly unavailable while a run is working.
    expect(cssRule(html, ".harny-switch:disabled")).toContain("opacity: 0.3");
  });

  it("keeps an MCP row on ONE line, so the card cannot change height while you click", () => {
    // The row is rebuilt on every config push and carries an error string that can be a
    // whole npm log: wrapped, it changed the card's height and moved the control stack under
    // the cursor every time a server was toggled.
    const html = renderViewHtml({
      ...base,
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      } as never,
    });
    const detail = cssRule(html, ".mcp-status .mcp-detail");
    expect(detail).toContain("white-space: nowrap");
    expect(detail).toContain("text-overflow: ellipsis");
    expect(detail).toContain("min-width: 0"); // …or flex refuses to shrink it
    expect(cssRule(html, ".mcp-status")).toContain("display: flex");
  });

  it("styles the per-turn metrics badge under assistant bubbles", () => {
    const html = renderViewHtml({
      ...base,
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
    });
    expect(html).toContain(".msg-meta {");
    expect(html).toMatch(/\.msg-meta \{[^}]*flex-shrink: 0/);
    expect(html).toMatch(/\.msg-meta \{[^}]*align-self: flex-start/);
    // The mode chip that leads the badge (see MessageMeta.mode): present, on the same
    // quiet bed as the rest of the line, and ONLY the word "Build" takes the accent —
    // Analyze stays gray, so the orange marks the turns that actually wrote.
    expect(html).toContain(".msg-meta .meta-mode {");
    expect(html).toMatch(/\.msg-meta \.meta-mode \{[^}]*background: var\(--overlay-1\)/);
    expect(html).toMatch(/\.msg-meta \.meta-mode\.build \{[^}]*color: var\(--accent\)/);
    // The colour lives on the WORD only: no rule paints the whole line.
    expect(html).not.toContain(".msg-meta.build {");
    expect(html).toMatch(/\.msg-meta \{[^}]*tabular-nums/);
  });

  it("ships every id the webview looks up in the metrics row (a missing one is a null crash)", () => {
    const html = renderViewHtml({
      ...base,
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
    });
    // view.ts resolves these ONCE at load with `as HTMLSpanElement` and writes to
    // them unconditionally, so the markup and the lookup are a contract.
    for (const id of [
      "met-tokens",
      "met-ctx",
      "met-pct",
      "met-window",
      "met-cache",
      "ctx-bar",
      "compact-btn",
      "compact-threshold-label",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    // The derivation note ("616k/1M") is nested INSIDE the same flex item as the
    // usable value: a wrapping row must never split them ("/1M" alone on a line
    // would be meaningless). Dim and hidden while empty — it explains the number,
    // it must not compete with it.
    expect(html).toMatch(
      /<span class="met"><span id="met-ctx"[^>]*>[^<]*<\/span><span class="met-note" id="met-window"/,
    );
    expect(html).toMatch(/\.met-note \{[^}]*white-space: nowrap/);
    expect(html).toMatch(/#met-window:empty \{\s*display: none/);
  });

  it("the tab strip does not shrink tabs and hides any vertical scrollbar", () => {
    const html = renderViewHtml({
      ...base,
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
    });
    // Horizontal scroll only (no vertical bar on a single-row strip).
    expect(flat(html)).toMatch(/#tabs \{[\s\S]*?overflow-x: auto; overflow-y: hidden/);
    // Tabs keep a readable floor and never shrink (the strip scrolls instead).
    expect(html).toMatch(/\.tab \{[\s\S]*?flex-shrink: 0/);
    expect(html).toMatch(/\.tab \{[\s\S]*?min-width: 5\.5rem/);
    // The label takes the free space so the × lands on the tab's RIGHT edge instead of
    // hugging the end of the name (min-width 0 is what keeps the ellipsis working).
    expect(html).toMatch(/\.tab > span:first-child \{[^}]*flex: 1/);
    expect(html).toMatch(/\.tab > span:first-child \{[^}]*min-width: 0/);
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
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
    });
    expect(html).not.toContain('id="steer-target"');
    expect(html).not.toContain("subagent-steer");
  });

  it("does NOT show the version in the sessions header (kept only in the empty hero)", () => {
    const state = {
      sessions: [],
      openIds: [],
      messages: [],
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
    };
    const withV = renderViewHtml({ ...base, state: { ...state, version: "0.1.0" } });
    expect(withV).not.toContain("harny-version");
    // The version still reaches the webview via the init payload (empty hero).
    expect(withV).toContain('"version":"0.1.0"');
  });

  it("uses ONE gear graphic + size across the cards (sessions, model, compaction, MCP)", () => {
    const html = renderViewHtml({
      ...base,
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
    });
    // All four gear keys share the class and the SAME 14×14 icon.
    expect((html.match(/class="gear-btn"/g) ?? []).length).toBe(4);
    expect(html).toMatch(/id="sessions-gear-btn" class="gear-btn"[^>]*><svg width="14" height="14"/);
    expect(html).toMatch(/id="gear-btn" class="gear-btn"[^>]*><svg width="14" height="14"/);
    expect(html).toMatch(/id="compact-settings-btn" class="gear-btn"[^>]*><svg width="14" height="14"/);
    expect(html).toMatch(/id="mcp-configure" class="gear-btn"[^>]*><svg width="14" height="14"/);
    // One shared rule sizes them; the old one-off (big/small) styles are gone.
    expect(flat(html)).toMatch(/\.gear-btn, #session-head \.gear-btn\s*\{/);
    expect(html).not.toMatch(/#compact-settings-btn\s*\{/);
    expect(html).not.toContain("icon-btn");
  });

  it("keeps the per-sub-agent abort button SQUARE and as tall as the status chip", () => {
    const html = renderViewHtml({
      ...base,
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
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
        config: {
          provider: "openai-compatible",
          model: "deepseek",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
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
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
    });
    expect(html).toMatch(/--font-size: 16px;/);
    // Without a host value it falls back to the UI-font var chain (webviews
    // expose --vscode-font-size but NOT --vscode-editor-font-size).
    const fallback = renderViewHtml({
      ...base,
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
    });
    expect(fallback).toMatch(/--font-size: var\(--vscode-font-size, 13px\);/);
    expect(fallback).not.toMatch(/vscode-editor-font-size/);
  });

  it("defines the streaming pulse and graceful settle animations", () => {
    const html = renderViewHtml({
      ...base,
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
    });
    // Active areas (answer bubble + live thinking block) beat on the SAME 1.2s ease-in-out
    // cadence as the play button — and the beat is COMPOSITED: opacity on an overlay, never a
    // border-color/box-shadow keyframe. Those are paint properties, and a 1.2s infinite paint
    // animation recalculates style 60 times a second for the whole stream (measured on the real
    // stylesheet: 60 recalcs/s and 9.3% of the webview main thread on a 1200-bubble transcript
    // with four working areas, 0% and 0 recalcs once the beat moved to opacity). This is the
    // tripwire against "optimising" the glow back onto the box.
    const beat = blockOf(flat(html), "@keyframes pulse-beat");
    expect(beat).toContain("opacity: 1");
    expect(beat).toContain("opacity: 0.25");
    expect(beat).not.toMatch(/box-shadow|border-color|filter|background|outline/);
    // IN PHASE with the play button (harny-pulse peaks at 0%/100%): the peak (opacity 1) is at
    // 0%/100% and the dim beat at 50% — not inverted.
    expect(beat).toMatch(/0%, 100% \{ opacity: 1; \}/);
    expect(beat).toMatch(/50% \{ opacity: 0\.25; \}/);
    // ONE overlay rule paints every working area: the halo is static there, and the state only
    // anchors it (`position: relative`, or `inset: 0` would resolve against an ancestor).
    expect(flat(html)).toMatch(
      /\.msg\.assistant\.streaming::after,[\s\S]*?\.thinking-block\.streaming::after,[\s\S]*?\.msg\.tool\.subagent\.subagent-running::after \{[^}]*box-shadow: var\(--pulse-glow\)[^}]*animation: pulse-beat 1\.2s ease-in-out infinite/,
    );
    // A pseudo-element takes no inline style, so the phase lock's offset reaches it as a custom
    // property it inherits (see phaseLockPulse).
    expect(flat(html)).toMatch(/animation-delay: var\(--pulse-delay, 0ms\)/);
    expect(html).toMatch(/\.msg\.assistant\.streaming\s*\{[^}]*position:\s*relative/s);
    expect(html).toMatch(/\.thinking-block\.streaming\s*\{[^}]*position:\s*relative/s);
    // …and they SETTLE OUT (fade the halo back) when the stream ends, instead of snapping off.
    expect(html).toMatch(/\.msg\.assistant\.settling\s*\{[^}]*transition\s*:\s*border-color 0\.7s ease/s);
    expect(html).toMatch(/\.thinking-block\.settling\s*\{[^}]*transition\s*:\s*border-color 0\.7s ease/s);
    // The fade lives on the overlay now: `content` must stay declared or the pseudo box would go
    // away at once and take the transition with it.
    expect(html).toMatch(
      /\.msg\.assistant\.settling::after[\s\S]*?\.subagent-settling::after\s*\{[^}]*content: ""[^}]*opacity:\s*0[^}]*transition:\s*opacity 0\.7s ease/s,
    );
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
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
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
    expect(
      cssRule(
        html,
        "#mode-btn.is-agent #mode-btn-icon-analyze,\n    #mode-btn.is-agent #mode-btn-icon-agent,\n    #mode-btn.is-agent .mode-btn-chevron",
      ),
    ).toContain("color: #ffffff");
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
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
    });
    expect(html).toMatch(/\.msg\.tool\.subagent\s*\{/);
    // The status chip is STATIC; the BUBBLE carries the synchronized beat, in its own violet —
    // through the same composited overlay, never a paint keyframe (see the answer bubble above).
    expect(html).not.toMatch(/\.subagent-status\.running\s*\{[^}]*animation/s);
    expect(html).toMatch(/\.msg\.tool\.subagent\.subagent-running\s*\{[^}]*border-color:\s*var\(--violet\)/s);
    expect(flat(html)).toMatch(/\.msg\.tool\.subagent\s*\{[^}]*--pulse-glow: 0 0 14px 1px rgba\(124, 92, 255/);
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
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
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
    // Off must SAY it also drops the tool-call dedup, or "off" would be a half-truth. The words
    // live in the help catalog now (src/i18n/en.help.json), so this checks the WIRING and
    // tips-contract.test.ts checks the sentence.
    expect(html).toMatch(/id="lg-off"[\s\S]{0,40}\/>Off</);
    expect(html).toMatch(/data-tip="lg.level.off"/);
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
    expect(html).toMatch(
      /#lg-toggle\s*\{[^}]*flex-wrap:\s*nowrap[^}]*min-height:\s*var\(--ctl-row[^)]*\)[^}]*align-items:\s*center/,
    );
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
    expect(html).toMatch(
      /\.ctl-cards\s*\{[^}]*max-height:\s*clamp\(6rem, calc\(100vh - 20rem\), 75vh\)[^}]*overflow-y:\s*auto/,
    );
    expect(html).toMatch(/#status\s*\{[^}]*min-height:\s*0/);
    // CHAT FLOOR: the transcript never collapses to zero, however much of the
    // stack is open (a zero-height chat put the pending bubbles and "Working…"
    // right on the tab strip). The squeeze lands on #status, which SCROLLS.
    expect(html).toMatch(/#messages-wrap\s*\{[^}]*min-height:\s*min\(9rem, 22vh\)/);
    expect(html).toMatch(/#status\s*\{[^}]*flex-shrink:\s*1;[^}]*overflow:\s*hidden/);
    // The fixed chrome around it (prompt box, model row, metrics, toggle strip)
    // never shrinks: on a short panel the cards scroll, the prompt does not flatten.
    expect(cssRule(html, "#input-area")).toContain("flex-shrink: 0");
    expect(cssRule(html, "#ctl-toggle")).toContain("flex-shrink: 0");
    // #metrics has several rules (one per state): pin the base one.
    expect(html).toMatch(/\n#metrics\s*\{[^}]*flex-shrink:\s*0/);
    // Narrow panel: ONE column, in DOM order (Window, Sampling, Parallel, Loop Guard).
    // Static CSS fallback; the webview then MEASURES the nowrap sensitivity row
    // and sets the exact column count (1 / 2 / 4) so the text never overflows.
    expect(html).toMatch(
      /@media \(max-width: 30rem\)\s*\{\s*\.ctl-cards\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/,
    );
    expect(html).toMatch(
      /@media \(min-width: 59rem\)\s*\{\s*\.ctl-cards\s*\{\s*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/,
    );
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
    // The VALUE is emitted with the other measured numbers (`:root`), and the sheet reads it
    // as a variable: media/view.css is a static file and cannot compute anything.
    expect(html).toMatch(/--panel-min-width:\s*max\(500px,\s*32rem\)/);
    expect(html).toMatch(/html\s*\{\s*min-width:\s*var\(--panel-min-width\);\s*overflow-x:\s*auto/);
    expect(html).toMatch(/body\s*\{[^}]*min-width:\s*var\(--panel-min-width\)/);
    // The old providers-form flag is gone (moved to the per-session Parallel card).
    expect(html).not.toContain("pe-maxparallel");
  });

  it("collapsing the control stack hides only the Window/Sampling cards", () => {
    const html = renderViewHtml({
      ...base,
      state: {
        sessions: [],
        openIds: [],
        messages: [],
        config: {
          provider: "openai",
          model: "gpt-4o",
          hasKey: true,
          models: [],
          providerModels: [],
          contextWindow: 128000,
        },
      },
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
    // The role must exist in BOTH palettes: it is a colour of its own, not the
    // terracotta of a typed prompt, and the light theme answers it with its own violet.
    expect(html).toMatch(/--summary-msg:\s*var\(--dark-summary-msg\)/);
    expect(html).toMatch(/--dark-summary-msg:\s*#[0-9a-f]{6}/i);
    expect(html).toMatch(/--light-summary-msg:\s*#[0-9a-f]{6}/i);
    expect(html).toMatch(/\.msg\.assistant\.synthetic-body\s*\{[^}]*background:\s*var\(--overlay-1\)/s);
    // …and the ✂ tab that slides up over that header is violet too: an orange tab on a
    // violet card would look like it belongs to another bubble.
    expect(html).toMatch(/\.msg\.user\.synthetic-summary \.truncate-at\s*\{[^}]*background:\s*var\(--summary-msg\)/s);
    // …and the ⎇ tab on an ERROR bubble is made of that bubble: it INHERITS its red wash and
    // red edge instead of keeping the neutral `--surface-2`, which read as a black linguetta
    // stuck on somebody else's bubble. Inheriting (not a repeated rgba) is what keeps the tab
    // and the bubble from ever drifting apart.
    expect(html).toMatch(/\:where\(\.msg\.assistant\.error\) \.branch-at\s*\{[^}]*background-color:\s*inherit/s);
    expect(html).toMatch(/\:where\(\.msg\.assistant\.error\) \.branch-at\s*\{[^}]*border-color:\s*inherit/s);
    // …and it must carry NO specificity of its own: a plain class here would outrank
    // `.branch-at:hover:not(:disabled)` and silently kill the accent repaint on hover.
    expect(html).not.toMatch(/^\.msg\.assistant\.error \.branch-at/m);
    expect(html).toMatch(/\.branch-at:hover:not\(:disabled\)\s*\{[^}]*background:\s*var\(--accent-surface\)/s);
    // For that inherited background to be safe the error bubble's surface must be OPAQUE and
    // come from the PALETTE: the risen tab overlaps the bubble above it, so an inherited alpha
    // would let that bubble show through. A role per theme also means both themes answer it.
    expect(html).toMatch(/\.msg\.assistant\.error\s*\{[^}]*background:\s*var\(--error-bg\)/s);
    expect(html).not.toMatch(/\.msg\.assistant\.error\s*\{[^}]*rgba\(/s);
    expect(html).toMatch(/--dark-error-bg:\s*#[0-9a-f]{6}/i);
    expect(html).toMatch(/--light-error-bg:\s*#[0-9a-f]{6}/i);
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

  it("picks its palette from the editor's theme class, dark as the base, harny.theme able to pin one", () => {
    const state = {
      sessions: [],
      openIds: [],
      messages: [],
      config: {
        provider: "openai",
        model: "gpt-4o",
        hasKey: true,
        models: [],
        providerModels: [],
        contextWindow: 128000,
      },
    };
    const html = renderViewHtml({ ...base, state });

    // Both palettes live in :root, side by side and PREFIXED, so no colour value
    // is ever written twice: the selection below is a plain assignment.
    expect(html).toMatch(/--dark-bg:\s*#111111/i);
    expect(html).toMatch(/--light-bg:\s*#fbfaf9/i);

    // NO theme class (unit tests, or the first paint before VS Code adds its own)
    // is the DARK palette: dark is the base rule, not one branch among two.
    expect(cssRule(html, "body")).toContain("--bg: var(--dark-bg);");
    expect(cssRule(html, "body")).toContain("color-scheme: dark");

    // The editor's own class selects the light palette, and color-scheme rides
    // along so NATIVE widgets (provider <select>, sliders, search fields) flip too.
    const lightRule = cssRule(html, "body.vscode-light, body.vscode-high-contrast-light");
    expect(lightRule).toContain("--bg: var(--light-bg);");
    expect(lightRule).toContain("--accent: var(--light-accent);");
    expect(lightRule).toContain("color-scheme: light");

    // harny.theme must WIN over the editor's class, and both are `body.<class>`:
    // equal specificity, so only SOURCE ORDER decides — the pinned blocks must
    // stay LAST. This is the invariant that makes the setting work at all.
    const lightAt = html.indexOf("body.vscode-light, body.vscode-high-contrast-light");
    expect(html.indexOf("body.theme-dark")).toBeGreaterThan(lightAt);
    expect(html.indexOf("body.theme-light")).toBeGreaterThan(html.indexOf("body.theme-dark"));

    // Pinning emits the class on the body; `auto` emits nothing and leaves the
    // choice to the editor (whose class VS Code swaps live on a theme change).
    expect(renderViewHtml({ ...base, state, theme: "light" })).toMatch(/<body class="controls-collapsed theme-light">/);
    expect(renderViewHtml({ ...base, state, theme: "dark" })).toMatch(/<body class="controls-collapsed theme-dark">/);
    expect(renderViewHtml({ ...base, state, theme: "auto" })).toMatch(/<body class="controls-collapsed">/);
  });
});
