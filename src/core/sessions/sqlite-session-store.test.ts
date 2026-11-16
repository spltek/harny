import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSessionStore } from "./sqlite-session-store";
import type { FileSystem } from "../tools/file-system";
import type { ChatMessage } from "../history/types";

/**
 * A `describe` for the tests that write REAL megabytes to a real file: `fill()` puts thousands of
 * messages of 2 KB on disk and deletes them, deliberately just under the WAL auto-checkpoint
 * threshold, so it cannot be made cheaper without changing what those tests prove.
 *
 * WHY 60 s AND NOT THE 5 s DEFAULT: 5 s is a macOS/Linux number. Measured on the three runners,
 * this file takes 2.3 s on `ubuntu-24.04`, 4.5 s on `macos-latest` and 14.2 s on a HEALTHY
 * `windows-latest` (17.4 s with the rest of the suite running beside it, so contention is only
 * +23%), where its heaviest test alone costs 1.3–1.7 s. Those numbers repeat within 0.3 s from
 * run to run — which means the timeout is not racing the PLATFORM, it is racing a
 * DEGRADED host: one `windows-latest` run took the same file to 59.9 s, with `a PINNED VACUUM owes
 * a COPY` at 21 s — 16× that test's own normal cost — while the CPU burnt stayed at 15–110 ms per
 * phase. The thread was WAITING on the filesystem, and 20 s was inside that tail, exactly as 5 s
 * had been before it.
 *
 * The assertions are untouched: this ceiling is a HANG GUARD, not a speed assertion. Speed is
 * asserted where it belongs, in `sqlite-store.perf.test.ts`, against p95 thresholds. A real hang
 * still fails, at 60 s. Antivirus is NOT what costs, whatever this note used to claim:
 * `RealTimeProtectionEnabled` is False on `windows-latest`, and a flushed 1 MB write measures p50
 * 7.6 ms / max 15.2 ms there. What costs is the VOLUME — ~34 MB of synchronous writes per case:
 * 8 MB of `fill`, 13 MB rebuilt by the VACUUM, 13 MB copied back by the checkpoint.
 */
const describeRealFileIo = (name: string, fn: () => void) => describe(name, { timeout: 60_000 }, fn);

/**
 * Times one phase of a real-file test and reports it ONLY when it was slow.
 *
 * A bare `Test timed out in 60000ms` says nothing about WHICH movement (`fill`, VACUUM, settle)
 * ate the time, and on a degraded runner that answer is the whole difference between "the host is
 * slow" and "someone made one click cost two VACUUMs". Wall vs CPU is what decides it: a phase
 * that burns 15 ms of CPU in 500 ms of wall clock was WAITING on the filesystem, not computing.
 *
 * Silent under 1 s: every one of these tests has finished under 1.7 s on every platform, so a
 * per-phase log line would be noise — the line exists for the day it is not.
 */
const SLOW_PHASE_MS = 1_000;
function timed<T>(label: string, fn: () => T): T {
  const wall = performance.now();
  const cpu = process.cpuUsage();
  try {
    return fn();
  } finally {
    const wallMs = performance.now() - wall;
    if (wallMs >= SLOW_PHASE_MS) {
      const spent = process.cpuUsage(cpu);
      const cpuMs = (spent.user + spent.system) / 1000;
      // Which of the two it was is the whole point of the line, so it is computed, not asserted:
      // more than half the wall clock spent OFF the CPU means the thread was parked on the disk.
      const verdict =
        wallMs - cpuMs > wallMs / 2
          ? "the thread was WAITING on the filesystem, not computing (degraded host, not this code)"
          : "the CPU was busy the whole time (this code, not the host)";
      console.error(
        `[real-file-io] ${label}: ${wallMs.toFixed(0)} ms of wall clock for ${cpuMs.toFixed(0)} ms of CPU — ${verdict}`,
      );
    }
  }
}

/**
 * Every maintenance call of a real-file store timed, wherever a test makes it.
 *
 * Wrapped here rather than at the ~28 call sites: `maintain()` is both the slowest phase and the
 * one that has timed out twice, and the tests should keep reading as the assertions they are.
 */
function timedMaintenance(store: SqliteSessionStore): SqliteSessionStore {
  const maintain = store.maintain.bind(store);
  const settlePending = store.settlePending.bind(store);
  store.maintain = (options = {}) => timed("maintain (VACUUM + checkpoint)", () => maintain(options));
  store.settlePending = () => timed("settlePending (copy back)", () => settlePending());
  return store;
}

/** In-memory fake filesystem: only `exists` matters (folderMissing). */
function fakeFs(existing: string[] = []): FileSystem {
  const set = new Set(existing);
  return {
    readText: () => "",
    readBytes: () => Buffer.alloc(0),
    writeText: () => {},
    exists: (p: string) => set.has(p),
    list: () => [],
    size: () => 0,
    mkdirRecursive: () => {},
  } as unknown as FileSystem;
}

const msg = (role: ChatMessage["role"], content: string, timestamp = 1): ChatMessage => ({ role, content, timestamp });

/**
 * Every test gets its OWN in-memory database, closed in afterEach: nothing is
 * written to disk and no state leaks between tests.
 */
function makeStore(opts: { existing?: string[]; currentFolder?: () => string | undefined; fs?: FileSystem } = {}) {
  const db = new DatabaseSync(":memory:");
  const store = new SqliteSessionStore({
    db,
    fs: opts.fs ?? fakeFs(opts.existing),
    currentFolder: opts.currentFolder,
    idGen: (() => {
      let n = 0;
      return () => `s${++n}`;
    })(),
  });
  dbs.push(db);
  return { store, db };
}

const dbs: DatabaseSync[] = [];
afterEach(() => {
  // A test may CLOSE its connection itself (the crash ones do: that IS the scenario).
  for (const db of dbs.splice(0))
    try {
      db.close();
    } catch {
      /* already closed by the test */
    }
});

describe("SqliteSessionStore — folderMissing costs ONE stat per DISTINCT folder", () => {
  it("does not probe the filesystem once per session on every list", () => {
    // The list is rebuilt on every render, tab switch, rename, run end… With a stat per ROW, a
    // big history of one project meant hundreds of synchronous syscalls each time (and on a
    // network mount, milliseconds each on the host thread). Sessions share a few folders.
    let probes = 0;
    const base = fakeFs(["/p/a"]);
    const fs = {
      ...base,
      exists: (p: string) => {
        probes++;
        return base.exists(p);
      },
    } as FileSystem;
    const { store } = makeStore({ fs, currentFolder: () => "/p/a" });

    const ids: string[] = [];
    for (let i = 0; i < 60; i++) ids.push(store.create(`s${i}`).id);
    // 40 of them move to a SECOND project (which no longer exists on disk).
    for (const id of ids.slice(0, 40)) store.saveSettings(id, { folder: "/p/gone" });

    probes = 0;
    const rows = store.list();

    // Two folders in play → two stats, however many sessions.
    expect(probes).toBe(2);
    // …and the answer is still per-folder, not one for everybody.
    expect(rows.filter((r) => r.folderMissing).length).toBe(40);
    expect(rows.filter((r) => !r.folderMissing).length).toBe(20);
  });
});

