/**
 * "The workspace folder is GONE" — noticed even when nobody touches anything.
 *
 * Everything else about a lost folder is REACTIVE: it is detected the next time the panel
 * renders (a click, a config change, the end of a run). That leaves one case uncovered, and
 * it is the one the user actually hits: the folder is deleted from outside (a `rm -rf`, a
 * disconnected mount, a `git clean` in the wrong place) while the panel sits still. The
 * screen would keep claiming a workspace that no longer exists, and the first symptom would
 * be a tool failing with `ENOENT` minutes later.
 *
 * So the root's existence is POLLED: one `stat` every few seconds, which is nothing next to
 * a transcript repaint, and the panel is rebuilt the moment the verdict CHANGES (both ways —
 * a mount that comes back must bring the chat back too).
 *
 * A poll, not `fs.watch`: a watcher on a directory that gets deleted behaves differently on
 * every platform (and cannot even be created if the directory is already gone at startup),
 * while `exists` + a timer is identical everywhere and never needs re-arming. The timer is
 * `unref`'d so it can never keep the host alive on its own.
 */

/** What the watcher needs from its surroundings (all injectable: the class is pure). */
export interface RootWatchDeps {
  /** The current workspace root, `undefined` when the window has none. */
  root(): string | undefined;
  /** Whether that path is still on disk (`fs.existsSync` in production; must not throw). */
  exists(path: string): boolean;
  /** The verdict changed and the panel must be rebuilt (chat ⇄ home). */
  onChange(root: string, existsNow: boolean): void;
  /** Poll period; the default is a compromise between "instant" and "free". */
  intervalMs?: number;
}

/** One stat every five seconds: coarse enough to be invisible, quick enough to feel live. */
export const ROOT_WATCH_INTERVAL_MS = 5_000;

/**
 * Watches ONE thing: whether the workspace root is still there.
 *
 * It is deliberately not a general filesystem watcher — no events for files, no recursion,
 * no debouncing — because the only question the UI asks is "can I still work here?".
 */
export class WorkspaceRootWatch {
  private timer: ReturnType<typeof setInterval> | undefined;
  /** The verdict the last poll reported (`undefined` = nothing known/reported yet). */
  private last: boolean | undefined;

  constructor(private readonly deps: RootWatchDeps) {}

  /** Begin polling. Idempotent: a second call does not start a second timer. */
  start(): void {
    if (this.timer !== undefined) return;
    // Record the CURRENT verdict without reporting it: the panel is being built with it.
    const root = this.deps.root();
    this.last = root ? this.deps.exists(root) : undefined;
    this.timer = setInterval(() => this.check(), this.deps.intervalMs ?? ROOT_WATCH_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Stop polling (the extension is going away). */
  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One poll — the whole behaviour, in five lines.
   *
   * Public on purpose: a test drives the state machine without waiting on a timer, so what
   * is asserted is the RULE, not the clock.
   */
  check(): void {
    const root = this.deps.root();
    if (!root) {
      // No root at all is the home screen, not a "lost folder": nothing to announce.
      this.last = undefined;
      return;
    }
    const existsNow = this.deps.exists(root);
    if (this.last !== undefined && this.last !== existsNow) this.deps.onChange(root, existsNow);
    this.last = existsNow;
  }
}
