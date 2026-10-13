import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { killTree } from "./kill-tree";

const isWin = process.platform === "win32";

/** Spawn a parent that spawns a long-lived grandchild and prints its pid. */
function spawnTree(): Promise<{ parent: ChildProcess; grandchildPid: number }> {
  const script = `
    const { spawn } = require("node:child_process");
    const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    process.stdout.write(String(g.pid) + "\\n");
    setInterval(() => {}, 1000);
  `;
  const parent = spawn(process.execPath, ["-e", script], {
    detached: !isWin,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("tree spawn timed out")), 5000);
    parent.stdout!.on("data", (d) => {
      buf += String(d);
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        resolve({ parent, grandchildPid: Number(buf.slice(0, nl)) });
      }
    });
    parent.on("error", reject);
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pids: number[], ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && pids.some(alive)) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("killTree", () => {
  it("kills the child AND its descendants", async () => {
    const { parent, grandchildPid } = await spawnTree();
    try {
      expect(parent.pid).toBeTruthy();
      expect(alive(parent.pid!)).toBe(true);
      expect(alive(grandchildPid)).toBe(true);

      killTree(parent);
      await waitUntilGone([parent.pid!, grandchildPid]);

      expect(alive(parent.pid!)).toBe(false);
      expect(alive(grandchildPid)).toBe(false);
    } finally {
      // Never leak a process if an assertion failed before the kill landed.
      if (parent.pid && alive(parent.pid)) killTree(parent);
      if (alive(grandchildPid)) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    }
  });

  it("is a no-op when the child has no pid", () => {
    expect(() => killTree({ pid: undefined, kill: () => true })).not.toThrow();
  });
});
