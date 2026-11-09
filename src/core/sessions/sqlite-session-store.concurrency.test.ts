import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { SqliteSessionStore } from "./sqlite-session-store";
import { SessionConflictError } from "./session-conflict";
import type { FileSystem } from "../tools/file-system";
import type { ChatMessage } from "../history/types";

/**
 * Two WINDOWS, one database.
 *
 * In production the two sides are two extension HOSTS — separate processes sharing
 * `<home>/sessions.db` — so these tests use the real thing: two connections on a real file in a
 * temp folder, and (for the lock) a real second process. An in-memory database would share one
 * connection and prove nothing about either mechanism.
 */
const fs = {
  readText: () => "",
  readBytes: () => Buffer.alloc(0),
  writeText: () => {},
  exists: () => true,
  list: () => [],
  size: () => 0,
  mkdirRecursive: () => {},
} as unknown as FileSystem;

const msg = (role: ChatMessage["role"], content: string, timestamp = 1): ChatMessage => ({ role, content, timestamp });

const cleanups: (() => void)[] = [];
afterEach(() => {
  // LIFO, and the order is the point: the folder must be removed AFTER the connections are
  // closed and after the lock-holder child is killed. Windows cannot delete a file that is still
  // open (`EPERM`), so the naive insertion order — remove, then close — failed four tests here
  // that had already passed on `windows-latest`.
  for (const fn of cleanups.splice(0).reverse()) fn();
});

/** One temp DIR per test: the database file must be shared between the two connections. */
function makeSharedFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "harny-concurrency-"));
  // `maxRetries` retries EPERM/EBUSY with a growing backoff: a child process killed a moment ago
  // may still be releasing its handle on the file.
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return join(dir, "sessions.db");
}

/** A store opened the way one extension host opens it. */
function openHost(file: string, busyTimeoutMs?: number): { store: SqliteSessionStore; db: DatabaseSync } {
  const db = new DatabaseSync(file);
  const store = new SqliteSessionStore({
    db,
    fs,
    ...(busyTimeoutMs !== undefined ? { busyTimeoutMs } : {}),
    idGen: (() => {
      let n = 0;
      return () => `s${++n}`;
    })(),
  });
  cleanups.push(() => {
    try {
      db.close();
    } catch {
      /* closed by the test */
    }
  });
  return { store, db };
}

describe("SqliteSessionStore — the transcript token (revision)", () => {
  it("is issued by load/list and moves by ONE on every message write", () => {
    const { store } = openHost(":memory:");
    const s = store.create("S");
    // A fresh row starts at 0: nobody has written a transcript yet.
    expect(s.revision).toBe(0);

    const after1 = store.saveMessages(s.id, [msg("user", "u")]);
    expect(after1.revision).toBe(1);
    expect(store.load(s.id).summary.revision).toBe(1);

    const after2 = store.saveMessages(s.id, [msg("user", "u"), msg("assistant", "a", 2)]);
    expect(after2.revision).toBe(2);
    // Both readers agree: the token lives on the ROW, not in the caller.
    expect(store.summary(s.id)?.revision).toBe(2);
    expect(store.load(s.id).summary.revision).toBe(2);
  });

  it("is NOT moved by a rename or a settings write (a false conflict would refuse a harmless save)", () => {
    const { store } = openHost(":memory:");
    const s = store.create("S");
    store.saveMessages(s.id, [msg("user", "u")]);

    store.rename(s.id, "renamed");
    store.saveSettings(s.id, { model: "gpt-x" });

    // A metadata write changes no message, so the token a host holds is still valid.
    expect(store.load(s.id).summary.revision).toBe(1);
    expect(() => store.saveMessages(s.id, [msg("user", "u")], { revision: 1 })).not.toThrow();
  });

  it("REFUSES a stale save instead of deleting the other window's turns", () => {
    const file = makeSharedFile();
    const a = openHost(file);
    const b = openHost(file);
    const s = a.store.create("S");
    a.store.saveMessages(s.id, [msg("user", "u1")]);
    // Both windows open the SAME session: same transcript, same token.
    expect(b.store.load(s.id).summary.revision).toBe(1);

    // Window B answers first.
    b.store.saveMessages(s.id, [msg("user", "u1"), msg("assistant", "b1", 2)], { revision: 1 });

    // Window A never saw `b1`. Without the token the prefix guard reaches `replace` and DELETEs it.
    const stale = () => a.store.saveMessages(s.id, [msg("user", "u1"), msg("assistant", "a1", 3)], { revision: 1 });
    expect(stale).toThrow(SessionConflictError);
    let error: unknown;
    try {
      stale();
    } catch (e) {
      error = e;
    }
    expect((error as SessionConflictError).storedRevision).toBe(2);

    // The refusal is the whole point: B's turn is still there, A's was never written.
    const stored = a.store.load(s.id);
    expect(stored.messages.map((m) => m.content)).toEqual(["u1", "b1"]);
    expect(stored.summary.revision).toBe(2);

    // ...and A can still write once it has caught up (that is what reopening the session does).
    a.store.saveMessages(s.id, [...stored.messages, msg("assistant", "a1", 3)], { revision: 2 });
    expect(a.store.load(s.id).messages.map((m) => m.content)).toEqual(["u1", "b1", "a1"]);
  });

  it("keeps last-writer-wins for a caller that sends NO token (the compatibility path)", () => {
    const file = makeSharedFile();
    const a = openHost(file);
    const b = openHost(file);
    const s = a.store.create("S");
    a.store.saveMessages(s.id, [msg("user", "u1")]);
    b.store.saveMessages(s.id, [msg("user", "u1"), msg("assistant", "b1", 2)]);

    // A caller with no token gets the OLD behaviour: the transcript is replaced. Pinned, not
    // endorsed — it is why `PersistentChatHistory` always sends one.
    a.store.saveMessages(s.id, [msg("user", "u1"), msg("assistant", "a1", 3)]);
    expect(a.store.load(s.id).messages.map((m) => m.content)).toEqual(["u1", "a1"]);
  });
});

