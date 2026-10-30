import { describe, it, expect } from "vitest";
import { sameFolder } from "./folder-path";

/**
 * Path equality, which two very different decisions hang on: whether a row OPENS a folder
 * (a window reload) or asks for one, and whether a gesture stored before a reload belongs
 * to the workspace that has just loaded. Both sides get the same answer from this.
 */

describe("sameFolder", () => {
  it("ignores trailing separators and the platform's separator style", () => {
    expect(sameFolder("/p/harny", "/p/harny/")).toBe(true);
    expect(sameFolder("/p/harny/", "/p/harny")).toBe(true);
    expect(sameFolder("C:\\Users\\Me\\A", "C:/Users/Me/A")).toBe(true);
    expect(sameFolder("/p/harny", "/p/harny2")).toBe(false);
  });

  it("compares Windows drive paths case-insensitively, POSIX paths by case", () => {
    // Windows filesystems are case-insensitive; a Linux one is not, so two genuinely
    // distinct folders must never collapse into one.
    expect(sameFolder("C:\\Users\\Me\\A", "c:\\users\\me\\a")).toBe(true);
    expect(sameFolder("/p/Harny", "/p/harny")).toBe(false);
  });

  it("is false when either side is missing (an unset pointer matches nothing)", () => {
    expect(sameFolder(undefined, "/p/a")).toBe(false);
    expect(sameFolder("/p/a", undefined)).toBe(false);
    expect(sameFolder("", "")).toBe(false);
  });
});
