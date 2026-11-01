import { debugLog } from "../logger";
import { dbMetrics, resetDbMetrics } from "../core/sessions/store-metrics";

/** Sampling period of the event-loop probe. */
const TICK_MS = 50;
/** How often a line is emitted (only when something moved). */
const REPORT_EVERY_MS = 30_000;
/** Ring of loop-delay samples kept for the percentiles. */
const RING = 240;
/** A lag above this counts as "the host was busy" and forces a report. */
const BUSY_LAG_MS = 25;

interface TelemetrySnapshot {
  /** Event-loop delay: the drift of a 50 ms timer. The single most honest signal
   * that the host is saturated (and in a single-threaded host, EVERYTHING shares
   * that thread: streaming, SQLite writes, tool spawns). */
  loopAvgMs: number;
  loopP95Ms: number;
  loopMaxMs: number;
  /** Messages posted to the webview since the last report, and their size. */
  posts: number;
  postBytes: number;
}

/**
 * Cheap, always-on measurement of the two walls that matter when several sessions
 * run at once: the event loop (shared by every session) and the webview channel.
 * It never decides anything: it prints ONE line every 30 s through `debugLog`,
 * which is gated by `HARNY_DEBUG`, so with the flag off the cost is a timer tick
 * and two counters.
 */
export class Telemetry {
  private readonly lags: number[] = [];
  private posts = 0;
  private postBytes = 0;
  private lastTick = 0;
  private lastReport = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  /** Begin sampling (idempotent). The interval is UNREF'd: telemetry must never
   * keep the extension host alive on its own. */
  start(): void {
    if (this.timer) return;
    this.lastTick = Date.now();
    this.lastReport = this.lastTick;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Count one message posted to the webview. The size is APPROXIMATE on purpose:
   * a JSON.stringify per token would cost more than the traffic it measures. */
  notePost(message: unknown): void {
    this.posts++;
    const content = (message as { content?: unknown } | null)?.content;
    this.postBytes += typeof content === "string" ? content.length + 64 : 96;
  }

  /** Current window, already rounded for the log. */
  snapshot(): TelemetrySnapshot {
    const sorted = [...this.lags].sort((a, b) => a - b);
    const avg = this.lags.reduce((sum, v) => sum + v, 0) / Math.max(1, this.lags.length);
    return {
      loopAvgMs: round1(avg),
      loopP95Ms: round1(sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0),
      loopMaxMs: round1(sorted.length > 0 ? sorted[sorted.length - 1] : 0),
      posts: this.posts,
      postBytes: this.postBytes,
    };
  }

  private tick(): void {
    const now = Date.now();
    const lag = Math.max(0, now - this.lastTick - TICK_MS);
    this.lastTick = now;
    this.lags.push(lag);
    if (this.lags.length > RING) this.lags.shift();
    if (now - this.lastReport < REPORT_EVERY_MS) return;
    this.lastReport = now;
    const busy = this.posts > 0 || this.lags.some((l) => l >= BUSY_LAG_MS);
    // An idle host prints nothing: the line exists to catch saturation, not to
    // prove the timer runs.
    if (busy) debugLog("[telemetry]", JSON.stringify({ ...this.snapshot(), db: dbMetrics() }));
    this.posts = 0;
    this.postBytes = 0;
    this.lags.length = 0;
    resetDbMetrics();
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
