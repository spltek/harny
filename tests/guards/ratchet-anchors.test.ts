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
/** The matrices live in `tests/mutation/` — one folder, so the root stays a manifest and not a config dump. */
const CONFIGS = join(ROOT, "tests", "mutation");

/** The statements each measured range must still cover. */
const ANCHORS: Record<string, string[]> = {
  "src/chat/webview/view.ts": [
    // the streaming block (one range per file is not a rule: this file carries several)
    'case "textDelta": {',
    "currentRawText += msg.content;",
    "if (!currentRawText.trim()) break;",
    "settleThinkingBlock();",
    "const resultEl = ensureResult();",
    // the SWITCH and the reader's own hand — what decides whether the end is taken at all
    "function setFollowState(lit: boolean): void {",
    "followChoice = busy ? on : null;",
    "function setFollow(on: boolean): void {",
    "setFollowState(on && busy);",
    "phaseLockPulse(autoscrollBtn);",
    "if (!autoScroll || !sessionBusy()) return;",
    "const max = Math.max(0, height - messagesEl.clientHeight);",
    // the LEDGER: the two numbers that are the only thing allowed to tell a hand from a reflow
    "let lastOffset = messagesEl.scrollTop;",
    // …and OUR own restructures re-read it: a node that moves is not a hand either
    "function syncLedger(): void {",
    "let back = lastOffset - offset > BOTTOM_EPS;",
    "back = lastMax - max <= BOTTOM_EPS;",
    "if (e.deltaY < 0) setFollow(false);",
    // the rule, in three parts: the switch is the only author, the enforcement obeys it, and a HOLD
    // is the one thing it must not fight
    "function gapFromEnd(): number {",
    "settle(back);",
    "if (handHeld) return;",
    "function releaseHand(): void {",
    'window.addEventListener("pointerup", releaseHand, PASSIVE);',
    // the state is DERIVED, and every message that ends the turn releases the session it was
    // working on: the two sentences that keep the Follow from outliving its own run
    "function syncFollowToWork(busy: boolean): void {",
    "if (!busy) followChoice = null;",
    "if (autoScroll && !wasLit) pinToBottom();",
    "function endTurn(): void {",
    "function releaseActive(): void {",
    "if (activeId) workingIds.delete(activeId);",
    "else if (msg.active === false) releaseActive();",
    // the geometry net — what decides whether the end is taken at all
    "const geometry = new ResizeObserver(() => {",
    "new MutationObserver(watchTranscript).observe(messagesEl, { childList: true });",
    // the tool-output language hint — what decides whether an output is coloured at all
    "function langHintOf(el: HTMLElement, text: string): string | undefined {",
    'return looksLikeJson(text) ? "json" : undefined;',
    "function looksLikeJson(text: string): boolean {",
    "JSON.parse(text);",
  ],
  "src/chat/chat-view.ts": [
    "private refreshTranscript(rt: SessionRuntime",
    "const live = rt.engine.projection();",
    "streaming: rt.agent.streaming,",
    "liveThinking: live.thinking",
  ],
  "src/chat/webview/find.ts": [
    "function blocks(): SearchBlock[] {",
    "const el = n.parentElement?.closest(SEARCH_BLOCK) ?? els.transcript;",
    "current.text += text;",
    "function nodeAt(block: SearchBlock, offset: number)",
    "range.setEnd(to.node, to.offset + 1);",
  ],
};

type Hunk = { file: string; start: number; end: number; config: string };

/** Every `<file>:<start>-<end>` entry of every Stryker config in `tests/mutation/`. */
function rangedHunks(): Hunk[] {
  const hunks: Hunk[] = [];
  for (const name of readdirSync(CONFIGS).filter((f) => f.endsWith(".conf.json"))) {
    const conf = JSON.parse(readFileSync(join(CONFIGS, name), "utf8")) as { mutate?: string[] };
    for (const entry of conf.mutate ?? []) {
      const m = /^(.+):(\d+)-(\d+)$/.exec(entry);
      if (!m) continue;
      hunks.push({ file: m[1], start: Number(m[2]), end: Number(m[3]), config: join("tests", "mutation", name) });
    }
  }
  return hunks;
}

describe("mutation ratchet anchors", () => {
  const hunks = rangedHunks();

  it("finds the surgical ratchets (a config deleted is a ratchet lost)", () => {
    // A FILE may carry more than one range (view.ts has the streaming block and the tool-output
    // language hint), so the list is per FILE: what must never happen is a mutated file with no
    // anchors, i.e. a floor nobody declared.
    expect([...new Set(hunks.map((h) => h.file))].sort()).toEqual(Object.keys(ANCHORS).sort());
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
    // A file may carry MORE than one measured range (view.ts: the streaming block, and the
    // tool-output language hint), and an anchor belongs to one of them, not to all: what must hold
    // is that every anchor still sits inside SOME range of that file. A range that slides off the
    // statements it was measured on therefore still fails here, which is the point.
    for (const file of [...new Set(hunks.map((h) => h.file))]) {
      const source = readFileSync(join(ROOT, file), "utf8").split("\n");
      const covered = hunks
        .filter((h) => h.file === file)
        .map((h) => source.slice(h.start - 1, h.end).join("\n"))
        .join("\n");
      for (const anchor of ANCHORS[file] ?? []) {
        expect(covered, `${file}: no measured range covers \`${anchor}\` — move it, do not delete it`).toContain(
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
