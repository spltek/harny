import type { FileSystem } from "../tools/file-system";
import { discoverSkills } from "./skill-loader";
import type { LoadedSkill } from "./types";

/** Re-scan interval: skills can be installed at ANY time (`npx skills add`), so
 * the registry re-discovers periodically instead of only at startup. */
const CACHE_TTL_MS = 3000;

/**
 * Discovers the installed Agent Skills from a list of roots (project first,
 * then user) and serves them by name. First root wins on a name clash, so a
 * project skill shadows a user-level one. Discovery is cached for a short TTL.
 */
export class SkillRegistry {
  private cache: LoadedSkill[] = [];
  private cacheAt = 0;

  constructor(
    private fs: FileSystem,
    private roots: () => string[],
  ) {}

  /** All discovered skills, de-duplicated by name and sorted by name. */
  list(): LoadedSkill[] {
    const now = Date.now();
    if (now - this.cacheAt < CACHE_TTL_MS) return this.cache;
    const byName = new Map<string, LoadedSkill>();
    for (const s of discoverSkills(this.fs, this.roots())) {
      if (!byName.has(s.name)) byName.set(s.name, s);
    }
    this.cache = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    this.cacheAt = now;
    return this.cache;
  }

  /** One skill by exact name, or undefined. */
  get(name: string): LoadedSkill | undefined {
    return this.list().find((s) => s.name === name);
  }

  /** Drop the cache so the next `list()` re-scans (e.g. right after an install). */
  invalidate(): void {
    this.cacheAt = 0;
  }
}
