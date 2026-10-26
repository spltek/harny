import { basename, join } from "node:path";
import type { FileSystem } from "../tools/file-system";
import type { LoadedSkill } from "./types";

/**
 * Parse the YAML frontmatter of a SKILL.md. Only the two required Agent-Skills
 * fields are read (`name`, `description`); the parser is deliberately minimal
 * (flat `key: value` lines) so Harny needs NO YAML dependency. Returns the
 * frontmatter map plus the body with the frontmatter block removed.
 */
export function parseSkillMd(text: string): { frontmatter: Record<string, string>; body: string } {
  const normalized = text.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(normalized);
  if (!match) return { frontmatter: {}, body: normalized.trim() };
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    let value = m[2].trim();
    // Strip surrounding single/double quotes (common in frontmatter).
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    frontmatter[m[1].toLowerCase()] = value;
  }
  return { frontmatter, body: normalized.slice(match[0].length).trim() };
}

/** First non-empty, non-heading line of the body — a description fallback. */
function firstMeaningfulLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    return t.length > 200 ? t.slice(0, 200) + "…" : t;
  }
  return "";
}

/** Read + parse one `SKILL.md` from `dir`, or undefined when it is missing or
 * unreadable. `name` falls back to the folder name; `description` to the first
 * meaningful body line. */
export function loadSkill(fs: FileSystem, dir: string): LoadedSkill | undefined {
  const path = join(dir, "SKILL.md");
  if (!fs.exists(path)) return undefined;
  let text: string;
  try {
    text = fs.readText(path);
  } catch {
    return undefined;
  }
  const { frontmatter, body } = parseSkillMd(text);
  const name = (frontmatter.name || "").trim() || basename(dir);
  const description = (frontmatter.description || "").trim() || firstMeaningfulLine(body);
  const disableModelInvocation = /^(true|yes|1)$/i.test(frontmatter["disable-model-invocation"] ?? "");
  return {
    name,
    description,
    dir,
    path,
    body,
    ...(disableModelInvocation ? { disableModelInvocation: true } : {}),
  };
}

/**
 * Discover every skill in the given roots: each IMMEDIATE sub-directory that
 * contains a `SKILL.md` is one skill. Missing roots are ignored.
 */
export function discoverSkills(fs: FileSystem, roots: readonly string[]): LoadedSkill[] {
  const out: LoadedSkill[] = [];
  for (const root of roots) {
    if (!root || !fs.isDirectory(root)) continue;
    for (const entry of fs.list(root)) {
      const dir = join(root, entry);
      if (!fs.isDirectory(dir)) continue;
      const skill = loadSkill(fs, dir);
      if (skill) out.push(skill);
    }
  }
  return out;
}
