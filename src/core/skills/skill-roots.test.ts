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

  it("with NO cwd (Restricted Mode) returns ONLY the user roots — a repo's skills are workspace content", () => {
    // Workspace Trust is about what a REPO may make the machine do. A checked-in `SKILL.md` is
    // instructions from that repo, so an untrusted folder contributes no roots at all: the user's
    // own skills stay available (they installed them), the project's do not.
    const roots = defaultSkillRoots(undefined, "/home/u");
    expect(roots).not.toContain(join("/w", ".agents", "skills"));
    // The prefix is built with the SAME `join` the implementation uses, never the literal
    // "/home/u": `join` rewrites the separators on Windows (`\home\u\.agents\skills`), where a
    // literal prefix matches nothing and the filter silently keeps every root — green on macOS
    // and Ubuntu, red on the one runner that could see it. `skill-roots.win32.test.ts` asserts
    // this file's contracts under `path.win32` so the dialect is checked on every OS.
    expect(roots.filter((r) => !r.startsWith(join("/home/u")))).toEqual([]);
    expect(roots).toContain(join("/home/u", ".agents", "skills"));
  });
});
