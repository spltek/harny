#!/usr/bin/env node
/**
 * The mutation gate that Stryker cannot express: "no NEW survivor".
 *
 * `thresholds.break` compares a PERCENTAGE, and a percentage moves in both directions for reasons
 * that are not regressions: Stryker generates a different number of mutants when the code changes
 * shape, a refactor shifts a line range and swaps what is being mutated, and a fresh test that
 * kills one mutant raises the score while the backlog stays where it was. A floor set half a
 * mutant above the current score (the only value that actually trips on the FIRST loss) is
 * therefore also the value that trips on a change nobody made.
 *
 * This reads the machine-readable report Stryker already writes (`reports/mutation.json`), takes
 * the mutants that were NOT detected (`Survived`, plus `NoCoverage` — a hunk no test reaches is
 * the same kind of hole), and compares them with a committed baseline. The run fails only when a
 * hole appears that the baseline does not already know about, and it names it.
 *
 *   node scripts/mutation-gate.mjs <config>            # check (exit 1 on a new hole)
 *   node scripts/mutation-gate.mjs <config> --update   # accept today's holes into the baseline
 *
 * The identity of a hole is `file + mutatorName + replacement`, never the position: a mutant id
 * and its line numbers change when code moves, and a gate that red-lights a `git mv` gets turned
 * off within a week. The cost is that two identical mutations of the same file collapse into one
 * entry counted twice — if one of them dies the count differs, but if they SWAP (one dies, the
 * other is born) the gate stays quiet. That is the price of stability, and it is smaller than the
 * alternative.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Paths are overridable so the test can drive the script against fixtures (see its test). */
const REPORT = process.env.MUTATION_REPORT ?? join("reports", "mutation.json");
const BASELINE = process.env.MUTATION_BASELINE ?? join("stryker", "survivors-baseline.json");
const CONF_DIR = process.env.MUTATION_CONF_DIR ?? "stryker";

/** Undetected mutants. `Timeout` is deliberately absent: it counts as detected and swings by a
 *  dozen between runs on the same code (a slow machine turns a killed loop into a timeout and
 *  back), so treating it as a hole would make the gate a coin flip. */
const HOLE_STATUSES = new Set(["Survived", "NoCoverage"]);

const [config, ...flags] = process.argv.slice(2);
const update = flags.includes("--update");

function die(message, code = 2) {
  console.error(`mutation-gate: ${message}`);
  process.exit(code);
}

if (!config) die("usage: node scripts/mutation-gate.mjs <config> [--update]");

const confPath = join(CONF_DIR, `${config}.conf.json`);
if (!existsSync(confPath)) die(`no such config: ${confPath}`);

const conf = JSON.parse(readFileSync(confPath, "utf8"));
/** `src/a.ts:10-20` mutates a range but still belongs to `src/a.ts`. */
const confFiles = new Set((conf.mutate ?? []).map((entry) => String(entry).replace(/:\d+-\d+$/, "")));

if (!existsSync(REPORT)) die(`no report at ${REPORT} — run \`npm run mutate:${config}\` first`);
const report = JSON.parse(readFileSync(REPORT, "utf8"));
const reportFiles = Object.keys(report.files ?? {});

/** The report is a single shared file, rewritten by every run: refuse to grade the wrong one. */
const stray = reportFiles.filter((file) => !confFiles.has(file));
if (stray.length) {
  die(
    `the report is not from "${config}" (it also holds ${stray.join(", ")}) — ` +
      `run \`npm run mutate:${config}\` and then this script`,
  );
}

/** Every hole in the report, aggregated by the position-independent identity. */
const holes = new Map();
for (const file of reportFiles) {
  for (const mutant of report.files[file].mutants ?? []) {
    if (!HOLE_STATUSES.has(mutant.status)) continue;
    const key = JSON.stringify([file, mutant.mutatorName, mutant.replacement]);
    const entry = holes.get(key) ?? {
      file,
      mutator: mutant.mutatorName,
      replacement: mutant.replacement,
      count: 0,
      where: [],
    };
    entry.count += 1;
    entry.where.push(`${mutant.location.start.line}:${mutant.location.start.column}`);
    if (mutant.status === "NoCoverage") entry.coverage = true;
    holes.set(key, entry);
  }
}

const survivors = [...holes.entries()]
  .map(([key, entry]) => ({ key, ...entry }))
  .sort((a, b) => a.file.localeCompare(b.file) || a.key.localeCompare(b.key));

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : { configs: {} };
baseline.configs ??= {};

const line = ({ file, mutator, replacement, where, coverage }) =>
  `  ${file}:${where.join(",")}  ${mutator} → ${JSON.stringify(replacement)}${coverage ? "  (no coverage)" : ""}`;

if (update) {
  const mutants = Object.values(report.files).reduce((n, file) => n + (file.mutants ?? []).length, 0);
  baseline.configs[config] = {
    measured: new Date().toISOString().slice(0, 10),
    mutants,
    survivors: survivors.map(({ file, mutator, replacement, count }) => ({ file, mutator, replacement, count })),
  };
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`mutation-gate: baseline updated for "${config}" — ${survivors.length} known hole(s)`);
  process.exit(0);
}

const known = baseline.configs[config];
if (!known) {
  die(`no baseline for "${config}" — run \`node scripts/mutation-gate.mjs ${config} --update\` and commit it`);
}

const knownCount = new Map(known.survivors.map((s) => [JSON.stringify([s.file, s.mutator, s.replacement]), s.count]));
const fresh = survivors.filter((s) => s.count > (knownCount.get(s.key) ?? 0));

if (fresh.length) {
  console.error(`mutation-gate: ${fresh.length} NEW undetected mutant(s) in "${config}":`);
  for (const hole of fresh) console.error(line(hole));
  console.error(
    `\nA new hole is either a missing test or a rule another guard already covers ` +
      `(then re-baseline: node scripts/mutation-gate.mjs ${config} --update).`,
  );
  process.exit(1);
}

console.log(`mutation-gate: "${config}" — ${survivors.length} known hole(s), 0 new`);
