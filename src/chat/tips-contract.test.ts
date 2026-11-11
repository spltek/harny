import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import bundle from "../i18n/en.help.json";
import { tip } from "../i18n";
import { untrustedModeHint } from "../core/agent/workspace-trust";
import { ARGS_ATTR, KEY_ATTR, TIP_ID } from "./webview/tips";

/**
 * THE CONTRACT BETWEEN THE MARKUP AND THE HELP CATALOG.
 *
 * Every explanation in the panel is now ONE mechanism: an element carries `data-tip="<key>"`, and
 * the words live in `src/i18n/en.help.json`. That split has exactly one failure mode that no unit
 * test can see — the two halves drifting apart. A key renamed in the catalog leaves controls that
 * silently say nothing; a key added to an element and never written leaves a card that never
 * opens; a sentence left in a `title="…"` re-introduces the OS tooltip nobody can translate.
 *
 * So this file checks BOTH directions, and the rules that keep the mechanism honest:
 *
 *   markup → catalog   every `data-tip` and every `setTip()` key resolves to real copy
 *   catalog → markup   no orphan entries (an unused key is dead weight in every translation)
 *   placeholders       `{min}`/`{max}` are the only ones, and only where the view supplies them
 *   labels             short and period-free, because they sit in a 10px grid cell
 *   one tooltip        never `title` AND `data-tip` on the same element
 *   no prose           nothing in the chrome writes a sentence into a `title`
 *   wired              `installTips()` is actually called, or every key above is decoration
 *
 * NO `title` ANY MORE. The markup used to keep a handful of live slots (the mode pill, the model,
 * the two footer counters) whose wording changed at runtime; every one of them now holds a KEY on
 * the element and lets `setTip` swap it, so a lock reason and a state change go through the same
 * catalog as the static explanations. What a `title` still carries is DATA — a file path, a goal,
 * a byte count, a tool name — because a value is not an explanation and must never be translated.
 */

const here = new URL(".", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, here), "utf8");

const HTML = read("./view-html.ts");
const VIEW = read("./webview/view.ts");
const CSS = read("../../media/view.css");

const CATALOG = bundle as { tips: Record<string, string>; labels: Record<string, string> };
const TIPS = CATALOG.tips;

/**
 * Live slots that still write prose into a `title`. Empty, and meant to stay so: every state-
 * dependent explanation is a catalog KEY the runtime swaps with setTip (a lock reason, the mode
 * pending, the model in use, the footer counters). An entry here is a regression, not a plan.
 */
const DYNAMIC_TITLE_IDS: string[] = [];

/** Every `.ts` under `src/` that can name a catalog key (tests excluded: they quote copy). */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

const SRC = sources(join(process.cwd(), "src"));
const SOURCE_TEXT = SRC.map((f) => readFileSync(f, "utf8")).join("\n");

/** Every HTML tag the markup writes, with the attributes that belong to THAT element. */
function tags(source: string): { id: string; attrs: string }[] {
  const found: { id: string; attrs: string }[] = [];
  for (const m of source.matchAll(/<([a-zA-Z][\w-]*)([^<>]*)>/g)) {
    const attrs = m[2];
    found.push({ id: /id="([^"]*)"/.exec(attrs)?.[1] ?? "", attrs });
  }
  return found;
}

const TAGS = tags(HTML);
const attr = (attrs: string, name: string): string | null => new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;

/** At least two words: one word is a label (`Rename`), two are an explanation. */
const hasProse = (text: string): boolean => /\S\s+\S/.test(text);

