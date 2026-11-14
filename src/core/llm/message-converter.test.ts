import { describe, it, expect } from "vitest";
import { toOpenAIMessages } from "./message-converter";
import type { LLMMessage } from "./types";

describe("toOpenAIMessages", () => {
  it("maps plain messages with string content", () => {
    const out = toOpenAIMessages([{ role: "user", content: "hello" }]);
    expect(out).toEqual([{ role: "user", content: "hello" }]);
  });

  it("builds multimodal content parts when images are present", () => {
    const msg: LLMMessage = {
      role: "user",
      content: "what do you see?",
      images: ["data:image/png;base64,AAAA", "data:image/jpeg;base64,BBBB"],
    };
    const out = toOpenAIMessages([msg]);

    expect(out[0].content).toEqual([
      { type: "text", text: "what do you see?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB" } },
    ]);
  });

  it("keeps tool call mappings intact alongside images", () => {
    const msg: LLMMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "Read", arguments: { path: "/x" } }],
    };
    const out = toOpenAIMessages([msg]);
    expect(out[0].tool_calls).toEqual([
      { id: "c1", type: "function", function: { name: "Read", arguments: '{"path":"/x"}' } },
    ]);
  });
});

describe("protocol-level message conversion (generalized rules)", () => {
  it("chat: passes reasoning_content back for assistant with thinking", () => {
    const out = toOpenAIMessages([{ role: "assistant", content: "answer", thinking: "reasoned" }]);
    expect(out[0].reasoning_content).toBe("reasoned");
  });

  it("chat: keeps no reasoning_content when there is no thinking", () => {
    const out = toOpenAIMessages([{ role: "assistant", content: "answer" }]);
    expect(out[0].reasoning_content).toBeUndefined();
  });

  it("chat: prefers reasoning_details over reasoning_content when both exist", () => {
    const details = [{ type: "reasoning.summary", summary: "full", format: "openai-responses-v1", index: 0 }];
    const out = toOpenAIMessages([
      { role: "assistant", content: "answer", thinking: "plain", reasoningDetails: details },
    ]);
    expect(out[0].reasoning_details).toEqual(details);
    expect(out[0].reasoning_content).toBeUndefined();
  });

  it("chat: ignores an empty reasoning_details array and falls back to reasoning_content", () => {
    const out = toOpenAIMessages([{ role: "assistant", content: "answer", thinking: "plain", reasoningDetails: [] }]);
    expect(out[0].reasoning_content).toBe("plain");
    expect(out[0].reasoning_details).toBeUndefined();
  });

  it("chat: never passes reasoning on non-assistant roles", () => {
    const out = toOpenAIMessages([
      { role: "user", content: "q", thinking: "x", reasoningDetails: [{ type: "reasoning.text" }] },
    ]);
    expect(out[0].reasoning_content).toBeUndefined();
    expect(out[0].reasoning_details).toBeUndefined();
  });

  it("chat: in the `reasoning` dialect an assistant with NO reasoning gets an EMPTY field", () => {
    // The upstream rejects the NEXT request when the field is missing
    // (`The reasoning_content in the thinking mode must be passed back to the API`), so an
    // empty string is sent instead of nothing — including for the synthetic state document a
    // compaction writes, and for turns made with a model that does not think.
    const out = toOpenAIMessages([{ role: "assistant", content: "answer" }], {
      alwaysPassBackReasoning: true,
    });
    expect(out[0].reasoning_content).toBe("");
  });

  it("chat: the empty pass-back never overwrites real reasoning nor reasoning_details", () => {
    const details = [{ type: "reasoning.text", text: "encrypted" }];
    const out = toOpenAIMessages(
      [
        { role: "assistant", content: "a", thinking: "reasoned" },
        { role: "assistant", content: "b", reasoningDetails: details },
      ],
      { alwaysPassBackReasoning: true },
    );
    expect(out[0].reasoning_content).toBe("reasoned");
    expect(out[1].reasoning_details).toEqual(details);
    expect(out[1].reasoning_content).toBeUndefined();
  });

  it("chat: the empty pass-back is NOT sent for other roles", () => {
    const out = toOpenAIMessages(
      [
        { role: "user", content: "q" },
        { role: "tool", content: "r", toolCallId: "c1" },
      ],
      { alwaysPassBackReasoning: true },
    );
    expect(out[0].reasoning_content).toBeUndefined();
    expect(out[1].reasoning_content).toBeUndefined();
  });
});

describe("toOpenAIMessages tool_calls guard", () => {
  it("omits tool_calls when the array is empty (no Empty tool_calls error)", () => {
    const out = toOpenAIMessages([{ role: "assistant", content: "ok", toolCalls: [] }]);
    expect(out[0]).not.toHaveProperty("tool_calls");
  });

  it("includes tool_calls only when there is at least one", () => {
    const out = toOpenAIMessages([
      { role: "assistant", content: "ok", toolCalls: [{ id: "c1", name: "Read", arguments: { path: "/x" } }] },
    ]);
    expect((out[0] as any).tool_calls).toHaveLength(1);
  });
});
