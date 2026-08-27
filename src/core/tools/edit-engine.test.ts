import { describe, it, expect } from "vitest";
import { applyEdits, checkStructuralBalance, closestContext } from "./edit-engine";
import { diffStat } from "./diff-text";

describe("edit-engine.applyEdits", () => {
  it("applies multiple exact edits sequentially", () => {
    const r = applyEdits("a\nb\nc\nd", [
      { oldText: "b", newText: "B" },
      { oldText: "d", newText: "D" },
    ]);
    expect(r.failed).toEqual([]);
    expect(r.content).toBe("a\nB\nc\nD");
    expect(r.applied).toBe(2);
  });

  it("handles an edit whose match shifts after an earlier one", () => {
    const r = applyEdits("xxxx\nfoo\nbar", [
      { oldText: "xxxx", newText: "yyyyyy" },
      { oldText: "bar", newText: "baz" },
    ]);
    expect(r.failed).toEqual([]);
    expect(r.content).toBe("yyyyyy\nfoo\nbaz");
  });

  it("replaces only the FIRST occurrence when unique by count enforcement", () => {
    // a unique oldText → exact
    const r = applyEdits("a\nb\na\n", [{ oldText: "a", newText: "X" }]);
    expect(r.failed.length).toBe(1); // "a" appears twice → duplicate error, not silent first-match
    expect(r.applied).toBe(0);
  });

  it("errors with a count when oldText is duplicated", () => {
    const r = applyEdits("x = 1;\nx = 1;\n", [{ oldText: "x = 1;", newText: "x = 2;" }]);
    expect(r.failed[0].reason).toContain("2 occurrences");
  });

  it("tolerates trailing whitespace and unicode quotes via fuzzy line matching", () => {
    const r = applyEdits("if (a) {\n    run();   \n}\n", [{ oldText: "if (a) {\n    run();\n}", newText: "if (a) {\n    runNow();\n}" }]);
    expect(r.failed).toEqual([]);
    expect(r.content).toBe("if (a) {\n    runNow();\n}\n");
    expect((r.modes as string[])[0]).toBe("fuzzy");
  });

  it("does NOT forgive leading indentation (quote exactly)", () => {
    const r = applyEdits("if (a) {\n    run();\n}\n", [{ oldText: "if (a) {\nrun();\n}", newText: "X" }]);
    expect(r.failed.length).toBe(1);
    expect(r.failed[0].reason).toContain("not found");
  });

  it("treats oldText === newText as an error (no change)", () => {
    const r = applyEdits("hello", [{ oldText: "hello", newText: "hello" }]);
    expect(r.failed[0].reason).toContain("no change");
  });

  it("supports CRLF files via exact match", () => {
    const r = applyEdits("a\r\nb\r\nc\r\n", [{ oldText: "a\r\nb", newText: "A\r\nB" }]);
    expect(r.failed).toEqual([]);
    expect(r.content).toBe("A\r\nB\r\nc\r\n");
  });

  it("inserts before an anchor line", () => {
    const r = applyEdits("a\nb\nc", [{ beforeText: "c", newText: "mid" }]);
    expect(r.failed).toEqual([]);
    expect(r.content).toBe("a\nb\nmid\nc");
  });

  it("rejects an insertion WITHOUT newText (no phantom 'Applied' with unchanged file)", () => {
    const r = applyEdits("a\nb\n", [{ beforeText: "b" }]);
    expect(r.applied).toBe(0);
    expect(r.failed[0].reason).toContain("insertion needs newText");
    // P7: the error teaches recovery with a minimal valid example.
    expect(r.failed[0].detail).toContain('{"beforeText": "<anchor line>", "newText": "<text to insert>"}');
    expect(r.content).toBe("a\nb\n");
  });

  it("reports failures without losing applied positions", () => {
    const r = applyEdits("a\nb", [
      { oldText: "a", newText: "A" },
      { oldText: "zzz", newText: "Z" },
    ]);
    expect(r.applied).toBe(1);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].index).toBe(1);
    expect(r.content).toBe("A\nb");
  });

  it("flags invalid ops", () => {
    const r = applyEdits("a", [{ newText: "x" }]);
    expect(r.failed[0].reason).toContain("invalid edit");
  });

  it("produces a unified diff when something changed", () => {
    const r = applyEdits("alpha\nbeta\ngamma\n", [{ oldText: "beta", newText: "BETA" }]);
    expect(r.diff).toContain("-beta");
    expect(r.diff).toContain("+BETA");
    expect(diffStat(r.diff!)).toBe("+1/-1");
  });
});

describe("checkStructuralBalance", () => {
  it("balanced nested file", () => {
    expect(checkStructuralBalance("{\n  a: [1, (2)],\n  b() { return { c: /x/ }; },\n}\n").balanced).toBe(true);
  });
  it("ignores braces inside strings and comments", () => {
    expect(checkStructuralBalance("const a = \"} {\";\n// }\n/* { */\nconst b = `tpl { } ${foo}`;\n").balanced).toBe(true);
  });
  it("catches an extra closing paren / unclosed array", () => {
    expect(checkStructuralBalance("f());\n").balanced).toBe(false);
    expect(checkStructuralBalance("const a = [1, 2;\n").balanced).toBe(false);
  });
  it("catches an unterminated string", () => {
    expect(checkStructuralBalance("const a = \"nope;\n").balanced).toBe(false);
  });
});

describe("closestContext", () => {
  it("finds surrounding lines with line numbers", () => {
    const ctx = closestContext("l1\nl2\nTARGET line extra\nl4\nl5\n", "TARGET line xyz");
    expect(ctx.some((l) => /TARGET line extra/.test(l))).toBe(true);
    expect(ctx[0]).toMatch(/^\s*\d+\|/);
  });
});