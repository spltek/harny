/**
 * Timings of the SYNCHRONOUS SQLite writes, kept as a small ring per operation.
 *
 * WHY: `node:sqlite` is synchronous and the extension host is ONE thread, so every
 * BEGIN/COMMIT stalls the streaming of every OTHER session. With one session it is
 * invisible; with ten it is the first thing to measure before deciding whether the
 * writer has to move to a worker thread. A profiler answers "where is the time";
 * this answers the cheaper, more useful question: "is the store the wall today?"
 *
 * Cheap by construction: one push per write, a bounded ring per op, and the report
 * is only formatted when the debug telemetry is on (HARNY_DEBUG).
 */
const RING = 200;

interface OpStats {
  count: number;
  totalMs: number;
  maxMs: number;
  samples: number[];
}

const ops = new Map<string, OpStats>();

/** Record one completed operation (called from a `finally`). */
export function noteDbOp(name: string, ms: number): void {
  let s = ops.get(name);
  if (!s) {
    s = { count: 0, totalMs: 0, maxMs: 0, samples: [] };
    ops.set(name, s);
  }
  s.count++;
  s.totalMs += ms;
  if (ms > s.maxMs) s.maxMs = ms;
  s.samples.push(ms);
  if (s.samples.length > RING) s.samples.shift();
}

export interface DbOpMetric {
  op: string;
  /** Writes since the last reset (the COUNT matters as much as the time). */
  count: number;
  avgMs: number;
  /** Tail latency: one slow COMMIT is what freezes the other sessions. */
  p95Ms: number;
  maxMs: number;
}

/** A snapshot for the telemetry line; empty when nothing was written. */
export function dbMetrics(): DbOpMetric[] {
  return [...ops.entries()].map(([op, s]) => {
    const sorted = [...s.samples].sort((a, b) => a - b);
    const p95 = sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
    return {
      op,
      count: s.count,
      avgMs: round(s.totalMs / Math.max(1, s.count)),
      p95Ms: round(p95),
      maxMs: round(s.maxMs),
    };
  });
}

/** Start a new window (called right after a report is emitted). */
export function resetDbMetrics(): void {
  ops.clear();
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
