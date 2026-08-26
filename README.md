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
│   │   ├── agent/                # Agent orchestrator (DI), ToolCallAccumulator, SystemPrompt
│   │   ├── sessions/             # SessionStore <- JsonlSessionStore, SessionManager
│   │   │                         #   + one runtime (dedicated Agent) per open session
│   │   ├── storage/              # Cross-platform path resolution (context.globalStorageUri)
│   │   └── tools/                # Tool interface + ToolRegistry + 12 tools (one file each)
│   │                             #   FileSystem / CommandRunner / HttpClient abstractions
│   ├── chat/
│   │   ├── chat-view.ts          # Host WebviewViewProvider (single right-side view)
│   │   ├── session-registry.ts   # Per-session agents (one agent = one session)
│   │   ├── view-html.ts          # Pure HTML generator (sessions + tabs + chat)
│   │   └── webview/              # Webview client (TS): view.ts + markdown.ts
│   │       #                       markdown-it + DOMPurify, bundled with esbuild
│   └── logger.ts                 # Optional file logger (HARNY_DEBUG=1)
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

443 unit tests cover: config (file multi-provider, JSONC, precedence home/workspace), event bus, history, sessions (JSONL store, manager, registry), the OpenAI-compatible LLM provider, host-model fetching, all 12 tools, the agent loop (fake LLM, abort, max turns, loop detection), markdown/DOM (markdown-it + DOMPurify), the HTML generators and the chat view provider (mocked VS Code).

## Features

- **Chat Completions protocol** (`/v1/chat/completions`)
- **Streaming**: Real-time SSE streaming for responsive UX
- **12 tools**: Read, Write, StrReplace, Edit, Delete, Shell, Grep, Glob, TodoWrite, WebSearch, WebFetch, ReadLints
- **Agent loop**: Automatic tool execution, multi-turn continuation, loop detection (repeated failing/succeeding tool calls), no bounded turn count (Stop button only) — a `maxTurns` cap exists behind the scenes for tests/future config
- **Per-session controls**: context window, output tokens and temperature are editable in the panel, persisted **per session** (JSONL header) and restored on reopen; output tokens/temperature win over the provider defaults
- **Empty shell**: with no open session the control stack is hidden and a hero invites you to pick a session from the list or create a new one
- **Sessions**: Persistent per-workspace sessions (JSONL), one agent per session, right-side view with tabs
- **Sessions follow the folder**: stored in `<workspaceRoot>/.harny-sessions` — rename/move/delete a project and its sessions go with it (no global mapping, no dead entries)
- **Single-folder requirement**: Harny needs **exactly one open workspace folder**; without it (empty window or multi-root) the panel shows a "open a folder" hero and session commands are guarded
- **Naming**: new sessions are named at creation via a prompt (default "New Session"); the session list shows creation and last-modified dates
- **Model catalog**: Fetch the host model list (`GET /v1/models`) when the config only declares apiKey + baseUrl
- **Cross-platform storage**: The dedicated `config.json` lives in `context.globalStorageUri` (per-OS), overridable with `HARNY_HOME`; sessions live per-folder and are auto-gitignored (`.harny-sessions/` appended to the workspace `.gitignore` when it exists)
- **VS Code native**: Right-side Activity Bar view, context menu integration, keybindings
- **Extensible**: Add a tool by implementing the `Tool` interface and registering it in the `ToolRegistry`

## Sessions: right-side view (Activity Bar icon)

Harny keeps **persistent per-folder sessions** (in `<workspaceRoot>/.harny-sessions`, JSONL) and manages them from a **single side view** opened with the Harny icon in the **Activity Bar** (right side). It requires **exactly one open workspace folder**: sessions live inside that folder, so they follow it (rename/move/delete the project and the sessions follow), and the workspace `.gitignore` gets `.harny-sessions/` appended automatically (when a `.gitignore` exists) to keep transcripts out of git.

