import { describe, it, expect } from "vitest";
import { SkillTool, SKILL_TOOL_NAME } from "./skill-tool";
import type { SkillRegistry } from "../skills/skill-registry";
import type { LoadedSkill } from "../skills/types";

function stubRegistry(skills: LoadedSkill[]): SkillRegistry {
  return {
    list: () => skills,
    get: (n: string) => skills.find((s) => s.name === n),
    invalidate: () => {},
  } as unknown as SkillRegistry;
}

const pdf: LoadedSkill = {
  name: "pdf",
  description: "PDF stuff",
  dir: "/w/.agents/skills/pdf",
  path: "/w/.agents/skills/pdf/SKILL.md",
  body: "# PDF\nUse pdftotext.",
};

describe("SkillTool", () => {
  it("has a stable name + JSON schema", () => {
    const tool = new SkillTool(stubRegistry([]));
    expect(tool.name).toBe(SKILL_TOOL_NAME);
    expect(tool.definition.name).toBe("Skill");
    expect(tool.definition.parameters.type).toBe("object");
    expect(tool.definition.parameters.required).toEqual(["name"]);
  });

  it("activates a skill: returns its instructions + directory", () => {
    const tool = new SkillTool(stubRegistry([pdf]));
    const r = tool.execute({ name: "pdf" });
    expect(r.isError).toBe(false);
    expect(r.content).toContain("Use pdftotext.");
    expect(r.content).toContain("/w/.agents/skills/pdf");
    expect(r.content).toContain('<skill name="pdf"');
  });

  it("errors on an unknown skill, listing what is installed", () => {
    const tool = new SkillTool(stubRegistry([pdf]));
    const r = tool.execute({ name: "nope" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('Unknown skill "nope"');
    expect(r.content).toContain("pdf");
  });

  it("errors when the name is missing", () => {
    const tool = new SkillTool(stubRegistry([]));
    expect(tool.execute({}).isError).toBe(true);
  });
});
