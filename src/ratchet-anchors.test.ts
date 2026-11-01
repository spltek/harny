import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the SURGICAL ratchets — the two configs that mutate a line RANGE instead of a whole
 * file (`src/chat/webview/view.ts`, `src/chat/chat-view.ts`), because both files are far too
 * large to mutate whole and the two hunks under them are the ones a field report paid for.
 *
 * A range is the one thing a config cannot verify on its own: Stryker mutates whatever sits
 * between `start` and `end`, so if lines are inserted above the hunk the range slides onto
 * SOMETHING ELSE, finds no mutable code, reports "no mutants found" and **exits 0**. That is
 * the silent pass this file exists to make loud — the anchors below are the exact statements
 * the floors were measured on, so a slide fails the suite instead of quietly ratcheting
 * nothing.
 */
const ROOT = process.cwd();

/** The statements each measured range must still cover. */
const ANCHORS: Record<string, string[]> = {
  "src/chat/webview/view.ts": [
    'case "textDelta": {',
    "currentRawText += msg.content;",
    "if (!currentRawText.trim()) break;",
    "if (currentThinkingBlock) clearThinkingBlock();",
    "const resultEl = ensureResult();",
  ],
  "src/chat/chat-view.ts": [
    "private refreshTranscript(rt: SessionRuntime",
    "const live = rt.engine.projection();",
    "streaming: rt.agent.streaming,",
    "liveThinking: live.thinking",
  ],
};

type Hunk = { file: string; start: number; end: number; config: string };

/** Every `<file>:<start>-<end>` entry of every Stryker config in the repo root. */
function rangedHunks(): Hunk[] {
  const hunks: Hunk[] = [];
  for (const name of readdirSync(ROOT).filter((f) => /^stryker.*\.conf\.json$/.test(f))) {
    const conf = JSON.parse(readFileSync(join(ROOT, name), "utf8")) as { mutate?: string[] };
    for (const entry of conf.mutate ?? []) {
      const m = /^(.+):(\d+)-(\d+)$/.exec(entry);
      if (!m) continue;
      hunks.push({ file: m[1], start: Number(m[2]), end: Number(m[3]), config: name });
    }
  }
  return hunks;
}

describe("mutation ratchet anchors", () => {
  const hunks = rangedHunks();

  it("finds the surgical ratchets (a config deleted is a ratchet lost)", () => {
    expect(hunks.map((h) => h.file).sort()).toEqual(Object.keys(ANCHORS).sort());
  });

  it("every range still points at CODE, not at blank lines or comments", () => {
    // An empty range is the silent pass: Stryker finds no mutant and exits 0, so the floor
    // stops being a floor without a single red test.
    for (const hunk of hunks) {
      const lines = readFileSync(join(ROOT, hunk.file), "utf8")
        .split("\n")
        .slice(hunk.start - 1, hunk.end);
      const code = lines.filter((l) => l.trim() && !l.trim().startsWith("//"));
      expect(code.length, `${hunk.config} → ${hunk.file}:${hunk.start}-${hunk.end}`).toBeGreaterThan(3);
    }
  });

  it("every range still covers the statements its floor was measured on", () => {
    for (const hunk of hunks) {
      const slice = readFileSync(join(ROOT, hunk.file), "utf8")
        .split("\n")
        .slice(hunk.start - 1, hunk.end)
        .join("\n");
      for (const anchor of ANCHORS[hunk.file] ?? []) {
        expect(slice, `${hunk.config}: the range no longer covers \`${anchor}\` — move it, do not delete it`).toContain(
          anchor,
        );
      }
    }
  });

  it("no ratchet config is born disarmed", () => {
    // `break: 0` MEASURES (that is `npm run mutate`, on purpose). A range config exists to
    // fail, so a floor of 0 there is a config whose result nobody will ever read.
    for (const hunk of hunks) {
      const conf = JSON.parse(readFileSync(join(ROOT, hunk.config), "utf8")) as {
        thresholds?: { break?: number };
      };
      expect(conf.thresholds?.break ?? 0, hunk.config).toBeGreaterThan(0);
    }
  });
});
