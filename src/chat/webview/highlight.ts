/**
 * ONE door for coloured code — the Diff section of a tool bubble, a tool's Input, an output whose
 * file language the panel actually KNOWS, and the fenced blocks of an answer all come through here.
 *
 * Two rules worth reading before changing anything.
 *
 * `null` means "leave the text alone", and that is a FEATURE. A colour is a CLAIM about what the
 * text is: `ls -la`, a grep listing, a log tail are not a language, and tokenizing them invents
 * keywords and strings that read as a rendering bug rather than as help. So every caller must be
 * able to say "I don't know" and get its plain `<pre>` back — which is the answer for every output
 * that is not a source file.
 *
 * The TEXT WINS over the colour: the HTML returned here has a `textContent` byte-identical to the
 * input, because Prism escapes everything it emits. That is not a detail — `extractPath()` reads a
 * tool's Input back with `JSON.parse`, so a highlighter that ate a quote or a backslash would
 * silently kill the Diff section of every bubble. `highlight.test.ts` pins that, not the colours.
 */
import Prism from "./prism";

/**
 * Above this, colour costs more than it explains: tokenizing is SYNCHRONOUS on the webview's
 * thread, and a rebuild of the transcript (a tab switch, a rewind) re-paints every bubble it
 * renders. A `Read` of a huge file — or a `Write` whose arguments carry the whole file — would make
 * a switch feel like a hang. It is the same 12000 the tool output is already cut at, so "what you
 * can see" and "what is coloured" cannot disagree.
 */
export const HIGHLIGHT_MAX_CHARS = 12_000;

/**
 * Tokenized HTML for `text`, or `null` when there is nothing honest to colour it with: no language,
 * no grammar for that language, a body over the budget, or nothing but whitespace.
 */
export function highlightToHtml(text: string, langId: string | undefined): string | null {
  if (!langId || !text.trim() || text.length > HIGHLIGHT_MAX_CHARS) return null;
  // `Prism.languages` is a plain object, and a fence label is MODEL-WRITTEN: `__proto__` would
  // resolve to the prototype and be handed to Prism as if it were a grammar. The own-property
  // check is the same one `langIdForFence` makes, repeated here because this is the door.
  if (!Object.prototype.hasOwnProperty.call(Prism.languages, langId)) return null;
  const grammar = Prism.languages[langId];
  return Prism.highlight(text, grammar, langId);
}
