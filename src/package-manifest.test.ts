import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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
    const commands = (contributes.commands ?? []) as { command: string }[];
    expect(commands.filter((c) => c.command.startsWith("harny."))).toEqual([]);
  });

  it("contributes NO custom harny keybindings", () => {
    const keybindings = (contributes.keybindings ?? []) as { command: string }[];
    expect(keybindings.filter((k) => k.command.startsWith("harny."))).toEqual([]);
  });

  it("still contributes the Harny view container and the chat webview", () => {
    const containers = (contributes.viewsContainers?.activitybar ?? []) as { id: string }[];
    expect(containers.some((c) => c.id === "harny")).toBe(true);
    const views = (contributes.views?.harny ?? []) as { id: string }[];
    expect(views.some((v) => v.id === "harny.chatView")).toBe(true);
  });
});
