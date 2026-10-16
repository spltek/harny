# Harny

> **Your AI coding agent, inside VS Code.** Bring your own model — local or cloud.

![license](https://img.shields.io/badge/license-MIT-blue)
![VS Code](https://img.shields.io/badge/VS%20Code-1.101%2B-blue)

<!--
  🎬 HERO MEDIA — drop your screenshot / GIF / video here.
  NOTE: the repo is PRIVATE, so a relative path like media/hero.png will 404
  on open-vsx.org (raw.githubusercontent is not publicly readable). Host the
  file publicly and paste the absolute URL, or make the repo public.
  For a video, use a clickable thumbnail:
  [![Watch the demo](PUBLIC_THUMBNAIL_URL)](https://youtu.be/XXXXXXXX)
-->

## Contents

- [What is Harny](#what-is-harny)
- [What you can do with it](#what-you-can-do-with-it)
- [Why Harny](#why-harny)
- [Supported providers](#supported-providers)
- [Install](#install)
- [Quick start](#quick-start)
- [Setup](#setup)
- [How it works](#how-it-works)
- [Technical reference](#technical-reference)
- [License](#license)

## What is Harny

Harny is a full AI coding agent that lives in a **panel in your Activity Bar**. It reads your project, edits files, runs commands, searches the web and keeps a persistent conversation per folder — with tool calling and live streaming.

It speaks one protocol, the **OpenAI Chat Completions API**. That single choice is what lets it talk to almost anything: a cloud model, a model on your laptop, or a server you run yourself.

## What you can do with it

- **"Fix this bug"** → it reads the relevant files, proposes the edit, you review the diff, then it writes.
- **"Add tests for this module"** → it reads the code, writes the tests, runs them, and iterates until they pass.
- **"Refactor X across the repo"** → it splits the work into independent parts and runs them **in parallel** as sub-agents.
- **"What does this codebase do?"** → it explores, greps and explains, without modifying anything.
- **"Continue where we left off"** → the session is still there, with its files, settings and history.

## Why Harny

**Two stages: preview, then apply.** In **Analyze**, every file-modifying tool runs in *dry-run* — it returns the exact diff but writes nothing. You see what would change before anything is touched. Switch to **Build** when you are happy.

**Bring your own model.** OpenAI, Anthropic, OpenRouter, or a model running on your own machine with Ollama, LM Studio or llama.cpp. Switch between them from one dropdown, per session.

**Real parallelism, not a buzzword.** Turning on Parallel makes the agent an **orchestrator** that splits the task into independent sub-tasks and runs them as sub-agents — each with its own bubble, its own live stream and its own stop button.

**You are never locked out.** Keep typing while it works: **Enter** queues your message, **Ctrl/Cmd+Enter** steers the run mid-flight. **Esc** stops everything.

**Nothing is hidden.** Every turn shows real token usage and timings. Every tool call shows its input, its output and the diff. Reasoning is streamed as it happens.

**Your history lives outside your project.** Sessions are stored in a central SQLite database — not in your repo. Agent tools can never read or corrupt transcripts, and cleaning your project never deletes your chat history.

## Supported providers

Harny is **openai-compatible by design**, so anything that implements `/v1/chat/completions` works. Tested configurations:

| Provider | Notes |
|---|---|
| **OpenAI** | Direct, with `reasoning_effort` control |
| **Anthropic** | Via their OpenAI-compatible endpoint |
| **OpenRouter** | Including its own reasoning switch (`reasoning: { enabled }`) |
| **Ollama** | Local, no API key needed |
| **LM Studio** | Local, OpenAI-compatible server |
| **llama.cpp / MLX** | Local, with a Jinja template (`enable_thinking`) |
| **OpenCode Go** | Including `thinking: { type: enabled \| disabled }` |
| **Anything else** | Any host speaking OpenAI Chat Completions |

Model lists can be **declared by hand** or **discovered from the server** (`GET /v1/models`) — including each model's real context window.

## Install

**VSCodium, Cursor, Windsurf, Theia** — install from Open VSX:

- Search **Harny** in the Extensions view, or open
  [open-vsx.org/extension/spltek/harny](https://open-vsx.org/extension/spltek/harny)

**VS Code** — the Marketplace listing is not live yet, so install the `.vsix`:

```bash
code --install-extension spltek.harny-<version>.vsix
```

Download it from the [Open VSX page](https://open-vsx.org/extension/spltek/harny) (*Download*), or build it yourself with `npm run package`.

**Requirements:** VS Code **1.101+**. Harny stores sessions with the built-in `node:sqlite`, which needs Node 22.5+.

## Quick start

1. Install Harny and click the **Harny icon** in the Activity Bar.
2. Open **exactly one folder** (Harny is per-workspace: without a single folder it shows a hint instead of a chat).
3. Add your key: `Cmd/Ctrl+Shift+P` → **Preferences: Open Settings (JSON)** → `"harny.apiKey": "sk-..."`.
   Using a local model? Set `harny.provider`, `harny.baseUrl` and `harny.model` — see [Setup](#setup).
4. Type a request and press **Enter**.

New sessions start in **Analyze**, so your first run is a preview, not a surprise.

## Setup

### Pick your model

The simplest setup is VS Code settings:

```jsonc
{
  "harny.apiKey": "sk-...",
  "harny.model": "gpt-4o"
}
```

For a **local model** you don't need any API key:

```jsonc
{
  "harny.provider": "openai-compatible",
  "harny.baseUrl": "http://localhost:11434",
  "harny.apiKey": "ollama",
  "harny.model": "llama3.2"
}
```

> Prefer `127.0.0.1` over `localhost` for local servers — Harny rewrites it for you, but configuring it directly avoids a rare DNS stall inside the extension host.

### Several providers at once (recommended)

For real work, use a dedicated **`config.json`** in Harny's data folder, outside your project (so keys never risk being committed). It supports a **`providers` map**: the model dropdown then lists **every model of every provider**, grouped by name, and picking a local one switches base URL, key and protocol automatically.

```jsonc
{
  "provider": "llamacpp",                       // the one selected at startup
  "providers": {
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "thinking": "effort"                      // reasoning_effort
    },
    "llamacpp": {
      "baseUrl": "http://127.0.0.1:8090/v1",
      "apiKey": "llamacpp",
      "thinking": "bool",                       // enable_thinking (Qwen3, Gemma)
      "models": [{ "id": "Qwen3.8-27B-Q6_K.gguf", "input": ["text"] }]
    },
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "ollama"
      // no "thinking": Harny sends nothing, provider default
    }
  }
}
```

The data folder follows the VS Code convention (or set `HARNY_HOME` to move it):

- **macOS** `~/Library/Application Support/Code/User/globalStorage/spltek.harny`
- **Windows** `%APPDATA%\Code\User\globalStorage\spltek.harny`
- **Linux** `~/.config/Code/User/globalStorage/spltek.harny`

The file is **re-read live** — no reload needed. `config.example.jsonc` in the repo is a ready starting point.

### Sessions

Sessions are **per workspace folder**, stored in a single SQLite database in the data folder — never inside your project.

- **+ New session** creates one; every session is **named at creation**.
- Everything is **persisted**: chatting, settings, mode, attachments. Close the tab, reopen it later — it's still there. Closing a tab does **not** delete a session.
- **⎇ Branch** copies a session (transcript + settings) into a new one. Hover any **assistant reply** to branch from exactly that point.
- **✂ Cut** truncates a session in place from a given prompt — handy to undo a conversation that went sideways. *(Branch first if you want to keep the tail.)*
- The **⚙ All sessions** manager lists every session across all folders, with **Open folder** and **Change folder…** actions and full-text search.

### Tuning the model parameters

Every numeric control below the model dropdown is a **slider with an exact value label**, and **every choice is saved per session** and restored when you reopen it.

**Window**
- **Context window** — the compaction ceiling. The slider scale follows the model's *real* context window when the host reports it (or via the models.dev catalog). Lower it to compact earlier and keep responses sharp.
- **Output tokens** — the `max_tokens` sent per request. Raise it for long edits and long answers.
- **Thinking** — `Off` / `Low` / `Medium` / `High`, **generalized across providers**. Harny knows *how* each provider exposes reasoning and speaks its dialect:

| `thinking` | What Harny sends | Typical |
|---|---|---|
| `bool` | `chat_template_kwargs.enable_thinking` + `reasoning_effort` | llama.cpp, Qwen3, Gemma |
| `effort` | `reasoning_effort: low/medium/high` | OpenAI |
| `reasoning` | `reasoning: { effort }` / `{ enabled: false }` | OpenRouter |
| `type` | `thinking: { type: "enabled" \| "disabled" }` | Anthropic-style hosts |
| *(absent)* | nothing — provider default | Ollama, generic hosts |

**Sampling**
- **Temperature / Top-P** — one segmented toggle picks the active sampler; the slider follows that scale. Only the active one is sent.
- **Presence / Frequency penalty** — push toward new topics, or reduce repetition.
- **Auto** is the *not sent* state: it clears the value and snaps the slider back to the provider default, so you always see what will actually be used.

## How it works

### Analyze & Build

The header has a mode selector, and it is the core safety idea of Harny.

- **Analyze** — read-only **preview**. Write, StrReplace, Edit and Delete still run, but in **dry-run**: they validate the change and return the exact **diff**, writing nothing to disk. When changes are ready, Harny asks **once** whether to switch to Build and suggests restarting the chat for a clean apply.
- **Build** — the same tools **write for real**.

The Shell tool is **allowlist-first** in Analyze: a command runs only if every segment is a known read-only command (`ls`, `cat`, `grep`, `git status`, `git log`, …). Scripts, interpreters (`python -c`, `node -e`) and anything state-changing are refused. It is a **best-effort filter, not a sandbox** — treat Analyze as a strong guardrail, not a jail.

### Parallel: sub-agents

Turn **Parallel** on and the main agent becomes an **orchestrator**. It classifies the work by **independence**:

- **SPLITTABLE** → it must emit **N `Delegate` calls in the same turn**, one per independent part.
- **NOT splittable** (a dependency, or — in Build — two parts writing the same resource) → it uses its own tools.

Sub-tasks that touch disjoint files run **in parallel**; overlapping writers are **serialized automatically**. Each sub-agent streams live in its own bubble with its own **⏹ abort**, and returns a report that the orchestrator synthesizes into one final answer.

The important nuance: with Parallel ON, the model is told that **parallelism means sub-tasks** — its own tool calls in a turn still run one after another. With Parallel **OFF** the concept is hidden entirely: no `Delegate` tool, no mention in the prompt.

The cap is a **0–100 slider per session** — `0` means *Off = no cap*.

### Queue & Steer

The prompt stays usable **while the agent works**.

- **Enter** → **queues** the message; it runs as a new send when the current run ends.
- **Ctrl/Cmd+Enter** → **steers**: injected at the next turn boundary, without restarting the run.
- A **Queue/Steer** indicator shows what Enter will do, flipping to *Steer* only while you hold **Ctrl/Cmd** during a run.
- Pending messages appear as **cancellable bubbles** above the prompt. All pending steers are submitted together as **one** message at the next turn boundary. **Stop** clears them.

### How every step is tracked

- **Reasoning** is streamed live as it happens, and passed back on later turns so tool-call chains keep their chain of thought.
- **Tool calls** get a three-section bubble — **Input / Output / Diff**. When a tool touches a file, the Diff section shows the unified diff with the target path and `+N/−M` counts, syntax-highlighted for the main languages.
- **Every turn** ends with a **metrics badge** carrying the *real* provider usage: `6.9k in · 74 out · ⚡ 800 · elapsed 2.3s · first token 676ms`.
- **Diagnostics** go to **Output > Harny**, one line per turn.

### When it gets stuck

Degenerate loops are **broken, not silently stopped** — a light-blue **"Nudge"** bubble appears in the transcript saying what was detected and what Harny did.

| Detected | Reaction |
|---|---|
| Reasoning looping **within a turn** | stream cut, model told to stop reasoning and act |
| Reasoning looping **across turns** | corrective nudge injected |
| Empty turn (no text, no tool call) | nudged to continue, then stopped loudly |
| Identical **failing** tool call repeated | not re-run; the recorded failure is returned |
| Error streak across turns | failure summary + "change strategy" |
| Identical **successful** read-only call repeated | served from cache |

The **Loop Guard** card exposes a sensitivity preset (`High` / `Normal` / `Low`) and **12 tunable parameters**, all persisted per session. Optionally it also guards the **final answer** itself for repetition.

### Attachments

Add files with **+**, **paste** from the clipboard, or **drag & drop** (hold **Shift** while dropping, otherwise VS Code's *drop into editor* intercepts it). Images are sent as multimodal content and rendered large in the transcript with a click-to-open lightbox; other files become a card with a per-type icon.

---

## Technical reference

Everything below this line is implementation detail: architecture, the complete
feature list, the full configuration reference and the release process. If you
just want to use Harny, you can stop reading here.

### Features

**Agent**
- **Chat Completions protocol** (`/v1/chat/completions`) with **real-time SSE streaming**
- **14 tools**: Read, Write, StrReplace, Edit, Delete, Shell, Grep, Glob, Skill, TodoWrite, WebSearch, WebFetch, ReadLints, Delegate — plus dynamic `mcp__<server>__<tool>` from any MCP server
- **Agent loop**: automatic tool execution, multi-turn continuation, no bounded turn count (the Stop button is the only limit; a `maxTurns` cap exists behind the scenes for tests)
- **Two chat modes**: **Analyze** (read-only preview — changes are prepared and diffed but never written; when previews are ready the host asks **once** via a modal whether to switch to Build, with a tip to restart the chat for a clean apply) and **Build** (full tool use, writes for real). The transcript keeps a static, non-clickable note. The mode is persisted **per session** (restored on reopen; new sessions start in Analyze)
- **Output-token-limit handling**: the provider's `finish_reason` is propagated; a truncated response is surfaced explicitly ("raise `harny.maxTokens`") instead of failing silently

**Parallel / sub-agents**
- The **Parallel** toggle enables the `Delegate` tool: the main agent becomes an **orchestrator** that decomposes a task into independent sub-tasks, each a separate `Agent` with its own ephemeral history (unbounded by default), orchestration depth capped at 1
- Disjoint files run **in parallel**; overlapping writers (or a writer and a reader of the same resource) are **serialized automatically**. A configurable cap limits concurrency. Each sub-agent streams live in its own bubble and has its own **⏹ abort**
- **HARD RULE — decision → action:** the moment the model decides the work is parallelizable, the `Delegate` calls must be in **that same turn**. A turn that reasons "I will parallelize" but contains no `Delegate` call is invalid
- Each `Delegate` carries a meaningful `id`, declared `resources` + `access`, and — when the user attached files — `attachments: [n]` selecting **only** what that sub-task needs
- **`resources` are a coordination declaration, not a sandbox.** They let the host serialize overlapping writers; they do **not** restrict what a sub-agent may read or write, so declare honestly
- With Parallel **OFF** the concept is hidden entirely: `Delegate` is not advertised, the prompt never mentions sub-agents (or even the word "Parallel"), and past `Delegate` turns are filtered out of the conversation
- **Stop vs per-sub-task abort:** the global **Stop** aborts the whole run; the **⏹** on a bubble stops **only that one** — running or still queued behind the cap. Either way a stopped sub-agent is reported as `aborted`, so the orchestrator knows the sub-task did not finish and never treats it as a completed report
- Sub-agents share all tools (except `Delegate`) and the loop guard

**Loop guard**
- Reasoning, empty, failing-tool, error-streak and repeated-tool loops are **broken, not just stopped** — the host interrupts the degenerate behaviour, tells the model how to recover and keeps going; identical read-only calls are cached and identical failing calls are not re-run
- Each type escalates independently, up to `maxNudges` interventions (2 by default), then a final `❌ Loop not resolved […]`
- Every intervention is logged as a light-blue **"Nudge"** bubble and a line in **Output > Harny**

**Sessions**
- **Persistent per-workspace sessions** in a single SQLite database (`<home>/sessions.db`), one agent per session, single right-side view with tabs
- Stored **outside the project folder**, so the agent tools can never read or modify transcripts, and repo cleanups never delete chat history. The panel shows only the current folder's sessions
- **Schema migrations**: the schema is **versioned** (`PRAGMA user_version`) and upgraded **automatically on open** through an ordered, immutable migration list — see **[docs/MIGRATIONS.md](docs/MIGRATIONS.md)**
- **Sessions area** (hideable by clicking the header): each row shows creation/last-modified dates above the name, with ✎ rename, 🗑 delete and **+ New session**
- **All-folders manager** (⚙): lists every session across all workspace folders, most recent first, each with its folder. The current folder's row carries a **"this folder"** tag; a folder that no longer exists renders **red ("— missing")**; a session with no folder shows **"(folder not set)"**. Per-row **Open folder**, **Change folder…** and **Delete**. Folder matching is **cross-platform** (normalized separators, case-insensitive Windows drive paths)
- **Tab bar** with all open sessions, laid out one after another; chats are **stacked**, only the selected one visible
- **Branch** (⎇) copies a session at its current state (full transcript + per-session settings) into a new session and opens it; hovering any **assistant reply** branches **up to and including** that reply
- **Cut / sanitize** (✂) truncates the session **in place** from that prompt downward, after a confirmation. The removed tail is **not** kept — branch first to preserve it
- **Unique names**: two sessions of the same workspace cannot share a name (case-insensitive, validated live on create/rename/branch)
- **In-panel alerts**: all confirmations and notices appear as in-panel modals, no native VS Code popups
- **Single-folder requirement**: exactly one open workspace folder; without it the panel shows an "open a folder" hero and session commands are guarded
- **Empty shell**: with no open session the control stack is hidden and a hero invites you to pick or create one

**Agent Skills**
- Compatible with the **Agent Skills** ecosystem (`skills.sh`): a skill is a folder with a `SKILL.md` (YAML frontmatter `name` + `description`)
- Harny scans the standard agent skill directories — project `.agents/`, `.claude/`, `.pi/skills/`, then user `~/.agents`, `~/.config/agents`, `~/.pi/agent`, `~/.claude`, `~/.cursor`, `~/.gemini`, `~/.copilot`. A project skill shadows a user one of the same name
- **Progressive disclosure**: the system prompt lists only `name: description`; the **`Skill` tool** loads the full `SKILL.md` on demand. The model activates a skill itself, or you force it with `/skill <name> [task]`
- **Skills card** lists the installed skills as clickable text; `/skills` lists them
- **`disable-model-invocation: true`** skills are hidden from the model and can only be activated manually
- **Slash menu**: typing `/` at the START of the prompt opens a picker — arrows/Enter select, Esc closes

**MCP servers**
- Speaks the **Model Context Protocol**; configure in `~/.harny/config.json` or from the panel

```json
{
  "mcpServers": {
    "sqlite": { "command": "npx", "args": ["-y", "mcp-sqlite", "/path/db.sqlite"] },
    "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer …" } }
  }
}
```

- **Transports**: **stdio** (spawned process) and **Streamable HTTP** (POST; JSON or `text/event-stream`; **stateless** by default, **stateful** via `Mcp-Session-Id`)
- Tools are exposed as `mcp__<server>__<tool>` (input schema = the server's)
- **UI**: an **MCP** card lists servers with live status; **click the server name to enable/disable** it, **`(N tools)`** opens a popover with each tool, a gear opens an editor (add/edit/delete + **Test**)
- Diagnostic logs at the critical points (`[mcp]` / `[mcp-http]`) in **Output > Harny**

**UI**
- **Esc to stop**: press Esc while a run is working to stop it — modals/overlays and native controls keep Esc for themselves
- **Focus always on the prompt**: the caret returns to the input after opening/switching a session, finishing a run, a cut, and after mode/parallel/model/attach interactions
- **Attachments**: **+** button, **paste from clipboard**, or **drag & drop** (hold **Shift** for OS file drops). Images are attached inline as data URIs and sent as multimodal content, text files as inline code blocks, and a pasted/dropped absolute path or `file://` URI attaches that file. In the transcript images render **large** (a third of the chat width, **resizable**, stacked, click for a **full-size lightbox**) and are **persisted with the message**; other files become a **card with a large per-type icon** (PDF / code / Markdown / JSON / sheet / archive, tinted by category) plus name and size. Under the prompt, pending attachments show the same icon small. Binary files copied in Finder/Explorer usually reach the webview only as their **name**, so use the **+** button; an attached binary is detected **from its content** (magic bytes — PDF, ZIP, OLE2, …) and reported to the model as such, never inlined as garbage
- **Plain tool outputs + three-section tool bubbles**: tool outputs are never colorized by line-prefix heuristics (an `ls -la` listing stays plain text); when Edit/Write/StrReplace/Delete touch a file, the bubble gets a third **Diff** section (Input / Output / Diff, collapsed with the bubble) showing the unified diff — a new file as all `+`, a deleted file as all `−` — with the **target file path in azure** after the tool name and `+N/−M` counts in the Diff header
- **Syntax highlighting in Diff sections**: editor-style colors (Prism, one-dark) for TypeScript, JavaScript, Python, Rust, C#, HTML, CSS, JSON, Markdown, Bash, SQL and Go — unknown extensions fall back to plain diff coloring
- **Per-turn metrics badge**: under every assistant turn, `6.9k in · 74 out · ⚡ 800 · elapsed 2.3s · first token 676ms` (hover for detail). Appears as soon as the turn ends (a `turn_meta` event, no transcript re-render), shown for tool-only turns too, captured from the provider stream and persisted with the message
- **Real context accounting**: the context-fill metric prefers the provider-reported input tokens; after a ✂ cut it is recomputed from the **kept** messages and persisted (cutting everything → 0, so it no longer "jumps back" on reload), and after a compaction the kept window's real cumulative-input delta is used. Auto-compaction follows the same numbers
- **Responsive control stack**: cards lay out **1 / 2 / 4 per row** as the panel widens, all share one row height so columns line up, and the stack **scrolls vertically** once it would take more than 75% of the panel height
- **Per-session controls**: mode, Parallel on/off, context window, output tokens, sampler value, presence/frequency penalties, thinking level and every Loop Guard parameter are sliders (each with a read-only value label; **Auto** snaps back to the knob's default) persisted **per session** and restored on reopen; they win over provider defaults
- **Diagnostics**: one line per turn (finish reason, content/thinking sizes, tool names, loop-guard decisions) in **Output > Harny**; set `HARNY_DEBUG=1` for a full request body log

**Storage**
- **Database compaction (VACUUM)**: the **All sessions** modal has two sliders (free-page % above which compaction is suggested — default `20`; minimum **reclaimable** MB — default `128`) plus the free/total numbers and **Compact & optimize indexes…**. The same modal is suggested automatically after a ✂ cut / session delete (and once at startup) when the DB is bloated, runs **"a bocce ferme"** (never during a live turn, since VACUUM is synchronous) and reports the **before → after** result. It also runs `PRAGMA optimize` and the **FTS5 `optimize`** (VACUUM alone does NOT merge full-text segments)
- **Cross-platform storage**: config and sessions live in `context.globalStorageUri` (per-OS), overridable with `HARNY_HOME`; nothing is written inside the workspace
- **Model catalog**: fetch the host model list (`GET /v1/models`) when the config only declares apiKey + baseUrl

### Architecture

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

**SOLID principles applied**

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

**1300+ unit tests** cover: config (file multi-provider, JSONC, precedence home/workspace), event bus, history, sessions (SQLite store with FTS5 search, **versioned schema migrations** via `PRAGMA user_version`, manager, registry, compactor, the cross-folder manager with its open/change-folder actions, the per-session control settings incl. the Loop Guard parameters), the OpenAI-compatible LLM provider (streaming, tool calls, `finish_reason`), host-model fetching, all 14 tools (including the Analyze dry-run preview), the mode policy, the agent loop (fake LLM, abort, max turns), the **loop guard** (reasoning/empty/tool-failure/error-streak/tool-repeat detection, tool-call dedup, sensitivity presets, the editable parameter ranges + their clamping), orchestration/sub-agents, **Agent Skills** (SKILL.md parsing + discovery), **MCP** (stdio + Streamable HTTP clients, tool wrapper, manager), markdown/DOM (markdown-it + DOMPurify), the HTML generators and the chat view provider (mocked VS Code, incl. the control-stack wiring: sliders, Auto defaults, the collapsible Loop Guard parameters and the responsive layout), the per-turn metrics badge (real usage + timings), the real context accounting (after a ✂ cut / compaction) and the DB compaction + index optimization (VACUUM, `PRAGMA optimize`, FTS5 `optimize`).

### Configuration reference

#### Sources and precedence

Harny reads configuration from **three sources**, in this order:

1. **`config.json`** in the extension data folder (`context.globalStorageUri`, or `HARNY_HOME`) — dedicated, **not** in the working folder
2. **VS Code settings** (`harny.*`) — User or Workspace settings
3. **Environment variable** `OPENAI_API_KEY` (key only)

#### VS Code settings (`harny.*`)

| Setting | Default | Description |
|---------|---------|-------------|
| `harny.provider` | `openai` | Provider preset — all use the OpenAI Chat Completions protocol (`openai`, `openai-compatible`, `anthropic`) |
| `harny.apiKey` | `""` | API key (falls back to `OPENAI_API_KEY`) |
| `harny.baseUrl` | `https://api.openai.com` | Base URL (for compatible providers) |
| `harny.model` | `gpt-4o` | Model for chat completions |
| `harny.maxTokens` | `16384` | Max tokens per response |
| `harny.temperature` | not set | Sampling temperature (omitted when unset; required by strict models) |
| `harny.thinkingMode` | not set | How the reasoning phase is expressed (`bool`, `effort`, `type`, `reasoning`, `unspecified`) — the provider's `thinking` field and the per-session radio group override it |
| `harny.thinkingLevel` | `medium` | Default thinking level (`off`/`low`/`medium`/`high`); per provider entry you can also set `thinkingLevel` — the radio group only unlocks for providers that declare `thinking` |
| `harny.autoOpen` | `false` | Open the chat panel on startup |
| `harny.dbVacuumThresholdPercent` | `20` | Free-page percentage above which Harny **suggests** compacting the sessions database (VACUUM) |
| `harny.dbVacuumMinFreeMB` | `128` | Minimum **reclaimable** megabytes below which Harny never suggests compacting (`0` = no minimum) |

#### Provider entry examples — `thinking` per provider

The `thinking` field declares how the reasoning phase is expressed in the request; combine it with `thinkingLevel` (the default level, overridable per session — `off`/`low`/`medium`/`high`).

**1. Local llama.cpp / MLX with a Jinja template** — `thinking: "bool"` sends `chat_template_kwargs.enable_thinking` + `reasoning_effort`:

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

**2. OpenAI-style host** — `thinking: "effort"` sends top-level `reasoning_effort`; with no `models` the dropdown auto-fills from `GET /v1/models`:

```jsonc
"openai": {
  "baseUrl": "https://api.openai.com/v1",
  "api": "openai-completions",
  "apiKey": "sk-...",
  "thinking": "effort",
  "thinkingLevel": "medium"
}
```

**2a. OpenRouter-native** — `thinking: "reasoning"` sends `reasoning: { effort }`, and `reasoning: { enabled: false }` for **Off**. This is the *reliable* disable on OpenRouter for models whose default is thinking-on (e.g. `deepseek/deepseek-v4-flash`, where omitting the field still reasons sometimes):

```jsonc
"openrouter": {
  "baseUrl": "https://openrouter.ai/api/v1",
  "api": "openai-completions",
  "apiKey": "sk-or-...",
  "thinking": "reasoning",
  "thinkingLevel": "medium"
}
```

> Reasoning-mandatory models on OpenRouter (gpt-5 family) reject Off with HTTP 400 ("Reasoning is mandatory…"). Use `"effort"` for those — Off then leaves the model default.

**2b. DeepSeek/Anthropic-style toggle** — `thinking: "type"` sends `thinking: { type: "enabled" | "disabled" }`. OpenCode Go ignores `reasoning_effort` levels for DeepSeek/Qwen/Kimi, so this is the switch that actually turns thinking off and on (on `deepseek-v4.1-flash` it is 100% reliable; `deepseek-v4-flash` is flaky regardless of the field):

```jsonc
"opencode-go": {
  "baseUrl": "https://opencode.ai/zen/go/v1",
  "api": "openai-completions",
  "apiKey": "sk-...",
  "thinking": "type",
  "thinkingLevel": "medium"
}
```

**3. Host you don't want to touch** — omit `thinking` (or set `"unspecified"`): Harny sends nothing and the Thinking radio group stays disabled:

```jsonc
"ollama": {
  "baseUrl": "http://localhost:11434/v1",
  "api": "openai-completions",
  "apiKey": "ollama"
  // no "thinking": nothing sent, radio group disabled — provider default only
}
```

> `maxTokens` per entry is optional: it acts as the provider's default cap until the per-session **Output tokens** control is set, which then wins and is persisted. Leave it out to always use the session default.

#### How the thinking level maps to each provider

- `"bool"` → `chat_template_kwargs.enable_thinking` + `reasoning_effort` (standard OpenAI field, read by the model's Jinja template)
- `"effort"` → `reasoning_effort: low/medium/high` (top-level); Off omits it
- `"reasoning"` → `reasoning: { effort }` for levels; `reasoning: { enabled: false }` for Off
- `"type"` → `thinking: { type: "enabled" | "disabled" }` (on/off, no effort tiers)
- absent / `"unspecified"` → nothing (provider default)

- The level uses the **standard OpenAI field name** `reasoning_effort` in both modes; `enable_thinking` is only the llama.cpp on/off toggle.
- The radio group is **enabled only for providers that declare** `thinking` — otherwise it stays disabled at the provider default.
- `Off` disables the phase where the provider allows it. Some models default to reasoning ON and cannot be disabled (reasoning-mandatory, e.g. the gpt-5 family rejects effort `"none"` with a 400); for models whose default is OFF, omitting is exactly what keeps it off.
- Reasoning is **passed back** on later turns so tool-call chains keep their chain of thought: `reasoning_content` for llama.cpp/DeepSeek/opencode-go, and the full `reasoning_details` blocks (encrypted/summarized) for OpenRouter, captured from the stream and replayed verbatim.
- The legacy boolean `enableThinking: true/false` is still honored and maps to `thinking: "bool"` with a `medium`/`off` level.

With the multi-provider format the model dropdown shows **all** models from **all** declared providers (grouped by name). Picking a local model automatically switches base URL, API key and protocol: `provider` in the file only indicates the initial one.

#### Dynamic models from the host (`GET /v1/models`)

For providers that expose their model list (OpenAI, OpenRouter, opencode-go, llama.cpp, Ollama, …) configure **only `apiKey` and `baseUrl`**, without listing models:

```jsonc
"opencode-go": {
  "baseUrl": "https://opencode.ai/zen/go/v1",
  "api": "openai-completions",
  "apiKey": "sk-..." // no "models"
}
```

- When opening the chat (or on every refresh) Harny fetches the list from `GET {baseUrl}/v1/models` and shows it in the dropdown, grouped by provider.
- The choice is **saved to the config file** (top-level `model`, and `provider` if you switch provider), preserving comments and formatting.
- On reopen Harny verifies the saved model still exists: if it was removed it reports it (invalid highlighted option + warning) and invites you to pick a new one.
- If the server is unreachable (e.g. llama.cpp is off) a "host models unavailable" warning appears instead of an empty dropdown.
- When the host reports each model's **context window** (OpenRouter `context_length`, vLLM `max_model_len`, llama.cpp `meta.n_ctx_train`, …) it is shown next to the model (`model · 128k`) and **adopted as the session's context window** on selection. If the host does **not** report it (e.g. **OpenCode Go**, whose `/models` has only `id/object/created/owned_by`), Harny falls back to the **models.dev** catalog (`<provider>.models.<id>.limit.context`, fetched lazily and cached for hours).

#### Window & sampling controls (per session)

Below the model dropdown, two cards let you tune the session. Every numeric control is a **slider with a read-only value label**. All are persisted with the session and restored on reopen:

- **Context window** (default `128000`): the slider **scale is the model's real context window** when it is known, otherwise a `2 048 000` fallback; step 1000. It is the compaction ceiling. Auto-compaction runs **before a request**, **mid-run at every agent turn boundary**, and **after the response**.
- **Output tokens** (default `16384`): the slider **scale is the model's real max output** when known, otherwise a `512 000` fallback; step 256. It is the `max_tokens` sent per request. The session value wins over the provider's declared default.
- **Temperature / Top-P** (Auto by default): a segmented toggle chooses which sampler is active — temperature `0.0–2.0` or top-p `0.0–1.0`, step 0.1 — and the slider below follows that scale. Only the active sampler is sent; **switching the toggle resets the value to Auto**. The toggle choice AND the value (when ≠ Auto) are persisted per session.
- **Presence / Frequency penalty** (Auto by default): sliders `0.0–2.0`, step 0.1. Presence pushes toward new topics; frequency reduces repetition. Sent only when set.
- **Auto** is the *not sent* state: pressing it clears the value (`null`) **and snaps the slider to the knob's default** — `1.0` for Temperature/Top-P, `0` for the penalties.

#### Loop Guard parameters

**Escalation**

| Parameter | Range (step) | What it does |
|---|---|---|
| `maxNudges` | 1–10 (1) | Reactive **nudges** a loop type gets before its escalation **stops the run**. Each type escalates independently; the final stop is the loud `❌ Loop not resolved […]` notice. |
| `guardResponse` | on/off | **Include response**: also guard the **visible final answer** for repetition (mid-stream cut + a per-turn backstop). Off by default. |

**Reasoning loops**

| Parameter | Range (step) | What it does |
|---|---|---|
| `reasoningThreshold` | 0.05–1.00 (0.05) | **Within a turn**: the trigram-duplication ratio of the reasoning block that flags a loop (**lower = flags sooner**). On a hit the stream is cut and the model is told to stop reasoning and act. |
| `reasoningMinTokens` | 10–500 (10) | Minimum reasoning tokens before that check runs, so a short thought is never flagged. |
| `crossTurnSimilarity` | 0.05–1.00 (0.05) | **Across turns**: the Jaccard similarity of two turns' reasoning that flags a loop → a corrective nudge is injected. |
| `crossTurnMinLength` | 0–1000 (10) | Minimum reasoning characters before the across-turn check runs. |

**Tool loops**

| Parameter | Range (step) | What it does |
|---|---|---|
| `toolFailureRepeats` | 1–10 (1) | How many **identical failing** tool calls are re-run before they are refused: the recorded failure is returned instead and a corrective is injected. |
| `errorStreakTurns` | 1–10 (1) | Consecutive turns containing tool errors before the host injects a summary + "change strategy". |
| `toolRepeatConsecutive` | 1–10 (1) | Consecutive **identical successful** calls that flag a repeat loop → served from cache + a corrective is injected. |
| `toolRepeatWindow` | 1–50 (1) | Size of the sliding window (in calls) used to count repeated call signatures. |
| `toolRepeatWindowThreshold` | 1–10 (1) | Repeats of the **same** signature inside that window that flag a loop. |

**Answer loops** (only when **Include response** is on)

| Parameter | Range (step) | What it does |
|---|---|---|
| `answerThreshold` | 0.05–1.00 (0.05) | Trigram-duplication ratio of the **final answer** that flags a repetition (**lower = flags sooner**). |
| `answerMinTokens` | 10–1000 (10) | Minimum answer tokens before the check runs. |

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

`High` = *flag loops sooner*; `Low` = *only clear, sustained loops*. Picking a level loads that **preset** into the sliders; moving a slider stores the **custom** value on the session (clamped to its editable range). Changing the level **resets** the custom values to the new preset. Every value is **clamped again on load**, so a hand-edited session file can never put the guard out of bounds.

#### Commands

Harny registers **no custom Command Palette entries** — the palette stays clean. The view is opened from the Activity Bar icon, or via VS Code's auto-generated **Focus on Harny Chat View** / **View: Toggle Harny**.

#### Development

```bash
npm install
npm run build      # build both bundles (host + webview)
npm run dev        # watch both — reload the VS Code window after a rebuild
npm test           # unit tests
```

Then open `harny/` in VS Code and press `F5` (Extension Development Host).

### Packaging

```bash
npm install        # installs the local @vscode/vsce dev dependency
npm run package    # → harny-<version>.vsix
```

Releases are cut from a `vX.Y.Z` git tag: the workflow typechecks, tests, builds, packages, creates the GitHub Release and publishes to **Open VSX** via **trusted publishing** (OIDC, no token — so VSCodium and compatible editors auto-update). The VS Code Marketplace step is **opt-in** and skips unless `VSCE_PAT` is configured. The full guide — versioning, publishers/trusted publishing, pre-releases, troubleshooting — is in **[docs/RELEASE.md](docs/RELEASE.md)**; notable changes are tracked in [CHANGELOG.md](CHANGELOG.md).

## License

MIT
