import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, mkdtempSync } from "node:fs";
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

  it("maps legacy enableThinking:false to thinking off", () => {
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
    expect(config.thinkingLevel).toBe("off");
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
          "opencode-go": {
            baseUrl: "https://opencode.ai/zen/go/v1",
            api: "openai-completions",
            thinking: "type",
            thinkingLevel: "medium",
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

    const ocg = provider.getProvider("opencode-go");
    expect(ocg?.thinkingMode).toBe("type");
    expect(ocg?.thinkingLevel).toBe("medium");
    // The hosted (non-active) entry must not leak into the runtime config.
    expect(active.thinkingLevel).not.toBe("low");
  });

  it("gear editor preserves unmanaged keys — a save is lossless", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        provider: "custom",
        providers: {
          custom: {
            baseUrl: "http://old/v1",
            api: "openai-completions",
            apiKey: "k",
            thinking: "type",
            thinkingLevel: "high",
            maxTokens: 1234,
            headers: { "X-A": "1" },
            models: [{ id: "m1", input: ["text"] }],
            customAnything: { nested: true },
          },
        },
      }),
    );
    const provider = new HarnyFileConfigProvider(tmp, nodeFileSystem);

    // Keys the form does not manage are surfaced as `extra`...
    const editor = provider.readProvidersEditor();
    expect(editor.providers.custom.extra).toEqual({
      models: [{ id: "m1", input: ["text"] }],
      customAnything: { nested: true },
    });

    // ...and survive a save that only changes the base URL.
    const round = provider.readProvidersEditor();
    round.providers.custom.baseUrl = "http://new/v1";
    expect(provider.saveProvidersEditor(round)).toBe(true);

    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).providers.custom).toEqual({
      api: "openai-completions",
      baseUrl: "http://new/v1",
      apiKey: "k",
      thinking: "type",
      thinkingLevel: "high",
      maxTokens: 1234,
      headers: { "X-A": "1" },
      models: [{ id: "m1", input: ["text"] }],
      customAnything: { nested: true },
    });
    expect(provider.getProvider("custom")?.models).toEqual([{ id: "m1", input: ["text"] }]);
  });

  it("clearing thinking also drops the legacy enableThinking flag", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        provider: "custom",
        providers: { custom: { baseUrl: "http://x/v1", enableThinking: true } },
      }),
    );
    const provider = new HarnyFileConfigProvider(tmp, nodeFileSystem);
    const editor = provider.readProvidersEditor();
    expect(editor.providers.custom.thinking).toBe("bool");
    editor.providers.custom.thinking = undefined;
    expect(provider.saveProvidersEditor(editor)).toBe(true);
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    expect(raw.providers.custom).toEqual({ api: "openai-completions", baseUrl: "http://x/v1" });
    expect(provider.getProvider("custom")?.thinkingMode).toBeUndefined();
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

  it("readProvidersEditor returns the raw provider map incl. the active one", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        provider: "llamacpp",
        model: "qwen",
        providers: {
          llamacpp: { baseUrl: "http://localhost:8090/v1", api: "openai-completions", apiKey: "local", thinking: "bool", thinkingLevel: "medium" },
          openrouter: { baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", apiKey: "sk-or", thinking: "effort" },
        },
      }),
    );
    const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);
    const editor = provider.readProvidersEditor();
    expect(editor.activeProvider).toBe("llamacpp");
    expect(Object.keys(editor.providers).sort()).toEqual(["llamacpp", "openrouter"]);
    expect(editor.providers.llamacpp).toEqual({
      baseUrl: "http://localhost:8090/v1",
      apiKey: "local",
      thinking: "bool",
      thinkingLevel: "medium",
    });
    expect(editor.providers.openrouter).toEqual({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-or",
      thinking: "effort",
    });
  });

  it("round-trips the global maxParallelSubAgents setting (flag off removes it)", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ providers: { p: { baseUrl: "http://x/v1" } }, maxParallelSubAgents: 4 }),
    );
    const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);
    expect(provider.readProvidersEditor().maxParallelSubAgents).toBe(4);
    expect(provider.read().maxParallelSubAgents).toBe(4);

    // Save with the cap set.
    const editor = provider.readProvidersEditor();
    editor.maxParallelSubAgents = 2;
    expect(provider.saveProvidersEditor(editor)).toBe(true);
    expect(provider.readProvidersEditor().maxParallelSubAgents).toBe(2);
    expect(provider.read().maxParallelSubAgents).toBe(2);

    // Flag off → undefined → the key is REMOVED from the file.
    const editor2 = provider.readProvidersEditor();
    editor2.maxParallelSubAgents = undefined;
    expect(provider.saveProvidersEditor(editor2)).toBe(true);
    expect(provider.readProvidersEditor().maxParallelSubAgents).toBeUndefined();
    expect(provider.read().maxParallelSubAgents).toBeUndefined();
    const raw = JSON.parse(
      (require("node:fs") as typeof import("node:fs")).readFileSync(join(dir, "config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect("maxParallelSubAgents" in raw).toBe(false);
  });

  it("reads the optional subagentMaxTurns setting and preserves it on save", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ providers: { p: { baseUrl: "http://x/v1" } }, subagentMaxTurns: 7 }),
    );
    const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);
    expect(provider.read().subagentMaxTurns).toBe(7);

    // Saving the providers editor preserves unknown top-level keys (lossless).
    const editor = provider.readProvidersEditor();
    expect(provider.saveProvidersEditor(editor)).toBe(true);
    expect(provider.read().subagentMaxTurns).toBe(7);
  });

  it("ignores invalid maxParallelSubAgents values (0, negative, non-integer)", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ providers: {}, maxParallelSubAgents: 0 }));
    const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);
    expect(provider.read().maxParallelSubAgents).toBeUndefined();
    expect(provider.readProvidersEditor().maxParallelSubAgents).toBeUndefined();
  });

  it("saveProvidersEditor replaces the provider map, preserves other keys, and creates the file when missing", () => {
    const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);
    const ok = provider.saveProvidersEditor({
      activeProvider: "llamacpp",
      providers: {
        llamacpp: { baseUrl: "http://localhost:8090/v1", apiKey: "local", thinking: "bool" },
      },
    });
    expect(ok).toBe(true);
    // Fresh install: a config.json (not config.jsonc) is created.
    const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
    expect(existsSync(join(dir, "config.json"))).toBe(true);
    expect(existsSync(join(dir, "config.jsonc"))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))).toEqual({
      providers: { llamacpp: { api: "openai-completions", baseUrl: "http://localhost:8090/v1", apiKey: "local", thinking: "bool" } },
      provider: "llamacpp",
    });
    const data = provider.read();
    expect(data.activeProvider).toBe("llamacpp");
    expect(data.baseUrl).toBe("http://localhost:8090/v1");
    expect(data.apiKey).toBe("local");
    expect(data.thinkingMode).toBe("bool");
    expect(provider.readProvidersEditor().providers.llamacpp).toEqual({
      baseUrl: "http://localhost:8090/v1",
      apiKey: "local",
      thinking: "bool",
    });
  });

  it("saveProvidersEditor on a fresh install without activeProvider has no top-level provider", () => {
    const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);
    const ok = provider.saveProvidersEditor({
      providers: { llamacpp: { baseUrl: "http://localhost:8090/v1" } },
    });
    expect(ok).toBe(true);
    const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
    expect(existsSync(join(dir, "config.json"))).toBe(true);
    const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<string, unknown>;
    expect(raw.provider).toBeUndefined(); // no active provider forced
    // reads still resolve the first provider as the effective active one
    expect(provider.read().activeProvider).toBe("llamacpp");
  });

  it("saveProvidersEditor keeps existing top-level keys (model, temp) and writes config.json", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ provider: "old", model: "kept-model", temperature: 0.5, providers: { old: { baseUrl: "http://x/v1", api: "openai-completions" } } }),
    );
    const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);
    provider.saveProvidersEditor({ providers: { newp: { baseUrl: "http://y/v1" } } });
    const raw = JSON.parse(require("node:fs").readFileSync(join(dir, "config.json"), "utf8")) as Record<string, unknown>;
    expect(raw.model).toBe("kept-model");
    expect(raw.temperature).toBe(0.5);
    expect((raw.providers as Record<string, unknown>).newp).toEqual({ api: "openai-completions", baseUrl: "http://y/v1" });
    expect((raw.providers as Record<string, unknown>).old).toBeUndefined();
  });

  it("saveProvidersEditor with an activeProvider sets the active top-level provider", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ provider: "a", providers: { a: { baseUrl: "http://a/v1", api: "openai-completions" } } }),
    );
    const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);
    provider.saveProvidersEditor({ activeProvider: "b", providers: { b: { baseUrl: "http://b/v1" } } });
    const raw = JSON.parse(require("node:fs").readFileSync(join(dir, "config.json"), "utf8")) as Record<string, unknown>;
    expect(raw.provider).toBe("b");
  });
});

