import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The DOM fixture in `src/chat/webview/view.test.ts` is written BY HAND, and `src/chat/webview/view.ts`
 * resolves its elements at module load with `getElementById(...)!` — a cast that hides the null.
 *
 * So an id that exists in the panel and not in the fixture is not a compile error and not a load
 * error: it is a `null` that surfaces as a `TypeError` in whichever unrelated test first touches
 * that element, pointing at a line with no obvious relation to the missing markup. `#attach-notice`
 * was exactly that. This guard closes the gap by reading both files instead of trusting them:
 *
 *  - the ids `view.ts` resolves by NAME (the ones that can silently be null), and
 *  - the ids the fixture actually contains.
 *
 * It lives here and not next to the fixture for a real reason: the webview project
 * (`tsconfig.webview.json`) has no Node types, so `node:fs` does not compile inside the webview
 * sources — a check that READS files belongs to the guards, which are allowed to.
 */

const ROOT = join(__dirname, "..", "..");
const VIEW = join(ROOT, "src/chat/webview/view.ts");
const TEST = join(ROOT, "src/chat/webview/view.test.ts");

/** Ids a string yields after a `needle` that opens the quote, e.g. `getElementById("x")`. */
function idsAfter(source: string, needle: string): string[] {
  return source
    .split(needle)
    .slice(1)
    .map((rest) => rest.slice(0, rest.indexOf('"')))
    .filter((id) => id.length > 0);
}

/** The fixture markup, sliced out of the test that installs it. */
function fixtureMarkup(): string {
  const source = readFileSync(TEST, "utf-8");
  const opener = "document.body.innerHTML = `";
  const start = source.indexOf(opener);
  expect(start, "the fixture's `document.body.innerHTML` assignment is gone from view.test.ts").toBeGreaterThan(-1);
  const body = source.slice(start + opener.length);
  const end = body.indexOf("`;");
  expect(end).toBeGreaterThan(0);
  return body.slice(0, end);
}

describe("the hand-written DOM fixture", () => {
  it("contains every id view.ts resolves by name", () => {
    const resolved = new Set(idsAfter(readFileSync(VIEW, "utf-8"), 'getElementById("'));
    const markup = fixtureMarkup();
    // A guard that reads nothing proves nothing: the scan has to FIND the markup and the ids.
    expect(markup.length).toBeGreaterThan(2000);
    expect(markup).toContain("<div");
    expect(resolved.size).toBeGreaterThan(150); // a refactor to querySelector("#x") must not empty this

    const present = new Set(idsAfter(markup, 'id="'));
    const missing = [...resolved].filter((id) => !present.has(id)).sort();
    expect(missing, "resolved by view.ts but absent from the fixture in view.test.ts").toEqual([]);
  });
});
