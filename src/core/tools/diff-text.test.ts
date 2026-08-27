import { describe, it, expect } from "vitest";
import { buildDiff, capDiff, diffStat, fencedDiffBlock } from "./diff-text";

describe("buildDiff", () => {
  it("treats a NEW file as all additions (diff against an empty base)", () => {
    const diff = buildDiff("", "a\nb\nc");
    expect(diff).toContain("@@ -0,0 +1,3 @@");
    expect(diff).toContain("+a");
    expect(diff).toContain("+b");
    expect(diff).toContain("+c");
    expect(diff).not.toContain("-a");
  });

  it("treats a DELETED file as all removals (diff against empty target)", () => {
    const diff = buildDiff("x\ny", "");
    expect(diff).toContain("@@ -1,2 +0,0 @@");
    expect(diff).toContain("-x");
    expect(diff).toContain("-y");
    expect(diff).not.toContain("+x");
  });

  it("produces a mixed diff with context for a modified line", () => {
    const diff = buildDiff("a\nb\nc", "a\nB\nc");
    expect(diff).toContain("-b");
    expect(diff).toContain("+B");
    expect(diff).toContain("a");
    expect(diff).toContain("c");
  });

  it("returns an empty string when nothing changed", () => {
    expect(buildDiff("same", "same")).toBe("");
  });
});

describe("capDiff", () => {
  it("leaves short diffs untouched", () => {
    const diff = "@@ -1 +1 @@\n-old\n+new";
    expect(capDiff(diff)).toBe(diff);
  });

  it("truncates at a line boundary with an explicit marker on its own line", () => {
    const many = Array.from({ length: 200 }, () => "x".repeat(60)).join("\n");
    const capped = capDiff(many, 1000);
    expect(capped.endsWith("… (diff truncated)")).toBe(true);
    // the marker sits on its own line, and the cut is BETWEEN lines
    expect(capped.split("\n").pop()).toBe("… (diff truncated)");
    const body = capped.slice(0, capped.length - "\n… (diff truncated)".length);
    expect(body).not.toBe("");
    expect(body.split("\n").every((l) => l.length === 60)).toBe(true);
  });
});

describe("diffStat", () => {
  it("counts + and - lines, ignoring the hunk header", () => {
    const diff = "@@ -1,2 +1,2 @@\n-old\n+new\n-old2";
    expect(diffStat(diff)).toBe("+1/-2");
  });

  it("ignores +++ / --- header lines", () => {
    expect(diffStat("--- a\n+++ b\n+add\n+add\n-del")).toBe("+2/-1");
  });
});

describe("fencedDiffBlock", () => {
  it("wraps a diff in the canonical fence with a stat label", () => {
    const diff = "@@ -1 +1 @@\n-old\n+new";
    expect(fencedDiffBlock(diff)).toBe(
      "\n\nDiff (+1/-1):\n```diff\n@@ -1 +1 @@\n-old\n+new\n```",
    );
  });

  it("returns an empty string for an empty/absent diff (no phantom fence)", () => {
    expect(fencedDiffBlock("")).toBe("");
    expect(fencedDiffBlock(undefined)).toBe("");
  });

  it("caps long diffs but keeps the full stat in the label", () => {
    const many = Array.from({ length: 600 }, (_, i) => `+line ${i}`).join("\n");
    const block = fencedDiffBlock(many);
    expect(block).toContain("Diff (+600/-0):");
    expect(block).toContain("… (diff truncated)");
    expect(block).not.toContain("+line 599");
  });
});