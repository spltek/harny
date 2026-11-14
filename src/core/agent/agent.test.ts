import { describe, it, expect, vi } from "vitest";
import { Agent } from "./agent";
import type { ContextOverflowEvidence } from "./agent";
import { ToolCallAccumulator } from "./tool-call-accumulator";
import { BUILD_SWITCH_HINT, DefaultSystemPromptBuilder } from "./system-prompt";
import { InMemoryEventBus } from "../events/in-memory-event-bus";
import { InMemoryChatHistory } from "../history/in-memory-chat-history";
import { StaticConfigProvider } from "../config/static-config-provider.test-utils";
import { ToolRegistry } from "../tools/tool-registry";
import type { HarnyConfig } from "../config/types";
import type { LLMMessage, LLMProviderFactory, StreamChunk } from "../llm/types";
import { toolCallChunks, toolCallChunksFromJson, textChunks } from "../llm/stream-chunks.test-utils";
import { Semaphore, limitLlmFactory } from "../llm/concurrency";
import type { Tool, ToolResult } from "../tools/tool";
import type { ToolDefinition } from "../tools/tool";
import { toolDefinitionsForMode } from "../tools/mode-policy";
import type { ToolScope } from "../tools/tool-scope";
import type { DelegateSpec } from "./orchestration";
import { SubAgentRunner } from "./subagent";
import type { AgentEvent, SubAgentEvent } from "./types";
import { resolveLoopGuardOptions, type LoopGuardOptions } from "./loop-guard";
import { McpTool } from "../mcp/mcp-tool";
import { ShellTool } from "../tools/shell-tool";
import { FILE_PREVIEW_NOTE } from "../tools/mode-policy";
import { conversationFaults } from "../history/conversation-validity";
import type { AnalyzePolicy } from "../tools/tool";

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

/** A stand-in tool. Its default policy is `read-only` — a fixture models a KNOWN tool, and
 * most tests are not about Analyze — while production's default is `refuse` (see
 * AnalyzePolicy). The tests whose subject IS the policy declare it explicitly, and the
 * REAL declarations are pinned in create-default-tools.test.ts: that is the check that
 * matters, so a real tool cannot forget to declare. */
function makeTool(
  name: string,
  result: ToolResult = { content: "ok", isError: false },
  opts: { analyzePolicy?: AnalyzePolicy; cacheable?: boolean } = {},
): Tool & { called: boolean } {
  const tool = {
    name,
    definition: { name, description: name, parameters: { type: "object", properties: {} } },
    analyzePolicy: opts.analyzePolicy ?? "read-only",
    ...(opts.cacheable ? { cacheable: true } : {}),
    called: false,
    execute: (): ToolResult => {
      tool.called = true;
      return result;
    },
  };
  return tool;
}

/** A file-mutating tool as the REAL ones declare it: `preview` in Analyze, plus the note
 * that tells the model a write there is a PROPOSAL. */
function previewTool(name: string, result: ToolResult = { content: "PROPOSED (preview)", isError: false }) {
  return { ...makeTool(name, result, { analyzePolicy: "preview" }), analyzeNote: FILE_PREVIEW_NOTE };
}

/** The REAL Shell tool with a fake runner: its Analyze allowlist lives in the tool, so a
 * test about that gate must use it rather than re-implement the rule. */
function shellTool(run: (command: string, opts: unknown) => Promise<unknown>) {
  return new ShellTool({ run: run as never }, () => "/workspace");
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
    /** A provider of your own, when the test must OBSERVE the request itself (its tool
     * list, its messages). Defaults to the fake built from `chunks`. */
    llmFactory?: LLMProviderFactory;
    tools?: Tool[];
    maxTurns?: number;
    log?: (message: string) => void;
    onTurnBoundary?: (signal: AbortSignal) => Promise<void> | void;
    onContextOverflow?: (signal: AbortSignal) => Promise<boolean> | boolean;
    contextBudget?: () => number;
    workspaceReady?: () => boolean;
    workspaceTrusted?: () => boolean;
    cwd?: () => string;
    loopGuard?: LoopGuardOptions;
    streamIdleTimeoutMs?: number;
    onFileChanged?: (change: { path: string; tool: string }) => void;
    /** What THIS session may use, read at every turn — and, since the per-tool Analyze declaration
     *  moved into the session, the only place a test can say "this conversation allows it". */
    toolScope?: () => ToolScope | undefined;
  } = {},
): Harness {
  const config = new StaticConfigProvider(opts.config ?? VALID_CONFIG);
  const history = new InMemoryChatHistory();
  const events = new InMemoryEventBus<AgentEvent>();
  const eventsLog: AgentEvent[] = [];
  events.subscribe((e) => eventsLog.push(e));
  const factory = opts.llmFactory ?? fakeFactory(...(opts.chunks ?? [[{ type: "text", content: "hi" }]]));
  const tools = new ToolRegistry(opts.tools ?? [makeTool("FakeTool")]);
  const systemPrompt = new DefaultSystemPromptBuilder(
    () => tools.definitions(),
    () => "/workspace",
  );

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
    onContextOverflow: opts.onContextOverflow,
    contextBudget: opts.contextBudget,
    workspaceReady: opts.workspaceReady,
    workspaceTrusted: opts.workspaceTrusted,
    cwd: opts.cwd,
    loopGuard: opts.loopGuard,
    streamIdleTimeoutMs: opts.streamIdleTimeoutMs,
    onFileChanged: opts.onFileChanged,
    toolScope: opts.toolScope,
  });
  return { agent, factory, events: eventsLog, history };
}

