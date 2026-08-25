import { describe, it, expect } from "vitest";
import { NodeCommandRunner } from "./command-runner";

const runner = new NodeCommandRunner();
const cwd = process.cwd();

describe("NodeCommandRunner", () => {
  it("runs a command and captures stdout with exit code 0", () => {
    const res = runner.run("echo hello", { cwd, timeoutMs: 5000 });
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe("hello");
    expect(res.timedOut).toBe(false);
  });

  it("captures non-zero exit codes with stderr", () => {
    const res = runner.run("echo oops >&2 && exit 3", { cwd, timeoutMs: 5000 });
    expect(res.code).toBe(3);
    expect(res.stderr).toContain("oops");
  });

  it("reports timeouts", () => {
    const res = runner.run("sleep 5", { cwd, timeoutMs: 300 });
    expect(res.timedOut).toBe(true);
    expect(res.code).not.toBe(0);
  });

  it("honors the working directory", () => {
    const res = runner.run("pwd", { cwd: "/tmp", timeoutMs: 5000 });
    expect(res.stdout.trim()).toMatch(/\/tmp$/);
  });
});
