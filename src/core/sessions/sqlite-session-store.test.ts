import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SqliteSessionStore } from "./sqlite-session-store";
import type { FileSystem } from "../tools/file-system";
import type { ChatMessage } from "../history/types";

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
function makeStore(opts: { existing?: string[]; currentFolder?: () => string | undefined } = {}) {
  const db = new DatabaseSync(":memory:");
  const store = new SqliteSessionStore({
    db,
    fs: fakeFs(opts.existing),
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
  for (const db of dbs.splice(0)) db.close();
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
    store.saveMessages("s1", [rich]);
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
    store.saveSettings(created.id, { toolScope: { mcp: ["files"], off: [] } });
    store.saveMessages(created.id, [msg("user", "one"), msg("assistant", "two")]);

    const summary = store.summary(created.id);
    expect(summary?.name).toBe("meta");
    expect(summary?.toolScope).toEqual({ mcp: ["files"], off: [] });
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

    store.saveSettings(a.id, { toolScope: { mcp: [], off: [] } });
    const b = store.load(a.id).summary;
    expect(b.toolScope).toEqual({ mcp: [], off: [] }); // decided "nothing", and it survived

    // …and "decided nothing" survives a later save that does not mention the scope at all
    // (carrySummary must not drop it).
    store.saveSettings(a.id, { thinkingLevel: "low" });
    expect(store.load(a.id).summary.toolScope).toEqual({ mcp: [], off: [] });
  });

  it("normalizes junk on the way in, so the column never holds it", () => {
    const { store } = makeStore();
    const s = store.create("junk")!;
    store.saveSettings(s.id, { toolScope: { mcp: [" a ", "a", 7], off: [" Shell "] } as never });
    expect(store.load(s.id).summary.toolScope).toEqual({ mcp: ["a"], off: ["Shell"] });
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
  it("maintain with threshold 0 FORCES a VACUUM even with no free pages", () => {
    const { store } = makeStore();
    store.create();
    store.saveMessages("s1", [msg("user", "a")]);
    const r = store.maintain({ freeRatioThreshold: 0 });
    expect(r.vacuumed).toBe(true);
  });
});

describe("SqliteSessionStore — vacuum also optimizes the indexes", () => {
  it("maintain runs the FTS5 optimize without breaking search", () => {
    const { store } = makeStore();
    store.create(); // s1
    store.saveMessages("s1", [msg("user", "hello world"), msg("assistant", "hi there")]);
    store.remove("s1"); // free pages + FTS segments to merge

    const r = store.maintain({ freeRatioThreshold: 0 });
    expect(r.vacuumed).toBe(true);

    // The full-text index survived the optimize and still matches NEW rows.
    store.create(); // s2
    store.saveMessages("s2", [msg("user", "hello again")]);
    expect(store.search("hello").some((h) => h.sessionId === "s2")).toBe(true);
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
