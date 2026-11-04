import { describe, it, expect, vi } from "vitest";
import { SessionRegistry } from "./session-registry";
import { SessionManager } from "../core/sessions/session-manager";
import { SessionConflictError } from "../core/sessions/session-conflict";
import type { SessionStore } from "../core/sessions/types";
import type { ChatController } from "../core/agent/chat-controller";
import type { ChatHistory } from "../core/history/chat-history";

function makeStore(): SessionStore {
  let c = 0;
  return {
    list: vi.fn(() => []),
    create: vi.fn((name?: string) => ({
      id: `s${++c}`,
      name: name?.trim() || "New Session",
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
    })),
    load: vi.fn((id: string) => ({
      summary: { id, name: "S", createdAt: 1, updatedAt: 1, messageCount: 2 },
      messages: [{ role: "user", content: "loaded", timestamp: 1 }],
    })),
    saveMessages: vi.fn((id: string, messages: { role: string; content: string; timestamp: number }[]) => ({
      id,
      name: "S",
      createdAt: 1,
      updatedAt: 2,
      messageCount: messages.length,
    })),
    rename: vi.fn((id, name) => ({ id, name, createdAt: 1, updatedAt: 2, messageCount: 0 })),
    remove: vi.fn(() => true),
  } as unknown as SessionStore;
}

function build() {
  const store = makeStore();
  const sessions = new SessionManager(store);
  const createAgent = vi.fn((h: ChatHistory): ChatController => {
    const history = h;
    return {
      getMessages: vi.fn(() => history.conversation()),
      addUserMessage: vi.fn(),
      setMode: vi.fn(),
      setDelegation: vi.fn(),
    } as unknown as ChatController;
  });
  // `configFor` is the view's job in production (it owns the derivation); here a
  // constant provider is enough — what matters is that spawn HANDS IT to createAgent.
  const registry = new SessionRegistry({
    sessions,
    store,
    createAgent,
    configFor: () => ({ get: () => ({}) as never }),
  });
  return { store, sessions, createAgent, registry };
}

describe("SessionRegistry — two windows, one session", () => {
  it("adopts the token of the transcript it LOADED, so the first save is guarded", () => {
    const { store, registry } = build();
    (store.load as ReturnType<typeof vi.fn>).mockImplementation((id: string) => ({
      summary: { id, name: "S", createdAt: 1, updatedAt: 1, messageCount: 1, revision: 7 },
      messages: [{ role: "user", content: "loaded", timestamp: 1 }],
    }));

    const rt = registry.openOrCreate("x");
    rt.history.add({ role: "assistant", content: "answer", timestamp: 2 });

    // 7 came from the load: without it the first write would be unguarded, and a window that
    // opened a stale copy would `replace` the other window's turns on its very first turn.
    expect(store.saveMessages).toHaveBeenCalledWith("x", expect.any(Array), { revision: 7 });
  });

  it("a rebuild (a ✂ cut) carries the token too — it is the one destructive write", () => {
    const { store, registry } = build();
    (store.load as ReturnType<typeof vi.fn>).mockImplementation((id: string) => ({
      summary: { id, name: "S", createdAt: 1, updatedAt: 1, messageCount: 1, revision: 3 },
      messages: [{ role: "user", content: "loaded", timestamp: 1 }],
    }));

    const rt = registry.openOrCreate("x");
    rt.history.rebuild([{ role: "user", content: "kept", timestamp: 1 }]);

    expect(store.saveMessages).toHaveBeenCalledWith("x", [{ role: "user", content: "kept", timestamp: 1 }], {
      replace: true,
      revision: 3,
    });
  });

  it("reports a REFUSED write once, with the session id, and blocks the history", () => {
    const { store, registry } = build();
    (store.load as ReturnType<typeof vi.fn>).mockImplementation((id: string) => ({
      summary: { id, name: "S", createdAt: 1, updatedAt: 1, messageCount: 1, revision: 1 },
      messages: [{ role: "user", content: "loaded", timestamp: 1 }],
    }));
    (store.saveMessages as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new SessionConflictError("x", 2);
    });
    const onConflict = vi.fn();
    registry.observeWriteConflicts(onConflict);

    const rt = registry.openOrCreate("x");
    rt.history.add({ role: "assistant", content: "mine", timestamp: 2 });
    rt.history.add({ role: "user", content: "mine too", timestamp: 3 });

    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(onConflict.mock.calls[0][0]).toBe("x");
    expect((onConflict.mock.calls[0][1] as SessionConflictError).storedRevision).toBe(2);
    // The messages are still there: only the WRITE was refused, never the user's work.
    expect(rt.history.all().map((m) => m.content)).toEqual(["loaded", "mine", "mine too"]);
  });

  it("wires no listener before the panel registers one (the refusal is never a crash)", () => {
    const { store, registry } = build();
    (store.saveMessages as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new SessionConflictError("x", 1);
    });
    const rt = registry.openOrCreate("x");
    expect(() => rt.history.add({ role: "user", content: "a", timestamp: 2 })).not.toThrow();
  });
});

