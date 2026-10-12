import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

  it("readBytes returns only the first N bytes (content sniffing)", () => {
    const dir = mkdtempSync(join(tmpdir(), "harny-fs-"));
    try {
      const f = join(dir, "bin.dat");
      writeFileSync(f, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x01, 0x02, 0x03, 0x04, 0x05]));
      expect(nodeFileSystem.readBytes(f, 5).toString("latin1")).toBe("%PDF-");
      expect(nodeFileSystem.readBytes(f).length).toBe(10); // default cap larger than the file
      expect(nodeFileSystem.readBytes(f, 0).length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
