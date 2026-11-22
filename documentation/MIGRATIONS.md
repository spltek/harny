# Database migrations

Harny's session storage is a single SQLite database (`<home>/sessions.db`, opened
with the built-in `node:sqlite`). Its schema is versioned with SQLite's
`PRAGMA user_version` and evolved through an **ordered, immutable** list of
migrations in [`src/core/sessions/migrations.ts`](../src/core/sessions/migrations.ts).

This document is the reference for changing the schema.

---

## TL;DR — adding a column

1. **Add a migration** to `MIGRATIONS` in `src/core/sessions/migrations.ts`
   (append; never edit migration 1).
2. **Update the four store touch points** in `sqlite-session-store.ts`
   (`normalizePatch`, `carrySummary`, `upsertSummary`, `rowToSummary`) + the
   types in `sessions/types.ts`.
3. **Update the schema snapshot** in `migrations.test.ts`.
4. **Add a store round-trip test** for the new field.
5. *(Only if user-facing)* expose it in the runtime/UI (see step 5 below).

`LATEST_VERSION` is derived from the last entry — **there is no number to bump by
hand**.

---

## How it works

- **`PRAGMA user_version`** is the schema version, stored in the database header.
  It is atomic and transactional.
- **`MIGRATIONS`** is an ordered, immutable list. Migration **1 is the frozen
  baseline** (the schema as of the first release). Never edit it.
- **`runMigrations(db)`** runs once, in `SqliteSessionStore`'s constructor, after
  the connection pragmas (`journal_mode = WAL`, then `busy_timeout` — a second
  window must wait for the lock, not fail on it).
- **One transaction, and the version is read INSIDE it.** All pending migrations
  run in a single `BEGIN IMMEDIATE … COMMIT`, and `user_version` is set after
  each. If any migration throws, the **whole upgrade rolls back** (version
  included). Two VS Code windows are two hosts activating at the same time on one
  database, so the version is re-read under the lock: the loser applies nothing
  and logs `already applied by another window`, instead of re-running a
  `CREATE TABLE` that now exists — a race that used to kill activation.
- **Pre-versioning installs.** A database with `user_version = 0` whose schema
  already exists (an install from before this system) is **stamped** to the
  baseline instead of re-running it.
- **Newer databases are refused.** If `user_version > LATEST_VERSION` the DB was
  written by a newer Harny: `runMigrations` throws, and activation shows a clear
  error instead of silently downgrading.
- **Diagnostics.** Each applied migration logs one line to **Output > Harny**
  (`[db] migration v2: sessions.reasoning_budget`).

---

## Step-by-step: a per-session field

Example: a per-session `reasoningBudget`.

### 1. The migration

```ts
// src/core/sessions/migrations.ts — APPEND to MIGRATIONS (never edit v1)
{
  version: 2,                                   // = LATEST_VERSION + 1
  name: "sessions.reasoning_budget",
  up: (db) => db.exec(`ALTER TABLE sessions ADD COLUMN reasoning_budget INTEGER`),
},
```

- `version` must be strictly increasing.
- `up` receives the raw `DatabaseSync`: use `db.exec` for DDL and prepared
  statements for data.
- Leave the column **nullable** unless you have a constant default (see
  [SQLite ALTER TABLE limits](#sqlite-alter-table-limits)).

### 2. The four store touch points

`SqliteSessionStore` has exactly four places that know the `sessions` columns:

```ts
// a) normalizePatch — accept the key and define its clear semantics
if ("reasoningBudget" in patch) out.reasoningBudget = patch.reasoningBudget;

// b) carrySummary — keep the value across an unrelated save
...(existing?.reasoningBudget !== undefined ? { reasoningBudget: existing.reasoningBudget } : {}),

// c) upsertSummary — add the column to the INSERT list, the ON CONFLICT SET and
//    the .run(...) arguments (the SQL lists every column explicitly)

// d) rowToSummary — read it back
...(num(r.reasoning_budget) !== undefined ? { reasoningBudget: num(r.reasoning_budget) } : {}),
```

Add the field to `SessionSummary` / `SessionSettings` / `SessionSettingsPatch` in
`src/core/sessions/types.ts`.

> If you forget **(c)**, the store throws `no such column` on the first save —
> loud, never silent.

### 3. The schema snapshot

Update the expected column list in `migrations.test.ts` (`schema contract`). That
test is the schema's contract: it fails if a migration exists without the
snapshot entry, or the snapshot has a column no migration creates.

### 4. A store test

Add a round-trip assertion in `sqlite-session-store.test.ts`
(`saveSettings` → `load().summary`) so the field is proven to persist.

### 5. Runtime / UI (only if the field is user-facing)

These do **not** touch the database directly:

- `SessionRuntime` in `chat/session-registry.ts` (restore it in `openOrCreate`);
- the `setX` message handler + `commitSetting` in `chat/chat-view.ts`;
- the control in `chat/view-html.ts` / `chat/webview/view.ts`.

---

## Special cases

### New table

```ts
{ version: 3, name: "session_layout", up: (db) => db.exec(`CREATE TABLE session_layout (…)`) }
```

Add its columns to the snapshot test.

### New index

```ts
{ version: 4, name: "index sessions(folder)",
  up: (db) => db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_folder ON sessions(folder)`) }
