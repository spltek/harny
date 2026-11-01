import { join } from "node:path";
import type { FileSystem } from "../tools/file-system";
import { preprocessJsonc, setTopLevelString } from "./jsonc";
import type { PartialConfigProvider } from "./partial-config-provider";
import { isThinkingLevel, isThinkingMode } from "./types";
import type {
  HarnyConfig,
  McpServerCommon,
  McpServerConfig,
  ProviderCatalog,
  ProviderEditorData,
  ProviderEditorEntry,
  ProviderExport,
  ResolvedNamedProvider,
} from "./types";

/** Validate + normalise a raw `mcpServers` object into the typed shape. */
function normalizeMcpServers(raw: unknown): Record<string, McpServerConfig> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, McpServerConfig> = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const rec = v as Record<string, unknown>;
    const enabled = typeof rec.enabled === "boolean" ? { enabled: rec.enabled } : {};
    // The DECLARATIONS travel with the server, not with its transport. They used to be
    // dropped here — `analyze` was documented and then lost on every read AND every
    // save — so an Analyze policy set in the file could never take effect.
    const analyzeRaw = rec.analyze;
    // Written out as literals (not a cast): this is the only place the file is trusted
    // with an enum, so the value must be one of the two WHOLE strings or nothing.
    const analyzeValue = analyzeRaw === "read-only" ? "read-only" : analyzeRaw === "trusted" ? "trusted" : undefined;
    const excludeTools = normalizeStringList(rec.excludeTools);
    // Same normalization, opposite meaning: an INCLUDE list of tools the user declares read-only
    // for Analyze (default-deny, so a tool the server adds tomorrow is not silently allowed).
    const analyzeTools = normalizeStringList(rec.analyzeTools);
    // Annotated, not inferred: an object literal widens its string properties, so the
    // declaration would arrive as `string` and not as the two allowed values.
    const common: Pick<McpServerCommon, "enabled" | "analyze" | "excludeTools" | "analyzeTools"> = {
      ...enabled,
      ...(analyzeValue ? { analyze: analyzeValue } : {}),
      ...(excludeTools ? { excludeTools } : {}),
      ...(analyzeTools ? { analyzeTools } : {}),
    };
    if (typeof rec.command === "string" && rec.command.trim()) {
      const args = Array.isArray(rec.args) ? rec.args.filter((a): a is string => typeof a === "string") : undefined;
      const env = normalizeStringMap(rec.env);
      out[name] = {
        command: rec.command.trim(),
        ...(args && args.length > 0 ? { args } : {}),
        ...(env ? { env } : {}),
        ...common,
      };
    } else if (typeof rec.url === "string" && rec.url.trim()) {
      const headers = normalizeStringMap(rec.headers);
      out[name] = { url: rec.url.trim(), ...(headers ? { headers } : {}), ...common };
    }
  }
  return out;
}

/** A list of non-empty, de-duplicated strings (tool names). Undefined when empty, so
 * "nothing excluded" stays absent in the file instead of `[]` on every server. */
function normalizeStringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== "string") continue;
    const t = item.trim();
    if (t) seen.add(t);
  }
  return seen.size > 0 ? [...seen] : undefined;
}

function normalizeStringMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** True for a positive integer (a valid concurrency cap / count). */
function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/** Validate + normalize an exported providers payload (accepts the config
 * shape AND the editor shape — only `providers` is required). */
function parseProviderExport(
  raw: unknown,
): { providers: Record<string, unknown>; provider?: string; maxParallelSubAgents?: number } | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const provRaw = obj.providers;
  if (!provRaw || typeof provRaw !== "object" || Array.isArray(provRaw)) return undefined;
  const providers: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(provRaw as Record<string, unknown>)) {
    if (!name.trim() || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    providers[name] = entry;
  }
  if (Object.keys(providers).length === 0) return undefined;
  const provider = typeof obj.provider === "string" && obj.provider.trim() ? obj.provider : undefined;
  const maxParallelSubAgents = isPositiveInt(obj.maxParallelSubAgents) ? obj.maxParallelSubAgents : undefined;
  return { providers, provider, maxParallelSubAgents };
}

