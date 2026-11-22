/**
 * Icon registry — the ONLY place icon artwork enters Harny's code.
 *
 * The artwork lives as standalone files under media/icons/ (see the README
 * there): `ui/` is the chrome and the tool marks — buttons, chevrons, toggles,
 * and one mark per tool — and `glyphs/` are the semantic marks inside the
 * transcript. Redrawing a set means editing those files: no markup, no test and
 * no CSS change (the shapes use `currentColor`, so they keep following the
 * palette).
 *
 * The files are inlined at BUILD time, never fetched at runtime:
 *   - esbuild   → `loader: { ".svg": "text" }` (build/scripts/build-*.mjs, dev.mjs)
 *   - vitest    → the svg-as-text plugin in vitest.config.mts
 * So the bundles carry plain strings: no `asWebviewUri`, no CSP change, no
 * async load, and the jsdom tests see exactly the markup the panel renders.
 */
import plus from "../../media/icons/plus.svg";
import close from "../../media/icons/close.svg";
import pencil from "../../media/icons/pencil.svg";
import trash from "../../media/icons/trash.svg";
import branch from "../../media/icons/branch.svg";
import scissors from "../../media/icons/scissors.svg";
import play from "../../media/icons/play.svg";
import stop from "../../media/icons/stop.svg";
import chevronDown from "../../media/icons/chevron-down.svg";
import gear from "../../media/icons/gear.svg";
import paperclip from "../../media/icons/paperclip.svg";
import search from "../../media/icons/search.svg";
import sparkles from "../../media/icons/sparkles.svg";
import check from "../../media/icons/check.svg";
import parallel from "../../media/icons/parallel.svg";
import eye from "../../media/icons/eye.svg";
// One mark per tool: these are what a tool call wears in the transcript.
import read from "../../media/icons/read.svg";
import write from "../../media/icons/write.svg";
import strreplace from "../../media/icons/strreplace.svg";
import edit from "../../media/icons/edit.svg";
import shell from "../../media/icons/shell.svg";
import grep from "../../media/icons/grep.svg";
import glob from "../../media/icons/glob.svg";
import unknown from "../../media/icons/unknown.svg";
import skill from "../../media/icons/skill.svg";
import websearch from "../../media/icons/websearch.svg";
import webfetch from "../../media/icons/webfetch.svg";
import readlints from "../../media/icons/readlints.svg";
import mcp from "../../media/icons/mcp.svg";
import thinking from "../../media/icons/thinking.svg";
// The four states of a todo: one box, four baffi.
import subagent from "../../media/icons/subagent.svg";
// The two delivery modes of a pending message: steer cuts the line, queue waits at its end.
import listStart from "../../media/icons/list-start.svg";
import listEnd from "../../media/icons/list-end.svg";
import history from "../../media/icons/history.svg";
import harny from "../../media/icons/harny.svg";
// The brand's SQUARE frame — the activity bar and the view header, i.e. the one brand file VS
// Code paints itself (package.json points at it), never a mark the panel asks for. It rides in
// the registry so the folder stays ONE flat set and no test has to special-case a file.
import harnyApp from "../../media/icons/harny-app.svg";
import fileBadge from "../../media/icons/file-badge.svg";

/** Every icon the UI can ask for, keyed by the name the call sites use. */
const ARTWORK = {
  plus,
  close,
  pencil,
  trash,
  branch,
  scissors,
  play,
  stop,
  chevronDown,
  gear,
  paperclip,
  search,
  sparkles,
  check,
  parallel,
  eye,
  read,
  write,
  strreplace,
  edit,
  shell,
  grep,
  glob,
  unknown,
  skill,
  websearch,
  webfetch,
  readlints,
  mcp,
  thinking,
  subagent,
  listStart,
  listEnd,
  history,
  harny,
  harnyApp,
  fileBadge,
};

type IconName = keyof typeof ARTWORK;

/** Every icon name, in the order they are declared. Exported for the SUITE only: it is the
 * list the icon test walks to prove each mark renders and has artwork on disk, and inlining
 * that list in the test would silently stop covering an icon added here. No production
 * reader — this is the one export in this file that is deliberately test-facing. */
export const ICON_NAMES = Object.keys(ARTWORK) as IconName[];

/**
 * Tool name → artwork. The keys are the tool names as the registry spells them,
 * lowered and stripped of anything that is not a letter ("StrReplace" →
 * "strreplace"), so a call site can pass the raw name it already has.
 *
 * Delete is NOT a file of its own: it is the same drawing as the session trash
 * (media/icons/trash.svg), and one file means they can never drift apart.
 */