describe("SqliteSessionStore — metadata writes on one row lose nothing", () => {
  /** Two windows open the same session: each has its own summary in memory. */
  function twoWindows() {
    const file = makeSharedFile();
    const a = openHost(file);
    const b = openHost(file);
    const s = a.store.create("S");
    return { file, a: a.store, b: b.store, id: s.id };
  }

  /** A store opened the way one extension host opens it, where the FIRST `sessions` write waits
   * for `hook` (which plays the other window's write) before touching the row. That is the exact
   * window a read-modify-write loses: the delay sits between this host's SNAPSHOT and its WRITE. */
  function openHostWithPause(file: string, hook: () => void): SqliteSessionStore {
    const db = new DatabaseSync(file);
    const STATEMENT_WRITE = /^\s*(UPDATE|INSERT INTO|INSERT OR REPLACE INTO)\s+sessions/i;
    let fired = false;
    const wrapped = new Proxy(db, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== "function") return value;
        if (prop !== "prepare") return (value as (...a: unknown[]) => unknown).bind(target);
        return (sql: string) => {
          const stmt = (value as (s: string) => object).call(target, sql);
          if (!STATEMENT_WRITE.test(sql)) return stmt;
          return new Proxy(stmt, {
            get(sTarget, sProp) {
              const sValue = Reflect.get(sTarget, sProp, sTarget) as unknown;
              if (typeof sValue !== "function") return sValue;
              if (sProp !== "run") return (sValue as (...a: unknown[]) => unknown).bind(sTarget);
              return (...args: unknown[]) => {
                if (!fired) {
                  fired = true;
                  hook();
                }
                return (sValue as (...a: unknown[]) => unknown).apply(sTarget, args);
              };
            },
          });
        };
      },
    });
    const store = new SqliteSessionStore({
      db: wrapped as unknown as DatabaseSync,
      fs,
      idGen: (() => {
        let n = 0;
        return () => `p${++n}`;
      })(),
    });
    cleanups.push(() => {
      try {
        db.close();
      } catch {
        /* closed by the test */
      }
    });
    return store;
  }

  it("interleaved settings patches keep BOTH keys (no lost update)", () => {
    const { a, b, id } = twoWindows();

    // The panel flushes a metric while the manager sets the model — both from their own snapshot
    // of the row. A read-modify-write would put the other one's OLD value back.
    b.saveSettings(id, { model: "gpt-x" });
    a.saveSettings(id, { contextTokens: 1234 });

    const settings = a.load(id).summary;
    expect(settings.model).toBe("gpt-x");
    expect(settings.contextTokens).toBe(1234);
    // …and the value RETURNED is the row, not the patch: B must not be told `model` is unset.
    expect(b.summary(id)?.model).toBe("gpt-x");
    expect(b.summary(id)?.contextTokens).toBe(1234);
  });

  it("a write that lands AFTER the other window updated the row keeps both values", () => {
    const { file, a, id } = twoWindows();
    let otherWindow = "";
    // Host B's first metadata write is paused right before it touches the row. In that window
    // host A commits a model change. A read-modify-write would now write B's whole stale row
    // back and silently undo it — the message-count/metrics flush doing it is what broke this.
    const b = openHostWithPause(file, () => {
      a.saveSettings(id, { model: "gpt-x" });
      otherWindow = "model set during B's pause";
    });

    b.saveSettings(id, { contextTokens: 1234 });

    expect(otherWindow).toBe("model set during B's pause"); // the interleaving really happened
    const row = a.summary(id);
    expect(row?.model).toBe("gpt-x"); // A's change survived B's write
    expect(row?.contextTokens).toBe(1234); // and B's change landed
  });

  it("a rename that lands after the other window's settings write keeps both", () => {
    const { file, a, b, id } = twoWindows();
    let interleaved = false;
    const paused = openHostWithPause(file, () => {
      a.saveSettings(id, { model: "gpt-x" });
      interleaved = true;
    });

    paused.rename(id, "Renamed while the model changed");

    expect(interleaved).toBe(true);
    const row = b.summary(id);
    expect(row?.name).toBe("Renamed while the model changed");
    expect(row?.model).toBe("gpt-x");
  });

  it("a rename and a settings write in the other window do not overwrite each other", () => {
    const { a, b, id } = twoWindows();
    a.saveSettings(id, { model: "gpt-x" });

    b.rename(id, "Renamed in B");

    // The rename must not carry a stale settings snapshot back over the row…
    expect(a.summary(id)?.model).toBe("gpt-x");
    // …and a later settings write must not put the old name back.
    a.saveSettings(id, { temperature: 0.3 });
    const after = a.summary(id);
    expect(after?.name).toBe("Renamed in B");
    expect(after?.temperature).toBe(0.3);
    expect(after?.model).toBe("gpt-x");
  });

  it("a settings write never moves the transcript token (revision)", () => {
    const { a, b, id } = twoWindows();
    a.saveMessages(id, [msg("user", "u1")]);
    const revision = a.load(id).summary.revision;

    b.saveSettings(id, { model: "gpt-x" });
    b.rename(id, "Renamed");

    // A metadata write that bumped the token would make the OTHER window's next save a false
    // conflict — i.e. a message the user typed lost for no reason.
    expect(a.load(id).summary.revision).toBe(revision);
    expect(() => a.saveMessages(id, [msg("user", "u1"), msg("assistant", "a1", 2)], { revision })).not.toThrow();
  });
});

