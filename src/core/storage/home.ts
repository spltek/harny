import { join } from "node:path";

export const HARNY_HOME_ENV = "HARNY_HOME";

export interface ResolvedHome {
  /** Base directory for extension data (env override or VS Code globalStorage). */
  home: string;
}

export interface ResolveHomeOptions {
  /** Absolute path of the extension's VS Code globalStorage directory. */
  globalStorageFsPath: string;
  /** Process environment, used for the HARNY_HOME override. */
  env?: Record<string, string | undefined>;
}

/**
 * pi-style workspace key: `/Users/x/proj` → `--Users-x-proj--` (safe as a
 * folder name). Sessions are grouped per workspace under this key in home.
 * BOTH separators and every Windows-illegal filename character (`\ : * ? " <
 * > |`) are collapsed to `-`, so a Windows cwd like `C:\Users\x\proj` yields
 * a VALID folder name. POSIX output is unchanged (`/` already became `-`).
 */
export function sanitizeWorkspaceKey(cwd: string): string {
  const clean = cwd
    .trim()
    .replace(/[\\/]+/g, "-")
    .replace(/[<>:"|?*\u0000-\u001f]+/g, "-")
    .replace(/^[-]+|[-]+$/g, "");
  return clean ? `--${clean}--` : "--global--";
}

/**
 * Resolve the cross-platform data directory for the extension, following the
 * VS Code convention:
 *
 * - default: `context.globalStorageUri.fsPath` (the extension's own folder:
 *   `~/Library/Application Support/Code/User/globalStorage/spltek.harny` on
 *   macOS, `%APPDATA%\Code\User\globalStorage\spltek.harny` on Windows,
 *   `~/.config/Code/User/globalStorage/spltek.harny` on Linux)
 * - override: `HARNY_HOME` env var (portable/backup setups)
 *
 * This home hosts the dedicated `config.json` AND the SESSIONS, which live in
 * `home/sessions/<workspaceKey>/` (pi/Cursor style): centralized — outside the
 * tool/agent folder scope — but grouped per workspace, so the panel shows only
 * the current folder's sessions.
 */
export function resolveHome(opts: ResolveHomeOptions): ResolvedHome {
  const envOverride = opts.env?.[HARNY_HOME_ENV]?.trim();
  const home = envOverride || opts.globalStorageFsPath;
  return { home };
}

/**
 * Central sessions directory for a workspace root (pi/Cursor style):
 * `home/sessions/<sanitizedKey>/`. Without a single workspace root the
 * sessions fall into the `--global--` bucket.
 */
export function sessionsDirFor(workspaceCwd: string | undefined, home: string): string {
  return join(home, "sessions", sanitizeWorkspaceKey(workspaceCwd || "global"));
}