/**
 * Cross-platform helpers — Harny must behave identically on macOS, Linux and
 * Windows. Keep every OS-specific decision HERE (single source of truth) so no
 * tool hardcodes a POSIX path or shell again.
 */

/** True on Windows (win32). */
export const isWindows = process.platform === "win32";

/**
 * Shell used to run a command STRING (the Shell tool and any shell-based
 * tooling). Windows: `ComSpec` (cmd.exe) unless overridden; POSIX: `$SHELL` or
 * `/bin/sh`. NEVER hardcode `/bin/bash`: it does not exist on Windows.
 */
export function defaultShell(): string {
  if (isWindows) return process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
  return process.env.SHELL || "/bin/sh";
}

/** True when the given path is absolute on ANY platform (drive letters, UNC,
 * POSIX root). `node:path`'s isAbsolute is platform-specific, so this is used
 * for inputs that may come from the model in either style. */
export function isAbsoluteAnyPlatform(p: string): boolean {
  return (
    p.startsWith("/") || // POSIX root
    /^[A-Za-z]:[\\/]/.test(p) || // C:\ or C:/
    /^[A-Za-z]:$/.test(p) || // bare drive "C:"
    /^\\\\/.test(p) // UNC \\server\share
  );
}