const TOOL_ARTWORK: Record<string, IconName> = {
  read: "read",
  write: "write",
  strreplace: "strreplace",
  edit: "edit",
  delete: "trash",
  shell: "shell",
  grep: "grep",
  glob: "glob",
  skill: "skill",
  websearch: "websearch",
  webfetch: "webfetch",
  readlints: "readlints",
  delegate: "subagent",
};

/**
 * The mark a tool call wears: `toolIcon("StrReplace")` → its artwork.
 *
 * Every tool exposed by an MCP server shares ONE mark (the plug): there can be
 * any number of them and a per-server drawing is not worth the noise.
 *
 * An unknown name wears the QUESTION badge (`media/icons/unknown.svg`). It used to
 * be the 🔧 emoji inside a span: the only "mark" in the panel that was not artwork
 * in media/icons/, drawn differently on every OS, unscalable by the sprite rules
 * and HONEST ONLY UP TO A POINT — it said "some tool" where the truth is "no tool".
 * A name nobody drew still needs a mark (an empty space in the header reads as a
 * broken icon), and a question says exactly what happened: the call named something
 * that does not exist here (see core/tools/unknown-tool.ts).
 */
export function toolIcon(name: string, size = 13): string {
  if (name.startsWith("mcp__")) return icon("mcp", size);
  const key = name.toLowerCase().replace(/[^a-z]/g, "");
  return icon(TOOL_ARTWORK[key] ?? "unknown", size);
}

/**
 * The mark for one todo status. All four share the same box and differ only in the
 * baffo inside: at 12px that is enough to tell them apart, and the shared box is
 * what makes them read as four states of one thing rather than four icons.
 */

/** The artwork is written for humans (one tag per line); the DOM only cares
 * about the drawing. Comments stay available for design notes, and the
 * whitespace BETWEEN elements goes away with them: an icon is inlined inside
 * text-bearing nodes (buttons, message bubbles), where a stray text node would
 * show up in `textContent` — a user prompt must stay "hi", never "hi    ". */
function flatten(markup: string): string {
  return markup
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>\s+</g, "><")
    .trim();
}

/**
 * Render one icon at `size` px, with optional extra root attributes:
 * `icon("gear", 14)` or `icon("sparkles", 12, 'class="hidden"')`.
 *
 * The artwork's own root attributes are KEPT (viewBox, fill, stroke-width…):
 * only what belongs to the CALLER is overridden — width/height (always the
 * requested size) and aria-hidden (icons are decorative here: the accessible
 * name always comes from the button or from the text next to the icon).
 *
 * An attribute in `attrs` OVERRIDES the artwork's own, so the same drawing can
 * live at two weights: the trash is 1.5 like every other tool mark, and the
 * session row — where it sits next to a 13px pencil at 2 — asks for 2 back.
 * Without this, one of the two families would have had to keep a copy of the
 * file, which is how two marks drift apart.
 */
export function icon(name: IconName, size = 14, attrs = ""): string {
  const raw = flatten(ARTWORK[name]);
  const open = /^<svg\b([^>]*)>/.exec(raw);
  // Defensive: a file without an <svg> root is passed through untouched.
  if (!open) return raw;
  const extra = attrs.trim() ? " " + attrs.trim() : "";
  // width/height/aria-hidden always belong to the caller; anything else only
  // when the caller actually passes it.
  const overridden = new Set([...attrs.matchAll(/([a-zA-Z-]+)\s*=/g)].map((m) => m[1]));
  // width/height are already gone (line above): what is left to DROP from the artwork is
  // `aria-hidden` — always the caller's — plus whatever this caller overrides.
  const drop = ["aria-hidden", ...overridden];
  let kept = open[1].replace(/\s(?:width|height)="[^"]*"/g, "");
  for (const attr of drop) {
    kept = kept.replace(new RegExp(`\\s${attr}="[^"]*"`, "g"), "");
  }
  const keptAttrs = kept.trimEnd();
  return `<svg${extra} width="${size}" height="${size}"${keptAttrs} aria-hidden="true">${raw.slice(open[0].length)}`;
}

/**
 * Document badge for a non-image attachment (message cards, attachment chips).
 * The extension label and its colour are DATA, so they are substituted into
 * the artwork template (media/icons/file-badge.svg) at render time.
 */
export function fileBadgeIcon(label: string, color: string, size = 44): string {
  const safeLabel = label.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return icon("fileBadge", size)
    .replace(/\{\{COLOR\}\}/g, color)
    .replace(/\{\{LABEL\}\}/g, safeLabel);
}
