import { describe, it, expect } from "vitest";
import {
  LoopGuard,
  callSignature,
  stableArgs,
  trigramDuplication,
  tokenize,
  isRepetitiveThinking,
  thinkingSimilarity,
  resolveLoopGuardOptions,
  normalizeLoopGuardSensitivity,
  isLoopGuardSensitivity,
  loopGuardPresets,
  clampLoopGuardOverrides,
  LOOP_GUARD_FIELD_RANGES,
  DEFAULT_LOOP_GUARD_OPTIONS,
  type ToolOutcome,
} from "./loop-guard";
import type { ToolCall } from "../tools/tool";

function toolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: "c", name, arguments: args };
}

function outcome(name: string, args: Record<string, unknown>, isError: boolean, content = "ok"): ToolOutcome {
  return { name, args, isError, content };
}

describe("stableArgs / callSignature", () => {
  it("is key-order independent", () => {
    expect(stableArgs({ b: 1, a: 2 })).toBe(stableArgs({ a: 2, b: 1 }));
    expect(callSignature("Read", { b: 1, a: 2 })).toBe(callSignature("Read", { a: 2, b: 1 }));
  });

  it("distinguishes different values and different tools", () => {
    expect(callSignature("Read", { path: "a" })).not.toBe(callSignature("Read", { path: "b" }));
    expect(callSignature("Read", { path: "a" })).not.toBe(callSignature("Write", { path: "a" }));
  });

  it("serialises every JSON shape the arguments can hold", () => {
    expect(stableArgs(undefined)).toBe("undefined");
    expect(stableArgs(null)).toBe("null");
    expect(stableArgs(3)).toBe("3");
    expect(stableArgs("x")).toBe('"x"');
    expect(stableArgs([1, "a"])).toBe('[1,"a"]');
    expect(stableArgs({ b: null, a: [1] })).toBe('{"a":[1],"b":null}');
  });

  it("never lets two DIFFERENT argument sets collide", () => {
    // Distinctness is the whole contract: a collision would refuse a legitimate call
    // as a "repeat". The delimiters are what keeps a nested value from flattening.
    expect(stableArgs([])).not.toBe(stableArgs({}));
    expect(stableArgs(["a,b"])).not.toBe(stableArgs(["a", "b"]));
    expect(stableArgs({ a: "b" })).not.toBe(stableArgs({ a: "b", c: "" }));
    expect(stableArgs({ a: [1] })).not.toBe(stableArgs({ a: "[1]" }));
  });
});

describe("reasoning repetition detection", () => {
  it("flags a degenerate reasoning loop", () => {
    const paragraph =
      "Let me check if there is a problem with the CSS or if the controls need to be fixed. " +
      "Actually, looking at the HTML, I can see that the controls are being rendered correctly. " +
      "The issue might be that the user needs to refresh the page or there is a CSS issue. ";
    const repeated = paragraph.repeat(4);
    expect(trigramDuplication(repeated)).toBeGreaterThan(0.5);
    expect(isRepetitiveThinking(repeated)).toBe(true);
  });

  it("does not flag normal, varied reasoning", () => {
    const normal =
      "I need to read the config file to understand the provider setup. Then I will locate the tool registry " +
      "and check how tools are registered. After that I should run the tests to confirm nothing broke, and " +
      "inspect the failing assertion before editing the source module. The next step is to open it.";
    expect(isRepetitiveThinking(normal)).toBe(false);
  });

  it("ignores short texts even when repetitive", () => {
    expect(isRepetitiveThinking("a a a a a a a a a a")).toBe(false);
  });

  it("thinkingSimilarity is ~1 for identical text and low for unrelated text", () => {
    const a = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
    expect(thinkingSimilarity(a, a)).toBeCloseTo(1, 5);
    expect(thinkingSimilarity(a, "one two three four five six seven eight nine ten")).toBe(0);
  });

  it("tokenize folds case and splits on punctuation", () => {
    // Folding is what makes similarity and duplication case-blind: "The" and "the"
    // must be the SAME token, otherwise normal prose reads as repetition.
    expect(tokenize("HELLO World, again!")).toEqual(["hello", "world", "again"]);
  });

  it("trigramDuplication counts TRIGRAMS, not tokens", () => {
    // 5 tokens → exactly 3 trigrams, all distinct → 0. Counting the wrong number
    // would still "work" on long texts and lie on short ones.
    expect(trigramDuplication("a b c d e")).toBe(0);
    expect(trigramDuplication("a b c a b c")).toBeCloseTo(0.25, 5); // 4 trigrams, 3 distinct
  });

  it("the threshold is INCLUSIVE, and a clean text never trips it", () => {
    // "a b c a b c" duplicates exactly 0.25: at the threshold it must already flag.
    // (minTokens 0 removes the length floor so only the comparison decides.)
    expect(trigramDuplication("a b c a b c")).toBeCloseTo(0.25, 5);
    expect(isRepetitiveThinking("a b c a b c", 0.25, 0)).toBe(true);
    expect(isRepetitiveThinking("a b c a b c", 0.26, 0)).toBe(false);
    // Zero duplication is below any positive threshold.
    expect(isRepetitiveThinking("a b c d e", 0.5, 0)).toBe(false);
  });
});

describe("LoopGuard tool deduplication", () => {
  it("reuses a cached read-only result for an identical call", () => {
    const g = new LoopGuard();
    const tc = toolCall("Read", { path: "a.ts" });
    expect(g.beforeToolCall(tc, true).mode).toBe("run");
    g.afterToolCall(tc, false, "CONTENT", true);

    const second = g.beforeToolCall(tc, true);
    expect(second.mode).toBe("reuse");
    if (second.mode === "reuse") expect(second.content).toContain("CONTENT");
  });

  it("refuses to re-run an identical failing call (and reports the previous error)", () => {
    const g = new LoopGuard();
    const tc = toolCall("Read", { path: "nope" });
    expect(g.beforeToolCall(tc, true).mode).toBe("run");
    g.afterToolCall(tc, true, "ENOENT: no such file", true);

    const second = g.beforeToolCall(tc, true);
    expect(second.mode).toBe("refuse");
    if (second.mode === "refuse") expect(second.content).toContain("ENOENT");
  });

  it("does NOT cache side-effecting tools and clears the read cache after one", () => {
    const g = new LoopGuard();
    const read = toolCall("Read", { path: "a.ts" });
    g.beforeToolCall(read, true);
    g.afterToolCall(read, false, "v1", true);

    const write = toolCall("Write", { path: "a.ts" });
    g.beforeToolCall(write, false);
    g.afterToolCall(write, false, "wrote", false);

    // A side-effect may have changed the file → the identical read runs again.
    expect(g.beforeToolCall(read, true).mode).toBe("run");
  });

  it("refuses a second identical read-only call that is still in flight", () => {
    const g = new LoopGuard();
    const tc = toolCall("Read", { path: "a.ts" });
    expect(g.beforeToolCall(tc, true).mode).toBe("run");
    expect(g.beforeToolCall(tc, true).mode).toBe("refuse");
  });

  it("clears a failed signature after a side-effect (a write may fix it)", () => {
    const g = new LoopGuard();
    const read = toolCall("Read", { path: "a.ts" });
    g.beforeToolCall(read, true);
    g.afterToolCall(read, true, "ENOENT", true);
    expect(g.beforeToolCall(read, true).mode).toBe("refuse");

    const write = toolCall("Write", { path: "a.ts" });
    g.beforeToolCall(write, false);
    g.afterToolCall(write, false, "wrote", false);

    expect(g.beforeToolCall(read, true).mode).toBe("run");
  });
});

