import { describe, it, expect } from "vitest";
import { formatSize, isImagePath, resolvePath } from "./path-utils";

describe("resolvePath", () => {
  it("returns the cwd for empty input", () => {
    expect(resolvePath(undefined, "/workspace")).toBe("/workspace");
    expect(resolvePath("", "/workspace")).toBe("/workspace");
  });

  it("keeps absolute paths", () => {
    expect(resolvePath("/tmp/a.txt", "/workspace")).toBe("/tmp/a.txt");
  });

  it("resolves relative paths against the cwd", () => {
    expect(resolvePath("src/main.ts", "/workspace")).toBe("/workspace/src/main.ts");
  });
});

describe("isImagePath", () => {
  it("detects common image extensions", () => {
    expect(isImagePath("a.jpg")).toBe(true);
    expect(isImagePath("a.jpeg")).toBe(true);
    expect(isImagePath("a.png")).toBe(true);
    expect(isImagePath("a.gif")).toBe(true);
    expect(isImagePath("a.webp")).toBe(true);
    expect(isImagePath("a.bmp")).toBe(true);
  });

  it("rejects non-image paths", () => {
    expect(isImagePath("a.txt")).toBe(false);
    expect(isImagePath("a.ts")).toBe(false);
  });
});

describe("formatSize", () => {
  it("formats bytes, KB and MB", () => {
    expect(formatSize(512)).toBe("512B");
    expect(formatSize(2048)).toBe("2.0KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0MB");
  });
});
