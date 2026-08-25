import { join } from "node:path";

export const HARNY_HOME_ENV = "HARNY_HOME";

/** Hidden folder, inside the workspace root, holding the per-folder sessions. */
export const SESSIONS_DIR_NAME = ".harny-sessions";

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
 * Resolve the cross-platform data directory for the extension, following the
 * VS Code convention:
 *
 * - default: `context.globalStorageUri.fsPath` (the extension's own folder:
 *   `~/Library/Application Support/Code/User/globalStorage/spltek.harny` on
 *   macOS, `%APPDATA%\Code\User\globalStorage\spltek.harny` on Windows,
 *   `~/.config/Code/User/globalStorage/spltek.harny` on Linux)
 * - override: `HARNY_HOME` env var (portable/backup setups)
 *
 * This home hosts ONLY the dedicated `config.json` (+ any future global data).
 * SESSIONS are per-workspace: they live in `<workspaceRoot>/.harny-sessions`
 * (see sessionsDirFor), so they follow the folder — rename, move or delete a
 * project and its sessions go with it (no global mapping, no dead entries).
 */
export function resolveHome(opts: ResolveHomeOptions): ResolvedHome {
  const envOverride = opts.env?.[HARNY_HOME_ENV]?.trim();
  const home = envOverride || opts.globalStorageFsPath;
  return { home };
}

/**
 * Sessions directory for a workspace root, or undefined when there is NO
 * single folder to scope to (Harny requires exactly one open folder).
 */
export function sessionsDirFor(workspaceCwd: string | undefined): string | undefined {
  const root = workspaceCwd?.trim();
  return root ? join(root, SESSIONS_DIR_NAME) : undefined;
}