import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the extension MANIFEST: the Command Palette is kept clean (no custom
 * `harny.*` commands/keybindings), while the view container + chat webview stay
 * contributed. A plain JSON read — no VS Code host needed.
 */
const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
const contributes = manifest.contributes ?? {};

describe("package.json manifest", () => {
  it("contributes NO custom harny commands (palette stays clean)", () => {
    // The panel does not pollute the palette. ONE exception is not a command but a KEYBINDING
    // target: `harny.findInChat` is registered at runtime and referenced by the keybinding below,
    // and it is deliberately absent from `contributes.commands`.
    const commands = (contributes.commands ?? []) as { command: string }[];
    expect(commands.filter((c) => c.command.startsWith("harny."))).toEqual([]);
  });

  it("any harny keybinding is SCOPED to our own view, and never steals a key elsewhere", () => {
    // The only reason to have one at all: inside a webview, ⌘F/Ctrl+F also reaches VS Code's own
    // find, which opens its widget and takes the focus away from the panel. A contributed
    // keybinding is the only way to win that chord — so it MUST be scoped to our view having the
    // focus: anywhere else, the editor's own find is none of our business.
    const keybindings = (contributes.keybindings ?? []) as { command: string; when?: string }[];
    const ours = keybindings.filter((k) => k.command.startsWith("harny."));
    expect(ours.length).toBeGreaterThan(0);
    for (const k of ours) expect(k.when).toBe("focusedView == harny.chatView");
    // …and the find chord is the one we claim.
    expect(ours.map((k) => k.command)).toEqual(["harny.findInChat"]);
  });

  it("still contributes the Harny view container and the chat webview", () => {
    const containers = (contributes.viewsContainers?.activitybar ?? []) as { id: string }[];
    expect(containers.some((c) => c.id === "harny")).toBe(true);
    const views = (contributes.views?.harny ?? []) as { id: string }[];
    expect(views.some((v) => v.id === "harny.chatView")).toBe(true);
  });

  it("declares Workspace Trust support — otherwise the panel does not EXIST in Restricted Mode", () => {
    // Reported from the field as "Harny does not appear in the panel" in a folder opened untrusted:
    // the panel was not broken, it was never contributed. An extension that does not declare
    // `capabilities.untrustedWorkspaces` is DISABLED in Restricted Mode by VS Code/VSCodium (the
    // same Workbench), so its view container and webview are not rendered at all — an empty side
    // bar with nothing to hover, nothing to click, and no hint. The declared level is `limited`
    // on purpose: `true` would keep the panel AND let it write and run commands in a folder the
    // user has not vetted, which is what Workspace Trust is for. `limited` + the read-only gate
    // (see core/agent/workspace-trust.ts) is the pair that makes it honest.
    const support = manifest.capabilities?.untrustedWorkspaces;
    expect(support).toBeTruthy();
    expect(["limited", true]).toContain(support.supported);
    // The reason shown in the Extensions view must be a sentence, not a restatement.
    expect(typeof support.description).toBe("string");
    expect(support.description.length).toBeGreaterThan(40);
  });
});

const ICON_SVG = join(process.cwd(), "media", "icon.svg");
const svgSource = readFileSync(ICON_SVG, "utf8");

/** Every .ts file under src/ (the walk never enters node_modules). */
function tsSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) tsSources(path, out);
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/**
 * Guards the BRAND ASSETS. Both checks come from real regressions: a non-square
 * viewBox on the activity-bar icon (VS Code renders it in a 24x24 slot, so the
 * mark came out blank/tiny) and an inlined copy of the artwork inside the
 * webview bundle that survived every edit to media/icon.svg.
 */
describe("brand assets", () => {
  it("declares icon paths that exist on disk", () => {
    expect(manifest.icon).toBe("media/icon.png");
    expect(statSync(join(process.cwd(), manifest.icon)).size).toBeGreaterThan(0);

    const containers = (contributes.viewsContainers?.activitybar ?? []) as { icon?: string }[];
    expect(containers[0]?.icon).toBe("media/icon.svg");
    expect(statSync(ICON_SVG).size).toBeGreaterThan(0);
  });

  it("keeps media/icon.svg on a SQUARE 24x24 viewBox", () => {
    // A non-square viewBox letterboxes the mark into the activity-bar slot.
    expect(svgSource).toMatch(/viewBox="0 0 24 24"/);
    // An explicit width/height makes some renderers thumbnail it to that exact
    // pixel size and come out blank; VS Code only needs the viewBox.
    expect(svgSource).not.toMatch(/<svg[^>]*\swidth=/);
  });

  it("only advertises a PUBLIC homepage (the hero credit links to it)", () => {
    // The credit renders an <a href> from `homepage`. A private repo (or a
    // relative path) must never end up there: it would 404 for every user.
    if (manifest.homepage === undefined) return; // plain-text credit: allowed
    expect(manifest.homepage).toMatch(/^https:\/\//);
    // `repository` is deliberately NOT used as a link fallback.
    expect(manifest.homepage).not.toContain("github.com/spltek/harny");
  });

  it("keeps the brand artwork in ONE place (nothing inlined under src/)", () => {
    // The hero mark is served from media/icon.svg at runtime (state.logoUri),
    // so no source file may duplicate the path data.
    const d = /<path[^>]*\sd="([^"]+)"/.exec(svgSource)?.[1];
    expect(d).toBeTruthy();
    const needle = d!.slice(0, 60);
    const offenders = tsSources(join(process.cwd(), "src"))
      .filter((file) => readFileSync(file, "utf8").includes(needle))
      .map((file) => file.replace(process.cwd() + "/", ""));
    expect(offenders).toEqual([]);
  });
});
