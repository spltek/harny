import type { HarnyConfig } from "./types";

/** A config source that may return only the keys it explicitly configures. */
export interface PartialConfigProvider {
  read(): Partial<HarnyConfig>;
}
