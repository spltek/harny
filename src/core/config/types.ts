export type ProviderName = "openai" | "openai-compatible" | "anthropic";

/**
 * How the active provider/model exposes the reasoning/thinking phase.
 * - "bool":   llama.cpp-style `chat_template_kwargs.enable_thinking` (on/off)
 *             + the standard `reasoning_effort` level inside `chat_template_kwargs`
 * - "effort": OpenAI-style `reasoning_effort` (low/medium/high)
 * - "type":   DeepSeek/Anthropic-style `thinking: { type: "enabled" | "disabled" }`
 *             (used by OpenCode Go for DeepSeek/Qwen/Kimi models)
 * - "reasoning": OpenRouter-native `reasoning: { effort }` for levels and
 *             `reasoning: { enabled: false }` to disable (reliable for
 *             DeepSeek; 400 on reasoning-mandatory models like gpt-5)
 * - "unspecified": nothing is sent — the provider/model keeps its own default
 *             (NOT an explicit "off"; it is the same as omitting the field).
 */
export type ThinkingMode = "bool" | "effort" | "type" | "reasoning" | "unspecified";

/** Per-session thinking level, generalized across providers. */
export type ThinkingLevel = "off" | "low" | "medium" | "high";

export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return v === "off" || v === "low" || v === "medium" || v === "high";
}

export function isThinkingMode(v: unknown): v is ThinkingMode {
  return v === "bool" || v === "effort" || v === "type" || v === "reasoning" || v === "unspecified";
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
  /** How the provider exposes thinking control (bool = llama.cpp kwargs + reasoning_effort, effort = reasoning_effort, type = thinking.type, unspecified = send nothing). */
  thinkingMode?: ThinkingMode;
  /** Thinking level for the current session; ignored when thinkingMode is "unspecified". */
  thinkingLevel?: ThinkingLevel;
  /**
   * Extra static request headers from the active named provider (e.g. a
   * custom User-Agent or an origin tag). Applied to chat-completions
   * requests only.
   */
  extraHeaders?: Record<string, string>;
  /**
   * Name of the header carrying a per-conversation session id (e.g. OpenCode
   * Go's `x-opencode-session`). When set, the provider sends
   * `<sessionHeader>: <sessionId>` so the host can optimize routing/caching.
   */
  sessionHeader?: string;
  /** Stable id of the harny session building the request (from the registry). */
  sessionId?: string;
  /**
   * Optional global cap on concurrently-running sub-agents (parallel reads).
   * Undefined = no cap. Set from the gear form.
   */
  maxParallelSubAgents?: number;
  /**
   * Max tool turns a single sub-agent may use before it is asked for its
   * report (default 100). Raise it for long sub-tasks; the loop guard still
   * stops degenerate loops independently.
   */
  subagentMaxTurns?: number;
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
  subagentMaxTurns: 100,
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
  /** Static extra request headers declared for this provider. */
  extraHeaders?: Record<string, string>;
  /** Header name for the per-conversation session id (e.g. x-opencode-session). */
  sessionHeader?: string;
  models: { id: string; input?: string[] }[];
}

/** Source of named providers for the chat UI (runtime provider switching). */
export interface NamedProvidersSource {
  getProvider(name: string): ResolvedNamedProvider | undefined;
}

/** Raw view of the config's named providers, for the gear editor UI. */
export interface ProviderEditorEntry {
  baseUrl?: string;
  apiKey?: string;
  thinking?: ThinkingMode;
  thinkingLevel?: ThinkingLevel;
  maxTokens?: number;
  /** Static extra headers (carried through the editor untouched). */
  headers?: Record<string, string>;
  /** Header name for the per-conversation session id (e.g. x-opencode-session). */
  sessionHeader?: string;
  /**
   * Every provider key the editor does NOT manage (e.g. `models`, `enableThinking`,
   * future/unknown fields), preserved verbatim so a save is LOSSLESS.
   */
  extra?: Record<string, unknown>;
}

export interface ProviderEditorData {
  activeProvider?: string;
  /** All named providers from the config file, keyed by name. */
  providers: Record<string, ProviderEditorEntry>;
  /**
   * Optional global cap on how many sub-agents run in PARALLEL. Undefined =
   * no cap (the orchestrator's batches all wait together). Set from the gear
   * form ("Set max parallel sub-agents").
   */
  maxParallelSubAgents?: number;
}

/** Persists the model selection (and optionally the active named provider) into the config file. */
export interface ModelSelectionSaver {
  saveModelSelection(model: string, provider?: string): boolean;
}

/** A named-provider source that can also persist selections (the file config provider). */
export interface ProviderCatalog extends NamedProvidersSource, ModelSelectionSaver {
  /** Full raw provider map for the gear editor (no config-side model lists). */
  readProvidersEditor(): ProviderEditorData;
  /** Replace the config's provider map + active provider, preserving other keys. */
  saveProvidersEditor(data: ProviderEditorData): boolean;
}
