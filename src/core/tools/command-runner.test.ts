import { describe, it, expect } from "vitest";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { NodeCommandRunner } from "./command-runner";

const runner = new NodeCommandRunner();
const cwd = process.cwd();

// Commands are written with `node -e "…"` so they run IDENTICALLY through the
// native shell on every OS (cmd.exe on Windows, sh/zsh on POSIX) — no `echo`,
// `sleep`, `pwd` or `/tmp`.
const node = (script: string): string => `node -e "${script}"`;

describe("NodeCommandRunner", () => {
  it("runs a command and captures stdout with exit code 0", async () => {
    const res = await runner.run(node("console.log('hello')"), { cwd, timeoutMs: 5000 });
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe("hello");
    expect(res.timedOut).toBe(false);
  });

  it("captures non-zero exit codes with stderr", async () => {
    const res = await runner.run(node("console.error('oops'); process.exit(3)"), { cwd, timeoutMs: 5000 });
    expect(res.code).toBe(3);
    expect(res.stderr).toContain("oops");
  });

  it("reports timeouts", async () => {
    const res = await runner.run(node("setTimeout(() => {}, 10000)"), { cwd, timeoutMs: 300 });
    expect(res.timedOut).toBe(true);
    expect(res.code).not.toBe(0);
  });

  it("honors the working directory", async () => {
    const res = await runner.run(node("console.log(process.cwd())"), { cwd: tmpdir(), timeoutMs: 5000 });
    // realpath both sides: on macOS `tmpdir()` is `/var/...` while the child
    // reports `/private/var/...` (same dir through a symlink).
    expect(realpathSync(res.stdout.trim())).toBe(realpathSync(tmpdir()));
  });

  it("does not block the event loop while the command runs (async spawn)", async () => {
    // A synchronous runner (spawnSync) would freeze the timer below; the async
    // one must let it fire while the command is still running.
    let ticked = false;
    const tick = new Promise<void>((resolve) =>
      setTimeout(() => {
        ticked = true;
        resolve();
      }, 30),
    );
    const run = runner.run(node("setTimeout(() => {}, 500)"), { cwd, timeoutMs: 5000 });
    await tick;
    expect(ticked).toBe(true);
    await run;
  });

  it("cancels a running command when the signal aborts", async () => {
    const controller = new AbortController();
    const pending = runner.run(node("setTimeout(() => {}, 10000)"), {
      cwd,
      timeoutMs: 10000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const res = await pending;
    expect(res.aborted).toBe(true);
    expect(res.timedOut).toBe(false);
  });
});
