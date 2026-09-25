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
import type { ToolDefinition } from "../tools/tool";
import { toolDefinitionsForMode } from "../tools/mode-policy";
import type { DelegateSpec } from "./orchestration";
import type { AgentEvent, SubAgentEvent } from "./types";

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

  it("nudges once, then stops when the same successful tool call keeps repeating", async () => {
    const { agent, factory, events, history } = buildHarness({
      chunks: [
        [{ type: "tool_call_start", index: 0, id: "c1", name: "FakeTool" }, { type: "tool_call_end", index: 0 }],
        [{ type: "tool_call_start", index: 0, id: "c2", name: "FakeTool" }, { type: "tool_call_end", index: 0 }],
        [{ type: "tool_call_start", index: 0, id: "c3", name: "FakeTool" }, { type: "tool_call_end", index: 0 }],
      ],
      maxTurns: 6,
    });

    await agent.send("x");

    // 3 identical calls → corrective nudge; one more identical → stop (4 calls).
    expect(factory.calls).toBe(4);
    expect(history.all().some((m) => m.role === "user" && /SAME tool/.test(m.content ?? ""))).toBe(true);
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

describe("Analyze (read-only) mode", () => {
  // Captures the tool definitions AND the system prompt each LLM turn
  // advertises, so tests can assert what the model was (and was NOT) allowed
  // to call and what rules it was given.
  function capturingHarness(
    tools: Tool[],
    chunks?: StreamChunk[][],
    mode: "analyze" | "agent" = "analyze",
  ): { agent: Agent; seenDefinitions: ToolDefinition[][]; seenSystemPrompts: string[]; history: InMemoryChatHistory } {
    const config = new StaticConfigProvider(VALID_CONFIG);
    const history = new InMemoryChatHistory();
    const events = new InMemoryEventBus<AgentEvent>();
    const seenDefinitions: ToolDefinition[][] = [];
    const seenSystemPrompts: string[] = [];
    let calls = 0;
    const factory: LLMProviderFactory = {
      create() {
        return {
          protocol: "chat" as const,
          async *stream(messages: LLMMessage[], _signal?: AbortSignal, toolDefinitions?: ToolDefinition[]) {
            if (toolDefinitions) seenDefinitions.push(toolDefinitions);
            seenSystemPrompts.push(String(messages[0]?.content ?? ""));
            const perCall = chunks ?? [[{ type: "text", content: "ok" }]];
            const list = perCall[Math.min(calls, perCall.length - 1)];
            calls++;
            for (const c of list) yield c;
          },
        };
      },
    };
    const registry = new ToolRegistry(tools);
    const systemPrompt = new DefaultSystemPromptBuilder(
      (m) => toolDefinitionsForMode(registry.getAll(), m),
      () => "/workspace",
    );
    const agent = new Agent({ config, llmFactory: factory, tools: registry, history, events, systemPrompt });
    agent.setMode(mode);
    return { agent, seenDefinitions, seenSystemPrompts, history };
  }

  function toolCallChunks(name: string, argsJson: string): StreamChunk[] {
    return [
      { type: "tool_call_start", index: 0, id: "c1", name },
      { type: "tool_call_delta", index: 0, delta: argsJson },
      { type: "tool_call_end", index: 0 },
    ];
  }

  it("advertises only the read-only tool set in analyze and all tools after setMode('agent')", async () => {
    const tools = ["Read", "Write", "Edit", "Delete", "StrReplace", "Shell", "Grep"].map((n) =>
      ({ name: n, definition: { name: n, description: n, parameters: { type: "object", properties: {} } }, execute: async () => ({ content: "ok", isError: false }) }) as Tool,
    );
    const { agent, seenDefinitions } = capturingHarness(tools);

    await agent.send("analyze this"); // default mode = analyze
    expect(seenDefinitions[0].map((d) => d.name)).toEqual(["Read", "Shell", "Grep"]);
    // the advertised Shell is explicitly read-only
    expect(seenDefinitions[0].find((d) => d.name === "Shell")!.description).toContain("READ-ONLY");

    agent.setMode("agent");
    await agent.send("now edit it");
    expect(seenDefinitions[1].map((d) => d.name).sort()).toEqual([...tools.map((t) => t.name)].sort());
  });

  it("refuses file-mutating tool calls in analyze WITHOUT running them", async () => {
    const writeTool = { ...makeTool("Write"), execute: vi.fn(async (): Promise<ToolResult> => ({ content: "wrote", isError: false })) };
    const { agent, history } = capturingHarness(
      [writeTool, makeTool("Read")],
      [toolCallChunks("Write", '{"path":"a.txt","content":"x"}'), [{ type: "text", content: "ok" }]],
    );

    await agent.send("write a file");

    expect(writeTool.execute as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    const toolResult = history.all().find((m) => m.role === "tool");
    expect(toolResult?.content).toContain("disabled in Analyze");
  });

  it("runs the same write tool after switching to agent mode", async () => {
    const writeTool = { ...makeTool("Write"), execute: vi.fn(async (): Promise<ToolResult> => ({ content: "wrote", isError: false })) };
    const { agent, history } = capturingHarness(
      [writeTool],
      [toolCallChunks("Write", '{"path":"a.txt","content":"x"}'), [{ type: "text", content: "ok" }]],
      "agent",
    );

    await agent.send("write a file");

    expect(writeTool.execute as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(history.all().find((m) => m.role === "tool")?.content).toBe("wrote");
  });

  it("refuses a write shell command in analyze without running it, but allows read-only commands", async () => {
    const shell = {
      ...makeTool("Shell"),
      execute: vi.fn(async (): Promise<ToolResult> => ({ content: "ran", isError: false })),
    };
    const { agent } = capturingHarness(
      [shell],
      [toolCallChunks("Shell", '{"command":"rm -rf /tmp/x"}'), [{ type: "text", content: "ok" }]],
    );
    await agent.send("delete temp");
    expect(shell.execute as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();

    const { agent: agent2, history: history2 } = capturingHarness(
      [shell, makeTool("Read")],
      [toolCallChunks("Shell", '{"command":"ls -la"}'), [{ type: "text", content: "ok" }]],
    );
    await agent2.send("list files");
    expect(shell.execute as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(history2.all().find((m) => m.role === "tool")?.content).toBe("ran");
  });

  it("keeps read tools fully functional in analyze mode", async () => {
    const readTool = makeTool("Read", { content: "contents", isError: false });
    const { agent, history } = capturingHarness(
      [readTool],
      [toolCallChunks("Read", '{"path":"a.ts"}'), [{ type: "text", content: "ok" }]],
    );

    await agent.send("read the file");

    expect(readTool.called).toBe(true);
    expect(history.all().find((m) => m.role === "tool")?.content).toBe("contents");
  });

  it("sends a read-only system prompt in analyze and a full one after setMode('agent')", async () => {
    const { agent, seenSystemPrompts } = capturingHarness([makeTool("Read")]);

    await agent.send("analyze this");
    expect(seenSystemPrompts[0]).toContain("READ-ONLY MODE (Analyze)");

    agent.setMode("agent");
    await agent.send("now do it");
    expect(seenSystemPrompts[1]).not.toContain("READ-ONLY MODE (Analyze)");
  });

  it("switching back from agent to analyze restores the read-only tool set", async () => {
    const tools = ["Read", "Write", "Shell"].map((n) =>
      ({ name: n, definition: { name: n, description: n, parameters: { type: "object", properties: {} } }, execute: async () => ({ content: "ok", isError: false }) }) as Tool,
    );
    const { agent, seenDefinitions } = capturingHarness(tools, undefined, "agent");

    await agent.send("full mode");
    expect(seenDefinitions[0].map((d) => d.name).sort()).toEqual(["Read", "Write", "Shell"].sort());

    agent.setMode("analyze"); // back to read-only
    await agent.send("analyze again");
    expect(seenDefinitions[1].map((d) => d.name)).toEqual(["Read", "Shell"]);
  });
});



describe("Orchestration (Delegate)", () => {
  function delegateTurn(calls: Array<Record<string, unknown>>): StreamChunk[] {
    const out: StreamChunk[] = [];
    calls.forEach((args, i) => {
      out.push({ type: "tool_call_start", index: i, id: "d" + i, name: "Delegate" });
      out.push({ type: "tool_call_delta", index: i, delta: JSON.stringify(args) });
      out.push({ type: "tool_call_end", index: i });
    });
    return out;
  }

  function build(opts: {
    calls: Array<Record<string, unknown>>;
    mode?: "analyze" | "agent";
    allowDelegation?: boolean;
    maxParallel?: number;
    delegate?: boolean;
    spawn?: (spec: DelegateSpec, onEvent?: (e: SubAgentEvent) => void) => Promise<ToolResult>;
  }): { agent: Agent; history: InMemoryChatHistory; eventLog: AgentEvent[] } {
    const config = new StaticConfigProvider(
      opts.maxParallel ? { ...VALID_CONFIG, maxParallelSubAgents: opts.maxParallel } : VALID_CONFIG,
    );
    const history = new InMemoryChatHistory();
    const events = new InMemoryEventBus<AgentEvent>();
    const eventLog: AgentEvent[] = [];
    events.subscribe((e) => eventLog.push(e));
    const factory = fakeFactory(delegateTurn(opts.calls), [{ type: "text", content: "done" }]);
    const tools = new ToolRegistry([makeTool("Read")]);
    const systemPrompt = new DefaultSystemPromptBuilder(() => tools.definitions(), () => "/w");
    const agent = new Agent({
      config,
      llmFactory: factory,
      tools,
      history,
      events,
      systemPrompt,
      allowDelegation: opts.allowDelegation,
      spawnSubAgent: opts.spawn ?? (async () => ({ content: "default report", isError: false })),
    });
    agent.setMode(opts.mode ?? "agent");
    agent.setDelegation(opts.delegate !== false); // orchestration tests: ON by default
    return { agent, history, eventLog };
  }

  it("intercepts Delegate and hands the parsed spec to the runner", async () => {
    const seen: DelegateSpec[] = [];
    const { agent } = build({
      calls: [{ id: "A", goal: "analyze x", access: "read", resources: ["src/a.ts"], parallel: "yes" }],
      spawn: async (spec) => {
        seen.push(spec);
        return { content: "🔁 report A", isError: false };
      },
    });

    await agent.send("go");

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      id: "A",
      goal: "analyze x",
      access: "read",
      resources: ["src/a.ts"],
      parallel: true,
    });
  });

  it("runs parallel read-delegates concurrently (both start before either ends)", async () => {
    const order: string[] = [];
    const spawn = async (spec: DelegateSpec): Promise<ToolResult> => {
      order.push("start:" + spec.id);
      await new Promise((r) => setTimeout(r, 5));
      order.push("end:" + spec.id);
      return { content: "r" + spec.id, isError: false };
    };
    const { agent } = build({
      calls: [
        { id: "A", goal: "a", access: "read", resources: ["a.ts"], parallel: "yes" },
        { id: "B", goal: "b", access: "read", resources: ["b.ts"], parallel: "yes" },
      ],
      spawn,
    });

    await agent.send("go");

    expect(order).toEqual(["start:A", "start:B", "end:A", "end:B"]);
  });

  it("caps concurrency at maxParallelSubAgents with a sliding window (never more than N running)", async () => {
    let running = 0;
    let maxRunning = 0;
    const order: string[] = [];
    const spawn = async (spec: DelegateSpec): Promise<ToolResult> => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      order.push("start:" + spec.id);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      order.push("end:" + spec.id);
      return { content: "r", isError: false };
    };
    const { agent } = build({
      calls: [
        { id: "A", goal: "a", access: "read", resources: ["a.ts"], parallel: "yes" },
        { id: "B", goal: "b", access: "read", resources: ["b.ts"], parallel: "yes" },
        { id: "C", goal: "c", access: "read", resources: ["c.ts"], parallel: "yes" },
      ],
      maxParallel: 2,
      spawn,
    });

    await agent.send("go");

    // Never more than 2 in flight…
    expect(maxRunning).toBe(2);
    // …and the slot of a finished agent is reused: C starts as soon as A ends
    // (it does NOT wait for B to finish too).
    expect(order.indexOf("start:C")).toBeGreaterThan(order.indexOf("end:A"));
    expect(order.indexOf("start:C")).toBeLessThan(order.indexOf("end:B"));
  });

  it("keeps the pool saturated: a fast agent frees its slot for the next one", async () => {
    const order: string[] = [];
    const spawn = async (spec: DelegateSpec): Promise<ToolResult> => {
      order.push("start:" + spec.id);
      // A is fast, B is slow, C is fast.
      await new Promise((r) => setTimeout(r, spec.id === "B" ? 40 : 5));
      order.push("end:" + spec.id);
      return { content: "r", isError: false };
    };
    const { agent } = build({
      calls: [
        { id: "A", goal: "a", access: "read", resources: ["a.ts"], parallel: "yes" },
        { id: "B", goal: "b", access: "read", resources: ["b.ts"], parallel: "yes" },
        { id: "C", goal: "c", access: "read", resources: ["c.ts"], parallel: "yes" },
      ],
      maxParallel: 2,
      spawn,
    });

    await agent.send("go");

    // A (fast) ends → C starts while B is still running (sliding window).
    expect(order.indexOf("end:A")).toBeLessThan(order.indexOf("start:C"));
    expect(order.indexOf("start:C")).toBeLessThan(order.indexOf("end:B"));
  });

  it("forwards the sub-agent's live events tagged with the Delegate tool call", async () => {
    const { agent, eventLog } = build({
      calls: [{ id: "A", goal: "a", access: "read", resources: ["a.ts"] }],
      spawn: async (_spec, onEvent) => {
        onEvent?.({ type: "thinking_delta", content: "thinking..." });
        onEvent?.({ type: "tool_call", toolCall: { id: "t1", name: "Read", arguments: { path: "a.ts" } } });
        return { content: "report", isError: false };
      },
    });

    await agent.send("go");

    const forwarded = eventLog.filter((e) => e.type === "subagent_event");
    expect(forwarded).toHaveLength(2);
    expect(forwarded[0]).toMatchObject({ toolCallId: "d0", event: { type: "thinking_delta" } });
    expect(forwarded[1]).toMatchObject({ toolCallId: "d0", event: { type: "tool_call" } });
  });

  it("emits each tool_result as its sub-agent finishes (not after the whole batch)", async () => {
    const spawn = async (spec: DelegateSpec): Promise<ToolResult> => {
      // A is slower than B: B must reach "done" first.
      await new Promise((r) => setTimeout(r, spec.id === "A" ? 15 : 3));
      return { content: "r" + spec.id, isError: false };
    };
    const { agent, eventLog, history } = build({
      calls: [
        { id: "A", goal: "a", access: "read", resources: ["a.ts"], parallel: "yes" },
        { id: "B", goal: "b", access: "read", resources: ["b.ts"], parallel: "yes" },
      ],
      spawn,
    });

    await agent.send("go");

    // Emission order follows COMPLETION order (B before A)…
    const emitted = eventLog
      .filter((e) => e.type === "tool_result")
      .map((e) => (e as { toolResult: { toolCallId: string } }).toolResult.toolCallId);
    expect(emitted).toEqual(["d1", "d0"]);

    // …while history still stores tool messages in the ORIGINAL call order.
    const stored = history
      .all()
      .filter((m) => m.role === "tool")
      .map((m) => m.toolCallId);
    expect(stored).toEqual(["d0", "d1"]);
  });

  it("routes each sub-agent's live events to its OWN Delegate call", async () => {
    const { agent, eventLog } = build({
      calls: [
        { id: "A", goal: "a", access: "read", resources: ["a.ts"], parallel: "yes" },
        { id: "B", goal: "b", access: "read", resources: ["b.ts"], parallel: "yes" },
      ],
      spawn: async (spec, onEvent) => {
        onEvent?.({ type: "text_delta", content: "from " + spec.id });
        return { content: "r" + spec.id, isError: false };
      },
    });

    await agent.send("go");

    const forwarded = eventLog.filter((e) => e.type === "subagent_event");
    const byCall = new Map(
      forwarded.map((e) => [
        (e as { toolCallId: string }).toolCallId,
        (e as { event: { content?: string } }).event.content ?? "",
      ]),
    );
    // Two parallel delegates → two tool-call ids (d0, d1), each with its event.
    expect(byCall.get("d0")).toBe("from A");
    expect(byCall.get("d1")).toBe("from B");
  });

  it("hides the Delegate tool from the LLM entirely when Parallel is OFF", async () => {
    const seenDefs: string[][] = [];
    const factory: LLMProviderFactory = {
      create() {
        return {
          protocol: "chat" as const,
          async *stream(_m: LLMMessage[], _s?: AbortSignal, defs?: { name: string }[]) {
            seenDefs.push((defs ?? []).map((d) => d.name));
            yield { type: "text", content: "ok" };
          },
        };
      },
    };
    const tools = new ToolRegistry([makeTool("Read"), makeTool("Delegate")]);
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: factory,
      tools,
      history: new InMemoryChatHistory(),
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(
        (m) => toolDefinitionsForMode(tools.getAll(), m),
        () => "/w",
      ),
      allowDelegation: true,
      spawnSubAgent: async () => ({ content: "r", isError: false }),
    });
    agent.setMode("agent");

    agent.setDelegation(false);
    await agent.send("off");
    expect(seenDefs[0]).not.toContain("Delegate");

    agent.setDelegation(true);
    await agent.send("on");
    expect(seenDefs[1]).toContain("Delegate");
  });

  it("drops past Delegate turns from the LLM conversation when Parallel is OFF", async () => {
    const seen: LLMMessage[][] = [];
    const factory: LLMProviderFactory = {
      create() {
        return {
          protocol: "chat" as const,
          async *stream(messages: LLMMessage[]) {
            seen.push(messages);
            yield { type: "text", content: "ok" };
          },
        };
      },
    };
    const history = new InMemoryChatHistory();
    history.add({ role: "user", content: "earlier", timestamp: 1 });
    history.add({
      role: "assistant",
      content: "🔧 Tools: Delegate",
      timestamp: 2,
      toolCalls: [{ id: "d1", name: "Delegate", arguments: {} }],
    });
    history.add({ role: "tool", content: "🔁 report", toolCallId: "d1", timestamp: 3 });
    history.add({ role: "assistant", content: "done", timestamp: 4 });

    const tools = new ToolRegistry([makeTool("Read")]);
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: factory,
      tools,
      history,
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(
        (m) => toolDefinitionsForMode(tools.getAll(), m),
        () => "/w",
      ),
      allowDelegation: true,
      spawnSubAgent: async () => ({ content: "r", isError: false }),
    });
    agent.setMode("agent");

    agent.setDelegation(false);
    await agent.send("now");
    const off = seen[0].map((m) => m.content ?? "").join("|");
    expect(off).not.toContain("Delegate");
    expect(off).not.toContain("report");

    agent.setDelegation(true);
    await agent.send("now2");
    const on = seen[1].map((m) => m.content ?? "").join("|");
    expect(on).toContain("Delegate");
  });

  it("emits subagent_start when each delegate actually begins (cap visible)", async () => {
    const started: string[] = [];
    const spawn = async (spec: DelegateSpec): Promise<ToolResult> => {
      started.push(spec.id);
      await new Promise((r) => setTimeout(r, 3));
      return { content: "r", isError: false };
    };
    const { agent, eventLog } = build({
      calls: [
        { id: "A", goal: "a", access: "read", resources: ["a.ts"], parallel: "yes" },
        { id: "B", goal: "b", access: "read", resources: ["b.ts"], parallel: "yes" },
      ],
      spawn,
    });

    await agent.send("go");

    const starts = eventLog.filter((e) => e.type === "subagent_start");
    expect(starts).toHaveLength(2);
    expect(started).toEqual(["A", "B"]);
  });

  it("maxParallelSubAgents = 1 serializes even parallel read-delegates", async () => {
    const order: string[] = [];
    const spawn = async (spec: DelegateSpec): Promise<ToolResult> => {
      order.push("start:" + spec.id);
      await new Promise((r) => setTimeout(r, 3));
      order.push("end:" + spec.id);
      return { content: "r", isError: false };
    };
    const { agent } = build({
      calls: [
        { id: "A", goal: "a", access: "read", resources: ["a.ts"], parallel: "yes" },
        { id: "B", goal: "b", access: "read", resources: ["b.ts"], parallel: "yes" },
      ],
      maxParallel: 1,
      spawn,
    });

    await agent.send("go");

    expect(order).toEqual(["start:A", "end:A", "start:B", "end:B"]);
  });

  it("never runs two writers concurrently", async () => {
    const order: string[] = [];
    const spawn = async (spec: DelegateSpec): Promise<ToolResult> => {
      order.push("start:" + spec.id);
      await new Promise((r) => setTimeout(r, 5));
      order.push("end:" + spec.id);
      return { content: "r" + spec.id, isError: false };
    };
    const { agent } = build({
      calls: [
        { id: "A", goal: "a", access: "write", resources: ["a.ts"], parallel: "yes" },
        { id: "B", goal: "b", access: "create", resources: ["b.ts"], parallel: "yes" },
      ],
      mode: "agent",
      spawn,
    });

    await agent.send("go");

    expect(order).toEqual(["start:A", "end:A", "start:B", "end:B"]);
  });

  it("refuses delegation when Parallel is OFF (Analyze or Agent)", async () => {
    let spawned = 0;
    const { agent, history } = build({
      calls: [{ id: "A", goal: "read", access: "read", resources: ["a.ts"] }],
      mode: "analyze",
      delegate: false,
      spawn: async () => {
        spawned++;
        return { content: "x", isError: false };
      },
    });

    await agent.send("go");

    expect(spawned).toBe(0);
    expect(history.all().find((m) => m.role === "tool")?.content).toContain("Delegation is disabled");
  });

  it("Analyze + Parallel: orchestrates read-only sub-agents but refuses writers", async () => {
    const spawned: string[] = [];
    const { agent, history } = build({
      calls: [
        { id: "A", goal: "read a", access: "read", resources: ["a.ts"], parallel: "yes" },
        { id: "B", goal: "write b", access: "write", resources: ["b.ts"] },
      ],
      mode: "analyze",
      spawn: async (spec) => {
        spawned.push(spec.id);
        return { content: "r", isError: false };
      },
    });

    await agent.send("go");

    // The read-only sub-agent ran; the writer was refused (read-only mode).
    expect(spawned).toEqual(["A"]);
    expect(history.all().some((m) => m.role === "tool" && /read-only/i.test(m.content ?? ""))).toBe(true);
  });

  it("abort() cascades to the sub-agents via onAbort", () => {
    let called = false;
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: fakeFactory([{ type: "text", content: "ok" }]),
      tools: new ToolRegistry([makeTool("Read")]),
      history: new InMemoryChatHistory(),
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(() => [], () => "/w"),
      allowDelegation: true,
      spawnSubAgent: async () => ({ content: "r", isError: false }),
      onAbort: () => {
        called = true;
      },
    });
    agent.abort();
    expect(called).toBe(true);
  });

  it("maxParallelSubAgents caps 5 parallel delegates to 2 concurrent", async () => {
    let running = 0;
    let max = 0;
    const spawn = async (): Promise<ToolResult> => {
      running++;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return { content: "r", isError: false };
    };
    const calls = ["A", "B", "C", "D", "E"].map((id, i) => ({
      id,
      goal: id,
      access: "read",
      resources: [`${i}.ts`],
      parallel: "yes",
    }));
    const { agent } = build({ calls, maxParallel: 2, spawn });

    await agent.send("go");

    expect(max).toBe(2);
  });

  it("abort stops launching queued sub-agents and ends the turn", async () => {
    const started: string[] = [];
    let agentRef: Agent;
    const spawn = async (spec: DelegateSpec): Promise<ToolResult> => {
      started.push(spec.id);
      if (spec.id === "A") agentRef.abort(); // user presses Stop while A runs
      await new Promise((r) => setTimeout(r, 5));
      return { content: "r", isError: false };
    };
    const calls = ["A", "B", "C"].map((id, i) => ({
      id,
      goal: id,
      access: "read",
      resources: [`${i}.ts`],
      parallel: "yes",
    }));
    const { agent, history, eventLog } = build({ calls, maxParallel: 1, spawn });
    agentRef = agent;

    await agent.send("go");

    // Only A started; the queued B/C must NEVER start after Stop.
    expect(started).toEqual(["A"]);
    // The not-started calls still get a tool result so the history stays coherent.
    expect(
      history.all().some((m) => m.role === "tool" && /aborted before running/i.test(m.content ?? "")),
    ).toBe(true);
    // …and a tool_result event is EMITTED for them, so the UI marks them ABORTED.
    const abortedEvents = eventLog.filter(
      (e) => e.type === "tool_result" && /aborted before running/i.test(e.toolResult.output),
    );
    expect(abortedEvents.length).toBe(2); // B and C
  });

  it("read-only delegates are parallel BY DEFAULT (no parallel flag needed)", async () => {
    let running = 0;
    let max = 0;
    const spawn = async (): Promise<ToolResult> => {
      running++;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return { content: "r", isError: false };
    };
    // No `parallel` field at all — reads must still run together.
    const calls = ["A", "B", "C"].map((id, i) => ({ id, goal: id, access: "read", resources: [`${i}.ts`] }));
    const { agent } = build({ calls, maxParallel: 2, spawn });

    await agent.send("go");

    expect(max).toBe(2);
  });

  it("rejects invalid delegate args (missing resources) without spawning", async () => {
    let spawned = 0;
    const { agent, history } = build({
      calls: [{ id: "A", goal: "x", access: "read" }],
      spawn: async () => {
        spawned++;
        return { content: "x", isError: false };
      },
    });

    await agent.send("go");

    expect(spawned).toBe(0);
    expect(history.all().find((m) => m.role === "tool")?.content).toContain("resources");
  });

  it("reports delegation unavailable when no spawn hook is configured", async () => {
    const history = new InMemoryChatHistory();
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: fakeFactory(
        delegateTurn([{ id: "A", goal: "x", access: "read", resources: ["a.ts"] }]),
        [{ type: "text", content: "ok" }],
      ),
      tools: new ToolRegistry([makeTool("Read")]),
      history,
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(() => [], () => "/w"),
      allowDelegation: true,
      // no spawnSubAgent on purpose
    });
    agent.setDelegation(true);

    await agent.send("go");

    expect(history.all().find((m) => m.role === "tool")?.content).toContain("not available");
  });

  it("wraps a thrown sub-agent error as a failed report", async () => {
    const { agent, history } = build({
      calls: [{ id: "A", goal: "x", access: "read", resources: ["a.ts"] }],
      spawn: async () => {
        throw new Error("kaboom");
      },
    });

    await agent.send("go");

    const tool = history.all().find((m) => m.role === "tool");
    expect(tool?.content).toContain("kaboom");
    expect(tool?.content).toContain('Sub-agent "A" failed');
  });

  it("sub-agents cannot delegate further (depth 1)", async () => {
    let spawned = 0;
    const { agent, history } = build({
      calls: [{ id: "A", goal: "x", access: "read", resources: ["a.ts"] }],
      allowDelegation: false,
      spawn: async () => {
        spawned++;
        return { content: "x", isError: false };
      },
    });

    await agent.send("go");

    expect(spawned).toBe(0);
    expect(history.all().find((m) => m.role === "tool")?.content).toContain("cannot delegate further");
  });

  it("turning Parallel off disables orchestration", async () => {
    let spawned = 0;
    const { agent, history } = build({
      calls: [{ id: "A", goal: "x", access: "read", resources: ["a.ts"] }],
      spawn: async () => {
        spawned++;
        return { content: "x", isError: false };
      },
    });
    agent.setDelegation(false); // Parallel turned off

    await agent.send("go");

    expect(spawned).toBe(0);
    expect(history.all().find((m) => m.role === "tool")?.content).toContain("Delegation is disabled");
  });

  it("advertises Delegate (and its rules) only when delegation is on", async () => {
    const seen: string[] = [];
    const factory: LLMProviderFactory = {
      create() {
        return {
          protocol: "chat" as const,
          async *stream(messages: LLMMessage[]) {
            seen.push(String(messages[0]?.content ?? ""));
            yield { type: "text", content: "ok" };
          },
        };
      },
    };
    const delegateTool = makeTool("Delegate");
    const tools = new ToolRegistry([makeTool("Read"), delegateTool]);
    const systemPrompt = new DefaultSystemPromptBuilder(
      (m) => toolDefinitionsForMode(tools.getAll(), m),
      () => "/w",
    );
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: factory,
      tools,
      history: new InMemoryChatHistory(),
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt,
      allowDelegation: true,
      spawnSubAgent: async () => ({ content: "r", isError: false }),
    });

    // Parallel OFF: Delegate is NOT advertised.
    agent.setMode("agent");
    agent.setDelegation(false);
    await agent.send("off");
    expect(seen[0]).not.toContain("- Delegate:");
    expect(seen[0]).not.toContain("ORCHESTRATION");

    // Parallel ON: Delegate + orchestration rules appear.
    agent.setDelegation(true);
    await agent.send("on");
    expect(seen[1]).toContain("- Delegate:");
    expect(seen[1]).toContain("ORCHESTRATION");
  });
});

