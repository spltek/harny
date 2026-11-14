import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
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

  it("the @types/vscode floor matches engines.vscode (else the .vsix cannot be built)", () => {
    // `vsce` REFUSES to package when the types are newer than the declared engine — "Either
    // upgrade engines.vscode or use an older @types/vscode version" — and it started refusing
    // in vsce 4.1.0, so the mismatch sat in the tree unseen. It is not cosmetic: the types are
    // the API surface `tsc` lets us use, so types ahead of the engine means code that compiles
    // here and throws on the VS Code version the manifest promises. Both are pinned to the
    // SAME minor, and this test is what makes a dependency bump say so in `npm test` instead
    // of at release time (the engine floor itself is a user-facing contract: raising it stops
    // updates for everyone below, which a MAJOR release may do and a minor may not).
    const engine = String(manifest.engines?.vscode ?? "");
    const types = String(manifest.devDependencies?.["@types/vscode"] ?? "");
    expect(engine).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(types).toMatch(/^\^?\d+\.\d+\.\d+$/);
    const floor = (v: string) =>
      v
        .replace(/^[^\d]*/, "")
        .split(".")
        .slice(0, 2)
        .join(".");
    expect(floor(types)).toBe(floor(engine));
  });
});

const BRAND_SVG = join(process.cwd(), "media", "icons", "harny.svg");
const APP_SVG = join(process.cwd(), "media", "icons", "harny-app.svg");
const svgSource = readFileSync(BRAND_SVG, "utf8");
const appSvgSource = readFileSync(APP_SVG, "utf8");

/** One ignore file's patterns, read the way gitignore reads them (comments and blanks dropped). */
function ignoreMatcher(ignoreFile: string): (file: string) => boolean {
  const lines = readFileSync(join(process.cwd(), ignoreFile), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  /** `*` stays inside one path segment, `**` crosses them, and a pattern without a slash
   *  matches at any depth (that is how `*.vsix` catches the artifact in the root). */
  const glob = (pattern: string): RegExp => {
    let re = "";
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === "*" && pattern[i + 1] === "*") {
        re += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else if (ch === "*") re += "[^/]*";
      else if (ch === "?") re += "[^/]";
      else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${pattern.includes("/") ? "" : "(?:.*/)?"}${re}$`);
  };
  /** gitignore semantics, as far as these patterns go: the LAST matching line wins. */
  return (file: string) => {
    let keep = true;
    for (const line of lines) {
      const negated = line.startsWith("!");
      if (glob(negated ? line.slice(1) : line).test(file)) keep = negated;
    }
    return keep;
  };
}

/** What a `.vsix` built from this working tree would carry. */
const ships = ignoreMatcher(".vscodeignore");

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
 * Guards the BRAND ASSETS. Every check comes from a real regression: a non-square
 * viewBox on the activity-bar icon (VS Code renders it in a 24x24 slot, so the
 * mark came out blank/tiny), an inlined copy of the artwork inside the webview
 * bundle that survived every edit to the file, and an artwork folder that is
 * deliberately kept OUT of the package (it is inlined at build time) — which makes
 * the brand files the only ones that must be let back in by hand.
 *
 * Both frames live in media/icons/ with the rest of the artwork: one drawing, one
 * folder, and the only difference between the two files is the canvas.
 */
describe("brand assets", () => {
  it("declares icon paths that exist on disk", () => {
    expect(manifest.icon).toBe("media/icons/harny.png");
    expect(statSync(join(process.cwd(), manifest.icon)).size).toBeGreaterThan(0);

    const containers = (contributes.viewsContainers?.activitybar ?? []) as { icon?: string }[];
    expect(containers[0]?.icon).toBe("media/icons/harny-app.svg");
    expect(statSync(APP_SVG).size).toBeGreaterThan(0);
  });

  it("keeps the activity-bar icon on a SQUARE 24x24 viewBox", () => {
    // A non-square viewBox letterboxes the mark into the activity-bar slot.
    expect(appSvgSource).toMatch(/viewBox="0 0 24 24"/);
    // An explicit width/height makes some renderers thumbnail it to that exact
    // pixel size and come out blank; VS Code only needs the viewBox.
    expect(appSvgSource).not.toMatch(/<svg[^>]*\swidth=/);
  });

  it("lets the brand frames INTO the package (the folder ships nothing else)", () => {
    // media/icons/** is excluded because the artwork is INLINED at build time; the brand is the
    // exception, because the runtime FETCHES it: the activity bar and the marketplace read their
    // icon off disk, and the panel loads the mark as an <img> through asWebviewUri. Get the order
    // wrong and the extension installs with a blank activity-bar icon and an empty hero — a
    // breakage no unit test can see from inside the editor.
    for (const file of ["media/icons/harny.svg", "media/icons/harny-app.svg", "media/icons/harny.png"]) {
      expect(ships(file), file).toBe(true);
    }
    // …and the rest of the folder stays out: the bundle carries it, a user never opens it.
    expect(ships("media/icons/plus.svg")).toBe(false);
    expect(ships("media/icons/README.md")).toBe(false);
    expect(ships("media/icons/icon-sheet.html")).toBe(false);
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
    // Both frames are served from disk at runtime (state.logoUri for the panel, package.json for
    // VS Code), so no source file may duplicate either path data — the panel's sign-off is
    // inlined by the BUILD from the file, never copied into the source.
    for (const markup of [svgSource, appSvgSource]) {
      const d = /<path[^>]*\sd="([^"]+)"/.exec(markup)?.[1];
      expect(d).toBeTruthy();
      const needle = d!.slice(0, 60);
      const offenders = tsSources(join(process.cwd(), "src"))
        .filter((file) => readFileSync(file, "utf8").includes(needle))
        .map((file) => file.replace(process.cwd() + "/", ""));
      expect(offenders).toEqual([]);
    }
  });
});

/**
 * Guards what does NOT leave the working tree. `vsce` packs the WORKING TREE and not the git
 * index, so a file can reach the user — or the Marketplace page — through no code change at all.
 * The list is a defect that reached a release: 1.1.0 shipped the internal review, 62 KB of
 * Italian design notes, and the panel rendered them as if they were docs for the user.
 *
 * The review itself is not guarded here as an EXCLUDED path — it was moved out of the repo, one
 * folder up, and no ignore line mentions it: an ignore entry still names the file and hides a
 * leak (`git add -f`, a copy under another name) instead of preventing it. One assert stands in
 * for all of that: the file must not exist in this tree, or a packer can reach it again.
 */
describe("what leaves the working tree", () => {
  it("keeps the internal review out of reach: it lives one folder UP from the repo", () => {
    expect(existsSync(join(process.cwd(), "REVIEW.md"))).toBe(false);
  });

  it("still ships the runtime, and still drops the dev-only tree", () => {
    // The positive half is what keeps the negative half honest: an `.vscodeignore` that
    // excluded everything would pass the checks above and ship an extension with no code.
    for (const file of ["dist/extension.js", "package.json", "media/view.js", "media/icons/harny.svg"]) {
      expect(ships(file), file).toBe(true);
    }
    for (const file of [
      "src/chat/view.ts",
      "scripts/mutation-gate.mjs",
      "stryker/default.conf.json",
      "docs/RELEASE.md",
      "reports/mutation.json",
      "media/view.css",
      "prettier.config.mjs",
      ".stryker-tmp/sandbox-x/package.json",
      "examples/mcp-server/index.mjs",
      "harny-1.1.0.vsix",
    ]) {
      expect(ships(file), file).toBe(false);
    }
  });
});
