import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeFileSystem, type FileSystem } from "../tools/file-system";
import { FileRunSnapshot, MAX_SNAPSHOT_FILES } from "./run-snapshot";

describe("FileRunSnapshot", () => {
  let dir: string;
  const cwd = () => dir;
  let snap: FileRunSnapshot;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harny-snap-"));
    snap = new FileRunSnapshot(nodeFileSystem, cwd);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("restores a modified file to its pre-run content", () => {
    const f = join(dir, "a.ts");
    writeFileSync(f, "original");
    snap.beginRun();
    snap.capture(["a.ts"]);
    writeFileSync(f, "changed");
    snap.commitRun();

    expect(snap.hasSnapshot()).toBe(true);
    const res = snap.restore();

    expect(res.restored).toEqual([f]);
    expect(readFileSync(f, "utf-8")).toBe("original");
  });

  it("deletes a file the run created", () => {
    snap.beginRun();
    snap.capture(["new.ts"]); // did not exist before the run
    writeFileSync(join(dir, "new.ts"), "made");
    snap.commitRun();

    const res = snap.restore();

    expect(res.removed).toEqual([join(dir, "new.ts")]);
    expect(existsSync(join(dir, "new.ts"))).toBe(false);
  });

  it("keeps the PRE-run state (first sighting wins)", () => {
    const f = join(dir, "a.ts");
    writeFileSync(f, "v1");
    snap.beginRun();
    snap.capture(["a.ts"]);
    writeFileSync(f, "v2");
    snap.capture(["a.ts"]); // must NOT overwrite the captured v1
    writeFileSync(f, "v3");
    snap.commitRun();

    snap.restore();

    expect(readFileSync(f, "utf-8")).toBe("v1");
  });

  it("walks a declared directory and restores its files", () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "a0");
    writeFileSync(join(dir, "src", "b.ts"), "b0");
    snap.beginRun();
    snap.capture(["src"]);
    writeFileSync(join(dir, "src", "a.ts"), "a1");
    snap.commitRun();

    snap.restore();

    expect(readFileSync(join(dir, "src", "a.ts"), "utf-8")).toBe("a0");
    expect(readFileSync(join(dir, "src", "b.ts"), "utf-8")).toBe("b0");
  });

  it("does not descend into vendored dirs (node_modules)", () => {
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "x.js"), "dep");
    snap.beginRun();
    snap.capture(["."]);
    writeFileSync(join(dir, "node_modules", "x.js"), "hacked");
    snap.commitRun();

    snap.restore();

    expect(readFileSync(join(dir, "node_modules", "x.js"), "utf-8")).toBe("hacked");
  });

  it("skips binary files and never corrupts them on restore", () => {
    const bin = join(dir, "img.bin");
    writeFileSync(bin, Buffer.from([0, 1, 2, 3, 0]));
    snap.beginRun();
    snap.capture(["img.bin"]);
    writeFileSync(bin, Buffer.from([9, 9, 9, 9, 9]));
    snap.commitRun();

    const res = snap.restore();

    expect(res.skipped).toContain(bin);
    expect([...readFileSync(bin)]).toEqual([9, 9, 9, 9, 9]); // untouched
  });

  it("is a one-shot undo", () => {
    const f = join(dir, "a.ts");
    writeFileSync(f, "v1");
    snap.beginRun();
    snap.capture(["a.ts"]);
    writeFileSync(f, "v2");
    snap.commitRun();

    snap.restore();

    expect(snap.hasSnapshot()).toBe(false);
    expect(snap.restore()).toEqual({ restored: [], removed: [], skipped: [] });
  });

  it("keeps the previous snapshot when a run captures nothing", () => {
    const f = join(dir, "a.ts");
    writeFileSync(f, "v1");
    snap.beginRun();
    snap.capture(["a.ts"]);
    writeFileSync(f, "v2");
    snap.commitRun();
    // A later run that captures nothing must not wipe the undoable snapshot.
    snap.beginRun();
    snap.commitRun();

    expect(snap.hasSnapshot()).toBe(true);
    snap.restore();

    expect(readFileSync(f, "utf-8")).toBe("v1");
  });

  it("resolvePath-relative resources are captured against the cwd", () => {
    const f = join(dir, "rel.txt");
    writeFileSync(f, "before");
    snap.beginRun();
    snap.capture(["./rel.txt"]);
    writeFileSync(f, "after");
    snap.commitRun();
    snap.restore();
    expect(readFileSync(f, "utf-8")).toBe("before");
  });
});

