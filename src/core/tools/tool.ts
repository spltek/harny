export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** True when no valid JSON arguments could be parsed from the stream (malformed/empty). */
  malformed?: boolean;
  /** True when the arguments had to be REBUILT from an incomplete JSON fragment (see
   * tool-call-accumulator). On its own it is not a fault — models emit sloppy or fenced JSON, and
   * reconstructing it is deliberate — but combined with {@link truncated} it means half an
   * argument. */
  repaired?: boolean;
  /** True when the turn that emitted this call was cut by the output-token limit
   * (`finish_reason: "length"`), i.e. the stream stopped mid-emission. A FACT ABOUT THE CALL, not
   * agent state: it cannot go stale between turns and every consumer reads the same value. */
  truncated?: boolean;
}

export interface ToolResult {
  content: string;
  isError: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the arguments. `type` and `properties` are the shape every caller
   * relies on; the REST is passed through untouched, because a tool that brings its own
   * schema (an MCP server) may use `oneOf`, `additionalProperties`, `$defs`/`$ref` and
   * defaults — rebuilding the object from two keys silently dropped all of them. */
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    [keyword: string]: unknown;
  };
}

/**
 * Execution context passed by the orchestrator to a tool.
 *
 * `dryRun` is set in Analyze (read-only preview) mode: the tool must VALIDATE
 * and describe the change (compute the diff) but NEVER touch the filesystem.
 * The result is shown to the user as a proposal, to be applied after switching
 * to Build mode.
 */
export interface ToolContext {
  dryRun?: boolean;
  /** The run's abort signal: long-running tools (Shell) cancel their work when
   * the user presses Stop. Absent in contexts that have no run. */
  signal?: AbortSignal;
  /** The session's USABLE context (window − output reserve), in tokens. Tools that
   * emit large output size their cap against it, so a single result cannot eat the
   * whole window of a small local model (see output-budget.ts). Absent = the tool's
   * own fixed ceiling, i.e. the behaviour outside a session. */
  contextBudget?: number;
}

/**
 * How a tool behaves in Analyze (read-only PREVIEW) mode.
 *
 * Analyze promises ONE thing: **no resource is modified**. Each tool says how that
 * promise is kept for it, and the default is `"refuse"` — the only safe answer for a
 * tool nobody described (a new MCP server, a plugin, a tool added tomorrow). With the
 * name lists this used to be the opposite: an unknown tool was assumed harmless and ran
 * for real (an MCP `drop_table` "was not a file-mutating tool").
 *
 *   · `"read-only"` — cannot change anything (files, databases, the world): runs normally.
 *   · `"preview"`   — changes files and WE own it: runs DRY (validated diff, nothing written).
 *   · `"guarded"`   — not classifiable on its own: the tool validates each call itself via
 *                     {@link Tool.guardAnalyze} (Shell: a read-only allowlist).
 *   · `"refuse"`    — may change something we can neither preview nor validate: never runs.
 */
export type AnalyzePolicy = "read-only" | "preview" | "guarded" | "refuse";

/** The policy that applies when a tool does not declare one: NOT harmless. */
export const DEFAULT_ANALYZE_POLICY: AnalyzePolicy = "refuse";

export interface Tool {
  readonly name: string;
  readonly definition: ToolDefinition;
  /** How this tool keeps Analyze's promise (see {@link AnalyzePolicy}). */
  readonly analyzePolicy?: AnalyzePolicy;
  /** For `analyzePolicy: "guarded"`: validate ONE call against Analyze. Returns the
   * refusal message (shown to the model, and in the transcript) or undefined to allow.
   * Living HERE, next to the tool, is what keeps the agent free of tool-name lists. */
  guardAnalyze?(args: Record<string, unknown>): string | undefined;
  /** Appended to this tool's description in Analyze only, so the model knows the contract
   * it is working under ("this write is a PROPOSAL", "only read-only commands run"). */
  readonly analyzeNote?: string;
  /** What the model is told when this tool is refused in Analyze. Optional: a tool that
   * knows how to unblock itself (an MCP server) says it better than any generic text. */
  readonly analyzeRefusal?: string;
  /** True when an identical call may be REUSED verbatim (loop guard cache). A tool that
   * is read-only may still be time-varying (WebSearch), so this is a separate fact from
   * {@link Tool.analyzePolicy}. Default: never cached. */
  readonly cacheable?: boolean;
  execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> | ToolResult;
}
