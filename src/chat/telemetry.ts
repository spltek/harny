import { monitorEventLoopDelay } from "node:perf_hooks";
import { debugLog } from "../logger";
import { dbMetrics, resetDbMetrics } from "../core/sessions/store-metrics";

/** Resolution of the event-loop histogram (ms): a stall shorter than this is not distinguishable
 *  from a healthy loop. Same 50 ms granularity the 20 Hz JS probe had — at 1/600th of the cost. */
export const RESOLUTION_MS = 50;
/** How often a line is emitted (only when something moved). This is ALSO the only timer telemetry
 *  owns: the probe itself runs in native code and never calls back into JavaScript. */
const REPORT_EVERY_MS = 30_000;
/** A lag above this counts as "the host was busy" and forces a report. */
const BUSY_LAG_MS = 25;

export interface TelemetrySnapshot {
  /** Event-loop delay: how LATE a timer fired, in ms. The single most honest signal that the host
   *  is saturated (and in a single-threaded host, EVERYTHING shares that thread: streaming, SQLite
   *  writes, tool spawns). */
  loopAvgMs: number;
  loopP95Ms: number;
  loopMaxMs: number;
  /** Messages posted to the webview since the last report, and their size. */
  posts: number;
  postBytes: number;
}

/** The lag numbers as the class needs them. An interface, not a direct call, because a native
 *  histogram cannot be advanced by a fake clock: a test that owns this seam is deterministic,
 *  while a test driving `setInterval` would measure the machine it runs on. */
export interface LagProbe {
  start(): void;
  stop(): void;
  /** Mean, p95 and worst delay since the last `reset`, in MILLISECONDS. */
  read(): { avgMs: number; p95Ms: number; maxMs: number };
  reset(): void;
}

/**
 * The real probe: `perf_hooks.monitorEventLoopDelay` keeps the histogram in native code.
 *
 * It replaces a `setInterval(tick, 50)` that woke the host **20 times a second, forever**, to find
 * out whether the host was busy — a measurement that perturbs what it measures and that a sleeping
 * extension host can never escape while a panel is open. The histogram is sampled by a native timer
 * with no JavaScript callback, so a healthy loop costs nothing at all, and the p95/max (the numbers
 * that actually identify saturation) are read only when a line is about to be printed.
 */
export class NativeLagProbe implements LagProbe {
  private histogram: ReturnType<typeof monitorEventLoopDelay> | undefined;

  start(): void {
    if (this.histogram) return;
    this.histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    this.histogram.enable();
  }

  stop(): void {
    this.histogram?.disable();
    this.histogram = undefined;
  }

  read(): { avgMs: number; p95Ms: number; maxMs: number } {
    const h = this.histogram;
    if (!h) return { avgMs: 0, p95Ms: 0, maxMs: 0 };
    // The histogram counts NANOSECONDS; the log speaks milliseconds.
    return { avgMs: h.mean / 1e6, p95Ms: h.percentile(95) / 1e6, maxMs: h.max / 1e6 };
  }

  reset(): void {
    this.histogram?.reset();
  }
}

/**
 * Cheap, always-on measurement of the two walls that matter when several sessions run at once: the
 * event loop (shared by every session) and the webview channel.
 *
 * It never decides anything: it prints ONE line every 30 s through `debugLog`, which is gated by
 * `HARNY_DEBUG`, so with the flag off the cost is two counters — and ONE timer wake-up per window.
 */
export class Telemetry {
  private posts = 0;
  private postBytes = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly probe: LagProbe;

  constructor(deps: { probe?: LagProbe } = {}) {
    this.probe = deps.probe ?? new NativeLagProbe();
  }

  /** Begin sampling (idempotent). The interval is UNREF'd: telemetry must never keep the extension
   *  host alive on its own. */
  start(): void {
    if (this.timer) return;
    this.probe.start();
    this.timer = setInterval(() => this.report(), REPORT_EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.probe.stop();
  }

  /** Count one message posted to the webview. The size is APPROXIMATE on purpose: a JSON.stringify
   *  per token would cost more than the traffic it measures. */
  notePost(message: unknown): void {
    this.posts++;
    const content = (message as { content?: unknown } | null)?.content;
    this.postBytes += typeof content === "string" ? content.length + 64 : 96;
  }

  /** Current window, already rounded for the log. Reading the probe does NOT reset it: only the
   *  end of a window does. */
  snapshot(): TelemetrySnapshot {
    const { avgMs, p95Ms, maxMs } = this.probe.read();
    return {
      loopAvgMs: round1(avgMs),
      loopP95Ms: round1(p95Ms),
      loopMaxMs: round1(maxMs),
      posts: this.posts,
      postBytes: this.postBytes,
    };
  }

  /** Close one window: log it if anything moved, then start the next one from zero.
   *
   *  Public so a test drives the clock instead of waiting 30 s — and so that the rule ("an idle
   *  host prints nothing; a busy one prints once") is asserted on behaviour, not on a timer. */
  report(): void {
    const snap = this.snapshot();
    // An idle host prints nothing: the line exists to catch saturation, not to prove the probe runs.
    if (this.posts > 0 || snap.loopMaxMs >= BUSY_LAG_MS) {
      debugLog("[telemetry]", JSON.stringify({ ...snap, db: dbMetrics() }));
    }
    this.posts = 0;
    this.postBytes = 0;
    this.probe.reset();
    resetDbMetrics();
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
