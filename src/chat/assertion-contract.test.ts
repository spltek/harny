import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A TEST MUST BE ABLE TO FAIL.
 *
 * The new-session test drove the dispatcher with a message nobody handled and asserted only that a
 * tab had NOT been created — true, because nothing at all had happened. The assertion was sound and
 * the test was worthless: an "absence" assertion cannot tell "correctly refused" from "silently
 * dropped".
 *
 * Some tests legitimately assert only absence (a cancelled dialog must change nothing). Those are
 * fine — and they are the ones whose TITLE says so. So the rule this test enforces is not "always
 * assert something positive", which would be wrong; it is: when a test drives the host and every
 * single expectation is a negation, the title must claim an absence too. A title that claims an
 * ACTION while the body only checks that nothing moved is exactly the shape of the bug.
 */

const root = fileURLToPath(new URL("../..", import.meta.url));

/** Titles allowed to assert only absence: they must SAY the absence. `\bnot\b` does not match
 *  "notify", and the words cover the shapes already in the suite (refuses, ignores, cancelled…). */
const ABSENCE_TITLE =
  /\b(nothing|never|not|no|without|refus\w*|ignor\w*|cancel\w*|invalid|unchanged|absent|missing|out-of-range)\b/i;

/** The assertion chains of a body: each `expect(…)` up to the `;` that ends its statement. */
function assertions(body: string): string[] {
  const chains: string[] = [];
  for (const m of body.matchAll(/\bexpect\s*\(/g)) {
    let depth = 0;
    let i = m.index + "expect".length;
    for (; i < body.length; i++) {
      if (body[i] === "(") depth++;
      else if (body[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    const end = body.indexOf(";", i);
    chains.push(body.slice(m.index, end < 0 ? body.length : end));
  }
  return chains;
}

/** True for an expectation that NOTHING happened: `.not.…` or a zero call count. */
const NEGATIVE = /\.not\.|toHaveBeenCalledTimes\(\s*0\s*\)/;

/** The block that follows the `it(` at `from`, or null when the body is not a block
 *  (`it("x", () => expect(…))` has no braces to scope). */
function blockAfter(text: string, from: number): string | null {
  const open = text.indexOf("{", from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      // Skip a whole string literal, so a brace inside text cannot close the block.
      for (i++; i < text.length; i++) {
        if (text[i] === "\\") i++;
        else if (text[i] === c) break;
      }
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(open, i);
    }
  }
  return null;
}

interface Suspect {
  file: string;
  line: number;
  title: string;
}

/** Tests that drive the dispatcher and expect ONLY absence, grouped by whether their title says so. */
function absenceOnlyTests(): Suspect[] {
  const suspects: Suspect[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.endsWith(".test.ts")) continue;
      const text = readFileSync(path, "utf8");
      for (const m of text.matchAll(/\bit\(\s*("(?:[^"\\]|\\.)*"|`[^`]*`)\s*,/g)) {
        const body = blockAfter(text, m.index + m[0].length);
        if (!body || !/\bhandler\(\s*\{/.test(body)) continue;
        const chains = assertions(body);
        if (chains.some((chain) => !NEGATIVE.test(chain))) continue;
        suspects.push({
          file: relative(root, path),
          line: text.slice(0, m.index).split("\n").length,
          title: m[1].slice(1, -1),
        });
      }
    }
  };
  walk(join(root, "src"));
  return suspects;
}

describe("assertion contract: an expectation about absence needs a title about absence", () => {
  const suspects = absenceOnlyTests();

  it("inspected the suite at all", () => {
    // The detector hunts a rare shape: if it stops finding ANY negative-only test, the parsing broke
    // (or the style changed) and its silence would read as a clean bill of health.
    expect(suspects.length).toBeGreaterThan(0);
  });

  it("no test claims an action while asserting only that nothing happened", () => {
    const mislabelled = suspects
      .filter((s) => !ABSENCE_TITLE.test(s.title))
      .map((s) => `${s.file}:${s.line} — "${s.title}" asserts only absence; say so in the title`);
    expect(mislabelled).toEqual([]);
  });
});
