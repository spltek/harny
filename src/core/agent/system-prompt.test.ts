import { describe, expect, it } from "vitest";
import { DefaultSystemPromptBuilder, SubAgentSystemPromptBuilder } from "./system-prompt";
import { toolDefinitionsForMode } from "../tools/mode-policy";
import { DELEGATE_TOOL_NAME } from "./orchestration";
import type { Tool } from "../tools/tool";

function tools(): Tool[] {
  return ["Read", "Write", "Edit", "Delete", "StrReplace", "Shell", "Grep"].map((name) => ({
    name,
    definition: {
      name,
      description: `The ${name} tool does its thing.`,
      parameters: { type: "object", properties: {} },
    },
    execute: async () => ({ content: "ok", isError: false }),
  }));
}

describe("DefaultSystemPromptBuilder mode awareness", () => {
  it("analyze mode: lists ALL tools and enforces the read-only PREVIEW rules", () => {
    const builder = new DefaultSystemPromptBuilder((mode) => toolDefinitionsForMode(tools(), mode), () => "/w");
    const prompt = builder.build("analyze");
    const listSection = prompt.slice(
      prompt.indexOf("You have access to these tools:"),
      prompt.indexOf("\nGuidelines:"),
    );

    // Analyze advertises the SAME set: writers are available as previews.
    expect(listSection).toContain("- Read:");
    expect(listSection).toContain("- Shell:");
    expect(listSection).toContain("- Write:");
    expect(listSection).toContain("- Edit:");
    // Explicit read-only PREVIEW rules are present.
    expect(prompt).toContain("READ-ONLY MODE (Analyze)");
    expect(prompt).toContain("PREVIEW");
    expect(prompt).toContain("Switch to **Build**");
  });

  it("agent mode: lists every tool and has NO read-only rules", () => {
    const builder = new DefaultSystemPromptBuilder((mode) => toolDefinitionsForMode(tools(), mode), () => "/w");
    const prompt = builder.build("agent");
    const listSection = prompt.slice(
      prompt.indexOf("You have access to these tools:"),
      prompt.indexOf("\nGuidelines:"),
    );

    expect(listSection).toContain("- Read:");
    expect(listSection).toContain("- Write:");
    expect(listSection).toContain("- Edit:");
    expect(listSection).toContain("- Delete:");
    expect(prompt).not.toContain("READ-ONLY MODE (Analyze)");
  });

  it("defaults to the analyze (read-only) prompt when no mode is given", () => {
    const builder = new DefaultSystemPromptBuilder((mode) => toolDefinitionsForMode(tools(), mode), () => "/w");
    expect(builder.build()).toContain("READ-ONLY MODE (Analyze)");
  });

  it("warns against repeating the same tool call", () => {
    const builder = new DefaultSystemPromptBuilder((mode) => toolDefinitionsForMode(tools(), mode), () => "/w");
    expect(builder.build("agent")).toContain("Never repeat the same tool call");
  });

  it("analyze mode + Delegate: read-only rules AND orchestration rules together", () => {
    const builder = new DefaultSystemPromptBuilder(
      (mode) => toolDefinitionsForMode(toolsWithDelegate(), mode),
      () => "/w",
    );
    const prompt = builder.build("analyze");
    expect(prompt).toContain("READ-ONLY MODE (Analyze)");
    expect(prompt).toContain("they MUST be read-only");
    expect(prompt).toContain("ORCHESTRATION");
    // The SAME 3-step orchestration flow applies in Analyze too (Parallel ON).
    expect(prompt).toContain("STEP 1 — THINK, DO NOT ANSWER");
    expect(prompt).toContain("STEP 2 — PLAN + LAUNCH");
    expect(prompt).toContain("sub-agent");
    // Read-only preview: writers are advertised (they run as previews).
    const listSection = prompt.slice(prompt.indexOf("You have access to these tools:"), prompt.indexOf("\nGuidelines:"));
    expect(listSection).toContain("- Write:");
  });

  it("pre-delegation (only Delegate advertised) forbids every other tool by name", () => {
    const delegateOnly: Tool[] = [
      {
        name: DELEGATE_TOOL_NAME,
        definition: { name: DELEGATE_TOOL_NAME, description: "Delegate a sub-task.", parameters: { type: "object", properties: {} } },
        execute: async () => ({ content: "ok", isError: false }),
      },
    ];
    const builder = new DefaultSystemPromptBuilder((m) => toolDefinitionsForMode(delegateOnly, m), () => "/w");
    const prompt = builder.build("agent");
    expect(prompt).toContain("DELEGATION TURN");
    expect(prompt).toContain("ONLY tool you may call is Delegate");
    expect(prompt).toContain("Do NOT call TodoWrite");
    expect(prompt).toContain("any such call is refused");
    // The reasoning is SCOPED to delegation on this turn: the model must not
    // start solving the task in its thinking.
    expect(prompt).toContain("Think ONLY about how to orchestrate");
    expect(prompt).toContain("Do NOT start solving");
    // The focused prompt does not drag the general guidelines in.
    expect(prompt).not.toContain("Guidelines:");
  });

  it("adds the same 3-step orchestration rules when Parallel is ON, in BOTH modes", () => {
    const withDelegate = new DefaultSystemPromptBuilder(
      (mode) => toolDefinitionsForMode(toolsWithDelegate(), mode),
      () => "/w",
    );
    // The delegation flow is IDENTICAL in Analyze and Build: don't answer →
    // think how to split into 1..N sub-tasks → launch the Delegate call(s).
    for (const mode of ["analyze", "agent"] as const) {
      const p = withDelegate.build(mode);
      expect(p).toContain("ORCHESTRATION MODE (PARALLEL ON)");
      expect(p).toContain("Do NOT answer");
      expect(p).toContain("STEP 1 — THINK, DO NOT ANSWER");
      expect(p).toContain("STEP 2 — PLAN + LAUNCH");
      expect(p).toContain("STEP 3 — COLLECT + ANSWER");
      // Conflict reasoning about resources (not just files) + meaningful ids.
      expect(p).toContain("containing folder");
      expect(p).toContain("MEANINGFUL id");
    }

    const without = new DefaultSystemPromptBuilder((mode) => toolDefinitionsForMode(tools(), mode), () => "/w");
    expect(without.build("agent")).not.toContain("ORCHESTRATION");
  });
});