describe("SessionRegistry", () => {
  it("create opens a new runtime session and binds an agent", () => {
    const { registry, createAgent } = build();

    const rt = registry.create();

    expect(createAgent).toHaveBeenCalledTimes(1);
    // The third argument is the session's OWN config view (derived from its runtime on
    // every read — see SessionConfigProvider), asked from the view at spawn time.
    expect(createAgent).toHaveBeenCalledWith(
      expect.anything(),
      "s1",
      expect.objectContaining({ get: expect.any(Function) }),
    );
    expect(rt.sessionId).toBe("s1");
    expect(registry.isOpen("s1")).toBe(true);
    expect(registry.listOpenIds()).toEqual(["s1"]);
  });

  it("create passes the chosen name to the store", () => {
    const { store, registry } = build();

    registry.create("Project X");

    expect(store.create).toHaveBeenCalledWith("Project X");
  });

  it("reorder re-applies the strip order and keeps the runtimes", () => {
    const { registry } = build();
    registry.create(); // s1
    registry.create(); // s2
    registry.create(); // s3
    const before = new Map(registry.listOpenIds().map((id) => [id, registry.get(id)]));

    registry.reorder(["s3", "s1", "s2"]);

    expect(registry.listOpenIds()).toEqual(["s3", "s1", "s2"]);
    // A reorder is cosmetic: same runtimes, same agents, nothing reloaded.
    for (const [id, rt] of before) expect(registry.get(id)).toBe(rt);
  });

  it("reorder ignores unknown ids and APPENDS the open sessions the list forgot", () => {
    const { registry } = build();
    registry.create(); // s1
    registry.create(); // s2

    // A stale drag: "nope" is not open, s1 is missing from the list.
    registry.reorder(["nope", "s2"]);

    expect(registry.listOpenIds()).toEqual(["s2", "s1"]);
  });

  it("openOrCreate reuses an already-open runtime", () => {
    const { registry, createAgent } = build();
    registry.create();

    const again = registry.openOrCreate("s1");

    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(again).toBe(registry.get("s1"));
  });

  it("openOrCreate loads an existing persisted session", () => {
    const { registry, store } = build();

    const rt = registry.openOrCreate("s9");

    expect(store.load).toHaveBeenCalledWith("s9");
    expect(registry.get("s9")).toBe(rt);
    // The loaded messages were replaced into the bound history (conversation).
    const msgs = (rt.agent.getMessages ? rt.agent.getMessages() : []) as { content: string }[];
    expect(msgs.map((m) => m.content)).toContain("loaded");
  });

  it("createWithMessage seeds the agent with the user message", () => {
    const { registry } = build();
    const rt = registry.createWithMessage("Explain this code");

    const agent = rt.agent as { addUserMessage: ReturnType<typeof vi.fn> };
    expect(agent.addUserMessage).toHaveBeenCalledWith("Explain this code");
    expect(registry.isOpen(rt.sessionId)).toBe(true);
  });

  it("close removes the runtime (session stays persisted)", () => {
    const { registry } = build();
    registry.create();

    registry.close("s1");

    expect(registry.isOpen("s1")).toBe(false);
    expect(registry.listOpenIds()).toEqual([]);
  });
});

