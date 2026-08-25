import { describe, it, expect } from "vitest";
import { endpointUrl } from "./endpoint";

describe("endpointUrl", () => {
  it("appends /v1 when the base URL has no version prefix", () => {
    expect(endpointUrl("https://api.openai.com", "/chat/completions")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("does not duplicate /v1 when the base URL already includes it", () => {
    expect(endpointUrl("http://localhost:8090/v1", "/chat/completions")).toBe(
      "http://localhost:8090/v1/chat/completions",
    );
  });

  it("handles a trailing slash on the base URL", () => {
    expect(endpointUrl("http://localhost:8090/v1/", "/chat/completions")).toBe(
      "http://localhost:8090/v1/chat/completions",
    );
  });

  it("accepts paths without a leading slash", () => {
    expect(endpointUrl("https://api.openai.com", "responses")).toBe(
      "https://api.openai.com/v1/responses",
    );
  });
});
