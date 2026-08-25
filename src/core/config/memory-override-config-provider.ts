import type { PartialConfigProvider } from "./partial-config-provider";
import type { HarnyConfig } from "./types";

/**
 * Runtime (in-memory) overrides, e.g. the model picked from the chat UI.
 * Sits at the top of the config chain: wins over files and VS Code settings.
 */
export class MemoryOverrideConfigProvider implements PartialConfigProvider {
  private overrides: Partial<HarnyConfig> = {};

  set(partial: Partial<HarnyConfig>): void {
    this.overrides = { ...this.overrides, ...partial };
  }

  clear(): void {
    this.overrides = {};
  }

  read(): Partial<HarnyConfig> {
    return { ...this.overrides };
  }
}
