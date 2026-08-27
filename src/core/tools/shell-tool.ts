import type { CommandRunner } from "./command-runner";
import { resolvePath } from "./path-utils";
import type { Tool, ToolDefinition, ToolResult } from "./tool";

const MAX_OUTPUT = 50000;

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

  execute(args: Record<string, unknown>): ToolResult {
    const command = args.command as string | undefined;
    if (!command) {
      return {
        content: 'Tool Shell requires the argument "command" (shell command string). Call again with {"command": "ls -la"}.',
        isError: true,
      };
    }

    const workingDir = args.working_directory as string | undefined;
    const wd = workingDir ? resolvePath(workingDir, this.cwd()) : this.cwd();

    const timeout = Math.max((args.block_until_ms as number | undefined) || 30000, 1000);
    const result = this.runner.run(command, { cwd: wd, timeoutMs: timeout });

    if (result.timedOut) {
      return { content: `Command timed out after ${timeout}ms: ${command}`, isError: true };
    }
    if (result.code !== 0) {
      return {
        content: `Command exited with code ${result.code}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`.slice(
          0,
          MAX_OUTPUT,
        ),
        isError: true,
      };
    }
    const truncated =
      result.stdout.length > MAX_OUTPUT
        ? result.stdout.slice(0, MAX_OUTPUT) + "\n\n[Output truncated at 50KB]"
        : result.stdout;
    return { content: truncated, isError: false };
  }
}
