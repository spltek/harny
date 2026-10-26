import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdits, checkStructuralBalance, closestContext } from "./edit-engine";
import { diffStat } from "./diff-text";
import { EditTool } from "./edit-tool";
import { nodeFileSystem } from "./file-system";

// ── engine: exact / unique ────────────────────────────────────────────────────

describe("applyEdits — exact matching", () => {
  it("deletes with empty newText and keeps surroundings", () => {
    expect(applyEdits("keep\n\nremove\n", [{ oldText: "\nremove\n", newText: "" }]).content).toBe("keep\n");
  });
  it("matches at the very start and end of the file", () => {
    expect(applyEdits("start-middle-end", [{ oldText: "start", newText: "S" }]).content).toBe("S-middle-end");
    expect(applyEdits("start-middle-end", [{ oldText: "end", newText: "E" }]).content).toBe("start-middle-E");
  });
  it("replaces the whole file", () => {
    expect(applyEdits("tutto", [{ oldText: "tutto", newText: "nulla" }]).content).toBe("nulla");
  });
  it("handles empty file and empty oldText (explicit error)", () => {
    expect(applyEdits("", [{ oldText: "x", newText: "y" }]).failed.length).toBe(1);
    expect(applyEdits("rest", [{ oldText: "", newText: "PRE" }]).failed[0].reason).toContain("empty");
  });
});

describe("applyEdits — multi-edit sequencing", () => {
  it("a later oldText found inside the previous newText uses the updated string", () => {
    const r = applyEdits("a", [
      { oldText: "a", newText: "b" },
      { oldText: "b", newText: "c" },
    ]);
    expect(r.applied).toBe(2);
    expect(r.content).toBe("c");
  });
  it("position shifts across insert + edit + insert", () => {
    const r = applyEdits("x\ny\nz\n", [
      { oldText: "x", newText: "x1\nx2" },
      { oldText: "z", newText: "Z" },
      { afterText: "y", newText: "between" },
    ]);
    expect(r.failed).toEqual([]);
    expect(r.content).toBe("x1\nx2\nbetween\ny\nZ\n");
  });
});

describe("applyEdits — fuzzy normalization (only noise tolerance)", () => {
  it("forgives trailing whitespace per line", () => {
    const r = applyEdits("x();   \ny();\n", [{ oldText: "x();\ny();", newText: "z();" }]);
    expect(r.failed).toEqual([]);
    expect(r.content).toBe("z();\n");
  });
  it("forgives unicode smart quotes and dashes", () => {
    const file = "const msg = \u201cit\u2019s fine\u201d;\n";
    const r = applyEdits(file, [{ oldText: 'const msg = "it\u2019s fine";', newText: "x" }]);
    expect(r.failed).toEqual([]);
    expect(r.content).toBe("x\n");
  });
  it("fails clearly when content diverges (paraphrase)", () => {
    const r = applyEdits("function f() { return 1; }\n", [{ oldText: "function f() { return 2; }", newText: "x" }]);
    expect(r.failed.length).toBe(1);
    expect(r.failed[0].reason).toContain("not found");
  });
});

describe("applyEdits — diff output", () => {
  it("emits a unified diff with stat", () => {
    const r = applyEdits("a\nb\nc\nd\ne\nf\n", [{ oldText: "b", newText: "B" }]);
    expect(r.diff).toContain("-b");
    expect(r.diff).toContain("+B");
    expect(diffStat(r.diff!)).toBe("+1/-1");
  });
});

describe("checkStructuralBalance — hard cases", () => {
  it("balanced nested file", () => {
    expect(checkStructuralBalance("{\n  a: [1, (2)],\n  b() { return { c: /x/ }; },\n}\n").balanced).toBe(true);
  });
  it("ignores braces inside strings (quotes, escaped, templates)", () => {
    expect(
      checkStructuralBalance("const a = \"} {\";\nconst b = 'x} {';\nconst c = `tpl { } ${foo}`;\n").balanced,
    ).toBe(true);
  });
  it("ignores braces inside comments", () => {
    expect(checkStructuralBalance("// }\n/* { */\nconst a = 1;\n").balanced).toBe(true);
  });
  it("catches extra paren, unclosed array, unterminated string, empty ok", () => {
    expect(checkStructuralBalance("f());\n").balanced).toBe(false);
    expect(checkStructuralBalance("const a = [1, 2;\n").balanced).toBe(false);
    expect(checkStructuralBalance('const a = "nope;\n').balanced).toBe(false);
    expect(checkStructuralBalance("").balanced).toBe(true);
  });
});

