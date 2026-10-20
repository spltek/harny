import type { ChatHistory } from "./chat-history";
import { checkpointStart } from "./conversation-validity";
import type { ChatMessage } from "./types";

export class InMemoryChatHistory implements ChatHistory {
  private messages: ChatMessage[] = [];

  all(): ChatMessage[] {
    return [...this.messages];
  }

  add(message: ChatMessage): void {
    this.messages.push(message);
  }

  addGroup(messages: ChatMessage[]): void {
    this.messages.push(...messages);
  }

  replace(messages: ChatMessage[]): void {
    this.messages = [...messages];
  }

  /**
   * What the MODEL sees: from the newest summary checkpoint onwards, minus the
   * UI-only bubbles.
   *
   * Everything before that checkpoint is the session's readable past — still
   * stored, still shown, still searchable — and deliberately OUT of the window.
   * The boundary is a STORED marker (see checkpointStart), so it does not drift
   * between turns: appending a message only ever grows the tail, which is what
   * keeps the provider's prompt cache valid.
   */
  conversation(): ChatMessage[] {
    return this.messages.slice(checkpointStart(this.messages)).filter((m) => !m.uiOnly);
  }
}
