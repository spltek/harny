import { describe, it, expect, vi } from "vitest";
import { Agent } from "./agent";
import { ToolCallAccumulator } from "./tool-call-accumulator";
import { BUILD_SWITCH_HINT, DefaultSystemPromptBuilder } from "./system-prompt";
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
import { SubAgentRunner } from "./subagent";
import type { AgentEvent, SubAgentEvent } from "./types";
import { resolveLoopGuardOptions, type LoopGuardOptions } from "./loop-guard";
import { McpTool } from "../mcp/mcp-tool";
import { toolCallPairingViolations } from "../history/tool-call-pairing";

const VALID_CONFIG: HarnyConfig = {
  provider: "openai",
  apiKey: "sk-test",
  baseUrl: "https://api.openai.com",
  model: "gpt-4o",
  maxTokens: 4096,
  temperature: 0.1,
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

function buildHarness(
  opts: {
    config?: HarnyConfig;
    chunks?: StreamChunk[][];
    tools?: Tool[];
    maxTurns?: number;
    log?: (message: string) => void;
    onTurnBoundary?: (signal: AbortSignal) => Promise<void> | void;
    loopGuard?: LoopGuardOptions;
    streamIdleTimeoutMs?: number;
    onFileChanged?: (change: { path: string; tool: string }) => void;
  } = {},
): Harness {
  const config = new StaticConfigProvider(opts.config ?? VALID_CONFIG);
  const history = new InMemoryChatHistory();
  const events = new InMemoryEventBus<AgentEvent>();
  const eventsLog: AgentEvent[] = [];
  events.subscribe((e) => eventsLog.push(e));
  const factory = fakeFactory(...(opts.chunks ?? [[{ type: "text", content: "hi" }]]));
  const tools = new ToolRegistry(opts.tools ?? [makeTool("FakeTool")]);
  const systemPrompt = new DefaultSystemPromptBuilder(() => tools.definitions(), () => "/workspace");

  const agent = new Agent({
    config,
    llmFactory: factory,
    tools,
    history,
    events,
    systemPrompt,
    maxTurns: opts.maxTurns,
    log: opts.log,
    onTurnBoundary: opts.onTurnBoundary,
    loopGuard: opts.loopGuard,
    streamIdleTimeoutMs: opts.streamIdleTimeoutMs,
    onFileChanged: opts.onFileChanged,
  });
  return { agent, factory, events: eventsLog, history };
}

describe("Agent", () => {
  it("aborts a stalled provider stream after the idle timeout and reports an explicit error", async () => {
    // A provider that accepts the request and then sends NOTHING (dead server).
    const hanging = {
      create: () => ({
        protocol: "chat" as const,
        async *stream(_m: unknown, signal?: AbortSignal) {
          await new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      }),
    } as unknown as LLMProviderFactory;
    const history = new InMemoryChatHistory();
    const events = new InMemoryEventBus<AgentEvent>();
    const log: AgentEvent[] = [];
    events.subscribe((e) => log.push(e));
    const tools = new ToolRegistry([]);
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: hanging,
      tools,
      history,
      events,
      systemPrompt: new DefaultSystemPromptBuilder(() => tools.definitions(), () => "/workspace"),
      streamIdleTimeoutMs: 20,
    });

    await agent.send("hi");

    // The run ends with an actionable error instead of hanging forever.
    expect(log.some((e) => e.type === "error" && /stalled/i.test((e as { error: string }).error))).toBe(true);
    expect(history.all().some((m) => m.role === "assistant" && /stalled/i.test(m.content))).toBe(true);
  });
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

  it("nudges and continues when a turn only produces thinking (no text, no tools)", async () => {
    const { agent, factory, history, events } = buildHarness({
      chunks: [
        [{ type: "thinking", content: "let me think about this" }],
        [{ type: "text", content: "final answer" }],
      ],
    });

    await agent.send("x");

    // Two LLM calls: the thinking-only turn is nudged, then answered.
    expect(factory.calls).toBe(2);
    // The guard logs a UI-only note and injects a corrective user nudge.
    expect(history.all().some((m) => m.role === "user" && /reasoning but no answer/.test(m.content))).toBe(true);
    expect(history.all().some((m) => m.role === "assistant" && m.content === "final answer")).toBe(true);
    expect(history.all().some((m) => m.content === "(empty response)")).toBe(false);
    // thinking deltas were streamed to the UI
    expect(events.some((e) => e.type === "thinking_delta" && e.content === "let me think about this")).toBe(true);
  });

  it("nudges and continues when a turn is completely empty (no text, no thinking, no tools)", async () => {
    const { agent, factory, history } = buildHarness({
      chunks: [[], [{ type: "text", content: "recovered answer" }]],
    });

    await agent.send("x");

    expect(factory.calls).toBe(2);
    expect(history.all().some((m) => m.role === "user" && /turn was empty/.test(m.content))).toBe(true);
    expect(history.all().some((m) => m.role === "assistant" && m.content === "recovered answer")).toBe(true);
  });

  it("stops with a clear error (not '(empty response)') when the model keeps stalling", async () => {
    const { agent, factory, history, events } = buildHarness({ chunks: [[]] });

    await agent.send("x");

    // Two nudges + the final failed attempt = 3 LLM calls, then a clear stop.
    expect(factory.calls).toBe(3);
    expect(history.all().some((m) => m.content === "(empty response)")).toBe(false);
    const last = history.all().filter((m) => m.role === "assistant").at(-1);
    expect(last?.content).toContain("Loop not resolved");
    expect(last?.content).toContain("[empty]");
    expect(events.some((e) => e.type === "error" && /Loop not resolved/.test(e.error))).toBe(true);
  });

  it("reports a token-limit truncation when the turn is empty (finish_reason=length)", async () => {
    const { agent, factory, history, events } = buildHarness({
      chunks: [[{ type: "thinking", content: "lots of reasoning" }, { type: "finish", reason: "length" }]],
    });

    await agent.send("x");

    // "length" is diagnosed immediately — no nudge/retry loop.
    expect(factory.calls).toBe(1);
    const last = history.all().filter((m) => m.role === "assistant").at(-1);
    expect(last?.content).toContain("token limit");
    expect(last?.content).toContain("harny.maxTokens");
    expect(last?.content).toContain("reasoning");
    expect(events.some((e) => e.type === "error" && /token limit|truncat/i.test(e.error))).toBe(true);
  });

  it("marks a partial answer as truncated when finish_reason=length", async () => {
    const { agent, history } = buildHarness({
      chunks: [[{ type: "text", content: "Partial ans" }, { type: "finish", reason: "length" }]],
    });

    await agent.send("x");

    const last = history.all().filter((m) => m.role === "assistant").at(-1);
    expect(last?.content).toContain("Partial ans");
    expect(last?.content).toContain("truncated");
    expect(last?.content).toContain("harny.maxTokens");
  });

  it("breaks a within-turn reasoning loop and nudges instead of burning the token budget", async () => {
    const loopText = "Let me check the CSS and the controls again. ".repeat(24);
    const { agent, factory, history, events } = buildHarness({
      chunks: [
        // Turn 0: a runaway repetitive reasoning stream.
        [{ type: "thinking", content: loopText }, { type: "finish", reason: "stop" }],
        // Turn 1: the model recovers with a final answer.
        [{ type: "text", content: "final answer after loop" }],
      ],
    });

    await agent.send("x");

    expect(factory.calls).toBe(2);
    const intervention = events.find((e) => e.type === "loop_intervention");
    expect(intervention && intervention.type === "loop_intervention" ? intervention.loopType : "").toBe("reasoning");
    // The corrective prompt is also surfaced LIVE (light-blue "Nudge" bubble).
    expect(events.some((e) => e.type === "harness_nudge")).toBe(true);
    expect(history.all().some((m) => m.role === "assistant" && /Loop guard/.test(m.content))).toBe(true);
    expect(history.all().some((m) => m.role === "assistant" && m.content === "final answer after loop")).toBe(true);
    // The broken reasoning was NOT stored as a normal assistant answer.
    expect(history.all().some((m) => m.role === "assistant" && m.content.includes(loopText))).toBe(false);
  });

  it("breaks a within-turn RESPONSE loop only when the opt-in guard is enabled", async () => {
    const loopText = "Let me explain the same thing over and over again. ".repeat(30);
    const chunks = [
      // Turn 0: a runaway repetitive VISIBLE answer.
      [{ type: "text", content: loopText }, { type: "finish", reason: "stop" }],
      // Turn 1: the model recovers with a concise answer.
      [{ type: "text", content: "concise final answer" }],
    ];

    // OFF (default): the repetitive answer is stored as-is, no intervention.
    const off = buildHarness({ chunks });
    await off.agent.send("x");
    expect(off.events.some((e) => e.type === "loop_intervention" && e.loopType === "response")).toBe(false);

    // ON: the answer is cut mid-stream, a "response" intervention is emitted,
    // and the model gets a chance to recover.
    const on = buildHarness({ chunks, loopGuard: resolveLoopGuardOptions("normal", true) });
    await on.agent.send("x");
    const intervention = on.events.find((e) => e.type === "loop_intervention");
    expect(intervention && intervention.type === "loop_intervention" ? intervention.loopType : "").toBe("response");
    expect(on.history.all().some((m) => m.role === "assistant" && m.content === "concise final answer")).toBe(true);
  });


  it("reuses a cached read-only result instead of re-running an identical read", async () => {
    let runs = 0;
    const read: Tool = {
      name: "Read",
      definition: { name: "Read", description: "read", parameters: { type: "object", properties: {} } },
      execute: (): ToolResult => {
        runs++;
        return { content: "FILE CONTENT", isError: false };
      },
    };
    const readCall = (): StreamChunk[] => [
      { type: "tool_call_start", index: 0, id: "c", name: "Read" },
      { type: "tool_call_delta", index: 0, delta: '{"path":"a.ts"}' },
      { type: "tool_call_end", index: 0 },
    ];
    const { agent, history } = buildHarness({
      tools: [read],
      chunks: [readCall(), readCall(), [{ type: "text", content: "done" }]],
    });

    await agent.send("x");

    // The underlying Read executed exactly once; the 2nd identical call reused it.
    expect(runs).toBe(1);
    expect(history.all().some((m) => m.role === "tool" && /reused the cached result/i.test(m.content))).toBe(true);
    expect(history.all().some((m) => m.content === "done")).toBe(true);
  });

  it("never sends the synthetic tool label to the model", async () => {
    const seen: LLMMessage[][] = [];
    const toolCall: StreamChunk[] = [
      { type: "tool_call_start", index: 0, id: "c1", name: "StrReplace" },
      { type: "tool_call_delta", index: 0, delta: '{"path":"a.ts","old_string":"x","new_string":"y"}' },
      { type: "tool_call_end", index: 0 },
    ];
    let call = 0;
    const factory: LLMProviderFactory = {
      create() {
        return {
          protocol: "chat" as const,
          async *stream(messages: LLMMessage[]) {
            seen.push(messages);
            call++;
            if (call === 1) {
              for (const c of toolCall) yield c;
            } else {
              yield { type: "text", content: "done" };
            }
          },
        };
      },
    };
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: factory,
      tools: new ToolRegistry([makeTool("StrReplace")]),
      history: new InMemoryChatHistory(),
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(() => [], () => "/w"),
    });

    await agent.send("go");

    expect(seen.length).toBeGreaterThanOrEqual(2);
    const assistantWithTools = seen[1].filter((m) => m.role === "assistant" && m.toolCalls?.length);
    expect(assistantWithTools).toHaveLength(1);
    expect(assistantWithTools[0].content).toBe("");
    // The synthetic label must never appear anywhere in the request.
    expect(JSON.stringify(seen[1])).not.toContain("🔧 Tool");
  });

  it("treats an ECHOED synthetic tool label as an empty turn and nudges instead of finishing", async () => {
    const toolCall: StreamChunk[] = [
      { type: "tool_call_start", index: 0, id: "c1", name: "StrReplace" },
      { type: "tool_call_delta", index: 0, delta: '{"path":"a.ts","old_string":"x","new_string":"y"}' },
      { type: "tool_call_end", index: 0 },
    ];
    const { agent, factory, history } = buildHarness({
      tools: [makeTool("StrReplace")],
      chunks: [
        toolCall,
        [{ type: "text", content: "🔧 Tool: StrReplace\n\n" }],
        [{ type: "text", content: "real answer" }],
      ],
    });

    await agent.send("go");

    // The echoed label did NOT end the run: the guard nudged and the model answered.
    // (Analyze mode also appends the preview footer, hence `includes`.)
    expect(history.all().some((m) => m.role === "assistant" && m.content.includes("real answer"))).toBe(true);
    expect(history.all().some((m) => m.role === "user" && /Continue NOW/.test(m.content))).toBe(true);
    expect(factory.calls).toBeGreaterThanOrEqual(3);
  });

  it("awaits onTurnBoundary before EVERY turn (mid-run hook) with the run's abort signal", async () => {
    let boundaries = 0;
    const signals: AbortSignal[] = [];
    const { agent } = buildHarness({
      chunks: [
        [{ type: "tool_call_start", index: 0, id: "c", name: "FakeTool" }, { type: "tool_call_end", index: 0 }],
        [{ type: "text", content: "done" }],
      ],
      onTurnBoundary: (signal) => {
        boundaries++;
        signals.push(signal);
      },
    });

    await agent.send("x");

    // Once before turn 0 (tool call) and once before turn 1 (final answer).
    expect(boundaries).toBe(2);
    // The host receives the run's signal so a mid-run compaction can be aborted.
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => typeof s?.aborted === "boolean" && s.aborted === false)).toBe(true);
  });

  it("emits a per-turn diagnostic line to the injected log", async () => {
    const logs: string[] = [];
    const repeated = (): StreamChunk[] => [
      { type: "tool_call_start", index: 0, id: "c", name: "Shell" },
      { type: "tool_call_delta", index: 0, delta: '{"command":"ls"}' },
      { type: "tool_call_end", index: 0 },
    ];
    const { agent } = buildHarness({
      tools: [makeTool("Shell")],
      chunks: [repeated(), repeated(), repeated(), [{ type: "text", content: "ok" }]],
      log: (m) => logs.push(m),
    });

    await agent.send("x");

    expect(logs.some((l) => /^turn 0: finish=/.test(l))).toBe(true);
    expect(logs.some((l) => l.includes("tools=[Shell]"))).toBe(true);
    expect(logs.some((l) => /loop-guard \[tool-repeat\] level 1/.test(l))).toBe(true);
  });

  it("logs stream start/end and per-tool timing (to diagnose a stall)", async () => {
    const logs: string[] = [];
    const call = (): StreamChunk[] => [
      { type: "tool_call_start", index: 0, id: "c", name: "FakeTool" },
      { type: "tool_call_delta", index: 0, delta: "{}" },
      { type: "tool_call_end", index: 0 },
    ];
    const { agent } = buildHarness({
      tools: [makeTool("FakeTool")],
      chunks: [call(), [{ type: "text", content: "done" }]],
      log: (m) => logs.push(m),
    });

    await agent.send("x");

    expect(logs.some((l) => /^stream: start model=/.test(l))).toBe(true);
    expect(logs.some((l) => /^stream: end after \d+s chunks=\d+/.test(l))).toBe(true);
    expect(logs.some((l) => /^tool: FakeTool start$/.test(l))).toBe(true);
    expect(logs.some((l) => /^tool: FakeTool ok in \d+ms$/.test(l))).toBe(true);
  });

  it("an MCP tool registered in the registry is callable by the agent", async () => {
    let called: Record<string, unknown> | undefined;
    const client = {
      callTool: async (_name: string, args: Record<string, unknown>) => {
        called = args;
        return { text: "mcp-ok", isError: false };
      },
    } as unknown as import("../mcp/mcp-client").McpStdioClient;
    const call: StreamChunk[] = [
      { type: "tool_call_start", index: 0, id: "m", name: "mcp__test__echo" },
      { type: "tool_call_delta", index: 0, delta: JSON.stringify({ text: "hi" }) },
      { type: "tool_call_end", index: 0 },
    ];
    const { agent, history } = buildHarness({
      tools: [new McpTool("test", { name: "echo" }, client)],
      chunks: [call, [{ type: "text", content: "done" }]],
    });

    await agent.send("x");

    expect(called).toEqual({ text: "hi" });
    expect(history.all().some((m) => m.role === "tool" && /mcp-ok/.test(m.content))).toBe(true);
  });

  it("logs a periodic stream heartbeat while the provider stalls (watchdog)", async () => {
    vi.useFakeTimers();
    try {
      const logs: string[] = [];
      // A stream that yields NOTHING until the turn is aborted: it simulates a
      // provider that went silent, the exact "hung" case we want to diagnose.
      const factory = {
        create: () => ({
          async *stream(_m: unknown, signal?: AbortSignal) {
            await new Promise<void>((resolve) => {
              if (signal?.aborted) return resolve();
              signal?.addEventListener("abort", () => resolve());
            });
          },
        }),
      } as unknown as LLMProviderFactory;
      const tools = new ToolRegistry([makeTool("FakeTool")]);
      const agent = new Agent({
        config: new StaticConfigProvider(VALID_CONFIG),
        llmFactory: factory,
        tools,
        history: new InMemoryChatHistory(),
        events: new InMemoryEventBus<AgentEvent>(),
        systemPrompt: new DefaultSystemPromptBuilder(() => tools.definitions(), () => "/w"),
        log: (m) => logs.push(m),
      });

      const sendPromise = agent.send("x").catch(() => {});
      await vi.advanceTimersByTimeAsync(15000);
      expect(logs.some((l) => /^stream: waiting 1[0-9]s/.test(l))).toBe(true);

      agent.abort();
      await sendPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs a stop line when it gives up on a loop", async () => {
    const logs: string[] = [];
    const empty: StreamChunk[] = [];
    const { agent } = buildHarness({ chunks: [empty], log: (m) => logs.push(m) });
    await agent.send("x");
    expect(logs.some((l) => /^loop-stop \[empty\]/.test(l))).toBe(true);
  });

  it("emits preview_ready when Analyze prepared changes (nothing applied)", async () => {
    const { agent, events } = buildHarness({
      tools: [makeTool("Edit")],
      chunks: [
        [
          { type: "tool_call_start", index: 0, id: "c", name: "Edit" },
          { type: "tool_call_delta", index: 0, delta: '{"path":"a.ts","edits":[]}' },
          { type: "tool_call_end", index: 0 },
        ],
        [{ type: "text", content: "done" }],
      ],
    });

    await agent.send("fix it");

    expect(events.some((e) => e.type === "preview_ready")).toBe(true);
  });

  it("does NOT emit preview_ready when nothing was prepared", async () => {
    const { agent, events } = buildHarness({ chunks: [[{ type: "text", content: "answer" }]] });
    await agent.send("a question");
    expect(events.some((e) => e.type === "preview_ready")).toBe(false);
  });

  it("emits preview_ready + flags the message even when the model wrote its OWN switch line", async () => {
    const { agent, events, history } = buildHarness({
      tools: [makeTool("Edit")],
      chunks: [
        [
          { type: "tool_call_start", index: 0, id: "c", name: "Edit" },
          { type: "tool_call_delta", index: 0, delta: '{"path":"a.ts","edits":[]}' },
          { type: "tool_call_end", index: 0 },
        ],
        [{ type: "text", content: "Done.\n\n➡️ Switch to **Build** to apply the changes." }],
      ],
    });

    await agent.send("fix it");

    expect(events.some((e) => e.type === "preview_ready")).toBe(true);
    const final = history.all().filter((m) => m.role === "assistant").at(-1);
    expect(final?.previewPrepared).toBe(true);
  });

  it("reports a real file change via onFileChanged only in Build (not on Analyze previews)", async () => {
    const writeChunks: StreamChunk[][] = [
      [
        { type: "tool_call_start", index: 0, id: "c", name: "Write" },
        { type: "tool_call_delta", index: 0, delta: '{"path":"a.ts","contents":"x"}' },
        { type: "tool_call_end", index: 0 },
      ],
      [{ type: "text", content: "done" }],
    ];

    // Build: a real write fires onFileChanged.
    const changes: { path: string; tool: string }[] = [];
    const { agent } = buildHarness({
      tools: [makeTool("Write")],
      chunks: writeChunks,
      onFileChanged: (c) => changes.push(c),
    });
    agent.setMode("agent");
    await agent.send("write it");
    expect(changes).toEqual([{ path: "a.ts", tool: "Write" }]);

    // Analyze: the same tool runs as a PREVIEW → no file-change event.
    const previews: { path: string; tool: string }[] = [];
    const { agent: a2 } = buildHarness({
      tools: [makeTool("Write")],
      chunks: writeChunks,
      onFileChanged: (c) => previews.push(c),
    });
    await a2.send("write it"); // default = Analyze
    expect(previews).toEqual([]);
  });

  it("emits a loop_intervention event when it breaks a loop", async () => {
    const repeated = (): StreamChunk[] => [
      { type: "tool_call_start", index: 0, id: "c", name: "Shell" },
      { type: "tool_call_delta", index: 0, delta: '{"command":"ls"}' },
      { type: "tool_call_end", index: 0 },
    ];
    const { agent, events } = buildHarness({
      tools: [makeTool("Shell")],
      chunks: [repeated(), repeated(), repeated(), [{ type: "text", content: "ok" }]],
    });

    await agent.send("x");

    const intervention = events.find((e) => e.type === "loop_intervention");
    expect(intervention).toBeTruthy();
    if (intervention && intervention.type === "loop_intervention") {
      expect(intervention.loopType).toBe("tool-repeat");
      expect(intervention.level).toBe(1);
      expect(intervention.message.length).toBeGreaterThan(0);
    }
  });

  it("refuses to re-run an identical failing call, nudges, then stops", async () => {
    const failingTool = makeTool("Read", { content: "boom", isError: true });
    const { agent, factory, events, history } = buildHarness({
      tools: [failingTool],
      chunks: [
        [{ type: "tool_call_start", index: 0, id: "c1", name: "Read" }, { type: "tool_call_end", index: 0 }],
        [{ type: "tool_call_start", index: 0, id: "c2", name: "Read" }, { type: "tool_call_end", index: 0 }],
        [{ type: "tool_call_start", index: 0, id: "c3", name: "Read" }, { type: "tool_call_end", index: 0 }],
      ],
      maxTurns: 8,
    });

    await agent.send("x");

    // The failing call runs ONCE, then identical repeats are REFUSED; the guard
    // nudges twice and stops on the third repeated failure (4 LLM turns).
    expect(factory.calls).toBe(4);
    const error = events.find((e) => e.type === "error");
    const message = error && error.type === "error" ? error.error : "";
    expect(message).toContain("Loop not resolved");
    expect(message).toContain("tool-failure");
    expect(history.all().some((m) => m.role === "user" && /SAME arguments/.test(m.content))).toBe(true);
    const refused = history.all().filter((m) => m.role === "tool" && /already failed and was NOT re-run/.test(m.content));
    expect(refused.length).toBeGreaterThanOrEqual(2);
  });

  it("nudges then stops after consecutive all-error turns with DIFFERENT tools", async () => {
    const tools = ["Read", "Write", "Grep", "Glob", "Shell"].map((n) =>
      makeTool(n, { content: `err ${n}`, isError: true }),
    );
    const call = (name: string): StreamChunk[] => [
      { type: "tool_call_start", index: 0, id: `c-${name}`, name },
      { type: "tool_call_end", index: 0 },
    ];
    const { agent, factory, events } = buildHarness({
      tools,
      chunks: tools.map((t) => call(t.name)),
      maxTurns: 8,
    });

    await agent.send("x");

    // Distinct calls each turn → the error STREAK drives escalation: nudge at 3,
    // nudge at 4, stop at 5.
    expect(factory.calls).toBe(5);
    const error = events.find((e) => e.type === "error");
    const message = error && error.type === "error" ? error.error : "";
    expect(message).toContain("Loop not resolved");
    expect(message).toContain("error-streak");
  });

  it("does not treat different arguments as the same failing call (uses the error streak)", async () => {
    const failingTool = makeTool("Read", { content: "boom", isError: true });
    const read = (p: string): StreamChunk[] => [
      { type: "tool_call_start", index: 0, id: `c-${p}`, name: "Read" },
      { type: "tool_call_delta", index: 0, delta: JSON.stringify({ path: p }) },
      { type: "tool_call_end", index: 0 },
    ];
    const { agent, factory, events, history } = buildHarness({
      tools: [failingTool],
      chunks: [read("a.ts"), read("b.ts"), read("c.ts"), read("d.ts"), read("e.ts")],
      maxTurns: 8,
    });

    await agent.send("x");

    // Different arguments each turn: the SAME-call tool-failure guard never
    // fires; the error STREAK is what stops the loop.
    expect(history.all().some((m) => m.role === "user" && /SAME arguments/.test(m.content))).toBe(false);
    const error = events.find((e) => e.type === "error");
    const message = error && error.type === "error" ? error.error : "";
    expect(message).toContain("Loop not resolved");
    expect(message).toContain("error-streak");
    expect(factory.calls).toBe(5);
  });

  it("nudges twice, then stops when the same successful tool call keeps repeating", async () => {
    const { agent, factory, events, history } = buildHarness({
      chunks: [
        [{ type: "tool_call_start", index: 0, id: "c1", name: "FakeTool" }, { type: "tool_call_end", index: 0 }],
        [{ type: "tool_call_start", index: 0, id: "c2", name: "FakeTool" }, { type: "tool_call_end", index: 0 }],
        [{ type: "tool_call_start", index: 0, id: "c3", name: "FakeTool" }, { type: "tool_call_end", index: 0 }],
      ],
      maxTurns: 8,
    });

    await agent.send("x");

    // 3 identical calls → nudge; a 4th → second nudge; a 5th → stop (5 turns).
    expect(factory.calls).toBe(5);
    expect(history.all().some((m) => m.role === "user" && /SAME tool/.test(m.content ?? ""))).toBe(true);
    const error = events.find((e) => e.type === "error");
    expect(error && error.type === "error" ? error.error : "").toContain("Loop not resolved");
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

  it("advertises the SAME tool set in both modes; Analyze tags Shell read-only and writers as previews", async () => {
    const tools = ["Read", "Write", "Edit", "Delete", "StrReplace", "Shell", "Grep"].map((n) =>
      ({ name: n, definition: { name: n, description: n, parameters: { type: "object", properties: {} } }, execute: async () => ({ content: "ok", isError: false }) }) as Tool,
    );
    const { agent, seenDefinitions } = capturingHarness(tools);

    await agent.send("analyze this"); // default mode = analyze
    // Writers are NOT hidden: they are available as validated previews.
    expect(seenDefinitions[0].map((d) => d.name).sort()).toEqual([...tools.map((t) => t.name)].sort());
    expect(seenDefinitions[0].find((d) => d.name === "Shell")!.description).toContain("READ-ONLY");
    expect(seenDefinitions[0].find((d) => d.name === "Write")!.description).toContain("PREVIEW MODE");

    agent.setMode("agent");
    await agent.send("now edit it");
    expect(seenDefinitions[1].map((d) => d.name).sort()).toEqual([...tools.map((t) => t.name)].sort());
    expect(seenDefinitions[1].find((d) => d.name === "Write")!.description).not.toContain("PREVIEW MODE");
  });

  it("runs file-mutating tool calls in analyze as DRY-RUN previews (never applied)", async () => {
    const writeTool = {
      ...makeTool("Write"),
      execute: vi.fn(async (): Promise<ToolResult> => ({ content: "PROPOSED (preview — NOT written): a.txt", isError: false })),
    };
    const { agent, history } = capturingHarness(
      [writeTool],
      [toolCallChunks("Write", '{"path":"a.txt","content":"x"}'), [{ type: "text", content: "ok" }]],
    );

    await agent.send("write a file");

    // The tool RUNS, but with the dryRun context — it must not touch disk.
    expect(writeTool.execute as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.objectContaining({ path: "a.txt" }),
      expect.objectContaining({ dryRun: true, signal: expect.anything() }),
    );
    const toolResult = history.all().find((m) => m.role === "tool");
    expect(toolResult?.content).toContain("PROPOSED");
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
    // Agent mode = real write: NO dryRun context (only the run signal).
    expect(writeTool.execute as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.objectContaining({ path: "a.txt" }),
      expect.not.objectContaining({ dryRun: true }),
    );
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

  it("appends an explicit 'nothing applied / switch to Build' footer when previews were prepared", async () => {
    const { agent, history } = capturingHarness(
      [makeTool("Edit"), makeTool("Read")],
      [
        toolCallChunks("Edit", '{"path":"a.ts","edits":[{"oldText":"x","newText":"y"}]}'),
        [{ type: "text", content: "I fixed the bug for you." }],
      ],
      "analyze",
    );

    await agent.send("fix it");

    const final = history.all().filter((m) => m.role === "assistant").at(-1);
    expect(final?.content).toContain("I fixed the bug for you.");
    expect(final?.content).toContain("Nothing has been applied");
    expect(final?.content).toContain("previews");
    expect(final?.content).toContain("Switch to **Build**");
  });

  it("lists WHAT needs Build in the preview footer", async () => {
    const { agent, history } = capturingHarness(
      [makeTool("Edit"), makeTool("Write")],
      [
        toolCallChunks("Edit", '{"path":"src/a.ts","edits":[]}'),
        toolCallChunks("Write", '{"path":"src/b.ts","contents":"x"}'),
        [{ type: "text", content: "Prepared the changes." }],
      ],
      "analyze",
    );

    await agent.send("do it");

    const final = history.all().filter((m) => m.role === "assistant").at(-1);
    expect(final?.content).toContain("Edit `src/a.ts`");
    expect(final?.content).toContain("Write `src/b.ts`");
    expect(final?.content).toContain("Switch to **Build**");
  });

  it("does not duplicate the footer when the model already told the user to switch", async () => {
    const { agent, history } = capturingHarness(
      [makeTool("Edit")],
      [
        toolCallChunks("Edit", '{"path":"a.ts","edits":[{"oldText":"x","newText":"y"}]}'),
        [{ type: "text", content: `Done.\n\n${BUILD_SWITCH_HINT}` }],
      ],
      "analyze",
    );

    await agent.send("fix it");

    const final = history.all().filter((m) => m.role === "assistant").at(-1);
    const occurrences = (final?.content.match(/Switch to \*\*Build\*\*/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("does not add the preview footer in Build mode", async () => {
    const { agent, history } = capturingHarness(
      [makeTool("Edit")],
      [toolCallChunks("Edit", '{"path":"a.ts","edits":[]}'), [{ type: "text", content: "Applied the change." }]],
      "agent",
    );

    await agent.send("fix it");

    const final = history.all().filter((m) => m.role === "assistant").at(-1);
    expect(final?.content).toBe("Applied the change.");
  });

  it("drops a superfluous 'switch to Build' line when NO changes were prepared", async () => {
    const { agent, history } = capturingHarness(
      [makeTool("Read")],
      [
        [
          {
            type: "text",
            content: "Here is the comparison table.\n\nSwitch to Build to apply any changes if needed.",
          },
        ],
      ],
      "analyze",
    );

    await agent.send("compare these models");

    const final = history.all().filter((m) => m.role === "assistant").at(-1);
    expect(final?.content).toContain("Here is the comparison table.");
    expect(final?.content).not.toMatch(/switch to\s*\**build\**/i);
  });

  it("drops the switch line in Build mode too (it is never useful there)", async () => {
    const { agent, history } = capturingHarness(
      [makeTool("Read")],
      [[{ type: "text", content: "Answer.\n\nSwitch to **Build** to apply the changes." }]],
      "agent",
    );

    await agent.send("x");

    const final = history.all().filter((m) => m.role === "assistant").at(-1);
    expect(final?.content).toBe("Answer.");
  });

  it("sends a read-only system prompt in analyze and a full one after setMode('agent')", async () => {
    const { agent, seenSystemPrompts } = capturingHarness([makeTool("Read")]);

    await agent.send("analyze this");
    expect(seenSystemPrompts[0]).toContain("READ-ONLY MODE (Analyze)");

    agent.setMode("agent");
    await agent.send("now do it");
    expect(seenSystemPrompts[1]).not.toContain("READ-ONLY MODE (Analyze)");
  });

  it("switching back to analyze re-tags the tool definitions as read-only previews", async () => {
    const tools = ["Read", "Write", "Shell"].map((n) =>
      ({ name: n, definition: { name: n, description: n, parameters: { type: "object", properties: {} } }, execute: async () => ({ content: "ok", isError: false }) }) as Tool,
    );
    const { agent, seenDefinitions } = capturingHarness(tools, undefined, "agent");

    await agent.send("full mode");
    expect(seenDefinitions[0].find((d) => d.name === "Write")!.description).not.toContain("PREVIEW MODE");
    expect(seenDefinitions[0].find((d) => d.name === "Shell")!.description).not.toContain("READ-ONLY");

    agent.setMode("analyze"); // back to read-only preview
    await agent.send("analyze again");
    expect(seenDefinitions[1].find((d) => d.name === "Write")!.description).toContain("PREVIEW MODE");
    expect(seenDefinitions[1].find((d) => d.name === "Shell")!.description).toContain("READ-ONLY");
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

  /** Agent with a capturing spawnSubAgent (records every Delegate spec it gets). */
  function capturingAgent(chunks: StreamChunk[][], sink: DelegateSpec[]): Agent {
    const factory = fakeFactory(...chunks);
    const tools = new ToolRegistry([makeTool("Delegate"), makeTool("Read")]);
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: factory,
      tools,
      history: new InMemoryChatHistory(),
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(() => tools.definitions(), () => "/w"),
      spawnSubAgent: async (spec) => {
        sink.push(spec);
        return { content: "r", isError: false };
      },
    });
    agent.setMode("agent");
    agent.setDelegation(true);
    return agent;
  }

  function build(opts: {
    calls: Array<Record<string, unknown>>;
    mode?: "analyze" | "agent";
    allowDelegation?: boolean;
    maxParallel?: number;
    delegate?: boolean;
    spawn?: (
      spec: DelegateSpec,
      onEvent?: (e: SubAgentEvent) => void,
      signal?: AbortSignal,
      toolCallId?: string,
      onPreviewPrepared?: (change: { path: string; tool: string }) => void,
    ) => Promise<ToolResult>;
    abortSubAgent?: (toolCallId: string) => void;
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
      abortSubAgent: opts.abortSubAgent,
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

  it("shows the Switch to Build CTA for DELEGATED previews (sub-agent bubbles it up)", async () => {
    const { agent, history, eventLog } = build({
      calls: [{ id: "A", goal: "edit x", access: "read", resources: ["src/a.ts"] }],
      mode: "analyze",
      spawn: async (_spec, _onEvent, _signal, _toolCallId, onPreviewPrepared) => {
        onPreviewPrepared?.({ path: "src/a.ts", tool: "Edit" });
        return { content: "🔁 report A", isError: false };
      },
    });

    await agent.send("go");

    const final = history.all().filter((m) => m.role === "assistant").at(-1);
    expect(final?.previewPrepared).toBe(true);
    expect(eventLog.some((e) => e.type === "preview_ready")).toBe(true);
    // The footer LISTS the file prepared by the sub-agent (not an empty list).
    expect(final?.content).toContain("src/a.ts");
  });

  it("a repeated read-only Delegate is RE-RUN, never served from the loop-guard cache", async () => {
    let spawned = 0;
    const dArgs = { id: "A", goal: "analyze x", access: "read", resources: [] };
    const factory = fakeFactory(delegateTurn([dArgs]), delegateTurn([dArgs]), [{ type: "text", content: "done" }]);
    const tools = new ToolRegistry([makeTool("Delegate")]);
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: factory,
      tools,
      history: new InMemoryChatHistory(),
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(() => tools.definitions(), () => "/w"),
      spawnSubAgent: async () => {
        spawned++;
        return { content: "r", isError: false };
      },
    });
    agent.setMode("agent");
    agent.setDelegation(true);

    await agent.send("go");

    // The SAME read-only Delegate twice must run TWICE: a Delegate is
    // side-effecting/non-deterministic, so the guard must not cache it.
    expect(spawned).toBe(2);
  });

  it("an INVALID Delegate just returns an error (no delegate-first restriction)", async () => {
    const spawned: DelegateSpec[] = [];
    const readCall: StreamChunk[] = [
      { type: "tool_call_start", index: 0, id: "r0", name: "Read" },
      { type: "tool_call_delta", index: 0, delta: '{"path":"a.ts"}' },
      { type: "tool_call_end", index: 0 },
    ];
    const factory = fakeFactory(
      delegateTurn([{ goal: "missing access" }]), // invalid: no `access`
      readCall,
      delegateTurn([{ id: "A", goal: "g", access: "read", resources: [] }]),
      [{ type: "text", content: "done" }],
    );
    const tools = new ToolRegistry([makeTool("Delegate"), makeTool("Read")]);
    const history = new InMemoryChatHistory();
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: factory,
      tools,
      history,
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(() => tools.definitions(), () => "/w"),
      spawnSubAgent: async (spec) => {
        spawned.push(spec);
        return { content: "r", isError: false };
      },
    });
    agent.setMode("agent");
    agent.setDelegation(true);

    await agent.send("go");

    // Nothing is blocked now: the invalid Delegate returned an error, the model
    // read a file with its own tool, then delegated successfully.
    expect(history.all().some((m) => m.role === "tool" && /Blocked/.test(m.content))).toBe(false);
    expect(spawned).toHaveLength(1);
  });

  it("Parallel ON: a direct answer (no tools) is accepted — no forced sub-agent", async () => {
    const spawned: DelegateSpec[] = [];
    const history = new InMemoryChatHistory();
    const factory = fakeFactory([{ type: "text", content: "here is your answer" }]);
    const tools = new ToolRegistry([makeTool("Read")]);
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: factory,
      tools,
      history,
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(() => tools.definitions(), () => "/w"),
      spawnSubAgent: async (spec) => {
        spawned.push(spec);
        return { content: "report", isError: false };
      },
    });
    agent.setMode("agent");
    agent.setDelegation(true);

    await agent.send("what is 2+2");

    // A pure question is answered directly: no sub-agent, no "you must delegate" nudge.
    expect(spawned).toHaveLength(0);
    expect(history.all().some((m) => m.role === "user" && m.harness)).toBe(false);
    expect(history.all().some((m) => m.role === "assistant" && m.content === "here is your answer")).toBe(true);
  });

  it("Parallel ON: the FULL tool set is advertised from the first turn (plus Delegate)", async () => {
    const seenDefs: ToolDefinition[][] = [];
    let call = 0;
    const factory: LLMProviderFactory = {
      create() {
        return {
          protocol: "chat" as const,
          async *stream(_m: LLMMessage[], _s?: AbortSignal, defs?: ToolDefinition[]) {
            if (defs) seenDefs.push(defs);
            call++;
            if (call === 1) {
              yield* delegateTurn([{ id: "web", goal: "g", access: "read", resources: ["."] }]);
            } else {
              yield { type: "text", content: "done" };
            }
          },
        };
      },
    };
    const tools = new ToolRegistry([makeTool("Delegate"), makeTool("Read"), makeTool("WebSearch")]);
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: factory,
      tools,
      history: new InMemoryChatHistory(),
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(() => tools.definitions(), () => "/w"),
      spawnSubAgent: async () => ({ content: "r", isError: false }),
    });
    agent.setMode("agent");
    agent.setDelegation(true);

    await agent.send("x");

    // From the FIRST turn the FULL tool set is advertised: the model may work
    // directly AND delegate — there is no "delegate-first" restriction.
    expect(seenDefs[0].map((d) => d.name).sort()).toEqual(["Delegate", "Read", "WebSearch"].sort());
    expect(seenDefs[1].map((d) => d.name).sort()).toEqual(["Delegate", "Read", "WebSearch"].sort());
  });

  it("Parallel ON: the model MAY use its own tools first (no blocking) and still delegates", async () => {
    const web = makeTool("WebSearch", { content: "search result", isError: false });
    const spawned: DelegateSpec[] = [];
    const history = new InMemoryChatHistory();
    const webCall: StreamChunk[] = [
      { type: "tool_call_start", index: 0, id: "w1", name: "WebSearch" },
      { type: "tool_call_delta", index: 0, delta: '{"query":"q"}' },
      { type: "tool_call_end", index: 0 },
    ];
    const factory = fakeFactory(
      webCall,
      delegateTurn([{ id: "web", goal: "search the models", access: "read", resources: ["./"] }]),
      [{ type: "text", content: "final" }],
    );
    const tools = new ToolRegistry([web]);
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: factory,
      tools,
      history,
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(() => tools.definitions(), () => "/w"),
      spawnSubAgent: async (spec) => {
        spawned.push(spec);
        return { content: "report", isError: false };
      },
    });
    agent.setMode("agent");
    agent.setDelegation(true);

    await agent.send("dammi dati su 3 modelli");

    // The WebSearch RAN (not blocked), the model then delegated, and no
    // "delegate-first" nudge was injected.
    expect(web.called).toBe(true);
    expect(history.all().some((m) => m.role === "user" && /ONLY move now is the Delegate/.test(m.content))).toBe(false);
    expect(spawned).toHaveLength(1);
  });

  it("Parallel OFF: no mandatory-delegation nudge", async () => {
    const history = new InMemoryChatHistory();
    const factory = fakeFactory([{ type: "text", content: "answer" }]);
    const tools = new ToolRegistry([makeTool("Read")]);
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: factory,
      tools,
      history,
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(() => tools.definitions(), () => "/w"),
      spawnSubAgent: async () => ({ content: "r", isError: false }),
    });
    agent.setMode("agent");
    agent.setDelegation(false);

    await agent.send("x");

    expect(factory.calls).toBe(1);
    expect(history.all().some((m) => m.role === "user" && /MANDATORY/.test(m.content))).toBe(false);
  });

  it("forwards ONLY the attachments the Delegate selects to each sub-agent", async () => {
    const seen: DelegateSpec[] = [];
    const factory = fakeFactory(
      delegateTurn([{ id: "a", goal: "describe doc 2", access: "read", resources: ["."], attachments: [2] }]),
      [{ type: "text", content: "done" }],
    );
    const tools = new ToolRegistry([makeTool("Delegate"), makeTool("Read")]);
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: factory,
      tools,
      history: new InMemoryChatHistory(),
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(() => tools.definitions(), () => "/w"),
      spawnSubAgent: async (spec) => {
        seen.push(spec);
        return { content: "report", isError: false };
      },
    });
    agent.setMode("agent");
    agent.setDelegation(true);

    await agent.send("describe the docs", {
      attachmentParts: [
        { name: "doc1.txt", isImage: false, text: "CONTENT ONE" },
        { name: "doc2.txt", isImage: false, text: "CONTENT TWO" },
      ],
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].attachmentText).toContain("CONTENT TWO");
    expect(seen[0].attachmentText).not.toContain("CONTENT ONE");
  });

  it("forwards ALL attachments when the Delegate selects none", async () => {
    const seen: DelegateSpec[] = [];
    const factory = fakeFactory(
      delegateTurn([{ id: "a", goal: "describe docs", access: "read", resources: ["."] }]),
      [{ type: "text", content: "done" }],
    );
    const tools = new ToolRegistry([makeTool("Delegate"), makeTool("Read")]);
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: factory,
      tools,
      history: new InMemoryChatHistory(),
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(() => tools.definitions(), () => "/w"),
      spawnSubAgent: async (spec) => {
        seen.push(spec);
        return { content: "report", isError: false };
      },
    });
    agent.setMode("agent");
    agent.setDelegation(true);

    await agent.send("describe the docs", {
      attachmentParts: [
        { name: "doc1.txt", isImage: false, text: "CONTENT ONE" },
        { name: "doc2.txt", isImage: false, text: "CONTENT TWO" },
      ],
    });

    expect(seen[0].attachmentText).toContain("CONTENT ONE");
    expect(seen[0].attachmentText).toContain("CONTENT TWO");
  });

  it("forwards a selected image attachment as multimodal data URI", async () => {
    const seen: DelegateSpec[] = [];
    const factory = fakeFactory(
      delegateTurn([{ id: "a", goal: "read image", access: "read", resources: ["."], attachments: [1] }]),
      [{ type: "text", content: "done" }],
    );
    const tools = new ToolRegistry([makeTool("Delegate"), makeTool("Read")]);
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: factory,
      tools,
      history: new InMemoryChatHistory(),
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(() => tools.definitions(), () => "/w"),
      spawnSubAgent: async (spec) => {
        seen.push(spec);
        return { content: "report", isError: false };
      },
    });
    agent.setMode("agent");
    agent.setDelegation(true);

    await agent.send("look", {
      attachmentParts: [{ name: "img.png", isImage: true, dataUri: "data:image/png;base64,ZZZ" }],
    });

    expect(seen[0].images).toEqual(["data:image/png;base64,ZZZ"]);
  });

  it("Parallel: 2 docs → 2 sub-agents, each gets ONLY its own attachment", async () => {
    const seen: DelegateSpec[] = [];
    const agent = capturingAgent(
      [
        delegateTurn([
          { id: "doc1", goal: "describe doc 1", access: "read", resources: ["./"], attachments: [1] },
          { id: "doc2", goal: "describe doc 2", access: "read", resources: ["./"], attachments: [2] },
        ]),
        [{ type: "text", content: "done" }],
      ],
      seen,
    );

    await agent.send("describe the 2 docs", {
      attachmentParts: [
        { name: "doc1.txt", isImage: false, text: "CONTENT ONE" },
        { name: "doc2.txt", isImage: false, text: "CONTENT TWO" },
      ],
    });

    const byId = Object.fromEntries(seen.map((s) => [s.id, s]));
    expect(byId["doc1"].attachmentText).toContain("CONTENT ONE");
    expect(byId["doc1"].attachmentText).not.toContain("CONTENT TWO");
    expect(byId["doc2"].attachmentText).toContain("CONTENT TWO");
    expect(byId["doc2"].attachmentText).not.toContain("CONTENT ONE");
  });

  it("does not leak the previous message's attachments into the next send", async () => {
    const seen: DelegateSpec[] = [];
    const agent = capturingAgent(
      [
        delegateTurn([{ id: "a", goal: "g", access: "read", resources: ["./"] }]),
        [{ type: "text", content: "done" }],
        delegateTurn([{ id: "b", goal: "g2", access: "read", resources: ["./"] }]),
        [{ type: "text", content: "done2" }],
      ],
      seen,
    );

    await agent.send("first", { attachmentParts: [{ name: "secret.txt", isImage: false, text: "SECRET" }] });
    await agent.send("second"); // no attachments this time

    expect(seen[0].id).toBe("a");
    expect(seen[0].attachmentText).toContain("SECRET");
    expect(seen[1].id).toBe("b");
    expect(seen[1].attachmentText ?? "").not.toContain("SECRET");
  });

  it("falls back to ALL attachments when the Delegate selects invalid numbers", async () => {
    const seen: DelegateSpec[] = [];
    const agent = capturingAgent(
      [
        delegateTurn([{ id: "a", goal: "g", access: "read", resources: ["./"], attachments: [99] }]),
        [{ type: "text", content: "done" }],
      ],
      seen,
    );

    await agent.send("x", {
      attachmentParts: [
        { name: "doc1.txt", isImage: false, text: "ONE" },
        { name: "doc2.txt", isImage: false, text: "TWO" },
      ],
    });

    expect(seen[0].attachmentText).toContain("ONE");
    expect(seen[0].attachmentText).toContain("TWO");
  });

  it("forwards attachments on an attachment-only send (no text)", async () => {
    const seen: DelegateSpec[] = [];
    const agent = capturingAgent(
      [
        delegateTurn([{ id: "a", goal: "analyze", access: "read", resources: ["./"] }]),
        [{ type: "text", content: "done" }],
      ],
      seen,
    );

    await agent.send("", {
      displayText: "look at this",
      attachmentParts: [{ name: "d.txt", isImage: false, text: "HELLO" }],
    });

    expect(seen[0].attachmentText).toContain("HELLO");
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
    const offTools = seen[0].flatMap((m) => (m.toolCalls ?? []).map((t) => t.name)).join("|");
    const offContent = seen[0].map((m) => m.content ?? "").join("|");
    expect(offTools).not.toContain("Delegate");
    expect(offContent).not.toContain("report");

    agent.setDelegation(true);
    await agent.send("now2");
    const onTools = seen[1].flatMap((m) => (m.toolCalls ?? []).map((t) => t.name)).join("|");
    expect(onTools).toContain("Delegate");
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

  it("runs writers on DISJOINT files in parallel", async () => {
    let running = 0;
    let max = 0;
    const spawn = async (): Promise<ToolResult> => {
      running++;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return { content: "r", isError: false };
    };
    const { agent } = build({
      calls: [
        { id: "A", goal: "a", access: "write", resources: ["a.ts"] },
        { id: "B", goal: "b", access: "create", resources: ["b.ts"] },
      ],
      mode: "agent",
      spawn,
    });

    await agent.send("go");

    expect(max).toBe(2); // two writers on different files run together
  });

  it("serializes two writers that share the same file", async () => {
    const order: string[] = [];
    const spawn = async (spec: DelegateSpec): Promise<ToolResult> => {
      order.push("start:" + spec.id);
      await new Promise((r) => setTimeout(r, 5));
      order.push("end:" + spec.id);
      return { content: "r", isError: false };
    };
    const { agent } = build({
      calls: [
        { id: "A", goal: "a", access: "write", resources: ["a.ts"] },
        { id: "B", goal: "b", access: "write", resources: ["a.ts"] },
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

  it("a per-session cap overrides the config default (setMaxParallelSubAgents)", async () => {
    let running = 0;
    let max = 0;
    const spawn = async (): Promise<ToolResult> => {
      running++;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return { content: "r", isError: false };
    };
    const calls = ["A", "B", "C"].map((id, i) => ({ id, goal: id, access: "read", resources: [`${i}.ts`], parallel: "yes" }));
    // Config says 2, but the session override serializes to 1.
    const { agent } = build({ calls, maxParallel: 2, spawn });
    agent.setMaxParallelSubAgents(1);

    await agent.send("go");

    expect(max).toBe(1);
  });

  it("defaults to a cap of 4 when neither the session nor the config sets one", async () => {
    let running = 0;
    let max = 0;
    const spawn = async (): Promise<ToolResult> => {
      running++;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return { content: "r", isError: false };
    };
    const calls = ["A", "B", "C", "D", "E", "F"].map((id, i) => ({ id, goal: id, access: "read", resources: [`${i}.ts`], parallel: "yes" }));
    const { agent } = build({ calls, spawn }); // no maxParallel in the config

    await agent.send("go");

    expect(max).toBe(4);
  });

  it("a per-session cap of 0 removes the limit", async () => {
    let running = 0;
    let max = 0;
    const spawn = async (): Promise<ToolResult> => {
      running++;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return { content: "r", isError: false };
    };
    const calls = ["A", "B", "C", "D", "E", "F"].map((id, i) => ({ id, goal: id, access: "read", resources: [`${i}.ts`], parallel: "yes" }));
    const { agent } = build({ calls, maxParallel: 2, spawn });
    agent.setMaxParallelSubAgents(0); // explicit no cap

    await agent.send("go");

    expect(max).toBe(6);
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

  it("prepends an ALWAYS-present state banner (mode + Parallel) to every turn", async () => {
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
    const tools = new ToolRegistry([makeTool("Read")]);
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

    agent.setMode("analyze");
    agent.setDelegation(false);
    await agent.send("a");
    expect(seen[0]).toContain("[CURRENT STATE]");
    expect(seen[0]).toContain("Analyze — READ-ONLY");
    // Parallel OFF: the banner says NOTHING about sub-tasks / Parallel.
    expect(seen[0]).not.toContain("Parallel");

    agent.setMode("agent");
    agent.setDelegation(true);
    await agent.send("b");
    expect(seen[1]).toContain("Build");
    expect(seen[1]).toContain("PARALLELISM MEANS SUB-TASKS");
  });

  it("REAL runner: sub-agents run concurrently up to maxParallelSubAgents", async () => {
    let running = 0;
    let max = 0;
    // Each sub-agent makes ONE stream call (a text-only turn); tracking that
    // call measures how many sub-agents run at the same time.
    const subFactory: LLMProviderFactory = {
      create() {
        return {
          protocol: "chat" as const,
          async *stream() {
            running++;
            max = Math.max(max, running);
            await new Promise((r) => setTimeout(r, 15));
            running--;
            yield { type: "text", content: "sub report" };
          },
        };
      },
    };
    const runner = new SubAgentRunner({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: subFactory,
      tools: new ToolRegistry([makeTool("Read")]),
      cwd: () => "/w",
    });
    const calls = ["A", "B", "C", "D", "E"].map((id, i) => ({
      id,
      goal: id,
      access: "read",
      resources: [`${i}.ts`],
    }));
    const { agent } = build({ calls, maxParallel: 2, spawn: (spec, onEvent) => runner.run(spec, onEvent) });

    await agent.send("go");

    // Two sub-agents must be running at the same time (cap = 2).
    expect(max).toBe(2);
  });

  it("REAL runner on abort: running and queued sub-agents both report aborted", async () => {
    const started: string[] = [];
    let agentRef: Agent;
    // A sub-agent hangs until aborted (so B stays queued behind cap 1).
    const hanging: LLMProviderFactory = {
      create() {
        return {
          protocol: "chat" as const,
          async *stream(_m: LLMMessage[], signal?: AbortSignal) {
            await new Promise<void>((resolve) => {
              if (signal?.aborted) return resolve();
              signal?.addEventListener("abort", () => resolve());
            });
          },
        };
      },
    };
    const runner = new SubAgentRunner({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: hanging,
      tools: new ToolRegistry([makeTool("Read")]),
      cwd: () => "/w",
    });
    const calls = ["A", "B"].map((id, i) => ({
      id,
      goal: id,
      access: "read",
      resources: [`${i}.ts`],
    }));
    const { agent, eventLog } = build({
      calls,
      maxParallel: 1,
      spawn: (spec, onEvent, signal) => {
        started.push(spec.id);
        if (spec.id === "A") agentRef.abort();
        return runner.run(spec, onEvent, signal);
      },
    });
    agentRef = agent;

    await agent.send("go");

    // Only A started; B stayed queued.
    expect(started).toEqual(["A"]);
    const outputs = eventLog
      .filter((e) => e.type === "tool_result")
      .map((e) => (e as { toolResult: { output: string } }).toolResult.output);
    expect(outputs.some((o) => /Sub-agent "A" aborted/i.test(o))).toBe(true); // A (running)
    expect(outputs.some((o) => /aborted before running/i.test(o))).toBe(true); // B (queued)
  });

  it("abortSubAgent stops ONE running sub-agent; the orchestrator is told it was interrupted", async () => {
    const started: string[] = [];
    let agentRef: Agent;
    // Each sub-agent runs until aborted (or a short delay), then reports.
    const subFactory: LLMProviderFactory = {
      create() {
        return {
          protocol: "chat" as const,
          async *stream(_m: LLMMessage[], signal?: AbortSignal) {
            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, 30);
              signal?.addEventListener("abort", () => {
                clearTimeout(t);
                resolve();
              });
            });
            if (signal?.aborted) return;
            yield { type: "text", content: "sub report" };
          },
        };
      },
    };
    const runner = new SubAgentRunner({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: subFactory,
      tools: new ToolRegistry([makeTool("Read")]),
      cwd: () => "/w",
    });
    const calls = [
      { id: "A", goal: "A", access: "read", resources: ["a.ts"] },
      { id: "B", goal: "B", access: "read", resources: ["b.ts"] },
    ];
    const { agent, eventLog, history } = build({
      calls,
      maxParallel: 2,
      abortSubAgent: (id) => runner.abort(id),
      spawn: (spec, onEvent, signal, toolCallId) => {
        started.push(spec.id);
        if (spec.id === "A") setTimeout(() => agentRef.abortSubAgent(toolCallId!), 5);
        return runner.run(spec, onEvent, signal, toolCallId);
      },
    });
    agentRef = agent;

    await agent.send("go");

    expect(started).toEqual(["A", "B"]);
    const outputs = eventLog
      .filter((e) => e.type === "tool_result")
      .map((e) => (e as { toolResult: { output: string } }).toolResult.output);
    // A was aborted, B finished normally.
    expect(outputs.some((o) => /Sub-agent "A" aborted/.test(o))).toBe(true);
    expect(outputs.some((o) => /Sub-agent "B" report/.test(o))).toBe(true);
    // The run continued to its final answer (it did NOT abort the whole run).
    expect(history.all().some((m) => m.role === "assistant" && m.content === "done")).toBe(true);
  });

  it("abortSubAgent on a still-QUEUED sub-agent skips it when its turn comes", async () => {
    const spawned: string[] = [];
    const release: (() => void)[] = [];
    let agentRef: Agent;
    const subFactory: LLMProviderFactory = {
      create() {
        return {
          protocol: "chat" as const,
          async *stream(_m: LLMMessage[], signal?: AbortSignal) {
            await new Promise<void>((resolve) => {
              release.push(resolve);
              signal?.addEventListener("abort", () => resolve());
            });
            if (signal?.aborted) return;
            yield { type: "text", content: "sub report" };
          },
        };
      },
    };
    const runner = new SubAgentRunner({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: subFactory,
      tools: new ToolRegistry([makeTool("Read")]),
      cwd: () => "/w",
    });
    const calls = [
      { id: "A", goal: "A", access: "read", resources: ["a.ts"] },
      { id: "B", goal: "B", access: "read", resources: ["b.ts"] },
    ];
    const { agent, eventLog } = build({
      calls,
      maxParallel: 1, // cap 1: B stays QUEUED behind A
      abortSubAgent: (id) => runner.abort(id),
      spawn: (spec, onEvent, signal, toolCallId) => {
        spawned.push(spec.id);
        return runner.run(spec, onEvent, signal, toolCallId);
      },
    });
    agentRef = agent;

    const send = agent.send("go");
    // Let A take the single slot, then abort the still-QUEUED B (tool call "d1").
    for (let i = 0; i < 50 && spawned.length < 1; i++) await new Promise((r) => setTimeout(r, 2));
    agentRef.abortSubAgent("d1");
    release.forEach((r) => r()); // let A finish and free the slot
    await send;

    expect(spawned).toEqual(["A"]); // B was never started
    const outputs = eventLog
      .filter((e) => e.type === "tool_result")
      .map((e) => (e as { toolResult: { output: string } }).toolResult.output);
    expect(outputs.some((o) => /Sub-agent "B" aborted/.test(o))).toBe(true);
  });

  it("clears pending per-sub-task aborts between runs (a late abort does not leak)", async () => {
    let spawned = 0;
    const tools = new ToolRegistry([makeTool("Read")]);
    const del = delegateTurn([{ id: "A", goal: "x", access: "read", resources: ["a.ts"] }]);
    const factory = fakeFactory(del, [{ type: "text", content: "done" }], del, [{ type: "text", content: "done" }]);
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: factory,
      tools,
      history: new InMemoryChatHistory(),
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(() => tools.definitions(), () => "/w"),
      spawnSubAgent: async () => {
        spawned++;
        return { content: "report", isError: false };
      },
    });
    agent.setMode("agent");
    agent.setDelegation(true);

    await agent.send("one");
    agent.abortSubAgent("d0"); // stray/late abort recorded AFTER run 1 ended
    await agent.send("two");

    // Run 2's Delegate "d0" still ran: the pending-abort set is per run.
    expect(spawned).toBe(2);
  });

  it("abortSubAgent with an empty id is a no-op and never skips the delegate", async () => {
    const spawned: string[] = [];
    const { agent } = build({
      calls: [{ id: "A", goal: "A", access: "read", resources: ["a.ts"] }],
      spawn: async (spec) => {
        spawned.push(spec.id);
        return { content: "report", isError: false };
      },
    });
    agent.abortSubAgent(""); // ignored
    await agent.send("go");
    expect(spawned).toEqual(["A"]);
  });

  it("rejects a WRITER delegate with missing resources without spawning", async () => {
    let spawned = 0;
    const { agent, history } = build({
      calls: [{ id: "A", goal: "x", access: "write" }],
      spawn: async () => {
        spawned++;
        return { content: "x", isError: false };
      },
    });

    await agent.send("go");

    expect(spawned).toBe(0);
    expect(history.all().find((m) => m.role === "tool")?.content).toContain("resources");
  });

  it("dedupes two IDENTICAL read-only delegates in the same turn (read cache)", async () => {
    const spawned: string[] = [];
    const { agent, history } = build({
      calls: [
        { id: "dup", goal: "same", access: "read", resources: [] },
        { id: "dup", goal: "same", access: "read", resources: [] },
      ],
      spawn: async (spec) => {
        spawned.push(spec.id);
        return { content: "report", isError: false };
      },
    });

    await agent.send("go");

    // Only ONE actually ran; the identical second was refused (already running).
    expect(spawned).toEqual(["dup"]);
    expect(history.all().some((m) => m.role === "tool" && /already running/i.test(m.content))).toBe(true);
  });

  it("spawns a READ-ONLY delegate with EMPTY resources (web research)", async () => {
    let spawned = 0;
    const { agent } = build({
      calls: [{ id: "milan", goal: "search Milan", access: "read", resources: [] }],
      spawn: async () => {
        spawned++;
        return { content: "🔁 report", isError: false };
      },
    });

    await agent.send("go");

    expect(spawned).toBe(1);
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
    expect(seen[0]).not.toContain("PARALLELISM");
    expect(seen[0]).not.toContain("sub-agent");

    // Parallel ON: the identity is stated and Delegate is advertised.
    agent.setDelegation(true);
    await agent.send("on");
    expect(seen[1]).toContain("PARALLELISM MEANS SUB-TASKS");
    expect(seen[1]).toContain("- Delegate:");
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
    expect(history.all().some((m) => /Loop not resolved/.test(m.content ?? ""))).toBe(true);
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
    expect(history.all().some((m) => /Loop not resolved/.test(m.content ?? ""))).toBe(false);
    expect(history.all().some((m) => /done via Glob/.test(m.content ?? ""))).toBe(true);
  });

  it("injects the corrective nudge at most twice per send", async () => {
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
    expect(nudges).toHaveLength(2);
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

describe("Agent soft steering", () => {
  const toolCall = (id = "c1"): StreamChunk[] => [
    { type: "tool_call_start", index: 0, id, name: "FakeTool" },
    { type: "tool_call_end", index: 0 },
  ];

  it("injects a steer at the next turn boundary, AFTER the tool result", async () => {
    const { agent, factory, history, events } = buildHarness({
      chunks: [toolCall(), [{ type: "text", content: "done" }]],
    });
    let steered = false;
    agent.onEvent((e) => {
      if (e.type === "tool_result" && !steered) {
        steered = true;
        agent.steer("s1", "actually use Rome");
      }
    });

    await agent.send("find Bologna and Florence");

    const msgs = history.all();
    const toolIdx = msgs.findIndex((m) => m.role === "tool");
    const steerIdx = msgs.findIndex((m) => m.steer);
    expect(steerIdx).toBeGreaterThan(toolIdx); // valid order: after the tool result
    expect(msgs[steerIdx].content).toBe("actually use Rome");
    // The model saw it on the NEXT request (2 LLM calls), and it is part of the
    // conversation sent to the LLM.
    expect(factory.calls).toBe(2);
    expect(history.conversation().some((m) => m.steer && m.content === "actually use Rome")).toBe(true);
    expect(events.some((e) => e.type === "steer_applied" && e.ids.includes("s1"))).toBe(true);
  });

  it("cancelSteer drops a queued steer before the boundary", async () => {
    const { agent, history } = buildHarness({
      chunks: [toolCall(), [{ type: "text", content: "done" }]],
    });
    agent.onEvent((e) => {
      if (e.type === "tool_result") {
        agent.steer("s1", "nope");
        agent.cancelSteer("s1");
      }
    });

    await agent.send("x");

    expect(history.all().some((m) => m.steer)).toBe(false);
  });

  it("ignores an empty steer", async () => {
    const { agent, history } = buildHarness({
      chunks: [toolCall(), [{ type: "text", content: "done" }]],
    });
    agent.onEvent((e) => {
      if (e.type === "tool_result") agent.steer("s1", "   ");
    });

    await agent.send("x");

    expect(history.all().some((m) => m.steer)).toBe(false);
  });

  it("carries images/attachments and marks the message as a steer", async () => {
    const { agent, history } = buildHarness({
      chunks: [toolCall(), [{ type: "text", content: "done" }]],
    });
    agent.onEvent((e) => {
      if (e.type === "tool_result") {
        agent.steer("s1", "inlined content", {
          displayText: "use this doc",
          images: ["data:image/png;base64,AAA"],
          attachments: [{ name: "a.png", path: "/tmp/a.png", size: 3, isImage: true }],
        });
      }
    });

    await agent.send("x");

    const steer = history.all().find((m) => m.steer)!;
    expect(steer.displayText).toBe("use this doc");
    expect(steer.images).toEqual(["data:image/png;base64,AAA"]);
    expect(steer.attachments?.[0].name).toBe("a.png");
  });

  it("does not leak a steer into a LATER run (cleared per run)", async () => {
    const { agent, history } = buildHarness({
      chunks: [
        toolCall(),
        [{ type: "text", content: "done" }],
        [{ type: "text", content: "second" }],
      ],
    });
    // Queue a steer that never reaches a boundary, then end the run.
    agent.onEvent((e) => {
      if (e.type === "done") agent.steer("late", "stranded");
    });

    await agent.send("first");
    const before = history.all().filter((m) => m.steer).length;
    await agent.send("second");

    expect(before).toBe(0);
    expect(history.all().filter((m) => m.steer).length).toBe(0);
  });
});

describe("Agent soft steering — fragility", () => {
  const toolCall = (id = "c1"): StreamChunk[] => [
    { type: "tool_call_start", index: 0, id, name: "FakeTool" },
    { type: "tool_call_end", index: 0 },
  ];

  it("MERGES multiple steers queued in the same turn into ONE user message", async () => {
    const { agent, history, events } = buildHarness({
      chunks: [toolCall(), [{ type: "text", content: "done" }]],
    });
    agent.onEvent((e) => {
      if (e.type === "tool_result") {
        agent.steer("a", "first correction");
        agent.steer("b", "second correction");
      }
    });

    await agent.send("x");

    const steers = history.all().filter((m) => m.steer);
    expect(steers.length).toBe(1); // a SINGLE merged user turn
    expect(steers[0].content).toBe("first correction\n\nsecond correction");
    // The event carries EVERY consumed id so the UI clears all drafts.
    const applied = events.find((e) => e.type === "steer_applied");
    expect(applied && applied.type === "steer_applied" ? applied.ids : []).toEqual(["a", "b"]);
  });

  it("carries a steer's attachments in BOTH the history entry and the event", async () => {
    const { agent, history, events } = buildHarness({
      chunks: [toolCall(), [{ type: "text", content: "done" }]],
    });
    const attachments = [{ name: "relazione.pdf", path: "/tmp/relazione.pdf", size: 42, isImage: false }];
    const images = ["data:image/png;base64,iVBORw0KGgo="];
    agent.onEvent((e) => {
      if (e.type === "tool_result") {
        agent.steer("s1", "guarda qui", { images, attachments, displayText: "guarda qui" });
      }
    });

    await agent.send("x");

    // The model already got them (this always worked)…
    const steer = history.all().find((m) => m.steer);
    expect(steer?.attachments).toEqual(attachments);
    expect(steer?.images).toEqual(images);
    // …and now the EVENT carries the same two fields, which is what the view
    // needs to render the live bubble with them.
    const applied = events.find((e) => e.type === "steer_applied");
    expect(applied && applied.type === "steer_applied" ? applied.images : undefined).toEqual(images);
    expect(applied && applied.type === "steer_applied" ? applied.attachments : undefined).toEqual(attachments);
  });

  it("does not apply a steer queued after the final turn (no boundary left)", async () => {
    const { agent, history } = buildHarness({ chunks: [[{ type: "text", content: "final" }]] });
    agent.onEvent((e) => {
      if (e.type === "done") agent.steer("late", "too late");
    });

    await agent.send("x");

    expect(history.all().some((m) => m.steer)).toBe(false);
  });
});

describe("Agent soft steering — final-answer boundary", () => {
  it("applies a steer queued during the FINAL answer at the end of the run", async () => {
    const { agent, factory, history, events } = buildHarness({
      chunks: [
        [{ type: "text", content: "first answer" }],
        [{ type: "text", content: "corrected answer" }],
      ],
    });
    let steered = false;
    agent.onEvent((e) => {
      if (e.type === "text_delta" && !steered) {
        steered = true;
        agent.steer("s1", "wait, use Rome");
      }
    });

    await agent.send("find Florence");

    // Same run continued (2 LLM calls), NOT a brand-new send.
    expect(factory.calls).toBe(2);
    const msgs = history.all();
    const steerIdx = msgs.findIndex((m) => m.steer);
    const firstAnswerIdx = msgs.findIndex((m) => m.role === "assistant" && m.content === "first answer");
    expect(steerIdx).toBeGreaterThan(firstAnswerIdx); // applied AFTER the answer
    expect(msgs.some((m) => m.role === "assistant" && m.content === "corrected answer")).toBe(true);
    expect(events.some((e) => e.type === "steer_applied" && e.ids.includes("s1"))).toBe(true);
  });
});

describe("Agent soft steering — no target (removed)", () => {
  it("steer NEVER aborts a sub-agent: it is a pure text correction", () => {
    const { agent } = buildHarness();
    const spy = vi.spyOn(agent, "abortSubAgent");
    agent.steer("s1", "not Florence, Rome");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("Agent — per-turn meta (real usage + timings)", () => {
  it("attaches REAL usage and wall-clock timings to the assistant message", async () => {
    const { agent, history } = buildHarness({
      chunks: [
        [
          { type: "text", content: "hi" },
          { type: "usage", usage: { input: 1234, output: 56, total: 1290, cached: 1000, cachedWrite: 20 } },
        ],
      ],
    });

    await agent.send("hello");

    const assistant = history.all().find((m) => m.role === "assistant")!;
    expect(assistant.meta).toBeDefined();
    expect(assistant.meta!.inputTokens).toBe(1234);
    expect(assistant.meta!.outputTokens).toBe(56);
    expect(assistant.meta!.totalTokens).toBe(1290);
    expect(assistant.meta!.cachedTokens).toBe(1000);
    expect(assistant.meta!.cachedWriteTokens).toBe(20);
    expect(typeof assistant.meta!.startedAt).toBe("number");
    expect(assistant.meta!.endedAt!).toBeGreaterThanOrEqual(assistant.meta!.startedAt!);
    expect(assistant.meta!.durationMs!).toBeGreaterThanOrEqual(0);
    expect(assistant.meta!.firstTokenAt!).toBeGreaterThanOrEqual(assistant.meta!.startedAt!);
    expect(assistant.meta!.ttftMs!).toBeGreaterThanOrEqual(0);
  });

  it("omits the token fields when the provider reports no usage (timings only)", async () => {
    const { agent, history } = buildHarness({ chunks: [[{ type: "text", content: "hi" }]] });
    await agent.send("hello");
    const assistant = history.all().find((m) => m.role === "assistant")!;
    expect(assistant.meta).toBeDefined();
    expect(assistant.meta!.inputTokens).toBeUndefined();
    expect(assistant.meta!.outputTokens).toBeUndefined();
    expect(typeof assistant.meta!.durationMs).toBe("number");
  });

  it("emits a turn_meta event with the REAL metrics as soon as a turn is committed", async () => {
    const { agent, events } = buildHarness({
      chunks: [[{ type: "text", content: "hi" }, { type: "usage", usage: { input: 1000, output: 10, total: 1010 } }]],
    });
    await agent.send("hello");
    const tm = events.find((e) => e.type === "turn_meta");
    expect(tm).toBeDefined();
    expect(tm && tm.type === "turn_meta" ? tm.meta.inputTokens : undefined).toBe(1000);
    expect(tm && tm.type === "turn_meta" ? typeof tm.meta.durationMs : undefined).toBe("number");
  });

  it("records WHICH model and WHICH budget served the turn (a session can switch mid-flight)", async () => {
    // The config of a turn on a 1M-window model whose output budget was clamped
    // by the host: both facts must land in the message, so an old turn stays
    // readable even after the user picks llama-local (32k) for the next one.
    const config: HarnyConfig = {
      ...VALID_CONFIG,
      model: "deepseek-v4.1-flash",
      activeProvider: "opencode-go",
      contextWindow: 1_048_576,
      maxTokens: 373_564,
    };
    const { agent, history } = buildHarness({
      config,
      chunks: [[{ type: "text", content: "hi" }]],
    });
    await agent.send("hello");

    const meta = history.all().find((m) => m.role === "assistant")!.meta!;
    expect(meta.model).toBe("deepseek-v4.1-flash");
    expect(meta.provider).toBe("opencode-go");
    expect(meta.contextWindow).toBe(1_048_576);
    expect(meta.maxTokens).toBe(373_564);
  });

  it("omits the identity fields when the config carries no model/provider (no invented labels)", async () => {
    const { agent, history } = buildHarness({ chunks: [[{ type: "text", content: "hi" }]] });
    await agent.send("hello");
    const meta = history.all().find((m) => m.role === "assistant")!.meta!;
    // The harness config HAS a model, so it is recorded…
    expect(meta.model).toBe("gpt-4o");
    // …while a field the config does not declare (no activeProvider, no window)
    // stays ABSENT rather than being defaulted.
    expect(meta.provider).toBeUndefined();
    expect(meta.contextWindow).toBeUndefined();
    expect(meta.maxTokens).toBe(4096);
  });
});

describe("tool-call pairing on an interrupted run", () => {
  /** A factory that RECORDS every request, so a test can assert on the WIRE. */
  function recordingFactory(chunks: StreamChunk[][]): LLMProviderFactory & { requests: LLMMessage[][] } {
    const requests: LLMMessage[][] = [];
    let call = 0;
    return {
      requests,
      create: () => ({
        protocol: "chat" as const,
        async *stream(messages: LLMMessage[]) {
          requests.push(messages);
          const batch = chunks[Math.min(call++, chunks.length - 1)];
          for (const chunk of batch) yield chunk;
        },
      }),
    } as unknown as LLMProviderFactory & { requests: LLMMessage[][] };
  }

  function toolCallChunks(id: string, name: string, args: Record<string, unknown>): StreamChunk[] {
    return [
      { type: "tool_call_start", index: 0, id, name },
      { type: "tool_call_delta", index: 0, delta: JSON.stringify(args) },
      { type: "tool_call_end", index: 0 },
    ];
  }

  it("a Stop while a tool runs leaves a conversation the provider still accepts", async () => {
    // A tool that runs until the RUN is aborted: the Shell-in-flight case.
    let started: () => void = () => {};
    const toolStarted = new Promise<void>((r) => (started = r));
    const blocking: Tool = {
      name: "Shell",
      definition: { name: "Shell", description: "shell", parameters: { type: "object", properties: {} } },
      execute: (_args, ctx) =>
        new Promise<ToolResult>((resolve) => {
          started();
          const signal = ctx?.signal;
          const done = (): void => resolve({ content: "⏹ aborted", isError: true });
          if (signal?.aborted) return done();
          signal?.addEventListener("abort", done, { once: true });
        }),
    };
    const factory = recordingFactory([
      toolCallChunks("call_1", "Shell", { command: "npm run build" }),
      [{ type: "text", content: "done" }],
    ]);
    const history = new InMemoryChatHistory();
    const events = new InMemoryEventBus<AgentEvent>();
    const tools = new ToolRegistry([blocking]);
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: factory,
      tools,
      history,
      events,
      systemPrompt: new DefaultSystemPromptBuilder(() => tools.definitions(), () => "/workspace"),
    });
    // Build mode (the default is Analyze, which would refuse a Shell command
    // before running it — and the point here is a tool that is IN FLIGHT).
    agent.setMode("agent");

    const run = agent.send("go");
    await toolStarted; // the tool is in flight: the turn is not committed yet
    // EXACTLY what the host does on Stop (chat-view.ts:1253-1260): signal the
    // abort and persist the interruption notice in the SAME tick.
    agent.abort();
    history.add({ role: "assistant", content: "❌ ⏹ Processing interrupted.", timestamp: Date.now(), uiOnly: true });
    await run;

    // The NEXT send builds its request from this history.
    await agent.send("next");

    // 1) the stored conversation honors the invariant…
    expect(toolCallPairingViolations(history.all())).toEqual([]);
    // …and the interrupted turn IS recorded: the call and its aborted result
    // landed together (losing them would be the other way to "fix" this).
    const turn = history.all().find((m) => m.role === "assistant" && !!m.toolCalls?.length);
    expect(turn?.toolCalls?.map((tc) => tc.id)).toEqual(["call_1"]);
    const result = history.all().find((m) => m.role === "tool");
    expect(result?.toolCallId).toBe("call_1");
    expect(result?.content).toMatch(/aborted/i);
    // 2) …and so does what actually goes on the wire (LLMMessage is camelCase: the
    // snake_case mapping happens later, in the provider's converter): every
    // toolCallId is answered by the tool message IMMEDIATELY after the turn.
    const second = factory.requests[1];
    const callIndex = second.findIndex((m) => m.role === "assistant" && !!m.toolCalls?.length);
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(second[callIndex + 1]?.role).toBe("tool");
    expect(second[callIndex + 1]?.toolCallId).toBe("call_1");
  });

  it("refuses to SEND a conversation that violates the pairing, and names the cause", async () => {
    const factory = recordingFactory([[{ type: "text", content: "hi" }]]);
    const history = new InMemoryChatHistory();
    const events = new InMemoryEventBus<AgentEvent>();
    const errors: string[] = [];
    events.subscribe((e) => {
      if (e.type === "error") errors.push((e as { error: string }).error);
    });
    const tools = new ToolRegistry([makeTool("FakeTool")]);
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: factory,
      tools,
      history,
      events,
      systemPrompt: new DefaultSystemPromptBuilder(() => tools.definitions(), () => "/workspace"),
    });
    // A history damaged by something OUTSIDE this path: the check must catch it
    // whoever produced it (that is the whole point of putting it at the wire).
    history.replace([
      { role: "user", content: "go", timestamp: 1 },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "Shell", arguments: {} }], timestamp: 2 },
      { role: "assistant", content: "interrupted", timestamp: 3 },
    ]);

    await agent.send("again");

    // Nothing went out: the provider never built a request it would reject.
    expect(factory.requests).toHaveLength(0);
    // …and what the user reads names the problem (which turn, which id) instead
    // of the provider's "insufficient tool messages following tool_calls".
    const shown = [...errors, ...history.all().map((m) => m.content ?? "")].join(" | ");
    expect(shown).toContain("not replayable");
    expect(shown).toContain("c1");
  });

  it("does NOT refuse a healthy conversation (a false positive would break every session)", async () => {
    const factory = recordingFactory([
      toolCallChunks("call_1", "Shell", { command: "echo hi" }),
      [{ type: "text", content: "done" }],
    ]);
    const history = new InMemoryChatHistory();
    const events = new InMemoryEventBus<AgentEvent>();
    const tools = new ToolRegistry([makeTool("Shell", { content: "hi", isError: false })]);
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: factory,
      tools,
      history,
      events,
      systemPrompt: new DefaultSystemPromptBuilder(() => tools.definitions(), () => "/workspace"),
    });
    agent.setMode("agent");

    await agent.send("go");

    // The full round trip (call → result → final answer) reached the provider
    // twice, and the stored history is valid.
    expect(factory.requests).toHaveLength(2);
    expect(toolCallPairingViolations(history.all())).toEqual([]);
  });
});
