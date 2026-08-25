import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditTool } from "./edit-tool";
import { nodeFileSystem } from "./file-system";

describe("EditTool", () => {
  let dir: string;
  const cwd = () => dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harny-edit-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const tool = () => new EditTool(nodeFileSystem, cwd);

  it("applies multi-edit atomically and writes the file, reporting the diff", () => {
    const f = join(dir, "a.js");
    writeFileSync(f, "x = 1;\ny = 2;\nz = 3;\n");
    const r = tool().execute({
      path: f,
      edits: [
        { oldText: "x = 1;", newText: "x = 10;" },
        { oldText: "z = 3;", newText: "z = 30;" },
      ],
    });
    expect(r.isError).toBe(false);
    expect(readFileSync(f, "utf8")).toBe("x = 10;\ny = 2;\nz = 30;\n");
    expect(r.content).toContain("Applied 2 edit(s)");
    expect(r.content).toContain("```diff"); // the preview
    expect(r.content).toContain("-x = 1;");
    expect(r.content).toContain("+x = 10;");
  });

  it("rejects duplicate oldText with a precise error", () => {
    const f = join(dir, "dup.js");
    writeFileSync(f, "a = on();\na = on();\n");
    const r = tool().execute({ path: f, edits: [{ oldText: "a = on();", newText: "a = off();" }] });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("2 occurrences");
    expect(readFileSync(f, "utf8")).toBe("a = on();\na = on();\n"); // untouched
  });

  it("reports a clear not-found error that points to the file and suggests re-reading", () => {
    const f = join(dir, "miss.js");
    writeFileSync(f, "const CONFIG = {\n    BLOCK_SIZE: 25,\n};\n");
    const r = tool().execute({
      path: f,
      edits: [{ oldText: "class SoundEngine {\n    constructor() {", newText: "X" }],
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain(f); // path included
    expect(r.content).toContain("Re-Read");
    expect(r.content).toContain("Nearby lines"); // context
  });

  it("does NOT write the file when any edit fails", () => {
    const f = join(dir, "c.js");
    writeFileSync(f, "abc\ndef\n");
    const r = tool().execute({
      path: f,
      edits: [
        { oldText: "abc", newText: "ABCD" },
        { oldText: "zzz", newText: "ZZZ" },
      ],
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("NOT written");
    expect(r.content).toContain("edit #1");
    expect(readFileSync(f, "utf8")).toBe("abc\ndef\n"); // unchanged
  });

  it("inserts before an anchor line", () => {
    const f = join(dir, "d.js");
    writeFileSync(f, "a\nb\n");
    const r = tool().execute({ path: f, edits: [{ beforeText: "b", newText: "between" }] });
    expect(r.isError).toBe(false);
    expect(readFileSync(f, "utf8")).toBe("a\nbetween\nb\n");
  });

  it("refuses to write when the edit would break the file structure", () => {
    const f = join(dir, "balance.js");
    writeFileSync(f, "function f() {\n  return { a: 1 };\n}\n");
    const r = tool().execute({ path: f, edits: [{ oldText: "};\n}", newText: "}" }] });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("would break the file");
    expect(readFileSync(f, "utf8")).toBe("function f() {\n  return { a: 1 };\n}\n");
  });

  it("returns a clear error for a missing file", () => {
    const r = tool().execute({ path: join(dir, "nope.js"), edits: [{ oldText: "a", newText: "b" }] });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("File not found");
  });

  it("deletes text with an empty newText", () => {
    const f = join(dir, "del.js");
    writeFileSync(f, "a\nb\nc\n");
    const r = tool().execute({ path: f, edits: [{ oldText: "\nb\n", newText: "" }] });
    expect(r.isError).toBe(false);
    expect(readFileSync(f, "utf8")).toBe("ac\n");
  });

  it("resolves relative paths from cwd", () => {
    writeFileSync(join(dir, "rel.js"), "x\n");
    const r = tool().execute({ path: "rel.js", edits: [{ oldText: "x", newText: "y" }] });
    expect(r.isError).toBe(false);
    expect(readFileSync(join(dir, "rel.js"), "utf8")).toBe("y\n");
  });
});