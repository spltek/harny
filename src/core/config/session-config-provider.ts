import type { ConfigProvider } from "./types";
import type { HarnyConfig } from "./types";

/**
 * The config a CONVERSATION runs on: the host chain (settings → config file) with the
 * session's own overrides on top — DERIVED at every read, never stored.
 *
 * This is the seam where the MissingSessionID bug lived, so it is worth being explicit
 * about the shape. The agent re-reads its config at every turn (`agent.ts`), which means
 * whatever sits behind this `get()` decides what the next request carries: model,
 * samplers, output budget, and the routing identity (`sessionId` + `sessionHeader`).
 *
 * The first iteration of the fix kept a per-session override LAYER and refreshed it from
 * a handful of places (`applySessionModel`, `applyAllSessionModels`, and once more after a
 * tab was closed). That is a cache of derived state: every new path that changes a
 * session then has to remember to call the refresher, and forgetting once is the same bug
 * again. Here nothing is cached — `derive()` is asked at read time, so there is no
 * invariant to maintain and no ordering to get right.
 *
 * `derive()` returns a Partial; keys it leaves ABSENT are simply not overridden, and keys
 * set to `undefined` are dropped rather than written (a spread would shadow the chain's
 * value with `undefined`, turning "unset" into "erased").
 *
 * One instance per session, created where the session's agent is (see
 * `SessionRegistry.spawn`), never shared between two of them.
 */
export class SessionConfigProvider implements ConfigProvider {
  constructor(
    private base: ConfigProvider,
    private derive: () => Partial<HarnyConfig>,
  ) {}

  get(): HarnyConfig {
    const merged: Record<string, unknown> = { ...this.base.get() };
    for (const [key, value] of Object.entries(this.derive())) {
      if (value !== undefined) merged[key] = value;
    }
    return merged as unknown as HarnyConfig;
  }
}
