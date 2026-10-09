import type { ToolResult } from "../tools/tool";

/** The orchestration tool: launches a sub-agent and returns its report. */
export const DELEGATE_TOOL_NAME = "Delegate";

export type DelegateAccess = "read" | "write" | "create";

/**
 * A structured sub-agent request declared by the orchestrator. The orchestrator
 * MUST say what it will touch (`resources`) and how (`access`); the host uses
 * this to decide what may run concurrently — reads yes, writers never together.
 */
export interface DelegateSpec {
  /** Short id used for dependencies (`after`) and reporting. */
  id: string;
  goal: string;
  context?: string;
  role?: string;
  access: DelegateAccess;
  /** Files/dirs the sub-agent will touch (drives the parallel decision). */
  resources: string[];
  /** Whether this read-only sub-task may run alongside other reads. Undefined
   * = default (read-only tasks ARE parallelizable); `false` = force serial. */
  parallel?: boolean;
  /** Ids of sibling sub-tasks that must finish first. */
  after: string[];
  /** Numbers (1-based) of the user's attachments this sub-task needs. Omitted
   * = ALL of the current message's attachments are forwarded. */
  attachments?: number[];
  /** Runtime-only: image data URIs resolved by the host for the sub-agent. */
  images?: string[];
  /** Runtime-only: inline text of the resolved text attachments. */
  attachmentText?: string;
}

/** Parse + validate the raw Delegate tool arguments. */
export function parseDelegateSpec(args: Record<string, unknown>): { spec?: DelegateSpec; error?: string } {
  const goal = typeof args.goal === "string" ? args.goal.trim() : "";
  if (!goal) return { error: 'Delegate requires a non-empty "goal".' };

  const access = args.access;
  if (access !== "read" && access !== "write" && access !== "create") {
    return { error: 'Delegate requires "access" to be one of: "read", "write", "create".' };
  }

  const resources = Array.isArray(args.resources)
    ? args.resources.filter((r): r is string => typeof r === "string" && r.trim().length > 0).map((r) => r.trim())
    : [];
  // Read-only tasks that do NOT touch the filesystem (web research, analysis of
  // the conversation) legitimately have no resources: allow an empty array so
  // they never fail. Writers MUST declare what they touch, because that is what
  // keeps two writers on the same file from running in parallel.
  if (resources.length === 0 && access !== "read") {
    return {
      error:
        'Delegate with access "write"/"create" requires a non-empty "resources" array listing the files/dirs ' +
        'the sub-agent will touch (it drives the safe-parallelism decision). Read-only tasks that do not touch ' +
        'files (e.g. web research) may leave "resources" empty.',
    };
  }

  const id = typeof args.id === "string" && args.id.trim() ? args.id.trim() : "";
  const role = typeof args.role === "string" && args.role.trim() ? args.role.trim() : undefined;
  const context = typeof args.context === "string" && args.context.trim() ? args.context.trim() : undefined;
  const parallel =
    args.parallel === "yes" ? true : args.parallel === "no" ? false : undefined;
  const after = Array.isArray(args.after)
    ? args.after.filter((a): a is string => typeof a === "string" && a.trim().length > 0).map((a) => a.trim())
    : [];
  const attachments = Array.isArray(args.attachments)
    ? args.attachments.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0)
    : undefined;

  return {
    spec: {
      id,
      goal,
      context,
      role,
      access,
      resources,
      parallel,
      after,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    },
  };
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Do two resource sets overlap (same path, or one dir containing the other)? */
export function resourcesOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) =>
    b.some((y) => {
      const nx = normalizePath(x);
      const ny = normalizePath(y);
      return nx === ny || nx.startsWith(ny + "/") || ny.startsWith(nx + "/");
    }),
  );
}

/** True when running both together could race on a write. */
export function haveWriteConflict(a: DelegateSpec, b: DelegateSpec): boolean {
  const aWrite = a.access !== "read";
  const bWrite = b.access !== "read";
  if (!aWrite && !bWrite) return false;
  return resourcesOverlap(a.resources, b.resources);
}

