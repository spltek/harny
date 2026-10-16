import { describe, it, expect } from "vitest";
import { Agent } from "./agent";
import { DefaultSystemPromptBuilder } from "./system-prompt";
import { InMemoryEventBus } from "../events/in-memory-event-bus";
import { InMemoryChatHistory } from "../history/in-memory-chat-history";
import { StaticConfigProvider } from "../config/static-config-provider";
import { ToolRegistry } from "../tools/tool-registry";
import type { HarnyConfig } from "../config/types";
import type { ChatMessage } from "../history/types";
import type { LLMProviderFactory } from "../llm/types";
import type { Tool } from "../tools/tool";

/**
 * FAULT INJECTION for the wire rules.
 *
 * conversation-validity.test.ts proves the RULES (given this shape, these faults).
 * This suite proves the CONSEQUENCE end to end: a malformed conversation is refused
 * before it reaches the provider, and the user is told WHICH rule broke.
 *
 * It matters because seven of the eight rules are "insurance": they describe shapes
 * a bug could produce (or an older build could have stored), not ones we have seen
 * in the wild. The provider's own answer to all of them is the same opaque 400
 * ("insufficient tool messages following tool_calls") — on that request AND on every
 * one after it, because the same history is re-sent each time. So the test is not
 * "does it fail?" but "does it fail LOUDLY and PRECISELY?".
 */

const CONFIG: HarnyConfig = {
  provider: "openai",
  apiKey: "sk-test",
  baseUrl: "https://api.openai.com",
  model: "gpt-4o",
  maxTokens: 100,
  temperature: 0,
  autoOpen: false,
};

const stubTool: Tool = {
  name: "Shell",
  definition: { name: "Shell", description: "run a command", parameters: { type: "object", properties: {} } },
  execute: () => ({ content: "ok", isError: false }),
};

/** A provider that records whether a request was even attempted. */
function spyFactory(): { factory: LLMProviderFactory; requests: number } {
  const box = { requests: 0 };
  const factory = {
    create: () => ({
      protocol: "chat" as const,
      async *stream() {
        box.requests += 1;
        yield { type: "text", content: "this must never run" };
      },
    }),
  } as unknown as LLMProviderFactory;
  return {
    factory,
    get requests() {
      return box.requests;
    },
  };
}

function buildAgents(factory: LLMProviderFactory): { agent: Agent; history: InMemoryChatHistory } {
  const history = new InMemoryChatHistory();
  const tools = new ToolRegistry([stubTool]);
  const agent = new Agent({
    config: new StaticConfigProvider(CONFIG),
    llmFactory: factory,
    tools,
    history,
    events: new InMemoryEventBus(),
    systemPrompt: new DefaultSystemPromptBuilder(() => tools.definitions(), () => "/workspace"),
  });
  return { agent, history };
}

const assistantCall = (id: string): ChatMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id, name: "Shell", arguments: {} }],
  timestamp: 2,
});

/**
 * One case per rule. `expect` is the phrase the guard must use: naming the rule is
 * the whole point (the provider's message names nothing).
 */
