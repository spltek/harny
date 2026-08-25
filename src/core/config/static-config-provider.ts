import type { ConfigProvider } from "./types";

/**
 * In-memory config provider, useful for tests and non-VS Code hosts.
 */
export class StaticConfigProvider implements ConfigProvider {
  constructor(private config: import("./types").HarnyConfig) {}

  get(): import("./types").HarnyConfig {
    return this.config;
  }
}
