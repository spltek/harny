import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { defaultSkillRoots } from "./skill-roots";

describe("defaultSkillRoots", () => {
  it("lists PROJECT roots first, then USER roots (project shadows user)", () => {
    const roots = defaultSkillRoots("/w", "/home/u");
    expect(roots[0]).toBe(join("/w", ".agents", "skills"));
    expect(roots.indexOf(join("/w", ".agents", "skills"))).toBeLessThan(
      roots.indexOf(join("/home/u", ".agents", "skills")),
    );
  });

  it("includes the `pi` dirs (project .pi/skills + user ~/.pi/agent/skills)", () => {
    const roots = defaultSkillRoots("/w", "/home/u");
    expect(roots).toContain(join("/w", ".pi", "skills"));
    expect(roots).toContain(join("/home/u", ".pi", "agent", "skills"));
  });

  it("includes the other common agent dirs", () => {
    const roots = defaultSkillRoots("/w", "/home/u");
    for (const p of [
      join("/w", ".claude", "skills"),
      join("/home/u", ".agents", "skills"),
      join("/home/u", ".config", "agents", "skills"),
      join("/home/u", ".claude", "skills"),
      join("/home/u", ".cursor", "skills"),
      join("/home/u", ".gemini", "skills"),
      join("/home/u", ".copilot", "skills"),
    ]) {
      expect(roots).toContain(p);
    }
  });
});
