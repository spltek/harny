import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runMigrations, applyMigrations, getUserVersion, LATEST_VERSION, type Migration } from "./migrations";

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

    expect(r).toEqual({ from: 0, to: LATEST_VERSION, applied: 2 });
    expect(LATEST_VERSION).toBe(2);
    expect(getUserVersion(db)).toBe(2);
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

    expect(runMigrations(db)).toEqual({ from: 2, to: 2, applied: 0 });
  });

  it("STAMPS a pre-versioning database instead of re-running the baseline", () => {
    const db = makeDb();
    runMigrations(db); // the full, current schema
    // Take the database back to the v1 SHAPE: this is what an install from before the
    // versioning system looks like (user_version 0, and no column added by a later
    // migration — SQLite 3.35+ can drop one, a pre-versioning install never had it).
    db.exec("ALTER TABLE sessions DROP COLUMN compaction_target_percent");
    db.prepare("INSERT INTO sessions(id,name,created_at,updated_at,message_count) VALUES('s1','x',1,1,0)").run();
    db.exec("PRAGMA user_version = 0"); // simulate an install from before versioning

    const logs: string[] = [];
    const r = runMigrations(db, { log: (m) => logs.push(m) });

    // Stamped to the BASELINE (v1), then the PENDING v2 migration runs: a legacy install
    // must still receive the new column instead of skipping it.
    expect(r).toEqual({ from: 1, to: 2, applied: 1 });
    expect(getUserVersion(db)).toBe(2);
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