describe("Agent", () => {
  it("an UNTRUSTED folder can never run Build: setMode('agent') resolves to Analyze", async () => {
    // Workspace Trust is asked exactly one question: may this folder's code make the machine do
    // things? A session can arrive here already carrying "agent" (a preference saved in a trusted
    // folder, a reload, a sub-agent inheriting write access), so the coercion lives in setMode —
    // the one path every caller takes — instead of in each caller.
    const logs: string[] = [];
    const { agent } = buildHarness({ workspaceTrusted: () => false, log: (m) => logs.push(m) });
    agent.setMode("agent");
    // `mode` is the mode the agent ACCEPTED (not the one asked for): that is what the run uses,
    // and what callers read to report what happened (a sub-agent's status footer).
    expect(agent.mode).toBe("analyze");
    await agent.send("hi");
    expect(logs.join("\n")).toContain("send: mode=analyze");
  });

  it("…and a TRUSTED folder still gets Build (the gate is the verdict, never a default)", async () => {
    const logs: string[] = [];
    const { agent } = buildHarness({ workspaceTrusted: () => true, log: (m) => logs.push(m) });
    agent.setMode("agent");
    expect(agent.mode).toBe("agent");
    await agent.send("hi");
    expect(logs.join("\n")).toContain("send: mode=agent");
  });

  it('with NO verdict passed in, Build is allowed: "nobody told me" is not "the folder is dirty"', () => {
    const { agent } = buildHarness();
    agent.setMode("agent");
    expect(agent.mode).toBe("agent");
  });

  it("runs NO tool when the workspace root is gone — and says why, so the model does not scaffold", async () => {
    // The ghost: with the folder deleted, "file not found" / "0 files found" read as an empty
    // project, and a model repairs an empty project by CREATING everything. So nothing runs.
    const read = makeTool("Read", { content: "file content", isError: false });
    const { agent, history } = buildHarness({
      tools: [read],
      chunks: [toolCallChunks("c1", "Read", { path: "a.ts" }), textChunks("done")],
      workspaceReady: () => false,
      cwd: () => "/p/gone",
    });

    await agent.send("read a.ts");

    expect(read.called).toBe(false);
    const toolMsg = history.all().find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("no longer exists");
    // The sentence that stops the "empty project" reflex.
    expect(toolMsg?.content).toContain("NOT an empty project");
  });

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
      systemPrompt: new DefaultSystemPromptBuilder(
        () => tools.definitions(),
        () => "/workspace",
      ),
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
      systemPrompt: new DefaultSystemPromptBuilder(
        () => [],
        () => "/workspace",
      ),
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
    const systemPrompt = new DefaultSystemPromptBuilder(
      () => [],
      () => "/workspace",
    );
    const agent = new Agent({ config, llmFactory: factory, tools, history, events, systemPrompt });

    await agent.send("what do you see?", { images: ["data:image/png;base64,AAAA"] });

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
      chunks: [
        [
          { type: "text", content: "Hel" },
          { type: "text", content: "lo" },
        ],
      ],
    });

    await agent.send("hello");

    expect(
      events.filter((e) => e.type === "text_delta").map((e) => (e.type === "text_delta" ? e.content : "")),
    ).toEqual(["Hel", "lo"]);
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(factory.calls).toBe(1);

    const assistant = history.all()[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("Hello");
  });

  it("emits thinking_delta when provider returns thinking type", async () => {
    const { agent, events, history } = buildHarness({
      chunks: [
        [
          { type: "thinking", content: "let me reason about this" },
          { type: "text", content: "Here is the answer" },
        ],
      ],
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
      systemPrompt: new DefaultSystemPromptBuilder(
        () => [],
        () => "/workspace",
      ),
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
      chunks: [
        [
          { type: "text", content: "I need to " },
          { type: "text", content: "\u003cthink\u003elet me check the API docs" },
          { type: "text", content: "\u003c/think\u003e" },
          { type: "text", content: "The answer is 42." },
        ],
      ],
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
      chunks: [
        [
          { type: "text", content: "\u003creason\u003eAnalyzing the algorithm..." },
          { type: "text", content: "\u003c/reason\u003e" },
          { type: "text", content: "Use quicksort." },
        ],
      ],
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
      chunks: [
        [
          { type: "text", content: "Hello. \u003cthink\u003eStep 1: check" },
          { type: "text", content: "Step 2: analyze" },
          { type: "text", content: "Step 3: conclude\u003c/think\u003eDone." },
        ],
      ],
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
    const output = toolResult && toolResult.type === "tool_result" ? toolResult.toolResult.output : "";
    expect(output).toContain("Unknown tool");
    // The reply is the model's ONLY channel for learning: it says the name does not exist
    // AND which names do (the ones this turn offered), so the next attempt can succeed.
    expect(output).toContain("No tool by that name is offered in this run.");
    expect(output).toContain("Available tools: FakeTool.");
  });

  it("diagnoses a name that carried the ARGUMENTS, instead of a mute 'Unknown tool'", async () => {
    // A real transcript: the provider handed over a call whose name field held part of the
    // arguments. The old reply was `Unknown tool: Greplike" string="true` — no diagnosis, no
    // list, so the model had nothing to correct and the bubble just wore the default wrench.
    const { agent, events } = buildHarness({
      chunks: [
        [
          { type: "tool_call_start", index: 0, id: "c1", name: 'Greplike" string="true' },
          { type: "tool_call_end", index: 0 },
        ],
      ],
    });

    await agent.send("x");

    const toolResult = events.find((e) => e.type === "tool_result");
    const output = toolResult && toolResult.type === "tool_result" ? toolResult.toolResult.output : "";
    expect(output).toContain('Unknown tool: Greplike" string="true');
    expect(output).toContain("not a tool name");
    expect(output).toContain("ONE call per tool");
    expect(toolResult && toolResult.type === "tool_result" ? toolResult.toolResult.isError : false).toBe(true);
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
      chunks: [[{ type: "thinking", content: "let me think about this" }], [{ type: "text", content: "final answer" }]],
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

  it("refuses a Delegate call when Parallel is OFF (the execution-side layer)", async () => {
    // The tool list is the FIRST layer (Parallel OFF excludes Delegate from the
    // definitions); a model that emits the name anyway must not spawn anything. This
    // refusal existed but was never tested — which is exactly why a report of "sub-agents
    // still running with Parallel OFF" could look like a missing gate.
    const { agent, history } = buildHarness({
      tools: [makeTool("Delegate")],
      chunks: [
        [
          { type: "tool_call_start", index: 0, id: "d1", name: "Delegate" },
          { type: "tool_call_delta", index: 0, delta: '{"id":"A","goal":"g","access":"read"}' },
          { type: "tool_call_end", index: 0 },
        ],
        [{ type: "text", content: "did it myself" }],
      ],
    });
    agent.setDelegation(false);

    await agent.send("go");

    // No sub-agent was spawned and the model was told why.
    const refusal = history.all().find((m) => m.role === "tool" && /Delegation is disabled/.test(m.content ?? ""));
    expect(refusal).toBeTruthy();
    expect(history.all().some((m) => m.role === "assistant" && m.content === "did it myself")).toBe(true);
  });

  it("a MODE switch mid-run does NOT reach this run: it lands on the NEXT one", async () => {
    // Mode and Parallel are SAFETY policies, decided ONCE per run (see Agent.runMode): the
    // run is born with them and keeps them to its last tool result, and a switch made while
    // it works is the NEXT run's policy — which is why the panel marks it as pending.
    // Before this rule the switch landed on the next TURN, and two things followed from it:
    // a writer sub-agent delegated before the switch kept writing while the pill said
    // Analyze, and a switch to Build erased the "nothing has been applied" footer while the
    // files were still untouched.
    const seenDefs: Array<Array<{ name: string; description: string }>> = [];
    let agentRef: Agent | undefined;
    const modesSeen: Array<boolean | undefined> = [];
    const write: Tool = {
      name: "Write",
      definition: { name: "Write", description: "write", parameters: { type: "object", properties: {} } },
      analyzePolicy: "preview", // the subject of this test IS the Analyze gate
      analyzeNote: FILE_PREVIEW_NOTE,
      execute: (args, ctx) => {
        modesSeen.push(ctx?.dryRun); // what the RUN decided for THIS call
        agentRef?.setMode("agent"); // the user flips to Build while the run works
        return { content: `preview ${String(args.path ?? "")}`, isError: false };
      },
    };
    let call = 0;
    const writeCall = (index: number, id: string, path: string): StreamChunk[] => [
      { type: "tool_call_start", index, id, name: "Write" } as StreamChunk,
      { type: "tool_call_delta", index, delta: `{"path":"${path}","content":"x"}` } as StreamChunk,
      { type: "tool_call_end", index } as StreamChunk,
    ];
    const recording: LLMProviderFactory = {
      create: () => ({
        protocol: "chat" as const,
        async *stream(
          _messages: LLMMessage[],
          _signal?: AbortSignal,
          tools?: Array<{ name: string; description: string }>,
        ) {
          seenDefs.push((tools ?? []).map((t) => ({ name: t.name, description: t.description })));
          call++;
          if (call === 1) {
            // TWO writes in the SAME turn: the first flips the mode while the turn runs, so
            // the second proves the turn was frozen (a live mode would have written it).
            for (const c of [...writeCall(0, "w1", "a.ts"), ...writeCall(1, "w2", "b.ts")]) yield c;
          } else if (call === 2) {
            // A LATER turn of the SAME run: still Analyze. This is what moved from per-turn
            // to per-run — under the old rule this write already went to disk.
            for (const c of writeCall(0, "w3", "c.ts")) yield c;
          } else if (call === 4) {
            // The NEXT run: born in Build, so its write is real.
            for (const c of writeCall(0, "w4", "d.ts")) yield c;
          } else {
            yield { type: "text", content: "done" } as StreamChunk;
          }
        },
      }),
    };
    const { agent, history } = buildHarness({ tools: [write], llmFactory: recording });
    agentRef = agent;

    await agent.send("go"); // run 1 starts in Analyze (the default)
    await agent.send("again"); // run 2 starts in Build (the switch was pending)

    // EVERY write of run 1 was a preview, the one from its THIRD turn included; run 2's was
    // a real write (Build does not set dryRun at all — see ToolContext — hence undefined).
    expect(modesSeen.slice(0, 3)).toEqual([true, true, true]);
    expect(modesSeen[3]).toBeUndefined();
    // What the model was TOLD, turn by turn: run 1 announced the write as a preview in every
    // turn, run 2 did not — the tool stays listed either way, so the note is the signal.
    const writeDesc = (i: number): string => seenDefs[i].find((t) => t.name === "Write")?.description ?? "";
    expect(writeDesc(0)).toContain("PREVIEW MODE (Analyze)");
    expect(writeDesc(1)).toContain("PREVIEW MODE (Analyze)");
    expect(writeDesc(3)).not.toContain("PREVIEW MODE");
    // …and the run that prepared previews still SAYS they are not on disk: the footer reads
    // the RUN's mode, so a pending switch to Build cannot erase it any more.
    const final = history.all().find((m) => m.role === "assistant" && m.content.includes("Nothing has been applied"));
    expect(final?.content).toContain("NOT on disk");
    expect(final?.content).toContain("c.ts"); // the third turn's preview is listed too
  });

  it("a PARALLEL switch mid-run does NOT reach this run either: it keeps the policy it was born with", async () => {
    // Same rule as the mode (see Agent.runMode): the run's orchestration policy is fixed at
    // its start. A run born with Parallel ON keeps delegating after a mid-run OFF — that
    // switch is the NEXT run's — and a run born with it OFF cannot acquire sub-agents
    // halfway. Stop, not a toggle, is what stops a run.
    const spawned: string[] = [];
    const seenDefs: string[][] = [];
    let call = 0;
    let agentRef: Agent | undefined;
    const delegateCall = (id: string): StreamChunk[] => [
      { type: "tool_call_start", index: 0, id, name: "Delegate" } as StreamChunk,
      {
        type: "tool_call_delta",
        index: 0,
        delta: `{"id":"${id}","goal":"g","access":"read","resources":["a.ts"]}`,
      } as StreamChunk,
      { type: "tool_call_end", index: 0 } as StreamChunk,
    ];
    const factory: LLMProviderFactory = {
      create: () => ({
        protocol: "chat" as const,
        async *stream(_m: LLMMessage[], _s?: AbortSignal, defs?: { name: string }[]) {
          seenDefs.push((defs ?? []).map((d) => d.name));
          call++;
          if (call === 1) {
            // Mid-run (the run's policies are already frozen): Parallel goes OFF, then the
            // model delegates. The RUN is still the one that started with Parallel ON.
            agentRef?.setDelegation(false);
            for (const c of delegateCall("d1")) yield c;
          } else if (call === 3) {
            // The NEXT run was born with Parallel OFF: the same call is refused at execution.
            for (const c of delegateCall("d2")) yield c;
          } else {
            yield { type: "text", content: "done" } as StreamChunk;
          }
        },
      }),
    };
    const history = new InMemoryChatHistory();
    const tools = new ToolRegistry([makeTool("Read"), makeTool("Delegate")]);
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
      spawnSubAgent: async (spec) => {
        spawned.push(spec.id);
        return { content: "report", isError: false };
      },
    });
    agentRef = agent;
    agent.setMode("agent");
    agent.setDelegation(true);

    await agent.send("one");
    await agent.send("two");

    // Run 1 delegated (its own policy), run 2 did not (its own policy) — and the second run
    // does not even see the tool, let alone a half-acquired one.
    expect(spawned).toEqual(["d1"]);
    expect(seenDefs[0]).toContain("Delegate");
    expect(seenDefs[2]).not.toContain("Delegate");
    const refusal = history.all().find((m) => m.role === "tool" && /Delegation is disabled/.test(m.content ?? ""));
    expect(refusal).toBeTruthy();
  });

  it("a PENDING mode cannot open or close the Delegate gate of the run in flight", async () => {
    // The case the per-run rule exists for. A run born in Build delegates a WRITER; the user
    // picks Analyze while it works (the panel locks the pill, so this arrives as the host
    // pushing the choice — the agent's contract is the same either way). The run keeps Build,
    // so the sub-agent is legitimately delegated and is NOT silently downgraded; the SAME
    // Delegate in the next run, born in Analyze, is refused.
    const spawned: string[] = [];
    const seenDefs: string[][] = [];
    let call = 0;
    let agentRef: Agent | undefined;
    const delegateWriter = (id: string): StreamChunk[] => [
      { type: "tool_call_start", index: 0, id, name: "Delegate" } as StreamChunk,
      {
        type: "tool_call_delta",
        index: 0,
        delta: `{"id":"${id}","goal":"write","access":"write","resources":["a.ts"]}`,
      } as StreamChunk,
      { type: "tool_call_end", index: 0 } as StreamChunk,
    ];
    const factory: LLMProviderFactory = {
      create: () => ({
        protocol: "chat" as const,
        async *stream(_m: LLMMessage[], _s?: AbortSignal, defs?: { name: string }[]) {
          seenDefs.push((defs ?? []).map((d) => d.name));
          call++;
          if (call === 1) {
            agentRef?.setMode("analyze"); // the pending switch, mid-run
            for (const c of delegateWriter("d1")) yield c;
          } else if (call === 3) {
            for (const c of delegateWriter("d2")) yield c;
          } else {
            yield { type: "text", content: "done" } as StreamChunk;
          }
        },
      }),
    };
    const history = new InMemoryChatHistory();
    const tools = new ToolRegistry([makeTool("Read"), makeTool("Delegate")]);
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
      spawnSubAgent: async (spec) => {
        spawned.push(spec.id);
        return { content: "wrote a.ts", isError: false };
      },
    });
    agentRef = agent;
    agent.setMode("agent");
    agent.setDelegation(true);

    await agent.send("one"); // Build: the writer IS delegated
    await agent.send("two"); // the pending Analyze is the run's policy now: refused

    expect(spawned).toEqual(["d1"]);
    const refusal = history
      .all()
      .find((m) => m.role === "tool" && /may only be delegated with access "read"/.test(m.content ?? ""));
    expect(refusal).toBeTruthy();
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
    const last = history
      .all()
      .filter((m) => m.role === "assistant")
      .at(-1);
    expect(last?.content).toContain("Loop not resolved");
    expect(last?.content).toContain("[empty]");
    expect(events.some((e) => e.type === "error" && /Loop not resolved/.test(e.error))).toBe(true);
  });

  it("reports a token-limit truncation when the turn is empty (finish_reason=length)", async () => {
    const { agent, factory, history, events } = buildHarness({
      chunks: [
        [
          { type: "thinking", content: "lots of reasoning" },
          { type: "finish", reason: "length" },
        ],
      ],
    });

    await agent.send("x");

    // "length" is diagnosed immediately — no nudge/retry loop.
    expect(factory.calls).toBe(1);
    const last = history
      .all()
      .filter((m) => m.role === "assistant")
      .at(-1);
    expect(last?.content).toContain("token limit");
    expect(last?.content).toContain("harny.maxTokens");
    expect(last?.content).toContain("reasoning");
    expect(events.some((e) => e.type === "error" && /token limit|truncat/i.test(e.error))).toBe(true);
  });

  it("marks a partial answer as truncated when finish_reason=length", async () => {
    const { agent, history } = buildHarness({
      chunks: [
        [
          { type: "text", content: "Partial ans" },
          { type: "finish", reason: "length" },
        ],
      ],
    });

    await agent.send("x");

    const last = history
      .all()
      .filter((m) => m.role === "assistant")
      .at(-1);
    expect(last?.content).toContain("Partial ans");
    expect(last?.content).toContain("truncated");
    expect(last?.content).toContain("harny.maxTokens");
  });

  it("breaks a within-turn reasoning loop and nudges instead of burning the token budget", async () => {
    const loopText = "Let me check the CSS and the controls again. ".repeat(24);
    const { agent, factory, history, events } = buildHarness({
      chunks: [
        // Turn 0: a runaway repetitive reasoning stream.
        [
          { type: "thinking", content: loopText },
          { type: "finish", reason: "stop" },
        ],
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
      [
        { type: "text", content: loopText },
        { type: "finish", reason: "stop" },
      ],
      // Turn 1: the model recovers with a concise answer.
      [{ type: "text", content: "concise final answer" }],
    ];

    // OFF (default): the repetitive answer is stored as-is, no intervention.
    const off = buildHarness({ chunks });
    await off.agent.send("x");
    expect(off.events.some((e) => e.type === "loop_intervention" && e.loopType === "response")).toBe(false);

    // ON: the answer is cut mid-stream, a "response" intervention is emitted,
    // and the model gets a chance to recover.
    const on = buildHarness({ chunks, loopGuard: resolveLoopGuardOptions("medium", true) });
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
      analyzePolicy: "read-only",
      cacheable: true, // the subject of this test IS the loop-guard cache
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

  it("with Loop Guard OFF an identical read is executed AGAIN (no cache, no reuse note)", async () => {
    let runs = 0;
    const read: Tool = {
      name: "Read",
      definition: { name: "Read", description: "read", parameters: { type: "object", properties: {} } },
      analyzePolicy: "read-only",
      cacheable: true,
      execute: (): ToolResult => {
        runs++;
        return { content: "FILE CONTENT", isError: false };
      },
    };
    const readCall = (id: string): StreamChunk[] => [
      { type: "tool_call_start", index: 0, id, name: "Read" },
      { type: "tool_call_delta", index: 0, delta: '{"path":"a.ts"}' },
      { type: "tool_call_end", index: 0 },
    ];
    const { agent, history } = buildHarness({
      tools: [read],
      chunks: [readCall("c1"), readCall("c2"), [{ type: "text", content: "done" }]],
      loopGuard: resolveLoopGuardOptions("off"),
    });

    await agent.send("x");

    // Off = the guard is completely inert: the second identical read RUNS.
    expect(runs).toBe(2);
    expect(history.all().some((m) => /reused the cached result/i.test(m.content))).toBe(false);
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
      tools: new ToolRegistry([previewTool("StrReplace")]),
      history: new InMemoryChatHistory(),
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(
        () => [],
        () => "/w",
      ),
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
      tools: [previewTool("StrReplace")],
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
        [
          { type: "tool_call_start", index: 0, id: "c", name: "FakeTool" },
          { type: "tool_call_end", index: 0 },
        ],
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

    // The per-turn line carries the mode and Parallel state too: that is what makes a
    // "it still behaved as Analyze" report diagnosable after the fact.
    const turnLine = logs.find((l) => l.startsWith("turn 0"));
    expect(turnLine).toMatch(/^turn 0: mode=\w+ parallel=(ON|OFF) finish=/);
    expect(turnLine).toContain("mode=analyze"); // the default when nothing switched
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

  it("an MCP tool registered in the registry is callable by the agent (Build)", async () => {
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
    agent.setMode("agent"); // Build: full tool use

    await agent.send("x");

    expect(called).toEqual({ text: "hi" });
    expect(history.all().some((m) => m.role === "tool" && /mcp-ok/.test(m.content))).toBe(true);
  });

  it("REFUSES a tool that declares nothing at all (production's default is not 'harmless')", async () => {
    // The safety net under every dynamic source: a tool in the registry with NO
    // declaration is refused in Analyze. This is what makes the hole unable to reopen by
    // omission — a new MCP server, a plugin, a tool added tomorrow.
    let called = false;
    const undeclared: Tool = {
      name: "MysteryTool",
      definition: { name: "MysteryTool", description: "?", parameters: { type: "object", properties: {} } },
      execute: () => {
        called = true;
        return { content: "ran", isError: false };
      },
    };
    const { agent, history } = buildHarness({
      tools: [undeclared],
      chunks: [
        [
          { type: "tool_call_start", index: 0, id: "m", name: "MysteryTool" },
          { type: "tool_call_end", index: 0 },
        ],
        [{ type: "text", content: "ok" }],
      ],
    });

    await agent.send("do something");

    expect(called).toBe(false);
    expect(history.all().find((m) => m.role === "tool")?.content).toContain("Analyze never modifies");
  });

  it("REFUSES an undeclared MCP tool in Analyze — the client is never called (the reported hole)", async () => {
    // `mcp__db__drop_table` used to be "not a file-mutating tool", so Analyze ran it for
    // real: it cannot be previewed like a file write, and nobody had declared it harmless.
    let called = false;
    const client = {
      callTool: async () => {
        called = true;
        return { text: "dropped", isError: false };
      },
    } as unknown as import("../mcp/mcp-client").McpStdioClient;
    const call: StreamChunk[] = [
      { type: "tool_call_start", index: 0, id: "m", name: "mcp__db__drop_table" },
      { type: "tool_call_delta", index: 0, delta: "{}" },
      { type: "tool_call_end", index: 0 },
    ];
    const { agent, history } = buildHarness({
      tools: [new McpTool("db", { name: "drop_table" }, client)],
      chunks: [call, [{ type: "text", content: "I did not run it" }]],
    });

    await agent.send("drop it"); // default mode = Analyze

    expect(called).toBe(false); // NOT executed
    const refusal = history.all().find((m) => m.role === "tool")?.content ?? "";
    expect(refusal).toContain("db"); // names the server
    expect(refusal).toContain("readOnlyHint"); // says WHY
    expect(refusal).toContain("Build"); // and what to do about it
  });

  it("runs an MCP tool in Analyze once the USER declares its server read-only", async () => {
    let called = false;
    const client = {
      callTool: async () => {
        called = true;
        return { text: "rows", isError: false };
      },
    } as unknown as import("../mcp/mcp-client").McpStdioClient;
    const call: StreamChunk[] = [
      { type: "tool_call_start", index: 0, id: "m", name: "mcp__db__read_query" },
      { type: "tool_call_delta", index: 0, delta: "{}" },
      { type: "tool_call_end", index: 0 },
    ];
    const { agent } = buildHarness({
      // The declaration is read LIVE: the tool asks the config on every access.
      tools: [new McpTool("db", { name: "read_query" }, client, () => "read-only")],
      chunks: [call, [{ type: "text", content: "ok" }]],
    });

    await agent.send("count the rows");

    expect(called).toBe(true);
  });

  it("runs it in Analyze when THIS SESSION declares that one tool read-only — the server says nothing", async () => {
    // The per-TOOL declaration is the session's (ToolScope.analyze): the registry is global, so the
    // tool itself cannot answer it, and `analyzePolicyFor` overlays the session where it is known.
    let called = false;
    const client = {
      callTool: async () => {
        called = true;
        return { text: "rows", isError: false };
      },
    } as unknown as import("../mcp/mcp-client").McpStdioClient;
    const call: StreamChunk[] = [
      { type: "tool_call_start", index: 0, id: "m", name: "mcp__db__read_query" },
      { type: "tool_call_delta", index: 0, delta: "{}" },
      { type: "tool_call_end", index: 0 },
    ];
    const { agent } = buildHarness({
      tools: [new McpTool("db", { name: "read_query" }, client)], // the server declares nothing
      chunks: [call, [{ type: "text", content: "ok" }]],
      toolScope: () => ({ mcp: ["db"], off: [], analyze: ["mcp__db__read_query"] }),
    });

    await agent.send("count the rows");

    expect(called).toBe(true);
  });

  it("…and still REFUSES the tools that same session did not name, in the SAME server", async () => {
    // An include list, tool by tool: allowing `read_query` here must not open `drop_table` — the
    // whole point of the narrowest statement, which is now per conversation.
    let called = false;
    const client = {
      callTool: async () => {
        called = true;
        return { text: "dropped", isError: false };
      },
    } as unknown as import("../mcp/mcp-client").McpStdioClient;
    const call: StreamChunk[] = [
      { type: "tool_call_start", index: 0, id: "m", name: "mcp__db__drop_table" },
      { type: "tool_call_delta", index: 0, delta: "{}" },
      { type: "tool_call_end", index: 0 },
    ];
    const { agent, history } = buildHarness({
      tools: [new McpTool("db", { name: "read_query" }, client), new McpTool("db", { name: "drop_table" }, client)],
      chunks: [call, [{ type: "text", content: "I did not run it" }]],
      toolScope: () => ({ mcp: ["db"], off: [], analyze: ["mcp__db__read_query"] }),
    });

    await agent.send("drop it");

    expect(called).toBe(false);
    const refusal = history.all().find((m) => m.role === "tool")?.content ?? "";
    expect(refusal).toContain("mcp__db__drop_table");
    expect(refusal).toContain("Analyze"); // the mode is named, not just "denied"
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
        systemPrompt: new DefaultSystemPromptBuilder(
          () => tools.definitions(),
          () => "/w",
        ),
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
      tools: [previewTool("Edit")],
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
      tools: [previewTool("Edit")],
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
    const final = history
      .all()
      .filter((m) => m.role === "assistant")
      .at(-1);
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
      tools: [previewTool("Write")],
      chunks: writeChunks,
      onFileChanged: (c) => changes.push(c),
    });
    agent.setMode("agent");
    await agent.send("write it");
    expect(changes).toEqual([{ path: "a.ts", tool: "Write" }]);

    // Analyze: the same tool runs as a PREVIEW → no file-change event.
    const previews: { path: string; tool: string }[] = [];
    const { agent: a2 } = buildHarness({
      tools: [previewTool("Write")],
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
    const refused = history
      .all()
      .filter((m) => m.role === "tool" && /already failed and was NOT re-run/.test(m.content));
    expect(refused.length).toBeGreaterThanOrEqual(2);
  });

  it("with Loop Guard OFF a repeated failing call is RE-RUN, with no nudge and no stop", async () => {
    let runs = 0;
    const failing: Tool = {
      name: "Read",
      definition: { name: "Read", description: "read", parameters: { type: "object", properties: {} } },
      analyzePolicy: "read-only",
      execute: (): ToolResult => {
        runs++;
        return { content: "boom", isError: true };
      },
    };
    const call = (id: string): StreamChunk[] => [
      { type: "tool_call_start", index: 0, id, name: "Read" },
      { type: "tool_call_end", index: 0 },
    ];
    const { agent, events, history } = buildHarness({
      tools: [failing],
      chunks: [call("c1"), call("c2"), call("c3")],
      maxTurns: 6,
      loopGuard: resolveLoopGuardOptions("off"),
    });

    await agent.send("x");

    // Off = nothing is refused and nothing escalates: the same failing call ran on EVERY turn
    // (the fake LLM keeps repeating it until maxTurns) instead of being refused after the first.
    expect(runs).toBeGreaterThanOrEqual(3);
    expect(history.all().some((m) => /already failed and was NOT re-run/.test(m.content))).toBe(false);
    expect(history.all().some((m) => m.role === "user" && /SAME arguments/.test(m.content))).toBe(false);
    expect(events.some((e) => e.type === "loop_intervention")).toBe(false);
    const error = events.find((e) => e.type === "error");
    expect(error && error.type === "error" ? error.error : "").not.toContain("Loop not resolved");
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
        [
          { type: "tool_call_start", index: 0, id: "c1", name: "FakeTool" },
          { type: "tool_call_end", index: 0 },
        ],
        [
          { type: "tool_call_start", index: 0, id: "c2", name: "FakeTool" },
          { type: "tool_call_end", index: 0 },
        ],
        [
          { type: "tool_call_start", index: 0, id: "c3", name: "FakeTool" },
          { type: "tool_call_end", index: 0 },
        ],
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
        [
          { type: "tool_call_start", index: 0, id: "a1", name: "A" },
          { type: "tool_call_end", index: 0 },
        ],
        [
          { type: "tool_call_start", index: 0, id: "b1", name: "B" },
          { type: "tool_call_end", index: 0 },
        ],
        [
          { type: "tool_call_start", index: 0, id: "c1", name: "C" },
          { type: "tool_call_end", index: 0 },
        ],
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
    const systemPrompt = new DefaultSystemPromptBuilder(
      () => [],
      () => "/workspace",
    );
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
    const assistants = history
      .all()
      .filter((m) => m.role === "assistant")
      .map((m) => m.content);
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

  it("survives a tool vanishing MID-RUN: the call fails as a result, the turn goes on", async () => {
    // The real race: the MCP server is removed from the config while a turn is in flight, the
    // manager reconnects and the tool is gone from the registry — but the model already has it in
    // the list it was given. The requirement is that nothing throws and the model can recover,
    // not that the tool call silently "works".
    const registry = new ToolRegistry([makeTool("Read"), makeTool("mcp__files__read")]);
    const events: AgentEvent[] = [];
    const seenDefinitions: string[][] = [];
    let calls = 0;
    const factory: LLMProviderFactory = {
      create: () => ({
        protocol: "chat" as const,
        async *stream(_m: LLMMessage[], _s?: AbortSignal, defs?: ToolDefinition[]) {
          seenDefinitions.push((defs ?? []).map((d) => d.name));
          calls++;
          if (calls === 1) {
            // The config watcher fires HERE: the server is gone before the call executes.
            registry.removeByPrefix("mcp__");
            yield { type: "tool_call_start", index: 0, id: "c1", name: "mcp__files__read" } as StreamChunk;
            yield { type: "tool_call_end", index: 0 } as StreamChunk;
            return;
          }
          yield { type: "text", content: "recovered" } as StreamChunk;
        },
      }),
    };
    const bus = new InMemoryEventBus<AgentEvent>();
    bus.subscribe((e) => events.push(e));
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: factory,
      tools: registry,
      history: new InMemoryChatHistory(),
      events: bus,
      systemPrompt: new DefaultSystemPromptBuilder(
        (m) => toolDefinitionsForMode(registry.getAll(), m),
        () => "/w",
      ),
      toolScope: () => ({ mcp: ["files"], off: [] }),
    });
    agent.setMode("agent");

    await expect(agent.send("go")).resolves.toBeUndefined();

    const result = events.find((e) => e.type === "tool_result") as {
      toolResult?: { output?: string; isError?: boolean };
    };
    expect(result?.toolResult?.output ?? "").toContain("Unknown tool: mcp__files__read");
    expect(result?.toolResult?.isError).toBe(true);
    // The turn CONTINUED: the model was called a SECOND time with the failure in hand (the loop
    // did not abort on a tool that no longer exists).
    expect(seenDefinitions.length).toBe(2);
    // …and the next turn is not offered the tool any more.
    expect(seenDefinitions[1]).not.toContain("mcp__files__read");
  });

  it("advertises ONLY what the session allows — and picks up a change on the NEXT turn", async () => {
    // The per-session scope is read at every turn (this is what makes "switch it off and the
    // session stops using it" true without reconnecting anything).
    const tools: Tool[] = [
      makeTool("Read"),
      makeTool("Shell"),
      makeTool("mcp__files__read"),
      makeTool("mcp__git__log"),
    ];
    let scope: ToolScope | undefined = { mcp: ["files"], off: [] };
    const registry = new ToolRegistry(tools);
    const seen: string[][] = [];
    const factory: LLMProviderFactory = {
      create: () => ({
        protocol: "chat" as const,
        async *stream(_m: LLMMessage[], _s?: AbortSignal, defs?: ToolDefinition[]) {
          seen.push((defs ?? []).map((d) => d.name));
          yield { type: "text", content: "ok" } as StreamChunk;
        },
      }),
    };
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: factory,
      tools: registry,
      history: new InMemoryChatHistory(),
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(
        (m) => toolDefinitionsForMode(registry.getAll(), m),
        () => "/w",
      ),
      toolScope: () => scope,
    });
    agent.setMode("agent");

    await agent.send("one");
    expect(seen[0].sort()).toEqual(["Read", "Shell", "mcp__files__read"]); // git is off

    // The user switches `git` on and `Shell` off: the SAME agent, no restart.
    scope = { mcp: ["files", "git"], off: ["Shell"] };
    await agent.send("two");
    expect(seen[1].sort()).toEqual(["Read", "mcp__files__read", "mcp__git__log"]);

    // …and a session with NO scope declared keeps everything (a conversation from before this).
    scope = undefined;
    await agent.send("three");
    expect(seen[2].sort()).toEqual(["Read", "Shell", "mcp__files__read", "mcp__git__log"]);
  });

  it("advertises the SAME tool set in both modes; Analyze tags Shell read-only and writers as previews", async () => {
    // Built as the REAL tools declare themselves: the notes come from the declarations
    // (Shell's from the real tool), not from a name list in the policy module.
    const tools: Tool[] = [
      makeTool("Read"),
      previewTool("Write"),
      previewTool("Edit"),
      previewTool("Delete"),
      previewTool("StrReplace"),
      shellTool(async () => ({ stdout: "", stderr: "", code: 0, timedOut: false })),
      makeTool("Grep"),
    ];
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
      ...previewTool("Write"),
      execute: vi.fn(async (): Promise<ToolResult> => ({
        content: "PROPOSED (preview — NOT written): a.txt",
        isError: false,
      })),
    };
    const { agent, history } = capturingHarness(
      [writeTool],
      [toolCallChunksFromJson("c1", "Write", '{"path":"a.txt","content":"x"}'), [{ type: "text", content: "ok" }]],
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
    const writeTool = {
      ...previewTool("Write"),
      execute: vi.fn(async (): Promise<ToolResult> => ({ content: "wrote", isError: false })),
    };
    const { agent, history } = capturingHarness(
      [writeTool],
      [toolCallChunksFromJson("c1", "Write", '{"path":"a.txt","content":"x"}'), [{ type: "text", content: "ok" }]],
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
    // The REAL tool: the Analyze allowlist is part of it (guardAnalyze), so nothing is
    // re-implemented here — the fake runner is the only stand-in.
    const run = vi.fn(async () => ({ stdout: "ran", stderr: "", code: 0, timedOut: false }));
    const shell = new ShellTool({ run }, () => "/workspace");
    const { agent } = capturingHarness(
      [shell],
      [toolCallChunksFromJson("c1", "Shell", '{"command":"rm -rf /tmp/x"}'), [{ type: "text", content: "ok" }]],
    );
    await agent.send("delete temp");
    expect(run).not.toHaveBeenCalled(); // refused BEFORE running anything

    const { agent: agent2, history: history2 } = capturingHarness(
      [shell, makeTool("Read")],
      [toolCallChunksFromJson("c1", "Shell", '{"command":"ls -la"}'), [{ type: "text", content: "ok" }]],
    );
    await agent2.send("list files");
    expect(run).toHaveBeenCalledTimes(1); // the read-only command DID run
    expect(history2.all().find((m) => m.role === "tool")?.content).toBe("ran");
  });

  it("keeps read tools fully functional in analyze mode", async () => {
    const readTool = makeTool("Read", { content: "contents", isError: false });
    const { agent, history } = capturingHarness(
      [readTool],
      [toolCallChunksFromJson("c1", "Read", '{"path":"a.ts"}'), [{ type: "text", content: "ok" }]],
    );

    await agent.send("read the file");

    expect(readTool.called).toBe(true);
    expect(history.all().find((m) => m.role === "tool")?.content).toBe("contents");
  });

  it("appends an explicit 'nothing applied / switch to Build' footer when previews were prepared", async () => {
    const { agent, history } = capturingHarness(
      [previewTool("Edit"), makeTool("Read")],
      [
        toolCallChunksFromJson("c1", "Edit", '{"path":"a.ts","edits":[{"oldText":"x","newText":"y"}]}'),
        [{ type: "text", content: "I fixed the bug for you." }],
      ],
      "analyze",
    );

    await agent.send("fix it");

    const final = history
      .all()
      .filter((m) => m.role === "assistant")
      .at(-1);
    expect(final?.content).toContain("I fixed the bug for you.");
    expect(final?.content).toContain("Nothing has been applied");
    expect(final?.content).toContain("previews");
    expect(final?.content).toContain("Switch to **Build**");
  });

  it("lists WHAT needs Build in the preview footer", async () => {
    const { agent, history } = capturingHarness(
      [previewTool("Edit"), previewTool("Write")],
      [
        toolCallChunksFromJson("c1", "Edit", '{"path":"src/a.ts","edits":[]}'),
        toolCallChunksFromJson("c1", "Write", '{"path":"src/b.ts","contents":"x"}'),
        [{ type: "text", content: "Prepared the changes." }],
      ],
      "analyze",
    );

    await agent.send("do it");

    const final = history
      .all()
      .filter((m) => m.role === "assistant")
      .at(-1);
    expect(final?.content).toContain("Edit `src/a.ts`");
    expect(final?.content).toContain("Write `src/b.ts`");
    expect(final?.content).toContain("Switch to **Build**");
  });

  it("does not duplicate the footer when the model already told the user to switch", async () => {
    const { agent, history } = capturingHarness(
      [previewTool("Edit")],
      [
        toolCallChunksFromJson("c1", "Edit", '{"path":"a.ts","edits":[{"oldText":"x","newText":"y"}]}'),
        [{ type: "text", content: `Done.\n\n${BUILD_SWITCH_HINT}` }],
      ],
      "analyze",
    );

    await agent.send("fix it");

    const final = history
      .all()
      .filter((m) => m.role === "assistant")
      .at(-1);
    const occurrences = (final?.content.match(/Switch to \*\*Build\*\*/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("does not add the preview footer in Build mode", async () => {
    const { agent, history } = capturingHarness(
      [previewTool("Edit")],
      [
        toolCallChunksFromJson("c1", "Edit", '{"path":"a.ts","edits":[]}'),
        [{ type: "text", content: "Applied the change." }],
      ],
      "agent",
    );

    await agent.send("fix it");

    const final = history
      .all()
      .filter((m) => m.role === "assistant")
      .at(-1);
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

    const final = history
      .all()
      .filter((m) => m.role === "assistant")
      .at(-1);
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

    const final = history
      .all()
      .filter((m) => m.role === "assistant")
      .at(-1);
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
    const tools: Tool[] = [
      makeTool("Read"),
      previewTool("Write"),
      shellTool(async () => ({ stdout: "", stderr: "", code: 0, timedOut: false })),
    ];
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
      systemPrompt: new DefaultSystemPromptBuilder(
        () => tools.definitions(),
        () => "/w",
      ),
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
    const systemPrompt = new DefaultSystemPromptBuilder(
      () => tools.definitions(),
      () => "/w",
    );
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

    const final = history
      .all()
      .filter((m) => m.role === "assistant")
      .at(-1);
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
      systemPrompt: new DefaultSystemPromptBuilder(
        () => tools.definitions(),
        () => "/w",
      ),
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
      systemPrompt: new DefaultSystemPromptBuilder(
        () => tools.definitions(),
        () => "/w",
      ),
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
      systemPrompt: new DefaultSystemPromptBuilder(
        () => tools.definitions(),
        () => "/w",
      ),
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
      systemPrompt: new DefaultSystemPromptBuilder(
        () => tools.definitions(),
        () => "/w",
      ),
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
      systemPrompt: new DefaultSystemPromptBuilder(
        () => tools.definitions(),
        () => "/w",
      ),
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
      systemPrompt: new DefaultSystemPromptBuilder(
        () => tools.definitions(),
        () => "/w",
      ),
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
      systemPrompt: new DefaultSystemPromptBuilder(
        () => tools.definitions(),
        () => "/w",
      ),
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
    const factory = fakeFactory(delegateTurn([{ id: "a", goal: "describe docs", access: "read", resources: ["."] }]), [
      { type: "text", content: "done" },
    ]);
    const tools = new ToolRegistry([makeTool("Delegate"), makeTool("Read")]);
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: factory,
      tools,
      history: new InMemoryChatHistory(),
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(
        () => tools.definitions(),
        () => "/w",
      ),
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
      systemPrompt: new DefaultSystemPromptBuilder(
        () => tools.definitions(),
        () => "/w",
      ),
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

  it("a Stop while the request is QUEUED behind the global cap ends like a Stop: done, no phantom error", async () => {
    // The global cap (core/llm/concurrency.ts) rejects a QUEUED request with an
    // AbortError when the run is stopped. The agent classifies errors by NAME
    // (`err.name === "AbortError"` → done), so the two modules are coupled by a string:
    // if that name ever changes, a normal Stop turns into a red "provider failed"
    // bubble. This test is the handshake.
    const sem = new Semaphore(1);
    const hold = await sem.acquire(); // the only slot is taken: the next request waits
    const { agent, events } = buildHarness({
      llmFactory: limitLlmFactory(fakeFactory([{ type: "text", content: "never" }]), sem),
    });

    const running = agent.send("go");
    // The request is parked in the queue, not in flight: exactly the fragile window.
    await vi.waitFor(() => expect(sem.queued).toBe(1));
    agent.abort();
    await running;

    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(events.some((e) => e.type === "done")).toBe(true);
    hold();
    expect(sem.inFlight).toBe(0);
    expect(sem.queued).toBe(0);
  });

  it("abort() cascades to the sub-agents via onAbort", () => {
    let called = false;
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: fakeFactory([{ type: "text", content: "ok" }]),
      tools: new ToolRegistry([makeTool("Read")]),
      history: new InMemoryChatHistory(),
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(
        () => [],
        () => "/w",
      ),
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
    const calls = ["A", "B", "C"].map((id, i) => ({
      id,
      goal: id,
      access: "read",
      resources: [`${i}.ts`],
      parallel: "yes",
    }));
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
    const calls = ["A", "B", "C", "D", "E", "F"].map((id, i) => ({
      id,
      goal: id,
      access: "read",
      resources: [`${i}.ts`],
      parallel: "yes",
    }));
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
    const calls = ["A", "B", "C", "D", "E", "F"].map((id, i) => ({
      id,
      goal: id,
      access: "read",
      resources: [`${i}.ts`],
      parallel: "yes",
    }));
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
    expect(history.all().some((m) => m.role === "tool" && /aborted before running/i.test(m.content ?? ""))).toBe(true);
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
      systemPrompt: new DefaultSystemPromptBuilder(
        () => tools.definitions(),
        () => "/w",
      ),
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
      llmFactory: fakeFactory(delegateTurn([{ id: "A", goal: "x", access: "read", resources: ["a.ts"] }]), [
        { type: "text", content: "ok" },
      ]),
      tools: new ToolRegistry([makeTool("Read")]),
      history,
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(
        () => [],
        () => "/w",
      ),
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
      systemPrompt: new DefaultSystemPromptBuilder(
        () => [],
        () => "/w",
      ),
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
      systemPrompt: new DefaultSystemPromptBuilder(
        () => [],
        () => "/w",
      ),
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
      systemPrompt: new DefaultSystemPromptBuilder(
        () => [],
        () => "/w",
      ),
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
      systemPrompt: new DefaultSystemPromptBuilder(
        () => [],
        () => "/w",
      ),
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
      chunks: [toolCall(), [{ type: "text", content: "done" }], [{ type: "text", content: "second" }]],
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
        agent.steer("s1", "look here", { images, attachments, displayText: "look here" });
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
      chunks: [[{ type: "text", content: "first answer" }], [{ type: "text", content: "corrected answer" }]],
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

  it("records the mode each RUN ran under — the switch is pending until the next one", async () => {
    // Mode and Parallel are decided once per run (see runMode), so every turn of a run
    // carries the same mode, and the NEXT run carries whatever was picked while the
    // previous one was working. This meta is what the badge under each answer reads.
    let agentRef: Agent | undefined;
    const write: Tool = {
      name: "Write",
      definition: { name: "Write", description: "write", parameters: { type: "object", properties: {} } },
      analyzePolicy: "preview",
      analyzeNote: FILE_PREVIEW_NOTE,
      execute: () => {
        agentRef?.setMode("agent"); // the user flips to Build while the turn runs
        return { content: "PROPOSED (preview)", isError: false };
      },
    };
    const { agent, history } = buildHarness({
      tools: [write],
      chunks: [
        [
          { type: "tool_call_start", index: 0, id: "w1", name: "Write" },
          { type: "tool_call_delta", index: 0, delta: '{"path":"a.ts","content":"x"}' },
          { type: "tool_call_end", index: 0 },
        ],
        [{ type: "text", content: "done" }],
      ],
    });
    agentRef = agent;

    await agent.send("go"); // run 1 starts in Analyze
    await agent.send("again"); // run 2 starts in Build (the switch during run 1 was pending)

    const assistants = history.all().filter((m) => m.role === "assistant" && m.meta);
    expect(assistants.map((m) => m.meta!.mode)).toEqual(["analyze", "analyze", "agent"]);
  });

  it("emits a turn_meta event with the REAL metrics as soon as a turn is committed", async () => {
    const { agent, events } = buildHarness({
      chunks: [
        [
          { type: "text", content: "hi" },
          { type: "usage", usage: { input: 1000, output: 10, total: 1010 } },
        ],
      ],
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

describe("tool context wiring", () => {
  it("hands the tool the session's usable window, so big output is capped to the model", async () => {
    // The wiring that makes output-budget.ts work end to end: the agent fills
    // ctx.contextBudget on EVERY tool call (a tool cannot know the model).
    let seen: number | undefined;
    const spy: Tool = {
      name: "SpyTool",
      definition: { name: "SpyTool", description: "spy", parameters: { type: "object", properties: {} } },
      analyzePolicy: "read-only", // fixture: an inert tool, and the run is in the default mode
      execute: (_args, ctx) => {
        seen = ctx?.contextBudget;
        return { content: "ok", isError: false };
      },
    };
    const { agent } = buildHarness({
      tools: [spy],
      contextBudget: () => 12_345,
      // The model must actually CALL the tool, otherwise nothing is executed.
      chunks: [
        [
          { type: "tool_call_start", index: 0, id: "c1", name: "SpyTool" },
          { type: "tool_call_delta", index: 0, delta: "{}" },
          { type: "tool_call_end", index: 0 },
        ],
        [{ type: "text", content: "done" }],
      ],
    });

    await agent.send("go");

    expect(seen).toBe(12_345);
  });
});

describe("context-overflow recovery (cross-provider)", () => {
  /** A factory that rejects the FIRST request with `boom` and answers later. */
  function flakyFactory(boom: string | undefined, answer = "recovered") {
    const requests: unknown[][] = [];
    const factory = {
      create: () => ({
        protocol: "chat" as const,
        async *stream(messages: unknown[]) {
          requests.push(messages);
          if (requests.length === 1 && boom) throw new Error(boom);
          yield { type: "text", content: answer };
        },
      }),
    } as unknown as ReturnType<typeof fakeFactory>;
    return { factory, requests };
  }

  const OPENAI_OVERFLOW =
    'OpenAI API error 400: {"error":{"message":"This model\'s maximum context length is 128000 tokens. ' +
    'However, your messages resulted in 130000 tokens.","code":"context_length_exceeded"}}';

  function build(opts: {
    factory: ReturnType<typeof fakeFactory>;
    onContextOverflow?: (signal: AbortSignal, evidence: ContextOverflowEvidence) => boolean;
    contextBudget?: () => number;
  }) {
    const history = new InMemoryChatHistory();
    const tools = new ToolRegistry([makeTool("FakeTool")]);
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: opts.factory,
      tools,
      history,
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(
        () => tools.definitions(),
        () => "/workspace",
      ),
      ...(opts.onContextOverflow ? { onContextOverflow: opts.onContextOverflow } : {}),
      ...(opts.contextBudget ? { contextBudget: opts.contextBudget } : {}),
    });
    return { agent, history };
  }

  it("compacts and retries the SAME turn when the provider says the input is too big", async () => {
    const { factory, requests } = flakyFactory(OPENAI_OVERFLOW);
    let compactions = 0;
    const evidences: ContextOverflowEvidence[] = [];
    const { agent, history } = build({
      factory,
      onContextOverflow: (_signal, evidence) => {
        compactions++;
        evidences.push(evidence);
        // What the host does: the history really shrinks (that is what makes a
        // retry meaningful).
        history.replace([
          { role: "user", content: "summary of past work", timestamp: 1 },
          { role: "assistant", content: "noted", timestamp: 2 },
        ]);
        return true;
      },
    });

    await agent.send("go");

    expect(compactions).toBe(1); // asked the host exactly once
    expect(requests).toHaveLength(2); // …and sent the same turn again
    // The host is told WHAT the rejection revealed: the wording family, and the
    // limit the provider itself stated (so it can adopt the real window).
    expect(evidences).toEqual([{ signature: "OpenAI error code", limitTokens: 128000 }]);
    // The retry went out with the COMPACTED history, not the one that was rejected.
    expect(requests[1].some((m: any) => m.content === "summary of past work")).toBe(true);
    // The run finished normally: the user sees an answer, not an error.
    expect(history.all().some((m) => m.role === "assistant" && m.content === "recovered")).toBe(true);
  });

  it("does NOT compact on an unrelated rejection (no false recovery)", async () => {
    const { factory, requests } = flakyFactory(
      'OpenAI API error 400: {"error":{"message":"Invalid schema for function Shell"}}',
    );
    let compactions = 0;
    const { agent, history } = build({
      factory,
      onContextOverflow: () => {
        compactions++;
        return true;
      },
      // A REAL budget with a small history: our own estimate is nowhere near the
      // ceiling, so leg 2 cannot fire either. (With an absurdly small budget ANY
      // request would look "full", which is the scenario the other test covers.)
      contextBudget: () => 100_000,
    });

    await agent.send("go");

    expect(compactions).toBe(0);
    expect(requests).toHaveLength(1);
    expect(
      history
        .all()
        .map((m) => m.content ?? "")
        .join(" | "),
    ).toContain("Invalid schema");
  });

  it("recovers from a rejection we CANNOT read, when our own estimate says we were at the ceiling", async () => {
    // Leg 2 of the detection: no known wording, but the request we sent was full.
    // Without it, any backend phrasing the limit differently would still die.
    const { factory, requests } = flakyFactory('OpenAI API error 400: {"error":{"message":"eltilov erom"}}');
    let compactions = 0;
    const { agent } = build({
      factory,
      onContextOverflow: () => {
        compactions++;
        return true;
      },
      // 10 tokens of budget against a system prompt + history of hundreds: our own
      // estimate is far above 90% of it.
      contextBudget: () => 10,
    });

    await agent.send("go");

    expect(compactions).toBe(1);
    expect(requests).toHaveLength(2);
  });

  it("counts IMAGES, so a rejection at the real ceiling is still read as size", async () => {
    // Leg 2 answers "was the request we sent full?" — and it can only answer that if
    // the estimate covers what the request CARRIES. A screenshot travels as a data URI
    // that nothing charged for, so a session full of images reported itself as nearly
    // empty and an unreadable rejection at the true ceiling went unrecognised.
    //
    // The two runs differ by the images and NOTHING else, so the differential pins
    // them and cannot pass for some other reason.
    const budget = 20_000; // the leg fires at 90% = 18_000
    const run = async (images?: string[]) => {
      const { factory } = flakyFactory('OpenAI API error 400: {"error":{"message":"eltilov erom"}}');
      let compactions = 0;
      const { agent } = build({
        factory,
        onContextOverflow: () => {
          compactions++;
          return true;
        },
        contextBudget: () => budget,
      });
      await agent.send("go", images ? { images } : {});
      return compactions;
    };

    // A few thousand tokens of prompt and history: nowhere near the ceiling.
    expect(await run()).toBe(0);
    // Ten images add 10 × IMAGE_TOKENS, past 90% of the SAME budget.
    expect(await run(Array.from({ length: 10 }, () => "data:image/png;base64,AAAA"))).toBe(1);
  });

  it("does not retry when the host could not free anything (no pointless loop)", async () => {
    const { factory, requests } = flakyFactory(OPENAI_OVERFLOW);
    let compactions = 0;
    const { agent } = build({
      factory,
      onContextOverflow: () => {
        compactions++;
        return false; // nothing to summarize: the same request would fail again
      },
    });

    await agent.send("go");

    expect(compactions).toBe(1);
    expect(requests).toHaveLength(1); // no blind retry
  });

  it("never treats a network failure as an overflow, even with a full context", async () => {
    const { factory, requests } = flakyFactory("fetch failed: connect ECONNREFUSED");
    let compactions = 0;
    const { agent } = build({
      factory,
      onContextOverflow: () => {
        compactions++;
        return true;
      },
      contextBudget: () => 10,
    });

    await agent.send("go");

    expect(compactions).toBe(0);
    expect(requests).toHaveLength(1);
  });
});

describe("observation masking in the request", () => {
  const big = (tokens: number): string => "x".repeat(tokens * 4);

  function buildRequestRecorder(contextBudget?: () => number) {
    const seen: any[][] = [];
    const factory = {
      create: () => ({
        protocol: "chat" as const,
        async *stream(messages: any[]) {
          seen.push(messages);
          yield { type: "text", content: "ok" };
        },
      }),
    } as unknown as ReturnType<typeof fakeFactory>;
    const history = new InMemoryChatHistory();
    const tools = new ToolRegistry([makeTool("FakeTool")]);
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: factory,
      tools,
      history,
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt: new DefaultSystemPromptBuilder(
        () => tools.definitions(),
        () => "/workspace",
      ),
      ...(contextBudget ? { contextBudget } : {}),
    });
    return { agent, history, seen };
  }

  const twoToolTurns = (): ChatMessage[] => [
    { role: "user", content: "go", timestamp: 1 },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "Shell", arguments: {} }], timestamp: 2 },
    { role: "tool", content: big(5000), toolCallId: "c1", timestamp: 3 },
    { role: "assistant", content: "done", timestamp: 4 },
    { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "Shell", arguments: {} }], timestamp: 5 },
    { role: "tool", content: big(5000), toolCallId: "c2", timestamp: 6 },
  ];

  it("sends the NEWEST tool output verbatim and stubs the older ones", async () => {
    // A small model: the budget forces the OLD result into a stub.
    const { agent, history, seen } = buildRequestRecorder(() => 32_000);
    history.replace(twoToolTurns());

    await agent.send("again");

    const request = seen[seen.length - 1];
    const toolMsgs = request.filter((m: any) => m.role === "tool");
    // The newest output (c2) is what the model is working on: verbatim.
    expect(String(toolMsgs[toolMsgs.length - 1].content)).toBe(big(5000));
    // The older one is a stub, and it says which tool produced it…
    expect(String(toolMsgs[0].content)).toContain("masked to save context");
    expect(String(toolMsgs[0].content)).toContain("Shell");
    // …while the STORED history keeps everything (the transcript is untouched).
    expect(history.all().find((m) => m.toolCallId === "c1")?.content).toBe(big(5000));
  });

  it("changes nothing when there is no budget (feature off)", async () => {
    const { agent, history, seen } = buildRequestRecorder();
    history.replace(twoToolTurns());

    await agent.send("again");

    expect(seen[seen.length - 1].some((m: any) => String(m.content).includes("masked"))).toBe(false);
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

  it("a Stop while a tool runs leaves a conversation the provider still accepts", async () => {
    // A tool that runs until the RUN is aborted: the Shell-in-flight case.
    let started: () => void = () => {};
    const toolStarted = new Promise<void>((r) => (started = r));
    const blocking: Tool = {
      name: "Shell",
      definition: { name: "Shell", description: "shell", parameters: { type: "object", properties: {} } },
      analyzePolicy: "read-only", // fixture for the ABORT path, not the Shell policy
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
      systemPrompt: new DefaultSystemPromptBuilder(
        () => tools.definitions(),
        () => "/workspace",
      ),
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
    expect(conversationFaults(history.all())).toEqual([]);
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
      systemPrompt: new DefaultSystemPromptBuilder(
        () => tools.definitions(),
        () => "/workspace",
      ),
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

  it("a tool that returns NOTHING still stores a non-blank result (rule 5)", async () => {
    // `grep` with no match, `mkdir -p`, a silent command: all legally return "".
    // A blank `tool` message is rejected by strict servers and tells the model
    // nothing, so the agent normalizes it at the single point every result passes.
    const silent: Tool = {
      name: "Shell",
      definition: { name: "Shell", description: "shell", parameters: { type: "object", properties: {} } },
      analyzePolicy: "read-only", // fixture for the blank-result rule, not the Shell policy
      execute: () => ({ content: "", isError: false }),
    };
    const factory = recordingFactory([
      toolCallChunks("call_1", "Shell", { command: "true" }),
      [{ type: "text", content: "done" }],
    ]);
    const history = new InMemoryChatHistory();
    const events = new InMemoryEventBus<AgentEvent>();
    const tools = new ToolRegistry([silent]);
    const agent = new Agent({
      config: new StaticConfigProvider(VALID_CONFIG),
      llmFactory: factory,
      tools,
      history,
      events,
      systemPrompt: new DefaultSystemPromptBuilder(
        () => tools.definitions(),
        () => "/workspace",
      ),
    });
    agent.setMode("agent");

    await agent.send("go");

    const stored = history.all().find((m) => m.role === "tool");
    expect(stored?.content).toBe("Shell: no output");
    // …and the whole conversation is still valid (nothing to refuse).
    expect(conversationFaults(history.all())).toEqual([]);
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
      systemPrompt: new DefaultSystemPromptBuilder(
        () => tools.definitions(),
        () => "/workspace",
      ),
    });
    agent.setMode("agent");

    await agent.send("go");

    // The full round trip (call → result → final answer) reached the provider
    // twice, and the stored history is valid.
    expect(factory.requests).toHaveLength(2);
    expect(conversationFaults(history.all())).toEqual([]);
  });
});
