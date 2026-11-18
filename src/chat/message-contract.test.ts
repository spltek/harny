import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE MESSAGE CONTRACT between the panel and the host.
 *
 * `onMessage` dispatches a string `type` through a `switch` with no `default`: an unhandled type is
 * DROPPED IN SILENCE. Nothing links the two sides at compile time — a `type` is just a string on a
 * structural `any` — so a test can send a misspelled one and still pass, because "no tab was opened"
 * is trivially true when no handler ran. That is not hypothetical: the new-session test sent
 * `{ type: "createNew" }`, no case matched, and it stayed green while asserting nothing.
 *
 * Both directions are pinned here:
 *   · every type a TEST sends must be handled (a typo can no longer hide behind a passing test);
 *   · every type the host handles must be driven by a test, or be one of the known gaps below
 *     (knowingly untested is a decision; unknowingly untested is how a dispatcher rots).
 */

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), "utf8");

/**
 * The `type` labels of the host's dispatcher. Anchored on the indentation prettier gives a `case`
 * directly inside the method's `switch` (6 spaces) and stopped at the switch's closing brace, so the
 * set stays EXACT: over-collecting labels from anywhere else in the file would let a bogus type
 * through, which is the one thing this test exists to prevent.
 */
function handledTypes(): string[] {
  const lines = read("src/chat/chat-view.ts").split("\n");
  const start = lines.findIndex((line) => line.includes("switch (msg.type)"));
  if (start < 0) throw new Error("no `switch (msg.type)` in chat-view.ts: the dispatcher moved");
  const types: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {4}\}$/.test(lines[i])) break; // the switch closes at the method's indent
    const label = /^ {6}case "([^"]+)":/.exec(lines[i]);
    if (label) types.push(label[1]);
  }
  return types;
}

/** Every test file in the tree. */
function testFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...testFiles(path));
    else if (entry.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

/** Types a TEST posts into the host, with the file that sends each (the first one, for reporting).
 *  `handler({` is the seam the chat suite drives; a new inbound seam must be added here, or the
 *  contract silently covers less than it claims. */
function sentTypes(): Map<string, string> {
  const sent = new Map<string, string>();
  for (const file of testFiles(join(root, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/handler\(\s*\{\s*type:\s*"([^"]+)"/g)) {
      if (!sent.has(m[1])) sent.set(m[1], relative(root, file));
    }
  }
  return sent;
}

/** Handlers no test drives today. An entry here is a decision, not a rubber stamp: the assertion
 *  below fails if one gets a test (the list went stale) or disappears (the handler moved away). */
const KNOWN_GAPS = [
  "dragDebug", // diagnostics only (logging), nothing to assert
];

describe("webview → host message contract", () => {
  const handled = new Set(handledTypes());
  const sent = sentTypes();

  it("parses both sides (a guard that reads nothing proves nothing)", () => {
    expect(handled.size).toBeGreaterThan(40);
    expect(sent.size).toBeGreaterThan(40);
  });

  it("no test sends a type the host does not handle", () => {
    const orphans = [...sent]
      .filter(([type]) => !handled.has(type))
      .map(([type, file]) => `${type} — sent from ${file}`);
    expect(orphans).toEqual([]);
  });

  it("every handled type is driven by a test, or is a known gap", () => {
    const undriven = [...handled].filter((type) => !sent.has(type) && !KNOWN_GAPS.includes(type));
    expect(undriven).toEqual([]);
    // Stale entries: a known gap that is now driven, or that no longer exists.
    const stale = KNOWN_GAPS.filter((type) => sent.has(type) || !handled.has(type));
    expect(stale).toEqual([]);
  });
});
