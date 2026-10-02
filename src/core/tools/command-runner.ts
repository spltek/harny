import { spawnSync } from "node:child_process";
import { defaultShell } from "../platform";

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
    const res = spawnSync(command, {
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
