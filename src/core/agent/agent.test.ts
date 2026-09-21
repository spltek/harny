import { describe, it, expect, vi } from "vitest";
import { Agent } from "./agent";
import { ToolCallAccumulator } from "./tool-call-accumulator";
import { DefaultSystemPromptBuilder } from "./system-prompt";
import { InMemoryEventBus } from "../events/in-memory-event-bus";
import { InMemoryChatHistory } from "../history/in-memory-chat-history";
import { StaticConfigProvider } from "../config/static-config-provider";
import { ToolRegistry } from "../tools/tool-registry";
import type { HarnyConfig } from "../config/types";
import type { LLMMessage, LLMProviderFactory, StreamChunk } from "../llm/types";
import type { Tool, ToolResult } from "../tools/tool";
import type { AgentEvent } from "./types";

const VALID_CONFIG: HarnyConfig = {
  provider: "openai",
  apiKey: "sk-test",
  baseUrl: "https://api.openai.com",
  model: "gpt-4o",
  maxTokens: 4096,
  temperature: 0.1,
  contextFiles: true,
  autoApprove: false,
  autoOpen: false,
};

const NO_KEY_CONFIG: HarnyConfig = { ...VALID_CONFIG, apiKey: "" };

function fakeFactory(...callChunks: StreamChunk[][]): LLMProviderFactory & { calls: number } {
  let calls = 0;
  return {
    calls: 0,
    get calls() {
      return calls;
    },
    create() {
      return {
        protocol: "chat" as const,
        async *stream() {
          const chunks = callChunks[Math.min(calls, callChunks.length - 1)];
          calls++;
          for (const c of chunks) yield c;
        },
      };
    },
  };
}

function makeTool(name: string, result: ToolResult = { content: "ok", isError: false }): Tool & { called: boolean } {
  const tool = {
    name,
    definition: { name, description: name, parameters: { type: "object", properties: {} } },
    called: false,
    execute: (): ToolResult => {
      tool.called = true;
      return result;
    },
  };
  return tool;
}

interface Harness {
  agent: Agent;
  factory: ReturnType<typeof fakeFactory>;
  events: AgentEvent[];
  history: InMemoryChatHistory;
}

function buildHarness(opts: { config?: HarnyConfig; chunks?: StreamChunk[][]; tools?: Tool[]; maxTurns?: number } = {}): Harness {
  const config = new StaticConfigProvider(opts.config ?? VALID_CONFIG);
  const history = new InMemoryChatHistory();
  const events = new InMemoryEventBus<AgentEvent>();
  const eventsLog: AgentEvent[] = [];
  events.subscribe((e) => eventsLog.push(e));
  const factory = fakeFactory(...(opts.chunks ?? [[{ type: "text", content: "hi" }]]));
  const tools = new ToolRegistry(opts.tools ?? [makeTool("FakeTool")]);
  const systemPrompt = new DefaultSystemPromptBuilder(() => tools.definitions(), () => "/workspace");

  const agent = new Agent({ config, llmFactory: factory, tools, history, events, systemPrompt, maxTurns: opts.maxTurns });
  return { agent, factory, events: eventsLog, history };
}