describe("Turn budget + forced final report", () => {
  it("when the budget is exhausted it asks for a report with NO tools (not a bare limit note)", async () => {
    const seenTools: (number | undefined)[] = [];
    let calls = 0;
    const factory: LLMProviderFactory = {
      create() {
        return {
          protocol: "chat" as const,
          async *stream(_m: LLMMessage[], _s?: AbortSignal, toolDefs?: { name: string }[]) {
            seenTools.push(toolDefs?.length);
            calls++;
            if (calls === 1) {
              yield { type: "tool_call_start", index: 0, id: "c1", name: "Read" };
              yield { type: "tool_call_end", index: 0 };
            } else {
              yield { type: "text", content: "FINAL REPORT: shipped" };
            }
          },
        };
      },
    };
    const history = new InMemoryChatHistory();
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: factory,
      tools: new ToolRegistry([makeTool("Read")]),
      history,
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(() => [], () => "/w"),
      maxTurns: 1,
      forceFinalReportOnLimit: true,
    });

    await agent.send("do it");

    // The forced turn advertised ZERO tools.
    expect(seenTools[0]).toBe(1);
    expect(seenTools[1]).toBe(0);
    const last = [...history.all()].reverse().find((m) => m.role === "assistant" && m.content);
    expect(last?.content).toContain("FINAL REPORT");
    expect(history.all().some((m) => /turn limit/.test(m.content ?? ""))).toBe(false);
  });

  it("without the flag it keeps the plain turn-limit stop note", async () => {
    const history = new InMemoryChatHistory();
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: {
        create() {
          return {
            protocol: "chat" as const,
            async *stream(): AsyncGenerator<StreamChunk> {
              yield { type: "tool_call_start", index: 0, id: "c1", name: "Read" };
              yield { type: "tool_call_end", index: 0 };
            },
          };
        },
      },
      tools: new ToolRegistry([makeTool("Read")]),
      history,
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(() => [], () => "/w"),
      maxTurns: 1,
    });

    await agent.send("do it");

    expect(history.all().some((m) => /reached the 1-turn limit/.test(m.content ?? ""))).toBe(true);
  });
});