describe("LoopGuard turn classification + escalation", () => {
  const empty = { content: "", thinking: "", toolCalls: [], toolResults: [] };

  it("escalates empty turns: react, react, stop", () => {
    const g = new LoopGuard();
    expect(g.observeTurn(empty).kind).toBe("react");
    expect(g.observeTurn(empty).kind).toBe("react");
    const stop = g.observeTurn(empty);
    expect(stop.kind).toBe("stop");
    if (stop.kind === "stop") expect(stop.type).toBe("empty");
  });

  it("escalates a repeated successful tool call", () => {
    const g = new LoopGuard();
    const tc = toolCall("Shell", { command: "ls" });
    const obs = {
      content: "",
      thinking: "",
      toolCalls: [tc],
      toolResults: [outcome("Shell", { command: "ls" }, false)],
    };
    expect(g.observeTurn(obs).kind).toBe("continue"); // 1st
    expect(g.observeTurn(obs).kind).toBe("continue"); // 2nd
    const third = g.observeTurn(obs);
    expect(third.kind).toBe("react");
    if (third.kind === "react") {
      expect(third.type).toBe("tool-repeat");
      expect(third.nudge).toContain("SAME tool");
    }
    expect(g.observeTurn(obs).kind).toBe("react"); // 4th → level 2
    expect(g.observeTurn(obs).kind).toBe("stop"); // 5th → stop
  });

  it("escalates an ALTERNATING tool-call loop (A/B/A/B) that never repeats consecutively", () => {
    const g = new LoopGuard();
    const turn = (url: string) => ({
      content: "Let me try a few more sources.",
      thinking: "",
      toolCalls: [toolCall("WebFetch", { url })],
      toolResults: [outcome("WebFetch", { url }, false)],
    });
    expect(g.observeTurn(turn("a")).kind).toBe("continue"); // A (1st)
    expect(g.observeTurn(turn("b")).kind).toBe("continue"); // B (1st)
    expect(g.observeTurn(turn("a")).kind).toBe("continue"); // A (2nd)
    expect(g.observeTurn(turn("b")).kind).toBe("continue"); // B (2nd)
    const fifth = g.observeTurn(turn("a")); // A (3rd) — the alternating loop
    expect(fifth.kind).toBe("react");
    if (fifth.kind === "react") expect(fifth.type).toBe("tool-repeat");
  });

  it("escalates a period-3 cycle (A/B/C/A/B/C)", () => {
    const g = new LoopGuard();
    const turn = (url: string) => ({
      content: "still looking",
      thinking: "",
      toolCalls: [toolCall("WebFetch", { url })],
      toolResults: [outcome("WebFetch", { url }, false)],
    });
    const kinds = ["a", "b", "c", "a", "b", "c", "a"].map((u) => g.observeTurn(turn(u)).kind);
    expect(kinds.slice(0, 6)).toEqual(["continue", "continue", "continue", "continue", "continue", "continue"]);
    expect(kinds[6]).toBe("react");
  });

  it("does NOT flag repeated calls with DIFFERENT arguments (real progress)", () => {
    const g = new LoopGuard();
    const turn = (path: string) => ({
      content: "",
      thinking: "",
      toolCalls: [toolCall("Read", { path })],
      toolResults: [outcome("Read", { path }, false)],
    });
    for (const p of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]) {
      expect(g.observeTurn(turn(p)).kind).toBe("continue");
    }
  });

  it("escalates an error streak of DIFFERENT failing calls", () => {
    const g = new LoopGuard();
    const turn = (path: string) => ({
      content: "",
      thinking: "",
      toolCalls: [toolCall("Read", { path })],
      toolResults: [outcome("Read", { path }, true, "err")],
    });
    expect(g.observeTurn(turn("a")).kind).toBe("continue");
    expect(g.observeTurn(turn("b")).kind).toBe("continue");
    const third = g.observeTurn(turn("c"));
    expect(third.kind).toBe("react");
    if (third.kind === "react") expect(third.type).toBe("error-streak");
  });

  it("classifies a repeated FAILING call as tool-failure", () => {
    const g = new LoopGuard();
    const tc = toolCall("Read", { path: "a" });
    const obs = {
      content: "",
      thinking: "",
      toolCalls: [tc],
      toolResults: [outcome("Read", { path: "a" }, true, "err")],
    };
    expect(g.observeTurn(obs).kind).toBe("continue"); // 1st failure
    const second = g.observeTurn(obs);
    expect(second.kind).toBe("react");
    if (second.kind === "react") expect(second.type).toBe("tool-failure");
  });

  it("resets a type's escalation when its condition clears (progress)", () => {
    const g = new LoopGuard();
    const progress = {
      content: "an answer",
      thinking: "",
      toolCalls: [toolCall("Read", { path: "a" })],
      toolResults: [outcome("Read", { path: "a" }, false)],
    };
    expect(g.observeTurn(empty).kind).toBe("react"); // empty level 1
    expect(g.observeTurn(progress).kind).toBe("continue"); // resets empty
    // A new empty turn starts over at level 1 (react), not straight to stop.
    expect(g.observeTurn(empty).kind).toBe("react");
  });

  it("detects a cross-turn reasoning loop", () => {
    const g = new LoopGuard();
    const text =
      "I should inspect the configuration module and then look at how providers are created, because the " +
      "issue could be in the base URL handling or in the model resolution logic of the model factory itself.";
    const obs = {
      content: "working",
      thinking: text,
      toolCalls: [toolCall("Read", { path: "a" })],
      toolResults: [outcome("Read", { path: "a" }, false)],
    };
    expect(g.observeTurn(obs).kind).toBe("continue"); // first, no previous
    const second = g.observeTurn(obs);
    expect(second.kind).toBe("react");
    if (second.kind === "react") expect(second.type).toBe("reasoning");
  });

  it("does not carry one type's escalation into another type", () => {
    const g = new LoopGuard(); // medium: maxNudges 2
    // Empty turns reach the LAST nudge (level 2)…
    expect(g.observeTurn(empty).kind).toBe("react");
    expect(g.observeTurn(empty).kind).toBe("react");
    // …then another type becomes active, which must clear "empty"'s level…
    const tc = toolCall("Shell", { command: "ls" });
    const repeated = {
      content: "",
      thinking: "",
      toolCalls: [tc],
      toolResults: [outcome("Shell", { command: "ls" }, false)],
    };
    for (let i = 0; i < 3; i++) expect(g.observeTurn(repeated).kind).toBe(i < 2 ? "continue" : "react");
    // …so an empty turn starts over at level 1 instead of stopping the run.
    expect(g.observeTurn(empty).kind).toBe("react");
  });

  it("the consecutiveness counter alone flags a repeat, without the window", () => {
    // Wide window + high threshold: only `toolRepeatConsecutive` can fire here, so
    // this pins ITS boundary (medium = 3) instead of letting the window mask it.
    const g = new LoopGuard({ ...DEFAULT_LOOP_GUARD_OPTIONS, toolRepeatWindow: 50, toolRepeatWindowThreshold: 50 });
    const tc = toolCall("Shell", { command: "ls" });
    const obs = {
      content: "",
      thinking: "",
      toolCalls: [tc],
      toolResults: [outcome("Shell", { command: "ls" }, false)],
    };
    expect(g.observeTurn(obs).kind).toBe("continue"); // 1st
    expect(g.observeTurn(obs).kind).toBe("continue"); // 2nd
    const third = g.observeTurn(obs); // 3rd = the threshold exactly
    expect(third.kind).toBe("react");
    if (third.kind === "react") expect(third.type).toBe("tool-repeat");
  });

  it("ignores identical thinking that is too SHORT to judge", () => {
    const g = new LoopGuard(); // medium: crossTurnMinLength 120
    const turn = (path: string) => ({
      content: "progress",
      thinking: "ok, next",
      toolCalls: [toolCall("Read", { path })],
      toolResults: [outcome("Read", { path }, false)],
    });
    expect(g.observeTurn(turn("a")).kind).toBe("continue");
    // Identical, but 8 characters: below the length floor the guard must stay quiet.
    expect(g.observeTurn(turn("b")).kind).toBe("continue");
  });
});