interface NamedProviderEntry {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: unknown[];
  enableThinking?: boolean;
  /** "bool" (llama.cpp kwargs) | "effort" (reasoning_effort) | "type" (thinking.type) | "reasoning" (OpenRouter reasoning object) | "unspecified" */
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
      const path = this.fs.exists(join(base, "config.json")) ? join(base, "config.json") : join(base, "config.jsonc");
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
      sessionHeader:
        typeof entry.sessionHeader === "string" && entry.sessionHeader.trim() ? entry.sessionHeader.trim() : undefined,
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
        // Everything the form does not manage is carried through verbatim
        // (models, enableThinking, unknown keys) so a save never drops it.
        const extra = editorExtras(entry as unknown as Record<string, unknown>);
        if (extra) out.extra = extra;
        providers[name] = out;
      }
    }
    return {
      activeProvider: data ? this.activeProviderName(data, map ?? {}) : undefined,
      providers,
      ...(data && isPositiveInt(data.maxParallelSubAgents) ? { maxParallelSubAgents: data.maxParallelSubAgents } : {}),
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

      // The map as it is on DISK, before this save replaces it: the only way to tell a rename
      // (one name out, one name in) from a delete or a merge. See `renameTarget`.
      const previousProviders = this.asProviderMap(parsed) ?? {};
      const providers: Record<string, Record<string, unknown>> = {};
      for (const [name, entry] of Object.entries(data.providers)) {
        // Start from the keys the editor does NOT manage (models, unknown
        // fields) so a save is lossless, then overlay the managed ones.
        const p: Record<string, unknown> = { api: "openai-completions", ...(entry.extra ?? {}) };
        setOrDelete(p, "baseUrl", entry.baseUrl);
        setOrDelete(p, "apiKey", entry.apiKey);
        setOrDelete(
          p,
          "sessionHeader",
          entry.sessionHeader && entry.sessionHeader.trim() ? entry.sessionHeader.trim() : undefined,
        );
        if (entry.thinking && isThinkingMode(entry.thinking)) {
          p.thinking = entry.thinking;
          setOrDelete(p, "thinkingLevel", entry.thinkingLevel);
        } else {
          // Explicitly cleared: drop the modern key, the per-provider default
          // level AND the legacy flag, or the latter two would keep the
          // provider reasoning-capable (a lone `thinkingLevel` implies bool).
          delete p.thinking;
          delete p.enableThinking;
          delete p.thinkingLevel;
        }
        setOrDelete(p, "maxTokens", typeof entry.maxTokens === "number" ? entry.maxTokens : undefined);
        setOrDelete(p, "headers", entry.headers && Object.keys(entry.headers).length > 0 ? entry.headers : undefined);
        providers[name] = p;
      }
      parsed.providers = providers;
      setOrDelete(
        parsed,
        "maxParallelSubAgents",
        isPositiveInt(data.maxParallelSubAgents) ? data.maxParallelSubAgents : undefined,
      );
      if (data.activeProvider === undefined) {
        // No change requested for the active provider.
      } else if (providers[data.activeProvider]) {
        parsed.provider = data.activeProvider;
      } else {
        // The requested active name is NOT in the map being written. The editor renames by
        // rewriting a key and can leave the active name behind: keeping it here is what made the
        // NEXT request dial another server, because `activeProviderName` falls back to the FIRST
        // entry of the map (renaming the OpenRouter provider sent its models to
        // `ECONNREFUSED 127.0.0.1:8090`, the local llama server listed first).
        const target = renameTarget(previousProviders, providers, data.activeProvider);
        if (target) parsed.provider = target;
        else if (typeof parsed.provider === "string" && !providers[parsed.provider]) {
          // Nothing to point at: drop the key rather than keep a name that resolves to nothing.
          // `activeProviderName` then falls back on purpose, and the file stops lying.
          delete parsed.provider;
        }
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

  /**
   * Raw providers section (exactly the config-file shape: baseUrl, apiKey,
   * api, models, thinking, …) for EXPORT. Lossless and portable.
   */
  exportProviders(): ProviderExport {
    const data = this.parseFile() ?? {};
    const map = (this.asProviderMap(data) ?? {}) as Record<string, unknown>;
    return {
      providers: map,
      ...(typeof data.provider === "string" && data.provider.trim() ? { provider: data.provider } : {}),
      ...(isPositiveInt(data.maxParallelSubAgents) ? { maxParallelSubAgents: data.maxParallelSubAgents } : {}),
    };
  }

  /**
   * Merge (default) or replace the providers section from an exported file,
   * preserving every other config key. Returns false on an invalid payload or
   * a write failure.
   */
  importProviders(raw: unknown, mode: "merge" | "replace" = "merge"): boolean {
    const incoming = parseProviderExport(raw);
    if (!incoming) return false;
    try {
      const base = this.dir();
      if (!base) return false;
      const jsonPath = join(base, "config.json");
      const jsoncPath = join(base, "config.jsonc");
      const jsonExists = this.fs.exists(jsonPath);
      const jsoncExists = this.fs.exists(jsoncPath);
      const path = jsonExists ? jsonPath : jsoncExists ? jsoncPath : jsonPath;
      const data: Record<string, unknown> = jsonExists || jsoncExists ? (this.parseFile() ?? {}) : {};
      const current = (this.asProviderMap(data) ?? {}) as Record<string, unknown>;
      const providers = mode === "merge" ? { ...current, ...incoming.providers } : incoming.providers;
      data.providers = providers;
      if (incoming.provider && providers[incoming.provider]) data.provider = incoming.provider;
      if (isPositiveInt(incoming.maxParallelSubAgents)) data.maxParallelSubAgents = incoming.maxParallelSubAgents;
      this.fs.mkdirRecursive(base);
      this.fs.writeText(path, JSON.stringify(data, null, 2) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  /** MCP servers section from the config file (validated). */
  readMcpServers(): Record<string, McpServerConfig> {
    const data = this.parseFile();
    return data ? normalizeMcpServers(data.mcpServers) : {};
  }

  /** Replace the MCP servers section, preserving every other config key. */
  saveMcpServers(servers: Record<string, McpServerConfig>): boolean {
    try {
      const base = this.dir();
      if (!base) return false;
      const jsonPath = join(base, "config.json");
      const jsoncPath = join(base, "config.jsonc");
      const jsonExists = this.fs.exists(jsonPath);
      const jsoncExists = this.fs.exists(jsoncPath);
      const path = jsonExists ? jsonPath : jsoncExists ? jsoncPath : jsonPath;
      const parsed: Record<string, unknown> = jsonExists || jsoncExists ? (this.parseFile() ?? {}) : {};
      const clean = normalizeMcpServers(servers);
      if (Object.keys(clean).length > 0) parsed.mcpServers = clean;
      else delete parsed.mcpServers;
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
    const path = this.fs.exists(join(base, "config.json")) ? join(base, "config.json") : join(base, "config.jsonc");
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

  private activeProviderName(data: Record<string, unknown>, providers: Record<string, NamedProviderEntry>): string {
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
    if (typeof data.autoOpen === "boolean") out.autoOpen = data.autoOpen;
    if (typeof data.enableThinking === "boolean") out.enableThinking = data.enableThinking;
    if (isThinkingMode(data.thinkingMode)) out.thinkingMode = data.thinkingMode;
    if (isPositiveInt(data.maxParallelSubAgents)) out.maxParallelSubAgents = data.maxParallelSubAgents;
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

/** Provider keys the gear editor manages explicitly (everything else is `extra`). */
const EDITOR_MANAGED_KEYS = new Set([
  "api",
  "baseUrl",
  "apiKey",
  "thinking",
  "thinkingLevel",
  "maxTokens",
  "headers",
  "sessionHeader",
  "enableThinking",
]);

/**
 * The subset of a raw provider entry that the editor does NOT manage. Kept so
 * `saveProvidersEditor` can put it back untouched (models, unknown fields).
 * Returns undefined when there is nothing to preserve.
 */
function editorExtras(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!EDITOR_MANAGED_KEYS.has(key)) extra[key] = value;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

/** `obj[key] = value`, or delete the key when the value is empty/undefined. */
function setOrDelete(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined || value === null || value === "") delete obj[key];
  else obj[key] = value;
}

/**
 * The name the active provider was RENAMED to, when the payload proves it: `wasActive` exists on
 * disk, is gone from the map being written, and EXACTLY one key disappeared while EXACTLY one
 * appeared. Anything else — a delete, a merge, several names moving at once — returns undefined:
 * guessing there would point the config at an entry the user never chose, which is the very
 * failure this guards (`activeProviderName` silently falling back to the first provider).
 */
function renameTarget(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  wasActive: string,
): string | undefined {
  if (!(wasActive in previous)) return undefined;
  const gone = Object.keys(previous).filter((name) => !(name in next));
  const added = Object.keys(next).filter((name) => !(name in previous));
  if (gone.length !== 1 || added.length !== 1 || gone[0] !== wasActive) return undefined;
  return added[0];
}
