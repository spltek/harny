import { describe, it, expect } from "vitest";
import { splitDiffFence, countDiff } from "./diff-fence";

describe("splitDiffFence", () => {
  it("returns undefined for plain text (never a diff heuristic on +/- prefixes)", () => {
    expect(splitDiffFence("-rw-r--r-- 1 user staff 123 file.txt\n-rw-r--r-- 1 user staff 456 other.ts")).toBeUndefined();
    expect(splitDiffFence("just a list:\n- item one\n- item two")).toBeUndefined();
  });

  it("extracts the fence body, strips the label line and keeps feedback text", () => {
    const text =
      "Applied 1 edit(s) to a.js — +1/-1.\n\nDiff (+1/-1):\n```diff\n@@ -1,2 +1,2 @@\n-old\n+new\n```";
    const found = splitDiffFence(text);
    expect(found).toBeDefined();
    expect(found!.body).toBe("@@ -1,2 +1,2 @@\n-old\n+new");
    expect(found!.stat).toBe("+1/-1");
    expect(found!.rest).toBe("Applied 1 edit(s) to a.js — +1/-1.");
  });

  it("keeps trailing text after the fence in rest", () => {
    const found = splitDiffFence("```diff\n+x\n```\nafter");
    expect(found!.body).toBe("+x");
    expect(found!.rest).toBe("after");
  });

  it("handles a fence without the label line", () => {
    const found = splitDiffFence("note\n```diff\n+a\n```");
    expect(found!.body).toBe("+a");
    expect(found!.stat).toBeUndefined();
    expect(found!.rest).toBe("note");
  });

  it("only matches an explicit ```diff fence, never ```plain", () => {
    expect(splitDiffFence("```plain\n-old\n+new\n```")).toBeUndefined();
  });

  it("uses no stat when the label format differs", () => {
    const found = splitDiffFence("Some text\n```diff\n-0\n+1\n```");
    expect(found!.stat).toBeUndefined();
    expect(found!.rest).toBe("Some text");
  });
});

describe("countDiff", () => {
  it("counts + and - lines, ignoring hunks and context", () => {
    const body = "@@ -1,3 +1,3 @@\n ctx\n-old\n+new\n ctx\n-old2";
    expect(countDiff(body)).toBe("+1/−2");
  });

  it("ignores +++ / --- header guard lines", () => {
    expect(countDiff("+++ a\n--- b\n+add\n+add\n-del")).toBe("+2/−1");
  });

  it("returns +0/−0 for an empty body", () => {
    expect(countDiff("")).toBe("+0/−0");
  });
});