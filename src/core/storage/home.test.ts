import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNY_HOME_ENV, resolveHome, sanitizeWorkspaceKey, sessionsDirFor } from "./home";

describe("resolveHome (config home only)", () => {
  let globalStorage: string;

  afterEach(() => {
    if (globalStorage) rmSync(globalStorage, { recursive: true, force: true });
  });

  it("defaults to the VS Code globalStorage folder", () => {
    globalStorage = mkdtempSync(join(tmpdir(), "harny-global-"));
    const { home } = resolveHome({ globalStorageFsPath: globalStorage, env: {} });
    expect(home).toBe(globalStorage);
  });

  it("honours the HARNY_HOME env override", () => {
    globalStorage = mkdtempSync(join(tmpdir(), "harny-global-"));
    const override = mkdtempSync(join(tmpdir(), "harny-override-"));
    const { home } = resolveHome({ globalStorageFsPath: globalStorage, env: { [HARNY_HOME_ENV]: override } });
    expect(home).toBe(override);
    rmSync(override, { recursive: true, force: true });
  });
});

describe("sanitizeWorkspaceKey", () => {
  it("turns a path into a safe pi-style key", () => {
    expect(sanitizeWorkspaceKey("/Users/test/MyProject")).toBe("--Users-test-MyProject--");
    expect(sanitizeWorkspaceKey("/")).toBe("--global--");
    expect(sanitizeWorkspaceKey("  ")).toBe("--global--");
  });
});

describe("sessionsDirFor (central storage)", () => {
  it("points sessions into the central home bucket per workspace (pi/Cursor style)", () => {
    expect(sessionsDirFor("/Users/test/MyProject", "/home")).toBe(join("/home", "sessions", "--Users-test-MyProject--"));
  });

  it("uses the --global-- bucket when there is no single workspace root", () => {
    expect(sessionsDirFor(undefined, "/home")).toBe(join("/home", "sessions", "--global--"));
  });
});