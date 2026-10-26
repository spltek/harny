import { describe, it, expect } from "vitest";
import {
  LoopGuard,
  callSignature,
  stableArgs,
  trigramDuplication,
  isRepetitiveThinking,
  thinkingSimilarity,
  resolveLoopGuardOptions,
  normalizeLoopGuardSensitivity,
  isLoopGuardSensitivity,
  loopGuardPresets,
  clampLoopGuardOverrides,
  LOOP_GUARD_FIELD_RANGES,
  LOOP_GUARD_SENSITIVITIES,
  DEFAULT_LOOP_GUARD_SENSITIVITY,
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
});

describe("Loop Guard sensitivity presets", () => {
  it("MEDIUM is the default: constant, resolved options and the bare guard all agree", () => {
    // The single default this whole feature is built on. Pinned here so a future preset
    // edit (or an accidental flip to "off") cannot change it silently.
    expect(DEFAULT_LOOP_GUARD_SENSITIVITY).toBe("medium");
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
    // The order the UI renders: Off first, then quiet → loud.
    expect([...LOOP_GUARD_SENSITIVITIES]).toEqual(["off", "low", "medium", "high"]);
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
    for (const level of LOOP_GUARD_SENSITIVITIES) {
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
