import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the WIRING between the suite and the artifacts that leave this repo.
 *
 * The bug this file exists to prevent already shipped twice: `release.yml` ran `npm test` on
 * `ubuntu-24.04` alone and then published a `.vsix` to the GitHub Release, the Marketplace and
 * Open VSX — so `v0.9.5` and `v0.9.6` were both tagged while `windows-latest` had been red for
 * twelve commits, and nothing anywhere could say so. The suite cannot test a YAML file's EFFECT,
 * but it can test the three things whose absence has no other symptom: that the gate exists, that
 * every shipping workflow DEPENDS on it, and that nobody spells a second, narrower gate of their
 * own. A workflow is the one file in the tree whose mistakes are silent until they are
 * irreversible — publishing cannot be taken back — which is why it gets a test like the manifest.
 */
const ROOT = process.cwd();
const WORKFLOWS = join(ROOT, ".github", "workflows");
const GATE_FILE = "test-matrix.yml";
const GATE = `./.github/workflows/${GATE_FILE}`;

type Job = { name: string; needs: string[]; uses?: string; body: string };

/**
 * A deliberately small reader: the only structure this test needs is "top-level `jobs:` → job
 * names → their `needs:`/`uses:` lines". A real YAML parser would be a phantom dependency (no
 * `yaml` in `package.json`) for four fields, and a test that silently parses NOTHING is the
 * failure mode this whole file is about — so every workflow is also asserted to have produced
 * the jobs its own text names (see `it`s below).
 */
function parseJobs(source: string): Job[] {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return [];
  const jobs: Job[] = [];
  let current: Job | undefined;
  for (const line of lines.slice(start + 1)) {
    // A new top-level key (`permissions:`, `env:` …) ends the block; two-indented keys are jobs.
    if (/^\S/.test(line) && !line.startsWith("#")) break;
    const head = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (head) {
      current = { name: head[1], needs: [], body: "" };
      jobs.push(current);
      continue;
    }
    if (!current) continue;
    current.body += `${line}\n`;
    const needs = /^ {4}needs:\s*(.+?)\s*$/.exec(line);
    if (needs) {
      current.needs = needs[1]
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
    }
    const uses = /^ {4}uses:\s*(\S+)\s*$/.exec(line);
    if (uses) current.uses = uses[1];
  }
  return jobs;
}

const read = (file: string) => readFileSync(join(WORKFLOWS, file), "utf8");
const workflowFiles = () =>
  readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith(".yml"))
    .sort();

/** Does `job` depend, directly or through another job, on the shared gate? */
function reachesGate(job: Job, jobs: Job[]): boolean {
  const byName = new Map(jobs.map((j) => [j.name, j]));
  const seen = new Set<string>();
  const stack = [...job.needs];
  while (stack.length) {
    const name = stack.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const next = byName.get(name);
    if (!next) continue;
    if (next.uses === GATE) return true;
    stack.push(...next.needs);
  }
  return false;
}

describe("the workflows that ship an artifact", () => {
  it("has ONE definition of the suite, and it runs on every OS the .vsix installs on", () => {
    const gate = read(GATE_FILE);
    expect(gate).toContain("workflow_call:");
    for (const os of ["ubuntu-24.04", "macos-latest", "windows-latest"]) {
      expect(gate, `${GATE_FILE} must run on ${os}`).toContain(os);
    }
    // Every OS must REPORT: with `fail-fast: true` a red Windows leg is cancelled by a red Ubuntu
    // one, which is how "one green runner" gets mistaken for a green tree.
    expect(gate).toContain("fail-fast: false");
    expect(parseJobs(gate).map((j) => j.name)).toEqual(["test"]);
  });

  it("is DEPENDED on by every job that publishes, uploads or ships", () => {
    const SHIP = /\b(?:vsce publish|ovsx(?:@\S+)? publish|gh release |upload-artifact)\b/;
    const shippers: string[] = [];
    for (const file of workflowFiles()) {
      if (file === GATE_FILE) continue;
      const jobs = parseJobs(read(file));
      expect(jobs.length, `${file} parsed to zero jobs`).toBeGreaterThan(0);
      for (const job of jobs.filter((j) => SHIP.test(j.body))) {
        shippers.push(`${file}:${job.name}`);
        expect(
          reachesGate(job, jobs),
          `${file} job '${job.name}' ships an artifact but does not depend on ${GATE} — a release must never publish code the other OSes have not blessed`,
        ).toBe(true);
      }
    }
    // If the marker stops matching, the loop above passes over nothing and proves nothing.
    expect(shippers.sort()).toEqual(
      expect.arrayContaining(["ci.yml:package", "release.yml:release"]) as unknown as string[],
    );
  });

  it("is the ONLY place the suite runs — a second, narrower gate is the bug", () => {
    for (const file of workflowFiles()) {
      if (file === GATE_FILE) continue;
      const source = read(file);
      expect(source, `${file} runs the suite itself instead of calling ${GATE}`).not.toMatch(
        /^\s*-?\s*(?:run:\s*)?npm (?:run )?(?:test|typecheck)\b/m,
      );
      expect(source, `${file} declares its own OS matrix`).not.toContain("matrix:");
    }
  });

  it("asks the gate for the SAME ref the release job packages", () => {
    // A hand-run release carries the tag as an INPUT while the triggering ref is `main`: without
    // this the gate would bless `main` and the release job would then package the tag — one green
    // tick over two different trees, which is the same class of lie as a one-OS gate.
    const jobs = parseJobs(read("release.yml"));
    const verify = jobs.find((j) => j.name === "verify");
    const release = jobs.find((j) => j.name === "release");
    expect(verify, "release.yml has no 'verify' gate job").toBeDefined();
    expect(release, "release.yml has no 'release' job").toBeDefined();
    const refOf = (job: Job) => /^ +ref:\s*(\S.*)$/m.exec(job.body)?.[1].trim();
    expect(refOf(verify!), "the gate is not told which ref to test").toBeDefined();
    expect(refOf(verify!)).toBe(refOf(release!));
  });

  it("keeps `main`'s vsix gated too: the dev artifact is not built from untested code", () => {
    const jobs = parseJobs(read("ci.yml"));
    const pkg = jobs.find((j) => j.name === "package");
    expect(pkg, "ci.yml has no 'package' job").toBeDefined();
    expect(reachesGate(pkg!, jobs)).toBe(true);
  });
});