const MALFORMED: Array<{ rule: string; phrase: RegExp; history: ChatMessage[] }> = [
  {
    rule: "a tool_calls turn with no results after it (the Stop bug)",
    phrase: /not followed by their tool results/,
    history: [
      { role: "user", content: "go", timestamp: 1 },
      assistantCall("c1"),
      { role: "user", content: "you there?", timestamp: 3 },
    ],
  },
  {
    rule: "a tool result that answers nothing",
    phrase: /does not answer the assistant turn above it/,
    history: [
      { role: "user", content: "go", timestamp: 1 },
      { role: "assistant", content: "thinking", timestamp: 2 },
      { role: "tool", content: "output", toolCallId: "ghost", timestamp: 3 },
    ],
  },
  {
    rule: "a tool result with no id (the wire drops it)",
    phrase: /tool result without a tool_call_id/,
    history: [
      { role: "user", content: "go", timestamp: 1 },
      assistantCall("c1"),
      { role: "tool", content: "output", timestamp: 3 },
    ],
  },
  {
    rule: "the same tool-call id used twice",
    phrase: /is used twice/,
    history: [
      { role: "user", content: "go", timestamp: 1 },
      assistantCall("c1"),
      { role: "tool", content: "one", toolCallId: "c1", timestamp: 3 },
      { role: "tool", content: "two", toolCallId: "c1", timestamp: 4 },
    ],
  },
  {
    rule: "a blank tool result (strict servers reject it)",
    phrase: /has no content/,
    history: [
      { role: "user", content: "go", timestamp: 1 },
      assistantCall("c1"),
      { role: "tool", content: "", toolCallId: "c1", timestamp: 3 },
    ],
  },
  {
    rule: "an assistant message with neither text nor tool calls",
    phrase: /no text and no tool calls/,
    history: [
      { role: "user", content: "go", timestamp: 1 },
      { role: "assistant", content: "   ", timestamp: 2 },
    ],
  },
  {
    rule: "a conversation that does not open with the user",
    phrase: /starts with a assistant message, not the user/,
    history: [
      { role: "assistant", content: "hello, I am the model", timestamp: 1 },
      { role: "user", content: "go", timestamp: 2 },
    ],
  },
  {
    rule: "attachments on a non-user message",
    phrase: /message carries attachments/,
    history: [
      { role: "user", content: "look", timestamp: 1 },
      { role: "assistant", content: "seen", images: ["data:image/png;base64,AAAA"], timestamp: 2 },
    ],
  },
];

describe("fault injection — every wire rule is caught before the provider sees it", () => {
  for (const c of MALFORMED) {
    it("refuses to send " + c.rule + ", and names the rule", async () => {
      const spy = spyFactory();
      const { agent, history } = buildAgents(spy.factory);
      history.replace(c.history); // the malformed state, injected directly

      await agent.send("again");

      // 1. Nothing reached the provider: that request would have been rejected, and
      //    so would every request after it (the same history is re-sent each turn).
      expect(spy.requests).toBe(0);
      // 2. The user is told WHAT is wrong, in the guard's own words…
      const shown = history.all().map((m) => m.content ?? "").join(" | ");
      expect(shown).toContain("not replayable");
      expect(shown).toMatch(c.phrase);
      // 3. …and it is called an INTERNAL error, so nobody looks at the provider.
      expect(shown).toMatch(/bug in Harny/);
    });
  }

  it("does NOT refuse a healthy conversation (a false positive would break every session)", async () => {
    const spy = spyFactory();
    const { agent, history } = buildAgents(spy.factory);
    history.replace([
      { role: "user", content: "go", timestamp: 1 },
      assistantCall("c1"),
      { role: "tool", content: "output", toolCallId: "c1", timestamp: 3 },
      { role: "assistant", content: "done", timestamp: 4 },
    ]);

    await agent.send("again");

    expect(spy.requests).toBe(1); // the request went out, as it must
  });

  it("allows the SHAPES the rules explicitly permit", async () => {
    // Guards drift into refusing valid sessions; these are the borderline-but-legal
    // ones, each allowed by a rule and easy to break while tightening another.
    const legal: ChatMessage[][] = [
      // A single character is content: only a truly blank result is a fault.
      [
        { role: "user", content: "go", timestamp: 1 },
        assistantCall("c1"),
        { role: "tool", content: ".", toolCallId: "c1", timestamp: 3 },
      ],
      // Several tool calls in one turn, each answered once, in order.
      [
        { role: "user", content: "go", timestamp: 1 },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "c1", name: "Shell", arguments: {} },
            { id: "c2", name: "Shell", arguments: {} },
          ],
          timestamp: 2,
        },
        { role: "tool", content: "one", toolCallId: "c1", timestamp: 3 },
        { role: "tool", content: "two", toolCallId: "c2", timestamp: 4 },
        { role: "assistant", content: "done", timestamp: 5 },
      ],
      // Attachments on a USER message (the only role allowed to carry them).
      [
        { role: "user", content: "look", images: ["data:image/png;base64,AAAA"], timestamp: 1 },
        { role: "assistant", content: "seen", timestamp: 2 },
      ],
    ];
    for (const history0 of legal) {
      const spy = spyFactory();
      const { agent, history } = buildAgents(spy.factory);
      history.replace(history0);

      await agent.send("again");

      expect(spy.requests).toBe(1);
    }
  });
});
