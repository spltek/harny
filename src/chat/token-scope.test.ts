import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * THE COLOUR OF CODE HAS TWO HALVES, and this file is the only place that can see both.
 *
 * The engine (`highlight.ts`) emits `<span class="token …">` and knows NOTHING about where that
 * markup lands; the stylesheet paints those spans and knows nothing about who emits them. A surface
 * that opts into the engine but not into the sheet renders PERFECT tokens in the inherited colour —
 * which looks exactly like "no highlighting" and passes every other test in this repo (the DOM
 * assertions only check that `.token` exists, and it does). The reverse half is worse: a container
 * named in the sheet that nothing produces is dead CSS that hides the next rename.
 *
 * So the scope list is pinned in both directions, and the one door that may tokenize is pinned too:
 * a third path calling `Prism.highlight` directly would skip the budget and the "no language, no
 * colour" rule that the whole feature rests on.
 */

const root = process.cwd();
const sheet = readFileSync(join(root, "media/view.css"), "utf8");

/** The containers the sheet colours: the argument list of the `:is(…) .token` base rule. */
function scopedContainers(): string[] {
  const line = sheet
    .split("\n")
    .find((l: string) => l.trimStart().startsWith(":is(") && l.trimEnd().endsWith(".token {"));
  const list = /:is\(([^)]+)\)/.exec(line ?? "")?.[1];
  expect(list, "the token scope rule is gone from media/view.css").toBeTruthy();
  return list!
    .split(",")
    .map((s) => s.trim().replace(/^\./, ""))
    .sort();
}

/** Every .ts under src/chat (the webview's own tree), repo-relative. */
function chatSources(dir = join(root, "src/chat"), out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) chatSources(path, out);
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

const sources = chatSources().filter((path) => !path.endsWith(".test.ts"));

describe("the token scope (engine ↔ stylesheet)", () => {
  it("colours EXACTLY the four code surfaces, and says so in one list", () => {
    // Adding a surface is a deliberate act: it lands here, in the sheet, and in a test that shows
    // it really receives tokens. Removing one fails just as loudly.
    expect(scopedContainers()).toEqual(["code-block", "fd-body", "tool-args", "tool-result"]);
  });

  it("every container it colours is really PRODUCED by the view", () => {
    // The reverse direction: a class in the scope list that no source writes is dead CSS, and a
    // class renamed in the view while the sheet keeps the old name is a surface that silently
    // loses its colours.
    for (const container of scopedContainers()) {
      const owners = sources.filter((path) => readFileSync(path, "utf8").includes(`"${container}`));
      expect(owners, `nothing writes the "${container}" container`).not.toEqual([]);
    }
  });

  it("tokenizes through ONE door: no module calls Prism.highlight on its own", () => {
    // `highlight.ts` is the budget, the "unknown language stays plain" rule and the text-identity
    // promise. `view.ts` is the one exception, and only for the DIFF (which tokenizes line by line,
    // with the +/- prefix kept out of the tokenizer — see `populateToolDiff`).
    const callers = sources
      .filter((path) => readFileSync(path, "utf8").includes("Prism.highlight"))
      .map((path) => path.slice(root.length + 1).replace(/\\/g, "/"))
      .sort();
    expect(callers).toEqual(["src/chat/webview/highlight.ts", "src/chat/webview/view.ts"]);
  });

  it("the tool Input is JSON in every tool, so its language is never guessed", () => {
    // The one surface whose colours need no heuristic: `formatArgs` stringifies the arguments, so
    // every bubble's Input has the same language. Pinned because a "smarter" per-tool language
    // would be exactly the guessing the feature refuses to do.
    const view = readFileSync(join(root, "src/chat/webview/view.ts"), "utf8");
    expect(view).toContain('highlightToHtml(argsText, "json")');
  });
});
