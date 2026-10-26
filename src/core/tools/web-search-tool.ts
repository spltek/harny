import type { HttpClient } from "../llm/http-client";
import { describeFetchError } from "./url-utils";
import type { Tool, ToolDefinition, ToolResult } from "./tool";

export class WebSearchTool implements Tool {
  readonly name = "WebSearch";
  /** Read-only for Analyze, but NOT cacheable: the world moves between two identical calls. */
  readonly analyzePolicy = "read-only" as const;
  readonly definition: ToolDefinition = {
    name: "WebSearch",
    description:
      "Search web for real-time info on any topic; use for up-to-date facts not in training data, like current events or tech updates. Returns short text snippets from the top results.",
    parameters: {
      type: "object",
      properties: {
        search_term: {
          type: "string",
          description: "The search term to look up on the web. Be specific and include relevant keywords.",
        },
        explanation: {
          type: "string",
          description:
            "One sentence explanation as to why this tool is being used, and how it contributes to the goal.",
        },
      },
      required: ["search_term"],
    },
  };

  constructor(private http: HttpClient) {}

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const searchTerm = args.search_term as string | undefined;
    if (!searchTerm) {
      return {
        content:
          'Tool WebSearch requires the argument "search_term" (string). Call again with {"search_term": "what to search"}.',
        isError: true,
      };
    }

    try {
      // DuckDuckGo's HTML search (no API key needed)
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchTerm)}`;
      const resp = await this.http.get(
        url,
        {
          "User-Agent": "Harny/0.1 (VS Code AI Coding Harness)",
          Accept: "text/html",
        },
        AbortSignal.timeout(10000),
      );

      const html = await resp.text();
      const snippets: string[] = [];
      const snippetRegex = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      let match: RegExpExecArray | null;
      while ((match = snippetRegex.exec(html)) !== null) {
        const text = match[1].replace(/<[^>]*>/g, "").trim();
        if (text && !snippets.includes(text)) snippets.push(text);
        if (snippets.length >= 5) break;
      }

      if (snippets.length === 0) {
        return { content: `No results found for: ${searchTerm}`, isError: false };
      }

      const explanation = args.explanation as string | undefined;
      const result = `## Web Search: "${searchTerm}"\n${explanation ? `\n_${explanation}_\n` : ""}\n${snippets
        .map((s, i) => `${i + 1}. ${s}`)
        .join("\n\n")}`;
      return { content: result, isError: false };
    } catch (err: unknown) {
      return { content: `WebSearch error: ${describeFetchError(err)}`, isError: true };
    }
  }
}
