import { describe, it, expect, vi } from "vitest";
import { SessionManager } from "./session-manager";
import type { LoadedSession, SessionSettingsPatch, SessionStore, SessionSummary } from "./types";

function makeStore(): SessionStore {
  let idc = 0;
  return {
    list: vi.fn((): SessionSummary[] => []),
    create: vi.fn((name?: string): SessionSummary => {
      idc++;
      return { id: `s${idc}`, name: name?.trim() || "New Session", createdAt: 1, updatedAt: 1, messageCount: 0 };
    }),
    load: vi.fn((id: string): LoadedSession => ({ summary: { id, name: "S", createdAt: 1, updatedAt: 1, messageCount: 1 }, messages: [{ role: "user", content: "x", timestamp: 1 }] })),
    saveMessages: vi.fn((id: string, messages: { role: string; content: string; timestamp: number }[]): SessionSummary => ({ id, name: "S", createdAt: 1, updatedAt: 2, messageCount: messages.length })),
    saveSettings: vi.fn((id: string, patch: SessionSettingsPatch): SessionSummary => ({ id, name: "S", createdAt: 1, updatedAt: 2, messageCount: 0, ...patch })),
    rename: vi.fn((id: string, name: string): SessionSummary => ({ id, name, createdAt: 1, updatedAt: 2, messageCount: 0 })),
    remove: vi.fn((): boolean => true),
  };
}

describe("SessionManager", () => {
  it("lists sessions most recently updated first", () => {
    const store = makeStore();
    store.list = vi.fn((): SessionSummary[] => [
      { id: "a", name: "A", createdAt: 1, updatedAt: 1, messageCount: 0 },
      { id: "b", name: "B", createdAt: 1, updatedAt: 5, messageCount: 2 },
      { id: "c", name: "C", createdAt: 1, updatedAt: 3, messageCount: 1 },
    ]);
    const manager = new SessionManager(store);

    expect(manager.list().map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("delegates create/load/rename/remove to the store", () => {
    const store = makeStore();
    const manager = new SessionManager(store);

    const created = manager.create("My session");
    expect(created.name).toBe("My session");
    expect(store.create).toHaveBeenCalledWith("My session");

    const loaded = manager.load("s9");
    expect(store.load).toHaveBeenCalledWith("s9");
    expect(loaded.messages[0].content).toBe("x");

    manager.rename("s9", "Renamed");
    expect(store.rename).toHaveBeenCalledWith("s9", "Renamed");

    manager.remove("s9");
    expect(store.remove).toHaveBeenCalledWith("s9");
  });

  it("saveMessages delegates and updates the store", () => {
    const store = makeStore();
    const manager = new SessionManager(store);

    const summary = manager.saveMessages("s1", [{ role: "user", content: "a", timestamp: 1 }]);

    expect(store.saveMessages).toHaveBeenCalledWith("s1", [{ role: "user", content: "a", timestamp: 1 }]);
    expect(summary.messageCount).toBe(1);
  });

  it("saveSettings delegates a patch atomically to the store", () => {
    const store = makeStore();
    const manager = new SessionManager(store);

    const summary = manager.saveSettings("s1", { model: "gpt-4o", temperature: 0.2 });

    expect(store.saveSettings).toHaveBeenCalledWith("s1", { model: "gpt-4o", temperature: 0.2 });
    expect(summary).toEqual(expect.objectContaining({ model: "gpt-4o", temperature: 0.2 }));
  });
});
