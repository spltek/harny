import type { HttpClient } from "./http-client";

/**
 * Fallback context-window catalog backed by models.dev (the open database that
 * OpenCode / Zen / many hosts use). Some OpenAI-compatible `/v1/models`
 * endpoints do NOT report the context window at all (e.g. OpenCode Go returns
 * only `id/object/created/owned_by`); models.dev has it under
 * `<provider>.models.<id>.limit.context`.
 *
 * Loaded LAZILY (only when a host model has no context of its own) and cached
 * for a long TTL, so the ~5 MB catalog is fetched at most a couple of times a
 * day — never on every panel paint.
 */
const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_TIMEOUT_MS = 15_000;
const MODELS_DEV_TTL_MS = 12 * 60 * 60 * 1000;

interface ModelsDevModel {
  limit?: { context?: number; output?: number };
}
interface ModelsDevProvider {
  models?: Record<string, ModelsDevModel>;
}

/** Positive integer or undefined. */
function posInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

/** Provider ids to try, most specific first: the config entry name, then a
 * host-derived guess (e.g. opencode.ai → opencode-go / opencode). */
export function modelsDevProviderCandidates(providerName: string, baseUrl?: string): string[] {
  const out: string[] = [];
  const push = (v: string): void => {
    const t = v.trim().toLowerCase();
    if (t && !out.includes(t)) out.push(t);
  };
  push(providerName);
  const host = (() => {
    try {
      return new URL(baseUrl ?? "").host.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (host.includes("opencode.ai")) {
    push("opencode-go");
    push("opencode");
  }
  return out;
}

export class ModelsDevCatalog {
  private data: Record<string, ModelsDevProvider> | null = null;
  /** Exact model id → every catalog entry that declares it. Built lazily for
   * the GENERIC cross-provider fallback (see {@link getLimits}). */
  private byModelId: Map<string, { provider: string; limit: { context?: number; output?: number } }[]> | null = null;
  private loadedAt = 0;
  private loading: Promise<void> | null = null;
  /** Message from the LAST failed load (undefined = the catalog is reachable). */
  private lastError: string | undefined;

  /**
   * False when the last load FAILED (network/abort/parse): lets the UI warn
   * that the fallback catalog is unreachable, as opposed to a model simply not
   * being listed in it.
   */
  isReachable(): boolean {
    return this.lastError === undefined;
  }

  constructor(
    private http: HttpClient,
    private url = MODELS_DEV_URL,
  ) {}

  /**
   * Context window AND max output for a model id. Best-effort: `{}` when
   * unknown or offline.
   *
   * Resolution order:
   *  1. the provider CANDIDATES (config provider name + host guesses) —
   *     authoritative;
   *  2. a GENERIC fallback: the SAME model id anywhere in the catalog, no
   *     provider/family list. This bridges a host whose naming differs from
   *     models.dev (e.g. a host exposing `deepseek-flash` under a provider
   *     models.dev calls `opencode-go`). Among matches it prefers the provider
   *     whose NAME appears in the id (`deepseek-flash` → `deepseek`).
   */
  async getLimits(
    modelId: string,
    providerCandidates: readonly string[],
  ): Promise<{ context?: number; output?: number }> {
    await this.ensureLoaded();
    if (!this.data) return {};
    // 1) the configured/derived providers first (authoritative).
    for (const pid of providerCandidates) {
      const limit = this.limitOf(this.data[pid]?.models?.[modelId] ?? this.data[pid]?.models?.[modelId.toLowerCase()]);
      if (limit) return limit;
    }
    // 2) generic fallback: the same id under ANY provider.
    if (!this.byModelId) this.indexCatalog();
    const matches = this.byModelId?.get(modelId) ?? this.byModelId?.get(modelId.toLowerCase());
    if (matches && matches.length > 0) {
      const lower = modelId.toLowerCase();
      const preferred = matches.find((m) => lower.includes(m.provider)) ?? matches[0];
      return { ...preferred.limit };
    }
    return {};
  }

  /** Context window for a model id (convenience over {@link getLimits}). */
  async getContext(modelId: string, providerCandidates: readonly string[]): Promise<number | undefined> {
    return (await this.getLimits(modelId, providerCandidates)).context;
  }

  /** Normalize one catalog model entry into a limit, or undefined when empty. */
  private limitOf(model: ModelsDevModel | undefined): { context?: number; output?: number } | undefined {
    const context = posInt(model?.limit?.context);
    const output = posInt(model?.limit?.output);
    if (!context && !output) return undefined;
    return { ...(context ? { context } : {}), ...(output ? { output } : {}) };
  }

  /** Build the `id → matches` index used by the generic cross-provider
   * fallback. One pass over the catalog, done lazily on first use. */
  private indexCatalog(): void {
    const index = new Map<string, { provider: string; limit: { context?: number; output?: number } }[]>();
    for (const [provider, prov] of Object.entries(this.data ?? {})) {
      for (const [id, model] of Object.entries(prov?.models ?? {})) {
        const limit = this.limitOf(model);
        if (!limit) continue;
        const list = index.get(id) ?? [];
        list.push({ provider, limit });
        index.set(id, list);
      }
    }
    this.byModelId = index;
  }

  private ensureLoaded(): Promise<void> {
    if (this.data && Date.now() - this.loadedAt < MODELS_DEV_TTL_MS) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), MODELS_DEV_TIMEOUT_MS);
        try {
          const res = await this.http.get(this.url, {}, controller.signal);
          if (!res.ok) {
            this.lastError = `HTTP ${res.status}`;
          } else {
            const body = await res.json();
            if (body && typeof body === "object") {
              this.data = body as Record<string, ModelsDevProvider>;
              this.byModelId = null; // rebuilt lazily against the fresh data
              this.loadedAt = Date.now();
              this.lastError = undefined;
            } else {
              this.lastError = "invalid catalog payload";
            }
          }
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        // Network/abort/parse error: keep any cached data but record that the
        // fallback is currently UNREACHABLE (the UI can warn about it).
        this.lastError = e instanceof Error ? e.message : String(e);
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }
}
