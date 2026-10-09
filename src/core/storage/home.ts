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
 * Resolve the cross-platform data directory for the extension, following the
 * VS Code convention:
 *
 * - default: `context.globalStorageUri.fsPath` (the extension's own folder:
 *   `~/Library/Application Support/Code/User/globalStorage/spltek.harny` on
 *   macOS, `%APPDATA%\Code\User\globalStorage\spltek.harny` on Windows,
 *   `~/.config/Code/User/globalStorage/spltek.harny` on Linux)
 * - override: `HARNY_HOME` env var (portable/backup setups)
 *
 * This home hosts the dedicated `config.json` AND the SESSIONS (`sessions.db`,
 * a single SQLite database): centralized — outside the tool/agent folder scope
 * — with each session tagged by its workspace `folder`.
 */
export function resolveHome(opts: ResolveHomeOptions): ResolvedHome {
  const envOverride = opts.env?.[HARNY_HOME_ENV]?.trim();
  const home = envOverride || opts.globalStorageFsPath;
  return { home };
}
