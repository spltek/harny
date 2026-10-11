# Harny

> **AI coding harness for VS Code** — fast like pi, with a SOLID, fully-tested core.

Harny brings a full AI coding agent directly into VS Code. It speaks the **OpenAI Chat Completions** protocol (including OpenAI-compatible providers such as Ollama, LM Studio and llama.cpp), with tool-calling (read, write, edit, bash, search) and real-time streaming.

## Architecture

SOLID-first design with dependency injection throughout. The composition root is `src/extension.ts` — every collaborator is created there and injected via constructors. The core layer has **zero VS Code imports**, which makes it fully unit-testable.

```
harny/
├── src/
│   ├── extension.ts              # Composition root: wires every dependency
│   ├── core/                     # VS Code-free domain layer (fully tested)
│   │   ├── config/               # ConfigProvider <- VscodeConfigProvider
│   │   ├── events/               # EventBus <- InMemoryEventBus
│   │   ├── history/              # ChatHistory <- PersistentChatHistory (bound to a session)
│   │   ├── llm/                  # LLMProvider <- OpenAIChatProvider
│   │   │                         #   HttpClient, SSE parser, factory, model-list fetcher
│   │   ├── agent/                # Agent orchestrator (DI), LoopGuard, ToolCallAccumulator,
│   │   │                         #   ThinkingTagParser, SystemPrompt, orchestration + sub-agents
│   │   ├── sessions/             # SessionStore <- SqliteSessionStore (node:sqlite + FTS5), SessionManager, Compactor
│   │   │                         #   + one runtime (dedicated Agent) per open session
│   │   ├── skills/               # Agent Skills (skills.sh): SKILL.md discovery + registry
│   │   ├── mcp/                  # Model Context Protocol: stdio + HTTP clients, manager, tools
│   │   ├── storage/              # Cross-platform path resolution (context.globalStorageUri)
│   │   └── tools/                # Tool interface + ToolRegistry + 14 tools (one file each)
│   │                             #   mode-policy (Analyze preview / Build), FileSystem /
│   │                             #   CommandRunner / HttpClient abstractions
│   ├── chat/
│   │   ├── chat-view.ts          # Host WebviewViewProvider (single right-side view)
│   │   ├── session-registry.ts   # Per-session agents (one agent = one session)
│   │   ├── stream-tee.ts         # Per-session event router + live buffers
│   │   ├── attachment-service.ts # Attach files/images as context
│   │   ├── view-html.ts          # Pure HTML generator (sessions + tabs + chat)
│   │   └── webview/              # Webview client (TS): view.ts + markdown.ts
│   │       #                       markdown-it + DOMPurify, bundled with esbuild
│   └── logger.ts                 # Diagnostics: "Output > Harny" channel + HARNY_DEBUG file
├── media/view.js                 # Webview client bundle (generated: node scripts/build-webview.mjs)
├── media/icon.svg                # Activity Bar icon
├── vitest.config.mts
└── package.json
```

### SOLID principles applied

- **S**ingle responsibility: `Agent` orchestrates the loop; `SessionRegistry` tracks open sessions; each tool is a class in its own file; `view-html.ts` only renders HTML.
- **O**pen/closed: adding a tool = adding a `Tool` class and registering it; the agent and LLM providers never change. Adding a provider = implementing `LLMProvider`. Adding a store = implementing `SessionStore`.
- **L**iskov: every implementation satisfies its interface (`ConfigProvider`, `EventBus`, `ChatHistory`, `LLMProvider`, `Tool`, `CommandRunner`, `FileSystem`, `HttpClient`, `SessionStore`).
- **I**nterface segregation: small, focused interfaces (`ChatController`, `SessionStore` expose only what consumers need).
- **D**ependency inversion: high-level modules (`ChatViewProvider`, `SessionRegistry`) depend on interfaces injected via constructors, never on concrete collaborators or VS Code APIs.

### Testing

```bash
npm test          # run all unit tests (vitest)
npm run coverage  # with coverage report
```

1270 unit tests cover: config (file multi-provider, JSONC, precedence home/workspace), event bus, history, sessions (SQLite store with FTS5 search, manager, registry, compactor, the cross-folder manager with its open/change-folder actions, the per-session control settings incl. the Loop Guard parameters), the OpenAI-compatible LLM provider (streaming, tool calls, `finish_reason`), host-model fetching, all 14 tools (including the Analyze dry-run preview), the mode policy, the agent loop (fake LLM, abort, max turns), the **loop guard** (reasoning/empty/tool-failure/error-streak/tool-repeat detection, tool-call dedup, sensitivity presets, the editable parameter ranges + their clamping), orchestration/sub-agents, **Agent Skills** (SKILL.md parsing + discovery), **MCP** (stdio + Streamable HTTP clients, tool wrapper, manager), markdown/DOM (markdown-it + DOMPurify), the HTML generators and the chat view provider (mocked VS Code, incl. the control-stack wiring: sliders, Auto defaults, the collapsible Loop Guard parameters and the responsive layout), the per-turn metrics badge (real usage + timings), the real context accounting (after a ✂ cut / compaction) and the DB compaction + index optimization (VACUUM, `PRAGMA optimize`, FTS5 `optimize`).

## Features

