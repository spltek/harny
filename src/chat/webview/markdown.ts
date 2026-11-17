import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import DOMPurify from "dompurify";
import { highlightToHtml } from "./highlight";
import { langIdForFence } from "./lang-map";

const md = new MarkdownIt({
  html: false, // raw HTML in the source is escaped, never rendered
  linkify: true, // auto-link bare URLs
  // Every source newline becomes a <br>: the webview bubbles are NOT
  // white-space:pre-wrap for markdown content, so without this the single
  // newlines inside a paragraph (model-written) would collapse to spaces.
  breaks: true,
  typographer: false,
  // Fenced code is tokenized HERE, where the language is still known and the body is still
  // SOURCE — post-render it is already escaped, and re-tokenizing escaped text is how a `&lt;`
  // ends up painted as a string. markdown-it asks for the body only and keeps its own
  // `<pre><code class="language-x">` wrapper, so `wrapCodeBlocks` still labels the block. The
  // empty string is markdown-it's "escape it yourself": the answer for every fence this bundle
  // has no grammar for (```mermaid, ```diff, a bare fence), which must stay plain.
  highlight: (code: string, lang: string): string => highlightToHtml(code, langIdForFence(lang)) ?? "",
});

md.use(taskLists, { label: true, enabled: true });

/**
 * Wrap markdown-it's `<pre><code>` output in the chat's `.code-block` div
 * (matching the existing webview CSS), keeping the language label.
 */
function wrapCodeBlocks(html: string): string {
  return html
    .replace(
      // Any fence label, not just `\w+`: `c++`, `c#` and `objective-c` are real labels, and a
      // regex that skipped them fell through to the rule below — which then matched only the
      // closing `</code></pre>` and left a `</div>` with no opening tag behind.
      /<pre><code class="language-([^\s"]+)">/g,
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
