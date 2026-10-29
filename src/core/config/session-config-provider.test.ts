import { describe, expect, it } from "vitest";
import { SessionConfigProvider } from "./session-config-provider";
import type { HarnyConfig } from "./types";

/**
 * The seam that decides what a conversation's NEXT request carries.
 *
 * The agent reads `config.get()` at every turn, so what sits behind this call is what
 * makes a tab switch harmless. It is DERIVED on every read — nothing is stored — which is
 * why there is no "refresh the layer" step to forget. The bug it replaced: a single shared
 * override layer, written from whichever tab was visible, so opening a session with no
 * model left a running session with no `sessionId` (OpenCode Go: 400 MissingSessionID) and
 * switching to another session sent its model instead.
 */

const BASE: HarnyConfig = {
  provider: "openai",
  apiKey: "sk-base",
  baseUrl: "https://base.example/v1",
  model: "base-model",
  maxTokens: 4096,
  temperature: 0.1,
  thinkingLevel: "off",
  autoOpen: false,
};

const base = { get: () => BASE };

describe("SessionConfigProvider — the config a conversation runs on", () => {
  it("layers the session's overrides ON TOP of the host chain", () => {
    const config = new SessionConfigProvider(base, () => ({
      model: "deepseek-v4-pro",
      sessionId: "s-1",
      sessionHeader: "x-opencode-session",
    }));

    expect(config.get()).toMatchObject({
      model: "deepseek-v4-pro",
      sessionId: "s-1",
      sessionHeader: "x-opencode-session",
      // …and everything the session does NOT override still comes from the chain.
      apiKey: "sk-base",
      baseUrl: "https://base.example/v1",
    });
  });

  it("DROPS `undefined` instead of writing it: unset is not erased", () => {
    // A session that stops overriding `temperature` must fall back to the chain's value.
    // A spread would write `temperature: undefined` and shadow it, so "Auto" would silently
    // mean "send no temperature" even when the config file declares one.
    const config = new SessionConfigProvider(base, () => ({ temperature: undefined, topP: 0.9 }));
    const got = config.get();
    expect(got.temperature).toBe(BASE.temperature);
    expect(got.topP).toBe(0.9);
    expect("temperature" in got).toBe(true);
  });

  it("reads LIVE: a change made mid-run reaches the next turn", () => {
    // The agent re-reads at every turn; a snapshot taken once would make every control
    // (sliders, model picker, Parallel) apply only after a restart.
    let model = "m-1";
    const config = new SessionConfigProvider(base, () => ({ model }));
    expect(config.get().model).toBe("m-1");
    model = "m-2";
    expect(config.get().model).toBe("m-2");
  });

  it("keeps two sessions apart, which is the whole point", () => {
    const a = new SessionConfigProvider(base, () => ({ model: "model-a", sessionId: "s-a" }));
    const b = new SessionConfigProvider(base, () => ({ model: "model-b", sessionId: "s-b" }));
    expect(a.get()).toMatchObject({ model: "model-a", sessionId: "s-a" });
    expect(b.get()).toMatchObject({ model: "model-b", sessionId: "s-b" });

    // One session having NOTHING to override (a brand-new one, no model yet) must not
    // disturb the other — this is the 400, in two lines.
    const empty = new SessionConfigProvider(base, () => ({}));
    expect(empty.get()).toEqual(BASE);
    expect(b.get()).toMatchObject({ model: "model-b", sessionId: "s-b" });
  });

  it("never mutates what the chain returned (the base config is shared by every session)", () => {
    const shared = { get: () => ({ ...BASE }) };
    const config = new SessionConfigProvider(shared, () => ({ model: "m-x" }));
    config.get();
    expect(shared.get().model).toBe("base-model");
  });
});
