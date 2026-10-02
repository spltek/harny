import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

export interface FileSystem {
  readText(path: string): string;
  writeText(path: string, content: string): void;
  exists(path: string): boolean;
  /** True when the path is an existing directory (false for files/missing). */
  isDirectory(path: string): boolean;
  /** Canonical absolute path (resolves symlinks); falls back to the input. */
  realpath(path: string): string;
  /** List the entries (files + dirs) in a directory (returns [] if missing). */
  list(dir: string): string[];
  size(path: string): number;
  mtimeMs(path: string): number;
  mkdirRecursive(path: string): void;
  delete(path: string): void;
}

export const nodeFileSystem: FileSystem = {
  readText: (p) => readFileSync(p, "utf-8"),
  // ATOMIC write: write a sibling temp file then rename over the target, so a
  // crash/power-loss never leaves a half-written session/config file.
  writeText: (p, c) => {
    const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
      writeFileSync(tmp, c, "utf-8");
      renameSync(tmp, p);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        /* best effort cleanup */
      }
      throw e;
    }
  },
  exists: (p) => existsSync(p),
  isDirectory: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  realpath: (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  },
  list: (d) => (existsSync(d) ? readdirSync(d) : []),
  size: (p) => statSync(p).size,
  mtimeMs: (p) => statSync(p).mtimeMs,
  mkdirRecursive: (p) => mkdirSync(p, { recursive: true }),
  delete: (p) => unlinkSync(p),
};
