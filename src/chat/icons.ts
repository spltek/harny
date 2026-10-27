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
 *   - esbuild   → `loader: { ".svg": "text" }` (scripts/build-*.mjs, dev.mjs)
 *   - vitest    → the svg-as-text plugin in vitest.config.mts
 * So the bundles carry plain strings: no `asWebviewUri`, no CSP change, no
 * async load, and the jsdom tests see exactly the markup the panel renders.
 */
import plus from "../../media/icons/plus.svg";
import minus from "../../media/icons/minus.svg";
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
import model from "../../media/icons/model.svg";
import eye from "../../media/icons/eye.svg";
// One mark per tool: these are what a tool call wears in the transcript.
import read from "../../media/icons/read.svg";
import write from "../../media/icons/write.svg";
import strreplace from "../../media/icons/strreplace.svg";
import edit from "../../media/icons/edit.svg";
import shell from "../../media/icons/shell.svg";
import grep from "../../media/icons/grep.svg";
import glob from "../../media/icons/glob.svg";
import skill from "../../media/icons/skill.svg";
import todowrite from "../../media/icons/todowrite.svg";
import websearch from "../../media/icons/websearch.svg";
import webfetch from "../../media/icons/webfetch.svg";
import readlints from "../../media/icons/readlints.svg";
import mcp from "../../media/icons/mcp.svg";
import thinking from "../../media/icons/thinking.svg";
// The four states of a todo: one box, four baffi.
import todoPending from "../../media/icons/todo-pending.svg";
import todoActive from "../../media/icons/todo-active.svg";
import todoDone from "../../media/icons/todo-done.svg";
import todoCancelled from "../../media/icons/todo-cancelled.svg";
import subagent from "../../media/icons/subagent.svg";
import history from "../../media/icons/history.svg";
import fileBadge from "../../media/icons/file-badge.svg";

/** Every icon the UI can ask for, keyed by the name the call sites use. */
const ARTWORK = {
  plus,
  minus,
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
  model,
  eye,
  read,
  write,
  strreplace,
  edit,
  shell,
  grep,
  glob,
  skill,
  todowrite,
  websearch,
  webfetch,
  readlints,
  mcp,
  thinking,
  todoPending,
  todoActive,
  todoDone,
  todoCancelled,
  subagent,
  history,
  fileBadge,
};

export type IconName = keyof typeof ARTWORK;

/** The registered names, in the order they are declared (tests walk this). */
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
  todowrite: "todowrite",
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
 * An unknown name returns the wrench it always had: a tool we have not drawn yet
 * must still be recognisable as "some tool", and silently rendering nothing
 * would leave an empty space in the header. The wrench carries its OWN trailing
 * space — it is text, and the flex `gap` that separates an <svg> from the name
 * does not exist for it.
 */
export function toolIcon(name: string, size = 13): string {
  if (name.startsWith("mcp__")) return icon("mcp", size);
  const key = name.toLowerCase().replace(/[^a-z]/g, "");
  const artwork = TOOL_ARTWORK[key];
  // The fallback is TEXT (an emoji), not an SVG: it needs its own hook so the head icons can all
  // be painted at the same size by the stylesheet (a bare glyph could not be targeted).
  if (!artwork) return '<span class="tool-emoji">🔧</span> ';
  return icon(artwork, size);
}

/** A todo's status, as the TodoWrite tool spells it. */
export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

/**
 * The mark for one todo status. All four share the same box and differ only in the
 * baffo inside: at 12px that is enough to tell them apart, and the shared box is
 * what makes them read as four states of one thing rather than four icons.
 */
export function todoStatusIcon(status: TodoStatus, size = 12): string {
  const artwork: IconName =
    status === "completed"
      ? "todoDone"
      : status === "in_progress"
        ? "todoActive"
        : status === "cancelled"
          ? "todoCancelled"
          : "todoPending";
  return icon(artwork, size);
}

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
  const drop = ["width", "height", "aria-hidden", ...overridden].filter((a) => a !== "width" && a !== "height");
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
