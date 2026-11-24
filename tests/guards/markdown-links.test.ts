import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the INTERNAL links of the Markdown we ship — `](#anchor)`.
 *
 * This is the one kind of link nothing else checks: the target lives in the same file, so no
 * bundler resolves it, no editor warns, and a renamed heading leaves a link that scrolls
 * nowhere. That matters here more than usual, because both of the README's indexes — `Contents`
 * and `Feature index` — are made entirely of them: a rename breaks navigation exactly where a
 * reader is being told where to go, and it breaks it SILENTLY.
 *
 * The guard found a real one on its first run: `documentation/MIGRATIONS.md` pointed at
 * `#sqlite-alter-table-limits`, a heading that exists only in an older wording of that
 * document. Nothing noticed for as long as the file has been there.
 *
 * CHANGELOG.md is deliberately OUT of scope: its headings are release numbers, a historical
 * record that must never be edited — so a link into a past release would be pinned to a heading
 * that cannot be renamed back into agreement.
 */
const FILES = [
  "README.md",
  ...readdirSync(join(process.cwd(), "documentation"))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => join("documentation", f)),
];

/**
 * GitHub's heading anchor, reproduced rather than approximated.
 *
 * The subtle part is the SPACES: they become one hyphen EACH, they do not collapse. `## Analyze &
 * Build` is `#analyze--build` — the `&` is dropped and leaves two spaces behind. A naive
 * `\s+ → -` would produce `#analyze-build`, and this guard would then agree with itself and
 * disagree with GitHub, which is the worst possible way for a link checker to be wrong.
 *
 * Duplicates get `-1`, `-2`, … in document order, because that is what the rendered page does.
 */
function slugify(heading: string, seen: Map<string, number>): string {
  const base = heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "") // inline code keeps its text and loses the backticks
    .replace(/[^\p{L}\p{N}\s_-]/gu, "") // punctuation goes, letters (any script) stay
    .replace(/\s/g, "-");
  const count = seen.get(base);
  seen.set(base, (count ?? 0) + 1);
  return count === undefined ? base : `${base}-${count}`;
}

/** Fenced blocks are skipped on BOTH sides: a heading-looking line or a link inside a code
 *  sample is content, not structure — the README's directory tree is full of both. */
function eachLineOutsideFences(markdown: string, visit: (line: string) => void): void {
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) visit(line);
  }
}

/** Every heading of the file, as the anchor a browser would land on. */
function anchorsOf(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const anchors = new Set<string>();
  eachLineOutsideFences(markdown, (line) => {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) anchors.add(slugify(heading[1], seen));
  });
  return anchors;
}

/** Every `](#anchor)` in the file, stripped to the anchor. */
function linksOf(markdown: string): string[] {
  const links: string[] = [];
  eachLineOutsideFences(markdown, (line) => {
    for (const match of line.matchAll(/\]\(#([^)\s]+)\)/g)) links.push(match[1]);
  });
  return links;
}

describe("internal Markdown links", () => {
  it("every `](#…)` points at a heading that exists in the same file", () => {
    const broken: string[] = [];
    let checked = 0;

    for (const file of FILES) {
      const markdown = readFileSync(join(process.cwd(), file), "utf8");
      const anchors = anchorsOf(markdown);
      for (const link of linksOf(markdown)) {
        checked += 1;
        if (!anchors.has(link)) broken.push(`${file} → #${link}`);
      }
    }

    // The positive half: a guard over an empty set passes forever. If the extraction breaks
    // (a regex change, a file renamed out of the list), the count is what says so.
    expect(checked, "no internal links were found — this guard has gone vacuous").toBeGreaterThan(10);
    expect(broken, "these links point at a heading that no longer exists").toEqual([]);
  });

  it("the slug rules match GitHub's on the two shapes this repo actually uses", () => {
    // Pinned because the whole guard is only as good as this function: an ampersand leaves a
    // double hyphen, and a heading with a dash in it keeps it.
    expect(slugify("Analyze & Build", new Map())).toBe("analyze--build");
    expect(slugify("Parallel: sub-agents", new Map())).toBe("parallel-sub-agents");
    expect(slugify("Renaming / dropping a column — SQLite limits", new Map())).toBe(
      "renaming--dropping-a-column--sqlite-limits",
    );
    expect(slugify("`data-tip` keys", new Map())).toBe("data-tip-keys");

    const seen = new Map<string, number>();
    expect(slugify("Sessions", seen)).toBe("sessions");
    expect(slugify("Sessions", seen)).toBe("sessions-1");
    expect(slugify("Sessions", seen)).toBe("sessions-2");
  });
});
