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
│   │   └── tools/                # Tool interface + ToolRegistry + 11 tools (one file each)
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

393 unit tests cover: config (file multi-provider, JSONC, precedence home/workspace), event bus, history, sessions (JSONL store, manager, registry), the OpenAI-compatible LLM provider, host-model fetching, all 11 tools, the agent loop (fake LLM, abort, max turns, loop detection), markdown/DOM (markdown-it + DOMPurify), the HTML generators and the chat view provider (mocked VS Code).

## Features

- **Chat Completions protocol** (`/v1/chat/completions`)
- **Streaming**: Real-time SSE streaming for responsive UX
- **11 tools**: Read, Write, StrReplace, Delete, Shell, Grep, Glob, TodoWrite, WebSearch, WebFetch, ReadLints
- **Agent loop**: Automatic tool execution, multi-turn continuation, loop detection (max turns)
- **Sessions**: Persistent per-workspace sessions (JSONL), one agent per session, right-side view with tabs
- **Naming**: new sessions are named at creation via a prompt (default "New Session"); the session list shows creation and last-modified dates
- **Model catalog**: Fetch the host model list (`GET /v1/models`) when the config only declares apiKey + baseUrl
- **Cross-platform storage**: Data lives in `context.globalStorageUri` (per-OS), overridable with `HARNY_HOME`
- **VS Code native**: Right-side Activity Bar view, context menu integration, keybindings
- **Extensible**: Add a tool by implementing the `Tool` interface and registering it in the `ToolRegistry`

## Sessions: right-side view (Activity Bar icon)

Harny keeps **persistent per-workspace sessions** (in `HARNY_HOME/sessions/<workspace>/`, JSONL) and manages them from a **single side view** opened with the Harny icon in the **Activity Bar** (right side):

- **Sessions area** (on top, **hideable** by clicking the header): list of the sessions of the current folder — each row shows the **creation/last-modified dates** above the name, with ✎ rename and 🗑 delete, and **+ New session**.
- **Tab bar**: the names of all **open sessions** as tabs laid out **one after another**.
- **Overlapped chats**: chats are **stacked**, not side by side — only **one chat is visible at a time**, the one of the selected tab. Switching tabs shows the corresponding chat.

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
- `Off` disables the phase where the provider allows it (`enable_thinking: false`
  for llama.cpp; `reasoning_effort` is omitted for OpenAI-style APIs, falling
  back to the model's default).
- The legacy boolean `enableThinking: true/false` is still honored and maps to
  `thinking: "bool"` with a `medium`/`off` level.

With the multi-provider format the model dropdown shows **all** models from **all** declared providers (grouped by name), not just those of the active provider. Picking a local model (e.g. `llamacpp` or `ollama`) automatically switches base URL, API key and protocol: `provider` in the file only indicates the initial one.

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
| `harny.contextFiles` | `true` | Auto-include project files as context |
| `harny.autoApprove` | `false` | Auto-approve tool calls |
| `harny.autoOpen` | `false` | Open the chat panel on startup |

### Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| `Harny: Open Chat` | `Cmd+Shift+H` | Open the Sessions view (right side) + a new chat |
| `Harny: New Session` | — | Create and open a new session (new tab) |
| `Harny: Explain This Code` | `Cmd+Shift+E` | Explain selection or whole file in a new session |
| `Harny: Edit with AI` | — | Ask AI to edit selected code in a new session |
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
