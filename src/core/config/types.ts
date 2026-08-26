export type ProviderName = "openai" | "openai-compatible" | "anthropic";

/**
 * How the active provider/model exposes the reasoning/thinking phase.
 * - "bool":   llama.cpp-style `chat_template_kwargs.enable_thinking` (on/off)
 *             + the standard `reasoning_effort` level inside `chat_template_kwargs`
 * - "effort": OpenAI-style `reasoning_effort` (low/medium/high)
 * - "none":   no thinking control is sent (default)
 */
export type ThinkingMode = "bool" | "effort" | "none";

/** Per-session thinking level — always sent (we never disable; models without
 * a reasoning phase simply ignore the field). */
export type ThinkingLevel = "low" | "medium" | "high";

export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return v === "low" || v === "medium" || v === "high";
}

export function isThinkingMode(v: unknown): v is ThinkingMode {
  return v === "bool" || v === "effort" || v === "none";
}

export interface HarnyConfig {
  provider: ProviderName;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  /** Sampler temperature; omitted (not sent) when unset. */
  temperature?: number;
  /** Presence penalty (− encourages… Auto/0 = not sent); 0.0–2.0 in the UI. */
  presencePenalty?: number;
  /** Frequency penalty (positive reduces repetition; Auto/0 = not sent). */
  frequencyPenalty?: number;
  /** Nucleus sampling threshold (0.0–1.0); sent only when the sampler is active. */
  topP?: number;
  /** Which sampler is ACTIVE per session: only its value is sent. */
  sampler?: "temperature" | "topP";
  contextFiles: boolean;
  autoApprove: boolean;
  /** Open the chat panel automatically when VS Code starts. */
  autoOpen: boolean;
  /** Model ids exposed by the active provider (optional, for UI pickers). */
  availableModels?: string[];
  /** Input modalities per model id (optional, e.g. {"m": ["text", "image"]}). */
  modelModalities?: Record<string, string[]>;
  /** All named providers from the multi-provider file, with their models (for the chat UI picker). */
  providerModels?: { provider: string; model: string }[];
  /** Name of the active named provider in the multi-provider file format (e.g. "llamacpp"). */
  activeProvider?: string;
  /**
   * Names of the named providers whose model list must be fetched from the
   * host `/models` endpoint (config declares only apiKey + baseUrl, no models).
   */
  hostModelProviders?: string[];
  /** Disable reasoning/thinking for reasoning models (llama.cpp `enable_thinking`). Legacy flag. */
  enableThinking?: boolean;
  /** How the provider exposes thinking control (bool = llama.cpp kwargs + reasoning_effort, effort = reasoning_effort, none = off). */
  thinkingMode?: ThinkingMode;
  /** Thinking level for the current session; ignored when thinkingMode is "none". */
  thinkingLevel?: ThinkingLevel;

}

export const DEFAULT_CONFIG: HarnyConfig = {
  provider: "openai",
  apiKey: "",
  baseUrl: "https://api.openai.com",
  model: "gpt-4o",
  maxTokens: 8192,
  contextFiles: true,
  autoApprove: false,
  autoOpen: false,
  // Our default thinking level: always sent (unless the user picks Off).
  thinkingLevel: "medium",
};

export interface ConfigProvider {
  get(): HarnyConfig;
}

/** A named provider entry resolved from the multi-provider file, ready for runtime switching. */
export interface ResolvedNamedProvider {
  name: string;
  baseUrl?: string;
  apiKey?: string;
  enableThinking?: boolean;
  thinkingMode?: ThinkingMode;
  thinkingLevel?: ThinkingLevel;
  maxTokens?: number;
  models: { id: string; input?: string[] }[];
}

/** Source of named providers for the chat UI (runtime provider switching). */
export interface NamedProvidersSource {
  getProvider(name: string): ResolvedNamedProvider | undefined;
}

/** Persists the model selection (and optionally the active named provider) into the config file. */
export interface ModelSelectionSaver {
  saveModelSelection(model: string, provider?: string): boolean;
}

/** A named-provider source that can also persist selections (the file config provider). */
export interface ProviderCatalog extends NamedProvidersSource, ModelSelectionSaver {}
