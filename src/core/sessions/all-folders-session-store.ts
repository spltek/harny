import { join } from "node:path";
import type { FileSystem } from "../tools/file-system";
import type { ChatMessage } from "../history/types";
import type { LoadedSession, SessionSettingsPatch, SessionStore, SessionSummary } from "./types";

export interface AllFoldersStoreDeps {
  /** Parent directory holding one bucket dir per workspace (`home/sessions`). */
  bucketsRoot: () => string;
  /** Bucket of the CURRENT workspace root (new sessions land here). */
  currentBucket: () => string;
  /** Absolute path of the current workspace root (persisted as `folder` on create). */
  currentFolder: () => string | undefined;
  fs: FileSystem;
  /** Per-bucket store factory (a plain JsonlSessionStore bound to one dir). */
  bucketStore: (dir: string) => SessionStore;
}

/**
 * Cross-folder view of ALL sessions: lists and loads across every workspace
 * bucket under `home/sessions`, while writes target the bucket where the
 * session's file physically lives. The per-session `folder` (persisted in the
 * JSONL header) is annotated at list time with availability (`folderMissing`);
 * legacy sessions without a folder fall back to the current root when their
 * file lives in the current bucket, otherwise their folder is unknown.
 *
 * Liskov: implements the same `SessionStore` interface as the per-bucket
 * `JsonlSessionStore`, so SessionManager, SessionRegistry and the chat view
 * need no changes for the cross-folder behaviour.
 */
export class AllFoldersSessionStore implements SessionStore {
  constructor(private deps: AllFoldersStoreDeps) {}

  list(): SessionSummary[] {
    const curBucket = this.deps.currentBucket();
    const curFolder = this.deps.currentFolder();
    const out: SessionSummary[] = [];
    for (const bucket of this.deps.fs.list(this.deps.bucketsRoot())) {
      // Only bucket dirs live under the root; ignore stray loose files.
      if (bucket.endsWith(".jsonl")) continue;
      const dir = join(this.deps.bucketsRoot(), bucket);
      for (const summary of this.deps.bucketStore(dir).list()) {
        out.push(this.annotate(summary, dir === curBucket ? curFolder : undefined));
      }
    }
    return out;
  }

  create(name?: string): SessionSummary {
    const dir = this.deps.currentBucket();
    const created = this.deps.bucketStore(dir).create(name);
    // Stamp the folder at creation so the session belongs to the current root
    // from the start (one extra atomic write; create is rare and cheap).
    const folder = this.deps.currentFolder();
    return folder ? this.deps.bucketStore(dir).saveSettings(created.id, { folder }) : created;
  }

  load(id: string): LoadedSession {
    return this.storeFor(id).load(id);
  }

  saveMessages(id: string, messages: ChatMessage[]): SessionSummary {
    return this.storeFor(id).saveMessages(id, messages);
  }

  rename(id: string, name: string): SessionSummary {
    return this.storeFor(id).rename(id, name);
  }

  remove(id: string): boolean {
    return this.storeFor(id).remove(id);
  }

  saveSettings(id: string, patch: SessionSettingsPatch): SessionSummary {
    return this.storeFor(id).saveSettings(id, patch);
  }

  saveModel(id: string, model?: string, provider?: string): SessionSummary {
    return this.storeFor(id).saveModel(id, model, provider);
  }

  saveThinkingLevel(
    id: string,
    level?: import("../config/types").ThinkingLevel,
  ): SessionSummary {
    return this.storeFor(id).saveThinkingLevel(id, level);
  }

  saveContextWindow(id: string, window?: number): SessionSummary {
    return this.storeFor(id).saveContextWindow(id, window);
  }

  saveContextTokens(id: string, tokens?: number): SessionSummary {
    return this.storeFor(id).saveContextTokens(id, tokens);
  }

  saveOutputTokens(id: string, tokens?: number): SessionSummary {
    return this.storeFor(id).saveOutputTokens(id, tokens);
  }

  saveTemperature(id: string, temp?: number): SessionSummary {
    return this.storeFor(id).saveTemperature(id, temp);
  }

  savePresencePenalty(id: string, value?: number): SessionSummary {
    return this.storeFor(id).savePresencePenalty(id, value);
  }

  saveFrequencyPenalty(id: string, value?: number): SessionSummary {
    return this.storeFor(id).saveFrequencyPenalty(id, value);
  }

  saveTopP(id: string, value?: number): SessionSummary {
    return this.storeFor(id).saveTopP(id, value);
  }

  saveSampler(id: string, sampler?: "temperature" | "topP"): SessionSummary {
    return this.storeFor(id).saveSampler(id, sampler);
  }

  /**
   * Annotate a summary for the list UI: the effective folder (persisted one,
   * or the current root when the file lives in the current bucket) and whether
   * that folder is unavailable. Only a folder that is KNOWN gets probed: an
   * unknown folder (legacy session elsewhere) is NOT "missing" — it is simply
   * unset (neutral row, open disabled until a folder is assigned).
   */
  private annotate(summary: SessionSummary, bucketFallback: string | undefined): SessionSummary {
    const folder = summary.folder ?? bucketFallback;
    const folderMissing = !!folder && !this.deps.fs.exists(folder);
    return { ...summary, ...(folder ? { folder } : {}), folderMissing };
  }

  /** Resolve the physical bucket of a session's file; fall back to the current bucket. */
  private storeFor(id: string): SessionStore {
    const root = this.deps.bucketsRoot();
    for (const bucket of this.deps.fs.list(root)) {
      if (bucket.endsWith(".jsonl")) continue;
      if (this.deps.fs.exists(join(root, bucket, `${id}.jsonl`))) {
        return this.deps.bucketStore(join(root, bucket));
      }
    }
    return this.deps.bucketStore(this.deps.currentBucket());
  }
}