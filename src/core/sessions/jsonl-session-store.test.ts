import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore } from "./jsonl-session-store";
import { nodeFileSystem } from "../tools/file-system";
import type { ChatMessage } from "../history/types";

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return { role: "user", content: "", timestamp: 1, ...partial };
}

describe("JsonlSessionStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harny-sessions-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lazily creates the sessions dir on the FIRST creation (never before)", () => {
    const missing = join(dir, "nested", "does-not-exist");
    const store = new JsonlSessionStore(() => missing, nodeFileSystem, { idGen: () => "s1" });
    expect(existsSync(missing)).toBe(false); // listing alone writes nothing
    expect(store.list()).toEqual([]);
    expect(existsSync(missing)).toBe(false);
    store.create();
    expect(existsSync(missing)).toBe(true); // the FIRST session materialises it
  });

  it("creates a session and lists it", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    const created = store.create("My session");

    expect(created.id).toBe("s1");
    expect(created.name).toBe("My session");
    expect(created.messageCount).toBe(0);
    expect(store.list()).toEqual([expect.objectContaining({ id: "s1", name: "My session" })]);
  });

  it("persists and loads messages in order", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();
    const messages = [
      msg({ role: "user", content: "hello", images: ["data:image/png;base64,AAAA"] }),
      msg({ role: "assistant", content: "ehi", toolCalls: [{ id: "c1", name: "Read", arguments: { path: "/x" } }] }),
    ];
    store.saveMessages("s1", messages);

    const loaded = store.load("s1");
    expect(loaded.summary.messageCount).toBe(2);
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[0].content).toBe("hello");
    expect(loaded.messages[0].images).toEqual(["data:image/png;base64,AAAA"]);
    expect(loaded.messages[1].toolCalls).toEqual([{ id: "c1", name: "Read", arguments: { path: "/x" } }]);
  });

  it("persists attachment metadata and displayText on user messages", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();
    store.saveMessages("s1", [
      msg({
        role: "user",
        content: 'Attached file "a.txt":\n```\nSECRET\n```\n\nlook',
        displayText: "look",
        attachments: [{ name: "a.txt", path: "/tmp/a.txt", size: 42 }],
      }),
    ]);

    const loaded = store.load("s1");
    expect(loaded.messages[0].displayText).toBe("look");
    expect(loaded.messages[0].attachments).toEqual([{ name: "a.txt", path: "/tmp/a.txt", size: 42 }]);
  });

  it("renames a session preserving its messages", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create("Old");
    store.saveMessages("s1", [msg({ content: "keep me" })]);

    store.rename("s1", "New name");

    const loaded = store.load("s1");
    expect(loaded.summary.name).toBe("New name");
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.messages[0].content).toBe("keep me");
  });

  it("removes a session and returns false for a missing one", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();

    expect(store.remove("s1")).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.remove("s1")).toBe(false);
  });

  it("ignores non-jsonl files when listing", () => {
    writeFileSync(join(dir, "notes.txt"), "x");
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();

    expect(store.list().map((s) => s.id)).toEqual(["s1"]);
  });

  it("loads a session with a missing header by synthesizing one", () => {
    writeFileSync(join(dir, "s1.jsonl"), JSON.stringify(msg({ content: "orphan" })) + "\n");
    const store = new JsonlSessionStore(() => dir, nodeFileSystem);

    const loaded = store.load("s1");
    expect(loaded.summary.id).toBe("s1");
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.messages[0].content).toBe("orphan");
  });

  it("writes a session header", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();
    store.saveMessages("s1", [msg({ content: "a" })]);

    const header = readFileSync(join(dir, "s1.jsonl"), "utf8").split("\n")[0];
    const meta = JSON.parse(header);
    expect(meta.type).toBe("session");
  });
});

describe("JsonlSessionStore model persistence", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harny-sessions-model-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists the last selected model and provider in the header", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();

    store.saveModel("s1", "deepseek-v4-flash", "opencode-go");
    const loaded = store.load("s1");

    expect(loaded.summary.model).toBe("deepseek-v4-flash");
    expect(loaded.summary.modelProvider).toBe("opencode-go");
    expect(store.list()[0].model).toBe("deepseek-v4-flash");
  });

  it("keeps the model when saving messages", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();
    store.saveModel("s1", "gemma.gguf", "llamacpp");

    store.saveMessages("s1", [{ role: "user", content: "x", timestamp: 1 }]);

    expect(store.load("s1").summary.model).toBe("gemma.gguf");
  });
});

