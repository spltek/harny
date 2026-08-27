import { describe, it, expect } from "vitest";
import { ThinkingTagParser } from "./thinking-parser";

describe("ThinkingTagParser", () => {
  it("passes plain text through untouched", () => {
    const p = new ThinkingTagParser();
    expect(p.feed("hello world")).toEqual([{ kind: "text", content: "hello world" }]);
  });

  it("extracts a <think> block and keeps the surrounding text", () => {
    const p = new ThinkingTagParser();
    const events = p.feed("Let me see.<think>check the docs</think>Done.");
    expect(events).toEqual([
      { kind: "text", content: "Let me see." },
      { kind: "thinking", content: "check the docs" },
      { kind: "text", content: "Done." },
    ]);
  });

  it("supports <reason> blocks", () => {
    const p = new ThinkingTagParser();
    const events = p.feed("<reason>because of X</reason>answer");
    expect(events).toEqual([
      { kind: "thinking", content: "because of X" },
      { kind: "text", content: "answer" },
    ]);
  });

  it("keeps state across chunks (a block spanning multiple chunks)", () => {
    const p = new ThinkingTagParser();
    expect(p.feed("<think>thinking part ")).toEqual([]);
    expect(p.feed("one")).toEqual([]);
    expect(p.feed("</think>done")).toEqual([
      { kind: "thinking", content: "thinking part one" },
      { kind: "text", content: "done" },
    ]);
  });

  it("handles mixed close tags without leaking a stray '>' (regression)", () => {
    const p = new ThinkingTagParser();
    // Opened with <think> but closed with </reason> while </think> is also
    // present later: the chosen close tag is </reason> (9 chars). The slice
    // must consume ALL of it, or a lone ">" leaks into the visible text.
    const events = p.feed("<think>a</reason>z</think>");
    expect(events).toEqual([
      { kind: "thinking", content: "a" },
      { kind: "text", content: "z</think>" },
    ]);
  });

  it("drops empty thinking blocks", () => {
    const p = new ThinkingTagParser();
    expect(p.feed("<think></think>rest")).toEqual([{ kind: "text", content: "rest" }]);
  });

  it("keeps an unclosed block buffered until it closes", () => {
    const p = new ThinkingTagParser();
    expect(p.feed("<think>partial")).toEqual([]);
    expect(p.feed("more")).toEqual([]);
    expect(p.feed("</think>end")).toEqual([
      { kind: "thinking", content: "partialmore" },
      { kind: "text", content: "end" },
    ]);
  });
});
