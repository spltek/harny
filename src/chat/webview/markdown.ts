import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import DOMPurify from "dompurify";

const md = new MarkdownIt({
  html: false, // raw HTML in the source is escaped, never rendered
  linkify: true, // auto-link bare URLs
  // Every source newline becomes a <br>: the webview bubbles are NOT
  // white-space:pre-wrap for markdown content, so without this the single
  // newlines inside a paragraph (model-written) would collapse to spaces.
  breaks: true,
  typographer: false,
});

md.use(taskLists, { label: true, enabled: true });

/**
 * Wrap markdown-it's `<pre><code>` output in the chat's `.code-block` div
 * (matching the existing webview CSS), keeping the language label.
 */
function wrapCodeBlocks(html: string): string {
  return html
    .replace(
      /<pre><code class="language-(\w+)">/g,
      '<div class="code-block"><div class="code-lang">$1</div><pre><code>',
    )
    .replace(/<pre><code>/g, '<div class="code-block"><pre><code>')
    .replace(/<\/code><\/pre>/g, "<\/code><\/pre><\/div>");
}

/**
 * Wrap markdown-it's `<table>` output in a `.table-scroll` container so wide
 * tables get a horizontal scrollbar instead of overflowing the bubble.
 */
function wrapTables(html: string): string {
  return html.replace(/<table>/g, '<div class="table-scroll"><table>').replace(/<\/table>/g, "</table></div>");
}

/**
 * Render untrusted LLM markdown to safe HTML:
 * markdown-it parses, then DOMPurify sanitizes the result.
 */
export function renderMarkdown(source: string): string {
  if (!source) return "";
  const html = wrapTables(wrapCodeBlocks(md.render(source)));
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
  });
}
