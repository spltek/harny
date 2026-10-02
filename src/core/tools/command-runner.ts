import { spawnSync } from "node:child_process";
import { defaultShell, isWindows } from "../platform";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

export interface CommandRunner {
  run(command: string, options: { cwd: string; timeoutMs: number; maxBuffer?: number }): CommandResult;
}

/**
 * CommandRunner using child_process.spawnSync with a shell.
 */
export class NodeCommandRunner implements CommandRunner {
  run(command: string, options: { cwd: string; timeoutMs: number; maxBuffer?: number }): CommandResult {
    // Windows console programs often emit in the OEM code page; force UTF-8 so
    // non-ASCII output is decoded correctly (Node reads it as UTF-8).
    const cmd = isWindows ? `chcp 65001>nul&&${command}` : command;
    const res = spawnSync(cmd, {
      cwd: options.cwd,
      encoding: "utf-8",
      maxBuffer: options.maxBuffer ?? 50 * 1024 * 1024,
      timeout: options.timeoutMs,
      shell: defaultShell(),
      killSignal: "SIGKILL",
    });
    return {
      stdout: (res.stdout as string) ?? "",
      stderr: (res.stderr as string) ?? "",
      code: res.status ?? -1,
      timedOut:
        (res.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
        res.signal === "SIGKILL" ||
        res.signal === "SIGTERM",
    };
  }
}
