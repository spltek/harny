import { describe, it, expect, vi } from "vitest";
import { SessionRegistry } from "./session-registry";
import { SessionManager } from "../core/sessions/session-manager";
import type { SessionStore } from "../core/sessions/types";
import type { ChatController } from "../core/agent/chat-controller";
import type { ChatHistory } from "../core/history/chat-history";

function makeStore(): SessionStore {
  let c = 0;
  return {
    list: vi.fn(() => []),
    create: vi.fn((name?: string) => ({ id: `s${++c}`, name: name?.trim() || "New Session", createdAt: 1, updatedAt: 1, messageCount: 0 })),
    load: vi.fn((id: string) => ({ summary: { id, name: "S", createdAt: 1, updatedAt: 1, messageCount: 2 }, messages: [{ role: "user", content: "loaded", timestamp: 1 }] })),
    saveMessages: vi.fn((id: string, messages: { role: string; content: string; timestamp: number }[]) => ({ id, name: "S", createdAt: 1, updatedAt: 2, messageCount: messages.length })),
    rename: vi.fn((id, name) => ({ id, name, createdAt: 1, updatedAt: 2, messageCount: 0 })),
    remove: vi.fn(() => true),
    saveModel: vi.fn((id, model, provider) => ({ id, name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 0, ...(model ? { model } : {}), ...(provider ? { modelProvider: provider } : {}) })),
    saveContextWindow: vi.fn((id, window) => ({ id, name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 0, ...(window ? { contextWindow: window } : {}) })),
    saveContextTokens: vi.fn((id, tokens) => ({ id, name: "New Session", createdAt: 1, updatedAt: 2, messageCount: 0, ...(tokens ? { contextTokens: tokens } : {}) })),
  } as unknown as SessionStore;
}

function build() {
  const store = makeStore();
  const sessions = new SessionManager(store);
  const createAgent = vi.fn((h: ChatHistory): ChatController => {
    const history = h;
    return { getMessages: vi.fn(() => history.conversation()), addUserMessage: vi.fn() } as unknown as ChatController;
  });
  const registry = new SessionRegistry({ sessions, store, createAgent });
  return { store, sessions, createAgent, registry };
}

describe("SessionRegistry", () => {
  it("create opens a new runtime session and binds an agent", () => {
    const { registry, createAgent } = build();

    const rt = registry.create();

    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(rt.sessionId).toBe("s1");
    expect(registry.isOpen("s1")).toBe(true);
    expect(registry.listOpenIds()).toEqual(["s1"]);
  });

  it("create passes the chosen name to the store", () => {
    const { store, registry } = build();

    registry.create("Project X");

    expect(store.create).toHaveBeenCalledWith("Project X");
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

describe("SessionRegistry per-session model", () => {
  it("loads the persisted model onto the runtime when opening", () => {
    const store = makeStore();
    (store.load as ReturnType<typeof vi.fn>).mockReturnValue({
      summary: { id: "s9", name: "S", createdAt: 1, updatedAt: 1, messageCount: 0, model: "deepseek-v4-flash", modelProvider: "opencode-go" },
      messages: [],
    });
    const sessions = new SessionManager(store);
    const registry = new SessionRegistry({
      sessions,
      store,
      createAgent: vi.fn((h) => ({ addUserMessage: vi.fn() } as unknown as ChatController)),
    });

    const rt = registry.openOrCreate("s9");

    expect(rt.model).toBe("deepseek-v4-flash");
    expect(rt.modelProvider).toBe("opencode-go");
  });

  it("new sessions have no model selected", () => {
    const { registry } = build();
    const rt = registry.create();
    expect(rt.model).toBeUndefined();
  });
});
