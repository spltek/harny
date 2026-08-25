import { join } from "node:path";

export const HARNY_HOME_ENV = "HARNY_HOME";

/** pi-style workspace key: `/Users/x/proj` -> `--Users-x-proj--` (safe as a folder name). */
export function sanitizeWorkspaceKey(cwd: string): string {
  const clean = cwd.trim().replaceAll("/", "-").replace(/^[-]+|[-]+$/g, "");
  return clean ? `--${clean}--` : "--global--";
}

export interface ResolvedHome {
  /** Base directory for all extension data (env override or VS Code globalStorage). */
  home: string;
  /** Per-workspace sessions directory under `home`. */
  sessionsDir: string;
}

export interface ResolveHomeOptions {
  /** Absolute path of the extension's VS Code globalStorage directory. */
  globalStorageFsPath: string;
  /** Current workspace root (used to scope sessions per-project). */
  workspaceCwd?: string;
  /** Process environment, used for the HARNY_HOME override. */
  env?: Record<string, string | undefined>;
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
 * Sessions are stored per workspace in `home/sessions/<workspaceKey>/`,
 * mirroring pi and Cursor.
 */
export function resolveHome(opts: ResolveHomeOptions): ResolvedHome {
  const envOverride = opts.env?.[HARNY_HOME_ENV]?.trim();
  const home = envOverride || opts.globalStorageFsPath;
  const workspaceCwd = opts.workspaceCwd?.trim();
  const sessionsDir = join(home, "sessions", sanitizeWorkspaceKey(workspaceCwd || "global"));
  return { home, sessionsDir };
}
