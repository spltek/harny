import { join } from "node:path";
import type { FileSystem } from "../tools/file-system";
import { preprocessJsonc, setTopLevelString } from "./jsonc";
import type { PartialConfigProvider } from "./partial-config-provider";
import { isThinkingLevel, isThinkingMode } from "./types";
import type {
  HarnyConfig,
  ProviderCatalog,
  ProviderEditorData,
  ProviderEditorEntry,
  ResolvedNamedProvider,
} from "./types";

interface NamedProviderEntry {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: unknown[];
  enableThinking?: boolean;
  /** "bool" (llama.cpp kwargs) | "effort" (reasoning_effort) | "none" */
  thinking?: string;
  /** Default thinking level for this provider: "off" | "low" | "medium" | "high" */
  thinkingLevel?: string;
  maxTokens?: number;
  /** Static extra request headers (string values only are honoured). */
  headers?: Record<string, unknown>;
  /** Header name for the per-conversation session id (e.g. x-opencode-session). */
  sessionHeader?: string;
}

/**
 * Reads a dedicated `config.json` (or `config.jsonc`) file from a directory
 * (the Harny home folder, e.g. `~/.harny`). Supports comments and trailing
 * commas. Invalid files are ignored.
 *
 * Two formats are supported:
 *
 * 1. Flat:
 *    { "apiKey": "...", "provider": "openai-compatible", "model": "...", ... }
 *
 * 2. Multi-provider map:
 *    {
 *      "provider": "llamacpp",                 // active provider name
 *      "model": "qwen.gguf",                   // selected model id
 *      "providers": {
 *        "llamacpp": {
 *          "baseUrl": "http://localhost:8090/v1",
 *          "api": "openai-completions",
 *          "apiKey": "...",
 *          "models": [ { "id": "...", "input": ["text", "image"] } ]
 *        }
 *      }
 *    }
 */
export class HarnyFileConfigProvider implements PartialConfigProvider, ProviderCatalog {
  constructor(
    private dir: () => string,
    private fs: FileSystem,
  ) {}

  read(): Partial<HarnyConfig> {
    const data = this.parseFile();
    if (!data) return {};

    const out = this.readFlatKeys(data);

    // Multi-provider format: resolve the active named provider on top of the flat keys,
    // and expose the full catalog (all providers + their models) for the chat UI picker.
    const providers = this.asProviderMap(data);
    if (providers && Object.keys(providers).length > 0) {
      const named = this.resolveNamedProvider(data, providers);
      if (named) Object.assign(out, named);

      const providerModels: { provider: string; model: string }[] = [];
      const hostModelProviders: string[] = [];
      for (const [name, entry] of Object.entries(providers)) {
        const ids = this.modelIds(entry);
        for (const modelId of ids) {
          providerModels.push({ provider: name, model: modelId });
        }
        // No models declared in the config → ask the host for its list.
        if (ids.length === 0) hostModelProviders.push(name);
      }
      if (providerModels.length > 0) out.providerModels = providerModels;
      if (hostModelProviders.length > 0) out.hostModelProviders = hostModelProviders;
      out.activeProvider = this.activeProviderName(data, providers);
    }
    return out;
  }