describe("Agent", () => {
  it("emits error + done and stores a uiOnly message when no API key", async () => {
    const { agent, events, history } = buildHarness({ config: NO_KEY_CONFIG });

    await agent.send("hello");

    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    const error = events.find((e) => e.type === "error");
    expect(error && error.type === "error" ? error.error : "").toContain("No API key");

    const messages = history.all();
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].uiOnly).toBe(true);
    // uiOnly messages are excluded from the LLM conversation
    expect(history.conversation()).toHaveLength(1);
  });

  it("mid-conversation fetch errors are included in the LLM story (not uiOnly)", async () => {
    const history = new InMemoryChatHistory();
    const events = new InMemoryEventBus<AgentEvent>();
    const eventsLog: AgentEvent[] = [];
    events.subscribe((e) => eventsLog.push(e));
    const failing: LLMProviderFactory = {
      create() {
        return {
          protocol: "chat" as const,
          async *stream() {
            throw new Error("fetch failed: network unreachable");
          },
        };
      },
    };
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: failing,
      tools: new ToolRegistry([makeTool("FakeTool")]),
      history,
      events,
      systemPrompt: new DefaultSystemPromptBuilder(() => [], () => "/workspace"),
    });

    await agent.send("hello");

    const errMsg = history.all().find((m) => m.role === "assistant" && /fetch failed/.test(m.content ?? ""));
    expect(errMsg).toBeDefined();
    // NOT uiOnly → the model sees it in the conversation, the story stays coherent
    expect(errMsg!.uiOnly).toBeFalsy();
    expect(history.conversation().some((m) => /fetch failed/.test(m.content ?? ""))).toBe(true);
    expect(eventsLog.filter((e) => e.type === "error")).toHaveLength(1);
  });

  it("proceeds without an API key for local endpoints", async () => {
    const localConfig: HarnyConfig = { ...NO_KEY_CONFIG, baseUrl: "http://localhost:8090/v1" };
    const { agent, events, factory } = buildHarness({
      config: localConfig,
      chunks: [[{ type: "text", content: "ok" }]],
    });

    await agent.send("hello");

    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(factory.calls).toBe(1);
  });

  it("forwards attached images to the LLM provider", async () => {
    let received: StreamChunk[][] = [];
    const factory: LLMProviderFactory = {
      create() {
        return {
          protocol: "chat" as const,
          async *stream(messages) {
            received.push(messages);
            yield { type: "text", content: "ok" };
          },
        };
      },
    };
    const config = new StaticConfigProvider(VALID_CONFIG);
    const history = new InMemoryChatHistory();
    const events = new InMemoryEventBus<AgentEvent>();
    const tools = new ToolRegistry([]);
    const systemPrompt = new DefaultSystemPromptBuilder(() => [], () => "/workspace");
    const agent = new Agent({ config, llmFactory: factory, tools, history, events, systemPrompt });

    await agent.send("cosa vedi?", { images: ["data:image/png;base64,AAAA"] });

    const userMessage = received[0][1]; // [0] is the system message
    expect(userMessage.images).toEqual(["data:image/png;base64,AAAA"]);
    // and it is persisted in history too
    expect(history.all()[0].images).toEqual(["data:image/png;base64,AAAA"]);
  });

  it("stores attachment metadata + displayText on the user message", async () => {
    const { agent, history } = buildHarness({ chunks: [[{ type: "text", content: "ok" }]] });

    await agent.send('Attached file "a.txt":\n```\nhi\n```\n\nlook', {
      attachments: [{ name: "a.txt", path: "/tmp/a.txt", size: 2 }],
      displayText: "look",
    });

    const user = history.all()[0];
    // The LLM content keeps the inlined file; the metadata drives the bubble.
    expect(user.content).toContain("Attached file");
    expect(user.attachments).toEqual([{ name: "a.txt", path: "/tmp/a.txt", size: 2 }]);
    expect(user.displayText).toBe("look");
  });

  it("streams text and stores the assistant message", async () => {
    const { agent, events, history, factory } = buildHarness({
      chunks: [[{ type: "text", content: "Hel" }, { type: "text", content: "lo" }]],
    });

    await agent.send("hello");

    expect(events.filter((e) => e.type === "text_delta").map((e) => (e.type === "text_delta" ? e.content : ""))).toEqual([
      "Hel",
      "lo",
    ]);
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(factory.calls).toBe(1);

    const assistant = history.all()[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("Hello");
  });

  it("emits thinking_delta when provider returns thinking type", async () => {
    const { agent, events, history } = buildHarness({
      chunks: [[
        { type: "thinking", content: "let me reason about this" },
        { type: "text", content: "Here is the answer" },
      ]],
    });

    await agent.send("complicated question");

    const thinking = events.filter((e) => e.type === "thinking_delta");
    expect(thinking).toHaveLength(1);
    if (thinking[0].type === "thinking_delta") {
      expect(thinking[0].content).toBe("let me reason about this");
    }
    const text = events.filter((e) => e.type === "text_delta");
    expect(text).toHaveLength(1);
    if (text[0].type === "text_delta") {
      expect(text[0].content).toBe("Here is the answer");
    }

    // Reasoning is persisted on the assistant message so the UI can keep
    // showing it after the final refresh re-render.
    const assistant = history.all().find((m) => m.role === "assistant");
    expect(assistant?.thinking).toBe("let me reason about this");
    expect(assistant?.content).toBe("Here is the answer");
  });

  it("persists reasoning_details and passes them back on later turns", async () => {
    const details = [{ type: "reasoning.encrypted", data: "abc", index: 0 }];
    const received: LLMMessage[][] = [];
    let call = 0;
    const factory: LLMProviderFactory = {
      create() {
        return {
          protocol: "chat" as const,
          async *stream(messages) {
            received.push(messages);
            if (call++ === 0) {
              yield { type: "thinking_details", details };
              yield { type: "thinking", content: "thinking..." };
              yield { type: "text", content: "done" };
            } else {
              yield { type: "text", content: "again" };
            }
          },
        };
      },
    };
    const config = new StaticConfigProvider(VALID_CONFIG);
    const history = new InMemoryChatHistory();
    const events = new InMemoryEventBus<AgentEvent>();
    const agent = new Agent({
      config,
      llmFactory: factory,
      tools: new ToolRegistry([]),
      history,
      events,
      systemPrompt: new DefaultSystemPromptBuilder(() => [], () => "/workspace"),
    });

    await agent.send("first");
    await agent.send("second");

    const assistant = history.all().find((m) => m.role === "assistant");
    expect(assistant?.reasoningDetails).toEqual(details);
    // The second request carries the stored reasoning_details back on the
    // assistant message (encrypted reasoning continuity across turns).
    const secondTurnAssistant = received[1].find((m) => m.role === "assistant");
    expect(secondTurnAssistant?.reasoningDetails).toEqual(details);
  });

  it("parses \u003cthink\u003e tags in text into thinking_delta events", async () => {
    const { agent, events, history } = buildHarness({
      chunks: [[
        { type: "text", content: "I need to " },
        { type: "text", content: "\u003cthink\u003elet me check the API docs" },
        { type: "text", content: "\u003c/think\u003e" },
        { type: "text", content: "The answer is 42." },
      ]],
    });

    await agent.send("what is the meaning?");

    const thinkingDeltas = events.filter((e) => e.type === "thinking_delta");
    expect(thinkingDeltas.length).toBeGreaterThan(0);
    // The full thinking content should contain the reasoning
    const fullThinking = thinkingDeltas
      .filter((e) => e.type === "thinking_delta")
      .map((e) => e.content)
      .join("");
    expect(fullThinking).toContain("check the API docs");

    // The assistant message in history should NOT contain the think tags
    const assistant = history.all().find((m) => m.role === "assistant");
    expect(assistant?.content).not.toContain("\u003cthink\u003e");
    expect(assistant?.content).not.toContain("\u003c/think\u003e");
    expect(assistant?.content).toContain("The answer is 42.");
    expect(assistant?.content).toContain("I need to ");
    // ...but the reasoning is kept on the message for the UI
    expect(assistant?.thinking).toContain("check the API docs");
  });

  it("parses \u003creason\u003e tags in text into thinking_delta events", async () => {
    const { agent, events, history } = buildHarness({
      chunks: [[
        { type: "text", content: "\u003creason\u003eAnalyzing the algorithm..." },
        { type: "text", content: "\u003c/reason\u003e" },
        { type: "text", content: "Use quicksort." },
      ]],
    });

    await agent.send("sort this");

    const thinkingDeltas = events.filter((e) => e.type === "thinking_delta");
    expect(thinkingDeltas.length).toBeGreaterThan(0);
    const fullThinking = thinkingDeltas
      .filter((e) => e.type === "thinking_delta")
      .map((e) => e.content)
      .join("");
    expect(fullThinking).toContain("Analyzing the algorithm");

    const assistant = history.all().find((m) => m.role === "assistant");
    expect(assistant?.content).not.toContain("\u003creason\u003e");
    expect(assistant?.content).toContain("Use quicksort");
  });

  it("handles think tags spanning across multiple text chunks", async () => {
    const { agent, events } = buildHarness({
      chunks: [[
        { type: "text", content: "Hello. \u003cthink\u003eStep 1: check" },
        { type: "text", content: "Step 2: analyze" },
        { type: "text", content: "Step 3: conclude\u003c/think\u003eDone." },
      ]],
    });

    await agent.send("multi-chunk thinking");

    const thinkingDeltas = events.filter((e) => e.type === "thinking_delta");
    expect(thinkingDeltas.length).toBeGreaterThan(0);

    const textDeltas = events
      .filter((e) => e.type === "text_delta")
      .map((e) => e.content)
      .join("");
    expect(textDeltas).toContain("Hello.");
    expect(textDeltas).toContain("Done.");
    expect(textDeltas).not.toContain("Step 1:");
  });

  it("passes through normal text without any thinking tags unchanged", async () => {
    const { agent, events, history } = buildHarness({
      chunks: [[{ type: "text", content: "Just normal text without any tags." }]],
    });

    await agent.send("hello");

    expect(events.filter((e) => e.type === "thinking_delta")).toHaveLength(0);
    const assistant = history.all().find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("Just normal text without any tags.");
  });

  it("executes tools and continues the loop", async () => {
    const readTool = makeTool("Read", { content: "file content", isError: false });
    const { agent, events, history, factory } = buildHarness({
      tools: [readTool],
      chunks: [
        [
          { type: "tool_call_start", index: 0, id: "c1", name: "Read" },
          { type: "tool_call_delta", index: 0, delta: '{"path":"/tmp/a.txt"}' },
          { type: "tool_call_end", index: 0 },
        ],
        [{ type: "text", content: "done reading" }],
      ],
    });

    await agent.send("read the file");

    expect(readTool.called).toBe(true);
    expect(factory.calls).toBe(2);

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult && toolResult.type === "tool_result" ? toolResult.toolResult.output : "").toBe("file content");

    // history: user, assistant(tool call), tool, assistant(final)
    const roles = history.all().map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
    // the tool-call turn names the tool instead of the generic placeholder
    expect(history.all()[1].content).toBe("🔧 Tool: Read");
  });

  it("surfaces tool execution errors via tool_result isError", async () => {
    const failingTool = makeTool("Read", { content: "boom", isError: true });
    const { agent, events } = buildHarness({
      tools: [failingTool],
      chunks: [
        [
          { type: "tool_call_start", index: 0, id: "c1", name: "Read" },
          { type: "tool_call_end", index: 0 },
        ],
      ],
    });

    await agent.send("x");

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult && toolResult.type === "tool_result" ? toolResult.toolResult.isError : false).toBe(true);
  });

  it("handles unknown tools gracefully", async () => {
    const { agent, events } = buildHarness({
      chunks: [
        [
          { type: "tool_call_start", index: 0, id: "c1", name: "Nope" },
          { type: "tool_call_end", index: 0 },
        ],
      ],
    });

    await agent.send("x");

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult && toolResult.type === "tool_result" ? toolResult.toolResult.output : "").toContain(
      "Unknown tool",
    );
  });

  it("stops after maxTurns when the model keeps calling tools", async () => {
    const { agent, factory } = buildHarness({
      chunks: [
        [
          { type: "tool_call_start", index: 0, id: "c1", name: "FakeTool" },
          { type: "tool_call_end", index: 0 },
        ],
      ],
      maxTurns: 3,
    });

    await agent.send("x");

    expect(factory.calls).toBe(3);
  });

  it("retries when a turn only produces thinking (no text, no tools) instead of an empty response", async () => {
    const { agent, factory, history, events } = buildHarness({
      chunks: [
        [{ type: "thinking", content: "let me think about this" }],
        [{ type: "text", content: "final answer" }],
      ],
    });

    await agent.send("x");

    // Two LLM calls: the thinking-only turn is retried, not stored as empty.
    expect(factory.calls).toBe(2);
    const roles = history.all().map((m) => m.role);
    expect(roles).toEqual(["user", "assistant"]);
    expect(history.all()[1].content).toBe("final answer");
    expect(history.all().some((m) => m.content === "(empty response)")).toBe(false);
    // thinking deltas were streamed to the UI
    expect(events.some((e) => e.type === "thinking_delta" && e.content === "let me think about this")).toBe(true);
  });

  it("detects repeated identical tool failures and stops early", async () => {
    const failingTool = makeTool("Read", { content: "boom", isError: true });
    const { agent, factory, events, history } = buildHarness({
      tools: [failingTool],
      chunks: [
        [
          { type: "tool_call_start", index: 0, id: "c1", name: "Read" },
          { type: "tool_call_end", index: 0 },
        ],
        [
          { type: "tool_call_start", index: 0, id: "c2", name: "Read" },
          { type: "tool_call_end", index: 0 },
        ],
        [
          { type: "tool_call_start", index: 0, id: "c3", name: "Read" },
          { type: "tool_call_end", index: 0 },
        ],
      ],
      maxTurns: 6,
    });

    await agent.send("x");

    // Stops early (NOT burning all maxTurns), but only AFTER one corrective
    // prompt was injected: local models get a chance to fix malformed args
    // before the loop detector hard-stops on the next identical failure.
    expect(factory.calls).toBe(3);
    const error = events.find((e) => e.type === "error");
    expect(error && error.type === "error" ? error.error : "").toContain("Tool loop detected");
    const roles = history.all().map((m) => m.role);
    // user, assistant(c0), tool, assistant(c1), tool, user(corrective),
    // assistant(c2), tool, assistant(loop stop msg)
    expect(roles).toContain("user");
    expect(roles.length).toBe(9);
    expect(history.all().some((m) => m.role === "user" && /[Rr]e-emit the tool call/.test(m.content))).toBe(true);
  });

  it("stops after 3 consecutive all-error turns even when the tool names differ", async () => {
    const failA = makeTool("Read", { content: "err A", isError: true });
    const failB = makeTool("Write", { content: "err B", isError: true });
    const failC = makeTool("Shell", { content: "err C", isError: true });
    const { agent, factory, events } = buildHarness({
      tools: [failA, failB, failC],
      chunks: [
        [{ type: "tool_call_start", index: 0, id: "c1", name: "Read" }, { type: "tool_call_end", index: 0 }],
        [{ type: "tool_call_start", index: 0, id: "c2", name: "Write" }, { type: "tool_call_end", index: 0 }],
        [{ type: "tool_call_start", index: 0, id: "c3", name: "Shell" }, { type: "tool_call_end", index: 0 }],
      ],
      maxTurns: 6,
    });

    await agent.send("x");

    // Three different failing tools in a row = loop, not a fixable single error.
    expect(factory.calls).toBe(3);
    const error = events.find((e) => e.type === "error");
    expect(error && error.type === "error" ? error.error : "").toContain("consecutive turns of tool errors");
  });

  it("does not fire the corrective prompt when the same tool fails with different args", async () => {
    const failingTool = makeTool("Read", { content: "boom", isError: true });
    const { agent, factory, events, history } = buildHarness({
      tools: [failingTool],
      chunks: [
        [
          { type: "tool_call_start", index: 0, id: "c1", name: "Read" },
          { type: "tool_call_delta", index: 0, delta: '{"path":"a.ts"}' },
          { type: "tool_call_end", index: 0 },
        ],
        [
          { type: "tool_call_start", index: 0, id: "c2", name: "Read" },
          { type: "tool_call_delta", index: 0, delta: '{"path":"b.ts"}' },
          { type: "tool_call_end", index: 0 },
        ],
        [
          { type: "tool_call_start", index: 0, id: "c3", name: "Read" },
          { type: "tool_call_delta", index: 0, delta: '{"path":"c.ts"}' },
          { type: "tool_call_end", index: 0 },
        ],
      ],
      maxTurns: 6,
    });

    await agent.send("x");

    // Different arguments each turn: detector A must NOT treat them as the
    // same failing call, so no corrective user prompt is injected. Detector B
    // (3 consecutive all-error turns) is what stops the loop.
    expect(factory.calls).toBe(3);
    expect(
      history.all().some((m) => m.role === "user" && /[Rr]e-emit the tool call/.test(m.content)),
    ).toBe(false);
    const error = events.find((e) => e.type === "error");
    expect(error && error.type === "error" ? error.error : "").toContain("consecutive turns of tool errors");
  });

  it("stops when the same successful tool call is repeated 3 times in a row", async () => {
    const { agent, factory, events } = buildHarness({
      chunks: [
        [{ type: "tool_call_start", index: 0, id: "c1", name: "FakeTool" }, { type: "tool_call_end", index: 0 }],
        [{ type: "tool_call_start", index: 0, id: "c2", name: "FakeTool" }, { type: "tool_call_end", index: 0 }],
        [{ type: "tool_call_start", index: 0, id: "c3", name: "FakeTool" }, { type: "tool_call_end", index: 0 }],
      ],
      maxTurns: 6,
    });

    await agent.send("x");

    expect(factory.calls).toBe(3);
    const error = events.find((e) => e.type === "error");
    expect(error && error.type === "error" ? error.error : "").toContain("3 times in a row");
  });

  it("notices the maxTurns limit with an explicit message", async () => {
    const { agent, history } = buildHarness({
      tools: [makeTool("A"), makeTool("B"), makeTool("C")],
      chunks: [
        [{ type: "tool_call_start", index: 0, id: "a1", name: "A" }, { type: "tool_call_end", index: 0 }],
        [{ type: "tool_call_start", index: 0, id: "b1", name: "B" }, { type: "tool_call_end", index: 0 }],
        [{ type: "tool_call_start", index: 0, id: "c1", name: "C" }, { type: "tool_call_end", index: 0 }],
      ],
      maxTurns: 3,
    });

    await agent.send("x");

    // Tool names differ each turn, no errors: no loop trigger, but the limit
    // still stops the agent with a visible message instead of a silent halt.
    const stopMsg = history.all().find((m) => m.content?.includes("3-turn limit"));
    expect(stopMsg).toBeDefined();
  });

  it("aborts mid-stream with a done event and no error", async () => {
    let signalRef: AbortSignal | undefined;
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const factory: LLMProviderFactory = {
      create() {
        return {
          protocol: "chat" as const,
          async *stream(_messages, signal) {
            signalRef = signal;
            let rejectAbort: (e: Error) => void = () => {};
            const aborted = new Promise<void>((_resolve, reject) => {
              rejectAbort = reject;
            });
            signal?.addEventListener("abort", () =>
              rejectAbort(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
            markStarted();
            yield { type: "text", content: "partial" };
            await aborted;
          },
        };
      },
    };
    const config = new StaticConfigProvider(VALID_CONFIG);
    const history = new InMemoryChatHistory();
    const events = new InMemoryEventBus<AgentEvent>();
    const eventsLog: AgentEvent[] = [];
    events.subscribe((e) => eventsLog.push(e));
    const tools = new ToolRegistry([]);
    const systemPrompt = new DefaultSystemPromptBuilder(() => [], () => "/workspace");
    const agent = new Agent({ config, llmFactory: factory, tools, history, events, systemPrompt });

    const sendPromise = agent.send("x");
    await started;
    expect(signalRef).toBeDefined();
    agent.abort();
    await sendPromise;

    expect(eventsLog.some((e) => e.type === "done")).toBe(true);
    expect(eventsLog.some((e) => e.type === "error")).toBe(false);
    expect(agent.streaming).toBe(false);
  });

  it("reset() clears the history", () => {
    const { agent, history } = buildHarness();
    history.add({ role: "user", content: "x", timestamp: 1 });
    agent.reset();
    expect(history.all()).toHaveLength(0);
  });

  it("load() replaces the history with a session's messages", () => {
    const { agent, history } = buildHarness();
    history.add({ role: "user", content: "old", timestamp: 1 });

    agent.load([
      { role: "user", content: "loaded", timestamp: 2 },
      { role: "assistant", content: "resp", timestamp: 3 },
    ]);

    expect(history.all().map((m) => m.content)).toEqual(["loaded", "resp"]);
  });
});

