import { describe, it, expect } from "vitest";
import { isLocalBaseUrl, requiresApiKey } from "./requires-api-key";
import type { HarnyConfig } from "./types";

const BASE: HarnyConfig = {
  provider: "openai-compatible",
  apiKey: "",
  baseUrl: "http://localhost:8090/v1",
  model: "m",
  maxTokens: 100,
  temperature: 0,
  contextFiles: true,
  autoApprove: false,
  autoOpen: false,
};

describe("isLocalBaseUrl", () => {
  it("recognizes local hosts", () => {
    expect(isLocalBaseUrl("http://localhost:8090/v1")).toBe(true);
    expect(isLocalBaseUrl("http://127.0.0.1:11434")).toBe(true);
    expect(isLocalBaseUrl("http://0.0.0.0:8000")).toBe(true);
    expect(isLocalBaseUrl("http://[::1]:8090")).toBe(true);
  });

  it("rejects remote hosts", () => {
    expect(isLocalBaseUrl("https://api.openai.com/v1")).toBe(false);
    expect(isLocalBaseUrl("https://api.anthropic.com")).toBe(false);
  });

  it("treats unparseable URLs as remote", () => {
    expect(isLocalBaseUrl("localhost:8090")).toBe(false);
    expect(isLocalBaseUrl("")).toBe(false);
  });
});

describe("requiresApiKey", () => {
  it("never requires a key when one is set", () => {
    expect(requiresApiKey({ ...BASE, apiKey: "k" })).toBe(false);
  });

  it("does not require a key for local endpoints", () => {
    expect(requiresApiKey(BASE)).toBe(false);
    expect(requiresApiKey({ ...BASE, baseUrl: "http://127.0.0.1:11434" })).toBe(false);
  });

  it("requires a key for remote endpoints without one (whitespace-only counts as none)", () => {
    expect(requiresApiKey({ ...BASE, baseUrl: "https://api.openai.com" })).toBe(true);
    expect(requiresApiKey({ ...BASE, provider: "openai", baseUrl: "https://api.openai.com" })).toBe(true);
    expect(requiresApiKey({ ...BASE, apiKey: " ", baseUrl: "https://api.openai.com" })).toBe(true);
  });
});