describe("HarnyFileConfigProvider opencode session header fields", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harny-config-sh-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("flattens sessionHeader + static headers into the runtime config and getProvider", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        provider: "opencode-go",
        model: "deepseek-v4-pro",
        providers: {
          "opencode-go": {
            baseUrl: "https://opencode.ai/go/v1",
            api: "openai-completions",
            apiKey: "go-key",
            sessionHeader: "x-opencode-session",
            headers: { "X-Origin": "harny", "User-Agent": "harny-agent" },
            models: [{ id: "deepseek-v4-pro" }],
          },
        },
      }),
    );
    const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);
    const data = provider.read();
    expect(data.sessionHeader).toBe("x-opencode-session");
    expect(data.extraHeaders).toEqual({ "X-Origin": "harny", "User-Agent": "harny-agent" });
    const resolved = provider.getProvider("opencode-go");
    expect(resolved?.sessionHeader).toBe("x-opencode-session");
    expect(resolved?.extraHeaders).toEqual({ "X-Origin": "harny", "User-Agent": "harny-agent" });
  });

  it("drops non-string / empty values from declared headers and ignores stray sessionHeader types", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        provider: "p",
        providers: {
          p: {
            baseUrl: "http://p/v1",
            sessionHeader: 42,
            headers: { Keep: "yes", Drop: 3, Empty: "" },
          },
        },
      }),
    );
    const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);
    const resolved = provider.getProvider("p");
    expect(resolved?.sessionHeader).toBeUndefined();
    expect(resolved?.extraHeaders).toEqual({ Keep: "yes" });
  });

  it("editor round-trips sessionHeader and headers (save does not drop them)", () => {
    const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);
    provider.saveProvidersEditor({
      providers: {
        "opencode-go": {
          baseUrl: "https://opencode.ai/go/v1",
          apiKey: "go-key",
          sessionHeader: "x-opencode-session",
          headers: { "X-Origin": "harny" },
        },
      },
    });
    const raw = JSON.parse(require("node:fs").readFileSync(join(dir, "config.json"), "utf8")) as Record<string, unknown>;
    expect((raw.providers as Record<string, unknown>)["opencode-go"]).toEqual({
      api: "openai-completions",
      baseUrl: "https://opencode.ai/go/v1",
      apiKey: "go-key",
      sessionHeader: "x-opencode-session",
      headers: { "X-Origin": "harny" },
    });
    const editor = provider.readProvidersEditor();
    expect(editor.providers["opencode-go"].sessionHeader).toBe("x-opencode-session");
    expect(editor.providers["opencode-go"].headers).toEqual({ "X-Origin": "harny" });
    // Flattened into the runtime config too.
    expect(provider.read().sessionHeader).toBe("x-opencode-session");
  });
});

