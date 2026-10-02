import { Worker } from "node:worker_threads";

/**
 * Regexes run in a WORKER THREAD with a hard timeout, never on the extension
 * host's main thread. A pathological pattern (catastrophic backtracking, e.g.
 * `(a+)+$`) can therefore never freeze VS Code: on timeout the worker is
 * terminated and the call fails with a clear error. This mirrors what the best
 * harnesses get for free from ripgrep's linear-time engine, in pure JS.
 *
 * The worker is spawned from an inline source (`eval: true`) so there is no
 * separate file to bundle/ship.
 */
const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (msg) => {
  const { id, pattern, flags, multiline, items } = msg;
  try {
    const re = new RegExp(pattern, flags);
    const results = items.map((it) => {
      if (multiline) {
        return { path: it.path, at: it.text.search(re) };
      }
      const lines = it.text.split(/\\r?\\n/);
      const hit = [];
      for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) hit.push(i);
      return { path: it.path, hit };
    });
    parentPort.postMessage({ id, results });
  } catch (e) {
    parentPort.postMessage({ id, error: (e && e.message) || String(e) });
  }
});
`;

export interface MatchItem {
  path: string;
  text: string;
}
export interface MatchResult {
  path: string;
  /** Line indices that matched (lines mode). */
  hit?: number[];
  /** Match start index, or -1 (multiline mode). */
  at?: number;
}

export class RegexTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegexTimeoutError";
  }
}

type Reply = { results?: MatchResult[]; error?: string };

let worker: Worker | undefined;
let seq = 0;
const pending = new Map<number, (r: Reply) => void>();

function failAll(message: string): void {
  for (const resolve of pending.values()) resolve({ error: message });
  pending.clear();
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(WORKER_SOURCE, { eval: true });
  w.on("message", (m: { id: number } & Reply) => {
    const resolve = pending.get(m.id);
    if (resolve) {
      pending.delete(m.id);
      resolve(m);
    }
  });
  w.on("error", (e) => {
    failAll(String((e as Error)?.message ?? e));
    worker = undefined;
  });
  w.on("exit", () => {
    worker = undefined;
  });
  worker = w;
  return w;
}

/**
 * Run `pattern` over `items` in the worker. Resolves with per-item results
 * ALIGNED to `items` order (so the caller can zip them). Rejects with
 * {@link RegexTimeoutError} when the evaluation exceeds `timeoutMs`.
 */
export function matchAll(
  pattern: string,
  flags: string,
  multiline: boolean,
  items: MatchItem[],
  timeoutMs: number,
): Promise<Reply> {
  const w = ensureWorker();
  const id = ++seq;
  return new Promise<Reply>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      // The worker is stuck: kill it (frees the CPU) and reject EVERY pending
      // call — they would otherwise wait forever on the terminated worker.
      void w.terminate();
      if (worker === w) worker = undefined;
      const err = new RegexTimeoutError("regex evaluation exceeded the time limit");
      reject(err);
      failAll("regex worker terminated");
      pending.clear();
    }, timeoutMs);
    pending.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    w.postMessage({ id, pattern, flags, multiline, items });
  });
}
