import { describe, it, expect } from "vitest";
import { langIdForPath } from "./lang-map";

describe("langIdForPath", () => {
  it("maps common code extensions to their Prism language id", () => {
    expect(langIdForPath("a.cs")).toBe("csharp");
    expect(langIdForPath("/deep/path/Program.cs")).toBe("csharp");
    expect(langIdForPath("a.ts")).toBe("typescript");
    expect(langIdForPath("a.tsx")).toBe("typescript");
    expect(langIdForPath("a.js")).toBe("javascript");
    expect(langIdForPath("a.py")).toBe("python");
    expect(langIdForPath("a.rs")).toBe("rust");
    expect(langIdForPath("a.html")).toBe("markup");
    expect(langIdForPath("a.css")).toBe("css");
    expect(langIdForPath("a.json")).toBe("json");
    expect(langIdForPath("a.md")).toBe("markdown");
    expect(langIdForPath("a.sh")).toBe("bash");
    expect(langIdForPath("a.sql")).toBe("sql");
    expect(langIdForPath("a.go")).toBe("go");
  });

  it("is case-insensitive on the extension", () => {
    expect(langIdForPath("a.CS")).toBe("csharp");
    expect(langIdForPath("A.TS")).toBe("typescript");
  });

  it("returns undefined for unknown / extension-less / dotfile paths", () => {
    expect(langIdForPath("a.txt")).toBeUndefined();
    expect(langIdForPath("Makefile")).toBeUndefined();
    expect(langIdForPath(".env")).toBeUndefined();
    expect(langIdForPath("a.")).toBeUndefined();
    expect(langIdForPath("path/without/ext")).toBeUndefined();
  });
});
