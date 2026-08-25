import { describe, it, expect } from "vitest";
import { MemoryOverrideConfigProvider } from "./memory-override-config-provider";
import { CompositeConfigProvider } from "./composite-config-provider";
import { StaticConfigProvider } from "./static-config-provider";
import type { HarnyConfig } from "./types";

const BASE: HarnyConfig = {
  provider: "openai-compatible",
  apiKey: "k",
  baseUrl: "http://localhost:8090/v1",
  model: "gemma.gguf",
  maxTokens: 100,
  temperature: 0,
  contextFiles: true,
  autoApprove: false,
  autoOpen: false,
  availableModels: ["gemma.gguf", "qwen-moe.gguf"],
};

describe("MemoryOverrideConfigProvider", () => {
  it("starts empty and stores partial overrides", () => {
    const o = new MemoryOverrideConfigProvider();
    expect(o.read()).toEqual({});

    o.set({ model: "qwen-moe.gguf" });
    expect(o.read()).toEqual({ model: "qwen-moe.gguf" });
  });

  it("merges subsequent sets", () => {
    const o = new MemoryOverrideConfigProvider();
    o.set({ model: "a" });
    o.set({ temperature: 0.9 });
    expect(o.read()).toEqual({ model: "a", temperature: 0.9 });
  });

  it("clear() empties the overrides", () => {
    const o = new MemoryOverrideConfigProvider();
    o.set({ model: "a" });
    o.clear();
    expect(o.read()).toEqual({});
  });

  it("wins over files and VS Code settings when last in the chain", () => {
    const o = new MemoryOverrideConfigProvider();
    const composite = new CompositeConfigProvider(new StaticConfigProvider(BASE), [
      { read: () => ({ model: "from-file" }) },
      o,
    ]);

    expect(composite.get().model).toBe("from-file"); // file wins over base
    o.set({ model: "qwen-moe.gguf" });
    expect(composite.get().model).toBe("qwen-moe.gguf"); // runtime override wins over file
  });
});
