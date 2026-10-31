import { join } from "node:path";

/**
 * Standard Agent-Skills directories, PROJECT first (a project skill shadows a
 * user one of the same name), then USER-level. These mirror the per-agent dirs
 * the `skills` CLI (skills.sh) writes to, so a skill installed for ANY common
 * agent (`-a pi`, `-a universal`, `-a cursor`, …) is found by Harny.
 *
 * `cwd` is UNDEFINED when the workspace must not be consulted — Restricted Mode (an untrusted
 * folder): a repo's `SKILL.md` is instructions the repo ships, i.e. workSPACE content, and
 * loading it while the folder is untrusted would be the very code path Workspace Trust exists to
 * close. Only the user-level roots are returned then; undefined is a verdict, not a default.
 */
export function defaultSkillRoots(cwd: string | undefined, home: string): string[] {
  return [
    // Project-level (only for a folder we may read instructions from).
    ...(cwd === undefined
      ? []
      : [join(cwd, ".agents", "skills"), join(cwd, ".claude", "skills"), join(cwd, ".pi", "skills")]),
    // User-level.
    join(home, ".agents", "skills"),
    join(home, ".config", "agents", "skills"),
    join(home, ".pi", "agent", "skills"),
    join(home, ".claude", "skills"),
    join(home, ".cursor", "skills"),
    join(home, ".gemini", "skills"),
    join(home, ".copilot", "skills"),
  ];
}