describe("SqliteSessionStore — sessions & messages", () => {
  it("creates a session, lists it and loads it back", () => {
    const { store } = makeStore();
    const created = store.create("Refactor");
    expect(created.id).toBe("s1");
    expect(created.name).toBe("Refactor");

    expect(store.list().map((s) => s.id)).toEqual(["s1"]);

    store.saveMessages("s1", [msg("user", "hello"), msg("assistant", "hi")]);
    const loaded = store.load("s1");
    expect(loaded.summary.messageCount).toBe(2);
    expect(loaded.messages.map((m) => m.content)).toEqual(["hello", "hi"]);
  });

  it("APPENDS only the new tail on a normal save (incremental)", () => {
    const { store, db } = makeStore();
    store.create();
    const all = [msg("user", "one"), msg("assistant", "two")];
    store.saveMessages("s1", all);
    // rowid stays stable for the appended tail => the prefix was NOT rewritten
    const before = db.prepare("SELECT rowid FROM messages WHERE session_id=? ORDER BY seq").all("s1") as {
      rowid: number;
    }[];

    store.saveMessages("s1", [...all, msg("user", "three")]);

    const after = db.prepare("SELECT rowid FROM messages WHERE session_id=? ORDER BY seq").all("s1") as {
      rowid: number;
    }[];
    expect(after.length).toBe(3);
    // The first two rows kept their identity (append, not delete+reinsert).
    expect(after[0].rowid).toBe(before[0].rowid);
    expect(after[1].rowid).toBe(before[1].rowid);
  });

  it("REPLACES when the history SHRINKS (a ✂ cut / compaction)", () => {
    const { store } = makeStore();
    store.create();
    store.saveMessages("s1", [msg("user", "a"), msg("assistant", "b"), msg("user", "c")]);
    store.saveMessages("s1", [msg("user", "a")]); // truncated
    const loaded = store.load("s1");
    expect(loaded.messages.map((m) => m.content)).toEqual(["a"]);
    expect(loaded.summary.messageCount).toBe(1);
  });

  it("REWRITES the head when a rebuild keeps the SAME length (compaction regression)", () => {
    const { store } = makeStore();
    store.create();
    store.saveMessages("s1", [msg("user", "old-A"), msg("assistant", "old-B"), msg("user", "old-C")]);
    // A 1-message span summarized into 2 synthetic messages, keeping 2: the new
    // history has MORE messages than the stored one, so a length-only check
    // would append instead of rewriting.
    const compacted = [
      msg("user", "SUMMARY"),
      msg("assistant", "SUMMARY-BODY"),
      msg("assistant", "old-B"),
      msg("user", "old-C"),
    ];
    store.saveMessages("s1", compacted);
    expect(store.load("s1").messages.map((m) => m.content)).toEqual(["SUMMARY", "SUMMARY-BODY", "old-B", "old-C"]);
  });

  it("REWRITES when a rebuild keeps the same length and the last message coincides", () => {
    const { store } = makeStore();
    store.create();
    store.saveMessages("s1", [msg("user", "a"), msg("assistant", "b"), msg("user", "c"), msg("assistant", "d")]);
    // Same length, same TAIL, different head: the prefix guard must catch it.
    const compacted = [msg("user", "S1"), msg("assistant", "S2"), msg("user", "c"), msg("assistant", "d")];
    store.saveMessages("s1", compacted);
    expect(store.load("s1").messages.map((m) => m.content)).toEqual(["S1", "S2", "c", "d"]);
  });

  it("does not rewrite when the history is identical (idempotent save)", () => {
    const { store, db } = makeStore();
    store.create();
    const all = [msg("user", "one"), msg("assistant", "two")];
    store.saveMessages("s1", all);
    const before = db.prepare("SELECT rowid FROM messages WHERE session_id=? ORDER BY seq").all("s1") as {
      rowid: number;
    }[];
    store.saveMessages("s1", all);
    const after = db.prepare("SELECT rowid FROM messages WHERE session_id=? ORDER BY seq").all("s1") as {
      rowid: number;
    }[];
    expect(after.map((r) => r.rowid)).toEqual(before.map((r) => r.rowid));
    expect(store.load("s1").messages.map((m) => m.content)).toEqual(["one", "two"]);
  });

  it("preserves EVERY field of a message (JSON data column)", () => {
    const { store } = makeStore();
    store.create();
    const rich: ChatMessage = {
      role: "assistant",
      content: "answer",
      timestamp: 42,
      thinking: "deep thought",
      images: ["data:image/png;base64,AAA"],
      toolCalls: [{ id: "c1", name: "Read", arguments: { path: "a.ts" } }],
      attachments: [{ name: "a.txt", path: "/tmp/a.txt", size: 2 }],
      displayText: "shown",
      steer: true,
    };
    // The RESULT of `c1` is part of the fixture on purpose: a lone assistant with an
    // unanswered call is a conversation `load()` now repairs (see session-recovery.ts),
    // and this test is about the FIELDS surviving the round trip, not about that cut.
    const result: ChatMessage = { role: "tool", content: "file body", timestamp: 43, toolCallId: "c1" } as ChatMessage;
    store.saveMessages("s1", [rich, result]);
    expect(store.load("s1").messages[0]).toEqual(rich);
  });

  it("rename and remove", () => {
    const { store } = makeStore();
    store.create("Old");
    store.saveMessages("s1", [msg("user", "x")]);
    expect(store.rename("s1", "New").name).toBe("New");
    expect(store.list()[0].name).toBe("New");

    expect(store.remove("s1")).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.load("s1").messages).toEqual([]);
  });

  it("a save AFTER a remove RESURRECTS the session — deletion is not defended down here", () => {
    // `saveMessages` upserts the session row (INSERT … ON CONFLICT DO UPDATE), which is what
    // makes an incremental append cheap. The consequence is that a writer still holding the
    // id brings the row back: the defence lives UPSTAIRS, where `deleteSession`/`closeTab`
    // refuse a session that is working (`if (this.isWorking(id)) return`) — a run keeps
    // saving its history, and without that guard a deleted session would reappear with a
    // fragment of its transcript.
    //
    // This test exists so nobody concludes, from `remove` alone, that a deletion is final.
    const { store } = makeStore();
    store.create("Doomed");
    store.saveMessages("s1", [msg("user", "one")]);
    store.remove("s1");
    expect(store.list()).toEqual([]);

    store.saveMessages("s1", [msg("user", "written after the delete")]);

    expect(store.list().map((s) => s.id)).toEqual(["s1"]);
    expect(store.load("s1").messages.map((m) => m.content)).toEqual(["written after the delete"]);
  });
});

