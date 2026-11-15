import type { DatabaseSync } from "node:sqlite";

/**
 * Ordered, IMMUTABLE schema migrations for the sessions database, tracked with
 * SQLite's built-in `PRAGMA user_version`.
 *
 * Rules:
 *  · a migration that has SHIPPED is never edited — add a new version instead;
 *  · every migration runs inside ONE transaction (SQLite DDL is transactional),
 *    so a failure rolls the whole upgrade back and leaves the version intact;
 *  · a database written by a NEWER Harny (user_version > latest) is refused
 *    instead of being silently downgraded;
 *  · a pre-versioning database (user_version = 0 but the schema already exists,
 *    i.e. an install from before this system) is STAMPED to the baseline
 *    without re-running it;
 *  · a migration that rewrites `messages` IN PLACE must also refresh the
 *    external-content FTS index, since it has no UPDATE trigger:
 *    `INSERT INTO messages_fts(messages_fts) VALUES('rebuild');`
 *
 * Step-by-step guide (add a field, table rebuilds, backfills, destructive
 * migrations, testing): documentation/MIGRATIONS.md.
 */
export interface Migration {
  /** Strictly increasing (1, 2, 3 …). Never reused or reordered. */
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
  /** true = rewrites or removes stored data (not merely adds). Harny takes NO automatic copy
   * of the database before such a migration: the upgrade runs in one transaction, so a failure
   * is already undone, and an install must not accumulate snapshots of itself in
   * globalStorage. The flag is what a caller COULD act on (the `backup` option below) and what
   * the review of a new migration has to look at. */
  destructive?: boolean;
}

/**
 * Migration 1 — the schema as of the first release. FROZEN: do not edit it,
 * add a new migration above instead.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "baseline schema",
    up: (db) =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          folder TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          message_count INTEGER NOT NULL DEFAULT 0,
          model TEXT,
          model_provider TEXT,
          thinking_level TEXT,
          context_window INTEGER,
          compaction_threshold_percent INTEGER,
          context_tokens INTEGER,
          output_tokens INTEGER,
          temperature REAL,
          presence_penalty REAL,
          frequency_penalty REAL,
          top_p REAL,
          sampler TEXT,
          max_parallel_sub_agents INTEGER,
          mode TEXT,
          parallel INTEGER,
          loop_guard TEXT,
          loop_guard_response INTEGER,
          loop_guard_params TEXT
        );
        CREATE TABLE IF NOT EXISTS messages (
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT,
          timestamp INTEGER,
          data TEXT NOT NULL,
          PRIMARY KEY (session_id, seq)
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='rowid');
        CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        END;
      `),
  },
  {
    version: 2,
    name: "per-session compaction landing point",
    // The % of the USABLE context a compaction lands at. NULL = AUTO (a quarter of the
    // trigger), so every existing session keeps the behaviour it has today. Only `sessions`
    // is touched: the FTS index follows `messages`, and no row of it is rewritten (see the
    // rule at the top of this file).
    up: (db) => db.exec("ALTER TABLE sessions ADD COLUMN compaction_target_percent INTEGER; "),
  },
  {
    version: 3,
    name: "per-session tool scope",
    // WHICH MCP servers this conversation uses, and which built-in tools it turned off — as ONE
    // JSON column rather than a table: it is a small value owned by the session, read whole or not
    // at all, and one column means one migration instead of one per list. NULL = a session written
    // before this existed, which must keep behaving exactly as it did (see normalizeToolScope).
    up: (db) => db.exec("ALTER TABLE sessions ADD COLUMN tool_scope TEXT; "),
  },
  {
    version: 4,
    name: "transcript in the order it was written",
    // REPAIRS a session whose compaction used to splice the span back as
    // [.. summarized .. deferred .. checkpoint ..]: `summarized` is the NEWER part of the span
    // (the most recent chunk that fit the summary request, cut by a TOKEN budget — possibly in
    // the middle of a turn) and `deferred` the OLDER one, so writing `summarized` first hoisted
    // that cut above the session's own beginning and pushed older messages BELOW it. The head
    // then stayed there forever: every later compaction copies everything above the newest
    // checkpoint verbatim. NOTHING is dropped — the blocks go back in chronological order.
    // A history written by the fixed build has no backwards step and is left untouched.
    destructive: true,
    up: (db) => reorderSplicedTranscripts(db),
  },
  {
    version: 5,
    name: "revision: the token a transcript write must match",
    // Optimistic concurrency for the ONE thing two windows can destroy: the transcript. Two VS
    // Code windows are two extension hosts on one `sessions.db`; each holds the history it
    // loaded, and a host that never saw the other's append used to reach the prefix guard's
    // `replace` branch — `DELETE FROM messages` — deleting turns it had never read. `revision`
    // is bumped inside the transaction that writes messages and handed back to the next save; a
    // mismatch is refused BEFORE any row is touched (see `session-conflict.ts`).
    //
    // NOT `destructive`: it only adds a column, and `0` is the honest starting value — a session
    // written before this existed had no competing writer by definition. It is bumped by
    // `saveMessages` ALONE: a rename or a settings write changes no message, so it must not
    // invalidate a token (a false conflict is a save the user never asked to lose).
    up: (db) => db.exec("ALTER TABLE sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0; "),
  },
];

/** One `messages` row, as the repair reads and writes it. */
interface StoredMessageRow {
  session_id: string;
  seq: number;
  role: string;
  content: string | null;
  timestamp: number | null;
  data: string;
}

