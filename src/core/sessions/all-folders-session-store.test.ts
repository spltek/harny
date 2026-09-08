import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AllFoldersSessionStore } from "./all-folders-session-store";
import { JsonlSessionStore } from "./jsonl-session-store";
import { nodeFileSystem, type FileSystem } from "../tools/file-system";
import type { ChatMessage } from "../history/types";

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return { role: "user", content: "", timestamp: 1, ...partial };
}

/**
 * Fixture: a real storage layout with two workspace buckets under
 * `home/sessions`, a real root-A folder and a deliberately MISSING folder-B.
 */
function setup() {
  const home = mkdtempSync(join(tmpdir(), "harny-home-"));
  const rootA = join(home, "proj-a");
  const missing = join(home, "proj-b-gone");
  const root = join(home, "sessions");
  mkdirSync(rootA, { recursive: true });
  mkdirSync(root, { recursive: true });

  let currentBucket = join(root, "--root-a--");
  let currentFolder = rootA;

  const store = new AllFoldersSessionStore({
    bucketsRoot: () => root,
    currentBucket: () => currentBucket,
    currentFolder: () => currentFolder,
    fs: nodeFileSystem,
    bucketStore: (dir) => new JsonlSessionStore(() => dir, nodeFileSystem),
  });
  return { home, root, rootA, missing, store, setCurrent: (b: string, f: string | undefined) => { currentBucket = b; currentFolder = f; } };
}

describe("AllFoldersSessionStore", () => {
  let fx: ReturnType<typeof setup>;

  beforeEach(() => {
    fx = setup();
  });

  afterEach(() => {
    rmSync(fx.home, { recursive: true, force: true });
  });

  it("creates in the current bucket and stamps the session's folder", () => {
    const created = fx.store.create("A");
    expect(created.folder).toBe(fx.rootA);
    const listed = fx.store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: created.id, name: "A", folder: fx.rootA, folderMissing: false });
    // The bucket dir materialised only on creation (lazy, like the base store).
    expect(existsSync(join(fx.root, "--root-a--"))).toBe(true);
  });

  it("lists sessions ACROSS buckets (other folders included)", () => {
    const a = fx.store.create("A");
    // A second workspace (bucket B) with its own session, folder missing.
    fx.setCurrent(join(fx.root, "--root-b--"), fx.missing);
    const b = fx.store.create("B");
    // B's folder does not exist -> red row.
    const listed = fx.store.list();
    expect(listed).toHaveLength(2);
    const byId = Object.fromEntries(listed.map((s) => [s.id, s]));
    expect(byId[a.id]).toMatchObject({ name: "A", folder: fx.rootA, folderMissing: false });
    expect(byId[b.id]).toMatchObject({ name: "B", folder: fx.missing, folderMissing: true });
  });

  it("loads a session from ANY bucket (open by id)", () => {
    fx.store.create("A");
    fx.setCurrent(join(fx.root, "--root-b--"), fx.missing);
    const a = fx.store.create("A-b"); // session id differs per bucket
    const idA = fx.store.list().find((s) => s.name === "A")!.id;
    // Write a message into A while the "current" bucket is B: the write must
    // land in A's bucket (found by id), not the current one.
    fx.store.saveMessages(idA, [msg({ content: "keep" })]);
    const loaded = fx.store.load(idA);
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.summary.name).toBe("A");
    // B's session untouched.
    expect(fx.store.load(a.id).messages).toHaveLength(0);
  });

  it("change folder: saveSettings({ folder }) moves the POINTER, file stays put", () => {
    const created = fx.store.create("A");
    const other = join(fx.home, "proj-other");
    mkdirSync(other, { recursive: true });
    fx.store.saveSettings(created.id, { folder: other });
    const listed = fx.store.list();
    expect(listed[0]).toMatchObject({ id: created.id, folder: other, folderMissing: false });
    // Pointer-only: the physical file never left bucket A.
    expect(existsSync(join(fx.root, "--root-a--", `${created.id}.jsonl`))).toBe(true);
  });

  it("points a session at a missing folder -> red; a valid one -> openable again", () => {
    const created = fx.store.create("A");
    fx.store.saveSettings(created.id, { folder: fx.missing });
    expect(fx.store.list()[0].folderMissing).toBe(true);
    const valid = join(fx.home, "valid");
    mkdirSync(valid, { recursive: true });
    fx.store.saveSettings(created.id, { folder: valid });
    expect(fx.store.list()[0]).toMatchObject({ folder: valid, folderMissing: false });
  });

  it("legacy sessions without folder: current bucket falls back to the current root", () => {
    // A session file written WITHOUT the folder field (pre-feature format).
    const fs: FileSystem = nodeFileSystem;
    const bucketA = join(fx.root, "--root-a--");
    fs.mkdirRecursive(bucketA);
    fs.writeText(
      join(bucketA, "legacy.jsonl"),
      JSON.stringify({ type: "session", id: "legacy", name: "Old", createdAt: 1, updatedAt: 1 }) + "\n",
    );
    const listed = fx.store.list().find((s) => s.id === "legacy")!;
    expect(listed.folder).toBe(fx.rootA);
    expect(listed.folderMissing).toBe(false);
    // Same legacy file but in ANOTHER bucket: folder unknown -> NEUTRAL (not
    // red): only a KNOWN path that disappeared is "missing". Open stays
    // disabled (no folder) but the row is not an error.
    fx.setCurrent(join(fx.root, "--root-b--"), undefined);
    // Re-list: legacy session lives in bucket A (not current) -> no fallback.
    const again = fx.store.list().find((s) => s.id === "legacy")!;
    expect(again.folder).toBeUndefined();
    expect(again.folderMissing).toBe(false);
  });

  it("remove and rename delegate to the owning bucket", () => {
    const created = fx.store.create("A");
    fx.store.rename(created.id, "Renamed");
    expect(fx.store.list()[0].name).toBe("Renamed");
    expect(fx.store.remove(created.id)).toBe(true);
    expect(fx.store.list()).toHaveLength(0);
    expect(fx.store.remove(created.id)).toBe(false);
  });

  it("per-field settings writes land in the owning bucket and survive reload", () => {
    const created = fx.store.create("A");
    fx.store.saveModel(created.id, "gpt-4o", "openai");
    fx.store.saveTemperature(created.id, 0.7);
    fx.setCurrent(join(fx.root, "--root-b--"), fx.missing);
    const reloaded = fx.store.load(created.id);
    expect(reloaded.summary.model).toBe("gpt-4o");
    expect(reloaded.summary.modelProvider).toBe("openai");
    expect(reloaded.summary.temperature).toBe(0.7);
  });
});