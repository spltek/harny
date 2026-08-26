import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnyFileConfigProvider } from "./harny-file-config-provider";
import { nodeFileSystem } from "../tools/file-system";

describe("HarnyFileConfigProvider", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harny-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty partial when the file does not exist", () => {
    const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);
    expect(provider.read()).toEqual({});
  });

  it("reads configured keys from config.json", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ apiKey: "sk-file", model: "llama3.2", temperature: 0.7 }),
    );
    const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);

    expect(provider.read()).toEqual({
      apiKey: "sk-file",
      model: "llama3.2",
      temperature: 0.7,
    });
  });

  it("supports comments (JSONC) in the file", () => {
    writeFileSync(
      join(dir, "config.json"),
      '{\n  // chiave\n  "apiKey": "sk-file",\n  /* modello locale */\n  "model": "qwen2.5"\n}\n',
    );
    const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);

    expect(provider.read()).toEqual({ apiKey: "sk-file", model: "qwen2.5" });
  });

  it("ignores malformed files", () => {
    writeFileSync(join(dir, "config.json"), "{ not valid json ");
    const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);

    expect(provider.read()).toEqual({});
  });

  it("ignores unknown keys", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ apiKey: "k", bogus: 123 }));
    const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);

    expect(provider.read()).toEqual({ apiKey: "k" });
  });

  it("accepts a config.jsonc file too", () => {
    writeFileSync(join(dir, "config.jsonc"), '{"model": "m", // con commento\n}');
    const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);

    expect(provider.read()).toEqual({ model: "m" });
  });
});

