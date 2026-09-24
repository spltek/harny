import { describe, expect, it } from "vitest";
import { DefaultSystemPromptBuilder } from "./system-prompt";
import { toolDefinitionsForMode } from "../tools/mode-policy";
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
});