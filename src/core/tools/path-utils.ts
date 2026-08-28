import { resolve } from "node:path";

/** Resolve a possibly-relative path against the workspace root. */
export function resolvePath(input: string | undefined, cwd: string): string {
  if (!input) return cwd;
  if (input.startsWith("/") || input.match(/^[A-Z]:\\/)) return input;
  return resolve(cwd, input);
}

export function isImagePath(path: string): boolean {
  return /\.(jpe?g|png|gif|webp|bmp)$/i.test(path);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
