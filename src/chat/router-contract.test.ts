import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The webview→host MESSAGE CONTRACT, checked against the SOURCE.
 *
 * The boundary is untyped in both directions: the webview writes `postMessage({ type: "x" })`
 * and the provider answers with `switch (msg.type) { case "x": … }`. Nothing in the compiler
 * connects the two strings, so a typo or a forgotten route fails SILENTLY — the click simply
 * does nothing, no error anywhere. This is the cheapest possible guard, and it also keeps the
 * router's inventory honest as it grows (55 cases today).
 *
 * Two directions, because they catch different mistakes:
 *  · every type the webview POSTS must have a route → a new button that goes nowhere;
 *  · every route must be PRODUCIBLE from the webview → dead code left behind by a removed
 *    feature, which is how a router rots.
 *
 * The parsing is text-level on purpose (a real type-checked boundary would be better, but it
 * is a separate refactor): it reads `postMessage(…)` / `post(…)` calls for the first
 * direction, and any quoted literal for the second — some types are built dynamically (the
 * sampler controls share one table, the model modal builds its message in a variable), and a
 * stricter rule there would report false positives.
 */

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

const VIEW = "./webview/view.ts";
const PENDING = "./webview/pending-section.ts";
const ROUTER = "./chat-view.ts";
/**
 * The webview is more than one module now: find and the MCP card were extracted, and THEY post
 * messages too. Scanning only `view.ts` made this test fail the moment a route moved — which is
 * exactly what it should do, and exactly why the list must be complete rather than convenient.
 */
const WEBVIEW_MODULES = [
  "./webview/view.ts",
  "./webview/pending-section.ts",
  "./webview/mcp-card.ts",
  "./webview/mcp-tools-popover.ts",
  "./webview/find.ts",
];

/** Every `type: "X"` inside an object passed to a posting call (`postMessage(...)`/`post(...)`). */
function postedTypes(src: string): Set<string> {
  const out = new Set<string>();
  for (const match of src.matchAll(/\b(postMessage|post)\(/g)) {
    // Brace/paren-match the call instead of regexing the body: the payload can hold nested
    // objects (`data: { … }`), and a `[^}]*` window would stop at their closing brace.
    let i = (match.index ?? 0) + match[0].length;
    let depth = 1;
    const start = i;
    while (i < src.length) {
      const ch = src[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }
    for (const t of src.slice(start, i).matchAll(/type:\s*"([a-zA-Z]+)"/g)) out.add(t[1]);
  }
  return out;
}

/** The `case "X":` labels of the provider's `switch (msg.type)`, which is THE router. */
function handledTypes(src: string): Set<string> {
  const at = src.indexOf("switch (msg.type)");
  expect(at, "the router's `switch (msg.type)` must exist").toBeGreaterThan(-1);
  let i = src.indexOf("{", at);
  let depth = 0;
  const start = i;
  while (i < src.length) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  const out = new Set<string>();
  for (const t of src.slice(start, i).matchAll(/case\s+"([a-zA-Z]+)":/g)) out.add(t[1]);
  return out;
}

const senders = WEBVIEW_MODULES.flatMap((m) => [...postedTypes(source(m))]);
const handled = handledTypes(source(ROUTER));
/** Where a dynamically built type can still appear as a plain literal. */
const webviewSource = WEBVIEW_MODULES.map(source).join("\n");

describe("webview → host message contract", () => {
  it("the parsers BITE: a typo and a dead route are both caught (synthetic sources)", () => {
    // These tests only mean something if the parsers fail when they should. Feeding them
    // known-bad sources is the only way to know — a green run over the real files would
    // look identical with a parser that returns nothing.
    const router = `switch (msg.type) {\n  case "send":\n    break;\n  case "setPendingMode":\n    break;\n  case "deadRoute":\n    break;\n}`;
    const view = [
      `vscode.postMessage({ type: "send" });`,
      `vscode.postMessage({ type: "sendd" });`, // the typo
      `post({ type: "setPendingMode", id });`, // the injected poster of pending-section
    ].join("\n");

    const handledSynthetic = handledTypes(router);
    const posted = [...postedTypes(view)];

    expect(handledSynthetic).toEqual(new Set(["send", "setPendingMode", "deadRoute"]));
    expect(posted).toEqual(["send", "sendd", "setPendingMode"]);
    // The typo is caught by the first direction…
    expect(posted.filter((t) => !handledSynthetic.has(t))).toEqual(["sendd"]);
    // …and the route nobody produces by the second.
    expect([...handledSynthetic].filter((t) => !view.includes(`"${t}"`))).toEqual(["deadRoute"]);
  });

  it("reads a NESTED payload without stopping at the first closing brace", () => {
    // Real payloads carry objects (attachments, diff data). A `[^}]*` regex would read
    // `{ type: "x", data: { … } }` as nothing at all — and the contract test would go quiet.
    const nested = `vscode.postMessage({ type: "send", attachments: [{ name: "a" }], data: { k: 1 } });`;
    expect([...postedTypes(nested)]).toEqual(["send"]);
    const multiline = `vscode.postMessage({\n  type: "switchTab",\n  id,\n});`;
    expect([...postedTypes(multiline)]).toEqual(["switchTab"]);
  });

  it("the parsers find a real router and a real sender set (otherwise these tests prove nothing)", () => {
    // A text-level parser can rot silently. Pin the SHAPE it must see, not an exact count
    // (adding a message must not demand a test edit).
    expect(handled.size).toBeGreaterThanOrEqual(50);
    expect(new Set(senders).size).toBeGreaterThanOrEqual(45);
    for (const known of ["send", "switchTab", "compact", "pickFiles"]) {
      expect(handled.has(known), `${known} must be a route`).toBe(true);
      expect(senders, `${known} must be seen as posted`).toContain(known);
    }
  });

  it("every message the webview posts has a route (a dead button is a silent bug)", () => {
    const unhandled = [...new Set(senders)].filter((t) => !handled.has(t)).sort();
    expect(unhandled, `posted by the webview but NOT routed by the provider: ${unhandled.join(", ")}`).toEqual([]);
  });

  it("every route is producible by the webview (no dead routes left by a removed feature)", () => {
    const orphans = [...handled].filter((t) => !webviewSource.includes(`"${t}"`)).sort();
    expect(orphans, `routed but nothing in the webview produces it: ${orphans.join(", ")}`).toEqual([]);
  });
});
