import { describe, it, expect } from "vitest";
import { parseSkillMd, loadSkill, discoverSkills } from "./skill-loader";
import type { FileSystem } from "../tools/file-system";

/** Tiny in-memory FileSystem keyed by absolute path. Separator-agnostic: keys
 * and query paths are normalised to `/`, so it works on Windows too (where
 * `path.join` yields `\\`). */
function memFs(files: Record<string, string>): FileSystem {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) map[norm(k)] = v;
  const dirs = new Set<string>();
  for (const p of Object.keys(map)) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/") || "/");
  }
  return {
    readText: (p) => {
      const k = norm(p);
      if (k in map) return map[k];
      throw new Error("ENOENT " + p);
    },
    readBytes: (p) => Buffer.from(map[norm(p)] ?? "", "utf-8"),
    writeText: () => {},
    exists: (p) => norm(p) in map,
    isDirectory: (p) => dirs.has(norm(p)),
    realpath: (p) => p,
    list: (d) => {
      const base = norm(d);
      const out = new Set<string>();
      for (const k of Object.keys(map)) {
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

describe("parseSkillMd", () => {
  it("extracts name/description and strips the frontmatter from the body", () => {
    const { frontmatter, body } = parseSkillMd(
      "---\nname: pdf-processing\ndescription: \"Extract PDF text\"\n---\n# Heading\nDo the thing.\n",
    );
    expect(frontmatter.name).toBe("pdf-processing");
    expect(frontmatter.description).toBe("Extract PDF text");
    expect(body).toBe("# Heading\nDo the thing.");
  });

  it("handles a file with NO frontmatter (body = whole text)", () => {
    const { frontmatter, body } = parseSkillMd("Just instructions\nmore");
    expect(frontmatter).toEqual({});
    expect(body).toBe("Just instructions\nmore");
  });

  it("tolerates a BOM and single quotes", () => {
    const { frontmatter } = parseSkillMd("\uFEFF---\nname: 'x'\ndescription: y\n---\nbody");
    expect(frontmatter.name).toBe("x");
    expect(frontmatter.description).toBe("y");
  });
});

describe("loadSkill / discoverSkills", () => {
  it("loads a skill with frontmatter metadata", () => {
    const fs = memFs({
      "/w/.agents/skills/pdf/SKILL.md": "---\nname: pdf\ndescription: PDFs\n---\nInstructions here",
    });
    const skill = loadSkill(fs, "/w/.agents/skills/pdf");
    expect(skill?.name).toBe("pdf");
    expect(skill?.description).toBe("PDFs");
    expect(skill?.body).toBe("Instructions here");
    expect(skill?.dir).toBe("/w/.agents/skills/pdf");
  });

  it("falls back to the folder name and first meaningful body line", () => {
    const fs = memFs({
      "/w/.agents/skills/my-skill/SKILL.md": "# Title\n\nThe real first line.\nMore.",
    });
    const skill = loadSkill(fs, "/w/.agents/skills/my-skill");
    expect(skill?.name).toBe("my-skill");
    expect(skill?.description).toBe("The real first line.");
  });

  it("reads disable-model-invocation (manual activation only)", () => {
    const on = memFs({
      "/w/.agents/skills/x/SKILL.md": "---\nname: x\ndescription: X\ndisable-model-invocation: true\n---\nbody",
    });
    expect(loadSkill(on, "/w/.agents/skills/x")?.disableModelInvocation).toBe(true);
    const off = memFs({ "/w/.agents/skills/y/SKILL.md": "---\nname: y\ndescription: Y\n---\nbody" });
    expect(loadSkill(off, "/w/.agents/skills/y")?.disableModelInvocation).toBeUndefined();
  });

  it("ignores a folder without SKILL.md", () => {
    const fs = memFs({ "/w/.agents/skills/not-a-skill/readme.md": "x" });
    expect(discoverSkills(fs, ["/w/.agents/skills"])).toEqual([]);
  });

  it("discovers every immediate sub-folder that has a SKILL.md", () => {
    const fs = memFs({
      "/w/.agents/skills/a/SKILL.md": "---\nname: a\ndescription: A\n---\nx",
      "/w/.agents/skills/b/SKILL.md": "---\nname: b\ndescription: B\n---\ny",
      "/w/.agents/skills/loose.txt": "ignored",
    });
    const names = discoverSkills(fs, ["/w/.agents/skills"]).map((s) => s.name).sort();
    expect(names).toEqual(["a", "b"]);
  });

  it("ignores missing roots", () => {
    const fs = memFs({});
    expect(discoverSkills(fs, ["/does/not/exist"])).toEqual([]);
  });
});
