// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown";

/** The rendered HTML's TEXT, i.e. what the reader actually gets after the tokens are unwrapped. */
function textOf(html: string): string {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  return holder.textContent ?? "";
}

describe("renderMarkdown (markdown-it + DOMPurify)", () => {
  it("turns single newlines into <br> (no pre-wrap on markdown bubbles)", () => {
    const html = renderMarkdown("line one\nline two");
    expect(html).toContain("<br>");
    // paragraphs from blank lines stay clean blocks, not ghost double-breaks
    const blocks = renderMarkdown("a paragraph\n\nanother paragraph");
    expect(blocks.match(/<p>/g)?.length).toBe(2);
  });

  it("renders multi-column tables", () => {
    const md = [
      "| File Name | Size | Modified |",
      "|-----------|-----------|---------------|",
      "| hello.txt | 11 B | 08/08/2025 17:44 |",
      "| pluto.txt | 12 B | 08/08/2025 17:45 |",
    ].join("\n");

    const html = renderMarkdown(md);

    expect(html).toContain('<div class="table-scroll"><table>');
    expect(html).toContain("<th>File Name</th>");
    expect(html).toContain("<th>Modified</th>");
    expect(html).toContain("<td>hello.txt</td>");
    expect(html).toContain("<td>pluto.txt</td>");
    expect(html).not.toContain("-----------");
  });

  it("renders tables with alignment colons", () => {
    const html = renderMarkdown("| a | b |\n|:--|--:|\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toMatch(/>1</);
    expect(html).toMatch(/>2</);
  });

  it("does not treat a single pipe line as a table", () => {
    expect(renderMarkdown("| not a table")).not.toContain("<table>");
  });

  it("renders fenced code blocks with a language label", () => {
    const html = renderMarkdown("```ts\nconst x = <T>(a: string) => a;\n```");
    expect(html).toContain('<div class="code-block">');
    expect(html).toContain('<div class="code-lang">ts</div>');
    // The body is COLOURED now, so `<T>` can be split across token spans: what has to survive is
    // the TEXT and the escaping of the markup inside it.
    expect(textOf(html)).toContain("const x = <T>(a: string) => a;");
    expect(html).not.toContain("<T>");
  });

  it("colours a fenced block whose language the bundle knows", () => {
    const html = renderMarkdown("```ts\nconst a = 1;\n```");
    expect(html).toContain('class="token keyword"');
  });

  it("keeps a fence the bundle has no grammar for PLAIN (no invented keywords)", () => {
    const html = renderMarkdown("```mermaid\ngraph TD; a-->b\n```");
    expect(html).toContain('<div class="code-lang">mermaid</div>');
    expect(html).not.toContain("token"); // a colour here would be a claim nobody can make
    expect(textOf(html)).toContain("graph TD; a-->b");
  });

  it("labels a fence whose name is not a word (c++, c#) without unbalancing the wrapper", () => {
    const html = renderMarkdown("```c++\nint main() {}\n```");
    expect(html).toContain('<div class="code-lang">c++</div>');
    // The label regex used to be `\\w+`, so `c++` fell through to the bare `<pre><code>` rule and
    // left a closing `</div>` with no opening tag: the count is the cheapest proof it cannot.
    expect((html.match(/<div/g) ?? []).length).toBe((html.match(/<\/div>/g) ?? []).length);
  });

  it("never processes markdown inside code blocks", () => {
    const html = renderMarkdown("```\n- not a list\n# not a heading\n| not a table |\n```");
    expect(html).toContain("- not a list");
    expect(html).toContain("# not a heading");
    expect(html).toContain("| not a table |");
    expect(html).not.toContain("<ul>");
  });

  it("escapes raw HTML (XSS safety)", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("never creates a link for javascript: URLs", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain("<a");
    expect(html).not.toMatch(/href=.["']?javascript:/i);
  });

  it("renders bold, italic and strikethrough", () => {
    const html = renderMarkdown("**bold** *italic* ~~deleted~~");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<s>deleted</s>");
  });

  it("renders headings and lists", () => {
    const html = renderMarkdown("# Title\n\n- one\n- two\n\n1. first\n2. second");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>first</li>");
  });

  it("renders task lists with checkboxes", () => {
    const html = renderMarkdown("- [x] done\n- [ ] to do");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("done");
    expect(html).toContain("to do");
  });

  it("renders links and auto-links bare URLs", () => {
    const html = renderMarkdown("[harny](https://example.com) and https://example.net");
    expect(html).toContain('<a href="https://example.com">harny</a>');
    expect(html).toContain('<a href="https://example.net">https://example.net</a>');
  });

  it("renders inline code", () => {
    const html = renderMarkdown("usare `const a = 1`");
    expect(html).toContain("<code>const a = 1</code>");
  });

  it("renders blockquotes and horizontal rules", () => {
    const html = renderMarkdown("> quote\n\n---");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("quote");
    expect(html).toContain("<hr>");
  });
});
