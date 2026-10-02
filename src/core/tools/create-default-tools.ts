import type { HttpClient } from "../llm/http-client";
import type { CommandRunner } from "./command-runner";
import { DelegateTool } from "./delegate-tool";
import { DeleteTool } from "./delete-tool";
import { EditTool } from "./edit-tool";
import type { DiagnosticsProvider } from "./diagnostics-provider";
import type { FileSystem } from "./file-system";
import { GlobTool } from "./glob-tool";
import { GrepTool } from "./grep-tool";
import { ReadLintsTool } from "./read-lints-tool";
import { ReadTool } from "./read-tool";
import { ShellTool } from "./shell-tool";
import { StrReplaceTool } from "./str-replace-tool";
import { TodoTool } from "./todo-tool";
import type { Tool } from "./tool";
import { WebFetchTool } from "./web-fetch-tool";
import { WebSearchTool } from "./web-search-tool";
import { WriteTool } from "./write-tool";

export interface DefaultToolsDeps {
  fs: FileSystem;
  runner: CommandRunner;
  http: HttpClient;
  diagnostics: DiagnosticsProvider;
  cwd: () => string;
}

/** Builds the standard set of tools with injected dependencies. */
export function createDefaultTools(deps: DefaultToolsDeps): Tool[] {
  return [
    new DelegateTool(),
    new ReadTool(deps.fs, deps.cwd),
    new WriteTool(deps.fs, deps.cwd),
    new StrReplaceTool(deps.fs, deps.cwd),
    new EditTool(deps.fs, deps.cwd),
    new DeleteTool(deps.fs, deps.cwd),
    new ShellTool(deps.runner, deps.cwd),
    new GrepTool(deps.fs, deps.cwd),
    new GlobTool(deps.fs, deps.cwd),
    new TodoTool(),
    new WebSearchTool(deps.http),
    new WebFetchTool(deps.http),
    new ReadLintsTool(deps.diagnostics, deps.cwd),
  ];
}
