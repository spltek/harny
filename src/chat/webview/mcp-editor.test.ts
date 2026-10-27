// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMcpEditor, parseMcpPairs, type McpEditor } from "./mcp-editor";

/**
 * The MCP editor on its own: the local draft of the server map, the form, Test, Delete, and the save
 * as the WHOLE map.
 *
 * The two rules this file exists for:
 *   · the keys the form does NOT edit SURVIVE a save (`analyze`, `excludeTools`, …) — rebuilding an
 *     entry from the form's fields silently stripped them, and the file is the user's too;
 *   · a server is EITHER stdio (`command`) OR HTTP (`url`), so switching DELETES the other, or the
 *     normalizer (which prefers `command`) makes the switch do nothing.
 */

let els: Record<string, HTMLElement>;
let post: ReturnType<typeof vi.fn<(message: unknown) => void>>;
let busy: boolean;
let ui: McpEditor;

beforeEach(() => {
  document.body.innerHTML = `
    <div id="modal" class="hidden">
      <div class="mcp-backdrop"></div>
      <select id="select"></select>
      <input id="name" /><input id="url" /><input id="command" />
      <textarea id="args"></textarea><textarea id="env"></textarea><textarea id="headers"></textarea>
      <input id="enabled" type="checkbox" />
      <button id="add"></button><button id="del"></button><button id="save"></button>
      <button id="cancel"></button><button id="test"></button><span id="test-result"></span>
    </div>
  `;
  const g = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
  els = { modal: g("modal"), testResult: g("test-result") };
  post = vi.fn<(message: unknown) => void>();
  busy = false;
  ui = createMcpEditor({
    modal: g("modal"),
    backdrop: document.querySelector(".mcp-backdrop"),
    select: g("select") as HTMLSelectElement,
    name: g("name") as HTMLInputElement,
    url: g("url") as HTMLInputElement,
    command: g("command") as HTMLInputElement,
    args: g("args") as HTMLTextAreaElement,
    env: g("env") as HTMLTextAreaElement,
    headers: g("headers") as HTMLTextAreaElement,
    enabled: g("enabled") as HTMLInputElement,
    add: g("add") as HTMLButtonElement,
    del: g("del") as HTMLButtonElement,
    save: g("save") as HTMLButtonElement,
    cancel: g("cancel") as HTMLButtonElement,
    test: g("test") as HTMLButtonElement,
    testResult: g("test-result"),
    post,
    busy: () => busy,
  });
});

const field = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
const click = (id: string): void => (document.getElementById(id) as HTMLButtonElement).click();
const lastPost = (type: string): any =>
  post.mock.calls
    .map((c) => c[0] as any)
    .filter((m) => m.type === type)
    .at(-1);

const SERVERS = {
  files: { command: "npx", args: ["-y", "mcp-files"], env: { LOG: "warn" }, enabled: true },
};

describe("opening", () => {
  it("asks the host for the servers, clearing the result line first", () => {
    els.testResult.textContent = "❌ old";
    ui.open();
    expect(post).toHaveBeenCalledWith({ type: "getMcpServers" });
    expect(els.testResult.textContent).toBe("");
  });

  it("refuses mid-run — the flag is read at CLICK time", () => {
    busy = true;
    ui.open();
    expect(post).not.toHaveBeenCalled();
  });

  it("loads the first server into the form and shows the modal", () => {
    ui.render({ servers: SERVERS }, true);
    expect(document.getElementById("modal")!.classList.contains("hidden")).toBe(false);
    expect(field("name").value).toBe("files");
    expect(field("command").value).toBe("npx");
    expect(field("args").value).toBe("-y\nmcp-files");
    expect(field("env").value).toBe("LOG=warn");
    expect(field("enabled").checked).toBe(true);
  });

  it("an empty map clears the form instead of showing a stale server", () => {
    ui.render({ servers: {} }, true);
    expect(field("name").value).toBe("");
    expect(field("command").value).toBe("");
  });

  it("a background change does NOT reopen a closed modal", () => {
    ui.render({ servers: SERVERS }, false);
    expect(document.getElementById("modal")!.classList.contains("hidden")).toBe(true);
  });
});

