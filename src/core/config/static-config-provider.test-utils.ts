import type { ConfigProvider, HarnyConfig } from "./types";

/**
 * In-memory config provider for tests: hand it a config, get it back.
 *
 * It lives in the TEST tree on purpose — no shipped code ever constructs one, and a
 * fake sitting in `src/` is indistinguishable from a feature nobody wired. The five
 * suites that need a `ConfigProvider` get it from here.
 */
export class StaticConfigProvider implements ConfigProvider {
  constructor(private config: HarnyConfig) {}

  get(): HarnyConfig {
    return this.config;
  }
}
