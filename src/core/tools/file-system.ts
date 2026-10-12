import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

/** Synchronous sleep (used only for the short atomic-rename retries). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface FileSystem {
  readText(path: string): string;
  /** Read the first `maxBytes` bytes of a file (default 8192). Used to sniff
   * the content TYPE (magic bytes) without loading a huge binary. */
  readBytes(path: string, maxBytes?: number): Buffer;
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
  readBytes: (p, maxBytes = 8192) => {
    const fd = openSync(p, "r");
    try {
      const size = Math.max(0, Math.min(maxBytes, statSync(p).size));
      const buf = Buffer.alloc(size);
      const read = readSync(fd, buf, 0, size, 0);
      return buf.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  },
  // ATOMIC write: write a sibling temp file then rename over the target, so a
  // crash/power-loss never leaves a half-written session/config file. On
  // Windows the rename can be refused while the target is briefly locked (AV,
  // indexer, another reader): retry, then fall back to a plain overwrite so a
  // save never fails.
  writeText: (p, c) => {
    const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, c, "utf-8");
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, p);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
        if (!transient || attempt >= 5) {
          try {
            unlinkSync(tmp);
          } catch {
            /* ignore */
          }
          if (transient) {
            writeFileSync(p, c, "utf-8"); // last resort: never lose the save
            return;
          }
          throw e;
        }
        sleepSync(15 * (attempt + 1));
      }
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
