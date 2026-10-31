import { describe, it, expect, vi, afterEach } from "vitest";
import { ROOT_WATCH_INTERVAL_MS, WorkspaceRootWatch, type RootWatchDeps } from "./workspace-watch";

/**
 * The one thing the panel cannot wait for: the workspace folder disappearing while nobody
 * touches anything. What is asserted here is the RULE (report a CHANGE, both ways, never
 * twice), and only one test looks at the clock at all.
 */

/** A fake filesystem: a set of paths that "exist", and a movable root. */
function fakeFs(root: string | undefined): {
  deps: Omit<RootWatchDeps, "onChange"> & { onChange: ReturnType<typeof vi.fn> };
  setRoot: (next: string | undefined) => void;
  onDisk: Set<string>;
} {
  const onDisk = new Set<string>();
  let current = root;
  if (root) onDisk.add(root);
  const onChange = vi.fn();
  return {
    deps: { root: () => current, exists: (p) => onDisk.has(p), onChange },
    setRoot: (next) => {
      current = next;
    },
    onDisk,
  };
}

/**
 * Every watcher a test starts is stopped afterwards.
 *
 * `start()` arms a real 5 s interval: `unref` keeps the process alive-able, but nothing
 * stops the polling itself, so a suite that forgets to `stop()` leaves timers running for
 * the whole file (and Vitest reports the open handles).
 */
const started: WorkspaceRootWatch[] = [];

function makeWatch(d: RootWatchDeps): WorkspaceRootWatch {
  const watch = new WorkspaceRootWatch(d);
  started.push(watch);
  return watch;
}

afterEach(() => {
  for (const watch of started.splice(0)) watch.stop();
  vi.useRealTimers();
});

describe("WorkspaceRootWatch", () => {
  it("reports a folder that disappears, exactly once", () => {
    const { deps: d, onDisk } = fakeFs("/p/ws");
    const watch = makeWatch(d);
    watch.start();
    onDisk.delete("/p/ws");
    watch.check();
    watch.check(); // a second poll sees the same verdict: it must NOT fire again
    expect(d.onChange).toHaveBeenCalledTimes(1);
    expect(d.onChange).toHaveBeenCalledWith("/p/ws", false);
  });

  it("reports the folder coming BACK (a mount that returns)", () => {
    const { deps: d, onDisk } = fakeFs("/p/ws");
    const watch = makeWatch(d);
    watch.start();
    onDisk.delete("/p/ws");
    watch.check();
    onDisk.add("/p/ws");
    watch.check();
    expect(d.onChange).toHaveBeenNthCalledWith(2, "/p/ws", true);
  });

  it("says NOTHING when there is no root (that is the home screen, not a lost folder)", () => {
    const { deps: d } = fakeFs(undefined);
    const watch = makeWatch(d);
    watch.start();
    watch.check();
    expect(d.onChange).not.toHaveBeenCalled();
  });

  it("records the startup verdict instead of announcing it (the panel is built with it)", () => {
    // Activating with an already-deleted folder must not produce a spurious "it changed".
    const { deps: d, onDisk } = fakeFs("/p/ws");
    onDisk.delete("/p/ws");
    const watch = makeWatch(d);
    watch.start();
    watch.check();
    expect(d.onChange).not.toHaveBeenCalled();
  });

  it("does not confuse a DIFFERENT root with a change (switching folders reloads the view)", () => {
    const { deps: d, setRoot, onDisk } = fakeFs("/p/a");
    const watch = makeWatch(d);
    watch.start();
    // Both exist: only the path changed, and that has its own refresh path.
    onDisk.add("/p/b");
    setRoot("/p/b");
    watch.check();
    expect(d.onChange).not.toHaveBeenCalled();
  });

  it("polls on its own timer, and stop() ends it", () => {
    vi.useFakeTimers();
    const { deps: d, onDisk } = fakeFs("/p/ws");
    const watch = makeWatch(d);
    watch.start();
    watch.start(); // idempotent: no second timer
    onDisk.delete("/p/ws");
    vi.advanceTimersByTime(ROOT_WATCH_INTERVAL_MS);
    expect(d.onChange).toHaveBeenCalledTimes(1);

    watch.stop();
    onDisk.add("/p/ws");
    vi.advanceTimersByTime(ROOT_WATCH_INTERVAL_MS * 4);
    // Nothing after stop(), even though the verdict changed twice.
    expect(d.onChange).toHaveBeenCalledTimes(1);
  });

  it("honours an explicit interval (the tests and any embedder can speed it up)", () => {
    vi.useFakeTimers();
    const { deps: d, onDisk } = fakeFs("/p/ws");
    const watch = makeWatch({ ...d, intervalMs: 50 });
    watch.start();
    onDisk.delete("/p/ws");
    vi.advanceTimersByTime(49);
    expect(d.onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(d.onChange).toHaveBeenCalledTimes(1);
  });
});

/**
 * The one that a fake cannot prove: `exists` here is the REAL `fs.existsSync` and the folder
 * is REALLY deleted on disk. It is the closest thing to the manual smoke test that runs
 * unattended — the production function, the production poll loop, the real kernel answering.
 */
describe("WorkspaceRootWatch — against a real filesystem", () => {
  it("reports a folder deleted on disk, and again when it comes back", async () => {
    const { existsSync, mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "harny-watch-"));
    const seen: boolean[] = [];
    const watch = new WorkspaceRootWatch({
      root: () => dir,
      exists: existsSync, // ← production, no fake
      onChange: (_root, existsNow) => seen.push(existsNow),
      intervalMs: 5, // real timers, tiny period: the RULE is what matters, not the 5 s
    });
    // Windows: a handle held by the indexer/antivirus makes a fresh delete fail with EPERM,
    // and timer granularity is ~15 ms (not 1 ms). Both are handled here so the test measures
    // the RULE — report a change once, both ways — and not the platform's mood.
    const rm = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 } as const;

    try {
      watch.start();
      await new Promise((r) => setTimeout(r, 100));
      expect(seen).toEqual([]); // nothing changed: silence

      rmSync(dir, rm);
      await new Promise((r) => setTimeout(r, 300));
      expect(seen).toEqual([false]); // ONE report, in one direction

      mkdirSync(dir);
      await new Promise((r) => setTimeout(r, 300));
      expect(seen).toEqual([false, true]); // a mount that comes back brings the chat back
    } finally {
      watch.stop();
      rmSync(dir, rm);
    }
  });

  it("stays silent when the window has no root to lose (that is the home, not a loss)", async () => {
    const { existsSync } = await import("node:fs");
    const seen: boolean[] = [];
    const watch = new WorkspaceRootWatch({
      root: () => undefined,
      exists: existsSync,
      onChange: (_root, existsNow) => seen.push(existsNow),
      intervalMs: 5,
    });
    try {
      watch.start();
      await new Promise((r) => setTimeout(r, 120));
      expect(seen).toEqual([]);
    } finally {
      watch.stop();
    }
  });
});
