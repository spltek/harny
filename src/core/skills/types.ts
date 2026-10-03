/**
 * Agent Skills: reusable instruction sets defined by a `SKILL.md` file with
 * YAML frontmatter (`name`, `description`) — the format used by skills.sh and
 * the wider ecosystem. Harny discovers them from the standard directories
 * (`.agents/skills/`, `.claude/skills/`) and activates them on demand.
 */

/** Metadata for one discovered skill (the catalog entry). */
export interface SkillMeta {
  name: string;
  description: string;
  /** Absolute path to the skill directory (holds SKILL.md + resources). */
  dir: string;
  /** Absolute path to the SKILL.md file. */
  path: string;
  /** `disable-model-invocation: true` — the model must NOT auto-activate it;
   * it stays available via the manual `/skill` command and the Skills card. */
  disableModelInvocation?: boolean;
}

/** A skill with its loaded instructions. */
export interface LoadedSkill extends SkillMeta {
  /** The SKILL.md body: the instructions, frontmatter stripped. */
  body: string;
}
