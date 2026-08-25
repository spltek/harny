import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSessionGitignore, SESSIONS_GITIGNORE_ENTRY } from "./workspace-gitignore";
import type { FileSystem } from "../tools/file-system";
import { readFileSync, existsSync } from "node:fs";

const fs: FileSystem = {
  readText: (p) => readFileSync(p, "utf-8"),
  writeText: (p, c) => writeFileSync(p, c, "utf-8"),
  exists: (p) => existsSync(p),
  mkdirRecursive: () => undefined,
  list: () => [],
  delete: () => undefined,
} as FileSystem;

describe("ensureSessionGitignore", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("appends the entry when .gitignore exists and lacks it", () => {
    dir = mkdtempSync(join(tmpdir(), "harny-git-"));
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    const added = ensureSessionGitignore(dir, fs);
    expect(added).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf-8")).toContain(SESSIONS_GITIGNORE_ENTRY);
  });

  it("does not duplicate the entry when already present", () => {
    dir = mkdtempSync(join(tmpdir(), "harny-git-"));
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n" + SESSIONS_GITIGNORE_ENTRY + "\n");
    const added = ensureSessionGitignore(dir, fs);
    expect(added).toBe(false);
    expect(readFileSync(join(dir, ".gitignore"), "utf-8")).toEqual("node_modules/\n" + SESSIONS_GITIGNORE_ENTRY + "\n");
  });

  it("does nothing when there is no .gitignore (hidden dot-dir, docs only)", () => {
    dir = mkdtempSync(join(tmpdir(), "harny-git-"));
    const added = ensureSessionGitignore(dir, fs);
    expect(added).toBe(false);
  });
});