describe("Loop Guard mid-stream checks", () => {
  /** Exactly 200 characters of the same token: its trigrams all repeat, so it IS a loop. */
  const looping = "ab ".repeat(67).trim();

  it("observeThinking stays quiet below 200 chars and fires AT 200", () => {
    // minTokens 0 + a low threshold: only the length floor can keep this quiet, so
    // the floor is what these two lines actually pin.
    const g = new LoopGuard({ ...DEFAULT_LOOP_GUARD_OPTIONS, reasoningMinTokens: 0, reasoningThreshold: 0.2 });
    expect(looping.length).toBe(200);
    expect(g.observeThinking("ab ab ab")).toBe(false); // 8 chars: too short to judge
    expect(g.observeThinking(looping)).toBe(true); // exactly the floor → checked, and it loops
  });

  it("observeThinking reports a reasoning loop only ONCE", () => {
    const g = new LoopGuard({ ...DEFAULT_LOOP_GUARD_OPTIONS, reasoningMinTokens: 0, reasoningThreshold: 0.2 });
    expect(g.observeThinking(looping)).toBe(true);
    // The stream keeps growing, but the turn is already flagged: never again.
    for (let i = 0; i < 3; i++) expect(g.observeThinking(looping + looping.repeat(i + 1))).toBe(false);
  });

  it("observeAnswer mirrors it, and only when the answer guard is ON", () => {
    const off = new LoopGuard({ ...DEFAULT_LOOP_GUARD_OPTIONS, answerMinTokens: 0, answerThreshold: 0.2 });
    expect(off.observeAnswer(looping)).toBe(false); // guardResponse is off by default

    const on = new LoopGuard({
      ...DEFAULT_LOOP_GUARD_OPTIONS,
      guardResponse: true,
      answerMinTokens: 0,
      answerThreshold: 0.2,
    });
    expect(on.observeAnswer(looping)).toBe(true); // exactly 200 → checked, and it loops
    // Already broken for this turn: no second report, whatever the text is.
    for (let i = 0; i < 3; i++) expect(on.observeAnswer(looping + looping.repeat(i + 1))).toBe(false);
  });
});

