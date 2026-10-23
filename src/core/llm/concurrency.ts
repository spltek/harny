import type { LLMProvider, LLMProviderFactory } from "./types";

/**
 * A GLOBAL cap on how many LLM requests are in flight at once.
 *
 * WHY a global one, when every session already has a per-session sub-agent cap:
 * the caps MULTIPLY. Ten open sessions with Parallel on and a cap of four are forty
 * requests in flight against the same provider key — which is exactly how you earn
 * a 429 storm, and a 429 storm costs more than a short queue (the agent has to back
 * off, the run stalls, the user sees a "network error" that is really self-inflicted
 * congestion). The per-session cap says "how wide may ONE run fan out"; this says
 * "how much the whole extension may ask of the provider at once".
 *
 * It is a FAIR, FIFO gate: whoever asked first gets the next slot, so one chatty
 * session cannot starve the other nine (a LIFO stack or a random pick would).
 *
 * Deliberately NOT a rate limiter: it bounds the WIDTH, not the throughput. And it
 * is not a timeout — a request that never settles still holds its slot; releasing
 * it is the caller's job (see `limitLlmFactory`, which releases in `finally`).
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly limit: number) {
    // A cap below 1 would deadlock every request; 1 is the strictest useful cap.
    if (!Number.isFinite(limit) || limit < 1) this.limit = 1;
  }

  /** Requests holding a slot right now. */
  get inFlight(): number {
    return this.active;
  }

  /** Requests waiting for a slot. */
  get queued(): number {
    return this.waiters.length;
  }

  /**
   * Take a slot. Resolves with the release function (idempotent: calling it twice
   * frees one slot, not two). Rejects with an `AbortError` when the signal aborts
   * while WAITING: a stopped run must not keep its place in the queue.
   */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, onAbort: undefined };
      if (signal) {
        waiter.onAbort = () => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(abortError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  /** The release handed to the holder: it TRANSFERS the slot to the next waiter
   * when there is one (so `active` never dips and no one can jump the queue), and
   * only then decrements. */
  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (!next) {
        this.active -= 1;
        return;
      }
      if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
      next.resolve(this.makeRelease());
    };
  }
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function abortError(): Error {
  const e = new Error("aborted while waiting for an LLM slot");
  e.name = "AbortError";
  return e;
}

/** How many requests the extension may have in flight, across every session and
 * every sub-agent. Well above a normal Parallel batch (so it never serializes the
 * common case) and well below "one request per agent", which is what used to
 * happen with a dozen sessions open. */
export const DEFAULT_MAX_CONCURRENT_LLM_REQUESTS = 8;

/**
 * Wrap a provider FACTORY so every provider it creates shares one semaphore.
 *
 * The factory is the right seam: `Agent` creates a provider per TURN (see
 * `runLlmTurn`), so a cap installed on a provider instance would apply to one
 * request only. Here one semaphore covers every session, every turn and every
 * sub-agent, because they all come through this factory.
 */
export function limitLlmFactory(inner: LLMProviderFactory, semaphore: Semaphore): LLMProviderFactory {
  return {
    create(config) {
      return gateProvider(inner.create(config), semaphore);
    },
  };
}

/** The slot is held for the WHOLE stream: from the first `next()` to completion,
 * early `return()` or error — the three ways an AsyncGenerator can end, all covered
 * by one `finally`.
 *
 * `yield*` (not a manual loop) is what makes that true: it FORWARDS `return()` and
 * `throw()` from the consumer into the inner generator, so a `break` in the agent's
 * `for await` and an aborted signal both unwind through the `finally` and free the
 * slot. */
function gateProvider(provider: LLMProvider, semaphore: Semaphore): LLMProvider {
  return {
    async *stream(messages, signal, toolDefinitions) {
      const release = await semaphore.acquire(signal);
      try {
        yield* provider.stream(messages, signal, toolDefinitions);
      } finally {
        release();
      }
    },
  };
}
