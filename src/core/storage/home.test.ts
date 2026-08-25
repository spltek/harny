import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHome, sessionsDirFor, SESSIONS_DIR_NAME, HARNY_HOME_ENV } from "./home";

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

describe("sessionsDirFor (per-folder storage)", () => {
  it("points sessions INTO the workspace root as a hidden folder", () => {
    expect(sessionsDirFor("/Users/test/MyProject")).toBe(join("/Users/test/MyProject", SESSIONS_DIR_NAME));
  });

  it("returns undefined when there is no single workspace root", () => {
    expect(sessionsDirFor(undefined)).toBeUndefined();
    expect(sessionsDirFor("   ")).toBeUndefined();
  });
});