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
 */
export interface Migration {
  /** Strictly increasing (1, 2, 3 …). Never reused or reordered. */
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
  /** true = may destroy data → a backup is taken before it runs. */
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
];

/** The version this build expects after running every migration. */
export const LATEST_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1].version;

/** Read the database's schema version (0 = never versioned). */
export function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

export interface MigrationRunResult {
  from: number;
  to: number;
  applied: number;
}

export interface MigrationOptions {
  /** Diagnostic sink (one line per applied migration). */
  log?: (message: string) => void;
  /** Called ONCE before running pending migrations when at least one is
   * `destructive` (so the caller can copy the database file first). */
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
  db.exec("BEGIN");
  try {
    for (const m of pending) {
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
