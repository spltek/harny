import type { ChatHistory } from "./chat-history";
import { InMemoryChatHistory } from "./in-memory-chat-history";
import type { ChatMessage } from "./types";
import type { SessionStore, SessionSummary } from "../sessions/types";

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
 */
export class PersistentChatHistory implements ChatHistory {
  private inner = new InMemoryChatHistory();

  constructor(
    private store: SessionStore,
    private sessionId: string,
    private onSaved?: (summary: SessionSummary) => void,
  ) {}

  all(): ChatMessage[] {
    return this.inner.all();
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

  conversation(): ChatMessage[] {
    return this.inner.conversation();
  }

  /**
   * The single write path. The result is captured FIRST and the optional hook
   * called after: `this.onSaved?.(this.store.saveMessages(...))` skips the call
   * itself when there is no hook — the optional call short-circuits its arguments.
   */
  private persist(): void {
    const summary = this.store.saveMessages(this.sessionId, this.inner.all());
    this.onSaved?.(summary);
  }
}