describe("SqliteSessionStore — per-session settings", () => {
  it("CLEARS the landing point when the patch says undefined (the AUTO value)", () => {
    const { store } = makeStore();
    store.create();
    store.saveSettings("s1", { compactionTargetPercent: 30 });
    expect(store.load("s1").summary.compactionTargetPercent).toBe(30);

    // A key PRESENT with no number clears it: the landing point goes back to AUTO.
    store.saveSettings("s1", { compactionTargetPercent: undefined });
    expect(store.load("s1").summary.compactionTargetPercent).toBeUndefined();
  });

  it("persists settings and carries them across a message save", () => {
    const { store } = makeStore();
    store.create();
    store.saveSettings("s1", {
      model: "gpt-4o",
      modelProvider: "openai",
      thinkingLevel: "high",
      contextWindow: 200000,
      compactionThresholdPercent: 75,
      compactionTargetPercent: 30,
      contextTokens: 12345,
      outputTokens: 4096,
      temperature: 0.2,
      topP: 0.9,
      sampler: "topP",
      maxParallelSubAgents: 6,
      loopGuard: "high",
      loopGuardResponse: true,
      loopGuardParams: { maxNudges: 3 },
      mode: "agent",
      parallel: true,
      toolScope: { mcp: ["files"], off: ["Shell"] },
      folder: "/proj/a",
    });
    store.saveMessages("s1", [msg("user", "hello")]);

    const s = store.load("s1").summary;
    expect(s).toMatchObject({
      model: "gpt-4o",
      modelProvider: "openai",
      thinkingLevel: "high",
      contextWindow: 200000,
      compactionThresholdPercent: 75,
      compactionTargetPercent: 30,
      contextTokens: 12345,
      outputTokens: 4096,
      temperature: 0.2,
      topP: 0.9,
      sampler: "topP",
      maxParallelSubAgents: 6,
      loopGuard: "high",
      loopGuardResponse: true,
      loopGuardParams: { maxNudges: 3 },
      mode: "agent",
      parallel: true,
      toolScope: { mcp: ["files"], off: ["Shell"] },
      folder: "/proj/a",
    });
  });

  it("summary() reads the METADATA without touching the messages", () => {
    // A per-turn reader (the tool scope) needs one setting, not a transcript scan: `load()` would
    // price a toggle as a full message read.
    const { store } = makeStore();
    const created = store.create("meta");
    store.saveSettings(created.id, { toolScope: { mcp: ["files"], off: [], analyze: [] } });
    store.saveMessages(created.id, [msg("user", "one"), msg("assistant", "two")]);

    const summary = store.summary(created.id);
    expect(summary?.name).toBe("meta");
    expect(summary?.toolScope).toEqual({ mcp: ["files"], off: [], analyze: [] });
    // …and an id that is not there is `undefined`, not a fabricated row.
    expect(store.summary("nope")).toBeUndefined();
  });

  it("keeps 'no scope' and 'empty scope' apart, across a save and a reload", () => {
    // The difference is the whole feature: no scope = a session from before it existed (nothing
    // restricted); empty = the user decided this conversation uses no MCP server at all. Storing
    // them the same way would silently re-enable tools the user switched off.
    const { store } = makeStore();
    const a = store.create("fresh")!;
    const loadedA = store.load(a.id).summary;
    expect("toolScope" in loadedA).toBe(false); // never decided: not stored at all

    store.saveSettings(a.id, { toolScope: { mcp: [], off: [], analyze: [] } });
    const b = store.load(a.id).summary;
    expect(b.toolScope).toEqual({ mcp: [], off: [], analyze: [] }); // decided "nothing", and it survived

    // …and "decided nothing" survives a later save that does not mention the scope at all
    // (carrySummary must not drop it).
    store.saveSettings(a.id, { thinkingLevel: "low" });
    expect(store.load(a.id).summary.toolScope).toEqual({ mcp: [], off: [], analyze: [] });
  });

  it("normalizes junk on the way in, so the column never holds it", () => {
    const { store } = makeStore();
    const s = store.create("junk")!;
    store.saveSettings(s.id, { toolScope: { mcp: [" a ", "a", 7], off: [" Shell "], analyze: [" x "] } as never });
    expect(store.load(s.id).summary.toolScope).toEqual({ mcp: ["a"], off: ["Shell"], analyze: ["x"] });
  });

  it("round-trips the per-session Analyze declarations, which is what makes them per-session", () => {
    // The gain of keeping this in `tool_scope` instead of the config file: TWO sessions of the same
    // workspace can disagree about the same tool, and a reload keeps them apart.
    const { store } = makeStore();
    const a = store.create("reader")!;
    const b = store.create("editor")!;
    store.saveSettings(a.id, { toolScope: { mcp: ["files"], off: [], analyze: ["mcp__files__read"] } });
    store.saveSettings(b.id, { toolScope: { mcp: ["files"], off: [], analyze: [] } });
    expect(store.load(a.id).summary.toolScope?.analyze).toEqual(["mcp__files__read"]);
    expect(store.load(b.id).summary.toolScope?.analyze).toEqual([]);
  });

  it("loopGuard: off round-trips, and a legacy 'normal' row loads as 'medium'", () => {
    const { store } = makeStore();
    store.create();
    // OFF is a real stored value, not "unset".
    store.saveSettings("s1", { loopGuard: "off" });
    expect(store.load("s1").summary.loopGuard).toBe("off");
    // A row written before the rename (\"normal\") is migrated on read.
    store.saveSettings("s1", { loopGuard: "normal" as never });
    expect(store.load("s1").summary.loopGuard).toBe("medium");
    // Junk is dropped (undefined = the default preset).
    store.saveSettings("s1", { loopGuard: "bogus" as never });
    expect(store.load("s1").summary.loopGuard).toBeUndefined();
  });

  it("contextTokens: 0 survives a cut + reload (an explicit clear beats the carry-over)", () => {
    const { store } = makeStore();
    store.create();
    store.saveMessages("s1", [msg("user", "a"), msg("assistant", "b")]);
    store.saveSettings("s1", { contextTokens: 12345 });
    expect(store.load("s1").summary.contextTokens).toBe(12345);

    // A ✂ cut: the host saves the shortened history, then clears the fill to 0.
    // saveMessages CARRIES the previous value over, so the explicit 0 must win.
    store.saveMessages("s1", [msg("user", "a")]);
    expect(store.load("s1").summary.contextTokens).toBe(12345); // still carried
    store.saveSettings("s1", { contextTokens: 0 });

    expect(store.load("s1").summary.contextTokens).toBe(0);
  });

  it("Auto (undefined) CLEARS temperature/penalties/topP/sampler", () => {
    const { store } = makeStore();
    store.create();
    store.saveSettings("s1", { temperature: 0.7, presencePenalty: 1, frequencyPenalty: 1, topP: 0.5, sampler: "topP" });
    // A key PRESENT with value undefined clears the field (the "Auto" semantics).
    store.saveSettings("s1", {
      temperature: undefined,
      presencePenalty: undefined,
      frequencyPenalty: undefined,
      topP: undefined,
      sampler: undefined,
    });

    const s = store.load("s1").summary;
    expect(s.temperature).toBeUndefined();
    expect(s.presencePenalty).toBeUndefined();
    expect(s.frequencyPenalty).toBeUndefined();
    expect(s.topP).toBeUndefined();
    expect(s.sampler).toBeUndefined();
  });

  it("stamps the CURRENT folder on create and annotates a missing one", () => {
    const { store } = makeStore({ existing: ["/proj/a"], currentFolder: () => "/proj/a" });
    const created = store.create();
    expect(created.folder).toBe("/proj/a");
    // /proj/a exists => not missing.
    expect(store.list()[0].folderMissing).toBeUndefined();

    // A folder that no longer exists is flagged at list time.
    store.saveSettings(created.id, { folder: "/proj/gone" });
    expect(store.list()[0].folderMissing).toBe(true);
  });
});

