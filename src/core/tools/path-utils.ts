import { homedir } from "node:os";
import { resolve } from "node:path";
import { isAbsoluteAnyPlatform } from "../platform";

/** Resolve a possibly-relative path against the workspace root. Accepts
 * absolute paths in ANY platform style (POSIX `/…`, Windows `C:\` / `C:/`,
 * UNC `\\server\share`) and `~` home shorthand, so model-emitted paths work
 * everywhere. */
export function resolvePath(input: string | undefined, cwd: string): string {
  if (!input) return cwd;
  const trimmed = input.trim();
  if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return resolve(homedir(), trimmed.slice(2));
  }
  if (isAbsoluteAnyPlatform(trimmed)) return trimmed;
  return resolve(cwd, trimmed);
}

export function isImagePath(path: string): boolean {
  return /\.(jpe?g|png|gif|webp|bmp)$/i.test(path);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