  /** Persists the selected model (and optionally the active provider) into the config file. */
  saveModelSelection(model: string, provider?: string): boolean {
    try {
      const base = this.dir();
      if (!base) return false;
      const path = this.fs.exists(join(base, "config.json"))
        ? join(base, "config.json")
        : join(base, "config.jsonc");
      if (this.fs.exists(path)) {
        let text = this.fs.readText(path);
        text = setTopLevelString(text, "model", model);
        if (provider) text = setTopLevelString(text, "provider", provider);
        this.fs.writeText(path, text);
        return true;
      }
      // No config file yet: create a minimal one.
      this.fs.mkdirRecursive(base);
      const entry: Record<string, string> = { model };
      if (provider) entry.provider = provider;
      this.fs.writeText(join(base, "config.json"), JSON.stringify(entry, null, 2) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  /** Returns the resolved entry of a named provider, for runtime switching from the chat UI. */
  getProvider(name: string): ResolvedNamedProvider | undefined {
    const data = this.parseFile();
    if (!data) return undefined;
    const providers = this.asProviderMap(data);
    const entry = providers?.[name];
    if (!entry) return undefined;
    return {
      name,
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKey,
      enableThinking: entry.enableThinking,
      thinkingMode: this.thinkingMode(entry),
      thinkingLevel: this.thinkingLevel(entry),
      maxTokens: entry.maxTokens,
      extraHeaders: this.headers(entry),
      sessionHeader: typeof entry.sessionHeader === "string" && entry.sessionHeader.trim()
        ? entry.sessionHeader.trim()
        : undefined,
      models: this.rawModels(entry),
    };
  }

  /** Normalize a provider's extra headers: only non-empty string values count. */
  private headers(entry: NamedProviderEntry): Record<string, string> | undefined {
    if (!entry.headers || typeof entry.headers !== "object") return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(entry.headers)) {
      if (typeof v === "string" && v.trim()) out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /** Full raw provider map for the gear editor (config-side only, no fetch). */
  readProvidersEditor(): ProviderEditorData {
    const data = this.parseFile();
    const providers: Record<string, ProviderEditorEntry> = {};
    const map = data ? this.asProviderMap(data) : undefined;
    if (map) {
      for (const [name, entry] of Object.entries(map)) {
        const out: ProviderEditorEntry = {};
        if (typeof entry.baseUrl === "string") out.baseUrl = entry.baseUrl;
        if (typeof entry.apiKey === "string") out.apiKey = entry.apiKey;
        const mode = this.thinkingMode(entry);
        if (mode) out.thinking = mode;
        const lvl = this.thinkingLevel(entry);
        if (lvl) out.thinkingLevel = lvl;
        if (typeof entry.maxTokens === "number") out.maxTokens = entry.maxTokens;
        const hdrs = this.headers(entry);
        if (hdrs) out.headers = hdrs;
        if (typeof entry.sessionHeader === "string" && entry.sessionHeader.trim()) {
          out.sessionHeader = entry.sessionHeader.trim();
        }
        providers[name] = out;
      }
    }
    return {
      activeProvider: data ? this.activeProviderName(data, map ?? {}) : undefined,
      providers,
    };
  }

  /** Replace the config's provider map + active provider, preserving other keys. */
  saveProvidersEditor(data: ProviderEditorData): boolean {
    try {
      const base = this.dir();
      if (!base) return false;
      const jsonPath = join(base, "config.json");
      const jsoncPath = join(base, "config.jsonc");
      // Fresh install (no file yet): create config.json. Otherwise keep the
      // extension the user already uses (json vs jsonc).
      const jsonExists = this.fs.exists(jsonPath);
      const jsoncExists = this.fs.exists(jsoncPath);
      const path = jsonExists ? jsonPath : jsoncExists ? jsoncPath : jsonPath;
      let parsed: Record<string, unknown> = {};
      if (jsonExists || jsoncExists) {
        const before = this.parseFile();
        if (before) parsed = before;
      }

      const providers: Record<string, Record<string, unknown>> = {};
      for (const [name, entry] of Object.entries(data.providers)) {
        const p: Record<string, unknown> = { api: "openai-completions" };
        if (entry.baseUrl) p.baseUrl = entry.baseUrl;
        if (entry.apiKey) p.apiKey = entry.apiKey;
        if (entry.thinking && isThinkingMode(entry.thinking)) p.thinking = entry.thinking;
        if (entry.thinkingLevel && isThinkingLevel(entry.thinkingLevel)) p.thinkingLevel = entry.thinkingLevel;
        if (typeof entry.maxTokens === "number") p.maxTokens = entry.maxTokens;
        if (entry.headers && Object.keys(entry.headers).length > 0) p.headers = entry.headers;
        if (entry.sessionHeader && entry.sessionHeader.trim()) p.sessionHeader = entry.sessionHeader.trim();
        providers[name] = p;
      }
      parsed.providers = providers;
      if (data.activeProvider && providers[data.activeProvider]) {
        parsed.provider = data.activeProvider;
      } else if (data.activeProvider === undefined) {
        // No change requested for the active provider.
      }

      // Preserve the file extension the user already uses (json vs jsonc);
      // fresh installs get config.json.
      this.fs.mkdirRecursive(base);
      this.fs.writeText(path, JSON.stringify(parsed, null, 2) + "\n");
      return true;
    } catch {
      return false;
    }
  }


  private parseFile(): Record<string, unknown> | undefined {
    const base = this.dir();
    if (!base) return undefined;
    const path = this.fs.exists(join(base, "config.json"))
      ? join(base, "config.json")
      : join(base, "config.jsonc");
    if (!this.fs.exists(path)) return undefined;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(preprocessJsonc(this.fs.readText(path)));
    } catch {
      return undefined; // malformed file: fall back to other sources
    }
    if (typeof data !== "object" || data === null) return undefined;
    return data;
  }

  private asProviderMap(data: Record<string, unknown>): Record<string, NamedProviderEntry> | undefined {
    if (typeof data.providers !== "object" || data.providers === null) return undefined;
    const raw = data.providers as Record<string, unknown>;
    const out: Record<string, NamedProviderEntry> = {};
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value === "object" && value !== null) {
        out[name] = value as NamedProviderEntry;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  private activeProviderName(
    data: Record<string, unknown>,
    providers: Record<string, NamedProviderEntry>,
  ): string {
    const names = Object.keys(providers);
    return typeof data.provider === "string" && providers[data.provider] ? data.provider : names[0];
  }

  private readFlatKeys(data: Record<string, unknown>): Partial<HarnyConfig> {
    const out: Partial<HarnyConfig> = {};
    if (typeof data.apiKey === "string") out.apiKey = data.apiKey;
    if (typeof data.provider === "string") out.provider = data.provider as HarnyConfig["provider"];
    if (typeof data.baseUrl === "string") out.baseUrl = data.baseUrl;
    if (typeof data.model === "string") out.model = data.model;
    if (typeof data.maxTokens === "number") out.maxTokens = data.maxTokens;
    if (typeof data.temperature === "number") out.temperature = data.temperature;
    if (typeof data.contextFiles === "boolean") out.contextFiles = data.contextFiles;
    if (typeof data.autoApprove === "boolean") out.autoApprove = data.autoApprove;
    if (typeof data.autoOpen === "boolean") out.autoOpen = data.autoOpen;
    if (typeof data.enableThinking === "boolean") out.enableThinking = data.enableThinking;
    if (isThinkingMode(data.thinkingMode)) out.thinkingMode = data.thinkingMode;
    if (isThinkingLevel(data.thinkingLevel)) out.thinkingLevel = data.thinkingLevel;
    // Legacy `enableThinking` (boolean) drives the provider entry too.
    if (typeof data.enableThinking === "boolean" && !isThinkingMode(data.thinkingMode)) {
      out.thinkingMode = "bool";
      if (!isThinkingLevel(data.thinkingLevel)) {
        out.thinkingLevel = data.enableThinking ? "medium" : "off";
      }
    }
    return out;
  }

  /** Resolve a provider entry's thinking capability (legacy enableThinking → "bool"). */
  private thinkingMode(entry: NamedProviderEntry): ResolvedNamedProvider["thinkingMode"] {
    if (typeof entry.thinking === "string" && isThinkingMode(entry.thinking)) {
      return entry.thinking;
    }
    // enableThinking / a declared thinkingLevel imply explicit thinking control.
    if (typeof entry.enableThinking === "boolean") return "bool";
    if (typeof entry.thinkingLevel === "string") return "bool";
    return undefined;
  }

  /** A provider's default thinking level (from its entry, when declared). */
  private thinkingLevel(entry: NamedProviderEntry): ResolvedNamedProvider["thinkingLevel"] {
    return typeof entry.thinkingLevel === "string" && isThinkingLevel(entry.thinkingLevel)
      ? entry.thinkingLevel
      : typeof entry.enableThinking === "boolean"
        ? entry.enableThinking
          ? "medium"
          : "off"
        : undefined;
  }

  private resolveNamedProvider(
    data: Record<string, unknown>,
    providers: Record<string, NamedProviderEntry>,
  ): Partial<HarnyConfig> | undefined {
    const activeName = this.activeProviderName(data, providers);
    const entry = providers[activeName];
    if (!entry) return undefined;

    const out: Partial<HarnyConfig> = { provider: "openai-compatible" };
    if (typeof entry.baseUrl === "string") out.baseUrl = entry.baseUrl;
    if (typeof entry.apiKey === "string") out.apiKey = entry.apiKey;
    // chat-completions is the only supported protocol (openai-completions).
    if (typeof entry.enableThinking === "boolean") out.enableThinking = entry.enableThinking;
    const mode = this.thinkingMode(entry);
    if (mode) out.thinkingMode = mode;
    const lvl = this.thinkingLevel(entry);
    if (lvl) out.thinkingLevel = lvl;
    if (typeof entry.maxTokens === "number") out.maxTokens = entry.maxTokens;
    // Static extra headers + the per-conversation session header, flattened
    // into the runtime config so the chat provider sends them.
    const hdrs = this.headers(entry);
    if (hdrs) out.extraHeaders = hdrs;
    if (typeof entry.sessionHeader === "string" && entry.sessionHeader.trim()) {
      out.sessionHeader = entry.sessionHeader.trim();
    }

    const modelIds = this.modelIds(entry);
    if (modelIds.length > 0) out.availableModels = modelIds;

    // Keep the declared input modalities per model, so the UI can refuse
    // images for text-only models instead of getting a server-side 500.
    const modalities: Record<string, string[]> = {};
    for (const m of this.rawModels(entry)) {
      if (m.input && m.input.length > 0) modalities[m.id] = m.input;
    }
    if (Object.keys(modalities).length > 0) out.modelModalities = modalities;

    const selected = typeof data.model === "string" && data.model !== "" ? data.model : modelIds[0];
    if (selected) {
      out.model = selected;
    }
    return out;
  }

  private modelIds(entry: NamedProviderEntry): string[] {
    if (!Array.isArray(entry.models)) return [];
    return entry.models
      .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null)
      .map((m) => (typeof m.id === "string" ? m.id : undefined))
      .filter((id): id is string => id !== undefined);
  }

  private rawModels(entry: NamedProviderEntry): { id: string; input?: string[] }[] {
    if (!Array.isArray(entry.models)) return [];
    const out: { id: string; input?: string[] }[] = [];
    for (const m of entry.models) {
      if (typeof m !== "object" || m === null) continue;
      const rec = m as Record<string, unknown>;
      if (typeof rec.id !== "string") continue;
      const input = Array.isArray(rec.input)
        ? rec.input.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase())
        : undefined;
      out.push({ id: rec.id, ...(input !== undefined && input.length > 0 ? { input } : {}) });
    }
    return out;
  }
}