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
  for (const fn of cleanups.splice(0)) fn();
});

/** One temp DIR per test: the database file must be shared between the two connections. */
function makeSharedFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "harny-concurrency-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
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