describe("JsonlSessionStore context window", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "harny-sessions-ctx-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("persists and loads the context window", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();
    store.saveContextWindow("s1", 200000);
    expect(store.load("s1").summary.contextWindow).toBe(200000);
    expect(store.list()[0].contextWindow).toBe(200000);
  });

  it("persists the output tokens and carries it across later saves", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();
    store.saveOutputTokens("s1", 16384);
    expect(store.load("s1").summary.outputTokens).toBe(16384);
    expect(store.list()[0].outputTokens).toBe(16384);
    // A later save (e.g. a new message) must NOT drop the per-session value.
    store.saveMessages("s1", [{ role: "user", content: "hi", timestamp: 1 }]);
    expect(store.load("s1").summary.outputTokens).toBe(16384);
    // Same for rename.
    store.rename("s1", "Renamed");
    expect(store.load("s1").summary.outputTokens).toBe(16384);
  });

  it("persists the temperature, carries 0 as a valid value and clears with Auto", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();
    store.saveTemperature("s1", 0.2);
    expect(store.load("s1").summary.temperature).toBe(0.2);
    expect(store.list()[0].temperature).toBe(0.2);
    // 0 is falsy but a VALID sampling temperature: it must survive saves.
    store.saveTemperature("s1", 0);
    expect(store.load("s1").summary.temperature).toBe(0);
    // A later save must not drop it.
    store.saveMessages("s1", [{ role: "user", content: "hi", timestamp: 1 }]);
    expect(store.load("s1").summary.temperature).toBe(0);
    // Auto (undefined) explicitly clears the stored value.
    store.saveTemperature("s1", undefined);
    const loaded = store.load("s1").summary;
    expect("temperature" in loaded).toBe(false);
    expect(store.list()[0].temperature).toBeUndefined();
  });

  it("persists the penalties, keeps 0 valid and clears with Auto", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();
    store.savePresencePenalty("s1", 0); // 0 is a valid, deliberate value
    store.saveFrequencyPenalty("s1", 1.5);
    expect(store.load("s1").summary.presencePenalty).toBe(0);
    expect(store.load("s1").summary.frequencyPenalty).toBe(1.5);
    // A later save must carry them over.
    store.saveMessages("s1", [{ role: "user", content: "hi", timestamp: 1 }]);
    const after = store.load("s1").summary;
    expect(after.presencePenalty).toBe(0);
    expect(after.frequencyPenalty).toBe(1.5);
    // Auto (undefined) clears the stored values.
    store.savePresencePenalty("s1", undefined);
    expect("presencePenalty" in store.load("s1").summary).toBe(false);
    expect(store.load("s1").summary.frequencyPenalty).toBe(1.5); // freq untouched
  });

  it("persists and clears top_p and the active sampler", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();
    store.saveTopP("s1", 0); // 0 is a valid threshold
    store.saveSampler("s1", "topP");
    let s = store.load("s1").summary;
    expect(s.topP).toBe(0);
    expect(s.sampler).toBe("topP");
    store.saveMessages("s1", [{ role: "user", content: "hi", timestamp: 1 }]);
    s = store.load("s1").summary;
    expect(s.topP).toBe(0);
    expect(s.sampler).toBe("topP"); // carried across saves
    store.saveTopP("s1", undefined);
    expect(store.load("s1").summary.topP).toBeUndefined();
    store.saveSampler("s1", undefined);
    expect(store.load("s1").summary.sampler).toBeUndefined();
  });
});

describe("JsonlSessionStore thinking level", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "harny-sessions-think-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("persists and loads the session thinking level", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();
    store.saveModel("s1", "qwen.gguf", "llamacpp");
    store.saveThinkingLevel("s1", "high");
    const loaded = store.load("s1").summary;
    expect(loaded.thinkingLevel).toBe("high");
    expect(store.list()[0].thinkingLevel).toBe("high");
    // model/provider survive the thinking update
    expect(loaded.model).toBe("qwen.gguf");
    expect(loaded.modelProvider).toBe("llamacpp");
  });

  it("ignores invalid thinking levels", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();
    store.saveThinkingLevel("s1", "insane" as never);
    expect(store.load("s1").summary.thinkingLevel).toBeUndefined();
  });

  it("keeps the thinking level when saving models or messages", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();
    store.saveThinkingLevel("s1", "low");
    store.saveModel("s1", "gemma.gguf", "llamacpp");
    expect(store.load("s1").summary.thinkingLevel).toBe("low");
  });
});

