import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FileSystem } from "../tools/file-system";
import type { ChatMessage } from "../history/types";
import { isThinkingLevel } from "../config/types";
import { clampLoopGuardOverrides, normalizeLoopGuardSensitivity, type LoopGuardOptions } from "../agent/loop-guard";
import { normalizeToolScope } from "../tools/tool-scope";
import { runMigrations } from "./migrations";
import { recoverSession } from "./session-recovery";
import { SessionConflictError } from "./session-conflict";
import { noteDbOp } from "./store-metrics";
import type {
  DbVacuumResult,
  DbVacuumStats,
  LoadedSession,
  PendingMaintenance,
  SaveMessagesOptions,
  SessionSettingsPatch,
  SessionStore,
  SessionSummary,
} from "./types";

/** One full-text search hit: which message matched, its snippet and BM25 rank. */
interface SessionSearchHit {
  sessionId: string;
  seq: number;
  /** Highlighted excerpt from FTS5 (`[...]` around the matched terms). */
  snippet: string;
  /** BM25 score (lower = more relevant, FTS5 convention). */
  score: number;
}

/** Clamp a persisted parallel cap: a finite integer >= 0 (0 = no cap). */
function toMaxParallelSubAgents(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.trunc(value);
  return n < 0 ? undefined : n;
}

interface SqliteSessionStoreDeps {
  /** An already-open SQLite database (production: `<home>/sessions.db`). */
  db: DatabaseSync;
  /**
   * Where that database lives, when known: lets the maintenance report the REAL size on
   * disk (`sessions.db` + `-wal`) beside the page counters. Absent in the in-memory tests.
   */
  dbPath?: string;
  /** Used only to annotate `folderMissing` at list time (a folder that is gone). */
  fs: FileSystem;
  /** The current workspace root: stamped on new sessions (per-folder bucketing). */
  currentFolder?: () => string | undefined;
  idGen?: () => string;
  /** Diagnostic sink for schema migrations (Output > Harny). */
  log?: (message: string) => void;
  /**
   * How long a WRITE waits for another process's lock before giving up (SQLite `busy_timeout`).
   *
   * Node's default is **0**: a second extension host (another VS Code window on the same machine,
   * same `sessions.db`) hits `database is locked` the instant the first one is mid-transaction, and
   * the write is simply lost. The two connections live in DIFFERENT processes, so waiting cannot
   * self-deadlock (within one process, blocking the only thread while the lock holder waits for it
   * would). Tests pass a small value to measure the wait instead of paying for it.
   */
  busyTimeoutMs?: number;
}

type Row = Record<string, unknown>;

/**
 * SQLite-backed session storage (`node:sqlite`, built into Node >= 22.5).
 *
 * One database holds EVERY session of every workspace (`folder` column), so the
 * cross-folder manager is a plain query — no bucket traversal. Messages live in
 * a `messages` table (one row each, incremental appends) with an FTS5 index for
 * full-text search. The full `ChatMessage` is stored as a JSON `data` column, so
 * no field (thinking / images / tool calls …) is lost, while `content` feeds FTS.
 *
 * SCHEMA: versioned via `migrations.ts` (`PRAGMA user_version`). To add a
 * per-session field: a NEW migration + the four store touch points
 * (`normalizePatch`, `carrySummary`, `upsertSummary`, `rowToSummary`) + the
 * schema snapshot in `migrations.test.ts`. Never edit the baseline migration.
 * Full guide: documentation/MIGRATIONS.md.
 */
export class SqliteSessionStore implements SessionStore {
  private readonly idGen: () => string;
  /**
   * What the file is still owed after a compaction attempt — see `PendingMaintenance`.
   *
   * Kept as STATE, not as a retry: a `busy` checkpoint means another connection owns a read
   * snapshot, and no amount of polling can know when it lets go. The debt is discharged by the
   * first observation of a free WAL (any write here, a click, the end of a turn), which costs a
   * PRAGMA and — for `copy` — moves bytes without rewriting one page.
   */
  private pending: PendingMaintenance = "none";

