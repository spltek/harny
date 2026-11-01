import { describe, it, expect } from "vitest";
import { CompositeConfigProvider } from "./composite-config-provider";
import { StaticConfigProvider } from "./static-config-provider.test-utils";
import type { HarnyConfig } from "./types";

const BASE: HarnyConfig = {
  provider: "openai",
  apiKey: "base-key",
  baseUrl: "https://api.openai.com",
  model: "gpt-4o",
  maxTokens: 4096,
  temperature: 0.1,
  autoOpen: false,
};

describe("CompositeConfigProvider", () => {
  it("returns the base config when there are no overrides", () => {
    const provider = new CompositeConfigProvider(new StaticConfigProvider(BASE), []);
    expect(provider.get()).toEqual(BASE);
  });

  it("applies override keys on top of the base", () => {
    const provider = new CompositeConfigProvider(new StaticConfigProvider(BASE), [
      { read: () => ({ model: "llama3.2", baseUrl: "http://localhost:11434" }) },
    ]);

    const config = provider.get();
    expect(config.model).toBe("llama3.2");
    expect(config.baseUrl).toBe("http://localhost:11434");
    expect(config.apiKey).toBe("base-key"); // untouched
    expect(config.temperature).toBe(0.1); // untouched
  });

  it("later overrides win over earlier ones", () => {
    const provider = new CompositeConfigProvider(new StaticConfigProvider(BASE), [
      { read: () => ({ model: "a" }) },
      { read: () => ({ model: "b" }) },
    ]);
    expect(provider.get().model).toBe("b");
  });
});
