import type { CommandRunner } from "./command-runner";
import { toolOutputCapChars, truncationNote } from "./output-budget";
import { resolvePath } from "./path-utils";
import type { Tool, ToolContext, ToolDefinition, ToolResult } from "./tool";

const MAX_OUTPUT = 50000;
/** Hard ceiling for a single command: the model can ask for less, never more
 * (an unbounded wait would keep a tool call pending for hours). */
export const MAX_SHELL_TIMEOUT_MS = 300000;

/**
 * Collapse runs of consecutive identical lines (e.g. `yes … | head` floods)
 * into the first occurrence + a marker, so the output cap budget is spent on
 * UNIQUE content instead of thousands of copies.
 */
function collapseIdenticalRuns(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let j = i + 1;
    while (j < lines.length && lines[j] === line) j++;
    const run = j - i;
    if (run > 1) out.push(line, `… [${run - 1} identical lines collapsed]`);
    else out.push(line);
    i = j;
  }
  return out.join("\n");
}

export class ShellTool implements Tool {
  readonly name = "Shell";
  readonly definition: ToolDefinition = {
    name: "Shell",
    description:
      "Executes a given command in a shell session, blocking for up to `block_until_ms` milliseconds.\n\n" +
      "Commands that run longer than `block_until_ms` are terminated and reported as timed out — " +
      "they are NOT moved to the background.\n\n" +
      "Commands run directly in your local shell with no sandbox.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to execute" },
        description: {
          type: "string",
          description:
            "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls -> Lists files in current directory\nInput: git status -> Shows working tree status",
        },
        working_directory: {
          type: "string",
          description: "The absolute path to the working directory (defaults to current directory)",
        },
        block_until_ms: {
          type: "number",
          description: "How long to block and wait for the command to complete (in milliseconds). Defaults to 30000ms.",
        },
      },
      required: ["command"],
    },
  };

  constructor(
    private runner: CommandRunner,
    private cwd: () => string,
  ) {}

  async execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const command = args.command as string | undefined;
    if (!command) {
      return {
        content: 'Tool Shell requires the argument "command" (shell command string). Call again with {"command": "ls -la"}.',
        isError: true,
      };
    }
    // The cap follows the MODEL (see output-budget.ts): a fixed 50KB is ~12k tokens,
    // the whole window of a small local model — and this is the NEWEST result, so
    // observation masking cannot touch it. Every truncation point below uses this.
    const cap = toolOutputCapChars(MAX_OUTPUT, ctx?.contextBudget);

    const workingDir = args.working_directory as string | undefined;
    const wd = workingDir ? resolvePath(workingDir, this.cwd()) : this.cwd();

    // Clamp the requested wait into [1s, MAX_SHELL_TIMEOUT_MS] so a model cannot
    // freeze the host (or leave the call pending) with an extreme value.
    const requested = typeof args.block_until_ms === "number" ? args.block_until_ms : 30000;
    const timeout = Math.min(Math.max(requested, 1000), MAX_SHELL_TIMEOUT_MS);
    const result = await this.runner.run(command, { cwd: wd, timeoutMs: timeout, signal: ctx?.signal });

    if (result.aborted) {
      return { content: `Command aborted by the user (Stop): ${command}`, isError: true };
    }
    if (result.timedOut) {
      return { content: `Command timed out after ${timeout}ms: ${command}`, isError: true };
    }
    if (result.code !== 0) {
      return {
        content: `Command exited with code ${result.code}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`.slice(
          0,
          cap,
        ),
        isError: true,
      };
    }
    // Success path: stderr is NOT dropped — CLI tools emit warnings there
    // with exit code 0 (npm deprecations, git behind, compiler warnings) and
    // the model must see them. stdout runs of identical lines are collapsed
    // BEFORE the cap so a flood cannot eat the whole budget.
    const collapsedStdout = collapseIdenticalRuns(result.stdout);
    const out = collapsedStdout.length > cap ? collapsedStdout.slice(0, cap) + truncationNote(cap) : collapsedStdout;
    const err = result.stderr.trim();
    const content = err ? (out ? `${out}\n\nSTDERR:\n${err.slice(0, cap)}` : err) : out;
    return { content, isError: false };
  }
}
