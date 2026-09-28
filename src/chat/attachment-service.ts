import { basename, extname } from "node:path";
import { readFileSync } from "node:fs";
import type { FileSystem } from "../core/tools/file-system";
import { formatSize, isImagePath } from "../core/tools/path-utils";
import type { AttachmentInfo } from "./attachment-types";

const MAX_ATTACHMENT_CHARS = 30000;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

export interface AttachmentContext {
  /** Text context (file contents / image notes) prepended to the user message. */
  text: string;
  /** Data URIs of attached images, sent as multimodal content to the LLM. */
  images: string[];
}

/**
 * Picks files through a dialog and builds the LLM context from them:
 * text files become code blocks, images become data-URI content parts.
 * The dialog function is injected so the service stays testable.
 */
export class AttachmentService {
  constructor(
    private fs: FileSystem,
    private pickDialog: () => Promise<string[] | undefined>,
  ) {}

  async pick(): Promise<AttachmentInfo[]> {
    const paths = await this.pickDialog();
    if (!paths || paths.length === 0) return [];
    return this.fromPaths(paths);
  }

  /** Metadata for known paths (used by the file dialog AND a pasted path/URI).
   * Non-existent paths are dropped. */
  fromPaths(paths: readonly string[]): AttachmentInfo[] {
    return paths
      .map((p) => (typeof p === "string" ? p.trim() : ""))
      .filter((p) => p.length > 0 && this.fs.exists(p))
      .map((path) => {
        const size = this.fs.size(path);
        const isImage = isImagePath(path);
        // Images carry an inline data URI so the webview can preview them
        // (thumbnail + lightbox) without any host round-trip.
        const dataUri = isImage ? this.imageDataUri(path, size) : undefined;
        return { name: basename(path), path, size, isImage, ...(dataUri ? { dataUri } : {}) };
      });
  }

  async buildContext(files: AttachmentInfo[]): Promise<AttachmentContext> {
    const textParts: string[] = [];
    const images: string[] = [];

    for (const f of files) {
      if (f.isImage) {
        const where = f.path ? ` at ${f.path}` : " (pasted from clipboard)";
        const note = `[Image attached: ${f.name} (${formatSize(f.size)})${where}]`;
        // Clipboard images arrive as a data URI (no file on disk); file images
        // are read from their path.
        const dataUri = f.dataUri ?? this.imageDataUri(f.path, f.size);
        if (dataUri) {
          images.push(dataUri);
          textParts.push(note);
        } else {
          textParts.push(`${note} — could not be read or is too large (max 15MB)`);
        }
        continue;
      }
      // Inline text (a pasted text file) OR a real file read from disk.
      let content: string | undefined = f.content;
      if (content === undefined) {
        if (!f.path) {
          textParts.push(
            `[Attached file "${f.name}" (${formatSize(f.size)}) could not be included: its content is not ` +
              "available (binary file or unsupported over the chat protocol)]",
          );
          continue;
        }
        try {
          content = this.fs.readText(f.path);
        } catch {
          textParts.push(`[Could not read file: ${f.name}]`);
          continue;
        }
      }
      if (content.length > MAX_ATTACHMENT_CHARS) {
        content = content.slice(0, MAX_ATTACHMENT_CHARS) + "\n\n[Content truncated...]";
      }
      textParts.push(`Attached file "${f.name}":\n\`\`\`\n${content}\n\`\`\``);
    }

    return { text: textParts.join("\n\n"), images };
  }

  private imageDataUri(path: string, size: number): string | undefined {
    if (size <= 0 || size > MAX_IMAGE_BYTES) return undefined;
    try {
      const mime = MIME_BY_EXT[extname(path).toLowerCase()] ?? "image/png";
      const base64 = readFileSync(path).toString("base64");
      return `data:${mime};base64,${base64}`;
    } catch {
      return undefined;
    }
  }
}