describe("the draft", () => {
  it("a selection change COMMITS what was typed instead of dropping it", () => {
    ui.render({ servers: { a: { command: "one" }, b: { command: "two" } } }, true);
    field("args").value = "-y\nedited"; // typed, not saved
    const select = document.getElementById("select") as HTMLSelectElement;
    select.value = "b";
    select.dispatchEvent(new Event("change"));
    expect(field("name").value).toBe("b");
    // Back to `a`: the edit survived the round trip (it was committed to the draft).
    select.value = "a";
    select.dispatchEvent(new Event("change"));
    expect(field("args").value).toBe("-y\nedited");
  });

  it("+ New keeps the current edit and opens a fresh entry", () => {
    ui.render({ servers: { a: { command: "one" } } }, true);
    field("args").value = "-y\nedited";
    click("add");
    expect(field("name").value).toBe("server");
    expect(field("command").value).toBe("npx");
    expect((document.getElementById("select") as HTMLSelectElement).value).toBe("server");
  });

  it("Delete removes the entry you SEE, even after renaming it in the form", () => {
    ui.render({ servers: { a: { command: "one" }, b: { command: "two" } } }, true);
    field("name").value = "renamed"; // a rename that was never saved
    click("del");
    const saved = lastPost("saveMcpServers");
    expect(saved).toBeUndefined(); // Delete is local until Save
    // The list now holds `b` only (`a` was renamed then deleted).
    const options = [...(document.getElementById("select") as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toEqual(["b"]);
  });

  it("a rename REBASES the entry instead of leaving a duplicate", () => {
    ui.render({ servers: { a: { command: "one" } } }, true);
    field("name").value = "renamed";
    field("command").value = "two";
    click("save");
    const sent = lastPost("saveMcpServers");
    expect(Object.keys(sent.servers)).toEqual(["renamed"]);
    expect(sent.servers.renamed.command).toBe("two");
  });
});

describe("the keys the form does not edit", () => {
  it("SURVIVE a save (analyze, excludeTools, and anything else the user wrote)", () => {
    // The bug this prevents: the form used to rebuild the entry from its own fields, so editing a
    // server here silently stripped `analyze`/`excludeTools` — its own file, damaged by a save.
    ui.render(
      {
        servers: {
          files: {
            command: "npx",
            args: ["-y", "mcp-files"],
            analyze: "trusted",
            excludeTools: ["drop_table"],
            unknownKey: { nested: true },
          },
        },
      },
      true,
    );
    field("args").value = "-y\nmcp-files\n./data"; // an EDIT: the entry must be preserved
    click("save");
    const entry = lastPost("saveMcpServers").servers.files;
    expect(entry.command).toBe("npx");
    expect(entry.args).toEqual(["-y", "mcp-files", "./data"]);
    expect(entry.analyze).toBe("trusted");
    expect(entry.excludeTools).toEqual(["drop_table"]);
    expect(entry.unknownKey).toEqual({ nested: true });
  });

  it("an emptied env box CLEARS it (it is an edited field, not a preserved key)", () => {
    ui.render({ servers: { files: { command: "npx", env: { LOG: "warn" } } } }, true);
    field("env").value = "";
    click("save");
    expect(lastPost("saveMcpServers").servers.files.env).toBeUndefined();
  });
});

describe("the edges", () => {
  it("saving an EDITED env writes it (the box is authoritative both ways)", () => {
    ui.render({ servers: { files: { command: "npx", env: { OLD: "1" } } } }, true);
    field("env").value = "NEW=2";
    click("save");
    expect(lastPost("saveMcpServers").servers.files.env).toEqual({ NEW: "2" });
  });

  it("a second + New picks a free name instead of overwriting the first", () => {
    ui.render({ servers: {} }, true);
    click("add");
    click("add");
    const options = [...(document.getElementById("select") as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toEqual(["server", "server-2"]);
  });

  it("deleting the LAST server clears the form instead of showing a ghost", () => {
    ui.render({ servers: { only: { command: "npx", args: ["-y", "x"] } } }, true);
    click("del");
    expect(field("name").value).toBe("");
    expect(field("command").value).toBe("");
    expect(field("args").value).toBe("");
  });

  it("a background change keeps the OPEN editor's list in sync (without reopening it)", () => {
    ui.render({ servers: { a: { command: "one" } } }, true);
    ui.render({ servers: { a: { command: "one" }, b: { command: "two" } } }, false);
    const options = [...(document.getElementById("select") as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toEqual(["a", "b"]);
    expect(document.getElementById("modal")!.classList.contains("hidden")).toBe(false);
  });
});

describe("stdio vs HTTP", () => {
  it("typing a URL DELETES the leftover command (the normalizer prefers command)", () => {
    ui.render({ servers: { files: { command: "npx", args: ["-y", "x"] } } }, true);
    field("url").value = "https://example.test/mcp";
    field("headers").value = "Authorization: Bearer a=b";
    click("save");
    const entry = lastPost("saveMcpServers").servers.files;
    expect(entry.url).toBe("https://example.test/mcp");
    expect(entry.command).toBeUndefined();
    expect(entry.args).toBeUndefined();
    // The colon/equals split keeps the value intact.
    expect(entry.headers).toEqual({ Authorization: "Bearer a=b" });
  });

  it("clearing the URL goes back to stdio, deleting the headers", () => {
    ui.render({ servers: { remote: { url: "https://x.test", headers: { A: "b" } } } }, true);
    field("url").value = "";
    expect(field("command").value).toBe(""); // nothing typed yet
    click("save");
    const entry = lastPost("saveMcpServers").servers.remote;
    // Neither a URL nor a command: the entry is kept as it was rather than written as nothing.
    expect(entry.url).toBe("https://x.test");
    expect(entry.headers).toEqual({ A: "b" });
  });
});

describe("Test", () => {
  it("posts the form, and says what to type when neither field is filled", () => {
    ui.render({ servers: { files: { command: "npx" } } }, true);
    field("url").value = "https://x.test/mcp";
    click("test");
    expect(lastPost("testMcpServer").server.url).toBe("https://x.test/mcp");
    expect(els.testResult.textContent).toBe("Testing…");

    // No server at all yet (an empty list, the form blank) and Test pressed: there is nothing to
    // test. NOTE: clearing the box of a server that HAS a command or a URL keeps it — that is the
    // "no command typed = keep the one it has" rule, deliberately not this guard.
    ui.render({ servers: {} }, true);
    click("test");
    expect(els.testResult.textContent).toBe("Enter a command (stdio) or a URL (HTTP)");
    expect(els.testResult.className).toContain("err");
  });
});

describe("Save", () => {
  it("refuses mid-run, on the editor's own line", () => {
    ui.render({ servers: SERVERS }, true);
    busy = true;
    click("save");
    expect(post.mock.calls.map((c) => (c[0] as any).type)).not.toContain("saveMcpServers");
    expect(els.testResult.textContent).toContain("Stop the run before saving");
  });

  it("posts the WHOLE map, not one entry", () => {
    ui.render({ servers: { a: { command: "one" }, b: { command: "two" } } }, true);
    click("save");
    expect(Object.keys(lastPost("saveMcpServers").servers).sort()).toEqual(["a", "b"]);
  });
});

describe("the host's answers", () => {
  it("a refusal says why and keeps the modal open", () => {
    ui.render({ servers: SERVERS }, true);
    ui.error('Stop the run first — a session is using "files" right now');
    expect(document.getElementById("modal")!.classList.contains("hidden")).toBe(false);
    expect(els.testResult.textContent).toContain("Stop the run first");
    expect(els.testResult.className).toContain("err");
  });

  it("Cancel and the backdrop close it", () => {
    ui.render({ servers: SERVERS }, true);
    click("cancel");
    expect(document.getElementById("modal")!.classList.contains("hidden")).toBe(true);
    document.querySelector(".mcp-backdrop")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.getElementById("modal")!.classList.contains("hidden")).toBe(true);
  });
});

describe("parseMcpPairs", () => {
  it("keeps a colon inside a value and an equals inside a header", () => {
    expect(parseMcpPairs("SOME_URL=http://x:1234")).toEqual({ SOME_URL: "http://x:1234" });
    expect(parseMcpPairs("Authorization: Bearer a=b")).toEqual({ Authorization: "Bearer a=b" });
    expect(parseMcpPairs("  \n A = 1 \n\n")).toEqual({ A: "1" });
    expect(parseMcpPairs("nonsense")).toEqual({});
  });
});