describe("ToolCallAccumulator", () => {
  it("assembles tool calls across start/delta/end chunks", () => {
    const acc = new ToolCallAccumulator();

    expect(acc.handle({ type: "tool_call_start", index: 0, id: "c1", name: "Read" })).toBeUndefined();
    expect(acc.handle({ type: "tool_call_delta", index: 0, delta: '{"path":' })).toBeUndefined();
    const call = acc.handle({ type: "tool_call_delta", index: 0, delta: '"/x"}' });

    expect(call).toBeUndefined();
    const completed = acc.handle({ type: "tool_call_end", index: 0 });
    expect(completed).toEqual({ id: "c1", name: "Read", arguments: { path: "/x" }, malformed: false });
  });

  it("ignores duplicate ends and deltas without a start", () => {
    const acc = new ToolCallAccumulator();

    expect(acc.handle({ type: "tool_call_delta", index: 5, delta: "junk" })).toBeUndefined();
    expect(acc.handle({ type: "tool_call_end", index: 5 })).toBeUndefined();

    acc.handle({ type: "tool_call_start", index: 0, id: "c1", name: "X" });
    acc.handle({ type: "tool_call_end", index: 0 });
    expect(acc.handle({ type: "tool_call_end", index: 0 })).toBeUndefined();
  });

  it("returns an empty object for invalid JSON arguments", () => {
    const acc = new ToolCallAccumulator();
    acc.handle({ type: "tool_call_start", index: 0, id: "c1", name: "X" });
    acc.handle({ type: "tool_call_delta", index: 0, delta: "not json" });
    const call = acc.handle({ type: "tool_call_end", index: 0 });
    expect(call?.arguments).toEqual({});
  });

  it("supports multiple parallel tool calls by index", () => {
    const acc = new ToolCallAccumulator();
    acc.handle({ type: "tool_call_start", index: 0, id: "a", name: "Read" });
    acc.handle({ type: "tool_call_start", index: 1, id: "b", name: "Write" });
    acc.handle({ type: "tool_call_delta", index: 1, delta: '{"path":"p"}' });

    const b = acc.handle({ type: "tool_call_end", index: 1 });
    const a = acc.handle({ type: "tool_call_end", index: 0 });

    expect(a).toEqual({ id: "a", name: "Read", arguments: {}, malformed: false });
    expect(b).toEqual({ id: "b", name: "Write", arguments: { path: "p" }, malformed: false });
  });
});

describe("Agent follow-through guard", () => {
  it("a no-tool turn is a final answer: no extra LLM turns, no nudge in history", async () => {
    const { agent, factory, history } = buildHarness({
      chunks: [[{ type: "text", content: "Sure! I will search for it." }]],
      maxTurns: 6,
    });

    await agent.send("find me the weather?");

    // One single LLM call: the answer stands as-is (enforcement is in the
    // system prompt, not runtime heuristics).
    expect(factory.calls).toBe(1);
    const userMsgs = history.all().filter((m) => m.role === "user");
    expect(userMsgs).toEqual([expect.objectContaining({ content: "find me the weather?" })]);
    const assistants = history.all().filter((m) => m.role === "assistant").map((m) => m.content);
    expect(assistants).toEqual(["Sure! I will search for it."]);
  });
});


