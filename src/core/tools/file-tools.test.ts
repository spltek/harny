import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeFileSystem } from "./file-system";
import { ReadTool } from "./read-tool";
import { WriteTool } from "./write-tool";
import { StrReplaceTool } from "./str-replace-tool";
import { DeleteTool } from "./delete-tool";

describe("file tools", () => {
  let dir: string;
  const cwd = () => dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harny-tools-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("ReadTool", () => {
    it("returns file content", () => {
      const p = join(dir, "a.txt");
      writeFileSync(p, "line1\nline2\nline3");
      const tool = new ReadTool(nodeFileSystem, cwd);

      const result = tool.execute({ path: p });

      expect(result.isError).toBe(false);
      expect(result.content).toBe("line1\nline2\nline3");
    });

    it("respects offset and limit (1-indexed)", () => {
      const p = join(dir, "a.txt");
      writeFileSync(p, "1\n2\n3\n4\n5");
      const tool = new ReadTool(nodeFileSystem, cwd);

      const result = tool.execute({ path: p, offset: 2, limit: 2 });

      expect(result.content).toBe("2\n3\n\n[Truncated: lines 2-3 of 5]");
    });

    it("supports negative offsets counting from the end", () => {
      const p = join(dir, "a.txt");
      writeFileSync(p, "1\n2\n3\n4\n5");
      const tool = new ReadTool(nodeFileSystem, cwd);

      const result = tool.execute({ path: p, offset: -2 });

      expect(result.content).toBe("4\n5");
    });

    it("negative offsets are not shifted when the file ends with a newline", () => {
      // split() on a trailing-newline file yields a phantom empty line that
      // used to make -1 return nothing and -2 return the last line.
      const p = join(dir, "nl.txt");
      writeFileSync(p, "1\n2\n3\n4\n5\n");
      const tool = new ReadTool(nodeFileSystem, cwd);

      expect(tool.execute({ path: p, offset: -1 }).content).toBe("5");
      expect(tool.execute({ path: p, offset: -2 }).content).toBe("4\n5");
    });

    it("notes when output is truncated", () => {
      const p = join(dir, "a.txt");
      writeFileSync(p, "1\n2\n3\n4\n5");
      const tool = new ReadTool(nodeFileSystem, cwd);

      const result = tool.execute({ path: p, offset: 1, limit: 2 });

      expect(result.content).toContain("[Truncated: lines 1-2 of 5]");
    });

    it("reports missing files as errors", () => {
      const tool = new ReadTool(nodeFileSystem, cwd);
      const result = tool.execute({ path: join(dir, "nope.txt") });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("File not found");
    });

    it("flags binary files instead of showing raw garbage", () => {
      const p = join(dir, "bin.dat");
      writeFileSync(p, "abc\u0000\u0001\u0002def");
      const tool = new ReadTool(nodeFileSystem, cwd);

      const result = tool.execute({ path: p });

      expect(result.isError).toBe(false);
      expect(result.content).toContain("Binary file");
      expect(result.content).toContain("content not displayed");
      expect(result.content).not.toContain("\u0000");
    });

    it("resolves relative paths against the workspace root", () => {
      writeFileSync(join(dir, "rel.txt"), "hello");
      const tool = new ReadTool(nodeFileSystem, cwd);
      const result = tool.execute({ path: "rel.txt" });
      expect(result.isError).toBe(false);
      expect(result.content).toBe("hello");
    });
  });

  describe("WriteTool", () => {
    it("creates a file with contents", () => {
      const tool = new WriteTool(nodeFileSystem, cwd);
      const result = tool.execute({ path: join(dir, "out.txt"), contents: "hello world" });

      expect(result.isError).toBe(false);
      expect(nodeFileSystem.readText(join(dir, "out.txt"))).toBe("hello world");
    });

    it("creates parent directories automatically", () => {
      const tool = new WriteTool(nodeFileSystem, cwd);
      const result = tool.execute({ path: join(dir, "nested", "deep", "out.txt"), contents: "x" });
      expect(result.isError).toBe(false);
      expect(nodeFileSystem.exists(join(dir, "nested", "deep", "out.txt"))).toBe(true);
    });

    it("fails when path or contents are missing", () => {
      const tool = new WriteTool(nodeFileSystem, cwd);
      expect(tool.execute({}).isError).toBe(true);
      expect(tool.execute({ path: "/x" }).isError).toBe(true);
    });

    it("tells the model exactly which field is missing", () => {
      const tool = new WriteTool(nodeFileSystem, cwd);
      const noPath = tool.execute({ contents: "body { color: red; }" });
      expect(noPath.isError).toBe(true);
      expect(noPath.content).toContain('forgot the REQUIRED "path"');
      expect(noPath.content).toContain(cwd());
      expect(noPath.content).toContain('"style.css"');

      const noContents = tool.execute({ path: "a.css" });
      expect(noContents.isError).toBe(true);
      expect(noContents.content).toContain('forgot the REQUIRED "contents"');

      const neither = tool.execute({});
      expect(neither.content).toContain("missing BOTH");
    });

    it("reports both char and byte counts (UTF-8)", () => {
      const p = join(dir, "uni.txt");
      const tool = new WriteTool(nodeFileSystem, cwd);

      const result = tool.execute({ path: p, contents: "café ☕" });

      expect(result.isError).toBe(false);
      expect(result.content).toContain("6 chars (9 bytes)");
    });

    it("emits an all-additions diff preview for a NEW file (view diff bubble)", () => {
      const tool = new WriteTool(nodeFileSystem, cwd);
      const result = tool.execute({ path: join(dir, "new.ts"), contents: "a\nb\nc" });

      expect(result.isError).toBe(false);
      expect(result.content).toContain("```diff");
      expect(result.content).toContain("@@ -0,0 +1,3 @@");
      expect(result.content).toContain("+a");
      expect(result.content).toContain("+b");
      expect(result.content).toContain("+c");
      expect(result.content).not.toContain("-a");
    });

    it("emits a mixed diff preview when overwriting an existing file", () => {
      writeFileSync(join(dir, "upd.txt"), "aaa\nbbb\nccc");
      const tool = new WriteTool(nodeFileSystem, cwd);
      const result = tool.execute({ path: join(dir, "upd.txt"), contents: "aaa\nxxx\nccc" });

      expect(result.isError).toBe(false);
      expect(result.content).toContain("```diff");
      expect(result.content).toContain("-bbb");
      expect(result.content).toContain("+xxx");
    });
  });

  describe("StrReplaceTool", () => {
    it("replaces a UNIQUE old_string (ambiguous ones are rejected)", () => {
      const p = join(dir, "a.txt");
      writeFileSync(p, "aaa bbb aaa");
      const tool = new StrReplaceTool(nodeFileSystem, cwd);

      const result = tool.execute({ path: p, old_string: "bbb", new_string: "XXX" });

      expect(result.isError).toBe(false);
      expect(nodeFileSystem.readText(p)).toBe("aaa XXX aaa");
    });

    it("replaces all occurrences with replace_all", () => {
      const p = join(dir, "a.txt");
      writeFileSync(p, "aaa bbb aaa");
      const tool = new StrReplaceTool(nodeFileSystem, cwd);

      tool.execute({ path: p, old_string: "aaa", new_string: "XXX", replace_all: true });

      expect(nodeFileSystem.readText(p)).toBe("XXX bbb XXX");
    });

    it("emits a mixed diff preview (view diff bubble)", () => {
      const p = join(dir, "a.txt");
      writeFileSync(p, "aaa bbb aaa");
      const tool = new StrReplaceTool(nodeFileSystem, cwd);

      const result = tool.execute({ path: p, old_string: "bbb", new_string: "XXX" });

      expect(result.isError).toBe(false);
      expect(result.content).toContain("```diff");
      expect(result.content).toContain("-aaa bbb aaa");
      expect(result.content).toContain("+aaa XXX aaa");
    });

    it("fails when old_string is not unique without replace_all (no silent partial replace)", () => {
      const p = join(dir, "dup.txt");
      writeFileSync(p, "aaa\nbbb\naaa\n");
      const tool = new StrReplaceTool(nodeFileSystem, cwd);

      const result = tool.execute({ path: p, old_string: "aaa", new_string: "AAA" });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("more than once");
      expect(nodeFileSystem.readText(p)).toBe("aaa\nbbb\naaa\n"); // file untouched
    });

    it("tolerates trailing whitespace in old_string (Unicode/whitespace-tolerant match)", () => {
      const p = join(dir, "tol.txt");
      writeFileSync(p, "linea 2\n");
      const tool = new StrReplaceTool(nodeFileSystem, cwd);

      const result = tool.execute({ path: p, old_string: "linea 2 ", new_string: "linea DUE" });

      expect(result.isError).toBe(false);
      expect(nodeFileSystem.readText(p)).toBe("linea DUE\n");
    });

    it("tolerates smart quotes when the old_string is a whole line", () => {
      const p = join(dir, "q.txt");
      writeFileSync(p, "\u201Cmondo\u201D\n"); // smart quotes around a word, own line
      const tool = new StrReplaceTool(nodeFileSystem, cwd);

      const result = tool.execute({ path: p, old_string: '"mondo"', new_string: "[mondo]" });

      expect(result.isError).toBe(false);
      expect(nodeFileSystem.readText(p)).toBe("[mondo]\n");
    });

    it("fails EXPLICITLY for partial-line smart-quote differences (never corrupts silently)", () => {
      const p = join(dir, "q2.txt");
      writeFileSync(p, "Ciao \u201Cmondo\u201D carino\n");
      const tool = new StrReplaceTool(nodeFileSystem, cwd);

      const result = tool.execute({ path: p, old_string: '"mondo"', new_string: "[mondo]" });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("not found");
      expect(nodeFileSystem.readText(p)).toBe("Ciao \u201Cmondo\u201D carino\n"); // untouched
    });

    it("preserves a matched line's trailing whitespace on tolerant matches", () => {
      const p = join(dir, "ws.txt");
      writeFileSync(p, "ｍｏｎｄｏ   \n"); // full-width NFKC→mondo + 3 trailing spaces
      const tool = new StrReplaceTool(nodeFileSystem, cwd);

      const result = tool.execute({ path: p, old_string: "mondo", new_string: "X" });

      expect(result.isError).toBe(false);
      expect(nodeFileSystem.readText(p)).toBe("X   \n");
    });

    it("warns (never blocks) about mid-word replacements with replace_all", () => {
      const p = join(dir, "mw.txt");
      writeFileSync(p, "catalog of cats");
      const tool = new StrReplaceTool(nodeFileSystem, cwd);

      const result = tool.execute({ path: p, old_string: "cat", new_string: "gatto", replace_all: true });

      expect(result.isError).toBe(false);
      expect(nodeFileSystem.readText(p)).toBe("gattoalog of gattos");
      expect(result.content).toContain("⚠️ 2 of 2 replacements were mid-word");
      expect(result.content).toContain('"catalog → gattoalog"');
    });

    it("errors when old_string is not found", () => {
      const p = join(dir, "a.txt");
      writeFileSync(p, "hello");
      const tool = new StrReplaceTool(nodeFileSystem, cwd);

      const result = tool.execute({ path: p, old_string: "nope", new_string: "x" });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("not found");
    });

    it("errors when the file does not exist", () => {
      const tool = new StrReplaceTool(nodeFileSystem, cwd);
      const result = tool.execute({ path: join(dir, "nope.txt"), old_string: "a", new_string: "b" });
      expect(result.isError).toBe(true);
    });
  });

  describe("DeleteTool", () => {
    it("deletes an existing file", () => {
      const p = join(dir, "a.txt");
      writeFileSync(p, "content");
      const tool = new DeleteTool(nodeFileSystem, cwd);

      const result = tool.execute({ path: p });

      expect(result.isError).toBe(false);
      expect(nodeFileSystem.exists(p)).toBe(false);
    });

    it("emits an all-removals diff preview (view diff bubble)", () => {
      const p = join(dir, "gone.ts");
      writeFileSync(p, "x\ny");
      const tool = new DeleteTool(nodeFileSystem, cwd);

      const result = tool.execute({ path: p });

      expect(result.isError).toBe(false);
      expect(result.content).toContain("```diff");
      expect(result.content).toContain("@@ -1,2 +0,0 @@");
      expect(result.content).toContain("-x");
      expect(result.content).toContain("-y");
      expect(result.content).not.toContain("+x");
    });

    it("errors when the file does not exist", () => {
      const tool = new DeleteTool(nodeFileSystem, cwd);
      const result = tool.execute({ path: join(dir, "nope.txt") });
      expect(result.isError).toBe(true);
    });
  });
});
