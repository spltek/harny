import { describe, it, expect } from "vitest";
import { ToolCallAccumulator } from "./tool-call-accumulator";

function feed(acc: ToolCallAccumulator, raw: string): unknown {
  acc.handle({ type: "tool_call_start", index: 0, id: "c1", name: "Write" });
  acc.handle({ type: "tool_call_delta", index: 0, delta: raw });
  return acc.handle({ type: "tool_call_end", index: 0 });
}

describe("ToolCallAccumulator", () => {
  it("parses valid JSON arguments", () => {
    const acc = new ToolCallAccumulator();
    const call = feed(acc, '{"path":"index.html","contents":"hi"}') as {
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    };
    expect(call.arguments).toEqual({ path: "index.html", contents: "hi" });
  });

  it("handles streamed JSON split across deltas", () => {
    const acc = new ToolCallAccumulator();
    acc.handle({ type: "tool_call_start", index: 0, id: "c1", name: "Write" });
    acc.handle({ type: "tool_call_delta", index: 0, delta: '{"path":"a' });
    acc.handle({ type: "tool_call_delta", index: 0, delta: '.txt","contents":"b' });
    acc.handle({ type: "tool_call_delta", index: 0, delta: '"}' });
    const call = acc.handle({ type: "tool_call_end", index: 0 }) as {
      arguments: Record<string, unknown>;
    };
    expect(call.arguments).toEqual({ path: "a.txt", contents: "b" });
  });

  it("recovers JSON wrapped in prose (markdown fences or extra text)", () => {
    const acc = new ToolCallAccumulator();
    const call = feed(
      acc,
      'Here are the arguments:\n```json\n{"path": "index.html", "contents": "<h1>Gatti</h1>"}\n```',
    ) as { arguments: Record<string, unknown> };
    expect(call.arguments).toEqual({ path: "index.html", contents: "<h1>Gatti</h1>" });
  });

  it("returns an empty (valid) object when nothing was emitted", () => {
    const acc = new ToolCallAccumulator();
    const call = feed(acc, "") as { arguments: Record<string, unknown>; malformed?: boolean };
    expect(call.arguments).toEqual({});
    // empty emission = valid call with no args (tools with no required params)
    expect(call.malformed).toBe(false);
  });

  it("returns an empty object for malformed JSON without braces", () => {
    const acc = new ToolCallAccumulator();
    const call = feed(acc, "not json at all") as { arguments: Record<string, unknown>; malformed?: boolean };
    expect(call.arguments).toEqual({});
    expect(call.malformed).toBe(true);
  });

  it("flags the call malformed when structure is unparseable", () => {
    const acc = new ToolCallAccumulator();
    const call = feed(acc, "here is nonsense with no object") as { malformed?: boolean };
    expect(call.malformed).toBe(true);
  });

  it("repairs truncated JSON (unterminated string + unclosed object)", () => {
    const acc = new ToolCallAccumulator();
    const call = feed(acc, '{"path":"index.html","contents":"hi') as {
      arguments: Record<string, unknown>;
      malformed?: boolean;
    };
    expect(call.malformed).toBe(false);
    expect(call.arguments).toEqual({ path: "index.html", contents: "hi" });
  });

  it("repairs truncated JSON missing a closing brace", () => {
    const acc = new ToolCallAccumulator();
    const call = feed(acc, '{"path":"a.txt","contents":"b"') as {
      arguments: Record<string, unknown>;
      malformed?: boolean;
    };
    expect(call.malformed).toBe(false);
    expect(call.arguments).toEqual({ path: "a.txt", contents: "b" });
  });

  it("keeps N parallel calls that REUSE the same index (provider without index)", () => {
    const acc = new ToolCallAccumulator();
    // Three Delegate calls all emitted at index 0 (index omitted by the host).
    const first = acc.handle({ type: "tool_call_start", index: 0, id: "a", name: "Delegate" });
    acc.handle({ type: "tool_call_delta", index: 0, delta: '{"id":"A"}' });
    // A NEW start at the same index must FLUSH the previous call, not drop it.
    const second = acc.handle({ type: "tool_call_start", index: 0, id: "b", name: "Delegate" });
    acc.handle({ type: "tool_call_delta", index: 0, delta: '{"id":"B"}' });
    const third = acc.handle({ type: "tool_call_start", index: 0, id: "c", name: "Delegate" });
    acc.handle({ type: "tool_call_delta", index: 0, delta: '{"id":"C"}' });
    const last = acc.handle({ type: "tool_call_end", index: 0 });

    expect(first).toBeUndefined();
    expect(second).toMatchObject({ id: "a", arguments: { id: "A" } });
    expect(third).toMatchObject({ id: "b", arguments: { id: "B" } });
    expect(last).toMatchObject({ id: "c", arguments: { id: "C" } });
  });
});

describe("ToolCallAccumulator — `repaired` says HOW the arguments arrived", () => {
  // The agent pairs this flag with the turn's finish reason: repaired alone is a sloppy model
  // (tolerated, deliberate), repaired on a CUT turn is half an argument (refused). The parser is
  // the only place that knows which one happened, so it has to say it.

  const call = (raw: string): { repaired?: boolean; malformed?: boolean; arguments: Record<string, unknown> } =>
    feed(new ToolCallAccumulator(), raw) as never;

  it("is false when the JSON arrived complete", () => {
    expect(call('{"path":"a.txt"}')).toMatchObject({ malformed: false, repaired: false });
  });

  it("is false for an empty emission (a valid call with no arguments)", () => {
    expect(call("")).toMatchObject({ malformed: false, repaired: false });
  });

  it("is false for JSON wrapped in prose, which needs extraction but no rebuilding", () => {
    expect(call('Here you go:\n```json\n{"path":"a.txt"}\n```')).toMatchObject({ malformed: false, repaired: false });
  });

  it("is true when the fragment had to be rebuilt (unterminated string)", () => {
    expect(call('{"path":"a.txt","contents":"half a sen')).toMatchObject({ malformed: false, repaired: true });
  });

  it("is true when the fragment had to be rebuilt (missing closing brace)", () => {
    expect(call('{"path":"a.txt","contents":"b"')).toMatchObject({ malformed: false, repaired: true });
  });

  it("is false when nothing could be parsed at all (that is `malformed`, a different fact)", () => {
    expect(call("no object here")).toMatchObject({ malformed: true, repaired: false });
  });

  it("survives the flush path (a provider that REUSES the index)", () => {
    const acc = new ToolCallAccumulator();
    acc.handle({ type: "tool_call_start", index: 0, id: "a", name: "Write" });
    acc.handle({ type: "tool_call_delta", index: 0, delta: '{"path":"a.txt","contents":"half' });

    const flushed = acc.handle({ type: "tool_call_start", index: 0, id: "b", name: "Write" });

    expect(flushed).toMatchObject({ id: "a", repaired: true, malformed: false });
  });
});
