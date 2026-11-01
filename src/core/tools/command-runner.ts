import { spawn } from "node:child_process";
import { defaultShell, isWindows } from "../platform";
import { killTree } from "../process/kill-tree";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
  /** True when the run was cancelled through the abort signal (Stop). */
  aborted?: boolean;
}

interface CommandRunOptions {
  cwd: string;
  timeoutMs: number;
  maxBuffer?: number;
  /** Cancels the command (kills the process tree) when aborted, e.g. user Stop. */
  signal?: AbortSignal;
}

export interface CommandRunner {
  run(command: string, options: CommandRunOptions): Promise<CommandResult>;
}

/**
 * CommandRunner backed by ASYNCHRONOUS `child_process.spawn`.
 *
 * It must NOT use `spawnSync`: a synchronous run blocks the whole VS Code
 * extension host (no other session can stream, no webview message is handled,
 * the UI freezes) for as long as the command runs. The async runner keeps the
 * host responsive, supports timeout and cancellation, and bounds the captured
 * output.
 */
export class NodeCommandRunner implements CommandRunner {
  run(command: string, options: CommandRunOptions): Promise<CommandResult> {
    // Windows console programs often emit in the OEM code page; force UTF-8 so
    // non-ASCII output is decoded correctly (Node reads it as UTF-8).
    const cmd = isWindows ? `chcp 65001>nul&&${command}` : command;
    const maxBuffer = options.maxBuffer ?? 50 * 1024 * 1024;

    return new Promise<CommandResult>((resolve) => {
      const child = spawn(cmd, {
        cwd: options.cwd,
        shell: defaultShell(),
        windowsHide: true,
        // POSIX: make the shell a process-group leader so killTree can signal
        // the whole tree (-pid).
        detached: !isWindows,
      });

      let stdout = "";
      let stderr = "";
      let captured = 0;
      let timedOut = false;
      let aborted = false;
      let settled = false;

      const finish = (code: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        resolve({ stdout, stderr, code, timedOut, ...(aborted ? { aborted: true } : {}) });
      };

      const capture = (chunk: Buffer, isErr: boolean): void => {
        captured += chunk.length;
        // Bound memory: past the cap the rest of the output is dropped (the
        // command still runs until it exits or the timeout fires).
        if (captured > maxBuffer) return;
        if (isErr) stderr += chunk.toString("utf8");
        else stdout += chunk.toString("utf8");
      };

      child.stdout?.on("data", (chunk: Buffer) => capture(chunk, false));
      child.stderr?.on("data", (chunk: Buffer) => capture(chunk, true));
      child.on("error", (err: Error) => {
        stderr += (stderr ? "\n" : "") + err.message;
        finish(-1);
      });
      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        finish(code ?? (signal ? -1 : 0));
      });

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, options.timeoutMs);

      const onAbort = (): void => {
        aborted = true;
        killTree(child);
      };
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
