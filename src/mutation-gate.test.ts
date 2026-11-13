import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `scripts/mutation-gate.mjs` is the real gate on NEW survivors — the thing `thresholds.break`
 * cannot express, because a percentage moves for reasons that are not regressions (a different
 * mutant count, a shifted line range) and a 0,05 margin is worth one mutant.
 *
 * It is driven end-to-end, as a process, exactly as `npm run mutate:<config>` calls it: the
 * script runs on plain Node with no build step, so importing it as a module would test a
 * different thing. Every path it reads is overridable by env, which is what lets the fixtures
 * live in a temporary directory instead of the real report.
 */
const SCRIPT = join(process.cwd(), "scripts", "mutation-gate.mjs");

type Status = "Killed" | "Survived" | "NoCoverage" | "Timeout";

/** One mutant of a Stryker report: only the fields the gate reads. */
const mutant = (mutatorName: string, replacement: string, status: Status, line = 1) => ({
  id: String(line),
  mutatorName,
  replacement,
  status,
  location: { start: { line, column: 0 }, end: { line, column: 1 } },
});

type Mutant = ReturnType<typeof mutant>;

let dir = "";
const run = (args: string[]): { code: number; out: string } => {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: dir,
      env: {
        ...process.env,
        MUTATION_REPORT: join(dir, "report.json"),
        MUTATION_BASELINE: join(dir, "baseline.json"),
        MUTATION_CONF_DIR: join(dir, "conf"),
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
};

/** Rewrite the fixtures: the config under test, the report Stryker would have written, a baseline. */
const fixture = (opts: { files?: string[]; report?: Record<string, Mutant[]>; baseline?: unknown }) => {
  const files = opts.files ?? ["src/a.ts"];
  mkdirSync(join(dir, "conf"), { recursive: true });
  writeFileSync(join(dir, "conf", "demo.conf.json"), JSON.stringify({ mutate: files }));
  const report = { files: {} as Record<string, { mutants: Mutant[] }> };
  for (const [file, mutants] of Object.entries(opts.report ?? {})) report.files[file] = { mutants };
  writeFileSync(join(dir, "report.json"), JSON.stringify(report));
  if (opts.baseline === undefined) rmSync(join(dir, "baseline.json"), { force: true });
  else writeFileSync(join(dir, "baseline.json"), JSON.stringify(opts.baseline));
};

const baselineOf = (survivors: { file: string; mutator: string; replacement: string; count: number }[]) => ({
  configs: { demo: { mutants: 0, survivors } },
});

describe("mutation gate (no NEW survivor)", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mutation-gate-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("--update records today's holes, and the check right after passes with zero new ones", () => {
    fixture({
      report: {
        "src/a.ts": [
          mutant("ConditionalExpression", "false", "Survived", 10),
          mutant("EqualityOperator", ">=", "Killed", 11),
          mutant("BlockStatement", "{}", "NoCoverage", 12),
        ],
      },
    });

    expect(run(["demo", "--update"]).code).toBe(0);
    const baseline = JSON.parse(readFileSync(join(dir, "baseline.json"), "utf8")) as {
      configs: { demo: { mutants: number; survivors: { replacement: string; count: number }[] } };
    };
    expect(baseline.configs.demo.mutants).toBe(3);
    expect(baseline.configs.demo.survivors.map((s) => s.replacement).sort()).toEqual(["false", "{}"]);

    const check = run(["demo"]);
    expect(check.code).toBe(0);
    expect(check.out).toContain("2 known hole(s), 0 new");
  });

  it("fails, and NAMES the mutant, when a hole the baseline does not know appears", () => {
    fixture({
      report: {
        "src/a.ts": [
          mutant("ConditionalExpression", "false", "Survived", 10),
          mutant("ArithmeticOperator", "+", "Survived", 42),
        ],
      },
      baseline: baselineOf([{ file: "src/a.ts", mutator: "ConditionalExpression", replacement: "false", count: 1 }]),
    });

    const res = run(["demo"]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("1 NEW undetected mutant(s)");
    expect(res.out).toContain("src/a.ts:42:0"); // where to look, not just that something broke
    expect(res.out).toContain('"+"');
  });

  it("catches a hole that migrates from timeout to survivor (the score would not move at all)", () => {
    // A timeout counts as detected: the same mutant turning into a survivor leaves the
    // percentage untouched in runs where the loop merely got slower. Only this gate sees it.
    fixture({
      report: { "src/a.ts": [mutant("ConditionalExpression", "false", "Survived", 10)] },
      baseline: baselineOf([]),
    });
    expect(run(["demo"]).code).toBe(1);
  });

  it("does NOT count a Timeout as a hole (it swings by a dozen between runs on the same code)", () => {
    fixture({
      report: {
        "src/a.ts": [
          mutant("ConditionalExpression", "false", "Survived", 10),
          mutant("UpdateOperator", "--", "Timeout", 11),
        ],
      },
      baseline: baselineOf([{ file: "src/a.ts", mutator: "ConditionalExpression", replacement: "false", count: 1 }]),
    });
    expect(run(["demo"]).code).toBe(0);
  });

  it("stays quiet when code MOVES: the identity is the mutation, not the line number", () => {
    fixture({
      report: { "src/a.ts": [mutant("ConditionalExpression", "false", "Survived", 900)] },
      baseline: baselineOf([{ file: "src/a.ts", mutator: "ConditionalExpression", replacement: "false", count: 1 }]),
    });
    expect(run(["demo"]).code).toBe(0);
  });

  it("counts duplicates: killing one of two identical holes is progress the gate can see", () => {
    const twice = [
      mutant("ConditionalExpression", "false", "Survived", 10),
      mutant("ConditionalExpression", "false", "Survived", 20),
    ];
    fixture({
      report: { "src/a.ts": twice },
      baseline: baselineOf([{ file: "src/a.ts", mutator: "ConditionalExpression", replacement: "false", count: 2 }]),
    });
    expect(run(["demo"]).code).toBe(0);

    fixture({
      report: { "src/a.ts": [twice[0]] },
      baseline: baselineOf([{ file: "src/a.ts", mutator: "ConditionalExpression", replacement: "false", count: 2 }]),
    });
    // One hole left where the baseline knows two: fewer is fine.
    expect(run(["demo"]).code).toBe(0);

    fixture({
      report: { "src/a.ts": twice },
      baseline: baselineOf([{ file: "src/a.ts", mutator: "ConditionalExpression", replacement: "false", count: 1 }]),
    });
    expect(run(["demo"]).code).toBe(1); // one MORE than known
  });

  it("refuses to grade a report left over from another config", () => {
    // Reports/mutation.json is a single file every run rewrites: grading the wrong one would
    // compare a survivor list against the wrong baseline and pass on nothing.
    fixture({
      files: ["src/a.ts"],
      report: { "src/a.ts": [], "src/other.ts": [] },
      baseline: baselineOf([]),
    });
    const res = run(["demo"]);
    expect(res.code).toBe(2);
    expect(res.out).toContain('is not from "demo"');
    expect(res.out).toContain("src/other.ts");
  });

  it("accepts a ranged config (`file:start-end`) but not a stray file", () => {
    fixture({
      files: ["src/a.ts:10-20"],
      report: { "src/a.ts": [] },
      baseline: baselineOf([]),
    });
    expect(run(["demo"]).code).toBe(0);
  });

  it("says how to create a missing baseline instead of failing as if there were a regression", () => {
    fixture({ report: { "src/a.ts": [] } });
    const res = run(["demo"]);
    expect(res.code).toBe(2); // not 1: nothing regressed, the gate is simply not armed yet
    expect(res.out).toContain("--update");
  });

  it("refuses an unknown config name, and a missing report", () => {
    fixture({ report: { "src/a.ts": [] } });
    expect(run(["nope"]).code).toBe(2);
    rmSync(join(dir, "report.json"));
    expect(run(["demo"]).code).toBe(2);
  });
});
