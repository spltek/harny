import { isAbsolute, relative, resolve } from "node:path";

/** Resolve a possibly-relative path against the workspace root. */
export function resolvePath(input: string | undefined, cwd: string): string {
  if (!input) return cwd;
  if (input.startsWith("/") || input.match(/^[A-Z]:\\/)) return input;
  return resolve(cwd, input);
}

/**
 * Path-traversal guard: returns a teaching refusal string when `resolved`
 * falls OUTSIDE `root` (e.g. "../x" or an absolute path elsewhere), or
 * `undefined` when it is inside (or equals) the root. LEXICAL check (resolve
 * + relative); it does not follow symlinks — a link inside the root that
 * points outside is a separate hardening (realpath), documented as residual.
 */
export function pathSafetyError(resolved: string, root: string): string | undefined {
  if (resolved === root) return undefined;
  const rel = relative(root, resolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return `Path ${resolved} falls outside the workspace root ${root}. Refusing to operate outside the sandbox. Re-target inside ${root} or grant an explicit allowed-root for this session.`;
  }
  return undefined;
}

export function isImagePath(path: string): boolean {
  return /\.(jpe?g|png|gif|webp|bmp)$/i.test(path);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
