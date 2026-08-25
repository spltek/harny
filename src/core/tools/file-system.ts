import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";

export interface FileSystem {
  readText(path: string): string;
  writeText(path: string, content: string): void;
  exists(path: string): boolean;
  /** List the entries (files + dirs) in a directory (returns [] if missing). */
  list(dir: string): string[];
  size(path: string): number;
  mtimeMs(path: string): number;
  mkdirRecursive(path: string): void;
  delete(path: string): void;
}

export const nodeFileSystem: FileSystem = {
  readText: (p) => readFileSync(p, "utf-8"),
  writeText: (p, c) => writeFileSync(p, c, "utf-8"),
  exists: (p) => existsSync(p),
  list: (d) => (existsSync(d) ? readdirSync(d) : []),
  size: (p) => statSync(p).size,
  mtimeMs: (p) => statSync(p).mtimeMs,
  mkdirRecursive: (p) => mkdirSync(p, { recursive: true }),
  delete: (p) => unlinkSync(p),
};