describe("HarnyFileConfigProvider multi-provider format", () => {
  let dir: string;
  const tmp = () => dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harny-config-mp-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves the active named provider into a flat config", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        provider: "llamacpp",
        model: "qwen-moe.gguf",
        providers: {
          llamacpp: {
            baseUrl: "http://localhost:8090/v1",
            api: "openai-completions",
            apiKey: "lamacpp",
            models: [{ id: "gemma.gguf" }, { id: "qwen-moe.gguf" }],
          },
        },
      }),
    );
    const provider = new HarnyFileConfigProvider(tmp, nodeFileSystem);

    expect(provider.read()).toEqual({
      provider: "openai-compatible",
      baseUrl: "http://localhost:8090/v1",
      apiKey: "lamacpp",
      model: "qwen-moe.gguf",
      availableModels: ["gemma.gguf", "qwen-moe.gguf"],
      activeProvider: "llamacpp",
      providerModels: [
        { provider: "llamacpp", model: "gemma.gguf" },
        { provider: "llamacpp", model: "qwen-moe.gguf" },
      ],
    });
  });

  it("exposes the catalog of ALL providers with their models", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        provider: "opencode-go",
        model: "deepseek-v4-flash",
        providers: {
          "opencode-go": {
            baseUrl: "https://opencode.ai/zen/go/v1",
            api: "openai-completions",
            apiKey: "sk-x",
            models: [{ id: "deepseek-v4-flash", input: ["text"] }, { id: "deepseek-v4-pro" }],
          },
          llamacpp: {
            baseUrl: "http://localhost:8090/v1",
            api: "openai-completions",
            apiKey: "k",
            models: [{ id: "LLM/qwen.gguf", input: ["text", "image"] }, { id: "LLM/gemma.gguf" }],
          },
        },
      }),
    );
    const provider = new HarnyFileConfigProvider(tmp, nodeFileSystem);

    const config = provider.read();
    expect(config.activeProvider).toBe("opencode-go");
    expect(config.providerModels).toEqual([
      { provider: "opencode-go", model: "deepseek-v4-flash" },
      { provider: "opencode-go", model: "deepseek-v4-pro" },
      { provider: "llamacpp", model: "LLM/qwen.gguf" },
      { provider: "llamacpp", model: "LLM/gemma.gguf" },
    ]);
    // The active provider still drives the flat resolution.
    expect(config.model).toBe("deepseek-v4-flash");
    expect(config.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(config.availableModels).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
  });

  it("lists providers without declared models as hostModelProviders", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        providers: {
          "opencode-go": { baseUrl: "https://opencode.ai/zen/go/v1", api: "openai-completions", apiKey: "sk-x" },
          llamacpp: {
            baseUrl: "http://localhost:8090/v1",
            api: "openai-completions",
            apiKey: "k",
            models: [], // vuoto = chiedi la lista all'host
          },
          ollama: {
            baseUrl: "http://localhost:11434/v1",
            api: "openai-completions",
            apiKey: "",
            models: [{ id: "qwen2.5-coder:32b" }],
          },
        },
      }),
    );
    const provider = new HarnyFileConfigProvider(tmp, nodeFileSystem);

    const config = provider.read();
    expect(config.hostModelProviders).toEqual(["opencode-go", "llamacpp"]);
    // Only the declared models land in the static catalog.
    expect(config.providerModels).toEqual([{ provider: "ollama", model: "qwen2.5-coder:32b" }]);
  });

  it("persists the model selection preserving comments", () => {
    const text = `{\n  // provider attivo\n  \"provider\": \"opencode-go\",\n  \"model\": \"deepseek-v4-flash\",\n  \"providers\": {}\n}`;
    writeFileSync(join(dir, "config.json"), text);
    const provider = new HarnyFileConfigProvider(tmp, nodeFileSystem);

    const ok = provider.saveModelSelection("deepseek-v4-pro", "opencode-go");
    const saved = require("node:fs").readFileSync(join(dir, "config.json"), "utf-8");

    expect(ok).toBe(true);
    expect(saved).toContain("// provider attivo");
    expect(saved).toContain(`\"model\": \"deepseek-v4-pro\"`);
    expect(provider.read().model).toBe("deepseek-v4-pro");
  });

  it("creates a minimal config file when none exists", () => {
    const provider = new HarnyFileConfigProvider(tmp, nodeFileSystem);

    const ok = provider.saveModelSelection("m1", "llamacpp");

    expect(ok).toBe(true);
    const read = provider.read();
    expect(read.model).toBe("m1");
    expect(read.provider as string).toBe("llamacpp");
  });

  it("resolves a named provider entry for runtime switching", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        providers: {
          llamacpp: {
            baseUrl: "http://localhost:8090/v1",
            api: "openai-completions",
            apiKey: "lamacpp",
            enableThinking: true,
            models: [{ id: "LLM/qwen.gguf", input: ["text", "image"] }, { id: "LLM/gemma.gguf" }],
          },
        },
      }),
    );
    const provider = new HarnyFileConfigProvider(tmp, nodeFileSystem);

    const entry = provider.getProvider("llamacpp");
    expect(entry).toEqual({
      name: "llamacpp",
      baseUrl: "http://localhost:8090/v1",
      apiKey: "lamacpp",
      enableThinking: true,
      thinkingMode: "bool",
      thinkingLevel: "medium",
      maxTokens: undefined,
      models: [
        { id: "LLM/qwen.gguf", input: ["text", "image"] },
        { id: "LLM/gemma.gguf" },
      ],
    });
    expect(provider.getProvider("missing")).toBeUndefined();
  });

  it("maps api to the chat protocol", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        providers: {
          x: { baseUrl: "http://x", api: "openai-completions", apiKey: "k", models: [] },
        },
      }),
    );
    const provider = new HarnyFileConfigProvider(tmp, nodeFileSystem);

  });

  it("selects the configured model", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        provider: "opencode-go",
        model: "deepseek-v4-pro",
        providers: {
          "opencode-go": {
            baseUrl: "https://opencode.ai/zen/go/v1",
            api: "openai-completions",
            apiKey: "sk-x",
            models: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }],
          },
        },
      }),
    );
    const provider = new HarnyFileConfigProvider(tmp, nodeFileSystem);

    const config = provider.read();
    expect(config.model).toBe("deepseek-v4-pro");
  });

  it("exposes the declared input modalities per model", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        provider: "llamacpp",
        providers: {
          llamacpp: {
            baseUrl: "http://x",
            api: "openai-completions",
            apiKey: "k",
            models: [
              { id: "vision.gguf", input: ["text", "image"] },
              { id: "text.gguf", input: ["text"] },
            ],
          },
        },
      }),
    );
    const provider = new HarnyFileConfigProvider(tmp, nodeFileSystem);
    expect(provider.read().modelModalities).toEqual({
      "vision.gguf": ["text", "image"],
      "text.gguf": ["text"],
    });
  });

  it("defaults to the first provider and first model when not selected", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        providers: {
          a: { baseUrl: "http://a", api: "openai-completions", apiKey: "ka", models: [{ id: "m1" }] },
          b: { baseUrl: "http://b", api: "openai-completions", apiKey: "kb", models: [{ id: "m2" }] },
        },
      }),
    );
    const provider = new HarnyFileConfigProvider(tmp, nodeFileSystem);

    const config = provider.read();
    expect(config.baseUrl).toBe("http://a");
    expect(config.apiKey).toBe("ka");
    expect(config.model).toBe("m1");
  });

  it("keeps flat overrides (temperature, maxTokens) in multi-provider mode", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        temperature: 0.9,
        maxTokens: 512,
        providers: {
          llamacpp: { baseUrl: "http://localhost:8090/v1", api: "openai-completions", apiKey: "k" },
        },
      }),
    );
    const provider = new HarnyFileConfigProvider(tmp, nodeFileSystem);

    const config = provider.read();
    expect(config.temperature).toBe(0.9);
    expect(config.maxTokens).toBe(512);
    expect(config.baseUrl).toBe("http://localhost:8090/v1");
  });

  it("scopes enableThinking per provider entry (llama.cpp flag not sent to hosted APIs)", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        provider: "opencode-go",
        model: "deepseek-v4-flash",
        providers: {
          "opencode-go": {
            baseUrl: "https://opencode.ai/zen/go/v1",
            api: "openai-completions",
            apiKey: "sk-x",
            models: [{ id: "deepseek-v4-flash", input: ["text"] }],
          },
          llamacpp: {
            baseUrl: "http://localhost:8090/v1",
            api: "openai-completions",
            apiKey: "k",
            enableThinking: true,
            models: [{ id: "qwen.gguf", input: ["text"] }],
          },
        },
      }),
    );
    const provider = new HarnyFileConfigProvider(tmp, nodeFileSystem);

    const config = provider.read();
    expect(config.provider).toBe("openai-compatible");
    expect(config.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(config.apiKey).toBe("sk-x");
    expect(config.model).toBe("deepseek-v4-flash");
    // enableThinking of the active provider applies (it's not set here)
    expect(config.enableThinking).toBeUndefined();
  });

  it("applies enableThinking from the active provider entry", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        provider: "llamacpp",
        providers: {
          llamacpp: { baseUrl: "http://localhost:8090/v1", api: "openai-completions", enableThinking: true },
          other: { baseUrl: "http://localhost:9000/v1", api: "openai-completions" },
        },
      }),
    );
    const provider = new HarnyFileConfigProvider(tmp, nodeFileSystem);

    const config = provider.read();
    expect(config.baseUrl).toBe("http://localhost:8090/v1");
    expect(config.enableThinking).toBe(true);
    // Legacy boolean flag: thinking is ON with a medium default level.
    expect(config.thinkingMode).toBe("bool");
    expect(config.thinkingLevel).toBe("medium");
  });

  it("maps legacy enableThinking:false to thinking low (no off anymore)", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        provider: "llamacpp",
        providers: {
          llamacpp: { baseUrl: "http://localhost:8090/v1", api: "openai-completions", enableThinking: false },
        },
      }),
    );
    const provider = new HarnyFileConfigProvider(tmp, nodeFileSystem);

    const config = provider.read();
    expect(config.thinkingMode).toBe("bool");
    expect(config.thinkingLevel).toBe("low");
  });

  it("supports explicit thinking mode and level per provider entry", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        provider: "openrouter",
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-completions",
            thinking: "effort",
            thinkingLevel: "high",
          },
          llamacpp: {
            baseUrl: "http://localhost:8090/v1",
            api: "openai-completions",
            thinking: "bool",
            thinkingLevel: "low",
          },
        },
      }),
    );
    const provider = new HarnyFileConfigProvider(tmp, nodeFileSystem);

    const active = provider.read();
    expect(active.thinkingMode).toBe("effort");
    expect(active.thinkingLevel).toBe("high");

    const llama = provider.getProvider("llamacpp");
    expect(llama?.thinkingMode).toBe("bool");
    expect(llama?.thinkingLevel).toBe("low");
    // The hosted (non-active) entry must not leak into the runtime config.
    expect(active.thinkingLevel).not.toBe("low");
  });

  it("reads flat thinkingMode / thinkingLevel keys", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ apiKey: "sk-x", provider: "openai-compatible", baseUrl: "http://localhost:11434", model: "qwen", thinkingMode: "effort", thinkingLevel: "low" }),
    );
    const provider = new HarnyFileConfigProvider(tmp, nodeFileSystem);

    const config = provider.read();
    expect(config.thinkingMode).toBe("effort");
    expect(config.thinkingLevel).toBe("low");
  });
});
