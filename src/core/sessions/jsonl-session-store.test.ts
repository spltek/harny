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
