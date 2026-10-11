import { describe, it, expect } from "vitest";
import { TodoTool } from "./todo-tool";
import { WebSearchTool } from "./web-search-tool";
import { WebFetchTool } from "./web-fetch-tool";
import { ReadLintsTool } from "./read-lints-tool";
import type { HttpClient, HttpResponse } from "../llm/http-client";
import type { DiagnosticsProvider } from "./diagnostics-provider";

describe("TodoTool", () => {
  it("creates a task list", () => {
    const tool = new TodoTool();
    const result = tool.execute({
      todos: [
        { id: "1", content: "fix bug", status: "pending" },
        { id: "2", content: "ship", status: "in_progress" },
      ],
      merge: false,
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("⏳ [pending] fix bug");
    expect(result.content).toContain("🔄 [in_progress] ship");
  });

  it("merges by id when merge is true", () => {
    const tool = new TodoTool();
    tool.execute({ todos: [{ id: "1", content: "a", status: "pending" }], merge: false });
    const result = tool.execute({
      todos: [{ id: "1", content: "a", status: "completed" }],
      merge: true,
    });

    expect(result.content).toContain("✅ [completed] a");
  });

  it("errors when todos is missing", () => {
    const tool = new TodoTool();
    expect(tool.execute({}).isError).toBe(true);
  });

  it("keeps PER-owner lists: concurrent sub-agents never clobber each other", () => {
    const tool = new TodoTool();
    const a = tool.execute({ todos: [{ id: "1", content: "alpha", status: "pending" }], merge: false }, { ownerId: "sub-a" });
    expect(a.content).toContain("alpha");
    // A different owner (another sub-agent / session) has its OWN list.
    const b = tool.execute({ todos: [{ id: "1", content: "beta", status: "pending" }], merge: false }, { ownerId: "sub-b" });
    expect(b.content).toContain("beta");
    // Updating A's list leaves B's untouched.
    const a2 = tool.execute({ todos: [{ id: "1", content: "alpha", status: "completed" }], merge: true }, { ownerId: "sub-a" });
    expect(a2.content).toContain("✅ [completed] alpha");
    expect(a2.content).not.toContain("beta");
    const b2 = tool.execute({ todos: [{ id: "1", content: "beta", status: "pending" }], merge: true }, { ownerId: "sub-b" });
    expect(b2.content).toContain("beta");
    expect(b2.content).not.toContain("alpha");
  });

  it("bounds the per-owner state map (LRU) so long sessions do not leak", () => {
    const tool = new TodoTool();
    // Seed the FIRST owner's list, then touch many later owners to evict it.
    tool.execute({ todos: [{ id: "1", content: "first-item", status: "pending" }], merge: false }, { ownerId: "first" });
    for (let i = 0; i < 250; i++) {
      tool.execute({ todos: [{ id: "x", content: "x", status: "pending" }], merge: false }, { ownerId: `o${i}` });
    }
    // "first" was evicted: a merge starts from an EMPTY list (no stale "first-item").
    const res = tool.execute({ todos: [{ id: "2", content: "second-item", status: "pending" }], merge: true }, { ownerId: "first" });
    expect(res.content).not.toContain("first-item");
    expect(res.content).toContain("second-item");
  });
});

function httpResponse(body: string, headers: Record<string, string> = {}): HttpResponse {
  return {
    ok: true,
    status: 200,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
    body: null,
  };
}

describe("WebSearchTool", () => {
  it("extracts snippets from DuckDuckGo HTML", async () => {
    const html =
      '<a class="result__snippet">First <b>result</b> here</a> junk <a class="result__snippet">Second result</a>';
    const http: HttpClient = {
      get: async () => httpResponse(html),
      post: async () => {
        throw new Error("no post");
      },
    };
    const tool = new WebSearchTool(http);

    const result = await tool.execute({ search_term: "typescript" });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("1. First result here");
    expect(result.content).toContain("2. Second result");
  });

  it("errors on missing search_term", async () => {
    const tool = new WebSearchTool({
      get: async () => {
        throw new Error("should not be called");
      },
      post: async () => {
        throw new Error("no post");
      },
    });
    expect((await tool.execute({})).isError).toBe(true);
  });
});

describe("WebFetchTool", () => {
  it("strips HTML tags from fetched content", async () => {
    const http: HttpClient = {
      get: async () => httpResponse("<html><body><h1>Title</h1><p>Hello <b>world</b></p></body></html>", { "content-type": "text/html" }),
      post: async () => {
        throw new Error("no post");
      },
    };
    const tool = new WebFetchTool(http);

    const result = await tool.execute({ url: "https://example.com" });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Title");
    expect(result.content).toContain("Hello world");
    expect(result.content).not.toContain("<b>");
  });

  it("normalizes protocol-less URLs to https", async () => {
    let requestedUrl = "";
    const http: HttpClient = {
      get: async (url) => {
        requestedUrl = url;
        return httpResponse("<html><body>ok</body></html>", { "content-type": "text/html" });
      },
      post: async () => {
        throw new Error("no post");
      },
    };
    const tool = new WebFetchTool(http);

    const result = await tool.execute({ url: "www.spltek.com" });

    expect(result.isError).toBe(false);
    expect(requestedUrl).toBe("https://www.spltek.com");
  });

  it("formats JSON responses as code blocks", async () => {
    const http: HttpClient = {
      get: async () => httpResponse('{"a":1}', { "content-type": "application/json" }),
      post: async () => {
        throw new Error("no post");
      },
    };
    const tool = new WebFetchTool(http);

    const result = await tool.execute({ url: "https://api.example.com/x" });

    expect(result.content).toContain("```json");
    expect(result.content).toContain('"a": 1');
  });

  it("reports redirects: final URL when it differs from the requested one", async () => {
    const http: HttpClient = {
      get: async () => ({ ...httpResponse("<html><body>landed</body></html>", { "content-type": "text/html" }), url: "https://final.example/page2" }),
      post: async () => {
        throw new Error("no post");
      },
    };
    const tool = new WebFetchTool(http);

    const result = await tool.execute({ url: "https://api.example.com/page1" });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("## Fetched: https://final.example/page2 (redirected from https://api.example.com/page1)");
  });
});

describe("ReadLintsTool", () => {
  const cwd = () => "/workspace";

  it("returns all diagnostics when no paths are given", async () => {
    const diagnostics: DiagnosticsProvider = {
      getDiagnostics: () => [
        {
          uri: "/workspace/a.ts",
          diagnostics: [{ severity: 0, message: "syntax error", line: 2, character: 4 }],
        },
      ],
    };
    const tool = new ReadLintsTool(diagnostics, cwd);

    const result = await tool.execute({});

    expect(result.isError).toBe(false);
    expect(result.content).toContain("a.ts");
    expect(result.content).toContain("[ERROR] L3:5 - syntax error");
    expect(result.content).toContain("1 error(s), 0 warning(s)");
  });

  it("filters by path", async () => {
    const diagnostics: DiagnosticsProvider = {
      getDiagnostics: () => [
        { uri: "/workspace/a.ts", diagnostics: [{ severity: 1, message: "warn a", line: 0, character: 0 }] },
        { uri: "/workspace/b.ts", diagnostics: [{ severity: 0, message: "err b", line: 0, character: 0 }] },
      ],
    };
    const tool = new ReadLintsTool(diagnostics, cwd);

    const result = await tool.execute({ paths: ["a.ts"] });

    expect(result.content).toContain("warn a");
    expect(result.content).not.toContain("err b");
  });

  it("returns no-errors message when clean", async () => {
    const diagnostics: DiagnosticsProvider = { getDiagnostics: () => [] };
    const tool = new ReadLintsTool(diagnostics, cwd);

    const result = await tool.execute({});

    expect(result.content).toContain("No linter errors found");
    // honest: files without an active language server produce no diagnostics,
    // so a zero may be absence of checking, not absence of errors.
    expect(result.content).toContain("active language server");
    expect(result.isError).toBe(false);
  });
});
