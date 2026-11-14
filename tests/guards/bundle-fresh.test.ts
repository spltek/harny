import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Guards the SHIPPED bundle against the one drift nobody notices: `media/view.js` is the file
 * the webview actually loads, and it is committed. A fix that lands in `src/chat/webview/view.ts`
 * and never in the bundle passes every test in this suite (they import the SOURCE through Vite)
 * and ships as nothing — which is exactly what happened to the two field reports in this release:
 * `npm run check` was green, the fix was real, and the panel in the .vsix was the old panel.
 *
 * `view-css.test.ts` already does this for the stylesheet. The bundle is the half that mattered
 * and had no guard, so it rebuilds the very same esbuild config into a temp file and compares the
 * bytes. No `npm run build` in the test: it would REPAIR the drift instead of reporting it.
 */
describe("media/view.js", () => {
  it("is the bundle these sources build (otherwise the fix never reaches the panel)", () => {
    const out = join(mkdtempSync(join(tmpdir(), "harny-bundle-")), "view.js");
    const build = spawnSync(process.execPath, ["build/scripts/build-webview.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, WEBVIEW_OUT: out },
      encoding: "utf8",
    });
    expect(build.status, build.stderr || build.stdout).toBe(0);

    const rebuilt = readFileSync(out, "utf8");
    const shipped = readFileSync(join(process.cwd(), "media/view.js"), "utf8");
    // The message is the whole point of the test: say what to run, not what differs.
    expect(shipped === rebuilt, "media/view.js is stale — run `npm run build` and commit the bundle").toBe(true);
  }, 60000);
});
