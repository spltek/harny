import { join } from "node:path";

/**
 * Standard Agent-Skills directories, PROJECT first (a project skill shadows a
 * user one of the same name), then USER-level. These mirror the per-agent dirs
 * the `skills` CLI (skills.sh) writes to, so a skill installed for ANY common
 * agent (`-a pi`, `-a universal`, `-a cursor`, …) is found by Harny.
 */
export function defaultSkillRoots(cwd: string, home: string): string[] {
  return [
    // Project-level.
    join(cwd, ".agents", "skills"),
    join(cwd, ".claude", "skills"),
    join(cwd, ".pi", "skills"),
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
