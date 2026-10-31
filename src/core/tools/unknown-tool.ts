/**
 * What the model reads when it calls a tool that is NOT there.
 *
 * The case that produced this file, seen in a real transcript: a provider handed
 * over a second call named `Greplike" string="true` (arguments that leaked into the
 * name field) and the answer was a bare `Unknown tool: Greplike" string="true`.
 * Nothing in that reply said the name is not a NAME, nothing said which names
 * exist, and so the transcript kept a bubble that looks like a tool Harny forgot
 * to draw and the model had nothing to correct itself with.
 *
 * A tool result is the ONLY channel the model has to learn from a mistake, so it
 * has to carry the diagnosis and the list. One turn, not two.
 */

/**
 * Characters a tool name can be made of, and how long it can get.
 *
 * Letters, digits and underscores: exactly what the MCP sanitiser keeps
 * (`mcp__<server>__<tool>`), which is also what the built-ins spell. A name that
 * fails this test was never a name — a quote, a space or a `=` in the name field
 * is a fragment of the ARGUMENTS sitting in the wrong place.
 */
const TOOL_NAME_SHAPE = /^[A-Za-z][A-Za-z0-9_]*$/;
const TOOL_NAME_MAX_CHARS = 64;

/** Whether `name` COULD be a tool name (not: whether it is a registered one). */
export function isToolName(name: string): boolean {
  return name.length > 0 && name.length <= TOOL_NAME_MAX_CHARS && TOOL_NAME_SHAPE.test(name);
}

/**
 * The error for a call whose name matches no tool.
 *
 * `available` is what the model was OFFERED this turn (not everything the
 * registry holds): a tool switched off for the session must not appear here,
 * or the reply would send the model straight into a second refusal.
 */
export function unknownToolMessage(name: string, available: readonly string[]): string {
  const lines = [`Unknown tool: ${name}`, ""];
  if (isToolName(name)) {
    lines.push("No tool by that name is offered in this run.");
  } else {
    lines.push(
      "That is not a tool name: it carries characters no name can have (a quote, a space or a `=`), " +
        "which is what a fragment of the ARGUMENTS looks like when it lands in the name field.",
      "Emit ONE call per tool, with the tool's name alone and its arguments as valid JSON.",
    );
  }
  if (available.length > 0) {
    lines.push("", `Available tools: ${available.join(", ")}.`);
  }
  return lines.join("\n");
}
