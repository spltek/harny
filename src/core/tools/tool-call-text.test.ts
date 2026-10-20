import { describe, it, expect } from "vitest";
import { describeToolCall, toolArgTarget, toolCallDetail } from "./tool-call-text";

describe("toolArgTarget", () => {
  it("reads the subject of each tool's call", () => {
    expect(toolArgTarget({ path: "src/a.ts" })).toBe("src/a.ts");
    expect(toolArgTarget({ glob_pattern: "**/*.ts" })).toBe("**/*.ts");
    expect(toolArgTarget({ command: "npm test" })).toBe("npm test");
    expect(toolArgTarget({ search_term: "vitest config" })).toBe("vitest config");
    expect(toolArgTarget({ url: "https://example.com" })).toBe("https://example.com");
    expect(toolArgTarget({ paths: ["a.ts", "b.ts"] })).toBe("a.ts, b.ts");
    expect(toolArgTarget({ todos: [{ id: "1", content: "do it", status: "pending" }] })).toBe("1 - do it - pending");
  });

  it("prefers the glob over the path (Glob carries both)", () => {
    expect(toolArgTarget({ path: "src", glob_pattern: "*.ts" })).toBe("*.ts");
  });

  it("returns undefined when there is nothing to name", () => {
    expect(toolArgTarget(undefined)).toBeUndefined();
    expect(toolArgTarget({})).toBeUndefined();
    expect(toolArgTarget({ paths: [] })).toBeUndefined();
    expect(toolArgTarget({ todos: [] })).toBeUndefined();
  });
});

describe("toolCallDetail", () => {
  it("measures a Write in LINES, never in bytes", () => {
    expect(toolCallDetail("Write", { path: "a.ts", contents: "one\ntwo\nthree" })).toBe("(3 lines)");
    expect(toolCallDetail("Write", { path: "a.ts", contents: "solo" })).toBe("(1 line)");
  });

  it("measures an Edit as lines moved, for BOTH spellings of the arguments", () => {
    // Edit calls it oldText/newText…
    expect(toolCallDetail("Edit", { path: "a.ts", oldText: "x", newText: "y\nz" })).toBe("(+2/-1)");
    // …StrReplace calls it old_string/new_string.
    expect(toolCallDetail("StrReplace", { path: "a.ts", old_string: "a\nb", new_string: "c" })).toBe("(+1/-2)");
  });

  it("names the sub-agent and flattens its goal", () => {
    expect(toolCallDetail("Delegate", { id: "auth", goal: "Split  the\n  auth module" })).toBe('"auth" → Split the auth module');
    expect(toolCallDetail("Delegate", { goal: "no id" })).toBe("→ no id");
  });

  it("adds nothing where the subject already says it (Read, Grep)", () => {
    expect(toolCallDetail("Read", { path: "a.ts" })).toBeUndefined();
    expect(toolCallDetail("Grep", { pattern: "x" })).toBeUndefined();
    expect(toolCallDetail("Shell", { command: "ls" })).toBeUndefined();
  });
});

describe("describeToolCall", () => {
  it("is one line: name, subject, size", () => {
    expect(describeToolCall("Write", { path: "src/a.ts", contents: "a\nb" })).toBe("Write src/a.ts (2 lines)");
    expect(describeToolCall("Shell", { command: "npm test" })).toBe("Shell npm test");
    expect(describeToolCall("Read", { path: "src/a.ts" })).toBe("Read src/a.ts");
    expect(describeToolCall("Edit", { path: "a.ts", oldText: "x", newText: "x" })).toBe("Edit a.ts (+1/-1)");
  });

  it("NEVER leaks the payload — a Write's contents stay out of the line", () => {
    const contents = "SECRET_MARKER\n".repeat(500);
    const line = describeToolCall("Write", { path: "a.ts", contents });
    expect(line).toBe("Write a.ts (500 lines)");
    expect(line).not.toContain("SECRET_MARKER");
    // And it stays ONE line however big the payload is.
    expect(line.split("\n")).toHaveLength(1);
  });

  it("caps the subject, so a 40-path or 50-todo dump cannot fill the span", () => {
    const paths = Array.from({ length: 40 }, (_, i) => `src/some/long/path/file-${i}.ts`);
    const line = describeToolCall("ReadLints", { paths });
    expect(line.length).toBeLessThan(140);
    expect(line.endsWith("…")).toBe(true);
  });

  it("degrades to the bare name when there is nothing to add", () => {
    expect(describeToolCall("ReadLints", {})).toBe("ReadLints");
    expect(describeToolCall("Read", undefined)).toBe("Read");
  });
});