```

### Backfill

```ts
{ version: 5, name: "backfill reasoning_budget",
  up: (db) => db.exec(`UPDATE sessions SET reasoning_budget = 0 WHERE reasoning_budget IS NULL`) }
```

### Renaming / dropping a column — SQLite limits

`ALTER TABLE` supports only: `RENAME TO`, `RENAME COLUMN`, `ADD COLUMN`, and
`DROP COLUMN` (SQLite ≥ 3.35). It **cannot** add a `PRIMARY KEY` / `UNIQUE`, nor a
`NOT NULL` column without a constant default, nor a column with a non-constant
default. For anything more complex, do a table rebuild inside the migration's
transaction:

1. `CREATE TABLE sessions_new (…)` with the target schema;
2. `INSERT INTO sessions_new (…) SELECT … FROM sessions`;
3. `DROP TABLE sessions`;
4. `ALTER TABLE sessions_new RENAME TO sessions`;
5. recreate indexes / triggers;
6. `INSERT INTO messages_fts(messages_fts) VALUES('rebuild')` if `messages` changed.

> Never run `VACUUM` or `PRAGMA journal_mode` inside a migration: they cannot run
> inside a transaction.

### Destructive migration (possible data loss)

Flag it, and assume there is NO copy of the database to fall back on:

```ts
{ version: 6, name: "drop legacy column", destructive: true,
  up: (db) => db.exec(`ALTER TABLE sessions DROP COLUMN legacy`) }
```

The flag buys you one thing — a reviewer's attention — because the upgrade runs
inside ONE transaction: a migration that THROWS is rolled back to the previous
version byte for byte. What a transaction cannot undo is a migration that
SUCCEEDS with the wrong intent, so a rewrite has to be inspectable and
conservative: touch only the rows that need it, keep everything else untouched,
and never invent data. Migration 4 is the worked example (it reorders a script
that is out of order and leaves a healthy one alone).

`runMigrations` also accepts a `backup` hook, called with the version being
upgraded FROM right before a destructive one runs. **Harny passes nothing**, on
purpose: an install must not accumulate snapshots of itself in `globalStorage`,
and the in-transaction rollback already covers a failure. The hook is for a
support script or a test that wants a copy while the database is still clean.

### A migration that rewrites `messages`

`messages_fts` is an external-content FTS5 table with INSERT/DELETE triggers but
**no UPDATE trigger**. A migration that changes `messages.content` in place must
rebuild the index:

```sql
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
```

---

## Golden rules

- **Never edit a shipped migration** — add a new one. Editing v1 breaks every
  database that already stamped it.
- **One migration = one intent**; name it after the change.
- Prefer `IF NOT EXISTS` in DDL (the version guard already prevents re-runs).
- **Never** run `VACUUM` / `journal_mode` inside a migration.
- **Always** update the snapshot test — it is the schema contract.
- Keep the baseline (v1) and the snapshot in sync: they describe the same schema.

---

## Testing

`src/core/sessions/migrations.test.ts` already covers: fresh DB, idempotency,
pre-versioning stamp, newer-DB refusal, ordering, rollback, destructive-backup,
and the **schema contract**. When you add a migration, add an incremental test:
start from the previous version, apply, assert the new state.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `no such column: X` at runtime | a store field was added without a migration (or without touch point **c**) |
| `session database is vN, newer than this Harny build` | the DB was written by a newer Harny — update Harny or point `HARNY_HOME` elsewhere |
| the version did not change after a failure | correct: the transaction rolled back — fix `up` and retry |
| want to see what ran | **Output > Harny** (`[db] migration v2: …`) |
