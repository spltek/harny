import { join } from "node:path";
import type { FileSystem } from "../tools/file-system";
import { resolvePath } from "../tools/path-utils";

/** A path's PRE-run state: whether it existed and, when it did, its text. */
interface Captured {
  existed: boolean;
  /** Present only for a readable text file. A missing `text` on an existing
   * file means it could not be read (binary/permission): restore leaves it. */
  text?: string;
}

export interface SnapshotRestoreResult {
  /** Files rewritten to their pre-run content. */
  restored: string[];
  /** Files that did NOT exist before the run and were deleted. */
  removed: string[];
  /** Paths that could not be restored (unreadable, or a created directory). */
  skipped: string[];
}

/**
 * Captures the files a writer run may touch, so the user can undo that run.
 * Only the LAST run that captured something is kept, and `restore()` is a
 * one-shot undo. Text-only (binary files are skipped, never corrupted) and
 * best-effort: it never throws.
 */
export interface RunSnapshot {
  /** Start capturing for a new run. */
  beginRun(): void;
  /** Capture the pre-run state of these paths (files; directories are walked). */
  capture(paths: readonly string[]): void;
  /** End the run: the captures become the single undoable snapshot when non-empty. */
  commitRun(): void;
  /** True when there is something to undo. */
  hasSnapshot(): boolean;
  /** Restore the last run's captured state (one-shot). */
  restore(): SnapshotRestoreResult;
}

/** Cap on captured files per run, so a huge declared directory cannot exhaust
 * memory. Extra files past the cap are skipped (restore reports them). */
export const MAX_SNAPSHOT_FILES = 2000;

/** A file larger than this is not captured (left untouched on restore). */
export const MAX_SNAPSHOT_FILE_BYTES = 1024 * 1024;

/** Vendored/build dirs never worth snapshotting (a writer declaring "." must
 * not walk node_modules). */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "out", "build", "coverage", ".next", "target",
  ".venv", "venv", "__pycache__", ".cache", ".turbo",
]);

/** File-backed {@link RunSnapshot}. */
export class FileRunSnapshot implements RunSnapshot {
  /** Pre-run state captured for the CURRENT run. */
  private pending = new Map<string, Captured>();
  /** The last committed (undoable) snapshot. */
  private last: Map<string, Captured> | undefined;
  private skipped = 0;

  constructor(
    private fs: FileSystem,
    private cwd: () => string,
  ) {}

  beginRun(): void {
    this.pending = new Map();
    this.skipped = 0;
  }

  capture(paths: readonly string[]): void {
    for (const raw of paths) {
      if (!raw || !raw.trim()) continue;
      this.capturePath(resolvePath(raw, this.cwd()));
    }
  }

  commitRun(): void {
    // Keep the PREVIOUS undoable snapshot when this run captured nothing, so
    // "undo last run" still undoes the most recent run that changed files.
    if (this.pending.size > 0 || this.skipped > 0) this.last = this.pending;
    this.pending = new Map();
    this.skipped = 0;
  }

  hasSnapshot(): boolean {
    return !!this.last && this.last.size > 0;
  }

  restore(): SnapshotRestoreResult {
    const restored: string[] = [];
    const removed: string[] = [];
    const skipped: string[] = [];
    const snapshot = this.last;
    if (!snapshot) return { restored, removed, skipped };
    this.last = undefined; // one-shot
    for (const [p, cap] of snapshot) {
      try {
        if (cap.existed) {
          if (cap.text !== undefined) {
            this.fs.writeText(p, cap.text);
            restored.push(p);
          } else {
            skipped.push(p); // unreadable before: never delete/corrupt it
          }
        } else if (this.fs.exists(p) && !this.fs.isDirectory(p)) {
          this.fs.delete(p);
          removed.push(p);
        }
      } catch {
        skipped.push(p);
      }
    }
    return { restored, removed, skipped };
  }

  private capturePath(abs: string): void {
    // First sighting wins: keep the PRE-run state (never overwrite with a later
    // post-write read of the same path).
    if (this.pending.has(abs) || this.last?.has(abs)) return;
    if (this.fs.isDirectory(abs)) {
      const base = abs.split(/[\\/]/).pop() ?? "";
      if (SKIP_DIRS.has(base)) return;
      for (const entry of this.fs.list(abs)) this.capturePath(join(abs, entry));
      return;
    }
    if (this.pending.size + this.skipped >= MAX_SNAPSHOT_FILES) {
      this.skipped++;
      return;
    }
    this.pending.set(abs, this.read(abs));
  }

  private read(abs: string): Captured {
    try {
      if (!this.fs.exists(abs)) return { existed: false };
      if (this.fs.size(abs) > MAX_SNAPSHOT_FILE_BYTES) return { existed: true };
      // Binary (NUL byte in the head): record that it existed WITHOUT content,
      // so restore leaves it untouched instead of corrupting it.
      if (this.fs.readBytes(abs, 8192).includes(0)) return { existed: true };
      return { existed: true, text: this.fs.readText(abs) };
    } catch {
      // Unreadable (permission): record that it existed, without content.
      return { existed: true };
    }
  }
}