describe("SqliteSessionStore — full-text search", () => {
  function seed() {
    const { store } = makeStore();
    const a = store.create("Rome");
    store.saveMessages(a.id, [msg("user", "Find the temperature in Rome"), msg("assistant", "Rome is warm")]);
    const b = store.create("Florence");
    store.saveMessages(b.id, [msg("user", "and the weather in Florence")]);
    return { store, a, b };
  }

  it("finds messages across sessions and returns a highlighted snippet", () => {
    const { store } = seed();
    const hits = store.search("rome");
    expect(hits.map((h) => h.sessionId)).toEqual(["s1", "s1"]); // two matches in Rome
    expect(hits[0].snippet).toContain("[Rome]");
    expect(hits[0].score).toBeLessThanOrEqual(hits[1].score); // BM25 ascending
  });

  it("matches multiple terms (AND) and respects the limit", () => {
    const { store } = seed();
    expect(store.search("rome temperature").map((h) => h.sessionId)).toEqual(["s1"]);
    expect(store.search("rome OR florence", 1).length).toBe(1);
  });

  it("an empty query returns nothing", () => {
    const { store } = seed();
    expect(store.search("   ")).toEqual([]);
  });

  it("drops the FTS rows when a session is removed", () => {
    const { store, a } = seed();
    expect(store.search("rome").length).toBeGreaterThan(0);
    store.remove(a.id);
    expect(store.search("rome")).toEqual([]);
  });
});

