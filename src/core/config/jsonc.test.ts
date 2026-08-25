import { describe, it, expect } from "vitest";
import { preprocessJsonc, setTopLevelString } from "./jsonc";

describe("preprocessJsonc", () => {
  it("removes line comments", () => {
    const out = preprocessJsonc('{\n  // api key\n  "a": 1\n}');
    expect(JSON.parse(out)).toEqual({ a: 1 });
  });

  it("removes block comments", () => {
    const out = preprocessJsonc('{ /* modello */ "a": "x" }');
    expect(JSON.parse(out)).toEqual({ a: "x" });
  });

  it("keeps // and /* inside strings", () => {
    const out = preprocessJsonc('{ "url": "https://example.com/x", "note": "a /* b */ c" }');
    expect(JSON.parse(out)).toEqual({ url: "https://example.com/x", note: "a /* b */ c" });
  });

  it("keeps escaped quotes inside strings", () => {
    const out = preprocessJsonc('{ "s": "say \\"hi\\"" }');
    expect(JSON.parse(out)).toEqual({ s: 'say "hi"' });
  });

  it("handles trailing comments without newline", () => {
    const out = preprocessJsonc('{ "a": 1 } // fine');
    expect(JSON.parse(out)).toEqual({ a: 1 });
  });
});

describe("preprocessJsonc trailing commas", () => {
  it("removes trailing commas after comments", () => {
    const out = preprocessJsonc('{"model": "m", // commento\n}');
    expect(JSON.parse(out)).toEqual({ model: "m" });
  });

  it("removes trailing commas in arrays and objects", () => {
    const out = preprocessJsonc('{ "a": [1, 2,], "b": {"c": 3,} }');
    expect(JSON.parse(out)).toEqual({ a: [1, 2], b: { c: 3 } });
  });

  it("keeps commas inside strings", () => {
    const out = preprocessJsonc('{ "note": "a, b" }');
    expect(JSON.parse(out)).toEqual({ note: "a, b" });
  });
});

describe("setTopLevelString", () => {
  it("replaces the top-level value preserving comments and formatting", () => {
    const input = `{\n  // chiave segreta\n  \"apiKey\": \"sk-x\",\n  \"model\": \"old-model\",  // modello scelto\n  \"nested\": { \"model\": \"untouched\" }\n}`;
    const out = setTopLevelString(input, "model", "LLM/qwen.gguf");
    expect(out).not.toContain("old-model");
    expect(out).toContain(`\"model\": \"LLM/qwen.gguf\"`);
    expect(out).toContain("// chiave segreta");
    expect(out).toContain("// modello scelto");
    expect(JSON.parse(preprocessJsonc(out))).toEqual({
      apiKey: "sk-x",
      model: "LLM/qwen.gguf",
      nested: { model: "untouched" },
    });
  });

  it("inserts a new top-level key after the opening brace", () => {
    const input = `{\n  \"apiKey\": \"sk-x\",\n  \"model\": \"m\"\n}`;
    const out = setTopLevelString(input, "provider", "llamacpp");
    expect(JSON.parse(preprocessJsonc(out))).toEqual({ apiKey: "sk-x", model: "m", provider: "llamacpp" });
  });

  it("handles an empty object", () => {
    const out = setTopLevelString("{}", "model", "m");
    expect(JSON.parse(out)).toEqual({ model: "m" });
  });

  it("escapes embedded quotes and slashes", () => {
    const input = '{ "model": "m", "note": "x" }';
    const out = setTopLevelString(input, "note", 'say \"hi\" /a/b');
    expect(JSON.parse(out)).toEqual({ model: "m", note: 'say "hi" /a/b' });
  });
});
