import type { HarnyConfig } from "../config/types";
import type { ToolDefinition } from "../tools/tool";
import type { HttpClient } from "./http-client";
import { OpenAIChatProvider } from "./openai-chat-provider";
import type { LLMProvider, LLMProviderFactory } from "./types";

/**
 * Picks the LLM provider implementation based on the configured protocol.
 */
export class DefaultLlmProviderFactory implements LLMProviderFactory {
  constructor(
    private http: HttpClient,
    private toolDefinitions: ToolDefinition[],
  ) {}

  create(config: HarnyConfig): LLMProvider {
    return new OpenAIChatProvider(config, this.http, this.toolDefinitions);
  }
}