describe("SqliteSessionStore — one writer at a time, across processes", () => {
  /** A second HOST: another process holding the write lock for a moment. */
  const HOLDER = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    db.exec("BEGIN IMMEDIATE");
    db.prepare("SELECT 1").get();
    process.stdout.write("locked\\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    db.exec("COMMIT");
    db.close();
  `;

  function holdLock(file: string): Promise<{ child: ChildProcessWithoutNullStreams; release: () => void }> {
    const child = spawn(process.execPath, ["-e", HOLDER, file], { stdio: "pipe" });
    cleanups.push(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    });
    return new Promise((resolve, reject) => {
      let seen = "";
      child.stdout.on("data", (d: Buffer) => {
        seen += d.toString();
        if (seen.includes("locked")) resolve({ child, release: () => {} });
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (!seen.includes("locked")) reject(new Error(`lock holder exited early (${code})`));
      });
    });
  }

  it("WAITS for the other host's lock instead of losing the write", async () => {
    const file = makeSharedFile();
    const host = openHost(file);
    const s = host.store.create("S");
    host.store.saveMessages(s.id, [msg("user", "u1")]);

    // Node's default for `busy_timeout` is 0: without the pragma this very save throws
    // `database is locked` the instant the other process holds the lock, and the turn is lost.
    expect((host.db.prepare("PRAGMA busy_timeout").get() as { timeout?: number }).timeout).toBe(5000);

    const { child } = await holdLock(file);
    const startedAt = performance.now();
    const summary = host.store.saveMessages(s.id, [msg("user", "u1"), msg("assistant", "a1", 2)], { revision: 1 });
    const waited = performance.now() - startedAt;
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    expect(summary.revision).toBe(2);
    // It really waited for the holder (400 ms), it did not get lucky on timing.
    expect(waited).toBeGreaterThan(200);
    expect(host.store.load(s.id).messages.map((m) => m.content)).toEqual(["u1", "a1"]);
  }, 15_000);

  it("with NO timeout the write fails FAST and writes NOTHING (the lock is taken before any row)", async () => {
    const file = makeSharedFile();
    const a = openHost(file);
    const b = openHost(file, 0); // `busy_timeout = 0`, i.e. Node's default
    const s = a.store.create("S");
    a.store.saveMessages(s.id, [msg("user", "u1")]);

    const { child } = await holdLock(file);
    const startedAt = performance.now();
    // IMMEDIATE means the lock is requested BEFORE the `DELETE`/`INSERT`: the failure is a clean
    // "nothing happened", never a half-written transcript to repair later.
    expect(() => b.store.saveMessages(s.id, [msg("user", "u1"), msg("assistant", "b1", 2)], { revision: 1 })).toThrow(
      /busy|locked/i,
    );
    expect(performance.now() - startedAt).toBeLessThan(300);
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    const stored = a.store.load(s.id);
    expect(stored.messages.map((m) => m.content)).toEqual(["u1"]);
    expect(stored.summary.revision).toBe(1);
    expect(() => b.store.load(s.id)).not.toThrow();
  }, 15_000);
});
