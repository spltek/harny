import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  runMigrations,
  applyMigrations,
  getUserVersion,
  LATEST_VERSION,
  repairSplicedTranscript,
  type Migration,
} from "./migrations";

const dbs: DatabaseSync[] = [];
function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  return db;
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function triggerExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name);
}

describe("runMigrations — the shipped schema", () => {
  it("creates the baseline on a fresh database and stamps the version", () => {
    const db = makeDb();

    const r = runMigrations(db);

    expect(r).toEqual({ from: 0, to: LATEST_VERSION, applied: 5 });
    expect(LATEST_VERSION).toBe(5);
    expect(getUserVersion(db)).toBe(5);
    expect(tableExists(db, "sessions")).toBe(true);
    expect(tableExists(db, "messages")).toBe(true);
    // The FTS index + triggers work.
    db.prepare("INSERT INTO messages(session_id, seq, role, content, timestamp, data) VALUES (?,?,?,?,?,?)").run(
      "s1",
      0,
      "user",
      "hello world",
      1,
      "{}",
    );
    const hit = db
      .prepare(
        "SELECT m.session_id AS session_id FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid WHERE messages_fts MATCH ?",
      )
      .get("hello") as { session_id?: string } | undefined;
    expect(hit?.session_id).toBe("s1");
  });

  it("is idempotent (a second run applies nothing)", () => {
    const db = makeDb();
    runMigrations(db);

    expect(runMigrations(db)).toEqual({ from: 5, to: 5, applied: 0 });
  });

  it("STAMPS a pre-versioning database instead of re-running the baseline", () => {
    const db = makeDb();
    runMigrations(db); // the full, current schema
    // Take the database back to the v1 SHAPE: this is what an install from before the
    // versioning system looks like (user_version 0, and no column added by a later
    // migration — SQLite 3.35+ can drop one, a pre-versioning install never had it).
    db.exec("ALTER TABLE sessions DROP COLUMN tool_scope");
    db.exec("ALTER TABLE sessions DROP COLUMN compaction_target_percent");
    db.exec("ALTER TABLE sessions DROP COLUMN revision");
    db.prepare("INSERT INTO sessions(id,name,created_at,updated_at,message_count) VALUES('s1','x',1,1,0)").run();
    db.exec("PRAGMA user_version = 0"); // simulate an install from before versioning

    const logs: string[] = [];
    const r = runMigrations(db, { log: (m) => logs.push(m) });

    // Stamped to the BASELINE (v1), then the PENDING migrations run: a legacy install must
    // still receive the new columns instead of skipping them.
    expect(r).toEqual({ from: 1, to: LATEST_VERSION, applied: LATEST_VERSION - 1 });
    expect(getUserVersion(db)).toBe(LATEST_VERSION);
    // Existing data survived (the baseline was NOT re-run / dropped).
    expect(db.prepare("SELECT name FROM sessions WHERE id='s1'").get()).toEqual({ name: "x" });
    expect(logs.some((l) => /pre-versioning/.test(l))).toBe(true);
  });

  it("REFUSES a database written by a newer build", () => {
    const db = makeDb();
    db.exec("PRAGMA user_version = 999");
    expect(() => runMigrations(db)).toThrow(/newer than this Harny build/);
  });
});

describe("schema contract (drift guard)", () => {
  const columns = (db: DatabaseSync, table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);

  it("migrations produce EXACTLY the columns the code relies on", () => {
    const db = makeDb();
    runMigrations(db);

    // Adding a per-session field means: a NEW migration + the store mapper
    // (normalizePatch/carrySummary/upsertSummary/rowToSummary) + THIS list.
    // If you add a column here without a migration, the store fails at runtime;
    // if you add a migration without updating this list, the test fails.
    expect(columns(db, "sessions")).toEqual([
      "id",
      "name",
      "folder",
      "created_at",
      "updated_at",
      "message_count",
      "model",
      "model_provider",
      "thinking_level",
      "context_window",
      "compaction_threshold_percent",
      "context_tokens",
      "output_tokens",
      "temperature",
      "presence_penalty",
      "frequency_penalty",
      "top_p",
      "sampler",
      "max_parallel_sub_agents",
      "mode",
      "parallel",
      "loop_guard",
      "loop_guard_response",
      "loop_guard_params",
      // ALTER TABLE appends: a column added by a later migration sits at the END.
      "compaction_target_percent",
      "tool_scope",
      "revision",
    ]);
    expect(columns(db, "messages")).toEqual(["session_id", "seq", "role", "content", "timestamp", "data"]);
    // The full-text index + its sync triggers exist.
    expect(tableExists(db, "messages_fts")).toBe(true);
    expect(triggerExists(db, "messages_ai")).toBe(true);
    expect(triggerExists(db, "messages_ad")).toBe(true);
  });
});

