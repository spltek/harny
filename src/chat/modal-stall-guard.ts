/**
 * "A dialog nobody answers must not take the panel down with it."
 *
 * The panel has ONE overlay: while a modal is pending, everything behind it is
 * unclickable, and `refresh()` DEFERS a rebuild rather than replacing the page underneath it
 * (wiping the modal would leave its answer never arriving — a deadlock this codebase has
 * already paid for once). The two rules together are right, and they compose into a risk: a
 * modal that is stuck *and* a rebuild that keeps being asked for leave the panel stale for
 * ever, with no way out but reloading the window.
 *
 * So the deferral is put on a clock. If it lasts longer than `stallMs`, the dialog is
 * CANCELLED and the rebuild goes through: the panel heals itself and says so in the log.
 *
 * The guard is narrow on purpose — it fires only when BOTH are true (a modal is pending AND
 * a rebuild is waiting). A dialog left open while nothing wants to redraw is the user
 * reading, not a stall, and must be left alone.
 */

/** What the guard needs from the panel. */
export interface ModalStallGuardDeps {
  /** Still stalled: a modal is pending AND a rebuild is deferred behind it. */
  stalled(): boolean;
  /** Break the deadlock: cancel the pending modal(s) and let the rebuild through. */
  recover(): void;
  /** Diagnostic sink (Output > Harny). */
  log?(message: string): void;
  /** How long a deferral may last before it is treated as a deadlock. */
  stallMs?: number;
}

/** Two minutes: long past any real dialog, short enough to be a rescue. */
export const MODAL_STALL_MS = 2 * 60_000;

/**
 * Arms a deadline when a rebuild is deferred, and cancels the dialog if the deferral
 * outlives it.
 */
export class ModalStallGuard {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: ModalStallGuardDeps) {}

  /** A rebuild was deferred: start the clock (idempotent — one deadline, not one per call). */
  arm(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => this.fire(), this.deps.stallMs ?? MODAL_STALL_MS);
    // Never keep the host alive for a rescue that may never be needed.
    this.timer.unref?.();
  }

  /** The rebuild went through (or nothing is deferred any more): no rescue needed. */
  disarm(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private fire(): void {
    this.timer = undefined;
    // Re-check at the deadline: the modal may have been answered (or the deferral resolved)
    // in the meantime, and a dialog nobody is waiting on must be left alone.
    if (!this.deps.stalled()) return;
    this.deps.log?.("a modal blocked a rebuild for too long: cancelled it and rebuilt the panel");
    this.deps.recover();
  }
}