/** Is this stored message one of the checkpoint pair's synthetic rows? */
function isSyntheticRow(data: string): boolean {
  try {
    return (JSON.parse(data) as { synthetic?: unknown }).synthetic === true;
  } catch {
    return false;
  }
}

function rowTimestamp(row: StoredMessageRow): number {
  const ts = Number(row.timestamp ?? 0);
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * Put one session's stored transcript back in the order it was written, or return `null`
 * when there is nothing to do (the overwhelmingly common case: a healthy history only ever
 * moves forward in time).
 *
 * The transcript is `[past][checkpoint pair][kept]`. `kept` follows the pair and is in order;
 * the damage can only be in `past`, which the old splice wrote as a run of
 * `[summarized][deferred]` segments — each segment internally ordered, each NEWER than the
 * one printed after it. After a few compactions those segments INTERLEAVE (a later cut lands
 * inside the span of an earlier one), so no block-level shuffle can untangle them: the past is
 * simply sorted by the timestamp every message carries, which is exactly the order it was
 * written in. The sort is STABLE, so messages sharing a millisecond (an assistant step and the
 * tool results it fired) keep their stored order and stay glued together.
 *
 * A history with no backwards step is left ALONE — the repair never reshuffles a healthy
 * session, and it never drops a row.
 */
export function repairSplicedTranscript(rows: StoredMessageRow[]): StoredMessageRow[] | null {
  let pairAt = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (isSyntheticRow(rows[i].data)) {
      pairAt = i;
      break;
    }
  }
  // The pair is TWO messages (the label and the state document) and both are synthetic: the
  // past ends where the pair BEGINS, not at its last row.
  while (pairAt > 0 && isSyntheticRow(rows[pairAt - 1].data)) pairAt--;
  const past = pairAt < 0 ? rows : rows.slice(0, pairAt);
  const tail = pairAt < 0 ? [] : rows.slice(pairAt);
  const outOfOrder = past.some((row, i) => i > 0 && rowTimestamp(row) < rowTimestamp(past[i - 1]));
  if (!outOfOrder) return null;
  const ordered = past
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rowTimestamp(a.row) - rowTimestamp(b.row) || a.index - b.index)
    .map((entry) => entry.row);
  return [...ordered, ...tail];
}

/**
 * Apply {@link repairSplicedTranscript} to every stored session (migration 4).
 *
 * The rewrite keeps `seq` dense from 0 and rebuilds the external-content FTS index at the end
 * (it has no UPDATE trigger — see the rule at the top).
 *
 * NO backup table and no snapshot file: an upgrade must not leave copies of the user's database
 * behind, and it does not need to. Every pending migration already runs inside ONE transaction,
 * so a failure ROLLBACKs to the previous version byte for byte — the only thing a copy would add
 * is the OLD order of a transcript that was already out of order (that is the bug being fixed).
 * Sessions with nothing to repair are not read back, not rewritten and never touched.
 */
