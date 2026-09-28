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
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(
    private http: HttpClient,
    private url = MODELS_DEV_URL,
  ) {}

  /** Context window for a model id, trying the provider candidates in order.
   * Best-effort: returns undefined when unknown or offline. */
  async getContext(modelId: string, providerCandidates: readonly string[]): Promise<number | undefined> {
    await this.ensureLoaded();
    if (!this.data) return undefined;
    for (const pid of providerCandidates) {
      const ctx = this.data[pid]?.models?.[modelId]?.limit?.context;
      if (typeof ctx === "number" && Number.isFinite(ctx) && ctx > 0) return Math.floor(ctx);
    }
    return undefined;
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
          if (res.ok) {
            const body = await res.json();
            if (body && typeof body === "object") {
              this.data = body as Record<string, ModelsDevProvider>;
              this.loadedAt = Date.now();
            }
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        /* offline / parse error: leave the catalog unloaded (no context) */
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }
}
