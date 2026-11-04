import type { ChatHistory } from "./chat-history";
import { InMemoryChatHistory } from "./in-memory-chat-history";
import type { ChatMessage } from "./types";
import type { SessionStore, SessionSummary } from "../sessions/types";
import { SessionConflictError } from "../sessions/session-conflict";

/**
 * Chat history bound to ONE fixed session id. Each open chat panel owns its own
 * instance, so every agent writes only to its own session (no shared "current").
 * `add` autosaves; `replace` swaps in-memory state without saving (used when
 * loading an existing session so it is not rewritten immediately).
 *
 * `onSaved` is the ONE hook a write has: every save bumps the session's
 * `updatedAt` in the store, and the session list on screen has to follow it
 * (see ChatViewProvider.noteSessionActivity). It is called with the summary the
 * store just returned, so nobody has to re-read the row.
 *
 * ## Two windows, one session
 *
 * The store hands back a `revision` with every read and every write; this history remembers it
 * (`adopt` on load, the summary after each save) and sends it back on the next save. If another
 * VS Code window wrote to this session in between, the store REFUSES the write
 * (`SessionConflictError`) rather than replacing rows this window never saw — which is what the
 * prefix guard alone would do, and it would delete the other window's turns.
 *
 * A refused write is not retried. Retrying with the new token would `replace` and destroy exactly
 * what the refusal protected, so the history BLOCKS instead: it keeps the messages in memory (the
 * screen stays intact, nothing is silently dropped), reports once through `onConflict`, and every
 * later save is a no-op until the session is reopened — `adopt` clears the block, which is what a
 * load does. The panel tells the user the transcript on disk is the other window's, so the state is
 * visible and recoverable, never silent.
 */
export class PersistentChatHistory implements ChatHistory {
  private inner = new InMemoryChatHistory();
  /** The token of the last read/write; `undefined` = the store does not issue one (a mock). */
  private revision?: number;
  /** Set when a save was REFUSED: no further write may touch this session from here. */
  private blocked = false;

  constructor(
    private store: SessionStore,
    private sessionId: string,
    private onSaved?: (summary: SessionSummary) => void,
    private onConflict?: (error: SessionConflictError) => void,
  ) {}

  all(): ChatMessage[] {
    return this.inner.all();
  }

  /**
   * Take the token of a session that was just LOADED (or of any summary the store returned).
   * Also releases a conflict block: a load is a fresh start from the stored transcript, which is
   * the only thing that can make this window's copy agree with the database again.
   */
  adopt(summary: SessionSummary): void {
    this.revision = summary.revision;
    this.blocked = false;
  }

  /** True after a refused save, until the session is reopened (see the class note). */
  get conflicted(): boolean {
    return this.blocked;
  }

  add(message: ChatMessage): void {
    this.inner.add(message);
    this.persist();
  }

  /**
   * One store write for the whole group: `saveMessages` inserts the new suffix
   * inside a single BEGIN/COMMIT, so a crash or a failure can never leave the
   * group half-written (and no other writer can slip in between its messages).
   */
  addGroup(messages: ChatMessage[]): void {
    if (messages.length === 0) return;
    this.inner.addGroup(messages);
    this.persist();
  }

  replace(messages: ChatMessage[]): void {
    this.inner.replace(messages);
  }

  /**
   * Rewrite the transcript from scratch — a ✂ cut, a rewind, a compaction or a window trim
   * REBUILT it, so the stored rows are not a prefix of what we hold and an append would leave the
   * tail of the old version behind.
   *
   * It exists instead of `replace(...)` + `store.saveMessages(id, msgs, { replace: true })` at the
   * call site because the token lives HERE: a rebuild that forgot it would be the one unguarded
   * `DELETE FROM messages` left, and it would delete another window's turns. Same conflict handling
   * as any other save (block + report), so a caller does not have to wrap it.
   */
  rebuild(messages: ChatMessage[]): void {
    this.inner.replace(messages);
    // Even when blocked: the in-memory history must match what the user just did on screen. Only
    // the WRITE is refused.
    this.persist({ replace: true });
  }

  conversation(): ChatMessage[] {
    return this.inner.conversation();
  }

  /**
   * The single write path. The result is captured FIRST and the optional hook
   * called after: `this.onSaved?.(this.store.saveMessages(...))` skips the call
   * itself when there is no hook — the optional call short-circuits its arguments.
   */
  private persist(options: { replace?: boolean } = {}): void {
    if (this.blocked) return;
    try {
      const summary = this.store.saveMessages(this.sessionId, this.inner.all(), {
        revision: this.revision,
        ...(options.replace ? { replace: true } : {}),
      });
      // Adopt what the store computed, not `revision + 1`: only the transaction knows.
      this.revision = summary.revision;
      this.onSaved?.(summary);
    } catch (e) {
      // ONLY a conflict is swallowed here. A `SQLITE_BUSY` (another process holding the lock) is a
      // "try again later" and must keep travelling: it is not a lost session, and hiding it would
      // hide a disk problem behind a concurrency story.
      if (!(e instanceof SessionConflictError)) throw e;
      this.blocked = true;
      this.onConflict?.(e);
    }
  }
}
