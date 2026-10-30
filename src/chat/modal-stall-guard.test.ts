import { describe, it, expect, vi, afterEach } from "vitest";
import { MODAL_STALL_MS, ModalStallGuard, type ModalStallGuardDeps } from "./modal-stall-guard";

/**
 * The rescue path: a modal pending AND a rebuild deferred behind it, for longer than the
 * deadline. Everything else — a dialog simply left open — must be left alone.
 */

function deps(stalled: boolean): {
  deps: Omit<ModalStallGuardDeps, "recover"> & { recover: ReturnType<typeof vi.fn> };
  setStalled: (next: boolean) => void;
} {
  let value = stalled;
  const recover = vi.fn();
  const log = vi.fn();
  return {
    deps: { stalled: () => value, recover, log },
    setStalled: (next) => {
      value = next;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ModalStallGuard", () => {
  it("cancels the dialog and rebuilds when the stall outlives the deadline", () => {
    vi.useFakeTimers();
    const { deps: d } = deps(true);
    const guard = new ModalStallGuard(d);
    guard.arm();
    vi.advanceTimersByTime(MODAL_STALL_MS);
    expect(d.recover).toHaveBeenCalledTimes(1);
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining("cancelled"));
  });

  it("does NOT fire when the dialog was answered (or the rebuild resolved) in time", () => {
    vi.useFakeTimers();
    const { deps: d } = deps(true);
    const guard = new ModalStallGuard(d);
    guard.arm();
    guard.disarm(); // the rebuild landed: nothing is waiting any more
    vi.advanceTimersByTime(MODAL_STALL_MS * 3);
    expect(d.recover).not.toHaveBeenCalled();
  });

  it("does NOT fire for a dialog nobody is waiting on (the user is just reading)", () => {
    // A modal is pending, but no rebuild is deferred: the panel is not stale, so the
    // dialog is none of the guard's business.
    vi.useFakeTimers();
    const { deps: d } = deps(false);
    const guard = new ModalStallGuard(d);
    guard.arm();
    vi.advanceTimersByTime(MODAL_STALL_MS);
    expect(d.recover).not.toHaveBeenCalled();
    expect(d.log).not.toHaveBeenCalled();
  });

  it("judges at the DEADLINE, not at arm time (a late answer still wins)", () => {
    vi.useFakeTimers();
    const { deps: d, setStalled } = deps(true);
    const guard = new ModalStallGuard(d);
    guard.arm();
    vi.advanceTimersByTime(MODAL_STALL_MS - 1);
    setStalled(false); // answered while the clock was running
    vi.advanceTimersByTime(1);
    expect(d.recover).not.toHaveBeenCalled();
  });

  it("keeps ONE deadline however many rebuilds ask for it", () => {
    vi.useFakeTimers();
    const { deps: d } = deps(true);
    const guard = new ModalStallGuard(d);
    guard.arm();
    guard.arm();
    guard.arm();
    vi.advanceTimersByTime(MODAL_STALL_MS);
    expect(d.recover).toHaveBeenCalledTimes(1);
  });

  it("honours an explicit deadline", () => {
    vi.useFakeTimers();
    const { deps: d } = deps(true);
    const guard = new ModalStallGuard({ ...d, stallMs: 50 });
    guard.arm();
    vi.advanceTimersByTime(49);
    expect(d.recover).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(d.recover).toHaveBeenCalledTimes(1);
  });
});