describe("exportProviders / importProviders", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harny-io-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const readRaw = (): Record<string, unknown> =>
    JSON.parse(require("node:fs").readFileSync(join(dir, "config.json"), "utf8"));

  it("exports the RAW providers section (lossless: api/models kept) + active provider", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        provider: "a",
        maxParallelSubAgents: 3,
        providers: {
          a: { baseUrl: "http://x/v1", apiKey: "k", api: "openai-completions", models: ["m1"] },
          b: { baseUrl: "http://y/v1" },
        },
      }),
    );
    const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);
    const out = provider.exportProviders();
    expect(out.provider).toBe("a");
    expect(out.maxParallelSubAgents).toBe(3);
    expect(out.providers).toMatchObject({
      a: { baseUrl: "http://x/v1", api: "openai-completions", models: ["m1"] },
      b: { baseUrl: "http://y/v1" },
    });
  });

  it("imports with MERGE: same name overridden, others kept, unknown keys preserved", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        keep: "yes",
        provider: "a",
        providers: { a: { baseUrl: "http://old/v1" }, b: { baseUrl: "http://b/v1" } },
      }),
    );
    const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);
    expect(provider.importProviders({ providers: { a: { baseUrl: "http://new/v1" }, c: { baseUrl: "http://c/v1" } } })).toBe(true);
    const raw = readRaw();
    expect(raw.keep).toBe("yes");
    const providers = raw.providers as Record<string, { baseUrl: string }>;
    expect(providers.a.baseUrl).toBe("http://new/v1");
    expect(providers.b.baseUrl).toBe("http://b/v1");
    expect(providers.c.baseUrl).toBe("http://c/v1");
  });

  it("imports with REPLACE: only the incoming providers remain", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ providers: { a: { baseUrl: "http://a/v1" } } }));
    const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);
    expect(provider.importProviders({ providers: { z: { baseUrl: "http://z/v1" } } }, "replace")).toBe(true);
    expect(Object.keys(readRaw().providers as Record<string, unknown>)).toEqual(["z"]);
  });

  it("rejects an invalid payload (no usable providers) and writes nothing", () => {
    const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);
    expect(provider.importProviders({ nope: true })).toBe(false);
    expect(provider.importProviders(null)).toBe(false);
    expect(provider.importProviders({ providers: {} })).toBe(false);
    expect(provider.importProviders({ providers: { bad: 42 } })).toBe(false);
    expect(require("node:fs").existsSync(join(dir, "config.json"))).toBe(false);
  });
});

