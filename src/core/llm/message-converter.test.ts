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
      content: "cosa vedi?",
      images: ["data:image/png;base64,AAAA", "data:image/jpeg;base64,BBBB"],
    };
    const out = toOpenAIMessages([msg]);

    expect(out[0].content).toEqual([
      { type: "text", text: "cosa vedi?" },
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


});





describe("toOpenAIMessages tool_calls guard", () => {
  it("omits tool_calls when the array is empty (no Empty tool_calls error)", () => {
    const out = toOpenAIMessages([{ role: "assistant", content: "ok", toolCalls: [] }]);
    expect(out[0]).not.toHaveProperty("tool_calls");
  });

  it("includes tool_calls only when there is at least one", () => {
    const out = toOpenAIMessages([{ role: "assistant", content: "ok", toolCalls: [{ id: "c1", name: "Read", arguments: { path: "/x" } }] }]);
    expect((out[0] as any).tool_calls).toHaveLength(1);
  });
});
