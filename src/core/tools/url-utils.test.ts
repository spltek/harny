import { describe, it, expect } from "vitest";
import { describeFetchError, normalizeUrl } from "./url-utils";

describe("normalizeUrl", () => {
  it("prepends https:// when the protocol is missing", () => {
    expect(normalizeUrl("www.spltek.com")).toBe("https://www.spltek.com");
    expect(normalizeUrl("spltek.com/contatti")).toBe("https://spltek.com/contatti");
  });

  it("keeps URLs that already have a protocol", () => {
    expect(normalizeUrl("http://www.spltek.com")).toBe("http://www.spltek.com");
    expect(normalizeUrl("https://www.spltek.com")).toBe("https://www.spltek.com");
  });

  it("handles empty input", () => {
    expect(normalizeUrl("")).toBe("");
    expect(normalizeUrl("  ")).toBe("");
  });
});

describe("describeFetchError", () => {
  it("unwraps the cause of a generic fetch failed error", () => {
    const err = new TypeError("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND www.spltek.com"), { code: "ENOTFOUND" }),
    });
    expect(describeFetchError(err)).toBe("fetch failed: getaddrinfo ENOTFOUND www.spltek.com (ENOTFOUND)");
  });

  it("passes through regular error messages", () => {
    expect(describeFetchError(new Error("boom"))).toBe("boom");
  });

  it("handles non-error values", () => {
    expect(describeFetchError("string err")).toBe("string err");
    expect(describeFetchError(undefined)).toBe("undefined");
  });
});