describe("tips: the markup and the catalog cannot drift apart", () => {
  it("every data-tip the markup carries resolves to real copy", () => {
    const keys = TAGS.map((t) => attr(t.attrs, KEY_ATTR)).filter((k): k is string => !!k && !k.includes("${"));
    expect(keys.length, "no control uses the shared card any more").toBeGreaterThan(30);
    for (const key of keys) {
      expect(TIPS, `data-tip="${key}" is not in src/i18n/en.help.json`).toHaveProperty([key]);
      expect(tip(key), `data-tip="${key}" resolves to an empty card`).not.toBe("");
    }
  });

  it("every key passed to setTip() at runtime resolves too", () => {
    // The key can sit behind a ternary (`setTip(hint, isSteer ? "a" : "b")`), so the arguments
    // are read as a window and every literal in it is checked. A computed key (`lg.p.${r.key}`)
    // is skipped here and covered by the placeholder/label rules below.
    const literals = [...SOURCE_TEXT.matchAll(/setTip\(([\s\S]{0,300}?)\)/g)].flatMap((m) =>
      [...m[1].matchAll(/"([a-z][\w.]*)"/g)].map((x) => x[1]),
    );
    const keys = literals.filter((k) => k.includes("."));
    expect(keys.length, "nothing sets a tip at runtime any more").toBeGreaterThan(0);
    for (const key of keys) {
      expect(TIPS, `setTip("${key}") is not in the catalog`).toHaveProperty([key]);
    }
  });

  it("no catalog entry is an orphan (an unused key is dead weight in every translation)", () => {
    // `lg.p.<field>` is the ONE key shape built from data (`lg.p.${r.key}`, from the ranges the
    // host sends), so the literal scan cannot see it. Anything else must be quoted somewhere.
    const dynamic = (key: string): boolean => key.startsWith("lg.p.");
    const orphans = Object.keys(TIPS).filter((key) => !dynamic(key) && !SOURCE_TEXT.includes(`"${key}"`));
    expect(orphans).toEqual([]);
  });

  it("a label exists for every Loop Guard parameter, and it is a LABEL", () => {
    const fields = Object.keys(TIPS).filter((k) => k.startsWith("lg.p."));
    expect(fields.length).toBeGreaterThan(5);
    for (const key of fields) {
      const label = CATALOG.labels[key];
      expect(label, `${key} has a tooltip but no field name (they are rendered together)`).toBeTruthy();
      expect(label.endsWith("."), `${key}: a field label is not a sentence`).toBe(false);
      expect(label.length, `${key}: "${label}" will not fit the field grid`).toBeLessThanOrEqual(16);
      // The NAME is the short form of the same idea: the card must not restate it.
      expect(TIPS[key].startsWith(label), `${key}: the card opens by repeating its own label`).toBe(false);
    }
  });

  it("placeholders are declared vars, and the view supplies every one it promises", () => {
    // A card is a sentence with holes in it: `{window}` alone would render as `{window}`. So every
    // name must be one the view actually passes to setTip/tip — an allowlist, because a typo in a
    // key and a typo in the call site are the same bug when the name is invented on both sides.
    const SUPPLIED = new Set([
      // Loop Guard ranges (buildLgFields)
      "min",
      "max",
      // the lock/policy reasons
      "wanted",
      "running",
      "model",
      "folder",
      "names",
      "name",
      "hidden",
      "total",
      // the footer and the session rows
      "used",
      "window",
      "reserve",
      "usable",
      "cached",
      "saved",
      "written",
      "created",
      "updated",
      // the alert's detected limit (the host reads it off the provider, the catalog writes the words)
      "tokens",
    ]);
    for (const [key, text] of Object.entries(TIPS)) {
      const vars = [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const unknown = vars.filter((v) => !SUPPLIED.has(v));
      expect(unknown, `${key}: the view never supplies ${unknown.join(", ")}`).toEqual([]);
      if (vars.length === 0) continue;
      // The RANGE is the one shape built from data (the host sends the ranges): both ends are
      // always passed together, so a lone {min} would be a card with a visible hole.
      if (key.startsWith("lg.p.")) expect(vars.sort(), `${key}: a range has two ends`).toEqual(["max", "min"]);
      else expect(vars, `${key}: only Loop Guard fields interpolate a range`).not.toContain("min");
    }
  });

  it("the explanation of an alert slider is a KEY, and the host cannot slip in prose", () => {
    // The two sliders of the model-limits alert are the only controls that live ABOVE a modal, and
    // their sentence was the last one written outside the catalog (`AlertField.hint`, painted into
    // an OS `title`). The number is DATA and stays the host's; the words are the catalog's — which
    // is also what lets the card (the topmost layer, above `#alert-modal`) explain them at all.
    const iface = /interface AlertField \{[\s\S]*?\n\}/.exec(VIEW)?.[0] ?? "";
    expect(iface, "AlertField is not found in the view").toBeTruthy();
    expect(iface, "a prose `hint` is back: a sentence the catalog cannot see").not.toMatch(/\bhint\??:/);
    expect(iface).toContain("hintKey?: string");
    expect(iface).toContain("hintArgs?: Vars");
    // Every key the HOST sends resolves (the literal scan above reads the view, not the host).
    const sent = [...SOURCE_TEXT.matchAll(/hintKey:([^,\n]*)/g)].flatMap((m) =>
      [...m[1].matchAll(/"([\w.]+)"/g)].map((x) => x[1]),
    );
    expect(sent.length, "the alert stopped carrying keys").toBeGreaterThan(1);
    for (const key of sent) {
      expect(TIPS, `hintKey "${key}" is not in the catalog`).toHaveProperty([key]);
      // A key that promises `{tokens}` must get one: the host builds it, and a missing argument is
      // a `{tokens}` printed in the card.
      const vars = [...TIPS[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      if (!vars.length) continue;
      expect(vars, `${key}: only the detected limit interpolates`).toEqual(["tokens"]);
      expect(SOURCE_TEXT, `${key} promises {tokens} and no call site supplies it`).toMatch(/tokens: /);
    }
    // …and the two "unknown" cases are separate keys: they explain different quantities.
    expect(new Set(sent).size, "one key cannot say two different things").toBe(3);
  });

  it("no element carries both a title and a data-tip (one question, one answer)", () => {
    const both = TAGS.filter((t) => attr(t.attrs, KEY_ATTR) && attr(t.attrs, "title"));
    expect(both.map((t) => t.id)).toEqual([]);
  });

  it("the elements that carry data-tip are the ones the panel explains", () => {
    // A cheap fingerprint of the migration: if a refactor drops the attributes wholesale, the
    // checks above pass vacuously (nothing to resolve, nothing to mismatch).
    for (const id of [
      "attach-btn",
      "compact-btn",
      "find-close",
      "insert-hint",
      "lg-collapse",
      "mcp-configure",
      "new-session",
    ]) {
      const tag = TAGS.find((t) => t.id === id);
      expect(tag, `#${id} vanished from the markup`).toBeTruthy();
      expect(attr(tag!.attrs, KEY_ATTR), `#${id} lost its explanation`).toBeTruthy();
    }
  });

  it("the markup carries no prose title at all (every explanation is a key)", () => {
    /** The two mode items have no id, so their slot is named after the mode they select. */
    const locate = (t: { id: string; attrs: string }): string =>
      t.id || (attr(t.attrs, "data-mode") ? `mode:${attr(t.attrs, "data-mode")}` : "<no id>");
    const prose = TAGS.filter((t) => {
      const title = attr(t.attrs, "title");
      // `${…}` is a value the markup does not know yet: a data slot, not prose.
      return !!title && !title.includes("${") && hasProse(title);
    });
    // Bidirectional: an id added to the list, or a title migrated without shrinking it, fails.
    expect(prose.map(locate).sort()).toEqual(DYNAMIC_TITLE_IDS.slice().sort());
  });

  it("the card is in the markup under the id the module looks for", () => {
    const card = TAGS.find((t) => t.id === TIP_ID);
    expect(card, `no #${TIP_ID} element: installTips() would install nothing`).toBeTruthy();
    expect(attr(card!.attrs, "role")).toBe("tooltip");
    // Hidden until asked, or it would paint over the panel on load.
    expect(attr(card!.attrs, "class")).toContain("hidden");
    // Args travel URL-encoded, so the module's attribute name must be one the CSS/markup know.
    expect(ARGS_ATTR).toBe("data-tip-args");
  });

  it("the card is actually installed, or every key above is decoration", () => {
    expect(VIEW).toContain("installTips()");
  });

  it("no webview module writes prose into a title (one question, one answer)", () => {
    // `view.ts` carried the chrome; the editors next to it carried the same habit. The scan reads
    // the WHOLE right-hand side of every `.title = …;` — a ternary or a concatenation is exactly
    // how the last few hid — and only skips templates, whose `${…}` is data the module cannot know
    // (`${name}`, `${path}`): a name in a tooltip is a value, not an explanation.
    const offenders: string[] = [];
    for (const file of SRC.map((f) => readFileSync(f, "utf8"))) {
      for (const stmt of file.matchAll(/\.title =([^;]*);/g)) {
        for (const literal of stmt[1].matchAll(/"([^"]*)"|`([^`]*)`/g)) {
          const text = literal[1] ?? literal[2] ?? "";
          if (hasProse(text) && !text.includes("${")) offenders.push(text);
        }
      }
    }
    expect(offenders, "these titles belong in src/i18n/en.help.json, behind setTip()").toEqual([]);
  });

  it("a title assigned from a local variable is checked too (the copy cannot hide behind a name)", () => {
    // `const why = cond ? "…" : "…"; el.title = why;` is how the last prose titles survived the
    // scan above: the assignment holds an IDENTIFIER, so there is no literal on that line. The
    // variable's own initialiser is read instead, to its first `;`.
    const INDIRECT_OK = new Set<string>([
      // The session/tab/file names a row displays: DATA from the host, never translated.
      "name",
    ]);
    const offenders: string[] = [];
    let seen = 0;
    for (const file of SRC.map((f) => readFileSync(f, "utf8"))) {
      for (const stmt of file.matchAll(/\.title\s*=\s*([A-Za-z_$][\w$]*)\s*;/g)) {
        const name = stmt[1];
        seen++;
        if (INDIRECT_OK.has(name)) continue;
        const init = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*([\\s\\S]{0,400}?);`).exec(file)?.[1] ?? "";
        for (const literal of init.matchAll(/"([^"]*)"|'([^']*)'/g)) {
          const text = literal[1] ?? literal[2] ?? "";
          if (hasProse(text)) offenders.push(`${name}: ${text}`);
        }
      }
    }
    expect(seen, "no indirect title assignment is left to check: this scan has gone stale").toBeGreaterThan(0);
    expect(offenders, "this title is built from prose: a catalog key behind setTip() instead").toEqual([]);
  });

  it("the lock reasons are keys, and every declared one resolves", () => {
    // A locked control answers "why?" — that answer is the one thing that must not be a static
    // attribute, because it depends on the snapshot. `LOCKS` therefore returns KEYS.
    const locks = VIEW.slice(VIEW.indexOf("const LOCKS"), VIEW.indexOf("function applyLocks"));
    expect(locks).toMatch(/tip: \(_?s, locked\) =>/);
    // The reason shown while locked is a DIFFERENT key from the one in the markup: a card that
    // silently kept "Configure providers & models" on a disabled gear would be a half-truth.
    expect(locks).toContain('"locked.gear"');
    expect(locks).toContain('"locked.mcp"');
    // …and the table is what actually writes it: a rule without an applier is documentation.
    expect(VIEW.slice(VIEW.indexOf("function applyLocks"), VIEW.indexOf("function applyWorkingLock"))).toContain(
      "setTip(rule.el, rule.tip(snap, locked))",
    );
  });

  it("the host's Restricted Mode hint and the card say the same sentence", () => {
    // Two layers need this text: the host puts it in the error, the panel in the card. Copying it
    // is fine; letting the copies drift is not — a user reading one and acting on the other would
    // be told two different things about the same folder.
    expect(TIPS["mode.untrusted"]).toBe(untrustedModeHint());
  });

  it("a parameter's NAME is the target, and only inert text asks for a help cursor", () => {
    // The card belongs to the title of a parameter, not to the slider under it: hovering the field
    // lights the name (the Loop Guard fields, generalized) and the name is what the pointer hovers.
    expect(CSS).toContain(".field:hover > .field-label[data-tip]");
    expect(CSS).toContain(".lg-field:hover .lg-name");
    // NO underline on hover: a dotted line under static text read as a link, and it made the whole
    // panel shimmer on every pass of the pointer.
    expect(CSS).not.toContain("text-decoration: underline dotted");
    expect(CSS).not.toMatch(/\[data-tip\]:hover/);
    // `cursor: help` on a button erases the click affordance: it is opt-in per element.
    expect(CSS).toContain('[data-tip][data-tip-cursor="help"]');
  });

  it("the cursor is decided in ONE place — the module that attaches the tip, never the markup", () => {
    // Which pointer an element shows is a fact about what the element IS (text asks, a control
    // points), and `tips.ts` reads it off the element itself. Hand-writing the attribute at a call
    // site is how the panel ended up with the question mark on some labels and not on the values
    // beside them: a `data-tip` added later would silently miss it again.
    const offenders = SRC.filter(
      // The generated stylesheet carries the selector itself; `tips.ts` is the module that decides.
      (f) => !f.endsWith("webview/tips.ts") && !f.endsWith("view-css.ts"),
    ).filter((f) => readFileSync(f, "utf8").includes("data-tip-cursor"));
    expect(offenders, "let setTip() decide the cursor").toEqual([]);
    expect(readFileSync(join(process.cwd(), "src/chat/webview/tips.ts"), "utf8")).toContain(
      'el.setAttribute(CURSOR_ATTR, "help")',
    );
  });

  it("interactive help is ONE switch, and exactly ONE element outlives it", () => {
    // Off, the panel explains nothing at all — no card, no question mark, no name lighting up.
    // The exception is the switch that turns it back on: a switch that also went mute would be a
    // trap with no way out. That exception is an ATTRIBUTE, so it is visible where it is granted,
    // and there is exactly one of them: a second `data-tip-always` would quietly reopen the whole
    // panel to a mode the user just switched off.
    const always = tags(SOURCE_TEXT).filter((t) => t.attrs.includes("data-tip-always"));
    expect(always.map((t) => t.id)).toEqual(["help-toggle"]);
    // A switch that can be GREYED OUT cannot turn help back on: it has to stay a live button.
    expect(always[0].attrs).toContain("aria-pressed");
    expect(always[0].attrs).not.toContain("disabled");
    // The CSS is what actually holds the line: every question mark and every advertising label is
    // gated behind the class the switch writes, so OFF means OFF for elements nobody remembered to
    // loop over (a section rendered later, a value that gains a card tomorrow).
    expect(CSS).toContain('body.help-on [data-tip][data-tip-cursor="help"]');
    expect(CSS).toContain("body.help-on .field:hover > .field-label[data-tip]");
    // …and `tips.ts` is what refuses to show the card, in both ways in (pointer and keyboard).
    const tips = readFileSync(join(process.cwd(), "src/chat/webview/tips.ts"), "utf8");
    expect(tips.match(/!mayExplain\(anchor\)/g)).toHaveLength(2);
  });
});
