import { describe, expect, it } from "vitest";
import { SubAgentRunner, SUBAGENT_REPORT_MARKER, lastAssistantReport, toSubAgentEvent } from "./subagent";
import { DEFAULT_LOOP_GUARD_OPTIONS } from "./loop-guard";
import type { LoopGuardOptions } from "./loop-guard";
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
    analyzePolicy: "preview" as const, // the test asserts the dry-run preview
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
  return toolCallChunks("c1", "Write", { path: "a.ts", content: "x" });
}

function buildRunner(llmFactory: LLMProviderFactory, tools: Tool[] = [], extra: Record<string, unknown> = {}) {
  return new SubAgentRunner({
    config: new StaticConfigProvider(CONFIG),
    llmFactory,
    tools: new ToolRegistry(tools),
    cwd: () => "/workspace",
    ...extra,
  });
}

/** The wire shape of a tool call, written ONCE: every test below used to carry its
 * own copy of these three chunks (five copies, drifting). */
function toolCallChunks(id: string, name: string, args: Record<string, unknown>): StreamChunk[] {
  return [
    { type: "tool_call_start", index: 0, id, name },
    { type: "tool_call_delta", index: 0, delta: JSON.stringify(args) },
    { type: "tool_call_end", index: 0 },
  ];
}

/** The Read stub: counts its calls, returns `output` (default "CONTENT") and records
 * the context budget it was handed. */
function makeReadTool(opts: { output?: string } = {}): Tool & { calls: number; budget?: number } {
  const tool = {
    name: "Read",
    definition: { name: "Read", description: "read", parameters: { type: "object", properties: {} } },
    analyzePolicy: "read-only" as const,
    cacheable: true, // the dedup tests assert the loop-guard cache
    calls: 0,
    budget: undefined as number | undefined,
    execute: (_args: Record<string, unknown>, ctx?: { contextBudget?: number }): ToolResult => {
      tool.calls++;
      tool.budget = ctx?.contextBudget;
      return { content: opts.output ?? "CONTENT", isError: false };
    },
  };
  return tool;
}

describe("sub-agents run on the SESSION's config", () => {
  it("sends the config the runner was given — the session's model and routing identity", async () => {
    // A sub-agent is a set of real requests made during the session's run, and it shares the
    // session's model. The config therefore comes from the runner (extension.ts passes the
    // per-session view), NOT from the host chain: the chain carries no session id, and a host
    // that routes by conversation (OpenCode Go's `x-opencode-session`) answers 400.
    const configs: HarnyConfig[] = [];
    const llm = {
      create(cfg: HarnyConfig) {
        configs.push(cfg);
        return {
          protocol: "chat" as const,
          async *stream() {
            yield { type: "text" as const, content: "done" };
          },
        };
      },
    } as unknown as LLMProviderFactory;
    const runner = new SubAgentRunner({
      config: new StaticConfigProvider({
        ...CONFIG,
        model: "deepseek-v4-pro",
        sessionId: "s-9",
        sessionHeader: "x-opencode-session",
      }),
      llmFactory: llm,
      tools: new ToolRegistry([]),
      cwd: () => "/workspace",
    });

    await runner.run(spec({}));

    expect(configs.length).toBeGreaterThan(0);
    expect(configs[0]).toMatchObject({
      model: "deepseek-v4-pro",
      sessionId: "s-9",
      sessionHeader: "x-opencode-session",
    });
  });
});

describe("sub-agents inherit the session's tool scope", () => {
  it("a tool switched off in the session is off for the delegated work too", async () => {
    // Without inheritance "this tool is off" is cosmetic: the model delegates and the sub-agent
    // calls it anyway. This asserts the definitions the sub-agent is actually GIVEN.
    const seen: string[][] = [];
    const prompts: string[] = [];
    const llm: LLMProviderFactory = {
      create: () => ({
        protocol: "chat" as const,
        async *stream(messages: unknown, _s?: AbortSignal, defs?: { name: string }[]) {
          seen.push((defs ?? []).map((d) => d.name));
          prompts.push(String((messages as { content?: unknown }[])[0]?.content ?? ""));
          yield { type: "text", content: "done" } as StreamChunk;
        },
      }),
    };
    const tools = ["Read", "Shell", "mcp__files__read"].map((name) => ({
      name,
      definition: { name, description: name, parameters: { type: "object", properties: {} } },
    })) as unknown as Tool[];
    const runner = new SubAgentRunner({
      config: new StaticConfigProvider(CONFIG),
      llmFactory: llm,
      tools: new ToolRegistry(tools),
      cwd: () => "/workspace",
      toolScope: () => ({ mcp: [], off: ["Shell"] }),
    });
    await runner.run(spec({ access: "read" }));

    // The MCP server is OFF for this session, Shell is OFF, Read stays. Delegate is excluded
    // anyway (depth is capped at 1), which the scope must not undo.
    expect(seen[0]).toEqual(["Read"]);
    // The PROMPT must agree with the list: advertising a tool the turn then hides is how a model
    // ends up planning around something it cannot call. The catalog is rendered one line per tool
    // (`- <name>: <description>`), so this is the exact line, not the bare word (the prompt also
    // TALKS about Shell elsewhere).
    expect(prompts[0]).toContain("- Read:");
    expect(prompts[0]).not.toContain("- Shell:");
    expect(prompts[0]).not.toContain("- mcp__files__read:");
  });
});

