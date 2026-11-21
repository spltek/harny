import { resolve } from "node:path";
import type { ToolResult } from "../tools/tool";

/** The orchestration tool: launches a sub-agent and returns its report. */
export const DELEGATE_TOOL_NAME = "Delegate";

type DelegateAccess = "read" | "write" | "create";

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
        "the sub-agent will touch (it drives the safe-parallelism decision). Read-only tasks that do not touch " +
        'files (e.g. web research) may leave "resources" empty.',
    };
  }

  const id = typeof args.id === "string" && args.id.trim() ? args.id.trim() : "";
  const role = typeof args.role === "string" && args.role.trim() ? args.role.trim() : undefined;
  const context = typeof args.context === "string" && args.context.trim() ? args.context.trim() : undefined;
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
      after,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    },
  };
}

function isAbsolutePath(p: string): boolean {
  // POSIX absolute (/x), Windows drive (C:\x or C:/x), Windows UNC
  // (\\server\share) and Windows root-relative (\x) — all must NOT be resolved
  // against the cwd.
  return p.startsWith("/") || p.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(p);
}

/** Normalize a resource path: resolve it against the working directory when it
 * is relative (so `src/a.ts` and `/proj/src/a.ts` MATCH), then collapse
 * separators/case. A `.`/`/`/empty path normalizes to the ROOT marker. */
function normalizePath(p: string, cwd?: string): string {
  let s = p.trim();
  if (cwd && s && !isAbsolutePath(s)) s = resolve(cwd, s);
  const n = s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return n;
}

/** A path that means "the whole working directory" (matches EVERYTHING). */
function isRootPath(n: string): boolean {
  return n === "" || n === "." || n === "/";
}

/** Do two resource sets overlap (same path, or one dir containing the other)?
 * `.`/`/` (or the working directory) means "everything" and matches any path,
 * so a writer on the root can never run in parallel with another writer. */
export function resourcesOverlap(a: readonly string[], b: readonly string[], cwd?: string): boolean {
  return a.some((x) =>
    b.some((y) => {
      const nx = normalizePath(x, cwd);
      const ny = normalizePath(y, cwd);
      if (isRootPath(nx) || isRootPath(ny)) return true;
      return nx === ny || nx.startsWith(ny + "/") || ny.startsWith(nx + "/");
    }),
  );
}

/** True when running both together could race on a write. */
export function haveWriteConflict(a: DelegateSpec, b: DelegateSpec, cwd?: string): boolean {
  const aWrite = a.access !== "read";
  const bWrite = b.access !== "read";
  if (!aWrite && !bWrite) return false;
  return resourcesOverlap(a.resources, b.resources, cwd);
}

export interface PlannedCall {
  /** True for the Delegate tool. */
  isDelegate: boolean;
  /** Parsed spec (undefined when the delegate args are invalid → serial). */
  spec?: DelegateSpec;
}

/** One execution step: a single call, or a batch that may run concurrently. */
type ExecutionStep = { kind: "single"; index: number } | { kind: "parallel"; indices: number[] };

/**
 * Plan how to execute a turn's tool calls.
 *
 * Delegates are batched together as long as they do NOT conflict on resources:
 * reads never conflict with reads, and a WRITE only conflicts with another call
 * whose resources OVERLAP it. So 5 writers on 5 DIFFERENT files run in parallel;
 * two writers on the same file (or a reader of a file being written) are split
 * into separate steps. A non-delegate call (or an INVALID delegate) is a
 * BARRIER that runs on its own. A delegate with `after` runs ONLY after the
 * steps that contain its dependencies — even when the model emits the calls out
 * of order (the dependency is resolved, not just treated as a position).
 * Results keep the original call order (the caller stores by index).
 */
export function planToolExecution(calls: readonly PlannedCall[], cwd?: string): ExecutionStep[] {
  const steps: ExecutionStep[] = [];
  let batch: { index: number; spec: DelegateSpec }[] = [];
  const completed = new Set<string>(); // delegate ids already in a CLOSED step
  const flush = () => {
    if (batch.length === 1) steps.push({ kind: "single", index: batch[0].index });
    else if (batch.length > 1) steps.push({ kind: "parallel", indices: batch.map((b) => b.index) });
    for (const b of batch) if (b.spec.id) completed.add(b.spec.id);
    batch = [];
  };
  const inBatch = (id: string): boolean => batch.some((b) => b.spec.id === id);
  const depsReady = (spec: DelegateSpec): boolean => spec.after.every((d) => completed.has(d));
  const deferred: number[] = [];
  const place = (i: number): void => {
    const call = calls[i];
    const spec = call.isDelegate && call.spec ? call.spec : undefined;
    if (!spec) {
      flush();
      steps.push({ kind: "single", index: i });
      return;
    }
    // A dependency on a sibling in the CURRENT batch: close the batch first so
    // the dependency completes, then the dependent can start.
    if (spec.after.some((d) => inBatch(d))) flush();
    // A dependency that has not run yet (the model emitted out of order): defer
    // the call until its prerequisites are placed.
    if (!depsReady(spec)) {
      deferred.push(i);
      return;
    }
    if (batch.some((b) => haveWriteConflict(spec, b.spec, cwd))) flush();
    batch.push({ index: i, spec });
  };
  for (let i = 0; i < calls.length; i++) place(i);
  flush();
  // Resolve deferred calls now that every in-order call is placed. Repeat until
  // no progress; a leftover (cycle / unknown id) runs last rather than hanging.
  let progress = true;
  while (deferred.length > 0 && progress) {
    progress = false;
    for (let k = 0; k < deferred.length;) {
      const i = deferred[k];
      const spec = calls[i].spec!;
      if (depsReady(spec)) {
        deferred.splice(k, 1);
        progress = true;
        if (batch.some((b) => haveWriteConflict(spec, b.spec, cwd))) flush();
        batch.push({ index: i, spec });
      } else {
        k++;
      }
    }
  }
  for (const i of deferred) {
    const spec = calls[i].spec!;
    if (batch.some((b) => haveWriteConflict(spec, b.spec, cwd))) flush();
    batch.push({ index: i, spec });
  }
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
