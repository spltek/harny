import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VIEW_CSS } from "./view-css";

/**
 * The stylesheet lives in `media/view.css` (a real file: formatted, lintable, diffable) and
 * reaches the panel through a GENERATED module (`scripts/gen-view-css.mjs`). A generated file
 * that nobody checks is a file that silently goes stale — so this pins the two together.
 *
 * The bugs this design removes: the sheet used to be a template literal inside `view-html.ts`,
 * where a stray backtick or a `${` was a syntax error no formatter or type could catch (it
 * happened twice while adding a single CSS rule).
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("view-css (generated from media/view.css)", () => {
  it("is exactly the stylesheet on disk — regenerate with `npm run gen:css`", () => {
    const css = readFileSync(join(root, "media/view.css"), "utf8");
    expect(VIEW_CSS).toBe(css);
  });

  it("is a plain JSON string, so no backtick or ${ can break the page it lands in", () => {
    // The module is JSON-encoded: whatever the sheet contains, it cannot end a template
    // literal or start an interpolation. Pinned here because that is the whole reason for the
    // indirection.
    const ts = readFileSync(join(root, "src/chat/view-css.ts"), "utf8");
    expect(ts.startsWith("// GENERATED")).toBe(true);
    expect(ts).toMatch(/export const VIEW_CSS = "/); // one double-quoted string, no backtick
  });

  it("keeps the sheet real: a .css file a formatter can read", () => {
    const css = readFileSync(join(root, "media/view.css"), "utf8");
    expect(css).toContain("box-sizing");
    // Sanity: the sheet is where the panel's rules live, not a stub.
    expect(css.split("\n").length).toBeGreaterThan(1000);
  });
});
