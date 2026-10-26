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
