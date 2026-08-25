import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHome, sanitizeWorkspaceKey, HARNY_HOME_ENV } from "./home";

describe("sanitizeWorkspaceKey", () => {
  it("replaces slashes with dashes and wraps in double dashes", () => {
    expect(sanitizeWorkspaceKey("/Users/silvio/Projects/App")).toBe("--Users-silvio-Projects-App--");
  });

  it("falls back to a global bucket for empty or blank input", () => {
    expect(sanitizeWorkspaceKey("")).toBe("--global--");
    expect(sanitizeWorkspaceKey("  ")).toBe("--global--");
  });

  it("strips leading/trailing slashes", () => {
    expect(sanitizeWorkspaceKey("/tmp/")).toBe("--tmp--");
  });
});

describe("resolveHome", () => {
  let globalStorage: string;

  afterEach(() => {
    rmSync(globalStorage, { recursive: true, force: true });
  });

  it("defaults to the VS Code globalStorage folder (per-platform path)", () => {
    globalStorage = mkdtempSync(join(tmpdir(), "harny-global-"));
    const workspace = "/Users/test/MyProject";
    const { home, sessionsDir } = resolveHome({
      globalStorageFsPath: globalStorage,
      workspaceCwd: workspace,
      env: {},
    });

    expect(home).toBe(globalStorage);
    expect(sessionsDir).toBe(join(globalStorage, "sessions", "--Users-test-MyProject--"));
  });

  it("honours the HARNY_HOME env override", () => {
    globalStorage = mkdtempSync(join(tmpdir(), "harny-global-"));
    const override = mkdtempSync(join(tmpdir(), "harny-override-"));
    const { home } = resolveHome({
      globalStorageFsPath: globalStorage,
      workspaceCwd: "/x",
      env: { [HARNY_HOME_ENV]: override },
    });

    expect(home).toBe(override);
    rmSync(override, { recursive: true, force: true });
  });

  it("uses the global sessions bucket when no workspace is open", () => {
    globalStorage = mkdtempSync(join(tmpdir(), "harny-global-"));
    const { sessionsDir } = resolveHome({ globalStorageFsPath: globalStorage, env: {} });

    expect(sessionsDir).toBe(join(globalStorage, "sessions", "--global--"));
  });
});