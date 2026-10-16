import type { ChatHistory } from "./chat-history";
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

  conversation(): ChatMessage[] {
    return this.messages.filter((m) => !m.uiOnly);
  }
}
