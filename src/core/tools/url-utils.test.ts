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
  it("unwraps the cause of a generic fetch failed error with a classified prefix", () => {
    const err = new TypeError("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND www.spltek.com"), { code: "ENOTFOUND" }),
    });
    expect(describeFetchError(err, "https://www.spltek.com")).toBe(
      "DNS resolution failed for www.spltek.com — check the domain name. [fetch failed: getaddrinfo ENOTFOUND www.spltek.com (ENOTFOUND)]",
    );
  });

  it("classifies a TCP timeout with host and port", () => {
    const err = new TypeError("fetch failed", {
      cause: Object.assign(new Error("fetch failed"), { code: "ETIMEDOUT" }),
    });
    const msg = describeFetchError(err, "https://slow.example:443");
    expect(msg).toContain("Connection to slow.example:443 timed out");
    expect(msg).toContain("(ETIMEDOUT)"); // raw detail kept
  });

  it("classifies TLS failures", () => {
    const err = new TypeError("fetch failed", {
      cause: Object.assign(new Error("unable to verify the first certificate"), {
        code: "DEPTH_ZERO_SELF_SIGNED_CERT",
      }),
    });
    const msg = describeFetchError(err, "https://self-signed.example");
    expect(msg).toContain("TLS handshake failed");
    expect(msg).toContain("unable to verify the first certificate");
  });

  it("passes through regular error messages", () => {
    expect(describeFetchError(new Error("boom"))).toBe("boom");
  });

  it("handles non-error values", () => {
    expect(describeFetchError("string err")).toBe("string err");
    expect(describeFetchError(undefined)).toBe("undefined");
  });
});
