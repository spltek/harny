import { spawn } from "node:child_process";
import { isWindows } from "../platform";

/**
 * Kill a spawned child AND its descendants. A plain `child.kill()` signals only
 * the shell/process itself, leaving grandchildren (a dev server, a watcher, an
 * MCP server's own children…) alive.
 *
 * On POSIX the child must be a process-GROUP leader (`detached: true`) so the
 * whole group can be signalled with `process.kill(-pid, …)`; on Windows
 * `taskkill /T /F` walks the tree. Best-effort: never throws.
 */
export function killTree(child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (isWindows) {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