function toolsWithDelegate(): Tool[] {
  return [
    ...tools(),
    {
      name: DELEGATE_TOOL_NAME,
      definition: {
        name: DELEGATE_TOOL_NAME,
        description: "Delegate a sub-task.",
        parameters: { type: "object", properties: {} },
      },
      execute: async () => ({ content: "ok", isError: false }),
    },
  ];
}

describe("SubAgentSystemPromptBuilder", () => {
  const build = (opts: { role?: string; access: "read" | "write" | "create"; resources: string[] }, mode: "analyze" | "agent") =>
    new SubAgentSystemPromptBuilder((m) => toolDefinitionsForMode(tools(), m), () => "/w", opts).build(mode);

  it("frames the sub-agent with its role and report contract", () => {
    const prompt = build({ role: "analyst", access: "read", resources: ["src/a.ts"] }, "analyze");
    expect(prompt).toContain("sub-agent of Harny");
    expect(prompt).toContain("Your role: analyst");
    expect(prompt).toContain("READ-ONLY");
    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("REPORT FORMAT");
  });

  it("tells a writer the exact resources it owns and that others may own the rest", () => {
    const prompt = build({ access: "write", resources: ["src/http-core.ts"] }, "agent");
    expect(prompt).toContain("src/http-core.ts");
    expect(prompt).toContain("Do not touch anything else");
    expect(prompt).not.toContain("You are READ-ONLY");
  });

  it("advertises writers to a read sub-agent as PREVIEWS", () => {
    const prompt = build({ access: "read", resources: ["a"] }, "analyze");
    expect(prompt).toContain("- Read:");
    expect(prompt).toContain("- Write:");
    expect(prompt).toContain("PREVIEW");
  });

  it("includes the turn-budget hint when provided", () => {
    const prompt = new SubAgentSystemPromptBuilder(
      (m) => toolDefinitionsForMode(tools(), m),
      () => "/w",
      { access: "read", resources: ["a"], turnBudget: 25 },
    ).build("analyze");
    expect(prompt).toContain("BUDGET");
    expect(prompt).toContain("25");
  });

  it("forbids repeating a tool call and steers to Glob/Grep/Read", () => {
    const prompt = build({ access: "read", resources: ["a"] }, "analyze");
    expect(prompt).toContain("NEVER repeat the same tool call");
    expect(prompt).toContain("Prefer Glob/Grep/Read");
  });
});