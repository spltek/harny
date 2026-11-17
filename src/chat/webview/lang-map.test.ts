import { describe, it, expect } from "vitest";
import Prism from "./prism";
import { langIdForPath, langIdForFence } from "./lang-map";

/**
 * The tables below ARE the specification, entry by entry, and they are exhaustive on purpose: a
 * mutation run of this module showed the cost of testing the mapping by example — blanking the
 * value of any alias a test never mentioned (23 of them) changed nothing anybody could see. The
 * last test closes the other half: an id is only worth mapping if the bundle really has its
 * grammar, which is what makes `highlightToHtml` colour the block instead of returning null.
 */
const EXTENSION_TABLE: Array<[string, string]> = [
  ["ts", "typescript"],
  ["tsx", "typescript"],
  ["mts", "typescript"],
  ["cts", "typescript"],
  ["js", "javascript"],
  ["jsx", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["py", "python"],
  ["pyi", "python"],
  ["rs", "rust"],
  ["cs", "csharp"],
  ["html", "markup"],
  ["htm", "markup"],
  ["css", "css"],
  ["json", "json"],
  ["jsonc", "json"],
  ["md", "markdown"],
  ["markdown", "markdown"],
  ["sh", "bash"],
  ["bash", "bash"],
  ["zsh", "bash"],
  ["sql", "sql"],
  ["go", "go"],
];

const FENCE_TABLE: Array<[string, string]> = [
  ["ts", "typescript"],
  ["typescript", "typescript"],
  ["js", "javascript"],
  ["jsx", "javascript"],
  ["javascript", "javascript"],
  ["py", "python"],
  ["python", "python"],
  ["rs", "rust"],
  ["rust", "rust"],
  ["cs", "csharp"],
  ["csharp", "csharp"],
  ["c#", "csharp"],
  ["sh", "bash"],
  ["bash", "bash"],
  ["zsh", "bash"],
  ["shell", "bash"],
  ["shellscript", "bash"],
  ["console", "bash"],
  ["html", "markup"],
  ["htm", "markup"],
  ["xml", "markup"],
  ["css", "css"],
  ["json", "json"],
  ["jsonc", "json"],
  ["md", "markdown"],
  ["markdown", "markdown"],
  ["sql", "sql"],
  ["go", "go"],
  ["golang", "go"],
];

describe("langIdForPath", () => {
  it("maps common code extensions to their Prism language id", () => {
    expect(langIdForPath("a.cs")).toBe("csharp");
    expect(langIdForPath("/deep/path/Program.cs")).toBe("csharp");
    expect(langIdForPath("a.ts")).toBe("typescript");
    expect(langIdForPath("a.tsx")).toBe("typescript");
    expect(langIdForPath("a.js")).toBe("javascript");
    expect(langIdForPath("a.py")).toBe("python");
    expect(langIdForPath("a.rs")).toBe("rust");
    expect(langIdForPath("a.html")).toBe("markup");
    expect(langIdForPath("a.css")).toBe("css");
    expect(langIdForPath("a.json")).toBe("json");
    expect(langIdForPath("a.md")).toBe("markdown");
    expect(langIdForPath("a.sh")).toBe("bash");
    expect(langIdForPath("a.sql")).toBe("sql");
    expect(langIdForPath("a.go")).toBe("go");
  });

  it("is case-insensitive on the extension", () => {
    expect(langIdForPath("a.CS")).toBe("csharp");
    expect(langIdForPath("A.TS")).toBe("typescript");
  });

  it("cannot be answered by the prototype chain (a file can be named anything)", () => {
    expect(langIdForPath("a.__proto__")).toBeUndefined();
    expect(langIdForPath("a.constructor")).toBeUndefined();
  });

  it("maps EVERY extension in the table (no entry is decoration)", () => {
    for (const [ext, id] of EXTENSION_TABLE) {
      expect(langIdForPath(`/deep/file.${ext}`), `.${ext}`).toBe(id);
    }
  });

  it("returns undefined for unknown / extension-less / dotfile paths", () => {
    expect(langIdForPath("a.txt")).toBeUndefined();
    expect(langIdForPath("Makefile")).toBeUndefined();
    expect(langIdForPath(".env")).toBeUndefined();
    expect(langIdForPath("a.")).toBeUndefined();
    expect(langIdForPath("path/without/ext")).toBeUndefined();
  });

  it("a dotfile is a NAME, not an extension — even when the name IS a language", () => {
    // The case that separates the two halves of the rule: `.ts` has no extension to read
    // (the dot is the first character), and a path guard that only asked "is there a dot?" would
    // answer `typescript` and colour a shell profile as TypeScript.
    expect(langIdForPath(".ts")).toBeUndefined();
    expect(langIdForPath("/home/me/.json")).toBeUndefined();
  });

  it("reads the LAST dot: a double extension is not the language", () => {
    expect(langIdForPath("a.min.js")).toBe("javascript");
    expect(langIdForPath("a.d.ts")).toBe("typescript");
  });
});

describe("langIdForFence", () => {
  it("accepts an extension-shaped label", () => {
    expect(langIdForFence("ts")).toBe("typescript");
    expect(langIdForFence("py")).toBe("python");
    expect(langIdForFence("sh")).toBe("bash");
  });

  it("accepts the LONG name of the same languages (what a model actually writes)", () => {
    expect(langIdForFence("typescript")).toBe("typescript");
    expect(langIdForFence("javascript")).toBe("javascript");
    expect(langIdForFence("jsx")).toBe("javascript");
    expect(langIdForFence("shell")).toBe("bash");
    expect(langIdForFence("console")).toBe("bash");
    expect(langIdForFence("csharp")).toBe("csharp");
    expect(langIdForFence("c#")).toBe("csharp");
    expect(langIdForFence("xml")).toBe("markup");
    expect(langIdForFence("golang")).toBe("go");
  });

  it("is case-insensitive and trims the label", () => {
    expect(langIdForFence(" TS ")).toBe("typescript");
    expect(langIdForFence("TypeScript")).toBe("typescript");
  });

  it("returns undefined for a language the bundle has no grammar for", () => {
    expect(langIdForFence(undefined)).toBeUndefined();
    expect(langIdForFence("")).toBeUndefined();
    expect(langIdForFence("   ")).toBeUndefined();
    expect(langIdForFence("mermaid")).toBeUndefined();
    expect(langIdForFence("diff")).toBeUndefined();
    expect(langIdForFence("yaml")).toBeUndefined();
  });

  it("cannot be answered by the prototype chain (the label is model-written)", () => {
    expect(langIdForFence("__proto__")).toBeUndefined();
    expect(langIdForFence("constructor")).toBeUndefined();
  });

  it("maps EVERY fence label in the table (no alias is decoration)", () => {
    for (const [label, id] of FENCE_TABLE) {
      expect(langIdForFence(label), label).toBe(id);
    }
  });
});

describe("the ids the maps return", () => {
  it("are all languages the BUNDLE has a grammar for", () => {
    // The half a table of ids cannot check: an id with no grammar is a surface that silently stays
    // plain. It is one `Prism.languages` lookup — the same one `highlightToHtml` makes.
    const ids = new Set([...EXTENSION_TABLE, ...FENCE_TABLE].map(([, id]) => id));
    for (const id of ids) {
      expect(Object.prototype.hasOwnProperty.call(Prism.languages, id), id).toBe(true);
      expect(Prism.languages[id], id).toBeTruthy();
    }
  });
});