describe("SessionRegistry history-write hook", () => {
  // The session list on screen follows a session's `updatedAt`, and the ONLY thing that
  // moves it is a history write. The hook is threaded through the registry, so it must
  // ride along on BOTH ways a runtime is born — a new session AND a loaded one.
  function buildWithHook() {
    const store = makeStore();
    const sessions = new SessionManager(store);
    const onHistorySaved = vi.fn();
    const histories = new Map<string, ChatHistory>();
    const registry = new SessionRegistry({
      sessions,
      store,
      configFor: () => ({ get: () => ({}) as never }),
      createAgent: vi.fn((h: ChatHistory, id: string) => {
        histories.set(id, h);
        return { addUserMessage: vi.fn(), setMode: vi.fn(), setDelegation: vi.fn() } as unknown as ChatController;
      }),
    });
    registry.observeHistoryWrites(onHistorySaved);
    return { store, registry, onHistorySaved, histories };
  }

  it("reports the write of a NEWLY created session", () => {
    const { registry, onHistorySaved, histories } = buildWithHook();
    const rt = registry.create("Live");

    histories.get(rt.sessionId)!.add({ role: "user", content: "hi", timestamp: 1 });

    expect(onHistorySaved).toHaveBeenCalledWith(expect.objectContaining({ id: rt.sessionId, messageCount: 1 }));
  });

  it("reports the write of a LOADED session (the hook is not only on the create path)", () => {
    const { registry, onHistorySaved, histories } = buildWithHook();
    const rt = registry.openOrCreate("s9");

    histories.get(rt.sessionId)!.addGroup([{ role: "assistant", content: "ok", timestamp: 2 }]);

    expect(onHistorySaved).toHaveBeenCalledWith(expect.objectContaining({ id: "s9" }));
  });

  it("registers LATE and still hears the runtimes that already existed", () => {
    // The panel is built after the registry (and after any session a gesture opened first):
    // the hook reads its listener at WRITE time, so registering later must not lose writes.
    const store = makeStore();
    const sessions = new SessionManager(store);
    const histories = new Map<string, ChatHistory>();
    const registry = new SessionRegistry({
      sessions,
      store,
      configFor: () => ({ get: () => ({}) as never }),
      createAgent: vi.fn((h: ChatHistory, id: string) => {
        histories.set(id, h);
        return { addUserMessage: vi.fn(), setMode: vi.fn(), setDelegation: vi.fn() } as unknown as ChatController;
      }),
    });
    const rt = registry.create("Early");

    const late = vi.fn();
    registry.observeHistoryWrites(late);
    histories.get(rt.sessionId)!.add({ role: "user", content: "hi", timestamp: 1 });

    expect(late).toHaveBeenCalledWith(expect.objectContaining({ id: rt.sessionId }));
  });
});

