import { describe, expect, it } from "vitest";
import { DefaultSystemPromptBuilder, SubAgentSystemPromptBuilder } from "./system-prompt";
import { toolDefinitionsForMode } from "../tools/mode-policy";
import { DELEGATE_TOOL_NAME } from "./orchestration";
import { TODO_TOOL_NAME } from "../tools/todo-tool";
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
    const builder = new DefaultSystemPromptBuilder(
      (mode) => toolDefinitionsForMode(tools(), mode),
      () => "/w",
    );
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
    const builder = new DefaultSystemPromptBuilder(
      (mode) => toolDefinitionsForMode(tools(), mode),
      () => "/w",
    );
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
    const builder = new DefaultSystemPromptBuilder(
      (mode) => toolDefinitionsForMode(tools(), mode),
      () => "/w",
    );
    expect(builder.build()).toContain("READ-ONLY MODE (Analyze)");
  });

  it("warns against repeating the same tool call", () => {
    const builder = new DefaultSystemPromptBuilder(
      (mode) => toolDefinitionsForMode(tools(), mode),
      () => "/w",
    );
    expect(builder.build("agent")).toContain("Never repeat the same tool call");
  });

  it("states the platform + native shell so the model uses the right commands", () => {
    const builder = new DefaultSystemPromptBuilder(
      (mode) => toolDefinitionsForMode(tools(), mode),
      () => "/w",
    );
    const prompt = builder.build("agent");
    expect(prompt).toMatch(/Platform: (Windows|macOS|Linux)/);
    expect(prompt).toMatch(/Shell tool runs commands with the native shell/);
  });

  it("lists installed skills under ## Skills (and omits the section when there are none)", () => {
    const withSkills = new DefaultSystemPromptBuilder(
      (mode) => toolDefinitionsForMode(tools(), mode),
      () => "/w",
      () => [
        {
          name: "pdf",
          description: "Extract PDF text",
          dir: "/w/.agents/skills/pdf",
          path: "/w/.agents/skills/pdf/SKILL.md",
        },
        {
          name: "code-review",
          description: "Review a diff",
          dir: "/w/.agents/skills/code-review",
          path: "/w/.agents/skills/code-review/SKILL.md",
        },
        {
          name: "grill-me",
          description: "Interview",
          dir: "/w/.agents/skills/grill-me",
          path: "/w/.agents/skills/grill-me/SKILL.md",
          disableModelInvocation: true,
        },
      ],
    );
    const prompt = withSkills.build("agent");
    expect(prompt).toContain("## Skills");
    expect(prompt).toContain("- pdf: Extract PDF text");
    expect(prompt).toContain("- code-review: Review a diff");
    expect(prompt).toContain("Skill tool");
    // disable-model-invocation skills are NOT offered to the model.
    expect(prompt).not.toContain("- grill-me:");

    const without = new DefaultSystemPromptBuilder(
      (mode) => toolDefinitionsForMode(tools(), mode),
      () => "/w",
    );
    expect(without.build("agent")).not.toContain("## Skills");
  });

  it("analyze mode + Delegate: read-only rules AND orchestration rules together", () => {
    const builder = new DefaultSystemPromptBuilder(
      (mode) => toolDefinitionsForMode(toolsWithDelegate(), mode),
      () => "/w",
    );
    const prompt = builder.build("analyze");
    expect(prompt).toContain("READ-ONLY MODE (Analyze)");
    expect(prompt).toContain("they MUST be read-only");
    expect(prompt).toContain("PARALLELISM MEANS SUB-TASKS");
    expect(prompt).toContain("you MUST call Delegate");
    expect(prompt).toContain("sub-agent");
    // Read-only preview: writers are advertised (they run as previews).
    const listSection = prompt.slice(
      prompt.indexOf("You have access to these tools:"),
      prompt.indexOf("\nGuidelines:"),
    );
    expect(listSection).toContain("- Write:");
  });

  describe("TASK LIST guidance (TodoWrite)", () => {
    const withTodo = () =>
      new DefaultSystemPromptBuilder(
        (m) => toolDefinitionsForMode(toolsWithTodo(), m),
        () => "/w",
      );
    const withoutTodo = () =>
      new DefaultSystemPromptBuilder(
        (m) => toolDefinitionsForMode(tools(), m),
        () => "/w",
      );

    it("appears only when TodoWrite is actually offered (both modes)", () => {
      for (const mode of ["analyze", "agent"] as const) {
        expect(withTodo().build(mode)).toContain("TASK LIST — TodoWrite");
        expect(withoutTodo().build(mode)).not.toContain("TASK LIST");
      }
    });

    it("carries a NARROW trigger and the anti-overuse line", () => {
      const prompt = withTodo().build("agent");
      // Only when it pays off: several distinct goals, or progress worth seeing…
      expect(prompt).toContain("several DISTINCT goals");
      // …and explicitly NOT on every request that happens to take a few calls.
      expect(prompt).toContain("Skip it for a quick task");
    });

    it("carries the merge:true rule that fixes late status updates", () => {
      const prompt = withTodo().build("agent");
      expect(prompt).toContain("merge:true");
      expect(prompt).toContain("never batch the updates");
      expect(prompt).toContain('nothing is left "in_progress"');
    });

    it("stays a short nudge, not a second PARALLELISM block", () => {
      // A length guard ON PURPOSE: the earlier draft (20 lines, HARD RULE,
      // numbered phases) pushed the tool on every single request. Past ~130
      // words this section has turned into that again.
      const prompt = withTodo().build("agent");
      const section = prompt.slice(prompt.indexOf("TASK LIST")).split("\n\n")[0];
      expect(section.split(/\s+/).filter(Boolean).length).toBeLessThan(130);
    });
  });

  it("tells the orchestrator to STEER a sub-agent (naming tool/skill) when Parallel is ON", () => {
    const withDelegate = new DefaultSystemPromptBuilder(
      (mode) => toolDefinitionsForMode(toolsWithDelegate(), mode),
      () => "/w",
    );
    const prompt = withDelegate.build("agent");
    expect(prompt).toContain("STEER the sub-agent");
    expect(prompt).toContain("SAME skills catalog");
    // Parallel OFF: the concept stays hidden entirely (no mention of steering either).
    const without = new DefaultSystemPromptBuilder(
      (mode) => toolDefinitionsForMode(tools(), mode),
      () => "/w",
    );
    expect(without.build("agent")).not.toContain("STEER the sub-agent");
  });

  it("tells the orchestrator to SELECT which attachments each sub-task gets (Parallel ON)", () => {
    const withDelegate = new DefaultSystemPromptBuilder(
      (mode) => toolDefinitionsForMode(toolsWithDelegate(), mode),
      () => "/w",
    );
    const prompt = withDelegate.build("agent");
    // The sub-agent is BLIND to the user's files unless forwarded, and the
    // orchestrator chooses per sub-task (omit = all).
    expect(prompt).toContain("unless you forward them");
    expect(prompt).toContain("give each sub-task ONLY the ones it needs");
    // Parallel OFF: the whole concept stays hidden.
    const without = new DefaultSystemPromptBuilder(
      (mode) => toolDefinitionsForMode(tools(), mode),
      () => "/w",
    );
    expect(without.build("agent")).not.toContain("unless you forward them");
  });

  it("states the mode-aware split rule when Parallel is ON", () => {
    const withDelegate = new DefaultSystemPromptBuilder(
      (mode) => toolDefinitionsForMode(toolsWithDelegate(), mode),
      () => "/w",
    );
    for (const mode of ["analyze", "agent"] as const) {
      const p = withDelegate.build(mode);
      // The IDENTITY: parallel work = Delegate; own tool calls are serial.
      expect(p).toContain("PARALLELISM MEANS SUB-TASKS");
      expect(p).toContain("you MUST call Delegate");
      // The ordered decision + HARD RULE.
      expect(p).toContain("SPLIT DECISION");
      expect(p).toContain("DEPENDENCY");
      expect(p).toContain("HARD RULE");
      // Planning details + report footer + resources hint.
      expect(p).toContain("MEANINGFUL");
      expect(p).toContain("NOT a sandbox");
      expect(p).toContain("[harny-subagent-report]");
      // The old permissive wording is GONE.
      expect(p).not.toContain("YOU DO NOT HAVE TO DELEGATE");
      expect(p).not.toContain("judgment call");
    }
    // The conflict rule is MODE-AWARE.
    const analyze = withDelegate.build("analyze");
    expect(analyze).toContain("NOTHING is written");
    expect(analyze).toContain("can NEVER conflict");
    // Analyze: sub-agents are read-only, so a write task is delegated as "read"
    // (a write/create delegate is refused) and PREPARES previews.
    expect(analyze).toContain("every sub-agent is READ-ONLY");
    expect(analyze).toContain('"write"/"create" delegate is REFUSED');
    const build = withDelegate.build("agent");
    expect(build).toContain("at least one of them WRITES it");
    expect(build).toContain("Two different files never conflict");
  });

  it("Parallel OFF never mentions sub-agents / Delegate / Parallel (both modes)", () => {
    const builder = new DefaultSystemPromptBuilder(
      (mode) => toolDefinitionsForMode(tools(), mode),
      () => "/w",
    );
    for (const mode of ["analyze", "agent"] as const) {
      const p = builder.build(mode);
      expect(p).not.toContain("PARALLELISM");
      expect(p).not.toContain("sub-agent");
      expect(p).not.toContain("Delegate");
      expect(p).not.toContain("delegate");
    }
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

function toolsWithTodo(): Tool[] {
  return [
    ...tools(),
    {
      name: TODO_TOOL_NAME,
      definition: {
        name: TODO_TOOL_NAME,
        description: "Manage the task list.",
        parameters: { type: "object", properties: {} },
      },
      execute: async () => ({ content: "ok", isError: false }),
    },
  ];
}

describe("SubAgentSystemPromptBuilder", () => {
  const build = (
    opts: { role?: string; access: "read" | "write" | "create"; resources: string[] },
    mode: "analyze" | "agent",
  ) =>
    new SubAgentSystemPromptBuilder(
      (m) => toolDefinitionsForMode(tools(), m),
      () => "/w",
      opts,
    ).build(mode);

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

  it("forbids a sub-agent from keeping its own task list", () => {
    // Its todo state is keyed by its own ownerId, so the orchestrator never sees
    // it: a list here only burns turns from the sub-agent's budget.
    const opts = { access: "read" as const, resources: ["a"] };
    const withTodo = new SubAgentSystemPromptBuilder(
      (m) => toolDefinitionsForMode(toolsWithTodo(), m),
      () => "/w",
      opts,
    ).build("analyze");
    expect(withTodo).toContain("Do NOT use TodoWrite");

    const withoutTodo = new SubAgentSystemPromptBuilder(
      (m) => toolDefinitionsForMode(tools(), m),
      () => "/w",
      opts,
    ).build("analyze");
    expect(withoutTodo).not.toContain("TodoWrite");
  });

  it("gives the sub-agent the SAME skills catalog as the orchestrator", () => {
    const prompt = new SubAgentSystemPromptBuilder(
      (m) => toolDefinitionsForMode(tools(), m),
      () => "/w",
      { access: "read", resources: [] },
      () => [
        {
          name: "pdf",
          description: "Extract PDF text",
          dir: "/w/.agents/skills/pdf",
          path: "/w/.agents/skills/pdf/SKILL.md",
        },
        {
          name: "grill-me",
          description: "Interview",
          dir: "/w/.agents/skills/grill-me",
          path: "/w/.agents/skills/grill-me/SKILL.md",
          disableModelInvocation: true,
        },
      ],
    ).build("analyze");
    expect(prompt).toContain("## Skills");
    expect(prompt).toContain("- pdf: Extract PDF text");
    expect(prompt).toContain("Skill tool");
    // Same rule as the orchestrator: manual-only skills are NOT offered to the model.
    expect(prompt).not.toContain("- grill-me:");

    // No catalog -> no section (the pre-feature behaviour is unchanged).
    const without = new SubAgentSystemPromptBuilder(
      (m) => toolDefinitionsForMode(tools(), m),
      () => "/w",
      { access: "read", resources: [] },
    ).build("analyze");
    expect(without).not.toContain("## Skills");
  });
});