export interface PlannedCall {
  /** True for the Delegate tool. */
  isDelegate: boolean;
  /** Parsed spec (undefined when the delegate args are invalid → serial). */
  spec?: DelegateSpec;
}

/** One execution step: a single call, or a batch that may run concurrently. */
export type ExecutionStep =
  | { kind: "single"; index: number }
  | { kind: "parallel"; indices: number[] };

/**
 * Plan how to execute a turn's tool calls.
 *
 * CONSECUTIVE delegates with no ordering dependency are batched together as
 * long as they do NOT conflict on resources: reads never conflict with reads,
 * and a WRITE only conflicts with another call whose resources OVERLAP it.
 * So 5 writers on 5 DIFFERENT files run in parallel; two writers on the same
 * file (or a reader of a file being written) are split into separate steps.
 * Any non-delegate call, or a delegate with an `after` dependency, is a
 * BARRIER that runs on its own. Results keep the original call order.
 */
export function planToolExecution(calls: readonly PlannedCall[]): ExecutionStep[] {
  const steps: ExecutionStep[] = [];
  let batch: { index: number; spec: DelegateSpec }[] = [];
  const flush = () => {
    if (batch.length === 1) steps.push({ kind: "single", index: batch[0].index });
    else if (batch.length > 1) steps.push({ kind: "parallel", indices: batch.map((b) => b.index) });
    batch = [];
  };
  calls.forEach((call, i) => {
    const spec =
      call.isDelegate && call.spec && call.spec.after.length === 0 ? call.spec : undefined;
    if (!spec) {
      flush();
      steps.push({ kind: "single", index: i });
      return;
    }
    // Cannot share a batch with a conflicting call (overlapping write): start
    // a fresh batch so it can still parallelize with later safe calls.
    if (batch.some((b) => haveWriteConflict(spec, b.spec))) flush();
    batch.push({ index: i, spec });
  });
  flush();
  return steps;
}

/** Build the user message that seeds a sub-agent run. */
export function buildSubAgentTask(spec: DelegateSpec): string {
  const parts = [`Task${spec.id ? ` "${spec.id}"` : ""}:`, spec.goal];
  if (spec.context) parts.push("", "Context provided by the calling agent:", spec.context);
  parts.push(
    "",
    "Complete ONLY this task, then reply with a CONCISE report (what you did, key results, files touched, blockers).",
  );
  return parts.join("\n");
}

/** Wrap a sub-agent's final text as the Delegate tool result. */
export function formatSubAgentReport(spec: DelegateSpec, report: string): string {
  const label = spec.id ? ` "${spec.id}"` : "";
  const role = spec.role ? ` [${spec.role}]` : "";
  return `🔁 Sub-agent${label}${role} report:\n${report}`;
}

export function formatSubAgentError(spec: DelegateSpec, message: string): string {
  const label = spec.id ? ` "${spec.id}"` : "";
  return `🔁 Sub-agent${label} failed: ${message}`;
}

/** Marker/result for a sub-agent the user stopped — either the whole-run Stop
 * or a per-sub-task abort. Always labelled "aborted": the UI has ONE terminal
 * stop state for sub-agents. It is an ERROR result on purpose: the orchestrator
 * must KNOW the sub-task did not finish and account for the gap, not treat it as
 * a successful report. */
export function formatSubAgentAborted(spec: DelegateSpec): string {
  const label = spec.id ? ` "${spec.id}"` : "";
  return (
    `⏹ Sub-agent${label} aborted by the user.` +
    " It did NOT finish and its work is incomplete: do not retry it unless asked;" +
    " continue with the remaining work and account for its missing result."
  );
}

export type { ToolResult };

/**
 * Run `worker` over `items` with at most `limit` in flight at any time. Unlike
 * chunked Promise.all (which waits for the whole chunk before starting the
 * next), a finished item immediately frees its slot for the next queued one,
 * so the pool stays saturated: there are always ~limit running until the
 * queue drains.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const max = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: max }, () => run()));
}
