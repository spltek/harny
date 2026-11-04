import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SqliteSessionStore } from "./sqlite-session-store";
import { dbMetrics, resetDbMetrics } from "./store-metrics";
import type { FileSystem } from "../tools/file-system";
import type { ChatMessage } from "../history/types";

/**
 * A MEASURED test of the wall that decides whether the SQLite writer has to move to
 * a worker thread: the store is SYNCHRONOUS on the single extension-host thread, so a
 * slow COMMIT is a stall for every OTHER session's stream.
 *
 * Why a test and not a profiler session: this answers the question REPEATABLY and
 * stays as a regression guard. The thresholds are deliberately generous (a factor
 * too loose beats a flaky suite) and the assertions are mostly about SHAPE — O(1) vs
 * O(n) — because shape is what survives a slower machine. The measured numbers are
 * printed, so `npm test` is also the benchmark.
 *
 * The cost model that matters for the multi-session promise:
 *  · an append must cost the SAME for a 20-message session and a 400-message one
 *    (re-writing the whole history per message would be O(n) and would explode as
 *    sessions grow — that is the failure mode these tests exist to catch);
 *  · the SETTINGS write (a summary upsert + a count query) must stay in the
 *    sub-millisecond range, because it is per-turn by nature.
 */

function fakeFs(): FileSystem {
  return {
    readText: () => "",
    readBytes: () => Buffer.alloc(0),
    writeText: () => {},
    exists: () => true,
    list: () => [],
    size: () => 0,
    mkdirRecursive: () => {},
  } as unknown as FileSystem;
}

const msg = (role: ChatMessage["role"], content: string, timestamp = 1): ChatMessage => ({
  role,
  content,
  timestamp,
});

/** A message shaped like the real thing: a parallel session carries tool calls and
 * long outputs, which is what actually lands in the row. */
function heavyMessage(i: number): ChatMessage {
  // A SOUND conversation (user/assistant alternation, no tool calls): `load()` now salvages
  // a damaged tail (see `session-recovery.ts`), so a fixture of orphan tool results would
  // measure the cost of a 1-message session and call it 300.
  return {
    role: i % 2 === 0 ? "user" : "assistant",
    content: `step ${i}: ${"x".repeat(400)}`,
    timestamp: 1_700_000_000_000 + i,
  };
}

let db: DatabaseSync;
let store: SqliteSessionStore;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  store = new SqliteSessionStore({
    db,
    fs: fakeFs(),
    idGen: (() => {
      let n = 0;
      return () => `s${++n}`;
    })(),
  });
  resetDbMetrics();
});

afterEach(() => {
  resetDbMetrics();
  store.close();
});

/** Median of the per-call timings, which is far more stable than the mean. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

describe("SqliteSessionStore — does the writer have to leave the host thread?", () => {
  it("an append costs the SAME at 20 messages and at 400 (O(1), not a re-write)", () => {
    const id = store.create("perf").id;

    // Warm-up: the first transaction also prepares the statements.
    store.saveMessages(id, [heavyMessage(0), heavyMessage(1)]);

    const timeAppends = (from: number, count: number): number => {
      const history: ChatMessage[] = [];
      const samples: number[] = [];
      // Build the prefix in ONE call, then measure single appends on top of it.
      for (let i = 0; i < from; i++) history.push(heavyMessage(i));
      store.saveMessages(id, [...history], { replace: true });
      for (let i = 0; i < count; i++) {
        history.push(heavyMessage(from + i));
        const t0 = performance.now();
        store.saveMessages(id, history);
        samples.push(performance.now() - t0);
      }
      return median(samples);
    };

    const small = timeAppends(20, 25); // appends on a 20-message history
    const large = timeAppends(400, 25); // the same append on a 400-message one

    console.log(
      `[db] append median: 20 msgs ${small.toFixed(2)}ms · 400 msgs ${large.toFixed(2)}ms ` +
        `(ratio ${(large / Math.max(small, 0.001)).toFixed(2)}x)`,
    );

    // A whole-history rewrite would show a ~20x ratio here. Allow 4x for noise.
    expect(large).toBeLessThan(small * 4 + 0.5);
    // And an append must be fast in absolute terms on any sane machine.
    expect(large).toBeLessThan(20);
  });

  it("20 sessions × 15 turns: the per-write p95 stays in single-digit milliseconds", () => {
    const sessions = Array.from({ length: 20 }, (_, i) => store.create(`s${i}`).id);
    const histories = new Map<string, ChatMessage[]>(sessions.map((id) => [id, []]));

    // Warm-up one transaction per session (statement preparation is one-off).
    for (const id of sessions) store.saveMessages(id, [heavyMessage(0)]);

    resetDbMetrics();
    const startedAt = performance.now();
    // Interleaved exactly as the host does it: one turn per session, round-robin, so
    // the pattern matches 20 streaming sessions rather than 20 sequential ones.
    for (let turn = 0; turn < 15; turn++) {
      for (const id of sessions) {
        const history = histories.get(id)!;
        history.push(heavyMessage(turn * 2), heavyMessage(turn * 2 + 1));
        store.saveMessages(id, history);
        store.saveSettings(id, { contextTokens: 1000 + turn });
      }
    }
    const elapsed = performance.now() - startedAt;

    const metrics = dbMetrics();
    const messages = metrics.find((m) => m.op === "saveMessages");
    const settings = metrics.find((m) => m.op === "saveSettings");
    console.log(
      `[db] 20 sessions × 15 turns in ${elapsed.toFixed(0)}ms · ` +
        `saveMessages p95 ${messages?.p95Ms}ms max ${messages?.maxMs}ms (n=${messages?.count}) · ` +
        `saveSettings p95 ${settings?.p95Ms}ms max ${settings?.maxMs}ms (n=${settings?.count})`,
    );

    expect(messages?.count).toBe(300); // every append was timed
    expect(settings?.count).toBe(300);
    // Generous: this is a guard against a structural regression (a rewrite, a missing
    // index, a transaction per message), not a microbenchmark.
    expect(messages!.p95Ms).toBeLessThan(25);
    expect(messages!.maxMs).toBeLessThan(120);
    expect(settings!.p95Ms).toBeLessThan(25);
  });

  it("reading a whole session back is linear in its size (no accidental N+1)", () => {
    const id = store.create("read").id;
    const history = Array.from({ length: 300 }, (_, i) => heavyMessage(i));
    store.saveMessages(id, history);

    const t0 = performance.now();
    const restored = store.load(id).messages;
    const elapsed = performance.now() - t0;

    console.log(`[db] load(300 messages) ${elapsed.toFixed(1)}ms`);
    expect(restored).toHaveLength(300);
    expect(elapsed).toBeLessThan(60);
  });

  it("a 200-message session is a fraction of a millisecond to search", () => {
    const id = store.create("search").id;
    store.saveMessages(
      id,
      Array.from({ length: 200 }, (_, i) => heavyMessage(i)),
    );

    const t0 = performance.now();
    const hits = store.search("step 42");
    const elapsed = performance.now() - t0;

    console.log(`[db] search over 200 messages ${elapsed.toFixed(1)}ms (${hits.length} hits)`);
    expect(hits.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(60);
  });
});