describe("Repeated-call loop: nudge before hard stop", () => {
  it("gives one corrective nudge to change approach, then stops if it repeats", async () => {
    const repeated = (): StreamChunk[] => [
      { type: "tool_call_start", index: 0, id: "c1", name: "Shell" },
      { type: "tool_call_delta", index: 0, delta: '{"command":"ls -la"}' },
      { type: "tool_call_end", index: 0 },
    ];
    const history = new InMemoryChatHistory();
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      // The SAME call every turn, forever.
      llmFactory: fakeFactory(repeated(), repeated(), repeated(), repeated(), repeated()),
      tools: new ToolRegistry([makeTool("Shell")]),
      history,
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(() => [], () => "/w"),
    });

    await agent.send("go");

    // A corrective user message pointing at Glob/Grep/Read was injected…
    const nudge = history.all().find((m) => m.role === "user" && /SAME tool/.test(m.content ?? ""));
    expect(nudge).toBeDefined();
    expect(nudge!.content).toContain("Glob");
    expect(nudge!.content).toContain("Grep");
    // …and after it repeated again, the loop was stopped.
    expect(history.all().some((m) => /Loop detected/.test(m.content ?? ""))).toBe(true);
  });

  it("recovers: after the nudge the model changes approach and finishes", async () => {
    const shell = (): StreamChunk[] => [
      { type: "tool_call_start", index: 0, id: "c1", name: "Shell" },
      { type: "tool_call_delta", index: 0, delta: '{"command":"find . -name x"}' },
      { type: "tool_call_end", index: 0 },
    ];
    const glob = (): StreamChunk[] => [
      { type: "tool_call_start", index: 0, id: "c2", name: "Glob" },
      { type: "tool_call_delta", index: 0, delta: '{"glob_pattern":"**/x"}' },
      { type: "tool_call_end", index: 0 },
    ];
    const { agent, history } = buildHarness({
      tools: [makeTool("Shell"), makeTool("Glob")],
      // 3 identical Shell calls → nudge; then the model SWITCHES to Glob.
      chunks: [shell(), shell(), shell(), glob(), [{ type: "text", content: "done via Glob" }]],
    });

    await agent.send("go");

    expect(history.all().some((m) => m.role === "user" && /SAME tool/.test(m.content ?? ""))).toBe(true);
    // The nudge worked: no hard stop, and the final answer is present.
    expect(history.all().some((m) => /Loop detected/.test(m.content ?? ""))).toBe(false);
    expect(history.all().some((m) => /done via Glob/.test(m.content ?? ""))).toBe(true);
  });

  it("injects the corrective nudge at most once per send", async () => {
    const shell = (): StreamChunk[] => [
      { type: "tool_call_start", index: 0, id: "c1", name: "Shell" },
      { type: "tool_call_delta", index: 0, delta: '{"command":"ls -la"}' },
      { type: "tool_call_end", index: 0 },
    ];
    const { agent, history } = buildHarness({
      tools: [makeTool("Shell")],
      chunks: [shell(), shell(), shell(), shell(), shell(), shell()],
    });

    await agent.send("go");

    const nudges = history.all().filter((m) => m.role === "user" && /SAME tool/.test(m.content ?? ""));
    expect(nudges).toHaveLength(1);
  });

  it("skips the nudge when the turn budget leaves no room (stops instead)", async () => {
    const shell = (): StreamChunk[] => [
      { type: "tool_call_start", index: 0, id: "c1", name: "Shell" },
      { type: "tool_call_delta", index: 0, delta: '{"command":"ls"}' },
      { type: "tool_call_end", index: 0 },
    ];
    const { agent, history } = buildHarness({
      tools: [makeTool("Shell")],
      chunks: [shell(), shell(), shell()],
      maxTurns: 3,
    });

    await agent.send("go");

    // turn+1 would hit the cap → no corrective turn, straight stop.
    expect(history.all().some((m) => m.role === "user" && /SAME tool/.test(m.content ?? ""))).toBe(false);
    expect(history.all().some((m) => /Loop detected/.test(m.content ?? ""))).toBe(true);
  });

  it("does not stop a healthy run that changes its tool calls", async () => {
    const history = new InMemoryChatHistory();
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: fakeFactory(
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
          { type: "tool_call_start", index: 0, id: "c3", name: "Grep" },
          { type: "tool_call_delta", index: 0, delta: '{"search_term":"x"}' },
          { type: "tool_call_end", index: 0 },
        ],
        [{ type: "text", content: "final report" }],
      ),
      tools: new ToolRegistry([makeTool("Read"), makeTool("Grep")]),
      history,
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(() => [], () => "/w"),
    });

    await agent.send("go");

    expect(history.all().some((m) => /Loop detected/.test(m.content ?? ""))).toBe(false);
    expect(history.all().some((m) => /final report/.test(m.content ?? ""))).toBe(true);
  });
});
