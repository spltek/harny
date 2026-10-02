import { describe, it, expect } from "vitest";
import { defaultShell, isAbsoluteAnyPlatform } from "./platform";

describe("isAbsoluteAnyPlatform", () => {
  it("recognises POSIX, drive-letter and UNC absolute paths", () => {
    for (const p of ["/etc/x", "/", "C:\\x", "C:/x", "C:", "\\\\server\\share\\a.ts"]) {
      expect(isAbsoluteAnyPlatform(p), p).toBe(true);
    }
  });

  it("treats relative paths as relative", () => {
    for (const p of ["src/x.ts", "./x", "..\\x", "foo/bar", "", "1:/x", "AB:/x"]) {
      expect(isAbsoluteAnyPlatform(p), p).toBe(false);
    }
  });

  it("recognises a bare drive and a trailing separator", () => {
    expect(isAbsoluteAnyPlatform("C:")).toBe(true);
    expect(isAbsoluteAnyPlatform("C:\\")).toBe(true);
    expect(isAbsoluteAnyPlatform("z:/x")).toBe(true);
  });
});

describe("defaultShell", () => {
  it("returns a non-empty shell on the current platform (never a bare /bin/bash on Windows)", () => {
    const shell = defaultShell();
    expect(shell.length).toBeGreaterThan(0);
    if (process.platform === "win32") expect(shell.toLowerCase()).not.toContain("bash");
  });
});