  constructor(private deps: SqliteSessionStoreDeps) {
    this.idGen = deps.idGen ?? (() => randomUUID());
    // Connection pragmas (persistent; must run OUTSIDE a transaction).
    this.deps.db.exec("PRAGMA journal_mode = WAL;");
    // WAL lets a reader and a writer coexist, but ONE writer at a time is still the rule: this is
    // what turns "another window is saving" from a lost write into a wait (see `busyTimeoutMs`).
    this.deps.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(deps.busyTimeoutMs ?? 5000))};`);
    // Versioned schema migrations (PRAGMA user_version) — see migrations.ts.
    // NO automatic snapshot file next to `sessions.db`: the pending migrations run in a SINGLE
    // transaction (a failure ROLLBACKs to the previous version, byte for byte), and an upgrade
    // must not leave a copy of every user's database behind in globalStorage.
    runMigrations(this.deps.db, { log: deps.log });
  }

  list(): SessionSummary[] {
    const rows = this.deps.db.prepare("SELECT * FROM sessions").all() as Row[];
    // ONE probe per DISTINCT folder, not one per ROW. `folderMissing` used to cost a
    // synchronous stat for EVERY session on every list — and the list is rebuilt on every
    // render, tab switch, rename, run end… With 200 sessions that is 200 syscalls each time,
    // and on a network mount (or a sleeping external disk) each one can take milliseconds on
    // the host thread. Sessions share a handful of folders, so the memo collapses the cost to
    // the number of PROJECTS. It lives for one call only: never stale, never invalidated.
    const probe = new Map<string, boolean>();
    return rows.map((r) => this.rowToSummary(r, probe));
  }

  create(name?: string): SessionSummary {
    const now = Date.now();
    const folder = this.deps.currentFolder?.();
    const summary: SessionSummary = {
      id: this.idGen(),
      name: name?.trim() || "New Session",
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      // The token of a row nobody has written a transcript to yet. Handing it back (instead of
      // `undefined`) means the FIRST save is guarded too: it would otherwise run unguarded and
      // replace whatever another window wrote between the create and the first turn.
      revision: 0,
      ...(folder ? { folder } : {}),
    };
    this.upsertSummary(summary);
    return summary;
  }

  load(id: string): LoadedSession {
    const row = this.deps.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    const summary = row ? this.rowToSummary(row) : this.emptySummary(id);
    const rows = this.deps.db.prepare("SELECT data FROM messages WHERE session_id = ? ORDER BY seq").all(id) as Row[];
    // A stored session can be DAMAGED in two ways a transaction cannot prevent (a
    // rotted row, a tail from a build that could still break a tool pair): both used
    // to throw here, or to wedge every later request. `recoverSession` keeps the head
    // and counts what it left out — the rows stay on disk, and the next ordinary save
    // rewrites them, so the repair becomes real without a destructive statement.
    const recovered = recoverSession(rows.map((r) => String(r.data)));
    const messages = recovered.messages;
    summary.messageCount = messages.length;
    if (recovered.reason) {
      return { summary, messages, repaired: { dropped: recovered.dropped, reason: recovered.reason } };
    }
    return { summary, messages };
  }

  /** The session's metadata alone: no message scan (see the interface note). */
  summary(id: string): SessionSummary | undefined {
    const row = this.deps.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    return row ? this.rowToSummary(row) : undefined;
  }

  /**
   * Persist the session's messages. The caller always passes the WHOLE history,
   * so we APPEND only the new tail when it grew and the stored rows are still a
   * valid prefix (the common per-turn case), and REPLACE everything otherwise
   * (a ✂ cut or a COMPACTION) — never rewrite the whole session on an ordinary
   * save.
   *
   * `options.replace` is the authoritative signal for a rebuild: a compaction
   * can rewrite the head while keeping the SAME length (or even growing by
   * one, when a single span is summarized into two synthetic messages), so a
   * length-only check would silently keep the stale rows. The prefix guard is
   * a safety net for a caller that forgets the flag.
   */
  saveMessages(id: string, messages: ChatMessage[], options: SaveMessagesOptions = {}): SessionSummary {
    // Timed because it is SYNCHRONOUS on the single extension-host thread: a slow
    // COMMIT here is a stall for every OTHER streaming session (see store-metrics).
    const startedAt = performance.now();
    try {
      return this.saveMessagesNow(id, messages, options);
    } finally {
      noteDbOp("saveMessages", performance.now() - startedAt);
      // A pending COPY (pages a VACUUM rebuilt that the `-wal` could not hand back) is discharged
      // by the first write that finds the file free: the user does not have to click again for it.
      this.drainCopiedIfPending();
    }
  }

  private saveMessagesNow(id: string, messages: ChatMessage[], options: SaveMessagesOptions = {}): SessionSummary {
    // Read OUTSIDE the lock: this is the metadata shape (name, model, `folderMissing`'s stat) and
    // holding a write lock across a filesystem probe would block every other window for a syscall.
    const existing = this.getSummary(id);
    // IMMEDIATE, not the default DEFERRED: the lock must be taken BEFORE the reads below, because
    // what they decide (append or REPLACE) is only correct against a transcript nobody can move.
    // With DEFERRED the reads run unlocked and the upgrade to a writer can fail afterwards — the
    // decision is then already made on a snapshot another host has replaced (`BUSY_SNAPSHOT`), and
    // `replace` deletes rows this caller never saw.
    this.deps.db.exec("BEGIN IMMEDIATE");
    try {
      const storedRevision = this.readRevision(id);
      if (options.revision !== undefined && options.revision !== storedRevision) {
        // Nothing is written, nothing is rolled back that mattered: refuse, and say what the store
        // holds so the caller can decide (see `session-conflict.ts`).
        throw new SessionConflictError(id, storedRevision);
      }
      const storedCount = this.countMessages(id);
      const replace = options.replace === true || !this.storedMessagesArePrefix(id, messages, storedCount);
      if (replace) {
        this.deps.db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
      }
      const from = replace ? 0 : storedCount;
      const insert = this.deps.db.prepare(
        "INSERT INTO messages(session_id, seq, role, content, timestamp, data) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (let i = from; i < messages.length; i++) {
        const m = messages[i];
        insert.run(id, i, String(m.role), m.content ?? "", m.timestamp ?? 0, JSON.stringify(m));
      }
      const summary = this.carrySummary(id, existing, messages);
      this.upsertSummary(summary);
      // Bumped in the SAME transaction as the rows it describes, and never decreased: the value is
      // read here, under the lock, so two hosts cannot compute the same next revision.
      this.deps.db.prepare("UPDATE sessions SET revision = ? WHERE id = ?").run(storedRevision + 1, id);
      summary.revision = storedRevision + 1;
      this.deps.db.exec("COMMIT");
      return summary;
    } catch (e) {
      this.deps.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** The stored transcript token, 0 when the row is gone (a save to a deleted session recreates it). */
  private readRevision(id: string): number {
    const row = this.deps.db.prepare("SELECT revision FROM sessions WHERE id = ?").get(id) as Row | undefined;
    const revision = Number(row?.revision ?? 0);
    return Number.isFinite(revision) ? revision : 0;
  }

  rename(id: string, name: string): SessionSummary {
    // ONE statement, only the columns a rename owns. This used to be
    // getSummary → carrySummary → upsertSummary, i.e. a full-row rewrite built from a snapshot
    // read: a settings write landing in between (a metric flush, another window's model change)
    // put its own OLD `name` back, and the rename silently reverted. `message_count` is
    // repaired in the same statement — it is what the snapshot used to recompute — and the
    // row is only CREATED when it is genuinely missing (a rename of a session another window
    // just deleted must not resurrect it, which is why the upsert is the fallback, not the rule).
    const updatedAt = Date.now();
    const changes = this.upsertName(id, name, updatedAt);
    if (changes === 0) {
      // No row: keep the historical behaviour of a settings write creating it.
      const summary = this.carrySummary(id, undefined, [], { name, updatedAt });
      summary.messageCount = this.countMessages(id);
      this.upsertSummary(summary);
      return summary;
    }
    return this.getSummary(id) ?? this.carrySummary(id, undefined, [], { name, updatedAt });
  }

  /** `name` + `updated_at` + a message-count repair, for one row. Returns rows touched. */
  private upsertName(id: string, name: string, updatedAt: number): number {
    const r = this.deps.db
      .prepare(
        `UPDATE sessions SET name = ?, updated_at = ?,
           message_count = (SELECT COUNT(*) FROM messages WHERE session_id = sessions.id)
         WHERE id = ?`,
      )
      .run(name, updatedAt, id);
    return Number(r.changes ?? 0);
  }

  remove(id: string): boolean {
    const existed = !!this.deps.db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(id);
    // IMMEDIATE for the same reason `saveMessages` uses it: the existence check above and the
    // DELETE below must describe the same database.
    this.deps.db.exec("BEGIN IMMEDIATE");
    try {
      this.deps.db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
      this.deps.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      this.deps.db.exec("COMMIT");
    } catch (e) {
      this.deps.db.exec("ROLLBACK");
      throw e;
    }
    // A delete frees pages: if a compaction was left owing its copy, this is as good a moment as any.
    this.drainCopiedIfPending();
    return existed;
  }

  /**
   * Atomically persist a subset of the per-session settings (a single UPDATE).
   * The patch is normalized with the same semantics as the JSONL store: a key
   * present (even `undefined`) SETS or CLEARS that field.
   */
  saveSettings(id: string, patch: SessionSettingsPatch): SessionSummary {
    const startedAt = performance.now();
    try {
      return this.saveSettingsNow(id, patch);
    } finally {
      noteDbOp("saveSettings", performance.now() - startedAt);
      this.drainCopiedIfPending();
    }
  }

  private saveSettingsNow(id: string, patch: SessionSettingsPatch): SessionSummary {
    const normalized = this.normalizePatch(patch);
    // A single UPDATE of the columns the caller NAMED.
    //
    // This was `getSummary` → `carrySummary` → `upsertSummary`: a full-row rewrite from a
    // snapshot, so two writers interleaving (this window's metric flush, another window's
    // rename/model change — the panel and the manager are separate entry points on the same
    // row) put each other's OLD values back: the classic lost update. Nothing here reads a row
    // to write it back, so there is nothing to lose. `revision` is NOT in the column map: it is
    // the optimistic-lock token of `saveMessages` and no settings write may move it.
    const assignments = settingAssignments(normalized);
    const changes = this.deps.db
      .prepare(`UPDATE sessions SET updated_at = ?${assignments.sets.map((s) => `, ${s}`).join("")} WHERE id = ?`)
      .run(Date.now(), ...assignments.values, id);
    if (Number(changes.changes ?? 0) === 0) {
      // The row does not exist (yet): create it, exactly as before.
      const summary = this.carrySummary(id, undefined, [], { ...normalized, updatedAt: Date.now() });
      summary.messageCount = this.countMessages(id);
      this.upsertSummary(summary);
      return summary;
    }
    // Read the result BACK instead of assembling it from the snapshot: the row now holds the
    // truth (another window's `name` included), and `message_count` is the column, not a recount
    // of what this patch happened to know about.
    return this.getSummary(id) ?? this.carrySummary(id, undefined, [], { ...normalized, updatedAt: Date.now() });
  }

  /**
   * Full-text search across every message of every session. The query uses
   * FTS5 syntax (`term`, `"a phrase"`, `a OR b`, `pre*`); if the syntax is
   * invalid (e.g. an unbalanced quote) it falls back to matching the input as a
   * literal PHRASE, so a plain typed string never errors.
   */
  search(query: string, limit = 50): SessionSearchHit[] {
    const q = query.trim();
    if (!q) return [];
    try {
      return this.runSearch(q, limit);
    } catch {
      try {
        return this.runSearch(`"${q.replace(/"/g, '""')}"`, limit);
      } catch {
        return [];
      }
    }
  }

  private runSearch(match: string, limit: number): SessionSearchHit[] {
    // SECURITY: the SQL text is STATIC and the user query is bound as a
    // PARAMETER (`?`) — never concatenated — so it cannot inject SQL. (The
    // `"..."` fallback builds an FTS QUERY string, still passed as a bound
    // value, not as SQL.) Every other statement in this store is parameterized
    // the same way.
    const rows = this.deps.db
      .prepare(
        `SELECT m.session_id AS sessionId, m.seq AS seq,
                snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet,
                bm25(messages_fts) AS score
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         WHERE messages_fts MATCH ?
         ORDER BY score
         LIMIT ?`,
      )
      .all(match, limit) as Row[];
    return rows.map((r) => ({
      sessionId: String(r.sessionId),
      seq: Number(r.seq),
      snippet: String(r.snippet ?? ""),
      score: Number(r.score ?? 0),
    }));
  }

  /** Close the underlying database (tests / shutdown). */
  close(): void {
    this.deps.db.close();
  }

  /**
   * Cheap (O(1), DB-header only) size stats: how many pages are FREE
   * (reclaimable holes left by ✂ cuts / session deletes) vs the total — plus the REAL
   * footprint on disk (`sessions.db` + its `-wal`) when the store knows the path. The page
   * counters say "how much is reclaimable", the footprint says "did it empty", and only the
   * second one is the number the user sees in Finder.
   *
   * The footprint belongs HERE, not only in the compaction report: the panel OPENs on these
   * numbers, and a figure that appears for the first time after the click is one the user has
   * nothing to compare it with.
   */
  dbVacuumStats(): DbVacuumStats {
    let pageCount = 0;
    let freePages = 0;
    let pageSize = 0;
    try {
      pageCount = Number((this.deps.db.prepare("PRAGMA page_count").get() as Row)?.page_count ?? 0);
      freePages = Number((this.deps.db.prepare("PRAGMA freelist_count").get() as Row)?.freelist_count ?? 0);
      pageSize = Number((this.deps.db.prepare("PRAGMA page_size").get() as Row)?.page_size ?? 0);
    } catch {
      /* best effort */
    }
    const stats: DbVacuumStats = {
      pageCount,
      freePages,
      pageSize,
      bytesFree: freePages * pageSize,
      bytesTotal: pageCount * pageSize,
      ratio: pageCount > 0 ? freePages / pageCount : 0,
    };
    const path = this.deps.dbPath;
    if (!path) return stats; // `:memory:` in the tests: there is no file to measure
    try {
      const wal = `${path}-wal`;
      return {
        ...stats,
        bytesOnDisk: this.deps.fs.size(path),
        walBytes: this.deps.fs.exists(wal) ? this.deps.fs.size(wal) : 0,
      };
    } catch {
      return stats; // best effort: a vanished file is not a failed compaction
    }
  }

  /**
   * Best-effort maintenance: drain the WAL, VACUUM when the free-page ratio reaches the
   * threshold (0 = force), then OPTIMIZE the indexes and checkpoint again.
   * Index work is kept here because VACUUM does NOT merge FTS5 segments:
   *  · `PRAGMA optimize` refreshes the query-planner statistics when useful;
   *  · the FTS5 `optimize` command merges the full-text segments accumulated
   *    by many inserts/deletes (smaller + faster full-text search).
   * Returns before/after stats for the UI. NEVER throws — but nothing is silent either.
   *
   * THE ONE THING IT REFUSES: compacting a database another connection is READING. The page
   * counters would drop to zero anyway (the VACUUM really does rebuild the file), and until a
   * checkpoint can copy it back those rebuilt pages just sit in `sessions.db-wal`:
   * measured on a 78 MB database with a reader holding a snapshot, logical size 78 → 19 MB
   * while the file stayed at 156 MB, and every further VACUUM appended ANOTHER full copy of
   * the database to the WAL it could not truncate — 100 → 120 → 140 MB. So "click again" did
   * not just fail to help, it made the file bigger. Writing nothing is the honest move: the
   * next call, reader gone, takes the same file from 140 MB to 19 MB in a single pass.
   *
   * The reader is only VISIBLE from the second click, though: the drain below can only report
   * `busy` when there is something to drain, and on the first click the WAL is empty — the
   * checkpoint answers `ok 0/0` and nothing distinguishes it from a free file. That first
   * VACUUM is unavoidable; it is the repetition that gets refused, and the repetition is what
   * used to pile up copies.
   *
   * WHAT IS OWED IS REMEMBERED (see `PendingMaintenance`). A refusal is not a dead end and a
   * pinned VACUUM is not a failed one: the request stays queued as `compact`, or the rebuilt
   * pages wait in the `-wal` as `copy` until any write finds the file free. Measured: after a
   * pinned VACUUM, one bare `wal_checkpoint(TRUNCATE)` took the file from 32 MB to 5 MB where a
   * second VACUUM (16 ms, same pages) only re-appended 5 MB to the WAL and changed nothing.
   * The debt is settled by an OBSERVATION, never by a stopwatch: `busy` belongs to another
   * process, and retrying N times would be guessing at an event nobody here can see.
   *
   * A FORCED CLICK (`freeRatioThreshold: 0`, what the modal's button sends) means "ignore the
   * ratio", not "rewrite the file whatever it costs": the free list is re-measured after the two
   * optimizes and a pass with no free page writes NOTHING, so the second click on an already
   * compact database is free and says so — instead of copying every page to reclaim zero bytes
   * and reporting it as work done.
   */
  maintain(options: { freeRatioThreshold?: number } = {}): DbVacuumResult {
    const threshold = options.freeRatioThreshold ?? 0.2;
    const startedAt = Date.now();
    // 0) The REAL state at the moment of the click: the size the user sees in Finder, before
    //    anything moves. Measured first, or the drain below would hide what was reclaimed.
    const before = this.dbVacuumStats();
    // 1) Drain and truncate the WAL, and BELIEVE the answer: `busy` means another connection
    //    holds a read snapshot, so no rebuilt page can reach `sessions.db` — and a VACUUM now
    //    would only append another copy of the database to a `-wal` nobody can truncate.
    //    (`busy` with an EMPTY WAL is impossible: the first click cannot know, the next one can.)
    const drained = this.checkpoint();
    if (drained.busy) {
      // The whole pass is still owed to the file: remember it, so nobody has to remember to click
      // again (see `settlePending`).
      this.pending = "compact";
      const stats = { vacuumed: false, before, after: before, durationMs: Date.now() - startedAt };
      this.deps.log?.(
        `maintain: skipped, the WAL checkpoint is BUSY (another connection is reading ${this.deps.dbPath ?? "the database"}) — nothing was written, compaction left PENDING`,
      );
      return { ...stats, walCheckpointBusy: true, pendingMaintenance: "compact" };
    }
    // 2) Optimize the INDEXES FIRST: merging FTS5 segments and refreshing the
    //    planner stats FREES/REWRITES pages, so the VACUUM below reclaims them
    //    too (doing it after the VACUUM would leave new holes behind).
    try {
      this.deps.db.exec("PRAGMA optimize");
    } catch (e) {
      this.deps.log?.(`maintain: PRAGMA optimize failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      this.deps.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('optimize')");
    } catch (e) {
      this.deps.log?.(`maintain: FTS5 optimize failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // 3) Page compaction, when the free-page ratio reaches the threshold. One pass is all it
    //    takes: a VACUUM that commits rebuilds the file from scratch, so the free list is 0
    //    afterwards — verified, not assumed (a second pass changes no page counter at all).
    //    Re-measured HERE, after the optimizes: merging FTS segments is what frees pages, and
    //    a VACUUM that reclaims nothing rewrites the whole file for zero bytes — on a forced
    //    click (threshold 0) that meant a full synchronous copy of the database per click,
    //    which is the "I keep clicking and the numbers never move" the panel used to report
    //    as "Vacuumed & optimized". No free page, no pass.
    const reclaimable = this.dbVacuumStats();
    let vacuumed = false;
    let error: string | undefined;
    if (reclaimable.pageCount > 0 && reclaimable.freePages > 0 && reclaimable.ratio >= threshold) {
      try {
        this.deps.db.exec("VACUUM");
        vacuumed = true;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    // 4) Copy the rebuilt pages back into `sessions.db` and truncate the `-wal`. A reader that
    //    appeared meanwhile reports `busy` WITHOUT throwing: say it, so "the pages are compact
    //    but the file is not" stops being a mystery.
    const checkpoint = this.checkpoint();
    const after = this.dbVacuumStats();
    // A VACUUM that ran but could not be copied back leaves a debt that is a COPY, not another
    // VACUUM: the rebuilt pages are already in the `-wal`, and repeating the compaction is exactly
    // what used to append one more full copy per click. A real failure (full disk…) is not a debt
    // — retrying it automatically would only fail again. And a pass that wrote NOTHING owes
    // nothing: a `busy` checkpoint there is another connection's business, and remembering a
    // "copy" would queue a checkpoint over pages that were never rebuilt.
    this.pending = vacuumed && checkpoint.busy && !error ? "copy" : "none";
    this.deps.log?.(
      `maintain: vacuumed=${vacuumed}, free pages ${before.freePages}->${after.freePages}, ` +
        `file ${before.bytesOnDisk ?? "?"}->${after.bytesOnDisk ?? "?"} bytes on disk, ` +
        `checkpoint ${checkpoint.busy ? "BUSY" : `ok (${checkpoint.checkpointed}/${checkpoint.log})`}` +
        `, pending=${this.pending}` +
        (error ? `, error: ${error}` : ""),
    );
    return {
      vacuumed,
      before,
      after,
      durationMs: Date.now() - startedAt,
      ...(error ? { error } : {}),
      ...(checkpoint.busy ? { walCheckpointBusy: true } : {}),
      pendingMaintenance: this.pending,
    };
  }

  /** What the file is still owed after a compaction attempt (`none` when nothing is). */
  pendingMaintenance(): PendingMaintenance {
    return this.pending;
  }

  /**
   * Discharge what `maintain()` left owed, if the file allows it now.
   *
   * `undefined` when nothing was owed — so any write path can call it on every save for free.
   * The `compact` branch runs a full synchronous VACUUM: only an idle-gated caller may reach it
   * (`chat-view` checks `dbBusy()` first); the write paths below go through `drainCopiedPages`,
   * which can only move bytes.
   */
  settlePending(): DbVacuumResult | undefined {
    if (this.pending === "none") return undefined;
    if (this.pending === "copy") return this.drainCopiedPages();
    // An explicit request outranks the free-page threshold: the user already decided.
    return this.maintain({ freeRatioThreshold: 0 });
  }

  /**
   * The cheap half of `settlePending`: copy the pages a previous VACUUM already rebuilt into the
   * `-wal` back into `sessions.db` and truncate it. No VACUUM, so no page is rewritten and the file
   * cannot grow — which is why every write path can afford to try it.
   *
   * Still pinned: nothing changes and the debt stays.
   */
  private drainCopiedPages(): DbVacuumResult {
    const startedAt = Date.now();
    const before = this.dbVacuumStats();
    const checkpoint = this.checkpoint();
    const after = this.dbVacuumStats();
    if (checkpoint.busy) {
      this.deps.log?.(
        `settle: the copy is still BUSY (another connection is reading ${this.deps.dbPath ?? "the database"}) — the debt stays`,
      );
      return {
        vacuumed: false,
        before,
        after,
        durationMs: Date.now() - startedAt,
        walCheckpointBusy: true,
        pendingMaintenance: "copy",
      };
    }
    this.pending = "none";
    this.deps.log?.(
      `settle: copied the compacted pages into ${this.deps.dbPath ?? "the database"} — ` +
        `${before.bytesOnDisk ?? "?"}->${after.bytesOnDisk ?? "?"} bytes on disk`,
    );
    return {
      vacuumed: false,
      before,
      after,
      durationMs: Date.now() - startedAt,
      pendingMaintenance: "none",
      copied: true,
    };
  }

  /**
   * Called from the write paths. Only the `copy` debt is discharged here: it touches bytes, not
   * pages, and must never run a VACUUM inside a save (it would freeze the host mid-turn).
   */
  private drainCopiedIfPending(): void {
    if (this.pending !== "copy") return;
    try {
      this.drainCopiedPages();
    } catch {
      /* best effort: a failed copy is not a failed save, and the debt stays for the next one */
    }
  }

  /**
   * `PRAGMA wal_checkpoint(TRUNCATE)`, reporting what actually happened.
   *
   * It answers `busy` instead of throwing when it cannot copy the WAL back, and `exec()`
   * throws the row away — which is exactly how "the pages are compacted but the file is
   * still huge" stayed invisible. `:memory:` has no WAL: there is nothing to report.
   */
  private checkpoint(): { busy: boolean; log: number; checkpointed: number } {
    try {
      const row = this.deps.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as Row | undefined;
      return {
        busy: Number(row?.busy ?? 0) !== 0,
        log: Number(row?.log ?? 0),
        checkpointed: Number(row?.checkpointed ?? 0),
      };
    } catch {
      return { busy: false, log: 0, checkpointed: 0 };
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * True when the stored rows are a byte-for-byte PREFIX of `messages`, i.e. the
   * new array is a pure append and the fast path is safe. A shrink is never a
   * prefix. For an equal count (the ambiguous rebuild case) every row is
   * compared, so a compaction that keeps the same length is still detected.
   */
  private storedMessagesArePrefix(id: string, messages: ChatMessage[], storedCount: number): boolean {
    if (storedCount === 0) return true;
    if (messages.length < storedCount) return false;
    const last = this.deps.db
      .prepare("SELECT data FROM messages WHERE session_id = ? AND seq = ?")
      .get(id, storedCount - 1) as Row | undefined;
    if (!last || String(last.data) !== JSON.stringify(messages[storedCount - 1])) return false;
    // Grew by at least one and the boundary message matches: trust the append
    // (the app never edits a middle message in place).
    if (messages.length > storedCount) return true;
    // Equal length: verify the whole prefix (the compaction-rebuild shape).
    const rows = this.deps.db.prepare("SELECT data FROM messages WHERE session_id = ? ORDER BY seq").all(id) as Row[];
    if (rows.length !== storedCount) return false;
    for (let i = 0; i < storedCount; i++) {
      if (String(rows[i].data) !== JSON.stringify(messages[i])) return false;
    }
    return true;
  }

  private countMessages(id: string): number {
    const row = this.deps.db.prepare("SELECT COUNT(*) AS c FROM messages WHERE session_id = ?").get(id) as Row;
    return Number(row?.c ?? 0);
  }

  private getSummary(id: string): SessionSummary | undefined {
    const row = this.deps.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    return row ? this.rowToSummary(row) : undefined;
  }

  private emptySummary(id: string): SessionSummary {
    const now = Date.now();
    // `revision: 0`: a session that is NOT on disk yet. Its first save creates the row at
    // revision 0, so handing the token back keeps that save guarded like any other.
    return { id, name: "Session", createdAt: now, updatedAt: now, messageCount: 0, revision: 0 };
  }

  /**
   * Base summary for a mutation: the new identity plus every persisted
   * per-session field carried forward (this is what keeps model / provider /
   * thinking / limits alive across a plain message save).
   */
  private carrySummary(
    id: string,
    existing: SessionSummary | undefined,
    messages: ChatMessage[],
    extra: Partial<SessionSummary> = {},
  ): SessionSummary {
    return {
      id,
      name: extra.name ?? existing?.name ?? "New Session",
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: extra.updatedAt ?? Date.now(),
      messageCount: messages.length,
      ...(existing?.folder ? { folder: existing.folder } : {}),
      ...(existing?.model ? { model: existing.model } : {}),
      ...(existing?.modelProvider ? { modelProvider: existing.modelProvider } : {}),
      ...(existing?.thinkingLevel ? { thinkingLevel: existing.thinkingLevel } : {}),
      ...(existing?.contextWindow ? { contextWindow: existing.contextWindow } : {}),
      ...(existing?.compactionThresholdPercent
        ? { compactionThresholdPercent: existing.compactionThresholdPercent }
        : {}),
      ...(existing?.compactionTargetPercent !== undefined
        ? { compactionTargetPercent: existing.compactionTargetPercent }
        : {}),
      ...(existing?.contextTokens ? { contextTokens: existing.contextTokens } : {}),
      ...(existing?.outputTokens ? { outputTokens: existing.outputTokens } : {}),
      // 0 is a VALID value for these: `!== undefined`, not truthiness.
      ...(existing?.temperature !== undefined ? { temperature: existing.temperature } : {}),
      ...(existing?.presencePenalty !== undefined ? { presencePenalty: existing.presencePenalty } : {}),
      ...(existing?.frequencyPenalty !== undefined ? { frequencyPenalty: existing.frequencyPenalty } : {}),
      ...(existing?.topP !== undefined ? { topP: existing.topP } : {}),
      ...(existing?.sampler ? { sampler: existing.sampler } : {}),
      ...(existing?.maxParallelSubAgents !== undefined ? { maxParallelSubAgents: existing.maxParallelSubAgents } : {}),
      ...(existing?.mode ? { mode: existing.mode } : {}),
      ...(existing?.parallel !== undefined ? { parallel: existing.parallel } : {}),
      ...(existing?.toolScope ? { toolScope: existing.toolScope } : {}),
      ...(existing?.loopGuard ? { loopGuard: existing.loopGuard } : {}),
      ...(existing?.loopGuardResponse ? { loopGuardResponse: existing.loopGuardResponse } : {}),
      ...(existing?.loopGuardParams ? { loopGuardParams: existing.loopGuardParams } : {}),
      // Carried, not bumped: only `saveMessages` moves the transcript token (a rename or a
      // settings write changes no message, and invalidating a token would refuse a save nobody
      // asked to lose). Dropping it here would also make `rename`/`saveSettings` hand back a
      // summary whose token is undefined, i.e. a host that would stop sending one.
      ...(existing?.revision !== undefined ? { revision: existing.revision } : {}),
      ...extra,
    };
  }

  /** Validate/clear semantics for a settings patch (mirrors the JSONL store). */
  private normalizePatch(patch: SessionSettingsPatch): Partial<SessionSummary> {
    const out: Partial<SessionSummary> = {};
    const folder = patch.folder?.trim();
    if (folder) out.folder = folder;
    if (patch.model) out.model = patch.model;
    if (patch.modelProvider) out.modelProvider = patch.modelProvider;
    // An EXPLICIT key CLEARS when it is not a valid level (mirrors the
    // temperature/penalties handling): `{ thinkingLevel: undefined }` clears it.
    if ("thinkingLevel" in patch) {
      out.thinkingLevel = isThinkingLevel(patch.thinkingLevel) ? patch.thinkingLevel : undefined;
    }
    if (typeof patch.contextWindow === "number") out.contextWindow = patch.contextWindow;
    if (typeof patch.compactionThresholdPercent === "number") {
      out.compactionThresholdPercent = patch.compactionThresholdPercent;
    }
    // A key PRESENT clears when it is not a number (the AUTO landing point), the same
    // semantics temperature/penalties use: `{ compactionTargetPercent: undefined }`
    // means "follow the trigger again", not "leave it alone".
    if ("compactionTargetPercent" in patch) {
      out.compactionTargetPercent =
        typeof patch.compactionTargetPercent === "number" ? patch.compactionTargetPercent : undefined;
    }
    if (typeof patch.contextTokens === "number") out.contextTokens = patch.contextTokens;
    if (typeof patch.outputTokens === "number") out.outputTokens = patch.outputTokens;
    if ("temperature" in patch) out.temperature = patch.temperature;
    if ("presencePenalty" in patch) out.presencePenalty = patch.presencePenalty;
    if ("frequencyPenalty" in patch) out.frequencyPenalty = patch.frequencyPenalty;
    if ("topP" in patch) out.topP = patch.topP;
    if ("sampler" in patch) out.sampler = patch.sampler;
    if ("maxParallelSubAgents" in patch) out.maxParallelSubAgents = toMaxParallelSubAgents(patch.maxParallelSubAgents);
    if ("mode" in patch) out.mode = patch.mode === "agent" || patch.mode === "analyze" ? patch.mode : undefined;
    if ("parallel" in patch) out.parallel = patch.parallel === true ? true : undefined;
    // Normalized on the way IN, so junk never reaches the column and an equal scope stays
    // byte-identical (see normalizeToolScope: trimmed, deduplicated, order-preserving).
    if ("toolScope" in patch) out.toolScope = normalizeToolScope(patch.toolScope);
    if ("loopGuard" in patch) out.loopGuard = normalizeLoopGuardSensitivity(patch.loopGuard);
    if ("loopGuardResponse" in patch) out.loopGuardResponse = patch.loopGuardResponse === true ? true : undefined;
    if ("loopGuardParams" in patch) out.loopGuardParams = clampLoopGuardOverrides(patch.loopGuardParams);
    return out;
  }

  /** INSERT or fully replace one session row (all columns from the summary). */
  private upsertSummary(s: SessionSummary): void {
    this.deps.db
      .prepare(
        `INSERT INTO sessions (
           id, name, folder, created_at, updated_at, message_count,
           model, model_provider, thinking_level, context_window, compaction_threshold_percent,
           compaction_target_percent,
           context_tokens, output_tokens, temperature, presence_penalty, frequency_penalty,
           top_p, sampler, max_parallel_sub_agents, mode, parallel, tool_scope, loop_guard, loop_guard_response, loop_guard_params
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, folder=excluded.folder, created_at=excluded.created_at,
           updated_at=excluded.updated_at, message_count=excluded.message_count,
           model=excluded.model, model_provider=excluded.model_provider,
           thinking_level=excluded.thinking_level, context_window=excluded.context_window,
           compaction_threshold_percent=excluded.compaction_threshold_percent,
           compaction_target_percent=excluded.compaction_target_percent,
           context_tokens=excluded.context_tokens, output_tokens=excluded.output_tokens,
           temperature=excluded.temperature, presence_penalty=excluded.presence_penalty,
           frequency_penalty=excluded.frequency_penalty, top_p=excluded.top_p,
           sampler=excluded.sampler, max_parallel_sub_agents=excluded.max_parallel_sub_agents,
           mode=excluded.mode, parallel=excluded.parallel, tool_scope=excluded.tool_scope,
           loop_guard=excluded.loop_guard, loop_guard_response=excluded.loop_guard_response,
           loop_guard_params=excluded.loop_guard_params`,
      )
      .run(
        s.id,
        s.name,
        s.folder ?? null,
        s.createdAt,
        s.updatedAt,
        s.messageCount,
        s.model ?? null,
        s.modelProvider ?? null,
        s.thinkingLevel ?? null,
        s.contextWindow ?? null,
        s.compactionThresholdPercent ?? null,
        s.compactionTargetPercent ?? null,
        s.contextTokens ?? null,
        s.outputTokens ?? null,
        s.temperature ?? null,
        s.presencePenalty ?? null,
        s.frequencyPenalty ?? null,
        s.topP ?? null,
        s.sampler ?? null,
        s.maxParallelSubAgents ?? null,
        s.mode ?? null,
        s.parallel === true ? 1 : null,
        s.toolScope ? JSON.stringify(s.toolScope) : null,
        s.loopGuard ?? null,
        s.loopGuardResponse === true ? 1 : null,
        s.loopGuardParams ? JSON.stringify(s.loopGuardParams) : null,
      );
  }

  /**
   * Does this folder still exist? `probe` memoizes the answer for ONE list() call (see the note
   * there); without it — a single-row read — the question is asked directly.
   */
  private folderPresent(folder: string, probe?: Map<string, boolean>): boolean {
    const cached = probe?.get(folder);
    if (cached !== undefined) return cached;
    const present = this.deps.fs.exists(folder);
    probe?.set(folder, present);
    return present;
  }

  private rowToSummary(r: Row, probe?: Map<string, boolean>): SessionSummary {
    const folder = typeof r.folder === "string" && r.folder.trim() ? r.folder : undefined;
    const loopGuard = normalizeLoopGuardSensitivity(r.loop_guard);
    const cap = toMaxParallelSubAgents(r.max_parallel_sub_agents);
    let loopGuardParams: Partial<LoopGuardOptions> | undefined;
    if (typeof r.loop_guard_params === "string" && r.loop_guard_params) {
      try {
        loopGuardParams = clampLoopGuardOverrides(JSON.parse(r.loop_guard_params));
      } catch {
        loopGuardParams = undefined;
      }
    }
    const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
    return {
      id: String(r.id),
      name: String(r.name ?? "Session"),
      createdAt: Number(r.created_at ?? 0),
      updatedAt: Number(r.updated_at ?? 0),
      messageCount: Number(r.message_count ?? 0),
      ...(typeof r.revision === "number" ? { revision: r.revision } : {}),
      ...(folder ? { folder } : {}),
      ...(folder && !this.folderPresent(folder, probe) ? { folderMissing: true } : {}),
      ...(typeof r.model === "string" ? { model: r.model } : {}),
      ...(typeof r.model_provider === "string" ? { modelProvider: r.model_provider } : {}),
      ...(typeof r.thinking_level === "string" && isThinkingLevel(r.thinking_level)
        ? { thinkingLevel: r.thinking_level }
        : {}),
      ...(num(r.context_window) !== undefined ? { contextWindow: num(r.context_window) } : {}),
      ...(num(r.compaction_threshold_percent) !== undefined
        ? { compactionThresholdPercent: num(r.compaction_threshold_percent) }
        : {}),
      ...(num(r.compaction_target_percent) !== undefined
        ? { compactionTargetPercent: num(r.compaction_target_percent) }
        : {}),
      ...(num(r.context_tokens) !== undefined ? { contextTokens: num(r.context_tokens) } : {}),
      ...(num(r.output_tokens) !== undefined ? { outputTokens: num(r.output_tokens) } : {}),
      ...(num(r.temperature) !== undefined ? { temperature: num(r.temperature) } : {}),
      ...(num(r.presence_penalty) !== undefined ? { presencePenalty: num(r.presence_penalty) } : {}),
      ...(num(r.frequency_penalty) !== undefined ? { frequencyPenalty: num(r.frequency_penalty) } : {}),
      ...(num(r.top_p) !== undefined ? { topP: num(r.top_p) } : {}),
      ...(r.sampler === "temperature" || r.sampler === "topP" ? { sampler: r.sampler } : {}),
      ...(cap !== undefined ? { maxParallelSubAgents: cap } : {}),
      ...(r.mode === "analyze" || r.mode === "agent" ? { mode: r.mode } : {}),
      ...(r.parallel === 1 ? { parallel: true } : {}),
      ...(normalizeToolScope(r.tool_scope) ? { toolScope: normalizeToolScope(r.tool_scope) } : {}),
      ...(loopGuard ? { loopGuard } : {}),
      ...(r.loop_guard_response === 1 ? { loopGuardResponse: true } : {}),
      ...(loopGuardParams ? { loopGuardParams } : {}),
    };
  }
}

/**
 * Summary field → column, for the PARTIAL update of a settings patch.
 * One table on purpose: a setting added to `normalizePatch` without a column here would make
 * `saveSettings` look like it worked while changing nothing, which is the hardest bug to see.
 * `revision` is absent by design — it is `saveMessages`' optimistic-lock token, and no settings
 * write may move it. The `encode` mirrors `upsertSummary` byte for byte (1/NULL instead of
 * true/false, JSON text instead of objects) so both writers produce the same row contents.
 */
const SETTING_COLUMNS: Record<string, { column: string; encode?: (v: unknown) => SQLValue }> = {
  folder: { column: "folder" },
  model: { column: "model" },
  modelProvider: { column: "model_provider" },
  thinkingLevel: { column: "thinking_level" },
  contextWindow: { column: "context_window" },
  compactionThresholdPercent: { column: "compaction_threshold_percent" },
  compactionTargetPercent: { column: "compaction_target_percent" },
  contextTokens: { column: "context_tokens" },
  outputTokens: { column: "output_tokens" },
  temperature: { column: "temperature" },
  presencePenalty: { column: "presence_penalty" },
  frequencyPenalty: { column: "frequency_penalty" },
  topP: { column: "top_p" },
  sampler: { column: "sampler" },
  maxParallelSubAgents: { column: "max_parallel_sub_agents" },
  mode: { column: "mode" },
  parallel: { column: "parallel", encode: (v) => (v === true ? 1 : null) },
  toolScope: { column: "tool_scope", encode: (v) => (v ? JSON.stringify(v) : null) },
  loopGuard: { column: "loop_guard" },
  loopGuardResponse: { column: "loop_guard_response", encode: (v) => (v === true ? 1 : null) },
  loopGuardParams: { column: "loop_guard_params", encode: (v) => (v ? JSON.stringify(v) : null) },
};

/** What a column can hold (the node:sqlite bindable set, minus the binary we never store). */
type SQLValue = string | number | null;

/** `column = ?` for every key the patch CARRIES, and for nothing else. */
function settingAssignments(patch: Partial<SessionSummary>): { sets: string[]; values: SQLValue[] } {
  const sets: string[] = [];
  const values: SQLValue[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const spec = SETTING_COLUMNS[key];
    if (!spec) throw new Error(`saveSettings: no column for setting "${key}"`);
    sets.push(`${spec.column} = ?`);
    values.push(spec.encode ? spec.encode(value) : ((value as SQLValue | undefined) ?? null));
  }
  return { sets, values };
}
