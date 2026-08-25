import type { HttpClient } from "../llm/http-client";
import { describeFetchError, normalizeUrl } from "./url-utils";
import type { Tool, ToolDefinition, ToolResult } from "./tool";

export class WebFetchTool implements Tool {
  readonly name = "WebFetch";
  readonly definition: ToolDefinition = {
    name: "WebFetch",
    description:
      "Fetch content from a specified URL and return its contents in a readable markdown format. Use this tool when you need to retrieve and analyze web content.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch. The content will be converted to a readable markdown format." },
      },
      required: ["url"],
    },
  };

  constructor(private http: HttpClient) {}

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const rawUrl = args.url as string | undefined;
    if (!rawUrl) {
      return {
        content: 'Tool WebFetch requires the argument "url" (string). Call again with {"url": "https://example.com"}.',
        isError: true,
      };
    }
    const url = normalizeUrl(rawUrl);

    try {
      const resp = await this.http.get(
        url,
        {
          "User-Agent": "Harny/0.1 (VS Code AI Coding Harness)",
          Accept: "text/html, text/plain, application/json",
        },
        AbortSignal.timeout(15000),
      );

      const contentType = resp.headers.get("content-type") || "";
      let content: string;

      if (contentType.includes("application/json")) {
        const json = (await resp.json()) as unknown;
        content = "```json\n" + JSON.stringify(json, null, 2) + "\n```";
      } else {
        const text = await resp.text();
        content = text
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]*>/g, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim()
          .slice(0, 10000);
      }

      return {
        content: `## Fetched: ${url}\nStatus: ${resp.status}\nType: ${contentType}\n\n${content}`,
        isError: false,
      };
    } catch (err: unknown) {
      return { content: `WebFetch error: ${describeFetchError(err)}`, isError: true };
    }
  }
}
