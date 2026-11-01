import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";

/**
 * The SAME contracts as `skill-roots.test.ts`, with `join` swapped for `path.win32.join` in this
 * file's module graph.
 *
 * Why the file exists: `defaultSkillRoots` builds every path with `join`, so on Windows the
 * strings it returns carry backslashes (`\home\u\.agents\skills`). The "an untrusted folder
 * contributes NO roots" contract was pinned with a POSIX LITERAL — `!r.startsWith("/home/u")` —
 * which is true on macOS and Ubuntu for the wrong reason (nothing starts with that string) and
 * false on Windows for the right one (every root does). It was written and run on macOS, went red
 * only on the Windows runner, and the branch shipped red for twelve commits because the two
 * POSIX runners kept saying green. A contract about machinery that is platform-dependent is not
 * tested by the platform the author happens to sit on: this file makes the Windows SHAPE an input
 * on every OS, so the next assertion written in the wrong dialect fails locally, today.
 */
vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  // Only `join` is platform-bound in this graph — `sep`/`delimiter` are not read by the module
  // under test, and the source's own `join` calls are the whole surface being asserted.
  return { ...actual, join: actual.win32.join };
});

import { defaultSkillRoots } from "./skill-roots";

describe("defaultSkillRoots under Windows path semantics", () => {
  it("the win32 mock is really in force (otherwise the file would test nothing)", () => {
    expect(join("/home/u", ".agents", "skills")).toBe("\\home\\u\\.agents\\skills");
    expect(defaultSkillRoots("/w", "/home/u")[0]).toBe("\\w\\.agents\\skills");
  });

  it("lists PROJECT roots first, then USER roots (project shadows user)", () => {
    const roots = defaultSkillRoots("/w", "/home/u");
    expect(roots.indexOf(join("/w", ".agents", "skills"))).toBeLessThan(
      roots.indexOf(join("/home/u", ".agents", "skills")),
    );
  });

  it("with NO cwd (Restricted Mode) returns ONLY the user roots — a repo's skills are workspace content", () => {
    const roots = defaultSkillRoots(undefined, "/home/u");
    expect(roots).not.toContain(join("/w", ".agents", "skills"));
    // The prefix is built with the SAME `join` the implementation uses — never a literal.
    expect(roots.filter((r) => !r.startsWith(join("/home/u")))).toEqual([]);
    expect(roots).toContain(join("/home/u", ".agents", "skills"));
  });
});