describe("applyMigrations — the runner", () => {
  const m = (version: number, name: string, sql: string, destructive = false): Migration => ({
    version,
    name,
    destructive,
    up: (db) => db.exec(sql),
  });

  it("applies pending migrations in order inside one transaction", () => {
    const db = makeDb();
    const logs: string[] = [];

    const r = applyMigrations(db, [m(1, "one", "CREATE TABLE t1 (x)"), m(2, "two", "CREATE TABLE t2 (x)")], {
      log: (x) => logs.push(x),
    });

    expect(r).toEqual({ from: 0, to: 2, applied: 2 });
    expect(getUserVersion(db)).toBe(2);
    expect(tableExists(db, "t1")).toBe(true);
    expect(tableExists(db, "t2")).toBe(true);
    expect(logs.some((l) => /v2: two/.test(l))).toBe(true);
  });

  it("skips migrations already applied", () => {
    const db = makeDb();
    applyMigrations(db, [m(1, "one", "CREATE TABLE t1 (x)")]);
    const r = applyMigrations(db, [m(1, "one", "CREATE TABLE t1 (x)"), m(2, "two", "CREATE TABLE t2 (x)")]);
    expect(r).toEqual({ from: 1, to: 2, applied: 1 });
    expect(tableExists(db, "t2")).toBe(true);
  });

  it("does NOT re-apply migrations another window already ran (the version is read under the lock)", () => {
    // Two windows are two extension hosts activating at the same time on ONE database. The loser
    // must find nothing to do; re-running `CREATE TABLE`/`ALTER TABLE` would throw straight out of
    // activation, i.e. Harny would fail to start in the second window.
    //
    // The race is simulated exactly where it happens: the backup hook runs AFTER the version was
    // read and BEFORE the transaction, so it can play the other window (which applied v2 and
    // bumped the version) in between.
    const db = makeDb();
    db.exec("CREATE TABLE t1(x)");
    db.exec("CREATE TABLE t2(y)");
    db.exec("PRAGMA user_version = 1"); // stale: the window that wrote this is one version behind
    const migrations = [
      { version: 1, name: "one", up: (d: DatabaseSync) => d.exec("CREATE TABLE t1(x)") },
      {
        version: 2,
        name: "two",
        destructive: true,
        up: (d: DatabaseSync) => d.exec("CREATE TABLE t2(y)"),
      },
    ];

    const result = applyMigrations(db, migrations, {
      backup: () => {
        // The other window, mid-flight.
        db.exec("PRAGMA user_version = 2");
      },
    });

    expect(result).toEqual({ from: 1, to: 2, applied: 0 });
    expect(getUserVersion(db)).toBe(2);
  });

  it("ROLLS BACK everything (and the version) when a migration throws", () => {
    const db = makeDb();
    const failing: Migration = {
      version: 2,
      name: "boom",
      up: () => {
        throw new Error("boom");
      },
    };

    expect(() => applyMigrations(db, [m(1, "one", "CREATE TABLE t1 (x)"), failing])).toThrow("boom");

    expect(getUserVersion(db)).toBe(0);
    expect(tableExists(db, "t1")).toBe(false); // v1 was rolled back too
  });

  it("calls the backup hook before a destructive migration", () => {
    const db = makeDb();
    let backedUp = -1;

    applyMigrations(db, [m(1, "one", "CREATE TABLE t1 (x)"), m(2, "drop", "DROP TABLE t1", true)], {
      backup: (v) => (backedUp = v),
    });

    expect(backedUp).toBe(0); // the version BEFORE the upgrade
  });

  it("does NOT call the backup hook for additive migrations", () => {
    const db = makeDb();
    let called = false;
    applyMigrations(db, [m(1, "one", "CREATE TABLE t1 (x)")], { backup: () => (called = true) });
    expect(called).toBe(false);
  });
});

