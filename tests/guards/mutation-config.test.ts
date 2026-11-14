import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

/**
 * Why `tests/mutation/*.conf.json` all carry `"tsconfigFile": "tests/mutation/no-tsconfig-rewrite.json"`, a
 * path that does not exist — and must not.
 *
 * Stryker's sandbox preprocessor rewrites the `extends`/`references`/`include` paths of the root
 * tsconfig, so a config that points OUTSIDE the sandbox keeps pointing somewhere inside it. It
 * reads that file with the TypeScript compiler API (`ts.parseConfigFileTextToJson`) — and this
 * repo compiles with **TypeScript 7**, the native port, whose JavaScript API is down to two
 * exports: no `parseConfigFileTextToJson`, no `parseJsonConfigFileContent`, nothing. Every
 * `npm run mutate:*` therefore died in `TSConfigPreprocessor` with
 * `TypeError: ts.parseConfigFileTextToJson is not a function`, before a single mutant ran.
 *
 * `tsconfigFile` is read by that preprocessor and by NOTHING else (no type-checking plugin here),
 * and the preprocessor skips silently when the file is not in the sandbox — so pointing it at a
 * name no file has turns the rewrite off. That is safe only while the rewrite is a no-op, which is
 * exactly what this file pins, in three directions:
 *
 * 1. the TypeScript API is STILL missing (if it comes back, delete the workaround, not the test);
 * 2. our tsconfig still has no `extends` / `references` (if it gains one, the skipped rewrite
 *    matters again and the mutation runs would test a sandbox with the wrong paths);
 * 3. every config carries the setting (a new config born without it crashes on its first run).
 */
const ROOT = process.cwd();
const SKIP = "tests/mutation/no-tsconfig-rewrite.json";

/** The two characters JSONC uses before which a comma is decoration, not a separator. */
const CLOSERS = String.raw`[\}\]]`;

const configs = (): string[] =>
  readdirSync(join(ROOT, "tests", "mutation"))
    .filter((f) => f.endsWith(".conf.json"))
    .map((f) => join("tests", "mutation", f));

describe("the mutation runner and the compiler that would break it", () => {
  it("TypeScript still has no config API — the reason the rewrite is pointed away", () => {
    // Loaded exactly like Stryker loads it (a `typescript` import from the repo root).
    const ts = createRequire(import.meta.url)("typescript") as Record<string, unknown>;
    expect(ts.parseConfigFileTextToJson).toBeUndefined();
  });

  it("our tsconfig has nothing to rewrite (`extends` / `references` pointed outside)", () => {
    // tsconfig.json is JSONC (it carries a trailing comma, and TypeScript tolerates comments) —
    // the very latitude of `parseConfigFileTextToJson`. Two lines of cleaning, no parser.
    const raw = readFileSync(join(ROOT, "tsconfig.json"), "utf8").replace(/\/\/[^\n]*/g, "");
    const tsconfig = JSON.parse(raw.replace(new RegExp(`,(\\s*${CLOSERS})`, "g"), "$1")) as Record<string, unknown>;
    expect(tsconfig.extends).toBeUndefined();
    expect(tsconfig.references).toBeUndefined();
  });

  it("every Stryker config disables the rewrite, pointing at a file that must not exist", () => {
    expect(configs().length).toBeGreaterThan(0);
    for (const path of configs()) {
      const conf = JSON.parse(readFileSync(join(ROOT, path), "utf8")) as { tsconfigFile?: string };
      expect(conf.tsconfigFile, `${path} would crash the run on the first sandbox`).toBe(SKIP);
    }
    // The whole trick is that the name resolves to nothing: create that file and the preprocessor
    // finds it in the sandbox and calls the missing API again.
    expect(existsSync(join(ROOT, SKIP))).toBe(false);
  });
});
