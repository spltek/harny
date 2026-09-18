import type { PartialConfigProvider } from "./partial-config-provider";
import type { HarnyConfig } from "./types";

/**
 * Runtime (in-memory) overrides, e.g. the model picked from the chat UI.
 * Sits at the top of the config chain: wins over files and VS Code settings.
 *
 * `undefined` DELETES the key instead of storing it: an override key with
 * undefined would otherwise wipe out the config-file/settings default when
 * the composite spread merges `{ ...base, ...override }`. An untouched
 * session therefore leaves the base defaults active ("Auto" = let the
 * config file / settings decide), while an explicit value wins.
 */
export class MemoryOverrideConfigProvider implements PartialConfigProvider {
  private overrides: Partial<HarnyConfig> = {};

  set(partial: Partial<HarnyConfig>): void {
    for (const [k, v] of Object.entries(partial) as [keyof HarnyConfig, unknown][]) {
      if (v === undefined) delete this.overrides[k];
      else this.overrides[k] = v as never;
    }
  }

  clear(): void {
    this.overrides = {};
  }

  read(): Partial<HarnyConfig> {
    return { ...this.overrides };
  }
}
