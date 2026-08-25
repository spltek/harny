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
  });

  describe("StrReplaceTool", () => {
    it("replaces the first occurrence by default", () => {
      const p = join(dir, "a.txt");
      writeFileSync(p, "aaa bbb aaa");
      const tool = new StrReplaceTool(nodeFileSystem, cwd);

      const result = tool.execute({ path: p, old_string: "aaa", new_string: "XXX" });

      expect(result.isError).toBe(false);
      expect(nodeFileSystem.readText(p)).toBe("XXX bbb aaa");
    });

    it("replaces all occurrences with replace_all", () => {
      const p = join(dir, "a.txt");
      writeFileSync(p, "aaa bbb aaa");
      const tool = new StrReplaceTool(nodeFileSystem, cwd);

      tool.execute({ path: p, old_string: "aaa", new_string: "XXX", replace_all: true });

      expect(nodeFileSystem.readText(p)).toBe("XXX bbb XXX");
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

    it("errors when the file does not exist", () => {
      const tool = new DeleteTool(nodeFileSystem, cwd);
      const result = tool.execute({ path: join(dir, "nope.txt") });
      expect(result.isError).toBe(true);
    });
  });
});
