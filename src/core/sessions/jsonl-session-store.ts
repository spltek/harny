import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { FileSystem } from "../tools/file-system";
import type { ChatMessage } from "../history/types";
import { isThinkingLevel, type ThinkingLevel } from "../config/types";
import type { LoadedSession, SessionStore, SessionSummary } from "./types";

interface SessionMeta {
  type: "session";
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  modelProvider?: string;
  thinkingLevel?: string;
  contextWindow?: number;
  contextTokens?: number;
  outputTokens?: number;
  temperature?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
}

/**
 * Stores each session as a JSONL file: a `session` header line followed by one
 * JSON object per chat message. The header also keeps the last selected model
 * (per-session). Listing only reads the header of each file.
 */
export class JsonlSessionStore implements SessionStore {
  private readonly idGen: () => string;

  constructor(
    private dir: () => string,
    private fs: FileSystem,
    options: { idGen?: () => string } = {},
  ) {
    this.idGen = options.idGen ?? (() => randomUUID());
  }

  list(): SessionSummary[] {
    const dir = this.dir();
    const out: SessionSummary[] = [];
    for (const entry of this.fs.list(dir)) {
      if (!entry.endsWith(".jsonl")) continue;
      const summary = this.readHeader(join(dir, entry));
      if (summary) out.push(summary);
    }
    return out;
  }

  create(name?: string): SessionSummary {
    const id = this.idGen();
    const now = Date.now();
    const summary: SessionSummary = {
      id,
      name: name?.trim() || "New Session",
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    };
    this.fs.mkdirRecursive(this.dir());
    this.fs.writeText(this.path(id), this.serialize(summary, []));
    return summary;
  }

  /**
   * Base summary for a mutation: the new file identity plus every persisted
   * per-session field carried forward from the previous header. Carrying
   * forward is what keeps model / provider / thinking / context window /
   * output tokens alive across any subsequent save (message, model, rename…).
   */
  private carrySummary(
    id: string,
    existing: SessionSummary | undefined,
    messages: ChatMessage[],
    extra: Partial<SessionSummary> = {},
  ): SessionSummary {
    return {
      id,
      name: existing?.name ?? "New Session",
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      messageCount: messages.length,
      ...(existing?.model ? { model: existing.model } : {}),
      ...(existing?.modelProvider ? { modelProvider: existing.modelProvider } : {}),
      ...(existing?.thinkingLevel ? { thinkingLevel: existing.thinkingLevel } : {}),
      ...(existing?.contextWindow ? { contextWindow: existing.contextWindow } : {}),
      ...(existing?.contextTokens ? { contextTokens: existing.contextTokens } : {}),
      ...(existing?.outputTokens ? { outputTokens: existing.outputTokens } : {}),
      // Temperature/penalties: 0 is a VALID value, so `!== undefined` (not truthiness).
      ...(existing?.temperature !== undefined ? { temperature: existing.temperature } : {}),
      ...(existing?.presencePenalty !== undefined ? { presencePenalty: existing.presencePenalty } : {}),
      ...(existing?.frequencyPenalty !== undefined ? { frequencyPenalty: existing.frequencyPenalty } : {}),
      ...extra,
    };
  }

  saveModel(id: string, model?: string, provider?: string): SessionSummary {
    const existing = this.fs.exists(this.path(id)) ? this.readHeader(this.path(id)) : undefined;
    const messages = this.fs.exists(this.path(id)) ? this.load(id).messages : [];
    const summary = this.carrySummary(id, existing, messages, {
      ...(model ? { model } : {}),
      ...(provider ? { modelProvider: provider } : {}),
    });
    this.fs.mkdirRecursive(this.dir());
    this.fs.writeText(this.path(id), this.serialize(summary, messages));
    return summary;
  }

  saveThinkingLevel(id: string, level?: ThinkingLevel): SessionSummary {
    const existing = this.fs.exists(this.path(id)) ? this.readHeader(this.path(id)) : undefined;
    const messages = this.fs.exists(this.path(id)) ? this.load(id).messages : [];
    const summary = this.carrySummary(id, existing, messages, {
      ...(isThinkingLevel(level) ? { thinkingLevel: level } : {}),
    });
    this.fs.mkdirRecursive(this.dir());
    this.fs.writeText(this.path(id), this.serialize(summary, messages));
    return summary;
  }

  saveContextWindow(id: string, window?: number): SessionSummary {
    const existing = this.fs.exists(this.path(id)) ? this.readHeader(this.path(id)) : undefined;
    const messages = this.fs.exists(this.path(id)) ? this.load(id).messages : [];
    const summary = this.carrySummary(id, existing, messages, {
      ...(typeof window === "number" ? { contextWindow: window } : {}),
    });
    this.fs.mkdirRecursive(this.dir());
    this.fs.writeText(this.path(id), this.serialize(summary, messages));
    return summary;
  }