- **Chat Completions protocol** (`/v1/chat/completions`)
- **Streaming**: Real-time SSE streaming for responsive UX
- **14 tools**: Read, Write, StrReplace, Edit, Delete, Shell, Grep, Glob, Skill, TodoWrite, WebSearch, WebFetch, ReadLints, Delegate (plus the dynamic `mcp__<server>__<tool>` from any MCP server)
- **Agent Skills** (skills.sh): Harny discovers installed skills (`SKILL.md` in `.agents`/`.claude`/`.pi` dirs) and offers a compact catalog; the model activates one on demand via the `Skill` tool (progressive disclosure), or you activate it manually with `/skill <name>` / the **Skills** card. `disable-model-invocation: true` skills stay manual-only
- **Slash menu**: typing `/` at the START of the prompt opens a picker with the installed skills (`/skill <name>`, `/skills`) — arrows/Enter select, Esc closes
- **MCP servers** (Model Context Protocol): connect external tool servers over **stdio** or **Streamable HTTP** (stateless or session-based, JSON or SSE); their tools appear as `mcp__<server>__<tool>`. A per-server **enable/disable** (click the name in the card), a **tool-list popover** on `(N tools)`, and an editor in the panel (add/edit/delete + Test)
- **Guardrails (per session)**: TWO cards below the prompt — **Parallel** (a **0–100 slider** for the concurrent sub-agent cap; `0` = **"Off"** = no cap) and **Loop Guard** (sensitivity `High`/`Normal`/`Low` + an opt-in **Include response** flag, plus a **collapsible section of 12 tunable parameter sliders**). Loop Guard and the sub-agent cap are persisted per session; the **Parallel on/off toggle itself is a single GLOBAL switch** (only the cap is per session).
- **Esc to stop**: press Esc while a run is working (the prompt is disabled then) to stop it — modals/overlays and native controls keep Esc for themselves
- **Focus always on the prompt**: the caret returns to the input after opening/switching a session, finishing a run, a cut, and after mode/parallel/model/attach interactions
- **Attachments**: add files/images with the **+** button, **paste from the clipboard** into the prompt, or **drag & drop** them onto the panel — images (screenshots/copied images, named "Image from clipboard") are attached inline as a data URI and sent as multimodal content, text files as inline code blocks, and a pasted/dropped absolute path / `file://` URI attaches that file. **In the transcript** every attachment is rendered for real: images appear **large** (a third of the chat width, **resizable** by dragging the corner, stacked, click to open a **full-size lightbox**) and are **persisted with the message** (so they survive a reload without duplication); other files become a **card with a large per-type icon** (PDF / code / Markdown / JSON / sheet / archive, tinted by category) plus the file name and size. **Under the prompt** the pending attachments show the **same icon, small**, next to the name, size and a ✕. Binary files (e.g. a PDF) copied in Finder/Explorer usually reach the webview only as their **name** (text), so use the **+** button; even attached, a binary PDF cannot be read over the Chat Completions protocol.
- **Drag & drop**: hold **Shift** while dropping (VS Code's "drop into editor" behaviour otherwise intercepts OS file drops); paste and the **+** button need no modifier.
- **Plain tool outputs + three-section tool bubbles**: tool outputs are never colorized by line-prefix heuristics (a `ls -la` listing stays plain text); when Edit/Write/StrReplace/Delete touch a file, the tool bubble gets a third **Diff** section (Input / Output / Diff, collapsed with the bubble) showing the unified diff — a new file as all `+` additions, a deleted file as all `−` removals, modifications/string replacements as a mixed diff — with the **target file path in azure right after the tool name** and `+N/−M` counts in the Diff header
- **Syntax highlighting in tool Diff sections**: code lines get editor-style syntax colors (Prism, one-dark palette) for TypeScript, JavaScript, Python, Rust, C#, HTML, CSS, JSON, Markdown, Bash, SQL and Go — unknown extensions fall back to plain diff coloring. The webview bundle is minified
- **Agent loop**: Automatic tool execution, multi-turn continuation, no bounded turn count (Stop button only) — a `maxTurns` cap exists behind the scenes for tests/future config
- **Two chat modes**: **Analyze** (read-only **preview** — changes are prepared and diffed but never written; a highlighted **"Switch to Build"** banner lists exactly what still needs Build) and **Build** (full tool use, writes for real)
- **Parallel / sub-agents**: the `Delegate` tool launches independent sub-tasks as sub-agents, with conflict analysis and automatic serialization of overlapping writers
- **Loop guard**: reasoning, empty, failing-tool, error-streak and repeated-tool loops are **broken, not just stopped** — the host interrupts the degenerate behaviour, tells the model how to recover and keeps going; identical read-only calls are served from cache and identical failing calls are not re-run
- **Output-token-limit handling**: the provider's `finish_reason` is propagated; a truncated response is surfaced explicitly ("raise `harny.maxTokens`") instead of failing silently
- **Diagnostics**: one line per turn (finish reason, content/thinking sizes, tool names, loop-guard decisions) in **Output > Harny**; an optional full request file log with `HARNY_DEBUG=1`
- **Per-turn metrics badge**: under every assistant turn a compact badge shows the **REAL** usage and timings — `6.9k in · 74 out · ⚡ 800 · elapsed 2.3s · first token 676ms` (hover for the full detail). It appears **as soon as the turn ends** (a `turn_meta` event, no transcript re-render) and is shown for tool-only turns too. Captured from the provider stream (`usage`) and persisted with the message
- **Real context accounting**: the context-fill metric prefers the provider-reported input tokens; after a ✂ cut it is recomputed from the **KEPT** messages and **persisted** (cutting everything → 0, so it no longer “jumps back” on reload), and after a compaction the kept window's real cumulative-input delta is used. Auto-compaction follows the same numbers
- **Database compaction (VACUUM)**: the **All sessions** modal has two stacked sliders (free-page % above which compaction is suggested — default `20`; minimum **reclaimable** MB — default `128`) + the free/total numbers + **Compact & optimize indexes…**. The SAME modal is suggested automatically after a ✂ cut / session delete (and once at startup) when the DB is bloated, runs **“a bocce ferme”** (never during a live turn, since VACUUM is synchronous) and reports the **before → after** result. Besides reclaiming pages it also runs `PRAGMA optimize` and the **FTS5 `optimize`** (VACUUM alone does NOT merge full-text segments)
- **Per-session controls**: context window, output tokens, sampler value, presence/frequency penalties, thinking level and every Loop Guard parameter are edited with **sliders** (each with a read-only value label; **Auto** snaps back to the knob's default) and persisted **per session** (in the SQLite `sessions` row), restored on reopen; they win over the provider defaults
- **Responsive control stack**: the cards lay out **1 / 2 / 4 per row** as the panel widens, all share ONE row height so the left and right columns' controls **line up**, and the whole stack **scrolls vertically** once it would take more than 75% of the panel height (the prompt and the metrics are the last to give way)
- **Empty shell**: with no open session the control stack is hidden and a hero invites you to pick a session from the list or create a new one
- **Sessions**: Persistent per-workspace sessions (SQLite), one agent per session, right-side view with tabs
- **Sessions in a central home** (pi/Cursor style): stored in a single SQLite database `<home>/sessions.db`, each session tagged with its workspace `folder` — out of the project folder, so the agent tools can never read or modify transcripts, and cleaning the repo never deletes chat history. The panel shows only the current folder's sessions
- **Single-folder requirement**: Harny needs **exactly one open workspace folder**; without it (empty window or multi-root) the panel shows a "open a folder" hero and session commands are guarded
- **Naming**: new sessions are named at creation via a prompt (default "New Session"); the session list shows creation and last-modified dates
- **Model catalog**: Fetch the host model list (`GET /v1/models`) when the config only declares apiKey + baseUrl
- **Cross-platform storage**: config and sessions live in `context.globalStorageUri` (per-OS, macOS `~/Library/…/globalStorage/spltek.harny`), overridable with `HARNY_HOME`; nothing is written inside the workspace
- **VS Code native**: Right-side Activity Bar view, context menu integration, keybindings
- **Extensible**: Add a tool by implementing the `Tool` interface and registering it in the `ToolRegistry`

## Chat modes: Analyze (preview) & Build

The header has a mode selector:

- **Analyze** — read-only **preview**. The file-modifying tools (Write, StrReplace, Edit, Delete) still run, but in **dry-run**: they validate the change and return the exact **diff**, writing NOTHING to disk. So you can ask "fix X", review the proposed diffs in the tool bubbles, then apply them. When changes were prepared, the host appends a footer that lists **exactly what needs Build** (`Edit src/a.ts`, `Write src/b.ts`, …) plus a prominent, clickable **"Switch to Build"** banner (the host adds the note even if the model claims it "fixed" something it only previewed, and removes any superfluous switch note when nothing was prepared).
- **Build** — full tool use: the same tools **write to disk**.

The Shell tool is read-only in Analyze (commands that would modify the filesystem are refused before running) and sub-agents launched in Analyze must be `access: "read"`.

## Parallel: sub-agents (orchestration)

The **Parallel** toggle enables the `Delegate` tool: the main agent becomes an **orchestrator** that decomposes a task into independent sub-tasks and runs them as **sub-agents** — each a separate `Agent` with its own ephemeral history (unbounded by default, like the orchestrator), with orchestration depth capped at 1. Sub-tasks that touch disjoint files run **in parallel**; overlapping writers (or a writer and a reader of the same resource) are **serialized** automatically. A configurable cap limits how many run at once. Each sub-agent streams live inside its own bubble and returns a report — and each bubble has its own **⏹ abort** button.

**With Parallel ON the orchestrator never does the work itself.** Until it has delegated, its first turn advertises **only the Delegate tool** (so it literally cannot start with WebSearch/Read/Shell), and any pre-delegation tool call is additionally blocked by the host. A request that needs **no tools** (a pure question/explanation) is answered directly; anything else follows the same 3-step flow in **both Analyze and Build**:

1. **Decide** — if the request needs no tools, just answer it directly and stop; otherwise you never do the work yourself: split the request into **1..N independent sub-tasks** (N ≥ 1; one is correct when nothing can run in parallel) and check resource conflicts so parallel tasks cannot clash (not only file paths: directories, generated files, configs, build outputs, read/write on the same path, a consumed artifact → ordered with `after`).
2. **Plan + launch** — in the *same* assistant turn, write a short plan for the user, then emit one `Delegate` per sub-task, all independent ones in that turn, each with a **meaningful `id`** (`frontend`, `api-tests`, …), declared `resources` + `access`, and — when the user attached files — `attachments: [n]` selecting **only the attachments that sub-task needs** (omit to forward all).
3. **Collect + answer** — after the reports arrive, synthesize one final answer (what was done, results, files, blockers); never claim what no sub-agent reported.

If the model tries to use a **non-Delegate tool before delegating**, the call is blocked and it is nudged once to delegate; if it still refuses, the **host dispatches a single READ-ONLY sub-agent itself** (recorded as a Delegate call, with its own bubble and report). Sub-agents share all tools (except `Delegate`) and the loop guard.

**Stop vs per-sub-task abort.** The global **Stop** aborts the whole run (every sub-agent together). The **⏹ abort** button on a single sub-agent bubble stops **only that one** — running or still queued behind the concurrency cap — and leaves the run alive. Either way a stopped sub-agent is reported as `aborted`: the orchestrator still receives that Delegate's tool result, marked `aborted` so it KNOWS the sub-task did not finish and can continue with the remaining work (never treating it as a completed report).

## Loop guard

Degenerate loops are detected and **broken** instead of silently stopping the run:

| Loop | How it's broken |
|------|-----------------|
| **reasoning** (within a turn) | the stream is cut and the model is told to stop reasoning and act |
| **reasoning** (across turns) | a corrective nudge is injected |
| **empty** (no text, no tool call) | the model is nudged to continue (bounded), then stopped loudly |
| **tool-failure** | identical failing calls are not re-run; a corrective is injected |
| **error-streak** | a summary of the failures + "change strategy" |
| **tool-repeat** | identical successful read-only calls are served from cache; a corrective is injected |

Each type escalates independently (up to `maxNudges` interventions — 2 by default, see the parameters below — then a final `❌ Loop not resolved […]`). Every intervention is logged in the transcript as a light-blue **"Nudge"** bubble stating the type and how the system reacted.

### Guardrails (per session)

Below the prompt sit **two cards**, both persisted **per session** (in the session's SQLite row) — never in the config file:

- **Parallel** — a **0–100 slider** for the concurrent sub-agent cap. `0` shows **"Off"** = **no cap** (unlimited); `1–100` is the cap. The legacy global `maxParallelSubAgents` in the config file is only the default for **new** sessions. Note: the **on/off toggle itself is a single GLOBAL switch** for the panel — only the cap is stored per session.
- **Loop Guard** — a **Sensitivity** radio group (`High` / `Normal` / `Low`), the **Include response** flag, and a **collapsible parameter section** (chevron on the *Include response* line, **collapsed by default**) with one **slider per parameter**.

Picking a sensitivity level loads that **preset** into the parameter sliders; moving a slider stores the **custom** value on the session (clamped to its editable range). Changing the level **resets** the custom values to the new preset (the preset is the new baseline).

#### Sensitivity presets

| | **High** (aggressive) | **Normal** (default) | **Low** (permissive) |
|---|---|---|---|
| `maxNudges` | 3 | 2 | 2 |
| `reasoningThreshold` | 0.45 | 0.5 | 0.65 |
| `reasoningMinTokens` | 50 | 60 | 120 |
| `crossTurnSimilarity` | 0.75 | 0.85 | 0.92 |
| `crossTurnMinLength` | 120 | 120 | 120 |
| `toolFailureRepeats` | 2 | 2 | 2 |
| `errorStreakTurns` | 2 | 3 | 5 |
| `toolRepeatConsecutive` | 2 | 3 | 4 |
| `toolRepeatWindow` | 10 | 16 | 20 |
| `toolRepeatWindowThreshold` | 2 | 3 | 4 |
| `answerThreshold` | 0.5 | 0.6 | 0.7 |
| `answerMinTokens` | 200 | 300 | 400 |

`High` = *flag loops sooner* (more nudges, lower thresholds); `Low` = *only clear, sustained loops*. The ranges below are the single source of truth shared by the panel and the host, and every value is **clamped again on load**, so a hand-edited session file can never put the guard out of bounds.

#### Every parameter

**Escalation**

| Parameter | Range (step) | What it does |
|---|---|---|
| `maxNudges` | 1–10 (1) | Reactive **nudges** a loop type gets before its escalation **stops the run**. Each loop type escalates independently, and the final stop is the loud `❌ Loop not resolved […]` notice. Higher = more patience before giving up. |
| `guardResponse` | on/off | **Include response**: also guard the **visible final answer** for repetition (mid-stream cut + a per-turn backstop), on top of the reasoning/tool guards. Off by default. |

**Reasoning loops**

| Parameter | Range (step) | What it does |
|---|---|---|
| `reasoningThreshold` | 0.05–1.00 (0.05) | **Within a turn**: the trigram-duplication ratio of the reasoning block that flags a loop (**lower = flags sooner**). On a hit the stream is cut and the model is told to stop reasoning and act. |
| `reasoningMinTokens` | 10–500 (10) | Minimum reasoning tokens before that check runs, so a short thought is never flagged. |
| `crossTurnSimilarity` | 0.05–1.00 (0.05) | **Across turns**: the Jaccard similarity of two turns' reasoning that flags a loop (**lower = flags sooner**) → a corrective nudge is injected. |
| `crossTurnMinLength` | 0–1000 (10) | Minimum reasoning characters before the across-turn check runs. |

**Tool loops**

| Parameter | Range (step) | What it does |
|---|---|---|
| `toolFailureRepeats` | 1–10 (1) | How many **identical failing** tool calls are re-run before they are refused: the recorded failure is returned instead and a corrective is injected. |
| `errorStreakTurns` | 1–10 (1) | Consecutive turns containing tool errors before the host injects a summary of the failures + "change strategy". |
| `toolRepeatConsecutive` | 1–10 (1) | Consecutive **identical successful** calls that flag a repeat loop → the call is served from cache and a corrective is injected. |
| `toolRepeatWindow` | 1–50 (1) | Size of the sliding window (in calls) used to count repeated call signatures. |
| `toolRepeatWindowThreshold` | 1–10 (1) | Repeats of the **same** signature inside that window that flag a loop. |

**Answer loops** (only when **Include response** is on)

| Parameter | Range (step) | What it does |
|---|---|---|
| `answerThreshold` | 0.05–1.00 (0.05) | Trigram-duplication ratio of the **final answer** that flags a repetition (**lower = flags sooner**). |
| `answerMinTokens` | 10–1000 (10) | Minimum answer tokens before the check runs. |

Every intervention is logged in the transcript as a light-blue **"Nudge"** bubble (and a line in **Output > Harny**) stating the loop type and how the system reacted.

## Agent Skills (skills.sh)

Harny is compatible with the **Agent Skills** ecosystem (skills.sh). A skill is a folder with a `SKILL.md` (YAML frontmatter `name` + `description`), installed with the official CLI:

```bash
npx skills add https://github.com/anthropics/skills --skill pptx -a pi -g -y
```

Harny scans the standard per-agent directories — project `.agents|.claude|.pi/skills`, then user `~/.agents`, `~/.config/agents`, `~/.pi/agent`, `~/.claude`, `~/.cursor`, `~/.gemini`, `~/.copilot`. A project skill shadows a user one of the same name.

- **Progressive disclosure**: the system prompt lists only `name: description`; the **`Skill` tool** loads the full `SKILL.md` on demand. The model activates a skill itself, or you force it with `/skill <name> [task]` (bypasses the model's choice).
- **Skills card** (in the controls) lists the installed skills as clickable text; a click fills the prompt with `/skill <name> `. `/skills` lists them.
- **`disable-model-invocation: true`** skills are hidden from the model and can only be activated manually.

## MCP servers

Harny speaks the **Model Context Protocol**, so it can use external tool servers. Configure them in `~/.harny/config.json` (Claude/Cursor-compatible) or from the panel:

```json
{
  "mcpServers": {
    "sqlite": { "command": "npx", "args": ["-y", "mcp-sqlite", "/path/db.sqlite"] },
    "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer …" } }
  }
}
```

- **Transports**: **stdio** (a spawned process) and **Streamable HTTP** (POST; JSON or `text/event-stream` responses; **stateless** by default, **stateful** via `Mcp-Session-Id`).
- **Tools** are exposed to the model as `mcp__<server>__<tool>` (input schema = the server's).
- **UI**: an **MCP** card lists the servers with a live status; **click the server name to enable/disable** it (a disabled server is kept in the config but not connected, so its tools are not exposed), and **`(N tools)`** opens a popover with each tool + description. A gear opens an editor to add/edit/delete servers and **Test** them.
- Diagnostic logs at the critical points (`[mcp]` / `[mcp-http]`) in **Output > Harny**.

## Diagnostics

Every turn writes one line to the **Output > Harny** channel:

```
[agent] turn 0: finish=stop content=123c thinking=456c tools=[Shell]
[agent] loop-guard [tool-repeat] level 1: identical successful tool call repeated three times — …
[agent] stop [truncation]: output-token limit reached (finish_reason=length)
```

Set `HARNY_DEBUG=1` to also log the exact request body to `/tmp/harny-debug.log`. Session transcripts live in the SQLite database `<home>/sessions.db`, handy to reconstruct any run.

## Sessions: right-side view (Activity Bar icon)

Harny keeps **persistent sessions** in a **single SQLite database** (`<home>/sessions.db`, pi/Cursor style) and manages them from a **single side view** opened with the Harny icon in the **Activity Bar** (right side). Each session is tagged with its workspace `folder`, the panel shows only the current folder's sessions, and living OUTSIDE the project means the agent tools (Read/Write/Edit/Grep…) can never touch transcripts and `rm -rf node_modules`-style cleanups never delete chat history. Storage uses the **built-in `node:sqlite`** (FTS5 for search), so it needs **VS Code 1.101+** (Node 22.5+).

- **Sessions area** (on top, **hideable** by clicking the header): list of the sessions of the current folder — each row shows the **creation/last-modified dates** above the name, with ✎ rename and 🗑 delete, and **+ New session**.
- **All-folders manager** (⚙ next to **+ New session**): lists **every** session across all workspace folders, most recent first, each with its folder. The current folder's row carries a **“this folder”** tag; a folder that no longer exists renders **red (“— missing”)**; a session with no folder shows **“(folder not set)”**. Per-row actions: **Open folder** (folder available and not the one already open — runs VS Code *Open Folder*, so Harny's working directory becomes that folder), **Change folder…** (missing/unset/current — opens a picker to re-point the session, pre-filled with its folder, after warning first when the folder is gone), and **Delete**. Folder matching is **cross-platform**: separators/trailing slash are normalized and Windows drive paths are compared case-insensitively.
- **Tab bar**: the names of all **open sessions** as tabs laid out **one after another**.
- **Overlapped chats**: chats are **stacked**, not side by side — only **one chat is visible at a time**, the one of the selected tab. Switching tabs shows the corresponding chat.
- **Branch**: each session row has a ⎇ button that **copies the session at its current state** (full transcript + per-session settings) into a new session and opens it. The dialog defaults to the original name. Hovering any **assistant reply** shows a ⎇ to branch the session **up to and including that reply** (same naming dialog, same uniqueness rules).
- **Cut / sanitize**: hovering a **user prompt** bubble shows a ✂ — it **truncates the current session IN PLACE** from that prompt downward (that message and everything after it are removed), after a confirmation. The removed tail is **not** kept, so branch first to preserve it; this is for "sanitizing" a conversation that took a bad turn and continuing from the clean point.
- **Unique names**: two sessions of the same workspace **cannot share a name** — the naming dialog validates live (create, rename and branch) and blocks duplicates (case-insensitive).
- **In-panel alerts**: all confirmations and notices (delete, compact, name conflicts, “session is working”) appear as in-panel modals inside the Harny area — same design family as the naming dialog, no native VS Code popups.
- **Queue & steer while working**: the prompt stays usable during a run — **Enter** queues the message (it runs as a new send when the current run ends), **Ctrl/Cmd+Enter** injects it as a **soft steer** (added to the conversation at the next turn boundary, without restarting the run). A **Queue/Steer** indicator (between Analyze/Build and Parallel; default **Queue**) shows what Enter and the play key will do: it turns **Steer** only while working with **Ctrl/Cmd** held, and returns to Queue when the key is released or the run ends. Pending messages show as cancellable bubbles above the prompt (you can delete individual steers before they go), and **all pending steers are submitted together as ONE message** at the next turn boundary; **Stop** clears them. In **Parallel**, a steer simply waits for the current sub-agent batch, then the orchestrator re-plans from the correction (no per-sub-agent targeting: use the **⏹** key on a sub-agent to stop it individually). Attachments work on queued and steered messages too.

**One agent = one session.** Each open session has its own `Agent` (dedicated history + event bus) in the registry. The side panel is a **single webview** that routes messages/events to the active session's runtime. Closing a tab **does not delete** the session (it stays persisted and reopenable). Sessions are organized by working folder (like pi/Cursor).

New sessions are **named at creation**: opening a new session prompts for a name with "New Session" as the default (also used by the context-menu commands). The sessions list shows each session's **creation date and last-modified date** before its name.

## Configuration

Harny reads configuration from **three sources**, in this order of precedence:

1. **`config.json`** in the extension data folder (`context.globalStorageUri`, or `HARNY_HOME`) — dedicated, **not** in the working folder
2. **VS Code settings** (`harny.*`) — User or Workspace settings
3. **Environment variable** `OPENAI_API_KEY` (key only)

### Dedicated `config.json` in the data folder

Copy `config.example.jsonc` into the **extension data folder** and personalize it (outside the repo, safe for keys). The folder follows the VS Code convention (`context.globalStorageUri`):

- macOS: `~/Library/Application Support/Code/User/globalStorage/spltek.harny`
- Windows: `%APPDATA%\Code\User\globalStorage\spltek.harny`
- Linux: `~/.config/Code/User/globalStorage/spltek.harny`

You can move it anywhere with the `HARNY_HOME` env var. The file is re-read live: changes are reflected in the model dropdown. Two formats are supported: **flat** (direct keys) and **multi-provider** (a `providers` map with provider + model selection):

```json
{
  "provider": "llamacpp",
  "model": "Qwen3.6-35B-A3B-UD-Q6_K.gguf",
  "providers": {
    "llamacpp": {
      "baseUrl": "http://127.0.0.1:8090/v1",
      "api": "openai-completions",
      "apiKey": "lamacpp",
      "thinking": "bool",
      "thinkingLevel": "medium",
      "models": [
        { "id": "Qwen3.6-35B-A3B-UD-Q6_K.gguf", "input": ["text", "image"] }
      ]
    }
  }
}
```

The `api` field is `openai-completions` (chat, the only supported protocol).

#### Provider entry examples — `thinking` per provider

The `thinking` field declares how the reasoning phase is expressed in the
request; combine it with `thinkingLevel` (the default level, overridable
per session — `off`/`low`/`medium`/`high`).

**1. Local llama.cpp / MLX with a Jinja template** — `thinking: "bool"` sends
`chat_template_kwargs.enable_thinking` + `reasoning_effort` (Qwen3, Gemma-4
Thinking, …):

```jsonc
"llamacpp": {
  "baseUrl": "http://127.0.0.1:8090/v1",
  "api": "openai-completions",
  "apiKey": "lamacpp",
  "thinking": "bool",
  "thinkingLevel": "medium",          // default level for this provider
  "models": [
    { "id": "Qwen3.8-27B-Q6_K.gguf", "input": ["text"] }
  ]
}
```

**2. OpenAI-style host (OpenAI)** — `thinking: "effort"`
sends top-level `reasoning_effort`; with no `models` the model dropdown auto-fills
from `GET /v1/models`:

```jsonc
"openai": {
  "baseUrl": "https://api.openai.com/v1",
  "api": "openai-completions",
  "apiKey": "sk-...",
  "thinking": "effort",
  "thinkingLevel": "medium"
}
```

**2a. OpenRouter-native** — `thinking: "reasoning"` sends `reasoning: { effort }`
for levels and `reasoning: { enabled: false }` for **Off**. This is the
*reliable* disable on OpenRouter for models whose default is thinking-on
(e.g. `deepseek/deepseek-v4-flash`, where omitting the field still reasons
sometimes):

```jsonc
"openrouter": {
  "baseUrl": "https://openrouter.ai/api/v1",
  "api": "openai-completions",
  "apiKey": "sk-or-...",
  "thinking": "reasoning",
  "thinkingLevel": "medium"
}
```

> Reasoning-mandatory models on OpenRouter (gpt-5 family) reject Off with
> HTTP 400 ("Reasoning is mandatory…"). Use `"effort"` for those — Off then
> leaves the model default.

**2b. DeepSeek/Anthropic-style toggle (OpenCode Go)** — `thinking: "type"` sends
`thinking: { type: "enabled" | "disabled" }`. OpenCode Go ignores
`reasoning_effort` levels for DeepSeek/Qwen/Kimi, so this is the switch that
actually turns thinking off and on (on `deepseek-v4.1-flash` it is 100%
reliable; `deepseek-v4-flash` is flaky regardless of the field):

```jsonc
"opencode-go": {
  "baseUrl": "https://opencode.ai/zen/go/v1",
  "api": "openai-completions",
  "apiKey": "sk-...",
  "thinking": "type",
  "thinkingLevel": "medium"
}
```

**3. Host you don't want to touch** — omit `thinking` (or set `"unspecified"`): Harny
sends nothing and the Thinking radio group stays disabled:

```jsonc
"ollama": {
  "baseUrl": "http://localhost:11434/v1",
  "api": "openai-completions",
  "apiKey": "ollama"
  // no "thinking": nothing sent, radio group disabled — provider default only
}
```

> `maxTokens` per entry is optional: it acts as the provider's default cap
> until the per-session **Output tokens** control is set, which then wins and
> is persisted (see *Window & sampling controls*). Leave it out to always use
> the session default (8192).

> **Tip — use `127.0.0.1` instead of `localhost`** for local servers. The
> extension also rewrites `localhost` → `127.0.0.1` automatically before
> fetching, but configuring it directly avoids the (rare) case where the DNS
> lookup for `localhost` stalls inside the VS Code extension host and surfaces
> as `fetch failed: Connect Timeout Error (... localhost:8090 ...)` while the
> server answers fine in a terminal/curl.

#### Thinking / reasoning level (per session)

A **Thinking** radio group sits in the **Window** card (Off / Low / Medium /
High) and is **generalized across providers**. Each provider entry declares how it
controls the reasoning phase with `thinking`:

| `thinking` | What Harny sends | Typical providers |
|------------|------------------|-------------------|
| `"bool"` | `chat_template_kwargs.enable_thinking` + `reasoning_effort` (standard OpenAI field, read by the model's Jinja template) | llama.cpp (Qwen3.8, Gemma-4 Thinking, …) |
| `"effort"` | `reasoning_effort: low/medium/high` (top-level); Off omits it | OpenAI, OpenAI-compatible |
| `"reasoning"` | `reasoning: { effort }` for levels; `reasoning: { enabled: false }` for Off | OpenRouter (reliable disable) |
| `"type"` | `thinking: { type: "enabled" \| "disabled" }` (on/off; no effort tiers) | OpenCode Go (DeepSeek, Qwen, Kimi), Anthropic-style hosts |
| absent / `"unspecified"` | nothing (provider default) | providers without thinking control |

- The level uses the **standard OpenAI field name** `reasoning_effort`
  (`low`/`medium`/`high`) in both modes; `enable_thinking` is only the
  llama.cpp on/off toggle.

- `thinkingLevel` on a provider entry sets its **default**; the radio group lets you
  override it **per session** (the choice is persisted with the session).
- The radio group is **enabled only for providers that declare** `thinking: "bool"`,
  `"effort"`, `"type"` or `"reasoning"` (see the config example) — otherwise it stays disabled at the
  provider default and Harny sends nothing.
- `Off` disables the phase where the provider allows it: `enable_thinking: false`
  for llama.cpp, `thinking: { type: "disabled" }` in `"type"` mode,
  `reasoning: { enabled: false }` in `"reasoning"` mode, and by **omitting**
  `reasoning_effort` in `"effort"` mode. Note: some models default to reasoning
  ON and cannot be disabled (reasoning-mandatory, e.g. the gpt-5 family rejects
  effort `"none"`/`enabled: false` with a 400); for models whose default is
  OFF (DeepSeek v4 on OpenRouter) omitting is exactly what keeps it off.
- Reasoning is **passed back** on later turns so tool-call chains keep their
  chain of thought: `reasoning_content` for llama.cpp/DeepSeek/opencode-go, and
  the full `reasoning_details` blocks (encrypted/summarized) for OpenRouter,
  captured from the stream and replayed verbatim.
- The legacy boolean `enableThinking: true/false` is still honored and maps to
  `thinking: "bool"` with a `medium`/`off` level.

With the multi-provider format the model dropdown shows **all** models from **all** declared providers (grouped by name), not just those of the active provider. Picking a local model (e.g. `llamacpp` or `ollama`) automatically switches base URL, API key and protocol: `provider` in the file only indicates the initial one.

#### Window & sampling controls (per session)

Below the model dropdown, two cards let you tune the session. Every numeric control is a **slider with a read-only value label** (the slider is the only control; the label always shows the exact value). The **Window** card holds the **context window**, the **output tokens** and the **thinking** level; the **Sampling** card holds the **sampler value**, the **presence penalty** and the **frequency penalty**. All are persisted with the session and restored on reopen:

- **Context window** (default `128000`): slider **32 000 → 2 000 000**, step 1000 — the compaction ceiling. Lower it to trigger auto-compaction earlier and keep the model fresh (avoids context rot), or raise it up to the model's maximum. The label keeps the **exact** host-pushed value (e.g. `131072`) while the slider sits on the nearest step. Auto-compaction runs **before a request**, **mid-run at every agent turn boundary** (it compacts the finished step, then the working continues), and **after the response**.
- **Output tokens** (default `8192`): slider **256 → 65 536**, step 256 — `max_tokens` sent per request; raise it for long edits/answers, lower it for quick chats. The session value wins over the provider's declared default.
- **Temperature / Top-P** (Auto by default): a compact **segmented toggle** (Temperature | Top-P) chooses which sampler is active — temperature `0.0–2.0` or top-p `0.0–1.0`, step 0.1 — and the **slider below** follows that scale. Only the active sampler is sent; **switching the toggle resets the value to Auto** (never a number on the wrong scale). The toggle choice AND the value (when ≠ Auto) are persisted per session.
- **Presence / Frequency penalty** (Auto by default): sliders `0.0–2.0`, step 0.1. Presence pushes toward new topics; frequency reduces repetition. Sent only when set (same strict-provider rule).
- **Auto** is the *not sent* state: pressing it clears the value (`null`) **and snaps the slider to the knob's default** — `1.0` for Temperature/Top-P, `0` for the penalties — so the control visibly shows what the provider will use.

#### Dynamic models from the host (`GET /v1/models`)

For providers that expose their model list (OpenAI, OpenRouter, opencode-go, llama.cpp, Ollama, …) just configure **only `apiKey` and `baseUrl`**, without listing models:

```jsonc
"opencode-go": {
  "baseUrl": "https://opencode.ai/zen/go/v1",
  "api": "openai-completions",
  "apiKey": "sk-..." // no "models"
}
```

- When opening the chat (or on every refresh) Harny fetches the list from `GET {baseUrl}/v1/models` and shows it in the dropdown, grouped by provider.
- The choice is **saved to the config file** (top-level `model`, and `provider` if you switch provider), preserving comments and formatting.
- On reopen Harny verifies the saved model still exists in the host list: if it was removed it reports it (invalid highlighted option + warning) and invites you to pick a new one.
- If the server is unreachable (e.g. llama.cpp is off) a "host models unavailable" warning appears instead of an empty dropdown.
- When the host reports each model's **context window** (OpenRouter `context_length`, vLLM `max_model_len`, llama.cpp `meta.n_ctx_train`, …) it is shown next to the model in the dropdown (`model · 128k`) and **adopted as the session's context window** on selection, so the compaction ceiling follows the real model size. If the host does **not** report it (e.g. **OpenCode Go**, whose `/models` has only `id/object/created/owned_by`), Harny falls back to the **models.dev** catalog (`<provider>.models.<id>.limit.context`, fetched lazily and cached for hours).



#### VS Code settings (`harny.*`)

| Setting | Default | Description |
|---------|---------|-------------|
| `harny.provider` | `openai` | Provider preset — always the OpenAI Chat Completions protocol (`openai`, `openai-compatible`, `anthropic`) |
| `harny.apiKey` | `""` | API key (falls back to `OPENAI_API_KEY` env var) |
| `harny.baseUrl` | `https://api.openai.com` | Base URL (for compatible providers) |
| `harny.model` | `gpt-4o` | Model for chat completions |
| `harny.maxTokens` | `8192` | Max tokens per response |
| `harny.subagentMaxTurns` | unset | Optional cap on a sub-agent's tool turns (also `subagentMaxTurns` in the config file). Unset/0 = **no cap**: sub-agents run until they finish or you press Stop, exactly like the orchestrator |
| `harny.temperature` | not set | Sampling temperature (omitted when unset; required by strict models) |
| `harny.thinkingMode` | not set | How the reasoning phase is expressed (`bool`, `effort`, `type`, `reasoning`, `unspecified`); the provider's `thinking` field and the per-session radio group override it — see the Thinking section |
| `harny.thinkingLevel` | `medium` | Default thinking level (`off`/`low`/`medium`/`high`); per provider entry you can also set `thinkingLevel` — the radio group only unlocks for providers that declare `thinking` |
| `harny.contextFiles` | `true` | Auto-include project files as context |
| `harny.autoApprove` | `false` | Auto-approve tool calls |
| `harny.autoOpen` | `false` | Open the chat panel on startup |
| `harny.dbVacuumThresholdPercent` | `20` | Free-page percentage above which Harny **suggests** compacting the sessions database (VACUUM) |
| `harny.dbVacuumMinFreeMB` | `128` | Minimum **reclaimable** megabytes below which Harny never suggests compacting (`0` = no minimum) |

### Commands

Harny registers **no custom Command Palette entries** — the palette stays clean. The view is opened from the Activity Bar icon, or via VS Code's auto-generated **Focus on Harny Chat View** / **View: Toggle Harny**. (The old `Harny: Open Chat` / `New Session` / `Reload Config` / `Debug Config` commands and the `Cmd+Shift+H` keybinding were removed.)

### Quick Start

1. `npm install` and `npm run build`
2. Open `harny/` in VS Code and press `F5` (Extension Development Host)
3. Set your API key: `Cmd+Shift+P` → `Preferences: Open Settings (JSON)` and add `"harny.apiKey": "sk-..."`, or set `OPENAI_API_KEY`.

### Using with Ollama / local LLMs

```json
{
  "harny.provider": "openai-compatible",
  "harny.baseUrl": "http://localhost:11434",
  "harny.apiKey": "ollama",
  "harny.model": "llama3.2"
}
```

## Packaging

```bash
npm install        # installs the local @vscode/vsce dev dependency
npm run package    # → harny-0.1.0.vsix
```

## License

MIT
