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
    return paths.map((path) => ({
      name: basename(path),
      path,
      size: this.fs.exists(path) ? this.fs.size(path) : 0,
      isImage: isImagePath(path),
    }));
  }

  async buildContext(files: AttachmentInfo[]): Promise<AttachmentContext> {
    const textParts: string[] = [];
    const images: string[] = [];

    for (const f of files) {
      if (f.isImage) {
        const note = `[Image attached: ${f.name} (${formatSize(f.size)}) at ${f.path}]`;
        const dataUri = this.imageDataUri(f.path, f.size);
        if (dataUri) {
          images.push(dataUri);
          textParts.push(note);
        } else {
          textParts.push(`${note} — could not be read or is too large (max 15MB)`);
        }
        continue;
      }
      let content: string;
      try {
        content = this.fs.readText(f.path);
      } catch {
        textParts.push(`[Could not read file: ${f.name}]`);
        continue;
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