  saveOutputTokens(id: string, tokens?: number): SessionSummary {
    const existing = this.fs.exists(this.path(id)) ? this.readHeader(this.path(id)) : undefined;
    const messages = this.fs.exists(this.path(id)) ? this.load(id).messages : [];
    const summary = this.carrySummary(id, existing, messages, {
      ...(typeof tokens === "number" ? { outputTokens: tokens } : {}),
    });
    this.fs.mkdirRecursive(this.dir());
    this.fs.writeText(this.path(id), this.serialize(summary, messages));
    return summary;
  }

  /**
   * Persist the session's sampling temperature. `undefined` means "Auto":
   * the stored value is explicitly cleared (JSON.stringify drops undefined
   * keys), overriding any previously carried value.
   */
  saveTemperature(id: string, temp?: number): SessionSummary {
    const existing = this.fs.exists(this.path(id)) ? this.readHeader(this.path(id)) : undefined;
    const messages = this.fs.exists(this.path(id)) ? this.load(id).messages : [];
    const summary = this.carrySummary(id, existing, messages, {
      ...(temp === undefined ? { temperature: undefined } : { temperature: temp }),
    });
    this.fs.mkdirRecursive(this.dir());
    this.fs.writeText(this.path(id), this.serialize(summary, messages));
    return summary;
  }

  /** Presence penalty (Auto/undefined clears the stored value). */
  savePresencePenalty(id: string, value?: number): SessionSummary {
    const existing = this.fs.exists(this.path(id)) ? this.readHeader(this.path(id)) : undefined;
    const messages = this.fs.exists(this.path(id)) ? this.load(id).messages : [];
    const summary = this.carrySummary(id, existing, messages, {
      ...(value === undefined ? { presencePenalty: undefined } : { presencePenalty: value }),
    });
    this.fs.mkdirRecursive(this.dir());
    this.fs.writeText(this.path(id), this.serialize(summary, messages));
    return summary;
  }

  /** Frequency penalty (Auto/undefined clears the stored value). */
  saveFrequencyPenalty(id: string, value?: number): SessionSummary {
    const existing = this.fs.exists(this.path(id)) ? this.readHeader(this.path(id)) : undefined;
    const messages = this.fs.exists(this.path(id)) ? this.load(id).messages : [];
    const summary = this.carrySummary(id, existing, messages, {
      ...(value === undefined ? { frequencyPenalty: undefined } : { frequencyPenalty: value }),
    });
    this.fs.mkdirRecursive(this.dir());
    this.fs.writeText(this.path(id), this.serialize(summary, messages));
    return summary;
  }

  saveContextTokens(id: string, tokens?: number): SessionSummary {
    const existing = this.fs.exists(this.path(id)) ? this.readHeader(this.path(id)) : undefined;
    const messages = this.fs.exists(this.path(id)) ? this.load(id).messages : [];
    const summary = this.carrySummary(id, existing, messages, {
      ...(typeof tokens === "number" ? { contextTokens: tokens } : {}),
    });
    this.fs.mkdirRecursive(this.dir());
    this.fs.writeText(this.path(id), this.serialize(summary, messages));
    return summary;
  }

  load(id: string): LoadedSession {
    const path = this.path(id);
    const lines = this.fs.exists(path) ? this.fs.readText(path).split("\n") : [];
    let summary: SessionSummary | undefined;
    const messages: ChatMessage[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (obj && typeof obj === "object") {
        const rec = obj as Record<string, unknown>;
        if (rec.type === "session") {
          summary = {
            id: String(rec.id ?? id),
            name: String(rec.name ?? "Session"),
            createdAt: Number(rec.createdAt ?? 0),
            updatedAt: Number(rec.updatedAt ?? 0),
            messageCount: 0,
            ...(typeof rec.model === "string" ? { model: rec.model } : {}),
            ...(typeof rec.modelProvider === "string" ? { modelProvider: rec.modelProvider } : {}),
            ...(typeof rec.thinkingLevel === "string" && isThinkingLevel(rec.thinkingLevel)
              ? { thinkingLevel: rec.thinkingLevel }
              : {}),
            ...(typeof rec.contextWindow === "number" ? { contextWindow: rec.contextWindow } : {}),
            ...(typeof rec.contextTokens === "number" ? { contextTokens: rec.contextTokens } : {}),
            ...(typeof rec.outputTokens === "number" ? { outputTokens: rec.outputTokens } : {}),
            ...(typeof rec.temperature === "number" ? { temperature: rec.temperature } : {}),
            ...(typeof rec.presencePenalty === "number" ? { presencePenalty: rec.presencePenalty } : {}),
            ...(typeof rec.frequencyPenalty === "number" ? { frequencyPenalty: rec.frequencyPenalty } : {}),
          };
        } else if (typeof rec.role === "string") {
          messages.push(rec as unknown as ChatMessage);
        }
      }
    }
    if (!summary) {
      summary = { id, name: "Session", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 };
    }
    summary.messageCount = messages.length;
    return { summary, messages };
  }