describe("sub-agents inherit the session's context discipline", () => {
  /** One read of `tokens` tokens, at a DISTINCT path per call: two identical calls
   * would be served from the loop guard's cache and never reach the wire. */
  const bigRead = (id: string, path: string): StreamChunk[] => toolCallChunks(id, "Read", { path });

  it("hands its tool calls the SESSION's usable window (so their output is capped to the model)", async () => {
    // A sub-agent does the heavy reading: without the budget its Shell/Grep caps stay
    // FIXED (50KB is an entire 8k context) while the main agent's scale down.
    const read = makeReadTool({ output: "small" });
    const runner = new SubAgentRunner({
      config: new StaticConfigProvider(CONFIG),
      llmFactory: factory([[...bigRead("c1", "a.ts"), { type: "text", content: "done" }]]),
      tools: new ToolRegistry([read]),
      cwd: () => "/workspace",
      contextBudget: () => 12_345,
    });

    await runner.run(spec({ access: "read" }));

    expect(read.budget).toBe(12_345);
  });

  it("MASKS its own old tool output: a sub-agent session cannot fill the window either", async () => {
    // The masking rule is in the Agent core, so it applies to a sub-agent as soon as
    // the budget is known — and a sub-agent's history is exactly the one that grows
    // with huge reads and greps. The request for the LAST turn must carry a stub in
    // place of the oldest output, and the newest one verbatim.
    const seen: LLMMessage[][] = [];
    const read = makeReadTool({ output: "x".repeat(5000 * 4) }); // ~5k tokens per read
    const base = factory([bigRead("c1", "a.ts"), bigRead("c2", "b.ts"), [{ type: "text", content: "done" }]]);
    const recording: LLMProviderFactory = {
      create: () => {
        const inner = base.create();
        return {
          protocol: "chat" as const,
          async *stream(messages: LLMMessage[], signal?: AbortSignal, tools?: never) {
            seen.push(messages);
            yield* inner.stream(messages, signal, tools as never);
          },
        };
      },
    };
    const runner = new SubAgentRunner({
      config: new StaticConfigProvider(CONFIG),
      llmFactory: recording,
      tools: new ToolRegistry([read]),
      cwd: () => "/workspace",
      contextBudget: () => 32_000,
    });

    await runner.run(spec({ access: "read" }));

    const last = seen[seen.length - 1];
    const toolMsgs = last.filter((m) => (m as { role: string }).role === "tool");
    expect(toolMsgs.length).toBe(2);
    // Oldest: a one-line stub naming the tool. Newest: the full output.
    expect(String(toolMsgs[0].content)).toContain("masked to save context");
    expect(String(toolMsgs[0].content)).toContain("Read");
    expect(String(toolMsgs[1].content)).toBe("x".repeat(5000 * 4));
  });

  it("an OVERFLOW inside a sub-agent is recovered the same way as in a session", async () => {
    // One strategy, two consumers: the host compacts the SUB-AGENT's history with the
    // same routine a session uses, and the turn is retried. The history handed over is
    // the sub-agent's OWN (ephemeral) one.
    const OVERFLOW =
      'OpenAI API error 400: {"error":{"code":"context_length_exceeded","message":"This model\'s maximum context length is 8192 tokens."}}';
    const requests: number[] = [];
    let calls = 0;
    const flaky: LLMProviderFactory = {
      create: () => ({
        protocol: "chat" as const,
        async *stream() {
          requests.push(++calls);
          if (calls === 1) throw new Error(OVERFLOW);
          yield { type: "text", content: "report after recovery" };
        },
      }),
    };
    const histories: ChatMessage[][] = [];
    const runner = new SubAgentRunner({
      config: new StaticConfigProvider(CONFIG),
      llmFactory: flaky,
      tools: new ToolRegistry([]),
      cwd: () => "/workspace",
      onContextOverflow: async (history) => {
        histories.push(history.conversation());
        history.replace([
          { role: "user", content: "summary of the sub-agent's work", timestamp: 1 },
          { role: "assistant", content: "noted", timestamp: 2 },
        ]);
        return true;
      },
    });

    const res = await runner.run(spec({ access: "read" }));

    // Recovered: the sub-agent finished instead of dying on the rejection.
    expect(res.isError).toBe(false);
    expect(res.content).toContain("report after recovery");
    expect(requests).toHaveLength(2);
    // The callback saw a real, non-empty history (the sub-agent's own).
    expect(histories).toHaveLength(1);
    expect(histories[0].length).toBeGreaterThan(0);
  });

  it("without a recovery callback an overflow still ends the sub-agent (no silent behaviour)", async () => {
    const OVERFLOW =
      'OpenAI API error 400: {"error":{"code":"context_length_exceeded","message":"This model\'s maximum context length is 8192 tokens."}}';
    const failing: LLMProviderFactory = {
      create: () => ({
        protocol: "chat" as const,
        async *stream() {
          throw new Error(OVERFLOW);
        },
      }),
    };
    const runner = buildRunner(failing);

    const res = await runner.run(spec({ access: "read" }));

    expect(res.isError).toBe(true);
  });

  it("guards a sub-agent with THIS session's options, not with the defaults", async () => {
    // Same guard, same session: a setting changed in the UI must protect the sub-agents
    // too, otherwise "they share the loop guard" only means "they have one".
    // The discriminator is countable: a model that keeps producing EMPTY turns is nudged
    // up to `maxNudges` times, then the run stops — so the number of requests reveals
    // which options were in force (the main agent's own test uses the same scenario).
    const stalling = (): { factory: LLMProviderFactory; calls: () => number } => {
      let calls = 0;
      return {
        calls: () => calls,
        factory: {
          create: () => ({
            protocol: "chat" as const,
            async *stream() {
              calls++;
              yield* [] as StreamChunk[]; // nothing: text, thinking and tools all empty
            },
          }),
        },
      };
    };
    const run = async (opts?: LoopGuardOptions): Promise<number> => {
      const stall = stalling();
      await new SubAgentRunner({
        config: new StaticConfigProvider(CONFIG),
        llmFactory: stall.factory,
        tools: new ToolRegistry([]),
        cwd: () => "/workspace",
        ...(opts ? { loopGuard: () => opts } : {}),
      }).run(spec({ access: "read" }));
      return stall.calls();
    };

    // The session's guard: ONE nudge, then the stop → the nudge + the final attempt.
    expect(await run({ ...DEFAULT_LOOP_GUARD_OPTIONS, maxNudges: 1 })).toBe(2);
    // The same sub-agent with no guard deps: the default preset (maxNudges: 2) → 3.
    expect(await run()).toBe(3);
  });

  it("frees room at every turn boundary, with its OWN history", async () => {
    // The session compacts proactively at a boundary (maybeCompactDuringRun); a sub-agent
    // — unbounded, and full of heavy reads — needs it more, and it must act on the
    // SUB-AGENT's history, not on the session's.
    const readCall = (id: string, path: string): StreamChunk[] => toolCallChunks(id, "Read", { path });
    const seenLengths: number[] = [];
    const runner = new SubAgentRunner({
      config: new StaticConfigProvider(CONFIG),
      llmFactory: factory([readCall("r1", "a.ts"), readCall("r2", "b.ts"), [{ type: "text", content: "report" }]]),
      tools: new ToolRegistry([makeReadTool()]),
      cwd: () => "/workspace",
      onTurnBoundary: (history) => {
        seenLengths.push(history.conversation().length);
        return false; // nothing to free in this test
      },
    });

    await runner.run(spec({ access: "read" }));

    // A boundary closes EVERY turn, the last one included: three turns here.
    expect(seenLengths).toHaveLength(3);
    expect(seenLengths[0]).toBeGreaterThan(0);
    // …and each call sees the sub-agent's OWN history, growing as it works.
    expect(seenLengths[1]).toBeGreaterThan(seenLengths[0]);
    expect(seenLengths[2]).toBeGreaterThan(seenLengths[1]);
  });

  it("without a budget it behaves exactly as before (no masking, no cap)", async () => {
    // The deps are optional: a runner built without them (tests, a future CLI) must not
    // change behaviour just because the feature exists.
    const read = makeReadTool({ output: "x".repeat(5000 * 4) });
    const runner = buildRunner(factory([bigRead("c1", "a.ts"), [{ type: "text", content: "done" }]]), [read]);

    await runner.run(spec({ access: "read" }));

    expect(read.budget).toBeUndefined();
  });
});

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
    const toolCall = (): StreamChunk[] => toolCallChunks("c1", "Read", { path: "a.ts" });
    const read: Tool = {
      name: "Read",
      definition: { name: "Read", description: "read", parameters: { type: "object", properties: {} } },
      analyzePolicy: "read-only", // a fixture stands in for a KNOWN tool
      cacheable: true,
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

  it("hands the sub-agent the installed skills catalog (it can activate a skill on its own)", async () => {
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
      skills: () => [
        {
          name: "pdf",
          description: "Extract PDF text",
          dir: "/w/.agents/skills/pdf",
          path: "/w/.agents/skills/pdf/SKILL.md",
        },
      ],
    });

    await runner.run(spec({ access: "read" }));

    expect(systemPrompt).toContain("## Skills");
    expect(systemPrompt).toContain("- pdf: Extract PDF text");
  });

  it("does not append the Analyze preview footer to a sub-agent report", async () => {
    const write: Tool = {
      name: "Write",
      definition: { name: "Write", description: "write", parameters: { type: "object", properties: {} } },
      execute: () => ({ content: "PROPOSED (preview — NOT written): x", isError: false }),
    };
    const runner = buildRunner(factory([writeCall(), [{ type: "text", content: "REPORT: done" }]]), [write]);

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
      analyzePolicy: "read-only", // a fixture stands in for a KNOWN tool
      cacheable: true,
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
      analyzePolicy: "read-only", // reads the web, changes nothing here
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
    // The MIRROR of the read-only case above: a writer sub-agent runs in Build, so `dryRun` is
    // not set at all (see ToolContext) and the tool really writes. Pinned here because the two
    // halves are the whole promise of the delegated work: a reader never writes, a writer does.
    expect(write.lastDryRun).toBeUndefined();
    expect(res.content).toContain("done writing");
  });

  it("an UNTRUSTED folder turns a WRITER sub-agent into a reader (delegation cannot launder Build)", async () => {
    // Restricted Mode must survive delegation: the orchestrator must not be able to get a helper
    // to do what it may not do itself. `setMode("agent")` inside the sub-agent resolves to
    // Analyze (see AgentDeps.workspaceTrusted), so the very same Write call that really writes in
    // the test above PREPARES here — and the report says so instead of claiming `done`.
    const write = makeWriteTool();
    const runner = buildRunner(factory([writeCall(), [{ type: "text", content: "report" }]]), [write], {
      workspaceTrusted: () => false,
    });

    const res = await runner.run(spec({ access: "write", resources: ["a.ts"] }));

    expect(write.called).toBe(true); // the tool call happens…
    expect(write.lastDryRun).toBe(true); // …as a validated preview, not a write
    // A report that said `done` with no files touched would be a lie the orchestrator cannot
    // detect: the status is needs-write, machine-readable, and the note names the REAL blocker.
    expect(res.content).toContain("needs-write");
    expect(res.content).toContain("Restricted Mode");
    // …and it must NOT send the orchestrator to re-delegate a writer: in an untrusted folder the
    // folder is what has to change, so that advice would loop until the turn budget ran out.
    expect(res.content).not.toContain('Re-delegate this sub-task with access "write"');
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
    const readCall = (id: string): StreamChunk[] => toolCallChunks(id, "Read", { path: "a.ts" });
    const runner = buildRunner(factory([readCall("r1"), readCall("r2"), [{ type: "text", content: "report" }]]), [
      read,
    ]);
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
      {
        role: "assistant",
        content: "🔧 Tool: Read",
        toolCalls: [{ id: "1", name: "Read", arguments: {} }],
        timestamp: 2,
      },
      { role: "tool", content: "data", toolCallId: "1", timestamp: 3 },
      { role: "assistant", content: "final report", timestamp: 4 },
    ];
    expect(lastAssistantReport(msgs)).toBe("final report");
  });

  it("falls back when there is no clean final message", () => {
    expect(lastAssistantReport([{ role: "user", content: "go", timestamp: 1 }])).toBe("(no report produced)");
  });
});