describe("JsonlSessionStore saveSettings", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "harny-sessions-patch-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("persists several fields in a single atomic write and carries others forward", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();
    store.saveModel("s1", "gpt-4o", "opencode-go");

    const summary = store.saveSettings("s1", {
      model: "deepseek-v4-flash",
      temperature: 0.2,
      outputTokens: 16384,
    });
    const loaded = store.load("s1").summary;

    expect(summary.model).toBe("deepseek-v4-flash");
    expect(loaded.model).toBe("deepseek-v4-flash");
    expect(loaded.temperature).toBe(0.2);
    expect(loaded.outputTokens).toBe(16384);
    // modelProvider (not in the patch) is carried forward unchanged
    expect(loaded.modelProvider).toBe("opencode-go");
  });

  it("clears a field back to Auto when the patch key is undefined", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();
    store.saveTemperature("s1", 0.7);
    expect(store.load("s1").summary.temperature).toBe(0.7);

    store.saveSettings("s1", { temperature: undefined });
    expect(store.load("s1").summary.temperature).toBeUndefined();
  });

  it("drops invalid thinking levels from the patch", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();
    store.saveSettings("s1", { thinkingLevel: "bogus" as never, model: "m1" });
    const loaded = store.load("s1").summary;
    expect(loaded.thinkingLevel).toBeUndefined();
    expect(loaded.model).toBe("m1");
  });

  it("persists the session folder in the header and carries it across saves/renames", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();
    store.saveSettings("s1", { folder: "/home/me/proj" });
    expect(store.load("s1").summary.folder).toBe("/home/me/proj");
    expect(store.list()[0].folder).toBe("/home/me/proj");

    // A later write (messages, rename) must NOT drop the folder.
    store.saveMessages("s1", [msg({ content: "x" })]);
    expect(store.load("s1").summary.folder).toBe("/home/me/proj");
    store.rename("s1", "Renamed");
    const reloaded = store.load("s1");
    expect(reloaded.summary.name).toBe("Renamed");
    expect(reloaded.summary.folder).toBe("/home/me/proj");
  });

  it("ignores folder values that are blank in the patch (set-only semantics)", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();
    store.saveSettings("s1", { folder: "   " });
    expect(store.load("s1").summary.folder).toBeUndefined();
  });

  it("persists the compaction threshold % and carries it across reloads, messages and renames", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();
    store.saveSettings("s1", { compactionThresholdPercent: 65 });

    // Written to disk, visible on load and in the listing.
    expect(store.load("s1").summary.compactionThresholdPercent).toBe(65);
    expect(store.list()[0].compactionThresholdPercent).toBe(65);

    // A later message write / rename must NOT drop the setting.
    store.saveMessages("s1", [msg({ content: "x" })]);
    expect(store.load("s1").summary.compactionThresholdPercent).toBe(65);
    store.rename("s1", "Renamed");
    const reloaded = store.load("s1");
    expect(reloaded.summary.name).toBe("Renamed");
    expect(reloaded.summary.compactionThresholdPercent).toBe(65);

    // A fresh store instance (new session read) still sees it.
    const store2 = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s9" });
    expect(store2.load("s1").summary.compactionThresholdPercent).toBe(65);
  });

  it("keeps the stored threshold when the patch omits it (set-only semantics)", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();
    store.saveSettings("s1", { compactionThresholdPercent: 65, model: "m1" });
    // The patch's other fields change, the threshold is untouched.
    store.saveSettings("s1", { model: "m2" });
    expect(store.load("s1").summary.compactionThresholdPercent).toBe(65);
  });
});

describe("JsonlSessionStore control settings (parallel cap + Loop Guard)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "harny-sessions-control-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("persists the parallel cap and the Loop Guard knobs, carried across writes", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();
    store.saveSettings("s1", {
      maxParallelSubAgents: 6,
      loopGuard: "high",
    });

    const loaded = store.load("s1").summary;
    expect(loaded.maxParallelSubAgents).toBe(6);
    expect(loaded.loopGuard).toBe("high");

    // A later message write / rename must NOT drop them.
    store.saveMessages("s1", [msg({ content: "x" })]);
    store.rename("s1", "Renamed");
    const reloaded = store.load("s1").summary;
    expect(reloaded.maxParallelSubAgents).toBe(6);
    expect(reloaded.loopGuard).toBe("high");

    // A fresh store instance still sees them (header round-trip).
    const store2 = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s9" });
    expect(store2.load("s1").summary.loopGuard).toBe("high");
  });

  it("keeps 0 as 'no cap' (not unset) and clears the override when the key is undefined", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();
    store.saveSettings("s1", { maxParallelSubAgents: 0 });
    expect(store.load("s1").summary.maxParallelSubAgents).toBe(0);

    store.saveSettings("s1", { maxParallelSubAgents: undefined });
    expect(store.load("s1").summary.maxParallelSubAgents).toBeUndefined();
  });

  it("keeps a valid Loop Guard level and clears/ignores an invalid one", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();
    store.saveSettings("s1", { loopGuard: "low" });
    expect(store.load("s1").summary.loopGuard).toBe("low");

    // An invalid level is dropped (no override stored).
    store.saveSettings("s1", { loopGuard: "bogus" as never });
    expect(store.load("s1").summary.loopGuard).toBeUndefined();

    // An explicit undefined clears it back to the default.
    store.saveSettings("s1", { loopGuard: "high" });
    store.saveSettings("s1", { loopGuard: undefined });
    expect(store.load("s1").summary.loopGuard).toBeUndefined();
  });

  it("persists the Include-response flag and carries it across writes", () => {
    const store = new JsonlSessionStore(() => dir, nodeFileSystem, { idGen: () => "s1" });
    store.create();
    store.saveSettings("s1", { loopGuard: "high", loopGuardResponse: true });
    expect(store.load("s1").summary.loopGuardResponse).toBe(true);

    store.saveMessages("s1", [msg({ content: "x" })]);
    expect(store.load("s1").summary.loopGuardResponse).toBe(true);

    // false (or undefined) clears the flag.
    store.saveSettings("s1", { loopGuardResponse: false });
    expect(store.load("s1").summary.loopGuardResponse).toBeUndefined();
  });
});
