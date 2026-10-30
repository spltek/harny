/**
 * "Finish this once the window has reloaded on that folder."
 *
 * Opening a folder as the workspace RELOADS the extension host, so the click that asked
 * for it — *open THIS session*, *start a new one here* — has nothing left to carry it:
 * the object graph and the webview are gone. Asking for the same thing twice is what
 * makes a folder change feel like a reset, so the intent is written to PERSISTENT state
 * (VS Code's `globalState`) BEFORE the folder is opened, and consumed ONCE on activation.
 *
 * Three rules keep a marker from firing at the wrong time:
 *   · the FOLDER it was written for — it is honoured only in the workspace it names, and
 *     any other activation DISCARDS it, so it can never surface days later in another
 *     project;
 *   · its AGE — a reload takes seconds, so a marker older than `PENDING_OPEN_MAX_AGE_MS`
 *     is the debris of a flow that never completed, not a request;
 *   · consume-once — `take` reads AND clears, so a marker can never run twice.
 */

import { sameFolder } from "./folder-path";

/** What the user asked for before the folder changed. */
export type PendingOpenAction = { readonly kind: "session"; readonly sessionId: string } | { readonly kind: "create" };

/** A stored marker: the action, the folder it belongs to, and when it was written. */
export interface PendingOpen {
  readonly folder: string;
  readonly action: PendingOpenAction;
  /** ms since the epoch — see `PENDING_OPEN_MAX_AGE_MS`. */
  readonly at: number;
}

/** A marker older than this cannot be a reload that is still in flight. */
export const PENDING_OPEN_MAX_AGE_MS = 5 * 60_000;

/** The persistence port: VS Code's `Memento` in production, a fake under test. */
export interface PendingOpenStore {
  get(): PendingOpen | undefined;
  set(value: PendingOpen | undefined): Promise<void>;
}

/** The slice of VS Code's `Memento` this needs (it is what `globalState` is). */
export interface MementoLike {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

/**
 * `globalState`, typed. It is the ONLY store that survives the reload the marker is for,
 * which is exactly why this port exists instead of a field on the provider.
 */
export class MementoPendingOpenStore implements PendingOpenStore {
  constructor(
    private readonly memento: MementoLike,
    private readonly key = "harny.pendingOpen",
  ) {}

  get(): PendingOpen | undefined {
    const stored = this.memento.get<PendingOpen | undefined>(this.key, undefined);
    // A value written by ANOTHER version (or half-written) must not crash activation:
    // the marker is an optimisation of a gesture, never a requirement.
    if (!stored || typeof stored.folder !== "string") return undefined;
    const kind = (stored.action as { kind?: unknown } | undefined)?.kind;
    if (kind !== "session" && kind !== "create") return undefined;
    return stored;
  }

  async set(value: PendingOpen | undefined): Promise<void> {
    await this.memento.update(this.key, value);
  }
}

/**
 * Remembering and consuming, in one place.
 *
 * The clock is injected (`now`): the age rule is part of the contract, and a test must be
 * able to age a marker without waiting or faking timers.
 */
export class PendingOpens {
  constructor(
    private readonly store: PendingOpenStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** Remember what to do once the window has reloaded on `folder`. */
  async remember(folder: string, action: PendingOpenAction): Promise<void> {
    await this.store.set({ folder, action, at: this.now() });
  }

  /**
   * Consume the marker for the workspace that has just opened.
   *
   * Returns the action, or `undefined` when there is nothing to finish (nothing stored,
   * another folder, or too old). It ALWAYS clears what it found: a marker that survives
   * its own activation is a booby trap for the next one.
   */
  async take(folder: string | undefined): Promise<PendingOpenAction | undefined> {
    const stored = this.store.get();
    if (!stored) return undefined;
    await this.store.set(undefined);
    if (!folder || !sameFolder(stored.folder, folder)) return undefined;
    if (this.now() - stored.at > PENDING_OPEN_MAX_AGE_MS) return undefined;
    return stored.action;
  }
}
