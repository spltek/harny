import { describe, it, expect, vi } from "vitest";
import { InMemoryEventBus } from "./in-memory-event-bus";

describe("InMemoryEventBus", () => {
  it("delivers events to subscribers", () => {
    const bus = new InMemoryEventBus<string>();
    const handler = vi.fn();
    bus.subscribe(handler);

    bus.emit("hello");

    expect(handler).toHaveBeenCalledExactlyOnceWith("hello");
  });

  it("unsubscribes and stops delivering", () => {
    const bus = new InMemoryEventBus<number>();
    const handler = vi.fn();
    const unsubscribe = bus.subscribe(handler);

    unsubscribe();
    bus.emit(42);

    expect(handler).not.toHaveBeenCalled();
  });

  it("isolates multiple subscribers", () => {
    const bus = new InMemoryEventBus<string>();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe(a);
    bus.subscribe(b);

    bus.emit("x");

    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it("keeps delivering to other subscribers when one throws", () => {
    const bus = new InMemoryEventBus<string>();
    const broken = vi.fn(() => {
      throw new Error("boom");
    });
    const ok = vi.fn();
    bus.subscribe(broken);
    bus.subscribe(ok);

    expect(() => bus.emit("x")).not.toThrow();

    expect(broken).toHaveBeenCalledOnce();
    expect(ok).toHaveBeenCalledOnce();
  });
});