describe("SqliteSessionStore — SQL-injection safety", () => {
  it("a malicious SEARCH query is treated as data (parameterized MATCH)", () => {
    const { store, db } = makeStore();
    store.create();
    store.saveMessages("s1", [msg("user", "hello world")]);

    const evil = "'); DROP TABLE messages; --";
    expect(() => store.search(evil)).not.toThrow();
    // Tables are intact and still hold the data.
    expect((db.prepare("SELECT count(*) c FROM messages").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT count(*) c FROM sessions").get() as { c: number }).c).toBe(1);
  });

  it("a malicious ID never matches (parameterized lookups/removals)", () => {
    const { store } = makeStore();
    store.create("A");
    store.create("B");
    const evil = "x' OR '1'='1";

    expect(store.load(evil).messages).toEqual([]);
    expect(store.remove(evil)).toBe(false);
    expect(store.list().length).toBe(2); // nothing deleted
  });
});

describe("SqliteSessionStore — vacuum stats & maintenance", () => {
  it("dbVacuumStats reports free vs total pages (O(1))", () => {
    const { store } = makeStore();
    store.create();
    const s = store.dbVacuumStats();
    expect(s.pageCount).toBeGreaterThan(0);
    expect(s.pageSize).toBeGreaterThan(0);
    expect(s.bytesTotal).toBe(s.pageCount * s.pageSize);
    expect(s.freePages).toBe(0);
    expect(s.ratio).toBe(0);
    // `:memory:`: there is no file to measure, so no footprint is claimed.
    expect(s.bytesOnDisk).toBeUndefined();
    expect(s.walBytes).toBeUndefined();
  });

  it("maintain VACUUMs when free pages dominate and reports before/after", () => {
    const { store } = makeStore();
    store.create();
    store.saveMessages(
      "s1",
      Array.from({ length: 3000 }, (_, i) => msg("user", "x".repeat(2000) + i)),
    );
    store.remove("s1"); // every page becomes free
    expect(store.dbVacuumStats().ratio).toBeGreaterThanOrEqual(0.2);

    const r = store.maintain({ freeRatioThreshold: 0.2 });
    expect(r.vacuumed).toBe(true);
    expect(r.before.ratio).toBeGreaterThanOrEqual(0.2);
    expect(r.after.freePages).toBe(0);
    expect(typeof r.durationMs).toBe("number");
  });

  it("maintain is a no-op below the threshold (and never throws)", () => {
    const { store } = makeStore();
    store.create();
    store.saveMessages("s1", [msg("user", "small")]);
    const r = store.maintain({ freeRatioThreshold: 0.5 });
    expect(r.vacuumed).toBe(false);
    expect(r.after.ratio).toBe(r.before.ratio);
  });
});

describe("SqliteSessionStore — vacuum force", () => {
  it("a forced click does NOT rewrite a file that has no free page", () => {
    const { store } = makeStore();
    store.create();
    store.saveMessages("s1", [msg("user", "a")]);
    const r = store.maintain({ freeRatioThreshold: 0 });
    // Threshold 0 means "ignore the ratio", NOT "VACUUM whatever it costs": a pass with an empty
    // free list reclaims ZERO bytes and rewrites the whole database anyway. That is what made the
    // panel say "Vacuumed & optimized in 0.0s" on numbers that could not possibly move, click
    // after click, while the user read it as "it is still doing something".
    expect(r.vacuumed).toBe(false);
    expect(r.before.freePages).toBe(0);
    // The free list stays empty and nothing is rewritten. (The page COUNTER may move by one: the
    // FTS optimize can add a segment page — that is the index work, not a compaction.)
    expect(r.after.freePages).toBe(0);
    expect(r.error).toBeUndefined();
    // `:memory:` has no WAL to hand anything back to: nothing is ever owed, nothing to settle.
    expect(r.pendingMaintenance).toBe("none");
    expect(store.pendingMaintenance()).toBe("none");
    expect(store.settlePending()).toBeUndefined();
  });

  it("a forced click with free pages to reclaim still runs the VACUUM", () => {
    const { store } = makeStore();
    const id = store.create().id;
    // Enough rows that deleting them empties whole pages: below that the free list stays 0 and
    // there is genuinely nothing for a VACUUM to reclaim.
    store.saveMessages(
      id,
      Array.from({ length: 400 }, (_, i) => msg("user", "x".repeat(2000) + i)),
    );
    store.remove(id);
    expect(store.dbVacuumStats().freePages).toBeGreaterThan(0);

    const r = store.maintain({ freeRatioThreshold: 0 });

    expect(r.vacuumed).toBe(true);
    expect(r.after.freePages).toBe(0);
  });
});

describe("SqliteSessionStore — vacuum also optimizes the indexes", () => {
  it("maintain runs the FTS5 optimize without breaking search", () => {
    const { store } = makeStore();
    const s1 = store.create().id;
    store.saveMessages(
      s1,
      Array.from({ length: 400 }, (_, i) => msg(i % 2 ? "assistant" : "user", "hello world " + i + "x".repeat(2000))),
    );
    store.remove(s1); // free pages + FTS segments to merge

    const r = store.maintain({ freeRatioThreshold: 0 });
    expect(r.vacuumed).toBe(true);

    // The full-text index survived the optimize and still matches NEW rows.
    const s2 = store.create().id;
    store.saveMessages(s2, [msg("user", "hello again")]);
    expect(store.search("hello").some((h) => h.sessionId === s2)).toBe(true);
  });
});

describeRealFileIo("SqliteSessionStore — a compaction that does not reach the FILE says so", () => {
  // WHY THIS BLOCK EXISTS: the tests above run on `:memory:`, where `journal_mode = WAL` is a
  // no-op and VACUUM truncates the database on the spot. In PRODUCTION the pages a VACUUM
  // rebuilds live in `sessions.db-wal` until a checkpoint copies them back — and a checkpoint
  // that cannot run reports `busy` instead of throwing, while `exec()` throws the row away. So
  // a run that HAD compacted could report "nothing to reclaim" and leave the file its old size,
  // and the run after it (the second click) looked like the only one that did anything.
  const dirs: string[] = [];
  const dbs: DatabaseSync[] = [];
  /** sessions.db + its -wal: the whole footprint, which is what "did it empty" means. */
  const footprint = (file: string): number =>
    statSync(file).size + (existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0);
  const openFile = (): { store: SqliteSessionStore; file: string } => {
    const dir = mkdtempSync(join(tmpdir(), "harny-vacuum-"));
    dirs.push(dir);
    const file = join(dir, "sessions.db");
    const db = new DatabaseSync(file);
    dbs.push(db);
    const fs = {
      ...fakeFs(),
      exists: (p: string) => existsSync(p),
      size: (p: string) => statSync(p).size,
    } as unknown as FileSystem;
    // 50 ms of busy_timeout: the point of the second test is that a BUSY checkpoint is
    // REPORTED, not that it is waited out.
    const store = new SqliteSessionStore({ db, fs, dbPath: file, busyTimeoutMs: 50, idGen: () => "s1" });
    return { store: timedMaintenance(store), file };
  };
  afterEach(() => {
    for (const db of dbs.splice(0))
      try {
        db.close();
      } catch {
        /* already closed by the test */
      }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const fill = (store: SqliteSessionStore): void => {
    store.create("big");
    timed("fill (2000 messages, 8 MB)", () =>
      store.saveMessages(
        "s1",
        Array.from({ length: 2000 }, (_, i) => msg("user", "x".repeat(2000) + i)),
      ),
    );
    timed("fill (remove, every page free)", () => store.remove("s1"));
  };

  it("dbVacuumStats carries the footprint BEFORE any click (the panel opens on these numbers)", () => {
    const { store, file } = openFile();
    fill(store);
    // The panel's first render used to show only page counters: the "8.8 MB on disk (64 KB in
    // the WAL)" line appeared for the first time AFTER the click, so the number the user was
    // watching had nothing to be compared with.
    const s = store.dbVacuumStats();
    expect(s.bytesOnDisk).toBe(statSync(file).size);
    expect(typeof s.walBytes).toBe("number");
    expect(s.bytesTotal).toBe(s.pageCount * s.pageSize);
  });

  it("ONE maintain() empties the file, not just the page counters", () => {
    const { store, file } = openFile();
    fill(store);
    const before = footprint(file);

    const r = store.maintain({ freeRatioThreshold: 0 });

    expect(r.vacuumed).toBe(true);
    expect(r.after.freePages).toBe(0);
    // No reader on the file: the checkpoint at the end CAN run, and it must — first call.
    expect(r.walCheckpointBusy).toBeUndefined();
    expect(footprint(file)).toBeLessThan(before);
    // The report carries the number the user reads in Finder, not only the logical one.
    expect(r.after.bytesOnDisk).toBe(statSync(file).size);
  });

  it("the SECOND click on an already-compact file writes nothing (no reader needed)", () => {
    const { store, file } = openFile();
    fill(store);
    const first = store.maintain({ freeRatioThreshold: 0 });
    expect(first.vacuumed).toBe(true);
    const emptied = footprint(file);

    // Reported from the panel: "I click once and something moves, I click again and the numbers
    // move again, then nothing ever moves". The numbers had nowhere left to go — no free page —
    // but the click kept rewriting the whole file to reclaim zero bytes and reported "Vacuumed &
    // optimized", so real work and no work looked exactly the same in the panel.
    const second = store.maintain({ freeRatioThreshold: 0 });

    expect(second.vacuumed).toBe(false);
    expect(second.before.freePages).toBe(0);
    expect(second.after.freePages).toBe(0);
    expect(second.walCheckpointBusy).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(footprint(file)).toBe(emptied);
  });

  it("a reader pins the file: the first run cannot know, every run AFTER it writes NOTHING", () => {
    const { store, file } = openFile();
    fill(store);
    const before = footprint(file);

    // A second connection holding a read snapshot: the next VS Code window on the same file.
    // WAL lets the VACUUM run, but no checkpoint can copy PAST the reader's mark — so the
    // rebuilt pages pile up in the `-wal`: measured, each pass took the FILE of a 19 MB database
    // from 100 to 120 to 140 MB while the page counters said "compacted" all along.
    const reader = new DatabaseSync(file);
    dbs.push(reader);
    reader.exec("BEGIN; SELECT count(*) FROM messages;");

    // 1st run: the WAL is empty and a checkpoint on an empty WAL answers `ok 0/0` — nothing
    // distinguishes it from a free file, so the VACUUM happens (it cannot be avoided) and what
    // it produced stays in the WAL. It must at least SAY that much.
    const first = store.maintain({ freeRatioThreshold: 0 });
    expect(first.vacuumed).toBe(true);
    expect(first.walCheckpointBusy).toBe(true); // pages compacted, file NOT rewritten
    expect(first.error).toBeUndefined();
    const afterFirst = footprint(file);

    // 2nd run with the reader still there: the un-truncatable WAL is now visible (`busy`, pages
    // copied 0), and THIS is the click that used to add another full copy of the database.
    const second = store.maintain({ freeRatioThreshold: 0 });
    expect(second.vacuumed).toBe(false);
    expect(second.walCheckpointBusy).toBe(true);
    expect(second.after.freePages).toBe(second.before.freePages); // nothing was touched
    expect(footprint(file)).toBe(afterFirst); // and nothing was ADDED: clicking again is not worse

    reader.exec("COMMIT"); // the reader is gone
    // The run that finally reaches the file — and it does everything in ONE pass, drain included.
    const third = store.maintain({ freeRatioThreshold: 0 });
    expect(third.walCheckpointBusy).toBeUndefined();
    expect(third.after.freePages).toBe(0);
    expect(footprint(file)).toBeLessThan(before);
  });
});

describeRealFileIo("SqliteSessionStore — the compaction it owes is STATE, not a retry", () => {
  // WHY: `busy` belongs to ANOTHER connection's read snapshot, so no amount of polling can know
  // when it lets go — N attempts would be a stopwatch over an event we cannot see. So the debt is
  // remembered (`compact` = the whole pass, `copy` = pages a VACUUM already rebuilt) and paid at the
  // first OBSERVATION of a free WAL: a write, a click, the end of a turn.
  //
  // Measured on the real store: after a pinned VACUUM, ONE `wal_checkpoint(TRUNCATE)` took the file
  // from 32 MB to 5 MB, while a SECOND VACUUM (16 ms, same pages) only re-appended 5 MB to the WAL
  // — which is exactly how "click again" grew the file instead of emptying it.
  const dirs: string[] = [];
  // Every connection this block opens on a FILE, closed BEFORE the folder is removed — and the
  // order is not cosmetic: Vitest unwinds `afterEach` hooks innermost-first, so the module-level
  // hook that closes `dbs` runs AFTER this one. Removing the folder first left `sessions.db` open,
  // and Windows refuses to delete an open file: `EPERM: Permission denied` in a hook, failing the
  // seven tests of this block that had ALREADY passed. macOS and Ubuntu never see it (unlink on an
  // open file is legal there), which is how it stayed green locally and red on `windows-latest`.
  const fileDbs: DatabaseSync[] = [];
  /** sessions.db + its -wal: the whole footprint, which is what "did it empty" means. */
  const footprint = (file: string): number =>
    statSync(file).size + (existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0);
  const fileFs = () =>
    ({
      ...fakeFs(),
      exists: (p: string) => existsSync(p),
      size: (p: string) => statSync(p).size,
    }) as unknown as FileSystem;
  const openFile = (
    dbFor?: (real: DatabaseSync) => DatabaseSync,
  ): { store: SqliteSessionStore; file: string; db: DatabaseSync } => {
    const dir = mkdtempSync(join(tmpdir(), "harny-pending-"));
    dirs.push(dir);
    const file = join(dir, "sessions.db");
    const real = new DatabaseSync(file);
    dbs.push(real);
    fileDbs.push(real);
    let n = 0;
    // 50 ms of busy_timeout: `busy` must be REPORTED here, not waited out.
    const store = new SqliteSessionStore({
      db: dbFor ? dbFor(real) : real,
      fs: fileFs(),
      dbPath: file,
      busyTimeoutMs: 50,
      idGen: () => `s${++n}`,
    });
    return { store: timedMaintenance(store), file, db: real };
  };
  afterEach(() => {
    for (const db of fileDbs.splice(0))
      try {
        db.close();
      } catch {
        /* already closed by the test */
      }
    // `maxRetries` is Node's own Windows remedy for a handle that is still being released.
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  /** A big session, then deleted: every page is free, so a VACUUM is worth real megabytes. */
  const fill = (store: SqliteSessionStore): void => {
    const id = store.create("big").id;
    timed("fill (1200 messages, 5 MB)", () =>
      store.saveMessages(
        id,
        Array.from({ length: 1200 }, (_, i) => msg("user", "x".repeat(2000) + i)),
      ),
    );
    timed("fill (remove, every page free)", () => store.remove(id));
  };
  /** The other VS Code window on the same sessions.db: a live read snapshot. */
  const readSnapshot = (file: string): DatabaseSync => {
    const reader = new DatabaseSync(file);
    dbs.push(reader);
    fileDbs.push(reader);
    reader.exec("BEGIN; SELECT count(*) FROM messages;");
    return reader;
  };
  /**
   * A fill leaves the WAL full (below the 1000-page auto-checkpoint threshold), and a reader that
   * starts at the CURRENT end still forbids the RESET: `busy` would then be true at the drain, and
   * the first-click blind spot (an EMPTY WAL answers `ok 0/0`) would never be reproduced. So the
   * WAL is emptied with nobody reading, exactly as SQLite's own auto-checkpoint would have.
   */
  const emptyWal = (db: DatabaseSync): void => {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  };

  it("a REFUSED pass owes `compact`, and settlePending() pays it — no second click", () => {
    const { store, file } = openFile();
    fill(store);
    const reader = readSnapshot(file);
    // Frames written AFTER the snapshot: this is what makes the drain ITSELF busy (with an empty
    // WAL there is nothing to drain and nothing to detect — that is the first-click blind spot).
    const keep = store.create("while-reading").id;
    store.saveMessages(keep, [msg("user", "hello")]);
    const before = footprint(file);

    const r = store.maintain({ freeRatioThreshold: 0 });
    expect(r.vacuumed).toBe(false);
    expect(r.walCheckpointBusy).toBe(true);
    expect(r.pendingMaintenance).toBe("compact");
    expect(store.pendingMaintenance()).toBe("compact");
    expect(footprint(file)).toBe(before); // refused on purpose: not one byte was written

    reader.exec("COMMIT"); // the reader is done
    const settled = store.settlePending();
    expect(settled?.vacuumed).toBe(true);
    expect(settled?.pendingMaintenance).toBe("none");
    expect(footprint(file)).toBeLessThan(before);
    expect(store.pendingMaintenance()).toBe("none");
  });

  it("a PINNED VACUUM owes a COPY: settling moves bytes and rewrites NO page", () => {
    const { store, file, db } = openFile();
    fill(store);
    emptyWal(db);
    const before = footprint(file);
    const reader = readSnapshot(file); // its snapshot predates the VACUUM's frames, so they are pinned

    const r = store.maintain({ freeRatioThreshold: 0 });
    // This is the FIRST-CLICK case: the drain has nothing to drain (`ok 0/0`), so nothing warns
    // that the reader is there — the VACUUM runs, and only the trailing checkpoint can tell.
    expect(r.vacuumed).toBe(true);
    expect(r.walCheckpointBusy).toBe(true);
    expect(r.pendingMaintenance).toBe("copy");
    const pagesPinned = store.dbVacuumStats().pageCount;
    const pinned = footprint(file);

    reader.exec("COMMIT");
    const settled = store.settlePending();
    // NOT a second VACUUM: `vacuumed` stays false and the page count does not move — the pages were
    // already rebuilt, only their copy into sessions.db was missing.
    expect(settled).toMatchObject({ vacuumed: false, copied: true, pendingMaintenance: "none" });
    expect(store.dbVacuumStats().pageCount).toBe(pagesPinned);
    expect(footprint(file)).toBeLessThan(before);
    expect(footprint(file)).toBeLessThan(pinned);
    expect(store.pendingMaintenance()).toBe("none");
  });

  it("an ordinary SAVE pays the debt — no click at all", () => {
    const { store, file, db } = openFile();
    fill(store);
    emptyWal(db);
    const reader = readSnapshot(file);
    store.maintain({ freeRatioThreshold: 0 });
    expect(store.pendingMaintenance()).toBe("copy");
    reader.exec("COMMIT");
    const pinned = footprint(file);

    // A save is one of the moments the database is naturally quiet: the copy rides along.
    const id = store.create("next").id;
    store.saveMessages(id, [msg("user", "a later turn")]);

    expect(store.pendingMaintenance()).toBe("none");
    expect(footprint(file)).toBeLessThan(pinned);
    expect(store.load(id)?.messages).toHaveLength(1); // and the save was not a casualty
  });

  it("while the reader stays, settling six times adds NOTHING and loses nothing", () => {
    const { store, file, db } = openFile();
    fill(store);
    const keep = store.create("keep").id;
    store.saveMessages(
      keep,
      Array.from({ length: 5 }, (_, i) => msg("user", `m${i}`)),
    );
    emptyWal(db);
    const reader = readSnapshot(file);
    store.maintain({ freeRatioThreshold: 0 });
    expect(store.pendingMaintenance()).toBe("copy");
    const pinned = footprint(file);

    for (let i = 0; i < 6; i++) {
      const s = store.settlePending();
      expect(s?.walCheckpointBusy).toBe(true);
      expect(s?.pendingMaintenance).toBe("copy");
      expect(footprint(file)).toBe(pinned); // no pile-up: this is what used to grow 100→120→140 MB
    }
    // The debt did not cost any data: the survivor is still all there, exactly once.
    expect(store.load(keep)?.messages.map((m) => m.content)).toEqual(["m0", "m1", "m2", "m3", "m4"]);

    reader.exec("COMMIT");
    expect(store.settlePending()?.pendingMaintenance).toBe("none");
    expect(footprint(file)).toBeLessThan(pinned);
  });

  it("nothing owed: settlePending() does nothing at all", () => {
    const { store, file } = openFile();
    fill(store);
    const before = footprint(file);
    expect(store.pendingMaintenance()).toBe("none");
    expect(store.settlePending()).toBeUndefined();
    expect(footprint(file)).toBe(before);
  });

  it("a busy checkpoint on a pass that wrote NOTHING is not a debt either", () => {
    const { store, file } = openFile();
    fill(store);
    const first = store.maintain({ freeRatioThreshold: 0 });
    expect(first.vacuumed).toBe(true); // now the free list is empty

    const reader = readSnapshot(file); // pins the WAL: the trailing checkpoint can report busy
    const second = store.maintain({ freeRatioThreshold: 0 });
    expect(second.vacuumed).toBe(false);
    // `copy` here would queue a checkpoint over pages that were NEVER rebuilt, and the panel would
    // then tell the user the compaction is queued when there was nothing left to compact.
    expect(second.pendingMaintenance).toBe("none");
    expect(store.pendingMaintenance()).toBe("none");
    expect(store.settlePending()).toBeUndefined();
    reader.exec("COMMIT");
  });

  it("a VACUUM that FAILS for a real reason is not a debt (retrying would fail the same way)", () => {
    const { store, file, db } = openFile(
      (real) =>
        ({
          exec: (sql: string) => {
            if (sql.trim().toUpperCase().startsWith("VACUUM")) throw new Error("disk I/O error");
            return real.exec(sql);
          },
          prepare: (sql: string) => real.prepare(sql),
        }) as unknown as DatabaseSync,
    );
    fill(store);
    emptyWal(db);
    const reader = readSnapshot(file); // makes the trailing checkpoint busy as well

    const r = store.maintain({ freeRatioThreshold: 0 });
    expect(r.error).toBe("disk I/O error");
    expect(r.vacuumed).toBe(false);
    // busy AND failing: the failure wins — this must not become an automatic retry loop.
    expect(r.pendingMaintenance).toBe("none");
    reader.exec("COMMIT");
    expect(store.settlePending()).toBeUndefined();
  });
});

describe("SqliteSessionStore — misc", () => {
  it("search('') short-circuits to no hits", () => {
    const { store } = makeStore();
    store.create();
    store.saveMessages("s1", [msg("user", "hello world")]);
    expect(store.search("")).toEqual([]);
    expect(store.search("   ")).toEqual([]);
  });

  it("close() releases the database", () => {
    const db = new DatabaseSync(":memory:");
    const store = new SqliteSessionStore({ db, fs: fakeFs(), idGen: () => "s1" });
    store.create();
    store.close();
    expect(() => db.prepare("SELECT 1").get()).toThrow();
  });
});

describe("SqliteSessionStore — thinkingLevel clear", () => {
  it("an explicit thinkingLevel: undefined CLEARS it (mirrors temperature)", () => {
    const { store } = makeStore();
    store.create();
    store.saveSettings("s1", { thinkingLevel: "high" });
    expect(store.load("s1").summary.thinkingLevel).toBe("high");

    store.saveSettings("s1", { thinkingLevel: undefined });
    expect(store.load("s1").summary.thinkingLevel).toBeUndefined();
  });
});

/**
 * INTEGRITY. The two promises this file exists to pin, in order of importance:
 *
 *  1. A session is never HALF-written. Every mutation is one transaction, so the file
 *     holds either the old state or the new one — a process killed between two
 *     statements loses the LAST write at worst, never a message in the middle. This
 *     needs a REAL file and a REAL second connection to be worth anything: an
 *     in-memory database cannot show what survived on disk.
 *  2. A damaged session still OPENS, shortened and reported — never thrown away.
 */
describe("SqliteSessionStore — a write that dies cannot corrupt the session", () => {
  const tmpDirs: string[] = [];
  // Every connection this block opens on a FILE. They are closed BEFORE the folder is removed,
  // and that order is not cosmetic: Windows cannot delete a file that is still open (the default
  // SQLite open is not delete-sharing), so removing first is `EPERM: Permission denied` in
  // `afterEach` — which fails a test that has ALREADY passed. It did exactly that on
  // `windows-latest` while macOS and Ubuntu were green.
  const fileDbs: DatabaseSync[] = [];
  const openRaw = (file: string): DatabaseSync => {
    const db = new DatabaseSync(file);
    dbs.push(db);
    fileDbs.push(db);
    return db;
  };
  const openFile = (name: string): { db: DatabaseSync; store: SqliteSessionStore; file: string } => {
    const dir = mkdtempSync(join(tmpdir(), "harny-store-"));
    tmpDirs.push(dir);
    const file = join(dir, name);
    const db = openRaw(file);
    return { db, store: new SqliteSessionStore({ db, fs: fakeFs(), idGen: () => "s1" }), file };
  };
  afterEach(() => {
    for (const db of fileDbs.splice(0))
      try {
        db.close();
      } catch {
        /* already closed by the test */
      }
    // `maxRetries` is Node's own Windows remedy: EPERM/EBUSY retried with a growing backoff, for
    // the case where a handle opened by a test's second connection is still being released.
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("a save that THROWS mid-loop leaves the file exactly as it was (nothing partial)", () => {
    const first = openFile("sessions.db");
    first.store.create("Keep me");
    first.store.saveMessages("s1", [msg("user", "one"), msg("assistant", "two")]);
    const before = first.db.prepare("SELECT seq, data FROM messages ORDER BY seq").all();

    // The 3rd message cannot be serialized: the INSERTs of #3 cannot even start, and the
    // two statements already done must be rolled back. `BigInt` is the cheapest way to
    // make JSON.stringify throw *inside* the transaction, i.e. after real writes.
    const poisoned = [msg("user", "one"), msg("assistant", "two"), { role: "user", content: "x", timestamp: 10n }];
    expect(() => first.store.saveMessages("s1", poisoned as unknown as ChatMessage[])).toThrow();

    // Same connection: the transaction is gone.
    expect(first.db.prepare("SELECT seq, data FROM messages ORDER BY seq").all()).toEqual(before);
    // And on DISK: a SECOND connection to the SAME file (the next VS Code window) reads
    // the old session whole, with the old count. This is the assertion an in-memory test
    // cannot make — and the one that means "a crash costs the last write, not the session".
    const second = openRaw(first.file);
    const reopened = new SqliteSessionStore({ db: second, fs: fakeFs(), idGen: () => "s9" });
    const loaded = reopened.load("s1");
    expect(loaded.messages.map((m) => m.content)).toEqual(["one", "two"]);
    expect(loaded.summary.messageCount).toBe(2);
    expect(loaded.repaired).toBeUndefined();
  });

  it("a connection that DIES inside a transaction leaves the previous state on disk", () => {
    const { store, file } = openFile("sessions.db");
    store.create("Survivor");
    store.saveMessages("s1", [msg("user", "kept")]);
    store.close(); // release the file, like the process would

    // A second process starts a destructive transaction and is killed before COMMIT:
    // the closest thing to the lights going out mid-write.
    const dying = new DatabaseSync(file);
    dying.exec("BEGIN");
    dying.prepare("DELETE FROM messages WHERE session_id = 's1'").run();
    dying
      .prepare(
        "INSERT INTO messages(session_id, seq, role, content, timestamp, data) VALUES ('s1', 0, 'user', '', 0, '\\u0000garbage')",
      )
      .run();
    dying.close(); // no COMMIT: SQLite rolls the whole transaction back

    const reopened = openRaw(file);
    const store2 = new SqliteSessionStore({ db: reopened, fs: fakeFs(), idGen: () => "s2" });
    const loaded = store2.load("s1");
    expect(loaded.messages.map((m) => m.content)).toEqual(["kept"]);
    expect(loaded.repaired).toBeUndefined();
  });

  it("an ORDINARY save of a sound session reports nothing (no false positives)", () => {
    const { store } = makeStore();
    store.create();
    store.saveMessages("s1", [msg("user", "a"), msg("assistant", "b")]);
    const loaded = store.load("s1");
    expect(loaded.messages).toHaveLength(2);
    expect("repaired" in loaded).toBe(false);
  });
});

describe("SqliteSessionStore — load() salvages a damaged session instead of throwing", () => {
  it("a row that no longer parses costs the TAIL, not the session", () => {
    const { store, db } = makeStore();
    store.create();
    store.saveMessages("s1", [msg("user", "keep me"), msg("assistant", "and me"), msg("user", "me too")]);
    // A rotted block, a hand edit, a row from a build that stored another shape.
    db.prepare("UPDATE messages SET data = '{oops' WHERE session_id = 's1' AND seq = 1").run();

    const loaded = store.load("s1");
    expect(loaded.messages.map((m) => m.content)).toEqual(["keep me"]);
    expect(loaded.repaired).toEqual({ dropped: 2, reason: "unreadable" });
    // The count follows what is USABLE: the list must not promise messages it cannot open.
    expect(loaded.summary.messageCount).toBe(1);
  });

  it("a dangling tool call is cut, and the session opens", () => {
    const { store } = makeStore();
    store.create();
    store.saveMessages("s1", [
      msg("user", "ask"),
      { role: "assistant", content: "", timestamp: 2, toolCalls: [{ id: "t1", name: "read_file", arguments: "{}" }] },
    ]);
    const loaded = store.load("s1");
    expect(loaded.messages.map((m) => m.role)).toEqual(["user"]);
    expect(loaded.repaired).toEqual({ dropped: 1, reason: "invalid_tail" });
  });

  it("the repair becomes REAL at the next ordinary save (no destructive statement on load)", () => {
    // Nothing is written by `load`: the rows stay until the session is used again, and
    // then the prefix guard notices the history is shorter and REPLACES the table.
    const { store, db } = makeStore();
    store.create();
    store.saveMessages("s1", [msg("user", "keep me"), msg("assistant", "and me")]);
    db.prepare("UPDATE messages SET data = '{oops' WHERE session_id = 's1' AND seq = 1").run();
    expect(store.load("s1").messages).toHaveLength(1);
    // Still damaged on disk: loading is a read.
    expect((db.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c).toBe(2);

    store.saveMessages("s1", [msg("user", "keep me"), msg("user", "next")]);

    const rows = db.prepare("SELECT data FROM messages ORDER BY seq").all() as { data: string }[];
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[1].data).content).toBe("next");
    const reloaded = store.load("s1");
    expect(reloaded.repaired).toBeUndefined();
    expect(reloaded.messages.map((m) => m.content)).toEqual(["keep me", "next"]);
  });
});
