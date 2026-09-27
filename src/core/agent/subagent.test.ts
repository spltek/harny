import { describe, expect, it } from "vitest";
import { SubAgentRunner, lastAssistantReport, toSubAgentEvent } from "./subagent";
import { StaticConfigProvider } from "../config/static-config-provider";
import { ToolRegistry } from "../tools/tool-registry";
import type { Tool, ToolResult } from "../tools/tool";
import type { HarnyConfig } from "../config/types";
import type { LLMMessage, LLMProviderFactory, StreamChunk } from "../llm/types";
import type { ChatMessage } from "../history/types";
import type { SubAgentEvent } from "./types";
import type { DelegateSpec } from "./orchestration";

const CONFIG: HarnyConfig = {
  provider: "openai",
  apiKey: "sk-test",
  baseUrl: "https://api.openai.com",
  model: "gpt-4o",
  maxTokens: 4096,
  temperature: 0.1,
  thinkingLevel: "off",
  contextFiles: true,
  autoApprove: false,
  autoOpen: false,
};

/** Factory that yields the given chunk batches per successive stream call. */
function factory(batches: StreamChunk[][]): LLMProviderFactory {
  let calls = 0;
  return {
    create() {
      return {
        protocol: "chat" as const,
        async *stream() {
          const batch = batches[Math.min(calls, batches.length - 1)];
          calls++;
          for (const c of batch) yield c;
        },
      };
    },
  };
}

function spec(partial: Partial<DelegateSpec>): DelegateSpec {
  return {
    id: "A",
    goal: "do the thing",
    access: "read",
    resources: ["src/a.ts"],
    parallel: false,
    after: [],
    ...partial,
  };
}

function makeWriteTool(): Tool & { called: boolean; lastDryRun?: boolean } {
  const tool = {
    name: "Write",
    definition: { name: "Write", description: "write", parameters: { type: "object", properties: {} } },
    called: false,
    lastDryRun: undefined as boolean | undefined,
    execute: (_args: Record<string, unknown>, ctx?: { dryRun?: boolean }): ToolResult => {
      tool.called = true;
      tool.lastDryRun = ctx?.dryRun;
      return { content: "wrote", isError: false };
    },
  };
  return tool;
}

function writeCall(): StreamChunk[] {
  return [
    { type: "tool_call_start", index: 0, id: "c1", name: "Write" },
    { type: "tool_call_delta", index: 0, delta: '{"path":"a.ts","content":"x"}' },
    { type: "tool_call_end", index: 0 },
  ];
}

function buildRunner(llmFactory: LLMProviderFactory, tools: Tool[] = []) {
  return new SubAgentRunner({
    config: new StaticConfigProvider(CONFIG),
    llmFactory,
    tools: new ToolRegistry(tools),
    cwd: () => "/workspace",
  });
}

