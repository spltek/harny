import { describe, it, expect } from "vitest";
import { SkillRegistry } from "./skill-registry";
import type { FileSystem } from "../tools/file-system";

/** In-memory FileSystem, separator-agnostic (normalises `\\` → `/` so it also
 * works on Windows) and derived from the CURRENT map so a mid-test insert is
 * seen. */
function memFs(files: Record<string, string>): FileSystem {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const entries = () => Object.entries(files).map(([k, v]) => [norm(k), v] as const);
  return {
    readText: (p) => {
      const k = norm(p);
      const hit = entries().find(([kk]) => kk === k);
      if (hit) return hit[1];
      throw new Error("ENOENT " + p);
    },
    readBytes: (p) => {
      const k = norm(p);
      const hit = entries().find(([kk]) => kk === k);
      return Buffer.from(hit?.[1] ?? "", "utf-8");
    },
    writeText: () => {},
    exists: (p) => {
      const k = norm(p);
      return entries().some(([kk]) => kk === k);
    },
    isDirectory: (p) => {
      const k = norm(p);
      return entries().some(([kk]) => kk.startsWith(k + "/"));
    },
    realpath: (p) => p,
    list: (d) => {
      const base = norm(d);
      const out = new Set<string>();
      for (const [k] of entries()) {
        if (!k.startsWith(base + "/")) continue;
        out.add(k.slice(base.length + 1).split("/")[0]);
      }
      return [...out];
    },
    size: () => 0,
    mtimeMs: () => 0,
    mkdirRecursive: () => {},
    delete: () => {},
  };
}

const skill = (dir: string, name: string, description = "d") =>
  [`${dir}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\nbody`] as const;

describe("SkillRegistry", () => {
  it("merges roots, sorts by name, and a PROJECT skill shadows a USER one", () => {
    const files = Object.fromEntries([
      skill("/proj/.agents/skills/alpha", "alpha", "project alpha"),
      skill("/proj/.agents/skills/beta", "beta", "project beta"),
      skill("/home/.agents/skills/alpha", "alpha", "user alpha"),
      skill("/home/.agents/skills/gamma", "gamma", "user gamma"),
    ]);
    const reg = new SkillRegistry(memFs(files), () => ["/proj/.agents/skills", "/home/.agents/skills"]);

    const list = reg.list();
    expect(list.map((s) => s.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(reg.get("alpha")?.description).toBe("project alpha"); // project wins
    expect(reg.get("gamma")?.description).toBe("user gamma");
  });

  it("get() returns undefined for an unknown skill", () => {
    const reg = new SkillRegistry(memFs({}), () => []);
    expect(reg.get("nope")).toBeUndefined();
  });

  it("re-scans after invalidate() (a skill installed mid-session shows up)", () => {
    const files: Record<string, string> = {};
    const fs = memFs(files);
    const reg = new SkillRegistry(fs, () => ["/w/.agents/skills"]);
    expect(reg.list()).toEqual([]);

    files["/w/.agents/skills/new/SKILL.md"] = "---\nname: new\ndescription: N\n---\nbody";
    // The short TTL cache would hide it briefly; invalidate() forces a re-scan.
    reg.invalidate();
    expect(reg.list().map((s) => s.name)).toEqual(["new"]);
  });
});
