import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeFileSystem } from "./file-system";

describe("nodeFileSystem", () => {
  it("writes atomically (no temp leftovers), reports dirs and realpaths", () => {
    const dir = mkdtempSync(join(tmpdir(), "harny-fs-"));
    try {
      const f = join(dir, "a.jsonl");
      nodeFileSystem.writeText(f, "hello\n");
      expect(nodeFileSystem.readText(f)).toBe("hello\n");
      // Atomic write = temp sibling + rename: no `*.tmp-*` must remain.
      expect(readdirSync(dir).filter((n) => n.includes(".tmp-"))).toEqual([]);
      expect(nodeFileSystem.isDirectory(dir)).toBe(true);
      expect(nodeFileSystem.isDirectory(f)).toBe(false);
      expect(nodeFileSystem.realpath(f)).toContain("a.jsonl");
      expect(nodeFileSystem.realpath(join(dir, "missing"))).toContain("missing"); // fallback
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
