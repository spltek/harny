import { describe, it, expect } from "vitest";
import { DefaultLlmProviderFactory } from "./llm-provider-factory";
import { OpenAIChatProvider } from "./openai-chat-provider";
import { FakeHttpClient } from "./http-client.test-utils";
import type { HarnyConfig } from "../config/types";

const base: HarnyConfig = {
  provider: "openai",
  apiKey: "k",
  baseUrl: "https://api.openai.com",
  model: "gpt-4o",
  maxTokens: 100,
  temperature: 0,
  autoOpen: false,
};

describe("DefaultLlmProviderFactory", () => {
  it("creates a chat provider for the chat protocol", () => {
    const factory = new DefaultLlmProviderFactory(new FakeHttpClient(), []);
    const provider = factory.create({ ...base, protocol: "chat" });
    expect(provider).toBeInstanceOf(OpenAIChatProvider);
  });
});
