import type { CommandRunner } from "./command-runner";
import { resolvePath } from "./path-utils";
import type { Tool, ToolDefinition, ToolResult } from "./tool";

const MAX_OUTPUT = 50000;

export class ShellTool implements Tool {
  readonly name = "Shell";
  readonly definition: ToolDefinition = {
    name: "Shell",
    description:
      "Executes a given command in a shell session, waiting for output for `block_until_ms` milliseconds.\n\n" +
      "The following permissions are supported:\n" +
      "- full_network: Grants unrestricted network access.\n" +
      "- all: Disables the sandbox entirely.\n\n" +
      "The required_permissions argument is used to request additional permissions.",
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
          description:
            "How long to block and wait for the command to complete before moving it to background (in milliseconds). Defaults to 30000ms.",
        },
        required_permissions: {
          type: "array",
          description: "Optional list of permissions to request (full_network, all).",
          items: { type: "string", enum: ["full_network", "all"] },
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
    const permissions = args.required_permissions as string[] | undefined;

    if (permissions?.includes("all")) {
      return {
        content: `Permission 'all' requested but sandbox disabling is not supported in harny. Command would run: "${command}" in ${wd}`,
        isError: true,
      };
    }

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
