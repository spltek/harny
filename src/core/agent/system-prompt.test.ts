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
  it("analyze mode: lists only read-only tools and enforces the read-only rules", () => {
    const builder = new DefaultSystemPromptBuilder((mode) => toolDefinitionsForMode(tools(), mode), () => "/w");
    const prompt = builder.build("analyze");
    const listSection = prompt.slice(
      prompt.indexOf("You have access to these tools:"),
      prompt.indexOf("\nGuidelines:"),
    );

    // Tool list respects the mode-filtered set: no Write/Edit/Delete/StrReplace.
    expect(listSection).toContain("- Read:");
    expect(listSection).toContain("- Shell:");
    expect(listSection).not.toContain("- Write:");
    expect(listSection).not.toContain("- StrReplace:");
    expect(listSection).not.toContain("- Edit:");
    expect(listSection).not.toContain("- Delete:");
    // Explicit read-only rules are present.
    expect(prompt).toContain("READ-ONLY MODE (Analyze)");
    expect(prompt).toContain("make no changes");
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

  it("adds orchestration rules only when the Delegate tool is available", () => {
    const withDelegate = new DefaultSystemPromptBuilder(
      (mode) => toolDefinitionsForMode(toolsWithDelegate(), mode),
      () => "/w",
    );
    expect(withDelegate.build("agent")).toContain("ORCHESTRATION (Delegate)");
    expect(withDelegate.build("agent")).toContain("EDITS ARE NEVER PARALLEL");

    const without = new DefaultSystemPromptBuilder((mode) => toolDefinitionsForMode(tools(), mode), () => "/w");
    expect(without.build("agent")).not.toContain("ORCHESTRATION (Delegate)");
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

  it("shows only the mode-filtered tools (no writers in read-only)", () => {
    const prompt = build({ access: "read", resources: ["a"] }, "analyze");
    expect(prompt).toContain("- Read:");
    expect(prompt).not.toContain("- Write:");
    expect(prompt).not.toContain("- Edit:");
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