import type { ConfigProvider } from "./types";
import type { PartialConfigProvider } from "./partial-config-provider";

/**
 * Merges a base ConfigProvider with ordered partial overrides.
 * Later overrides win for the keys they explicitly define.
 */
export class CompositeConfigProvider implements ConfigProvider {
  constructor(
    private base: ConfigProvider,
    private overrides: PartialConfigProvider[],
  ) {}

  get(): import("./types").HarnyConfig {
    let result = this.base.get();
    for (const override of this.overrides) {
      result = { ...result, ...override.read() };
    }
    return result;
  }
}
