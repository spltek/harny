import { join } from "node:path";
import type { FileSystem } from "../tools/file-system";

/** Git-ignore entry for the per-folder sessions directory. */
export const SESSIONS_GITIGNORE_ENTRY = ".harny-sessions/";

/**
 * Ensure the workspace `.gitignore` (WHEN it exists) mentions the sessions
 * folder, so transcripts (code, paths, snippets) never end up in a commit by
 * accident. When there is no `.gitignore`, this does nothing — the folder is
 * a hidden dot-dir and the README documents the recommendation.
 *
 * @returns true when the entry was appended (or false otherwise).
 */
export function ensureSessionGitignore(root: string, fs: FileSystem): boolean {
  const path = join(root, ".gitignore");
  if (!fs.exists(path)) return false;
  const content = fs.readText(path);
  const has = content.split("\n").some((l) => l.trim() === SESSIONS_GITIGNORE_ENTRY);
  if (has) return false;
  fs.writeText(path, content.trimEnd() + "\n" + SESSIONS_GITIGNORE_ENTRY + "\n");
  return true;
}