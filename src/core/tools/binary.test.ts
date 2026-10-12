import { describe, expect, it } from "vitest";
import { detectBinary, describeBinary, isBinaryText } from "./binary";

const buf = (...bytes: number[]): Buffer => Buffer.from(bytes);
const ascii = (s: string): Buffer => Buffer.from(s, "latin1");

describe("detectBinary — magic bytes (content, not extension)", () => {
  it("recognizes common binary formats by signature", () => {
    expect(detectBinary(ascii("%PDF-1.7\n..."))).toEqual({ binary: true, format: "PDF" });
    expect(detectBinary(buf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00))).toEqual({
      binary: true,
      format: "PNG",
    });
    expect(detectBinary(buf(0xff, 0xd8, 0xff, 0xe0))).toEqual({ binary: true, format: "JPEG" });
    expect(detectBinary(ascii("GIF89a..."))).toEqual({ binary: true, format: "GIF" });
    expect(detectBinary(buf(0x1f, 0x8b, 0x08))).toEqual({ binary: true, format: "GZIP" });
    expect(detectBinary(buf(0x7f, 0x45, 0x4c, 0x46, 0x02))).toEqual({ binary: true, format: "ELF" });
    expect(detectBinary(buf(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))).toEqual({
      binary: true,
      format: "OLE2",
    });
    expect(detectBinary(ascii("SQLite format 3\u0000rest"))).toEqual({ binary: true, format: "SQLITE" });
  });

  it("detects TAR from its offset-257 signature", () => {
    const head = Buffer.alloc(512);
    head.write("ustar", 257, "latin1");
    expect(detectBinary(head)).toEqual({ binary: true, format: "TAR" });
  });

  it("detects WEBP (RIFF container)", () => {
    const head = Buffer.concat([ascii("RIFF"), buf(0, 0, 0, 0), ascii("WEBP"), buf(0, 0, 0, 0)]);
    expect(detectBinary(head)).toEqual({ binary: true, format: "WEBP" });
  });

  it("reports a generic container as ZIP (no extension guessing)", () => {
    const zip = buf(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00);
    expect(detectBinary(zip)).toEqual({ binary: true, format: "ZIP" });
  });
});

describe("detectBinary — text/binary heuristic (no signature)", () => {
  it("treats plain UTF-8 and Latin-1 text as TEXT", () => {
    expect(detectBinary(ascii("hello world\nsecond line"))).toEqual({ binary: false });
    // Latin-1 bytes (>= 0x80) are text, not binary.
    expect(detectBinary(ascii("café déjà vu — “quoted”"))).toEqual({ binary: false });
  });

  it("flags a NUL byte as binary (no known format)", () => {
    expect(detectBinary(ascii("abc\u0000\u0001\u0002def"))).toEqual({ binary: true });
  });

  it("flags a control-character-heavy sample as binary", () => {
    const noisy = Buffer.alloc(100, 0x01); // 100 × SOH control chars
    expect(detectBinary(noisy)).toEqual({ binary: true });
  });

  it("treats empty and whitespace as text", () => {
    expect(detectBinary(Buffer.alloc(0))).toEqual({ binary: false });
    expect(detectBinary(ascii("   \n\t"))).toEqual({ binary: false });
  });
});

describe("describeBinary", () => {
  it("returns the content format, or a generic label", () => {
    expect(describeBinary({ binary: true, format: "ZIP" })).toBe("ZIP");
    expect(describeBinary({ binary: true, format: "PDF" })).toBe("PDF");
    expect(describeBinary({ binary: true })).toBe("Binary");
  });
});

describe("isBinaryText (decoded-string fallback)", () => {
  it("detects NUL and a high replacement-character ratio", () => {
    expect(isBinaryText("abc\u0000def")).toBe(true);
    expect(isBinaryText("a\uFFFD".repeat(100))).toBe(true);
    expect(isBinaryText("just normal text\nwith lines")).toBe(false);
  });
});