describe("HarnyFileConfigProvider MCP servers", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "harny-mcp-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("reads + normalizes mcpServers (stdio and http, dropping malformed)", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        providers: { p: { baseUrl: "http://x" } },
        mcpServers: {
          github: { command: "npx", args: ["-y", "server-github"], env: { TOKEN: "t" } },
          remote: { url: "https://example.com/mcp", headers: { "X-A": "1" } },
          blank: { command: "   " },
          bad: 42,
        },
      }),
    );
    const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);
    expect(provider.readMcpServers()).toEqual({
      github: { command: "npx", args: ["-y", "server-github"], env: { TOKEN: "t" } },
      remote: { url: "https://example.com/mcp", headers: { "X-A": "1" } },
    });
  });

  it("keeps the per-server enabled flag", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        mcpServers: {
          on: { command: "node" },
          off: { command: "node", enabled: false },
        },
      }),
    );
    const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);
    expect(provider.readMcpServers()).toEqual({
      on: { command: "node" },
      off: { command: "node", enabled: false },
    });
  });

  it("returns {} when the config file is missing", () => {
    const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);
    expect(provider.readMcpServers()).toEqual({});
  });

  it("saves mcpServers losslessly (preserving other keys) and removes the key when empty", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ provider: "p", providers: { p: { baseUrl: "http://x" } } }));
    const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);

    expect(provider.saveMcpServers({ test: { command: "node", args: ["server.js"] } })).toBe(true);
    const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    expect(raw.mcpServers).toEqual({ test: { command: "node", args: ["server.js"] } });
    expect(raw.providers).toEqual({ p: { baseUrl: "http://x" } }); // preserved
    expect(provider.readMcpServers()).toEqual({ test: { command: "node", args: ["server.js"] } });

    expect(provider.saveMcpServers({})).toBe(true);
    expect("mcpServers" in JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))).toBe(false);
  });
});