- **Sessions area** (on top, **hideable** by clicking the header): list of the sessions of the current folder — each row shows the **creation/last-modified dates** above the name, with ✎ rename and 🗑 delete, and **+ New session**.
- **Tab bar**: the names of all **open sessions** as tabs laid out **one after another**.
- **Overlapped chats**: chats are **stacked**, not side by side — only **one chat is visible at a time**, the one of the selected tab. Switching tabs shows the corresponding chat.
- **Branch**: each session row has a ⎇ button that **copies the session at its current state** (full transcript + per-session settings) into a new session and opens it. The dialog defaults to the original name. Hovering any **assistant reply** shows a ⎇ to branch the session **up to and including that reply** (same naming dialog, same uniqueness rules).
- **Unique names**: two sessions of the same workspace **cannot share a name** — the naming dialog validates live (create, rename and branch) and blocks duplicates (case-insensitive).
- **In-panel alerts**: all confirmations and notices (delete, compact, name conflicts, “session is working”) appear as in-panel modals inside the Harny area — same design family as the naming dialog, no native VS Code popups.

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
request; combine it with `thinkingLevel` (the dropdown default, overridable
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
  "thinkingLevel": "medium",          // dropdown default for this provider
  "models": [
    { "id": "Qwen3.8-27B-Q6_K.gguf", "input": ["text"] }
  ]
}
```

**2. OpenAI-style host (OpenAI, OpenRouter, opencode-go)** — `thinking: "effort"`
sends top-level `reasoning_effort`; with no `models` the dropdown auto-fills
from `GET /v1/models`:

```jsonc
"openrouter": {
  "baseUrl": "https://openrouter.ai/api/v1",
  "api": "openai-completions",
  "apiKey": "sk-or-...",
  "thinking": "effort",
  "thinkingLevel": "medium"
}
```

**3. Host you don't want to touch** — omit `thinking` (or set `"none"`): Harny
sends nothing and the Thinking dropdown stays disabled:

```jsonc
"ollama": {
  "baseUrl": "http://localhost:11434/v1",
  "api": "openai-completions",
  "apiKey": "ollama"
  // no "thinking": nothing sent, dropdown disabled — provider default only
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

A **Thinking** dropdown sits in the chat header (Off / Low / Medium / High) and
is **generalized across providers**. Each provider entry declares how it
controls the reasoning phase with `thinking`:

| `thinking` | What Harny sends | Typical providers |
|------------|------------------|-------------------|
| `"bool"` | `chat_template_kwargs.enable_thinking` + `reasoning_effort` (standard OpenAI field, read by the model's Jinja template) | llama.cpp (Qwen3.8, Gemma-4 Thinking, …) |
| `"effort"` | `reasoning_effort: low/medium/high` (top-level) | OpenAI, OpenRouter, opencode-go |
| absent / `"none"` | nothing (provider default) | providers without thinking control |

- The level uses the **standard OpenAI field name** `reasoning_effort`
  (`low`/`medium`/`high`) in both modes; `enable_thinking` is only the
  llama.cpp on/off toggle.

- `thinkingLevel` on a provider entry sets its **default**; the dropdown lets you
  override it **per session** (the choice is persisted with the session).
- The dropdown is **enabled only for providers that declare** `thinking: "bool"`
  or `"effort"` (see the config example) — otherwise it stays disabled at the
  provider default and Harny sends nothing.
- `Off` disables the phase where the provider allows it (`enable_thinking: false`
  for llama.cpp; `reasoning_effort` is omitted for OpenAI-style APIs, falling
  back to the model's default).
- The legacy boolean `enableThinking: true/false` is still honored and maps to
  `thinking: "bool"` with a `medium`/`off` level.

With the multi-provider format the model dropdown shows **all** models from **all** declared providers (grouped by name), not just those of the active provider. Picking a local model (e.g. `llamacpp` or `ollama`) automatically switches base URL, API key and protocol: `provider` in the file only indicates the initial one.

#### Window & sampling controls (per session)

Below the model dropdown, two cards let you tune the session. The **Window** card holds the **context window**, the **output tokens** and the **thinking** level; the **Sampling** card holds **temperature**, **presence penalty** and **frequency penalty** (0.0–2.0, `− / + / Auto` steps). All are persisted with the session and restored on reopen:

- **Context window** (default `128000`): the compaction ceiling — lower it to trigger auto-compaction earlier and keep the model fresh (avoids context rot), or raise it up to the model's maximum.
- **Output tokens** (default `8192`): `max_tokens` sent per request; raise it for long edits/answers, lower it for quick chats. The session value wins over the provider's declared default.
- **Temperature / Top-P** (Auto by default): a compact **segmented toggle** (Temperature | Top-P) chooses which sampler is active — temperature `0.0–2.0` or top-p `0.0–1.0` — and a **single shared stepper** below whose scale follows the toggle. Only the active sampler is sent; **switching the toggle resets the shared value to Auto** (never a number on the wrong scale). The toggle choice AND the value (when ≠ Auto) are persisted per session.
- **Presence / Frequency penalty** (Auto by default): `0.0–2.0`. Presence pushes toward new topics; frequency reduces repetition. Sent only when set (same strict-provider rule).

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



#### VS Code settings (`harny.*`)

| Setting | Default | Description |
|---------|---------|-------------|
| `harny.provider` | `openai` | Provider preset — always the OpenAI Chat Completions protocol (`openai`, `openai-compatible`, `anthropic`) |
| `harny.apiKey` | `""` | API key (falls back to `OPENAI_API_KEY` env var) |
| `harny.baseUrl` | `https://api.openai.com` | Base URL (for compatible providers) |
| `harny.model` | `gpt-4o` | Model for chat completions |
| `harny.maxTokens` | `8192` | Max tokens per response |
| `harny.temperature` | not set | Sampling temperature (omitted when unset; required by strict models) |
| `harny.thinkingMode` | not set | How the reasoning phase is expressed (`bool`, `effort`, `none`); the provider's `thinking` field and the per-session dropdown override it — see the Thinking section |
| `harny.thinkingLevel` | `medium` | Default thinking level (`off`/`low`/`medium`/`high`); per provider entry you can also set `thinkingLevel` — the dropdown only unlocks for providers that declare `thinking` |
| `harny.contextFiles` | `true` | Auto-include project files as context |
| `harny.autoApprove` | `false` | Auto-approve tool calls |
| `harny.autoOpen` | `false` | Open the chat panel on startup |

### Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| `Harny: Open Chat` | `Cmd+Shift+H` | Open the Sessions view (right side) + a new chat |
| `Harny: New Session` | — | Create and open a new session (new tab) |
| `Harny: Reload Config` | — | Reload the config file |
| `Harny: Debug Config` | — | Show the resolved config summary |

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
npm install -g @vscode/vsce
vsce package
# → harny-0.1.0.vsix
```

## License

MIT