  saveMessages(id: string, messages: ChatMessage[]): SessionSummary {
    const existing = this.fs.exists(this.path(id)) ? this.readHeader(this.path(id)) : undefined;
    const summary = this.carrySummary(id, existing, messages);
    this.fs.mkdirRecursive(this.dir());
    this.fs.writeText(this.path(id), this.serialize(summary, messages));
    return summary;
  }

  rename(id: string, name: string): SessionSummary {
    const existing = this.fs.exists(this.path(id)) ? this.readHeader(this.path(id)) : undefined;
    const now = Date.now();
    const summary: SessionSummary = {
      id,
      name: name.trim() || "Session",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      messageCount: existing?.messageCount ?? 0,
      ...(existing?.model ? { model: existing.model } : {}),
      ...(existing?.modelProvider ? { modelProvider: existing.modelProvider } : {}),
      ...(existing?.thinkingLevel ? { thinkingLevel: existing.thinkingLevel } : {}),
      ...(existing?.contextWindow ? { contextWindow: existing.contextWindow } : {}),
      ...(existing?.contextTokens ? { contextTokens: existing.contextTokens } : {}),
      ...(existing?.outputTokens ? { outputTokens: existing.outputTokens } : {}),
      ...(existing?.temperature !== undefined ? { temperature: existing.temperature } : {}),
    };
    const messages = this.fs.exists(this.path(id)) ? this.load(id).messages : [];
    this.fs.writeText(this.path(id), this.serialize(summary, messages));
    return summary;
  }

  remove(id: string): boolean {
    const path = this.path(id);
    if (!this.fs.exists(path)) return false;
    this.fs.delete(path);
    return true;
  }

  private path(id: string): string {
    return join(this.dir(), `${id}.jsonl`);
  }

  private readHeader(path: string): SessionSummary | undefined {
    if (!this.fs.exists(path)) return undefined;
    const lines = this.fs.readText(path).split("\n");
    const headerLine = lines.find((l) => l.trim());
    if (!headerLine) return undefined;
    let meta: unknown;
    try {
      meta = JSON.parse(headerLine.trim());
    } catch {
      return undefined;
    }
    if (!meta || typeof meta !== "object") return undefined;
    const rec = meta as Record<string, unknown>;
    if (rec.type !== "session") return undefined;
    const total = lines.filter((l) => l.trim()).length;
    return {
      id: String(rec.id),
      name: String(rec.name ?? "Session"),
      createdAt: Number(rec.createdAt ?? 0),
      updatedAt: Number(rec.updatedAt ?? 0),
      messageCount: Math.max(0, total - 1),
      ...(typeof rec.model === "string" ? { model: rec.model } : {}),
      ...(typeof rec.modelProvider === "string" ? { modelProvider: rec.modelProvider } : {}),
      ...(typeof rec.thinkingLevel === "string" && isThinkingLevel(rec.thinkingLevel)
        ? { thinkingLevel: rec.thinkingLevel }
        : {}),
      ...(typeof rec.contextWindow === "number" ? { contextWindow: rec.contextWindow } : {}),
      ...(typeof rec.contextTokens === "number" ? { contextTokens: rec.contextTokens } : {}),
      ...(typeof rec.outputTokens === "number" ? { outputTokens: rec.outputTokens } : {}),
      ...(typeof rec.temperature === "number" ? { temperature: rec.temperature } : {}),
      ...(typeof rec.presencePenalty === "number" ? { presencePenalty: rec.presencePenalty } : {}),
      ...(typeof rec.frequencyPenalty === "number" ? { frequencyPenalty: rec.frequencyPenalty } : {}),
    };
  }

  private serialize(summary: SessionSummary, messages: ChatMessage[]): string {
    const header: SessionMeta = {
      type: "session",
      id: summary.id,
      name: summary.name,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      ...(summary.model ? { model: summary.model } : {}),
      ...(summary.modelProvider ? { modelProvider: summary.modelProvider } : {}),
      ...(summary.thinkingLevel ? { thinkingLevel: summary.thinkingLevel } : {}),
      ...(summary.contextWindow ? { contextWindow: summary.contextWindow } : {}),
      ...(summary.contextTokens ? { contextTokens: summary.contextTokens } : {}),
      ...(summary.outputTokens ? { outputTokens: summary.outputTokens } : {}),
      ...(summary.temperature !== undefined ? { temperature: summary.temperature } : {}),
      ...(summary.presencePenalty !== undefined ? { presencePenalty: summary.presencePenalty } : {}),
      ...(summary.frequencyPenalty !== undefined ? { frequencyPenalty: summary.frequencyPenalty } : {}),
    };
    const lines = [JSON.stringify(header), ...messages.map((m) => JSON.stringify(m))];
    return lines.join("\n") + "\n";
  }
}