describe("closestContext", () => {
  it("matches paraphrased single line and returns numbered lines", () => {
    const ctx = closestContext("l1\nl2\nTARGET line extra\nl4\nl5\n", "TARGET line xyz");
    expect(ctx.some((l) => /TARGET line extra/.test(l))).toBe(true);
    expect(ctx[0]).toMatch(/^\s*\d+\|/);
  });
  it("empty needle → empty context", () => {
    expect(closestContext("a\n", "")).toEqual([]);
  });
});

// ── EditTool end-to-end (real fs) ─────────────────────────────────────────────

describe("EditTool — end-to-end robustness", () => {
  let dir: string;
  const cwd = () => dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harny-edit-stress-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const tool = () => new EditTool(nodeFileSystem, cwd);

  it("applies the real single-edit scenario and reports the diff preview", () => {
    const f = join(dir, "sound.js");
    writeFileSync(
      f,
      [
        "class SoundEngine {",
        "    constructor() {",
        "        this.ctx = null;",
        "        this.notes = {",
        "            'A4': 440.00,",
        "        };",
        "    }",
        "}",
      ].join("\n"),
    );
    const r = tool().execute({
      path: f,
      edits: [{ oldText: "            'A4': 440.00,", newText: "            'A4': 440.00, 'B4': 493.88," }],
    });
    expect(r.isError).toBe(false);
    expect(readFileSync(f, "utf8")).toContain("'A4': 440.00, 'B4': 493.88,");
    expect(r.content).toContain("```diff");
    expect(r.content).toContain("+");
  });

  it("targets the WRONG file → precise error with nearby lines and path", () => {
    const f = join(dir, "config.js");
    writeFileSync(f, "const CONFIG = {\n    BLOCK_SIZE: 25,\n};\n");
    const r = tool().execute({
      path: f,
      edits: [{ oldText: "class SoundEngine {\n    constructor() {", newText: "X" }],
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain(f);
    expect(r.content).toContain("Re-Read");
    // nearby lines show the REAL file (CONFIG) so the model sees the mismatch
    expect(r.content).toContain("CONFIG");
  });

  it("caps the shown context and does not leak the whole file", () => {
    const f = join(dir, "big.txt");
    writeFileSync(f, Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"));
    const r = tool().execute({ path: f, edits: [{ oldText: "line 999", newText: "x" }] });
    expect(r.content).toContain("Nearby lines");
    expect((r.content.match(/\d+\|/g) ?? []).length).toBeLessThan(15); // head + nearby only
    expect(r.content).not.toContain("line 40"); // not the whole file
  });

  it("CRLF file survives an exact edit preserving other line endings", () => {
    const f = join(dir, "crlf.txt");
    writeFileSync(f, "a\r\nb\r\nc\r\n");
    const r = tool().execute({ path: f, edits: [{ oldText: "a\r\nb", newText: "a\r\nB" }] });
    expect(r.isError).toBe(false);
    expect(readFileSync(f, "utf8")).toBe("a\r\nB\r\nc\r\n");
  });

  it("values uniqueness: same snippet on two lines is rejected, then fixed with context", () => {
    const f = join(dir, "dup.js");
    writeFileSync(f, "set(a);\nset(b);\nset(c);\n");
    const r1 = tool().execute({ path: f, edits: [{ oldText: "set(", newText: "apply(" }] });
    expect(r1.isError).toBe(true);
    expect(r1.content).toContain("occurrences");
    // disambiguate with a full unique line
    const r2 = tool().execute({ path: f, edits: [{ oldText: "set(b);", newText: "apply(b);" }] });
    expect(r2.isError).toBe(false);
    expect(readFileSync(f, "utf8")).toBe("set(a);\napply(b);\nset(c);\n");
  });
});
