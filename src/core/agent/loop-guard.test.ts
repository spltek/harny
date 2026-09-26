import { describe, it, expect } from "vitest";
import {
  LoopGuard,
  callSignature,
  stableArgs,
  trigramDuplication,
  isRepetitiveThinking,
  thinkingSimilarity,
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
    const g = new LoopGuard(2);
    expect(g.observeTurn(empty).kind).toBe("react");
    expect(g.observeTurn(empty).kind).toBe("react");
    const stop = g.observeTurn(empty);
    expect(stop.kind).toBe("stop");
    if (stop.kind === "stop") expect(stop.type).toBe("empty");
  });

  it("escalates a repeated successful tool call", () => {
    const g = new LoopGuard(2);
    const tc = toolCall("Shell", { command: "ls" });
    const obs = { content: "", thinking: "", toolCalls: [tc], toolResults: [outcome("Shell", { command: "ls" }, false)] };
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

  it("escalates an error streak of DIFFERENT failing calls", () => {
    const g = new LoopGuard(2);
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
    const g = new LoopGuard(2);
    const tc = toolCall("Read", { path: "a" });
    const obs = { content: "", thinking: "", toolCalls: [tc], toolResults: [outcome("Read", { path: "a" }, true, "err")] };
    expect(g.observeTurn(obs).kind).toBe("continue"); // 1st failure
    const second = g.observeTurn(obs);
    expect(second.kind).toBe("react");
    if (second.kind === "react") expect(second.type).toBe("tool-failure");
  });

  it("resets a type's escalation when its condition clears (progress)", () => {
    const g = new LoopGuard(2);
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
    const g = new LoopGuard(2);
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