describe("SubAgentRunner", () => {
  it("runs the sub-agent and returns its final text as a wrapped report", async () => {
    const runner = buildRunner(factory([[{ type: "text", content: "I analysed a.ts; no issues." }]]));
    const res = await runner.run(spec({ id: "A", role: "analyst" }));
    expect(res.isError).toBe(false);
    expect(res.content).toBe('🔁 Sub-agent "A" [analyst] report:\nI analysed a.ts; no issues.');
  });

  it("read sub-agents are read-only: Write runs as a DRY-RUN preview (nothing written)", async () => {
    const write = makeWriteTool();
    const runner = buildRunner(factory([writeCall(), [{ type: "text", content: "report" }]]), [write]);
    const res = await runner.run(spec({ access: "read" }));
    expect(write.called).toBe(true);
    expect(write.lastDryRun).toBe(true);
    expect(res.content).toContain("report");
  });

  it("honours a custom turn budget from deps (and still returns a report)", async () => {
    const toolCall = (): StreamChunk[] => [
      { type: "tool_call_start", index: 0, id: "c1", name: "Read" },
      { type: "tool_call_delta", index: 0, delta: '{"path":"a.ts"}' },
      { type: "tool_call_end", index: 0 },
    ];
    const read: Tool = {
      name: "Read",
      definition: { name: "Read", description: "read", parameters: { type: "object", properties: {} } },
      execute: (): ToolResult => ({ content: "data", isError: false }),
    };
    const runner = new SubAgentRunner({
      config: new StaticConfigProvider(CONFIG),
      llmFactory: factory([toolCall(), toolCall(), [{ type: "text", content: "forced report" }]]),
      tools: new ToolRegistry([read]),
      cwd: () => "/workspace",
      maxTurns: 2,
    });

    const res = await runner.run(spec({ access: "read" }));

    // Budget exhausted → the forced final report turn still yields a report.
    expect(res.isError).toBe(false);
    expect(res.content).toContain("forced report");
  });

  it("uses the configured subagentMaxTurns as the turn budget", async () => {
    let systemPrompt = "";
    const captureFactory: LLMProviderFactory = {
      create() {
        return {
          protocol: "chat" as const,
          async *stream(messages: LLMMessage[]) {
            if (!systemPrompt) systemPrompt = String(messages[0]?.content ?? "");
            yield { type: "text", content: "report" };
          },
        };
      },
    };
    const runner = new SubAgentRunner({
      config: new StaticConfigProvider({ ...CONFIG, subagentMaxTurns: 7 }),
      llmFactory: captureFactory,
      tools: new ToolRegistry([]),
      cwd: () => "/workspace",
    });

    await runner.run(spec({ access: "read" }));

    expect(systemPrompt).toContain("BUDGET");
    expect(systemPrompt).toContain("7");
  });

  it("is UNBOUNDED by default (no turn cap, like the orchestrator)", async () => {
    let systemPrompt = "";
    const captureFactory: LLMProviderFactory = {
      create() {
        return {
          protocol: "chat" as const,
          async *stream(messages: LLMMessage[]) {
            if (!systemPrompt) systemPrompt = String(messages[0]?.content ?? "");
            yield { type: "text", content: "report" };
          },
        };
      },
    };
    const runner = new SubAgentRunner({
      config: new StaticConfigProvider(CONFIG),
      llmFactory: captureFactory,
      tools: new ToolRegistry([]),
      cwd: () => "/workspace",
    });

    await runner.run(spec({ access: "read" }));

    // No budget configured -> no BUDGET hint and no finite cap.
    expect(systemPrompt).not.toContain("BUDGET");
  });

  it("does not append the Analyze preview footer to a sub-agent report", async () => {
    const write: Tool = {
      name: "Write",
      definition: { name: "Write", description: "write", parameters: { type: "object", properties: {} } },
      execute: () => ({ content: "PROPOSED (preview — NOT written): x", isError: false }),
    };
    const runner = buildRunner(
      factory([writeCall(), [{ type: "text", content: "REPORT: done" }]]),
      [write],
    );

    const res = await runner.run(spec({ access: "read" }));

    expect(res.content).toContain("REPORT: done");
    // The preview footer is for the TOP-LEVEL answer only, never a report.
    expect(res.content).not.toContain("Nothing has been applied");
  });

  it("forwards its live events to the caller (nested streaming)", async () => {
    const runner = buildRunner(
      factory([[{ type: "thinking", content: "hmm" }], [{ type: "text", content: "report" }]]),
    );
    const seen: SubAgentEvent[] = [];

    const res = await runner.run(spec({ access: "read" }), (e) => seen.push(e));

    expect(seen.some((e) => e.type === "thinking_delta" && e.content === "hmm")).toBe(true);
    expect(seen.some((e) => e.type === "text_delta")).toBe(true);
    expect(seen.some((e) => e.type === "done")).toBe(true);
    expect(res.content).toContain("report");
  });

  it("recovers a sub-agent stuck repeating a tool call and returns its report", async () => {
    const read: Tool = {
      name: "Read",
      definition: { name: "Read", description: "read", parameters: { type: "object", properties: {} } },
      execute: (): ToolResult => ({ content: "data", isError: false }),
    };
    const sameCall = (): StreamChunk[] => [
      { type: "tool_call_start", index: 0, id: "c1", name: "Read" },
      { type: "tool_call_delta", index: 0, delta: '{"path":"a.ts"}' },
      { type: "tool_call_end", index: 0 },
    ];
    const runner = buildRunner(
      factory([sameCall(), sameCall(), sameCall(), [{ type: "text", content: "recovered report" }]]),
      [read],
    );

    const res = await runner.run(spec({ access: "read" }));

    expect(res.isError).toBe(false);
    expect(res.content).toContain("recovered report");
    expect(res.content).not.toContain("Loop detected");
  });

  it("write sub-agents can use Write (full agent mode)", async () => {
    const write = makeWriteTool();
    const runner = buildRunner(factory([writeCall(), [{ type: "text", content: "done writing" }]]), [write]);
    const res = await runner.run(spec({ access: "write", resources: ["a.ts"] }));
    expect(write.called).toBe(true);
    expect(res.content).toContain("done writing");
  });

  it("wraps a failing sub-agent as an error result", async () => {
    const failing: LLMProviderFactory = {
      create() {
        return {
          protocol: "chat" as const,
          async *stream(): AsyncGenerator<StreamChunk> {
            throw new Error("boom");
          },
        };
      },
    };
    // The Agent reports mid-run fetch errors into the transcript; the runner
    // still produces a report/error result without throwing.
    const res = await buildRunner(failing).run(spec({ id: "Z" }));
    expect(res.content).toContain('Sub-agent "Z"');
  });

  it("abortAll aborts the in-flight sub-agents", async () => {
    let aborted = false;
    const hanging: LLMProviderFactory = {
      create() {
        return {
          protocol: "chat" as const,
          async *stream(_m: LLMMessage[], signal?: AbortSignal): AsyncGenerator<StreamChunk> {
            await new Promise<void>((resolve) => {
              if (signal?.aborted) return resolve();
              signal?.addEventListener("abort", () => {
                aborted = true;
                resolve();
              });
            });
          },
        };
      },
    };
    const runner = buildRunner(hanging);
    const pending = runner.run(spec());
    // Give the run a tick to register as active, then abort everything.
    await Promise.resolve();
    expect(runner.activeCount).toBe(1);
    runner.abortAll();
    const res = await pending;
    expect(aborted).toBe(true);
    expect(runner.activeCount).toBe(0);
    // An aborted run is INTERRUPTED (an error result), never a plain report.
    expect(res.isError).toBe(true);
    expect(res.content).toContain("interrupted");
  });
});

describe("toSubAgentEvent", () => {
  it("keeps live events and drops usage / raw chunks", () => {
    expect(toSubAgentEvent({ type: "text_delta", content: "x" })).toEqual({ type: "text_delta", content: "x" });
    expect(toSubAgentEvent({ type: "usage", usage: {} as never })).toBeUndefined();
    expect(toSubAgentEvent({ type: "raw_chunk", chunk: "x", kind: "text" })).toBeUndefined();
  });
});

describe("lastAssistantReport", () => {
  it("returns the last visible assistant text with no pending tool calls", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go", timestamp: 1 },
      { role: "assistant", content: "🔧 Tool: Read", toolCalls: [{ id: "1", name: "Read", arguments: {} }], timestamp: 2 },
      { role: "tool", content: "data", toolCallId: "1", timestamp: 3 },
      { role: "assistant", content: "final report", timestamp: 4 },
    ];
    expect(lastAssistantReport(msgs)).toBe("final report");
  });

  it("falls back when there is no clean final message", () => {
    expect(lastAssistantReport([{ role: "user", content: "go", timestamp: 1 }])).toBe("(no report produced)");
  });
});