describe("migration 4 — the transcript goes back in the order it was written", () => {
  const row = (seq: number, role: string, content: string, timestamp: number, synthetic = false) => ({
    session_id: "s1",
    seq,
    role,
    content,
    timestamp,
    data: JSON.stringify({ role, content, timestamp, ...(synthetic ? { synthetic: true } : {}) }),
  });

  const insert = (db: DatabaseSync, rows: ReturnType<typeof row>[]): void => {
    const stmt = db.prepare(
      "INSERT INTO messages(session_id, seq, role, content, timestamp, data) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const r of rows) stmt.run(r.session_id, r.seq, r.role, r.content, r.timestamp, r.data);
  };

  const contents = (db: DatabaseSync): string[] =>
    (
      db.prepare("SELECT content FROM messages WHERE session_id = 's1' ORDER BY seq").all() as { content: string }[]
    ).map((r) => r.content);

  /**
   * A database as a v3 build left it: the current schema, then every column a LATER additive
   * migration put at the END removed again (SQLite 3.35+ can drop one) and the version rewound.
   * Without the drop, `runMigrations` would re-apply migration 5 to rows that already have the
   * column — a "duplicate column" that the real upgrade path can never produce.
   */
  const asVersion3 = (db: DatabaseSync): void => {
    runMigrations(db);
    db.exec("ALTER TABLE sessions DROP COLUMN revision");
    db.exec("PRAGMA user_version = 3");
  };

  it("swaps a [newer summarized][older deferred] splice back, and touches nothing else", () => {
    const db = makeDb();
    asVersion3(db);
    db.prepare("INSERT INTO sessions(id, name, created_at, updated_at, message_count) VALUES ('s1','S',0,0,6)").run();
    // Exactly the shape the old splice wrote: the newer chunk (10:01) hoisted above the older
    // one (09:43), then the checkpoint and the kept tail.
    insert(db, [
      row(0, "assistant", "new-1", 1_000),
      row(1, "assistant", "new-2", 1_001),
      row(2, "user", "first input of the session", 900),
      row(3, "assistant", "old-2", 901),
      row(4, "user", "Summary of past interactions", 2_000, true),
      row(5, "assistant", "## Goal", 2_001, true),
      row(6, "user", "last question", 2_002),
    ]);
    db.prepare("UPDATE sessions SET message_count = 7").run();

    runMigrations(db);

    expect(getUserVersion(db)).toBe(5);
    // The session now OPENS on the first user input, and the blocks are chronological.
    expect(contents(db)).toEqual([
      "first input of the session",
      "old-2",
      "new-1",
      "new-2",
      "Summary of past interactions",
      "## Goal",
      "last question",
    ]);
    // `seq` stays dense from 0 (the store writes by index).
    const seqs = (db.prepare("SELECT seq FROM messages ORDER BY seq").all() as { seq: number }[]).map((r) => r.seq);
    expect(seqs).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // Nothing was lost, and nothing was LEFT BEHIND: the repair keeps no backup table (the
    // transaction is the safety net for a failure, and the old order of an already scrambled
    // transcript is not information worth a copy).
    expect(tableExists(db, "messages_backup_v4")).toBe(false);
    // The full-text index follows the rewrite.
    const hit = db
      .prepare(
        "SELECT m.content AS content FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid WHERE messages_fts MATCH ?",
      )
      .get("first") as { content?: string } | undefined;
    expect(hit?.content).toBe("first input of the session");
  });

  it("untangles INTERLEAVED segments (a later cut landed inside an earlier one)", () => {
    // The real damage after a few compactions: the segments do not merely follow each other,
    // their time ranges OVERLAP — so no block-level reorder can fix them and the past is
    // sorted by the timestamp each message carries.
    const db = makeDb();
    asVersion3(db);
    db.prepare("INSERT INTO sessions(id, name, created_at, updated_at, message_count) VALUES ('s1','S',0,0,4)").run();
    insert(db, [
      row(0, "user", "new-a", 100),
      row(1, "assistant", "new-b", 300),
      row(2, "user", "old-a", 50),
      row(3, "assistant", "old-b", 200),
    ]);

    runMigrations(db);

    expect(contents(db)).toEqual(["old-a", "new-a", "old-b", "new-b"]);
  });

  it("leaves a healthy history alone (no rewrite at all)", () => {
    const db = makeDb();
    asVersion3(db);
    db.prepare("INSERT INTO sessions(id, name, created_at, updated_at, message_count) VALUES ('s1','S',0,0,4)").run();
    insert(db, [
      row(0, "user", "one", 1),
      row(1, "assistant", "two", 2),
      row(2, "user", "three", 3),
      row(3, "assistant", "four", 4),
    ]);

    runMigrations(db);

    expect(contents(db)).toEqual(["one", "two", "three", "four"]);
    expect(tableExists(db, "messages_backup_v4")).toBe(false);
  });
});

describe("migration 4 — invariants on RANDOM histories (the guarantees, not one fixture)", () => {
  // A fixture proves the case we thought of. These prove the PROPERTIES the repair must have for
  // ANY input, which is what "safe to run on a stranger's database" actually means:
  //   1. it is a PERMUTATION — no row lost, none duplicated, none invented;
  //   2. the past it returns is in order (never a step backwards);
  //   3. the checkpoint pair + kept tail are untouched, in place;
  //   4. equal timestamps keep their stored order (stability: a tool call stays with its step);
  //   5. it is IDEMPOTENT — a second run finds nothing to do;
  //   6. a history with no backwards step is never touched (`null`).
  it("holds all of them over 300 generated histories", () => {
    let seed = 42; // deterministic LCG: a failure is reproducible
    const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

    const isSyn = (data: string): boolean => {
      try {
        return (JSON.parse(data) as { synthetic?: unknown }).synthetic === true;
      } catch {
        return false;
      }
    };
    const syntheticRow = (seq: number, ts: number) => ({
      session_id: "s1",
      seq,
      role: "user",
      content: `pair-${seq}`,
      timestamp: ts,
      data: JSON.stringify({ synthetic: true, timestamp: ts }),
    });
    /** Where the untouched tail (pair + kept) begins, exactly as the repair decides it. */
    const tailStart = (rows: { data: string }[]): number => {
      let i = rows.length - 1;
      while (i >= 0 && !isSyn(rows[i].data)) i--;
      if (i < 0) return rows.length;
      while (i > 0 && isSyn(rows[i - 1].data)) i--;
      return i;
    };
    const monotonic = (rows: { timestamp: number }[]): boolean =>
      rows.every((r, i) => i === 0 || r.timestamp >= rows[i - 1].timestamp);

    let repaired = 0;
    for (let trial = 0; trial < 300; trial++) {
      const n = 2 + Math.floor(next() * 28);
      // Few distinct timestamps on purpose: ties are the risky part (they are what keeps a tool
      // call glued to the assistant step that fired it).
      const rows = Array.from({ length: n }, (_, i) => {
        const ts = 1_000 + Math.floor(next() * 12);
        return next() < 0.08
          ? syntheticRow(i, ts)
          : {
              session_id: "s1",
              seq: i,
              role: next() < 0.5 ? "user" : "assistant",
              content: `m${i}`,
              timestamp: ts,
              data: JSON.stringify({ role: "user", timestamp: ts }),
            };
      });

      const out = repairSplicedTranscript(rows);

      if (!out) {
        // "Nothing to do" is only legitimate when the past really is in order.
        expect(monotonic(rows.slice(0, tailStart(rows))), `trial ${trial}: null but out of order`).toBe(true);
        continue;
      }
      repaired++;
      const start = tailStart(rows);

      // 1. same rows, no duplicates, nothing invented (compared by identity).
      expect(out.length).toBe(rows.length);
      expect([...out].sort((a, b) => a.seq - b.seq).map((r) => r.seq)).toEqual(
        [...rows].sort((a, b) => a.seq - b.seq).map((r) => r.seq),
      );
      // 2. the past is in order.
      expect(monotonic(out.slice(0, start)), `trial ${trial}: still out of order`).toBe(true);
      // 3. pair + kept untouched, and still at the end.
      expect(out.slice(start)).toEqual(rows.slice(start));
      // 4. stability: equal timestamps keep their stored relative order.
      const before = new Map(rows.map((r, i) => [r.seq, i]));
      const pastOut = out.slice(0, start);
      for (let i = 1; i < pastOut.length; i++) {
        if (pastOut[i].timestamp === pastOut[i - 1].timestamp) {
          expect(before.get(pastOut[i].seq)! > before.get(pastOut[i - 1].seq)!, `trial ${trial}: unstable`).toBe(true);
        }
      }
      // 5. idempotent.
      expect(repairSplicedTranscript(out)).toBe(null);
    }
    // The generator must actually produce damaged histories, otherwise this proves nothing.
    expect(repaired).toBeGreaterThan(200);
  });
});