describe("Loop Guard sensitivity presets", () => {
  it("MEDIUM is the default: constant, resolved options and the bare guard all agree", () => {
    // The single default this whole feature is built on. Pinned here so a future preset
    // edit (or an accidental flip to "off") cannot change it silently.
    expect(DEFAULT_LOOP_GUARD_OPTIONS).toEqual(resolveLoopGuardOptions("medium"));
    expect(DEFAULT_LOOP_GUARD_OPTIONS.enabled).toBe(true);
    // No override (= undefined) resolves to Medium, NOT to Off and NOT to another level.
    expect(resolveLoopGuardOptions()).toEqual(DEFAULT_LOOP_GUARD_OPTIONS);
    expect(resolveLoopGuardOptions(undefined).maxNudges).toBe(2);
    expect(resolveLoopGuardOptions(null).enabled).toBe(true);
    // …and a guard built without options is a MEDIUM one (agent.ts relies on it).
    const bare = new LoopGuard();
    const obs = {
      content: "done",
      thinking: "",
      toolCalls: [toolCall("Shell", { command: "ls" })],
      toolResults: [outcome("Shell", { command: "ls" }, false)],
    };
    expect(bare.observeTurn(obs).kind).toBe("continue"); // 1st
    expect(bare.observeTurn(obs).kind).toBe("continue"); // 2nd (medium: consec = 3)
    const third = bare.observeTurn(obs); // 3rd — the MEDIUM threshold, not high's 2
    expect(third.kind).toBe("react");
    if (third.kind === "react") expect(third.type).toBe("tool-repeat");
  });

  it("medium is the default and matches the historical values", () => {
    const o = resolveLoopGuardOptions();
    expect(o).toEqual(resolveLoopGuardOptions("medium"));
    expect(o.enabled).toBe(true);
    expect(o.maxNudges).toBe(2);
    expect(o.reasoningThreshold).toBe(0.5);
    expect(o.reasoningMinTokens).toBe(60);
    expect(o.crossTurnSimilarity).toBe(0.85);
    expect(o.errorStreakTurns).toBe(3);
    expect(o.toolRepeatConsecutive).toBe(3);
    expect(o.toolRepeatWindow).toBe(16);
    expect(o.toolRepeatWindowThreshold).toBe(3);
  });

  it("high is aggressive and low is permissive (hard-coded values)", () => {
    const high = resolveLoopGuardOptions("high");
    expect(high.maxNudges).toBe(3);
    expect(high.reasoningThreshold).toBe(0.45);
    expect(high.reasoningMinTokens).toBe(50);
    expect(high.crossTurnSimilarity).toBe(0.75);
    expect(high.errorStreakTurns).toBe(2);
    expect(high.toolRepeatConsecutive).toBe(2);
    expect(high.toolRepeatWindow).toBe(10);
    expect(high.toolRepeatWindowThreshold).toBe(2);

    const low = resolveLoopGuardOptions("low");
    expect(low.maxNudges).toBe(2);
    expect(low.reasoningThreshold).toBe(0.65);
    expect(low.reasoningMinTokens).toBe(120);
    expect(low.crossTurnSimilarity).toBe(0.92);
    expect(low.errorStreakTurns).toBe(5);
    expect(low.toolRepeatConsecutive).toBe(4);
    expect(low.toolRepeatWindow).toBe(20);
    expect(low.toolRepeatWindowThreshold).toBe(4);
  });

  it("an unknown level falls back to medium", () => {
    expect(resolveLoopGuardOptions("bogus" as never)).toEqual(resolveLoopGuardOptions("medium"));
  });

  it("off is INERT: the guard is disabled and the answer guard cannot be forced back on", () => {
    const off = resolveLoopGuardOptions("off");
    expect(off.enabled).toBe(false);
    // `includeResponse` must NOT re-enable anything while the guard is off.
    expect(resolveLoopGuardOptions("off", true).guardResponse).toBe(false);
    expect(resolveLoopGuardOptions("off", true).enabled).toBe(false);
    // Every other preset is enabled.
    for (const level of ["low", "medium", "high"] as const) {
      expect(resolveLoopGuardOptions(level).enabled).toBe(true);
    }
  });

  it("exposes the presets as COPIES (loopGuardPresets)", () => {
    const p = loopGuardPresets();
    expect(p.high).toEqual(resolveLoopGuardOptions("high"));
    expect(p.medium).toEqual(resolveLoopGuardOptions("medium"));
    expect(p.low).toEqual(resolveLoopGuardOptions("low"));
    expect(p.off).toEqual(resolveLoopGuardOptions("off"));
    // Mutating a copy must not corrupt the module-level presets.
    p.medium.maxNudges = 99;
    expect(resolveLoopGuardOptions("medium").maxNudges).toBe(2);
  });

  it("every preset value sits inside its editable range", () => {
    for (const level of ["off", "low", "medium", "high"] as const) {
      const preset = resolveLoopGuardOptions(level);
      for (const r of LOOP_GUARD_FIELD_RANGES) {
        const v = preset[r.key];
        expect(v).toBeGreaterThanOrEqual(r.min);
        expect(v).toBeLessThanOrEqual(r.max);
        if (r.integer) expect(Number.isInteger(v)).toBe(true);
      }
    }
  });

  it("clamps UI overrides to the editable ranges, dropping junk", () => {
    expect(clampLoopGuardOverrides(undefined)).toBeUndefined();
    expect(clampLoopGuardOverrides("x")).toBeUndefined();
    expect(clampLoopGuardOverrides({ nope: 1 })).toBeUndefined();
    expect(clampLoopGuardOverrides({ maxNudges: 999 })).toEqual({ maxNudges: 10 });
    expect(clampLoopGuardOverrides({ maxNudges: -3 })).toEqual({ maxNudges: 1 });
    expect(clampLoopGuardOverrides({ reasoningThreshold: 999 })).toEqual({ reasoningThreshold: 1 });
    // Integer fields are rounded; ratio fields keep decimals.
    expect(clampLoopGuardOverrides({ maxNudges: 2.7 })).toEqual({ maxNudges: 3 });
    expect(clampLoopGuardOverrides({ reasoningThreshold: 0.52 })).toEqual({ reasoningThreshold: 0.52 });
    expect(clampLoopGuardOverrides({ maxNudges: Number.NaN })).toBeUndefined();
  });

  it("drops null and non-finite overrides instead of writing them through", () => {
    // These arrive from PERSISTED json: null, Infinity and a string are all values a
    // session file can carry. Each must be dropped, not clamped into the guard.
    expect(clampLoopGuardOverrides(null)).toBeUndefined();
    expect(clampLoopGuardOverrides({ maxNudges: null })).toBeUndefined();
    expect(clampLoopGuardOverrides({ maxNudges: "5" })).toBeUndefined();
    expect(clampLoopGuardOverrides({ maxNudges: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(clampLoopGuardOverrides({ maxNudges: Number.NEGATIVE_INFINITY })).toBeUndefined();
    // One junk key must not discard its valid neighbours.
    expect(clampLoopGuardOverrides({ maxNudges: 4, nope: 1 })).toEqual({ maxNudges: 4 });
  });

  it("declares every numeric parameter exactly once, integer only for counts/tokens", () => {
    // The table is the ONE source of truth: the panel builds its fields from it and the
    // host clamps incoming overrides to it. A missing key is an unreachable knob.
    const ratios = ["reasoningThreshold", "crossTurnSimilarity", "answerThreshold"];
    const keys = LOOP_GUARD_FIELD_RANGES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(
      Object.keys(DEFAULT_LOOP_GUARD_OPTIONS)
        .filter((k) => k !== "enabled" && k !== "guardResponse")
        .sort(),
    );
    for (const r of LOOP_GUARD_FIELD_RANGES) {
      expect(r.integer).toBe(!ratios.includes(r.key));
      expect(r.step).toBeGreaterThan(0);
      expect(r.min).toBeLessThanOrEqual(r.max);
    }
  });

  it("normalizeLoopGuardSensitivity validates persisted values and migrates the old name", () => {
    expect(normalizeLoopGuardSensitivity(undefined)).toBeUndefined();
    expect(normalizeLoopGuardSensitivity("off")).toBe("off");
    expect(normalizeLoopGuardSensitivity("high")).toBe("high");
    expect(normalizeLoopGuardSensitivity("low")).toBe("low");
    expect(normalizeLoopGuardSensitivity("medium")).toBe("medium");
    // Sessions saved before the rename persist "normal": same behaviour, new name.
    expect(normalizeLoopGuardSensitivity("normal")).toBe("medium");
    expect(normalizeLoopGuardSensitivity("bogus")).toBeUndefined();
    expect(normalizeLoopGuardSensitivity(3)).toBeUndefined();
    expect(isLoopGuardSensitivity("high")).toBe(true);
    expect(isLoopGuardSensitivity("off")).toBe(true);
    // The legacy spelling is accepted ONLY by the normalizer, never as a level.
    expect(isLoopGuardSensitivity("normal")).toBe(false);
  });

  it("high flags an error streak sooner than low", () => {
    const turn = (path: string) => ({
      content: "",
      thinking: "",
      toolCalls: [toolCall("Read", { path })],
      toolResults: [outcome("Read", { path }, true, "err")],
    });
    const high = new LoopGuard(resolveLoopGuardOptions("high"));
    expect(high.observeTurn(turn("a")).kind).toBe("continue");
    const highSecond = high.observeTurn(turn("b"));
    expect(highSecond.kind).toBe("react"); // high errorStreak=2
    if (highSecond.kind === "react") expect(highSecond.type).toBe("error-streak");

    const low = new LoopGuard(resolveLoopGuardOptions("low"));
    for (let i = 0; i < 4; i++) expect(low.observeTurn(turn(`p${i}`)).kind).toBe("continue"); // low errorStreak=5
    const lowFifth = low.observeTurn(turn("p4"));
    expect(lowFifth.kind).toBe("react");
  });

  it("high flags a tool loop sooner than low", () => {
    const tc = toolCall("Shell", { command: "ls" });
    const obs = {
      content: "",
      thinking: "",
      toolCalls: [tc],
      toolResults: [outcome("Shell", { command: "ls" }, false)],
    };
    const high = new LoopGuard(resolveLoopGuardOptions("high"));
    expect(high.observeTurn(obs).kind).toBe("continue"); // 1st
    const highSecond = high.observeTurn(obs);
    expect(highSecond.kind).toBe("react"); // high consec=2
    if (highSecond.kind === "react") expect(highSecond.type).toBe("tool-repeat");

    const low = new LoopGuard(resolveLoopGuardOptions("low"));
    expect(low.observeTurn(obs).kind).toBe("continue"); // 1st
    expect(low.observeTurn(obs).kind).toBe("continue"); // 2nd
    expect(low.observeTurn(obs).kind).toBe("continue"); // 3rd
    const lowFourth = low.observeTurn(obs);
    expect(lowFourth.kind).toBe("react"); // low consec=4
  });

  it("the response guard is off by default and opt-in", () => {
    expect(resolveLoopGuardOptions("medium").guardResponse).toBe(false);
    expect(resolveLoopGuardOptions("medium", true).guardResponse).toBe(true);
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu ".repeat(30);
    const off = new LoopGuard(resolveLoopGuardOptions("medium"));
    expect(off.observeAnswer(text)).toBe(false);

    const on = new LoopGuard(resolveLoopGuardOptions("medium", true));
    expect(on.observeAnswer(text)).toBe(true);
    // Once flagged, it does not fire again for the same turn.
    expect(on.observeAnswer(text)).toBe(false);
    const decision = on.noteAnswerLoop();
    expect(decision.kind).toBe("react");
    if (decision.kind === "react") expect(decision.type).toBe("response");
  });

  it("guards the final answer per turn only when enabled", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu ".repeat(30);
    const obs = { content: text, thinking: "", toolCalls: [], toolResults: [] };
    const off = new LoopGuard(resolveLoopGuardOptions("medium"));
    expect(off.observeTurn(obs).kind).toBe("continue");
    const on = new LoopGuard(resolveLoopGuardOptions("medium", true));
    const decision = on.observeTurn(obs);
    expect(decision.kind).toBe("react");
    if (decision.kind === "react") expect(decision.type).toBe("response");
  });
});

describe("Loop Guard OFF — the guard is completely inert", () => {
  const repetitive = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu ".repeat(30);
  const tc = toolCall("Read", { path: "a" });

  it("never flags reasoning, even with the answer guard forced on", () => {
    const g = new LoopGuard({ ...resolveLoopGuardOptions("off"), guardResponse: true });
    expect(g.observeThinking(repetitive)).toBe(false);
    expect(g.observeAnswer(repetitive)).toBe(false);
    for (let i = 0; i < 10; i++) {
      expect(g.observeTurn({ content: repetitive, thinking: repetitive, toolCalls: [], toolResults: [] }).kind).toBe(
        "continue",
      );
    }
  });

  it("never dedupes or refuses tool calls (off means off, not just quieter)", () => {
    const g = new LoopGuard(resolveLoopGuardOptions("off"));
    // First run executes and is recorded as a FAILURE…
    expect(g.beforeToolCall(tc, true).mode).toBe("run");
    g.afterToolCall(tc, true, "boom", true);
    // …and an identical failing call runs again instead of being refused.
    expect(g.beforeToolCall(tc, true).mode).toBe("run");
    g.afterToolCall(tc, true, "boom", true);
    // A successful read is never cached: a second identical read runs again.
    expect(g.beforeToolCall(tc, true).mode).toBe("run");
    g.afterToolCall(tc, false, "file body", true);
    expect(g.beforeToolCall(tc, true).mode).toBe("run");
    // No in-flight bookkeeping either: the same call twice in one turn is allowed.
    expect(g.beforeToolCall(tc, false).mode).toBe("run");
    expect(g.beforeToolCall(tc, false).mode).toBe("run");
  });

  it("turning it off at runtime silences a guard that was already escalating", () => {
    const obs = {
      content: "done",
      thinking: "",
      toolCalls: [toolCall("Shell", { command: "ls" })],
      toolResults: [outcome("Shell", { command: "ls" }, false)],
    };
    const g = new LoopGuard(resolveLoopGuardOptions("high"));
    expect(g.observeTurn(obs).kind).toBe("continue"); // 1st
    expect(g.observeTurn(obs).kind).toBe("react"); // high flags at 2
    g.setOptions(resolveLoopGuardOptions("off"));
    for (let i = 0; i < 5; i++) expect(g.observeTurn(obs).kind).toBe("continue");
    expect(g.observeThinking(repetitive)).toBe(false);
    expect(g.beforeToolCall(tc, true).mode).toBe("run");
  });
});

describe("state a new run must not inherit (reset / beginTurn)", () => {
  /** Exactly 200 characters of the same token: its trigrams all repeat, so it IS a loop. */
  const looping = "ab ".repeat(67).trim();
  const eager = {
    ...DEFAULT_LOOP_GUARD_OPTIONS,
    reasoningMinTokens: 0,
    reasoningThreshold: 0.2,
    guardResponse: true,
    answerMinTokens: 0,
    answerThreshold: 0.2,
  };

  it("reset() wipes EVERY piece of state, not just the levels", () => {
    const g = new LoopGuard(eager);
    const read = toolCall("Read", { path: "cached" });
    const bad = toolCall("Read", { path: "failed" });
    const flying = toolCall("Read", { path: "inflight" });
    g.beforeToolCall(read, true);
    g.afterToolCall(read, false, "body", true);
    g.beforeToolCall(bad, true);
    g.afterToolCall(bad, true, "ENOENT", true);
    g.beforeToolCall(flying, true);
    expect(g.observeThinking(looping)).toBe(true);
    expect(g.observeAnswer(looping)).toBe(true);
    for (let i = 0; i < 2; i++)
      expect(g.observeTurn({ content: "", thinking: "", toolCalls: [], toolResults: [] }).kind).toBe("react");

    g.reset();

    // No cache, no remembered failure, nothing in flight: every call starts clean.
    expect(g.beforeToolCall(read, true).mode).toBe("run");
    expect(g.beforeToolCall(bad, true).mode).toBe("run");
    expect(g.beforeToolCall(flying, true).mode).toBe("run");
    // The per-turn flags are back to "not flagged": both detectors fire again.
    expect(g.observeThinking(looping)).toBe(true);
    expect(g.observeAnswer(looping)).toBe(true);
    // …and the escalation restarted, so an empty turn is level ONE again (react, not stop).
    expect(g.observeTurn({ content: "", thinking: "", toolCalls: [], toolResults: [] }).kind).toBe("react");
  });

  it("beginTurn() clears the per-turn flags but KEEPS the levels", () => {
    const g = new LoopGuard(eager);
    expect(g.observeThinking(looping)).toBe(true);
    expect(g.observeAnswer(looping)).toBe(true);
    g.beginTurn();
    // A new turn re-checks from scratch: the previous turn's verdict is not inherited.
    expect(g.observeThinking(looping)).toBe(true);
    expect(g.observeAnswer(looping)).toBe(true);
    // Levels SURVIVE beginTurn (only reset() clears them): 1 → 2, still a react.
    expect(g.noteReasoningLoop().level).toBe(1);
    g.beginTurn();
    const second = g.noteReasoningLoop();
    expect(second.kind).toBe("react");
    expect(second.level).toBe(2);
  });
});

describe("mid-stream checks are amortised: one re-check per 200 new characters", () => {
  const looping = "ab ".repeat(67).trim();
  const prose =
    "I need to read the config file to understand the provider setup. Then I will locate the tool registry " +
    "and check how tools are registered before running anything that touches the disk or the network layer.";

  it("checks at 200 chars, then waits for another 200 before checking again", () => {
    const g = new LoopGuard({ ...DEFAULT_LOOP_GUARD_OPTIONS, reasoningMinTokens: 0, reasoningThreshold: 0.2 });
    expect(prose.length).toBeGreaterThanOrEqual(200);
    const first = prose.slice(0, 200);
    expect(first.length).toBe(200);
    // Checked — and clean, so the guard keeps quiet instead of claiming a loop.
    expect(g.observeThinking(first)).toBe(false);
    // Only +3 characters: the next check is 200 characters away, so the loop pattern
    // that just appeared is NOT seen yet (this is what keeps the call cheap).
    expect(g.observeThinking(first + "ab ")).toBe(false);
    // Another 200 later the text is mostly the pattern: now it IS flagged.
    expect(g.observeThinking(first + looping)).toBe(true);
  });
});

describe("each type's escalation is reset by a turn where it is not active", () => {
  const neutral = { content: "an answer", thinking: "", toolCalls: [], toolResults: [] };
  const emptyTurn = { content: "", thinking: "", toolCalls: [], toolResults: [] };

  it("tool-failure", () => {
    const g = new LoopGuard();
    const failing = (path: string) => ({
      content: "",
      thinking: "",
      toolCalls: [toolCall("Read", { path })],
      toolResults: [outcome("Read", { path }, true, "err")],
    });
    expect(g.observeTurn(failing("a")).kind).toBe("continue");
    expect(g.observeTurn(failing("a")).kind).toBe("react"); // level 1
    expect(g.observeTurn(failing("a")).kind).toBe("react"); // level 2
    expect(g.observeTurn(neutral).kind).toBe("continue");
    expect(g.observeTurn(failing("a")).kind).toBe("continue");
    // Back to level 1: the run gets its two nudges again, it does not stop straight away.
    expect(g.observeTurn(failing("a")).kind).toBe("react");
  });

  it("error-streak", () => {
    const g = new LoopGuard();
    const failing = (path: string) => ({
      content: "",
      thinking: "",
      toolCalls: [toolCall("Read", { path })],
      toolResults: [outcome("Read", { path }, true, "err")],
    });
    for (let i = 0; i < 3; i++) expect(g.observeTurn(failing(`a${i}`)).kind).toBe(i < 2 ? "continue" : "react");
    expect(g.observeTurn(failing("a3")).kind).toBe("react"); // level 2
    expect(g.observeTurn(neutral).kind).toBe("continue");
    for (let i = 0; i < 2; i++) expect(g.observeTurn(failing(`b${i}`)).kind).toBe("continue");
    expect(g.observeTurn(failing("b2")).kind).toBe("react");
  });

  it("tool-repeat", () => {
    const g = new LoopGuard();
    const same = (path: string) => ({
      content: "",
      thinking: "",
      toolCalls: [toolCall("Read", { path })],
      toolResults: [outcome("Read", { path }, false)],
    });
    for (let i = 0; i < 3; i++) expect(g.observeTurn(same("a")).kind).toBe(i < 2 ? "continue" : "react");
    expect(g.observeTurn(same("a")).kind).toBe("react"); // level 2
    expect(g.observeTurn(neutral).kind).toBe("continue");
    for (let i = 0; i < 2; i++) expect(g.observeTurn(same("a")).kind).toBe("continue");
    expect(g.observeTurn(same("a")).kind).toBe("react");
  });

  it("reasoning (cross-turn)", () => {
    const g = new LoopGuard();
    const text =
      "I should inspect the configuration module and then look at how providers are created, because the " +
      "issue could be in the base URL handling or in the model resolution logic of the model factory itself.";
    const think = (path: string) => ({
      content: "working",
      thinking: text,
      toolCalls: [toolCall("Read", { path })],
      toolResults: [outcome("Read", { path }, false)],
    });
    expect(g.observeTurn(think("a")).kind).toBe("continue");
    expect(g.observeTurn(think("b")).kind).toBe("react"); // level 1
    expect(g.observeTurn(think("c")).kind).toBe("react"); // level 2
    expect(g.observeTurn(neutral).kind).toBe("continue");
    expect(g.observeTurn(think("d")).kind).toBe("continue"); // no previous reasoning any more
    const again = g.observeTurn(think("e"));
    expect(again.kind).toBe("react");
    if (again.kind === "react") expect(again.level).toBe(1);
  });

  it("response", () => {
    const g = new LoopGuard({ ...DEFAULT_LOOP_GUARD_OPTIONS, guardResponse: true });
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu ".repeat(30);
    const looping = { content: text, thinking: "", toolCalls: [], toolResults: [] };
    expect(g.observeTurn(looping).kind).toBe("react"); // level 1
    expect(g.observeTurn(looping).kind).toBe("react"); // level 2
    expect(g.observeTurn(neutral).kind).toBe("continue");
    const again = g.observeTurn(looping);
    expect(again.kind).toBe("react");
    if (again.kind === "react") expect(again.level).toBe(1);
    // …and the empty-turn detector is a DIFFERENT type: reaching nothing here proves it.
    expect(g.observeTurn(emptyTurn).kind).toBe("react");
  });
});

describe("turn classification, the fine print", () => {
  it("one success among failures is NOT a failure streak", () => {
    const g = new LoopGuard();
    const mixed = (path: string) => ({
      content: "",
      thinking: "",
      toolCalls: [toolCall("Read", { path }), toolCall("Read", { path: `${path}-b` })],
      toolResults: [outcome("Read", { path }, true, "err"), outcome("Read", { path: `${path}-b` }, false, "ok")],
    });
    for (const p of ["a", "b", "c", "d"]) expect(g.observeTurn(mixed(p)).kind).toBe("continue");
  });

  it("a turn with no tool calls empties the repeat window (a reset is progress)", () => {
    const g = new LoopGuard(resolveLoopGuardOptions("high")); // window 10, threshold 2
    const same = {
      content: "",
      thinking: "",
      toolCalls: [toolCall("Read", { path: "a" })],
      toolResults: [outcome("Read", { path: "a" }, false)],
    };
    const spent = { content: "let me think", thinking: "", toolCalls: [], toolResults: [] };
    expect(g.observeTurn(same).kind).toBe("continue");
    expect(g.observeTurn(spent).kind).toBe("continue");
    // The identical call is seen for the FIRST time again: no window carries it over.
    expect(g.observeTurn(same).kind).toBe("continue");
  });

  it("a failure streak is broken by a turn that succeeds", () => {
    const g = new LoopGuard();
    const failing = (path: string) => ({
      content: "",
      thinking: "",
      toolCalls: [toolCall("Read", { path })],
      toolResults: [outcome("Read", { path }, true, "err")],
    });
    const ok = (path: string) => ({
      content: "",
      thinking: "",
      toolCalls: [toolCall("Read", { path })],
      toolResults: [outcome("Read", { path }, false, "ok")],
    });
    expect(g.observeTurn(failing("a")).kind).toBe("continue");
    expect(g.observeTurn(ok("b")).kind).toBe("continue");
    expect(g.observeTurn(failing("c")).kind).toBe("continue");
  });

  it("whitespace-only content and thinking is still an EMPTY turn", () => {
    const g = new LoopGuard();
    const decision = g.observeTurn({ content: "   ", thinking: "\n\t ", toolCalls: [], toolResults: [] });
    expect(decision.kind).toBe("react");
    if (decision.kind === "react") {
      expect(decision.type).toBe("empty");
      // Whitespace is not "reasoning": the nudge must be the no-reasoning one.
      expect(decision.nudge).toContain("empty (no text, no tool call)");
      expect(decision.nudge).not.toContain("produced reasoning");
    }
  });
});

describe("the nudges say what to do (they are the product, not decoration)", () => {
  const same = {
    content: "",
    thinking: "",
    toolCalls: [toolCall("Shell", { command: "ls" })],
    toolResults: [outcome("Shell", { command: "ls" }, false)],
  };

  it("tool-repeat: names the tool and points at the read-only tools", () => {
    const g = new LoopGuard(resolveLoopGuardOptions("high"));
    expect(g.observeTurn(same).kind).toBe("continue");
    const d = g.observeTurn(same);
    expect(d.kind).toBe("react");
    if (d.kind === "react") {
      expect(d.nudge).toContain('You called the SAME tool ("Shell") with identical arguments 3+ times');
      expect(d.nudge).toContain("STOP repeating it. Change approach NOW");
      expect(d.nudge).toContain("prefer these over Shell");
      expect(d.nudge).toContain("Then write your final report.");
      expect(d.note).toContain("identical successful tool call repeated");
    }
  });

  it("the error streak reports the tools and the count", () => {
    const g = new LoopGuard();
    const turn = (path: string) => ({
      content: "",
      thinking: "",
      toolCalls: [toolCall("Read", { path })],
      toolResults: [outcome("Read", { path }, true, "err"), outcome("Write", { path }, true, "err")],
    });
    const kinds = ["a", "b", "c"].map((p) => g.observeTurn(turn(p)));
    expect(kinds.slice(0, 2).map((k) => k.kind)).toEqual(["continue", "continue"]);
    const d = kinds[2];
    expect(d.kind).toBe("react");
    if (d.kind !== "react") return;
    expect(d.type).toBe("error-streak");
    expect(d.nudge).toContain("3 turns in a row ended with ALL tools failing (Read, Write)");
    expect(d.nudge).toContain("try a DIFFERENT approach");
    expect(d.note).toContain("error streak (3 turns of failures)");
    // The stop message is the one a user sees in the transcript.
    expect(g.observeTurn(turn("d")).kind).toBe("react");
    const stop = g.observeTurn(turn("e"));
    expect(stop.kind).toBe("stop");
    if (stop.kind === "stop") expect(stop.message).toContain("consecutive turns of tool errors (Read, Write)");
  });

  it("reasoning, empty and tool-failure each carry their own sentence", () => {
    const reasons = new LoopGuard();
    const first = reasons.noteReasoningLoop();
    if (first.kind === "react") {
      expect(first.nudge).toContain("Your reasoning is LOOPING");
      expect(first.nudge).toContain("STOP reasoning now");
      expect(first.note).toContain("reasoning loop detected");
    }
    reasons.noteReasoningLoop();
    const stop = reasons.noteReasoningLoop();
    expect(stop.kind).toBe("stop");
    if (stop.kind === "stop")
      expect(stop.message).toContain("Reasoning loop not resolved after repeated interventions.");

    const answers = new LoopGuard({ ...DEFAULT_LOOP_GUARD_OPTIONS, guardResponse: true });
    const answer = answers.noteAnswerLoop();
    if (answer.kind === "react") {
      expect(answer.nudge).toContain("Your final answer is LOOPING");
      expect(answer.nudge).toContain("STOP repeating it. Finish the answer concisely");
      expect(answer.note).toContain("response loop detected");
    }
    answers.noteAnswerLoop();
    const answerStop = answers.noteAnswerLoop();
    if (answerStop.kind === "stop") expect(answerStop.message).toContain("Response loop not resolved");

    const empties = new LoopGuard();
    const emptyDecision = empties.observeTurn({ content: "", thinking: "", toolCalls: [], toolResults: [] });
    if (emptyDecision.kind === "react") expect(emptyDecision.note).toContain("empty turn (no text, no tool call)");
    empties.observeTurn({ content: "", thinking: "", toolCalls: [], toolResults: [] });
    const emptyStop = empties.observeTurn({ content: "", thinking: "", toolCalls: [], toolResults: [] });
    if (emptyStop.kind === "stop") expect(emptyStop.message).toContain("kept producing empty turns");

    const failing = new LoopGuard();
    const failObs = {
      content: "",
      thinking: "",
      toolCalls: [toolCall("Read", { path: "a" })],
      toolResults: [outcome("Read", { path: "a" }, true, "err")],
    };
    failing.observeTurn(failObs);
    const failReact = failing.observeTurn(failObs);
    if (failReact.kind === "react") {
      expect(failReact.nudge).toContain("Re-Read the target, fix the arguments, or use a different tool/approach");
      expect(failReact.note).toContain("it was not re-run and a corrective was injected");
    }
    failing.observeTurn(failObs);
    const failStop = failing.observeTurn(failObs);
    if (failStop.kind === "stop") expect(failStop.message).toContain("kept repeating the same failing tool call");
  });
});

describe("cross-turn boundaries: strictly longer than the floor, similarity INCLUSIVE", () => {
  it("exactly at the length floor is NOT judged; one more character is", () => {
    const g = new LoopGuard(); // crossTurnMinLength 120
    const exactly = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor"
      .repeat(2)
      .slice(0, 120);
    expect(exactly.length).toBe(120);
    const turn = (path: string, thinking: string) => ({
      content: "progress",
      thinking,
      toolCalls: [toolCall("Read", { path })],
      toolResults: [outcome("Read", { path }, false)],
    });
    expect(g.observeTurn(turn("a", exactly)).kind).toBe("continue");
    // 120 chars: at the floor, not above it → no judgement even though the text is identical.
    expect(g.observeTurn(turn("b", exactly)).kind).toBe("continue");
    // 121 chars: identical text, and now it IS judged → a cross-turn reasoning loop.
    const judged = new LoopGuard();
    const above = `${exactly}x`;
    expect(judged.observeTurn(turn("c", above)).kind).toBe("continue");
    const flagged = judged.observeTurn(turn("d", above));
    expect(flagged.kind).toBe("react");
    if (flagged.kind === "react") expect(flagged.type).toBe("reasoning");
  });

  it("padding with whitespace does not make short thinking long enough", () => {
    const g = new LoopGuard(); // crossTurnMinLength 120
    const short = `${"lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor".repeat(2).slice(0, 118)}\n\n`;
    expect(short.length).toBe(120);
    const turn = (path: string) => ({
      content: "progress",
      thinking: short,
      toolCalls: [toolCall("Read", { path })],
      toolResults: [outcome("Read", { path }, false)],
    });
    expect(g.observeTurn(turn("a")).kind).toBe("continue");
    expect(g.observeTurn(turn("b")).kind).toBe("continue");
  });

  it("a similarity EXACTLY at the threshold already flags the loop", () => {
    // 17 shared words out of a 20-word union = 0.85 = the medium threshold.
    const shared = Array.from({ length: 17 }, (_, i) => `common${i}`).join(" ");
    const a = `${shared} onlya1 onlya2 onlya3`;
    const b = shared;
    expect(thinkingSimilarity(a, b)).toBeCloseTo(17 / 20, 5);
    const g = new LoopGuard({ ...DEFAULT_LOOP_GUARD_OPTIONS, crossTurnSimilarity: thinkingSimilarity(a, b) });
    const turn = (path: string, thinking: string) => ({
      content: "progress",
      thinking,
      toolCalls: [toolCall("Read", { path })],
      toolResults: [outcome("Read", { path }, false)],
    });
    expect(g.observeTurn(turn("a", a)).kind).toBe("continue");
    const d = g.observeTurn(turn("b", b));
    expect(d.kind).toBe("react");
    if (d.kind === "react") expect(d.type).toBe("reasoning");
  });
});

describe("dedup bookkeeping: small payloads, first error wins", () => {
  it("reports the FIRST failure, not the latest rewrite of it", () => {
    const g = new LoopGuard();
    const tc = toolCall("Read", { path: "a" });
    g.afterToolCall(tc, true, "FIRST-ERROR", true);
    g.afterToolCall(tc, true, "SECOND-ERROR", true);
    const d = g.beforeToolCall(tc, true);
    expect(d.mode).toBe("refuse");
    if (d.mode === "refuse") expect(d.content).toContain("FIRST-ERROR");
  });

  it("truncates what it stores, so a huge payload cannot live in the guard", () => {
    const g = new LoopGuard();
    const tc = toolCall("Read", { path: "big" });
    const huge = `${"x".repeat(700)}-TAIL`;
    g.afterToolCall(tc, true, huge, true);
    const refused = g.beforeToolCall(tc, true);
    if (refused.mode === "refuse") expect(refused.content).not.toContain("-TAIL");

    const read = toolCall("Read", { path: "big2" });
    const body = `${"y".repeat(25_000)}-END`;
    g.afterToolCall(read, false, body, true);
    g.beforeToolCall(read, true);
    const reused = g.beforeToolCall(read, true);
    if (reused.mode === "reuse") {
      expect(reused.content).not.toContain("-END");
      expect(reused.content.length).toBeLessThan(21_000);
    }
  });
});

describe("tokenize / trigramDuplication edge shapes", () => {
  it("punctuation BETWEEN words separates them (it is replaced, not deleted)", () => {
    // Deleting the punctuation would fuse "a,b" into one token, and a fused token is
    // invisible to every similarity check built on top of it.
    expect(tokenize("a,b")).toEqual(["a", "b"]);
    expect(tokenize("file.ts")).toEqual(["file", "ts"]);
  });

  it("too few tokens to form a trigram is zero duplication, not NaN", () => {
    expect(trigramDuplication("a b")).toBe(0);
    expect(trigramDuplication("a")).toBe(0);
    expect(trigramDuplication("")).toBe(0);
  });

  it("an empty side of similarity is 0, never NaN", () => {
    expect(thinkingSimilarity("", "")).toBe(0);
    expect(thinkingSimilarity("a b", "")).toBe(0);
    expect(thinkingSimilarity("", "a b")).toBe(0);
  });
});

describe("the amortisation is what keeps every delta cheap — for BOTH streams", () => {
  const looping = "ab ".repeat(67).trim();
  const prose =
    "I need to read the config file to understand the provider setup. Then I will locate the tool registry " +
    "and check how tools are registered before running anything that touches the disk or the network layer.";
  const eager = {
    ...DEFAULT_LOOP_GUARD_OPTIONS,
    guardResponse: true,
    reasoningMinTokens: 0,
    reasoningThreshold: 0.2,
    answerMinTokens: 0,
    answerThreshold: 0.2,
  };

  it("a delta SHORTER than 200 chars is never inspected, even when it is pure loop", () => {
    const g = new LoopGuard(eager);
    const head = prose.slice(0, 200);
    expect(g.observeThinking(head)).toBe(false); // checked: clean
    // +150 characters of an obvious pattern: the text as a whole is now ~40% duplicated,
    // but only 150 characters arrived, so the guard must NOT look yet.
    expect(g.observeThinking(head + looping.slice(0, 150))).toBe(false);
    // +200 arrived: now it looks, and the loop is there.
    expect(g.observeThinking(head + looping)).toBe(true);
  });

  it("the answer stream is amortised the same way", () => {
    const g = new LoopGuard(eager);
    const head = prose.slice(0, 200);
    expect(g.observeAnswer(head)).toBe(false); // clean
    expect(g.observeAnswer(head + looping.slice(0, 150))).toBe(false); // not inspected
    expect(g.observeAnswer(head + looping)).toBe(true);
  });

  it("a long but varied answer is not a loop", () => {
    const g = new LoopGuard(eager);
    const varied = `${prose} ${prose.split(" ").reverse().join(" ")} ${prose.replace(/e/g, "a")}`;
    expect(varied.length).toBeGreaterThan(400);
    expect(g.observeAnswer(varied)).toBe(false);
  });
});

describe("the observeTurn branches carry their own sentences", () => {
  const answer = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu ".repeat(30);

  it("response: react with the answer nudge, then stop with the answer stop", () => {
    const g = new LoopGuard({ ...DEFAULT_LOOP_GUARD_OPTIONS, guardResponse: true });
    const obs = { content: answer, thinking: "", toolCalls: [], toolResults: [] };
    const first = g.observeTurn(obs);
    expect(first.kind).toBe("react");
    if (first.kind === "react") {
      expect(first.nudge).toContain("Your previous answer repeated itself. Do NOT repeat it");
      expect(first.note).toContain("response loop detected in the answer");
    }
    g.observeTurn(obs);
    const stop = g.observeTurn(obs);
    expect(stop.kind).toBe("stop");
    if (stop.kind === "stop") expect(stop.message).toContain("kept repeating the same answer");
  });

  it("cross-turn reasoning: react with the previous-turn nudge, then stop", () => {
    const g = new LoopGuard();
    const text =
      "I should inspect the configuration module and then look at how providers are created, because the " +
      "issue could be in the base URL handling or in the model resolution logic of the model factory itself.";
    const turn = (path: string) => ({
      content: "working",
      thinking: text,
      toolCalls: [toolCall("Read", { path })],
      toolResults: [outcome("Read", { path }, false)],
    });
    expect(g.observeTurn(turn("a")).kind).toBe("continue");
    const first = g.observeTurn(turn("b"));
    expect(first.kind).toBe("react");
    if (first.kind === "react") {
      expect(first.nudge).toContain("Your reasoning is repeating the SAME content as the previous turn");
      expect(first.nudge).toContain("next tool or write your final answer");
      expect(first.note).toContain("cross-turn reasoning loop");
    }
    expect(g.observeTurn(turn("c")).kind).toBe("react");
    const stop = g.observeTurn(turn("d"));
    expect(stop.kind).toBe("stop");
    if (stop.kind === "stop") expect(stop.message).toContain("kept repeating the same reasoning across turns");
  });
});

describe("the repeat WINDOW is exactly toolRepeatWindow entries", () => {
  // Only the frequency check can fire here: consecutiveness is set out of reach, so
  // what these two sequences pin is the WINDOW, not the consecutive counter.
  const wide = { ...DEFAULT_LOOP_GUARD_OPTIONS, toolRepeatConsecutive: 99 };
  const turn = (path: string) => ({
    content: "",
    thinking: "",
    toolCalls: [toolCall("Read", { path })],
    toolResults: [outcome("Read", { path }, false)],
  });

  it("an occurrence older than the window is FORGOTTEN", () => {
    const g = new LoopGuard(wide); // window 16, window threshold 3
    expect(g.observeTurn(turn("a")).kind).toBe("continue"); // the old occurrence
    for (let i = 0; i < 14; i++) expect(g.observeTurn(turn(`b${i}`)).kind).toBe("continue");
    expect(g.observeTurn(turn("a")).kind).toBe("continue"); // 2nd — inside
    // The first "a" has slid out: only two of them are in the window, so no loop yet.
    expect(g.observeTurn(turn("a")).kind).toBe("continue");
  });

  it("an occurrence still INSIDE the window counts", () => {
    const g = new LoopGuard(wide);
    expect(g.observeTurn(turn("a")).kind).toBe("continue"); // 15 turns back — still inside
    for (let i = 0; i < 13; i++) expect(g.observeTurn(turn(`b${i}`)).kind).toBe("continue");
    expect(g.observeTurn(turn("a")).kind).toBe("continue"); // 2nd
    const third = g.observeTurn(turn("a")); // 3rd, and all three are in the 16-entry window
    expect(third.kind).toBe("react");
    if (third.kind === "react") expect(third.type).toBe("tool-repeat");
  });
});

describe("a disabled guard records nothing", () => {
  it("state collected while OFF does not come back when it is switched ON", () => {
    const g = new LoopGuard(resolveLoopGuardOptions("off"));
    const tc = toolCall("Read", { path: "a" });
    for (let i = 0; i < 3; i++) {
      expect(g.beforeToolCall(tc, true).mode).toBe("run");
      g.afterToolCall(tc, true, "ENOENT", true);
    }
    g.setOptions(resolveLoopGuardOptions("medium"));
    // Nothing was kept from the disabled phase: this is a FIRST call, not a repeat.
    expect(g.beforeToolCall(tc, true).mode).toBe("run");
  });
});

describe("whitespace padding cannot smuggle thinking past the length floor", () => {
  it("121 raw characters that trim to 118 are still too short", () => {
    const g = new LoopGuard(); // crossTurnMinLength 120
    const short = `${"lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor".repeat(2).slice(0, 118)}\n\n\n`;
    expect(short.length).toBe(121);
    const turn = (path: string) => ({
      content: "progress",
      thinking: short,
      toolCalls: [toolCall("Read", { path })],
      toolResults: [outcome("Read", { path }, false)],
    });
    expect(g.observeTurn(turn("a")).kind).toBe("continue");
    expect(g.observeTurn(turn("b")).kind).toBe("continue");
  });
});

describe("tool-repeat: the stop message names the call", () => {
  it("reports the tool and the fact that the arguments did not change", () => {
    const g = new LoopGuard(resolveLoopGuardOptions("high")); // maxNudges 3
    const same = {
      content: "",
      thinking: "",
      toolCalls: [toolCall("Shell", { command: "ls" })],
      toolResults: [outcome("Shell", { command: "ls" }, false)],
    };
    expect(g.observeTurn(same).kind).toBe("continue");
    for (let i = 0; i < 3; i++) expect(g.observeTurn(same).kind).toBe("react");
    const stop = g.observeTurn(same);
    expect(stop.kind).toBe("stop");
    if (stop.kind === "stop") expect(stop.message).toContain('The model called "Shell" with identical arguments');
  });
});
