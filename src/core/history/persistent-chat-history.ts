import type { ChatHistory } from "./chat-history";
import { InMemoryChatHistory } from "./in-memory-chat-history";
import type { ChatMessage } from "./types";
import type { SessionStore } from "../sessions/types";

/**
 * Chat history bound to ONE fixed session id. Each open chat panel owns its own
 * instance, so every agent writes only to its own session (no shared "current").
 * `add` autosaves; `replace` swaps in-memory state without saving (used when
 * loading an existing session so it is not rewritten immediately).
 */
export class PersistentChatHistory implements ChatHistory {
  private inner = new InMemoryChatHistory();

  constructor(private store: SessionStore, private sessionId: string) {}

  all(): ChatMessage[] {
    return this.inner.all();
  }

  add(message: ChatMessage): void {
    this.inner.add(message);
    this.store.saveMessages(this.sessionId, this.inner.all());
  }

  replace(messages: ChatMessage[]): void {
    this.inner.replace(messages);
  }

  conversation(): ChatMessage[] {
    return this.inner.conversation();
  }
}
