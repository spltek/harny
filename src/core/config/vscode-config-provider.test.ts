import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const configValues: Record<string, unknown> = {};
const workspaceMock = {
  getConfiguration: vi.fn(() => ({
    get: vi.fn((key: string, fallback: unknown) =>
      key in configValues ? configValues[key] : fallback,
    ),
  })),
};

vi.mock("vscode", () => ({ workspace: workspaceMock }));

const { VscodeConfigProvider } = await import("./vscode-config-provider");

describe("VscodeConfigProvider", () => {
  const originalKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(configValues)) delete configValues[k];
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  it("returns defaults when nothing is configured", () => {
    const provider = new VscodeConfigProvider();
    const config = provider.get();

    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o");
    expect(config.apiKey).toBe("");
  });

  it("reads values from harny.* settings", () => {
    configValues["provider"] = "openai-compatible";
    configValues["model"] = "llama3.2";
    configValues["baseUrl"] = "http://localhost:11434";
    configValues["temperature"] = 0.5;
    configValues["maxTokens"] = 2048;

    const provider = new VscodeConfigProvider();
    const config = provider.get();

    expect(config.provider).toBe("openai-compatible");
    expect(config.model).toBe("llama3.2");
    expect(config.baseUrl).toBe("http://localhost:11434");
    expect(config.temperature).toBe(0.5);
    expect(config.maxTokens).toBe(2048);
  });

  it("reads the optional subagentMaxTurns setting (unset = undefined = no cap)", () => {
    expect(new VscodeConfigProvider().get().subagentMaxTurns).toBeUndefined();

    configValues["subagentMaxTurns"] = 7;
    expect(new VscodeConfigProvider().get().subagentMaxTurns).toBe(7);
  });

  it("falls back to OPENAI_API_KEY env var when apiKey is empty", () => {
    process.env.OPENAI_API_KEY = "sk-env-key";

    const provider = new VscodeConfigProvider();
    const config = provider.get();

    expect(config.apiKey).toBe("sk-env-key");
  });

  it("prefers the configured apiKey over the env var", () => {
    configValues["apiKey"] = "sk-configured";
    process.env.OPENAI_API_KEY = "sk-env-key";

    const provider = new VscodeConfigProvider();
    const config = provider.get();

    expect(config.apiKey).toBe("sk-configured");
  });
});
