/**
 * Binary-content detection for the tools that present file TEXT (Read, Grep)
 * and for the attachment builder.
 *
 * Two layers, neither of which trusts the file EXTENSION:
 *  1. MAGIC BYTES — the content fingerprint (PDF, ZIP, OLE2, images, …), which
 *     also tells the caller WHAT the file is, best-effort;
 *  2. a byte HEURISTIC (NUL / control-character ratio) for everything without
 *     a known signature.
 * There is deliberately NO extension list: a generic container (e.g. ZIP) is
 * reported as such, and the MODEL combines it with the file name and its own
 * knowledge (a `.docx` is a ZIP, a `.dwg` is Autodesk, …) to decide how to
 * read/modify it. Enumerating subtypes here would always be partial.
 */

const SAMPLE_CHARS = 8000;

/**
 * Legacy helper for callers that ALREADY decoded a file to a UTF-8 string: a
 * decoded binary surfaces as NUL (\u0000) or U+FFFD replacement characters.
 * New code should prefer {@link detectBinary} on raw bytes.
 */
export function isBinaryText(text: string): boolean {
  const sample = text.slice(0, SAMPLE_CHARS);
  if (sample.includes("\u0000")) return true;
  const bad = sample.match(/\uFFFD/g)?.length ?? 0;
  if (sample.length > 0 && bad / sample.length > 0.02) return true;
  return false;
}

export interface BinaryInfo {
  /** True when the content must not be shown/inlined as text. */
  binary: boolean;
  /** Content-based format when recognized (e.g. "PDF", "PNG", "ZIP", "OLE2").
   * A generic container stays generic (ZIP, not "DOCX"): the model knows the
   * mapping from the file name. */
  format?: string;
}

/** Content signatures. Kept to >= 2 distinctive bytes so plain text cannot
 * match by accident (ambiguous 2-letter signatures like `BM`/`MZ` are omitted:
 * the byte heuristic still flags their real files as binary). */
const MAGIC: readonly { format: string; bytes: readonly number[]; offset?: number }[] = [
  { format: "PDF", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { format: "PNG", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { format: "JPEG", bytes: [0xff, 0xd8, 0xff] },
  { format: "GIF", bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  { format: "ZIP", bytes: [0x50, 0x4b, 0x03, 0x04] }, // local file
  { format: "ZIP", bytes: [0x50, 0x4b, 0x05, 0x06] }, // empty archive
  { format: "ZIP", bytes: [0x50, 0x4b, 0x07, 0x08] }, // spanned
  { format: "GZIP", bytes: [0x1f, 0x8b] },
  { format: "BZIP2", bytes: [0x42, 0x5a, 0x68] }, // BZh
  { format: "XZ", bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  { format: "7Z", bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { format: "RAR", bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] },
  { format: "ZSTD", bytes: [0x28, 0xb5, 0x2f, 0xfd] },
  { format: "OLE2", bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] }, // legacy .doc/.xls/.ppt
  { format: "ELF", bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { format: "MACHO", bytes: [0xfe, 0xed, 0xfa, 0xce] },
  { format: "MACHO", bytes: [0xfe, 0xed, 0xfa, 0xcf] },
  { format: "MACHO", bytes: [0xce, 0xfa, 0xed, 0xfe] },
  { format: "MACHO", bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { format: "WASM", bytes: [0x00, 0x61, 0x73, 0x6d] },
  { format: "SQLITE", bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00] },
  { format: "TAR", bytes: [0x75, 0x73, 0x74, 0x61, 0x72], offset: 257 }, // "ustar"
];

function matches(head: Buffer, bytes: readonly number[], offset: number): boolean {
  return head.length >= offset + bytes.length && bytes.every((b, i) => head[offset + i] === b);
}

/** Byte heuristic for content WITHOUT a known signature: NUL is decisive, a
 * high ratio of control characters is not text. UTF-8 multibyte and Latin-1
 * bytes (>= 0x80) are treated as TEXT, so non-ASCII text is not misclassified. */
function looksBinary(bytes: Buffer): boolean {
  if (bytes.length === 0) return false;
  let control = 0;
  for (const b of bytes) {
    if (b === 0) return true;
    if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d) || b === 0x7f) control++;
  }
  return control / bytes.length > 0.3;
}

/**
 * Detect whether the first bytes of a file are BINARY and, when possible, WHAT
 * the file is (content-based only). A generic container is reported as such
 * (ZIP), never guessed from the extension.
 */
export function detectBinary(head: Buffer): BinaryInfo {
  for (const m of MAGIC) {
    if (!matches(head, m.bytes, m.offset ?? 0)) continue;
    return { binary: true, format: m.format };
  }
  // WEBP is a RIFF container: "RIFF" at 0 and "WEBP" at 8.
  if (head.length >= 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") {
    return { binary: true, format: "WEBP" };
  }
  if (looksBinary(head)) return { binary: true };
  return { binary: false };
}

/** Human label for a detection result: "PDF", "ZIP", "Binary". */
export function describeBinary(info: BinaryInfo): string {
  return info.format ?? "Binary";
}