function reorderSplicedTranscripts(db: DatabaseSync): void {
  const sessions = db.prepare("SELECT id FROM sessions").all() as { id: string }[];
  let repaired = 0;
  for (const { id } of sessions) {
    const rows = db
      .prepare("SELECT session_id, seq, role, content, timestamp, data FROM messages WHERE session_id = ? ORDER BY seq")
      .all(id) as unknown as StoredMessageRow[];
    const fixed = repairSplicedTranscript(rows);
    if (!fixed) continue;
    db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
    const insert = db.prepare(
      "INSERT INTO messages(session_id, seq, role, content, timestamp, data) VALUES (?, ?, ?, ?, ?, ?)",
    );
    fixed.forEach((row, index) => insert.run(id, index, row.role, row.content ?? "", row.timestamp ?? 0, row.data));
    repaired++;
  }
  if (repaired > 0) db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild');");
}

/** The version this build expects after running every migration — DERIVED from the table,
 * never typed twice. Exported for the SUITE only (it asserts a fresh DB lands here): a
 * hard-coded number in that test would go stale the day a migration is appended, and would
 * keep passing while the DB was behind. */
export const LATEST_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1].version;

/** Read the database's schema version (0 = never versioned). */
export function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

interface MigrationRunResult {
  from: number;
  to: number;
  applied: number;
}

interface MigrationOptions {
  /** Diagnostic sink (one line per applied migration). */
  log?: (message: string) => void;
  /** Called ONCE, with the version being upgraded FROM, when at least one pending migration is
   * `destructive` — so a caller that wants a snapshot (a test, a support script) can take one
   * while the database is still untouched. The extension passes nothing: shipped upgrades leave
   * no copy of the user's database behind. */
  backup?: (fromVersion: number) => void;
}

/**
 * Apply `migrations` to `db` (exported for tests; production uses
 * {@link runMigrations}). All pending migrations run in a SINGLE transaction.
 */
export function applyMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[],
  options: MigrationOptions = {},
): MigrationRunResult {
  const log = options.log ?? ((): void => {});
  const latest = migrations[migrations.length - 1].version;
  let current = getUserVersion(db);

  // Pre-versioning install: the schema is already there but user_version is 0.
  // It IS the baseline, so stamp it instead of re-running migration 1.
  if (current === 0 && tableExists(db, "sessions")) {
    current = migrations[0].version;
    db.exec(`PRAGMA user_version = ${current}`);
    log(`[db] pre-versioning schema detected — stamped v${current}`);
  }

  if (current > latest) {
    throw new Error(
      `session database is v${current}, newer than this Harny build (v${latest}): ` +
        "update Harny or use a different HARNY_HOME.",
    );
  }

  const pending = migrations.filter((m) => m.version > current);
  if (pending.length === 0) return { from: current, to: current, applied: 0 };

  if (options.backup && pending.some((m) => m.destructive)) options.backup(current);

  const from = current;
  // IMMEDIATE: the version must be decided INSIDE the lock, because two VS Code windows are two
  // extension hosts that activate at the same time on ONE `sessions.db` (VS Code restoring them at
  // launch is the normal case, not a corner). With DEFERRED both hosts read `user_version`, both
  // decide the same migrations are pending, and the loser either re-runs them (`table already
  // exists`, thrown out of activation) or fails upgrading a stale snapshot to a writer.
  db.exec("BEGIN IMMEDIATE");
  try {
    const locked = getUserVersion(db);
    const stillPending = pending.filter((m) => m.version > locked);
    if (stillPending.length === 0) {
      // Another window got there first. Not an error: this database is exactly what we wanted.
      db.exec("COMMIT");
      if (locked !== from) log(`[db] migrations already applied by another window (v${locked})`);
      return { from, to: locked, applied: 0 };
    }
    for (const m of stillPending) {
      log(`[db] migration v${m.version}: ${m.name}`);
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  log(`[db] migrations applied: v${from} → v${latest} (${pending.length})`);
  return { from, to: latest, applied: pending.length };
}

/** Apply the shipped migrations to `db`. */
export function runMigrations(db: DatabaseSync, options: MigrationOptions = {}): MigrationRunResult {
  return applyMigrations(db, MIGRATIONS, options);
}
