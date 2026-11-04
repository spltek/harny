/**
 * A save that arrived with a STALE token — the stored transcript moved under it.
 *
 * Two VS Code windows are two extension hosts sharing ONE `sessions.db`, so the same session can
 * be open in both: each host holds the history it loaded, and both keep appending. The store's
 * prefix guard can only compare the rows it has with the array it is given, and a host that never
 * saw the other's append reaches the "not a prefix" branch — `replace`, `DELETE FROM messages` —
 * and deletes turns it has never read. That is not a crash and no test can see it as one: the
 * transcript simply becomes the other window's, minus its messages.
 *
 * `revision` makes that detectable. It is bumped inside the SAME transaction that writes messages
 * and read back by the next save; a save whose token no longer matches is REFUSED, before a single
 * row is touched, and this error says what it found. Nothing is lost by refusing: the winner's rows
 * are intact and the loser still has its messages in memory (`PersistentChatHistory` blocks itself
 * instead of retrying — see there).
 *
 * It is a named class, not an `Error` with a flag, because both sides have to agree: the store
 * throws it and the history must NOT confuse it with a `SQLITE_BUSY` from another process (which
 * is a "try again", not a "someone else owns this now").
 */
export class SessionConflictError extends Error {
  constructor(
    readonly sessionId: string,
    /** The revision the STORE holds now — the token this host would need to write. */
    readonly storedRevision: number,
  ) {
    super(
      `session ${sessionId} changed since it was loaded (stored revision ${storedRevision}): ` +
        `the write was refused instead of overwriting it`,
    );
    this.name = "SessionConflictError";
  }
}