describe("SessionRegistry per-session model", () => {
  it("loads the persisted model onto the runtime when opening", () => {
    const store = makeStore();
    (store.load as ReturnType<typeof vi.fn>).mockReturnValue({
      summary: {
        id: "s9",
        name: "S",
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
        model: "deepseek-v4-flash",
        modelProvider: "opencode-go",
      },
      messages: [],
    });
    const sessions = new SessionManager(store);
    const registry = new SessionRegistry({
      sessions,
      store,
      configFor: () => ({ get: () => ({}) as never }),
      createAgent: vi.fn(
        (h) => ({ addUserMessage: vi.fn(), setMode: vi.fn(), setDelegation: vi.fn() }) as unknown as ChatController,
      ),
    });

    const rt = registry.openOrCreate("s9");

    expect(rt.model).toBe("deepseek-v4-flash");
    expect(rt.modelProvider).toBe("opencode-go");
  });

  it("loads the persisted mode and parallel onto the runtime when opening", () => {
    const store = makeStore();
    (store.load as ReturnType<typeof vi.fn>).mockReturnValue({
      summary: { id: "s9", name: "S", createdAt: 1, updatedAt: 1, messageCount: 0, mode: "agent", parallel: true },
      messages: [],
    });
    const sessions = new SessionManager(store);
    let agent: { setMode: ReturnType<typeof vi.fn>; setDelegation: ReturnType<typeof vi.fn> } | undefined;
    const registry = new SessionRegistry({
      sessions,
      store,
      configFor: () => ({ get: () => ({}) as never }),
      createAgent: vi.fn(() => {
        agent = { addUserMessage: vi.fn(), setMode: vi.fn(), setDelegation: vi.fn() } as never;
        return agent as unknown as ChatController;
      }),
    });

    const rt = registry.openOrCreate("s9");

    expect(rt.mode).toBe("agent");
    expect(rt.parallel).toBe(true);
    // The FRESH agent is synced immediately (not only at the first send).
    expect(agent!.setMode).toHaveBeenCalledWith("agent");
    expect(agent!.setDelegation).toHaveBeenCalledWith(true);
  });

  it("loads the persisted output tokens onto the runtime when opening", () => {
    const store = makeStore();
    (store.load as ReturnType<typeof vi.fn>).mockReturnValue({
      summary: {
        id: "s9",
        name: "S",
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
        model: "deepseek-v4-flash",
        outputTokens: 4096,
      },
      messages: [],
    });
    const sessions = new SessionManager(store);
    const registry = new SessionRegistry({
      sessions,
      store,
      configFor: () => ({ get: () => ({}) as never }),
      createAgent: vi.fn(
        (h) => ({ addUserMessage: vi.fn(), setMode: vi.fn(), setDelegation: vi.fn() }) as unknown as ChatController,
      ),
    });

    const rt = registry.openOrCreate("s9");

    expect(rt.outputTokens).toBe(4096);
  });

  it("loads the persisted compaction threshold % onto the runtime when opening", () => {
    const store = makeStore();
    (store.load as ReturnType<typeof vi.fn>).mockReturnValue({
      summary: {
        id: "s9",
        name: "S",
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
        model: "deepseek-v4-flash",
        compactionThresholdPercent: 65,
      },
      messages: [],
    });
    const sessions = new SessionManager(store);
    const registry = new SessionRegistry({
      sessions,
      store,
      configFor: () => ({ get: () => ({}) as never }),
      createAgent: vi.fn(
        (h) => ({ addUserMessage: vi.fn(), setMode: vi.fn(), setDelegation: vi.fn() }) as unknown as ChatController,
      ),
    });

    const rt = registry.openOrCreate("s9");

    expect(rt.compactionThresholdPercent).toBe(65);
  });

  it("loads the persisted temperature onto the runtime when opening", () => {
    const store = makeStore();
    (store.load as ReturnType<typeof vi.fn>).mockReturnValue({
      summary: {
        id: "s9",
        name: "S",
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
        model: "deepseek-v4-flash",
        temperature: 0.3,
      },
      messages: [],
    });
    const sessions = new SessionManager(store);
    const registry = new SessionRegistry({
      sessions,
      store,
      configFor: () => ({ get: () => ({}) as never }),
      createAgent: vi.fn(
        (h) => ({ addUserMessage: vi.fn(), setMode: vi.fn(), setDelegation: vi.fn() }) as unknown as ChatController,
      ),
    });

    const rt = registry.openOrCreate("s9");

    expect(rt.temperature).toBe(0.3);
  });

  it("loads the persisted penalties onto the runtime when opening", () => {
    const store = makeStore();
    (store.load as ReturnType<typeof vi.fn>).mockReturnValue({
      summary: {
        id: "s9",
        name: "S",
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
        model: "deepseek-v4-flash",
        presencePenalty: 1.5,
        frequencyPenalty: 0.5,
      },
      messages: [],
    });
    const sessions = new SessionManager(store);
    const registry = new SessionRegistry({
      sessions,
      store,
      configFor: () => ({ get: () => ({}) as never }),
      createAgent: vi.fn(
        (h) => ({ addUserMessage: vi.fn(), setMode: vi.fn(), setDelegation: vi.fn() }) as unknown as ChatController,
      ),
    });

    const rt = registry.openOrCreate("s9");

    expect(rt.presencePenalty).toBe(1.5);
    expect(rt.frequencyPenalty).toBe(0.5);
  });

  it("loads the persisted top_p and sampler onto the runtime when opening", () => {
    const store = makeStore();
    (store.load as ReturnType<typeof vi.fn>).mockReturnValue({
      summary: {
        id: "s9",
        name: "S",
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
        model: "deepseek-v4-flash",
        topP: 0.8,
        sampler: "topP",
      },
      messages: [],
    });
    const sessions = new SessionManager(store);
    const registry = new SessionRegistry({
      sessions,
      store,
      configFor: () => ({ get: () => ({}) as never }),
      createAgent: vi.fn(
        (h) => ({ addUserMessage: vi.fn(), setMode: vi.fn(), setDelegation: vi.fn() }) as unknown as ChatController,
      ),
    });

    const rt = registry.openOrCreate("s9");

    expect(rt.topP).toBe(0.8);
    expect(rt.sampler).toBe("topP");
  });

  it("loads the persisted control settings (parallel cap + Loop Guard) when opening", () => {
    const store = makeStore();
    (store.load as ReturnType<typeof vi.fn>).mockReturnValue({
      summary: {
        id: "s9",
        name: "S",
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
        model: "deepseek-v4-flash",
        maxParallelSubAgents: 6,
        loopGuard: "high",
        loopGuardResponse: true,
      },
      messages: [],
    });
    const sessions = new SessionManager(store);
    const registry = new SessionRegistry({
      sessions,
      store,
      configFor: () => ({ get: () => ({}) as never }),
      createAgent: vi.fn(
        (h) => ({ addUserMessage: vi.fn(), setMode: vi.fn(), setDelegation: vi.fn() }) as unknown as ChatController,
      ),
    });

    const rt = registry.openOrCreate("s9");

    expect(rt.maxParallelSubAgents).toBe(6);
    expect(rt.loopGuard).toBe("high");
    expect(rt.loopGuardResponse).toBe(true);
  });

  it("new sessions have no model selected", () => {
    const { registry } = build();
    const rt = registry.create();
    expect(rt.model).toBeUndefined();
  });
});
