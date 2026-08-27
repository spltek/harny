import { describe, it, expect } from "vitest";
import { formatSize, isImagePath, pathSafetyError, resolvePath } from "./path-utils";

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

describe("pathSafetyError", () => {
  const root = "/workspace";
  it("allows paths inside the root (and the root itself)", () => {
    expect(pathSafetyError("/workspace", root)).toBeUndefined();
    expect(pathSafetyError("/workspace/src/a.ts", root)).toBeUndefined();
    // ".." that is normalized back INSIDE the root is fine
    expect(pathSafetyError("/workspace/sub/../a.ts", root)).toBeUndefined();
  });
  it("rejects traversal outside the root with a teaching message", () => {
    const err = pathSafetyError("/etc/passwd", root);
    expect(err).toContain("falls outside the workspace root /workspace");
    expect(err).toContain("Refusing to operate outside the sandbox");
    const parent = pathSafetyError("/workspace/../other", root);
    expect(parent).toContain("falls outside");
  });
  it("rejects a sibling path at the same level", () => {
    expect(pathSafetyError("/workspace-x/a", root)).toContain("falls outside");
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
