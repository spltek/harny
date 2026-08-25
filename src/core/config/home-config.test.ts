import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CompositeConfigProvider } from "./composite-config-provider";
import { HarnyFileConfigProvider } from "./harny-file-config-provider";
import { MemoryOverrideConfigProvider } from "./memory-override-config-provider";
import { StaticConfigProvider } from "./static-config-provider";
import { nodeFileSystem } from "../tools/file-system";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnyConfig } from "./types";

const BASE: HarnyConfig = {
  provider: "openai",
  apiKey: "",
  baseUrl: "https://api.openai.com",
  model: "gpt-4o",
  maxTokens: 4096,
  temperature: 0.1,
  contextFiles: true,
  autoApprove: false,
  autoOpen: false,
};

describe("home config resolution (~/.harny/config.json)", () => {
  let harnyHome: string;

  function build(): CompositeConfigProvider {
    return new CompositeConfigProvider(new StaticConfigProvider(BASE), [
      new HarnyFileConfigProvider(() => harnyHome, nodeFileSystem),
    ]);
  }

  beforeEach(() => {
    harnyHome = mkdtempSync(join(tmpdir(), "harny-home-"));
  });

  afterEach(() => {
    rmSync(harnyHome, { recursive: true, force: true });
  });

  it("picks up ~/.harny/config.json", () => {
    writeFileSync(
      join(harnyHome, "config.json"),
      JSON.stringify({ baseUrl: "http://localhost:8090/v1", apiKey: "lamacpp" }),
    );
    const config = build().get();
    expect(config.baseUrl).toBe("http://localhost:8090/v1");
    expect(config.apiKey).toBe("lamacpp");
  });

  it("does NOT read .harny.json from the working directory", () => {
    // A stray workspace file must have no effect: config lives only in ~/.harny.
    const workspace = mkdtempSync(join(tmpdir(), "harny-ws-"));
    try {
      writeFileSync(
        join(workspace, ".harny.json"),
        JSON.stringify({ baseUrl: "http://workspace-should-be-ignored" }),
      );
      const config = new CompositeConfigProvider(new StaticConfigProvider(BASE), [
        new HarnyFileConfigProvider(() => workspace, nodeFileSystem),
      ]).get();
      expect(config.baseUrl).toBe("https://api.openai.com");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("falls back to VS Code settings when no config file exists", () => {
    const config = build().get();
    expect(config.baseUrl).toBe("https://api.openai.com");
    expect(config.model).toBe("gpt-4o");
  });

  it("lets runtime overrides (model dropdown) win over the file", () => {
    writeFileSync(join(harnyHome, "config.json"), JSON.stringify({ model: "from-file" }));
    const runtime = new MemoryOverrideConfigProvider();
    const config = new CompositeConfigProvider(new StaticConfigProvider(BASE), [
      new HarnyFileConfigProvider(() => harnyHome, nodeFileSystem),
      runtime,
    ]);
    expect(config.get().model).toBe("from-file");
    runtime.set({ model: "from-dropdown" });
    expect(config.get().model).toBe("from-dropdown");
  });
});
