import { describe, expect, it } from "vitest";
import { SubAgentRunner, SUBAGENT_REPORT_MARKER, lastAssistantReport, toSubAgentEvent } from "./subagent";
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
    expect(res.content).toContain('🔁 Sub-agent "A" [analyst] report:\nI analysed a.ts; no issues.');
    // Host-generated facts are appended after the prose.
    expect(res.content).toContain(SUBAGENT_REPORT_MARKER);
  });

  it("read sub-agents are read-only: Write runs as a DRY-RUN preview (nothing written)", async () => {
    const write = makeWriteTool();
    const runner = buildRunner(factory([writeCall(), [{ type: "text", content: "report" }]]), [write]);
    const res = await runner.run(spec({ access: "read" }));
    expect(write.called).toBe(true);
    expect(write.lastDryRun).toBe(true);
    expect(res.content).toContain("report");
  });

  it("forwards onPreviewPrepared when the sub-agent prepares an Analyze preview", async () => {
    const write = makeWriteTool();
    const runner = buildRunner(factory([writeCall(), [{ type: "text", content: "report" }]]), [write]);
    let previewed: { path: string; tool: string } | undefined;

    await runner.run(spec({ access: "read" }), undefined, undefined, undefined, (change) => {
      previewed = change;
    });

    expect(previewed).toEqual({ path: "a.ts", tool: "Write" });
  });

  it("appends a read-only escalation note when a READ sub-agent prepared previews", async () => {
    const write = makeWriteTool();
    const runner = buildRunner(factory([writeCall(), [{ type: "text", content: "report" }]]), [write]);

    const res = await runner.run(spec({ access: "read" }));

    expect(res.content).toContain("ran READ-ONLY");
    expect(res.content).toContain("a.ts");
    expect(res.content).toContain('access "write"');
  });

  it("does NOT append the escalation note to a WRITER sub-agent", async () => {
    const write = makeWriteTool();
    const runner = buildRunner(factory([writeCall(), [{ type: "text", content: "report" }]]), [write]);

    const res = await runner.run(spec({ access: "write", resources: ["a.ts"] }));

    expect(res.content).not.toContain("ran READ-ONLY");
  });

  it("appends a machine-readable footer with status + filesTouched (writer)", async () => {
    const write = makeWriteTool();
    const runner = buildRunner(factory([writeCall(), [{ type: "text", content: "report" }]]), [write]);

    const res = await runner.run(spec({ access: "write", resources: ["a.ts"] }));

    expect(res.content).toContain(SUBAGENT_REPORT_MARKER);
    const json = res.content.slice(res.content.indexOf(SUBAGENT_REPORT_MARKER) + SUBAGENT_REPORT_MARKER.length).trim();
    expect(JSON.parse(json)).toEqual({ status: "done", filesTouched: ["a.ts"], previews: [] });
  });

  it("marks a READ sub-agent that prepared previews as needs-write", async () => {
    const write = makeWriteTool();
    const runner = buildRunner(factory([writeCall(), [{ type: "text", content: "report" }]]), [write]);

    const res = await runner.run(spec({ access: "read" }));

    const json = res.content.slice(res.content.indexOf(SUBAGENT_REPORT_MARKER) + SUBAGENT_REPORT_MARKER.length).trim();
    expect(JSON.parse(json)).toEqual({ status: "needs-write", filesTouched: [], previews: ["a.ts"] });
  });

  it("marks an aborted sub-agent report as aborted", async () => {
    const runner = buildRunner(factory([[{ type: "text", content: "report" }]]));
    const c = new AbortController();
    c.abort();

    const res = await runner.run(spec({ access: "read" }), undefined, c.signal);

    expect(res.content).toContain('"status":"aborted"');
  });

  it("does not call onPreviewPrepared when the sub-agent prepares nothing", async () => {
    const runner = buildRunner(factory([[{ type: "text", content: "report" }]]));
    let previewed = false;

    await runner.run(spec({ access: "read" }), undefined, undefined, undefined, () => {
      previewed = true;
    });

    expect(previewed).toBe(false);
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

  it("forwards the delegate's resolved attachments to the sub-agent (text + images)", async () => {
    const seen: LLMMessage[][] = [];
    const captureFactory: LLMProviderFactory = {
      create() {
        return {
          protocol: "chat" as const,
          async *stream(messages: LLMMessage[]) {
            seen.push(messages);
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
    const withAttachments: DelegateSpec = {
      ...spec({ access: "read" }),
      images: ["data:image/png;base64,AAA"],
      attachmentText: 'Attached file "d.txt":\n```\nHELLO\n```',
    };

    await runner.run(withAttachments);

    const userMsg = seen[0].find((m) => m.role === "user");
    expect(String(userMsg?.content)).toContain("HELLO");
    expect(userMsg?.images).toEqual(["data:image/png;base64,AAA"]);
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

  it("breaks an ALTERNATING web loop (A/B/A/B) instead of looping forever", async () => {
    const fetched: string[] = [];
    const web: Tool = {
      name: "WebFetch",
      definition: { name: "WebFetch", description: "fetch", parameters: { type: "object", properties: {} } },
      execute: (args: Record<string, unknown>): ToolResult => {
        const url = String(args.url);
        fetched.push(url);
        return { content: `page ${url}`, isError: false };
      },
    };
    const webCall = (id: string, url: string): StreamChunk[] => [
      { type: "tool_call_start", index: 0, id, name: "WebFetch" },
      { type: "tool_call_delta", index: 0, delta: JSON.stringify({ url }) },
      { type: "tool_call_end", index: 0 },
    ];
    const logs: string[] = [];
    const runner = new SubAgentRunner({
      config: new StaticConfigProvider(CONFIG),
      llmFactory: factory([
        // Two URLs alternating: never the same call twice in a row, so the old
        // consecutive-only detector could NEVER break this (the reported bug).
        webCall("a1", "https://a"),
        webCall("b1", "https://b"),
        webCall("a2", "https://a"),
        webCall("b2", "https://b"),
        webCall("a3", "https://a"), // 3rd identical call in the window → loop guard
        [{ type: "text", content: "current weather report" }],
      ]),
      tools: new ToolRegistry([web]),
      cwd: () => "/workspace",
      log: (m) => logs.push(m),
    });

    const res = await runner.run(spec({ access: "read" }));

    expect(res.isError).toBe(false);
    expect(res.content).toContain("current weather report");
    expect(res.content).not.toContain("Loop not resolved");
    // The window detector fired on the alternation, before any endless refetch.
    expect(logs.some((l) => /loop-guard \[tool-repeat\] level 1/.test(l))).toBe(true);
    expect(fetched.length).toBeLessThanOrEqual(5);
  });

  it("logs a sub-agent's lifecycle (start + end with duration)", async () => {
    const logs: string[] = [];
    const runner = new SubAgentRunner({
      config: new StaticConfigProvider(CONFIG),
      llmFactory: factory([[{ type: "text", content: "report" }]]),
      tools: new ToolRegistry([makeWriteTool()]),
      cwd: () => "/workspace",
      log: (m) => logs.push(m),
    });

    const res = await runner.run(spec({ access: "read" }), undefined, undefined, "tc1");

    expect(res.isError).toBe(false);
    expect(logs.some((l) => /^subagent "A" start: access=read resources=1/.test(l))).toBe(true);
    expect(logs.some((l) => /^subagent "A" end in \d+ms$/.test(l))).toBe(true);
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
    // still produces a result WITHOUT throwing, but it must be marked as an
    // ERROR (the sub-task did not complete) so the orchestrator can react.
    const res = await buildRunner(failing).run(spec({ id: "Z" }));
    expect(res.isError).toBe(true);
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
    // A stopped run is ABORTED (an error result), never a plain report.
    expect(res.isError).toBe(true);
    expect(res.content).toContain("aborted");
  });

  it("abort(toolCallId) aborts the matching sub-agent; unknown ids are a no-op", async () => {
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
    const pending = runner.run(spec(), undefined, undefined, "tc-1");
    await Promise.resolve();
    expect(runner.activeCount).toBe(1);

    runner.abort("nope"); // unknown id: never touches the running sub-agent
    expect(runner.activeCount).toBe(1);

    runner.abort("tc-1");
    const res = await pending;
    expect(aborted).toBe(true);
    expect(runner.activeCount).toBe(0);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("aborted");
    expect(res.content).not.toContain("interrupted");
  });

  it("aborting the PARENT signal aborts the in-flight sub-agent (start/abort race)", async () => {
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
    const ac = new AbortController();
    const pending = runner.run(spec(), undefined, ac.signal, "tc-signal");
    await Promise.resolve();
    expect(runner.activeCount).toBe(1);

    ac.abort(); // whole-run Stop cascades through the parent signal
    const res = await pending;
    expect(aborted).toBe(true);
    expect(runner.activeCount).toBe(0);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("aborted");
  });
});

describe("SubAgentRunner — loop guard parity", () => {
  function makeReadTool(): Tool & { calls: number } {
    const tool = {
      name: "Read",
      definition: { name: "Read", description: "read", parameters: { type: "object", properties: {} } },
      calls: 0,
      execute: (): ToolResult => {
        tool.calls++;
        return { content: "CONTENT", isError: false };
      },
    };
    return tool;
  }

  it("applies the EMPTY-turn guard (sub-agent cannot stall forever)", async () => {
    const logs: string[] = [];
    const empty = (): StreamChunk[] => [];
    const runner = new SubAgentRunner({
      config: new StaticConfigProvider(CONFIG),
      llmFactory: factory([empty(), empty(), empty()]),
      tools: new ToolRegistry([]),
      cwd: () => "/workspace",
      log: (m) => logs.push(m),
    });

    const res = await runner.run(spec({ id: "E" }));

    // Same guard as the orchestrator: react, react, then stop loudly.
    expect(logs.some((l) => /loop-guard \[empty\] level 1/.test(l))).toBe(true);
    expect(logs.some((l) => /loop-stop \[empty\]/.test(l))).toBe(true);
    expect(res.content.length).toBeGreaterThan(0);
  });

  it("cuts a WITHIN-sub-agent reasoning loop mid-stream", async () => {
    const logs: string[] = [];
    const loopText = "Let me check the CSS and the controls again. ".repeat(30);
    const runner = new SubAgentRunner({
      config: new StaticConfigProvider(CONFIG),
      llmFactory: factory([
        [{ type: "thinking", content: loopText }],
        [{ type: "text", content: "report after loop" }],
      ]),
      tools: new ToolRegistry([]),
      cwd: () => "/workspace",
      log: (m) => logs.push(m),
    });

    const res = await runner.run(spec({ id: "R" }));

    expect(logs.some((l) => /loop-guard \[reasoning\] level 1/.test(l))).toBe(true);
    expect(res.content).toContain("report after loop");
  });

  it("reuses an identical read-only call INSIDE a sub-agent (source dedup)", async () => {
    const read = makeReadTool();
    const readCall = (id: string): StreamChunk[] => [
      { type: "tool_call_start", index: 0, id, name: "Read" },
      { type: "tool_call_delta", index: 0, delta: '{"path":"a.ts"}' },
      { type: "tool_call_end", index: 0 },
    ];
    const runner = buildRunner(
      factory([readCall("r1"), readCall("r2"), [{ type: "text", content: "report" }]]),
      [read],
    );
    const outputs: string[] = [];
    const res = await runner.run(spec({ id: "D" }), (e) => {
      if (e.type === "tool_result") outputs.push(e.toolResult.output);
    });

    expect(res.content).toContain("report");
    // The second identical Read was served from the guard's cache, not run again.
    expect(read.calls).toBe(1);
    expect(outputs.some((o) => /reused the cached result/.test(o))).toBe(true);
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
