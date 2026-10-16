import type { SkillRegistry } from "../skills/skill-registry";
import type { Tool, ToolDefinition, ToolResult } from "./tool";

export const SKILL_TOOL_NAME = "Skill";

/**
 * Activates an Agent Skill by name and returns its full instructions.
 *
 * Progressive disclosure: the SYSTEM PROMPT carries only the compact catalog
 * (name + description of every installed skill); this tool loads the heavy
 * `SKILL.md` body on demand, so the prompt stays small until a skill is used.
 */
export class SkillTool implements Tool {
  readonly name = SKILL_TOOL_NAME;
  readonly analyzePolicy = "read-only" as const;
  readonly cacheable = true;

  constructor(private skills: SkillRegistry) {}

  get definition(): ToolDefinition {
    return {
      name: SKILL_TOOL_NAME,
      description:
        'Activate a skill by name and return its full instructions. When the task matches one of the skills listed under "## Skills" in the system prompt, call this tool FIRST (with that skill\'s exact name), then follow the returned instructions. Skills are reusable instruction sets installed from the skills.sh ecosystem (e.g. `npx skills add <repo>`).',
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Exact name of the skill to activate (from the ## Skills list).",
          },
        },
        required: ["name"],
      },
    };
  }

  execute(args: Record<string, unknown>): ToolResult {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return { content: "Skill: missing required 'name'.", isError: true };
    const skill = this.skills.get(name);
    if (!skill) {
      const available = this.skills.list().map((s) => s.name).join(", ") || "(none installed)";
      return {
        content: `Unknown skill "${name}". Installed skills: ${available}.`,
        isError: true,
      };
    }
    return {
      content:
        `<skill name="${skill.name}" dir="${skill.dir}">\n${skill.body}\n</skill>\n\n` +
        `Follow the instructions above for the current task. Any resources they reference live in ` +
        `${skill.dir} — read them with Read/Glob/Grep as needed.`,
      isError: false,
    };
  }
}