/** In-memory FileSystem for the edge cases (cross-platform: keys are normalised
 * to forward slashes, so `path.join` output matches on Windows too). */
function fakeFs(
  entries: Record<string, string | "dir">,
  opts: { readTextThrows?: Set<string>; writeTextThrows?: Set<string> } = {},
) {
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const dirs = new Set<string>();
  const files = new Map<string, string>();
  for (const [p, v] of Object.entries(entries)) {
    if (v === "dir") dirs.add(norm(p));
    else files.set(norm(p), v);
  }
  const fs = {
    exists: (p: string) => files.has(norm(p)) || dirs.has(norm(p)),
    isDirectory: (p: string) => dirs.has(norm(p)),
    list: (d: string) => {
      const prefix = norm(d) + "/";
      const out = new Set<string>();
      for (const p of [...files.keys(), ...dirs]) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        if (rest && !rest.includes("/")) out.add(rest);
      }
      return [...out];
    },
    size: (p: string) => (files.get(norm(p)) ?? "").length,
    readBytes: (p: string, max = 8192) => Buffer.from((files.get(norm(p)) ?? "").slice(0, max)),
    readText: (p: string) => {
      if (opts.readTextThrows?.has(norm(p))) throw new Error("EACCES");
      return files.get(norm(p)) ?? "";
    },
    writeText: (p: string, c: string) => {
      if (opts.writeTextThrows?.has(norm(p))) throw new Error("EPERM");
      files.set(norm(p), c);
    },
    delete: (p: string) => {
      files.delete(norm(p));
    },
    realpath: (p: string) => p,
    mtimeMs: () => 0,
    mkdirRecursive: (p: string) => {
      dirs.add(norm(p));
    },
  } as unknown as FileSystem;
  return { fs, files, dirs };
}

describe("FileRunSnapshot edge cases", () => {
  it("caps the number of captured files (extra files are not captured)", () => {
    const entries: Record<string, string | "dir"> = { "/root": "dir" };
    for (let i = 0; i < MAX_SNAPSHOT_FILES + 5; i++) entries[`/root/f${i}.txt`] = "x";
    const { fs } = fakeFs(entries);
    const snap = new FileRunSnapshot(fs, () => "/root");

    snap.beginRun();
    snap.capture(["/root"]);
    snap.commitRun();

    // Exactly MAX files were captured (all existed + text) → all restored.
    expect(snap.restore().restored.length).toBe(MAX_SNAPSHOT_FILES);
  });

  it("leaves an unreadable file untouched on restore (never deletes it)", () => {
    const { fs } = fakeFs(
      { "/root": "dir", "/root/locked.bin": "secret" },
      { readTextThrows: new Set(["/root/locked.bin"]) },
    );
    const snap = new FileRunSnapshot(fs, () => "/root");

    snap.beginRun();
    snap.capture(["/root/locked.bin"]);
    snap.commitRun();

    const res = snap.restore();

    // Unreadable before → recorded as existing without content → skipped.
    expect(res.restored).toEqual([]);
    expect(res.removed).toEqual([]);
  });

  it("reports a file as skipped when restore cannot write it", () => {
    const writeErrors = new Set<string>();
    const { fs, files } = fakeFs(
      { "/root": "dir", "/root/a.txt": "v1" },
      { writeTextThrows: writeErrors },
    );
    const snap = new FileRunSnapshot(fs, () => "/root");

    snap.beginRun();
    snap.capture(["/root/a.txt"]);
    files.set("/root/a.txt", "v2"); // the run changed it
    snap.commitRun();

    writeErrors.add("/root/a.txt"); // restore write fails
    const res = snap.restore();

    expect(res.skipped).toContain("/root/a.txt");
  });
});
