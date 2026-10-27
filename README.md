# Harny

> **Your AI coding agent, inside VSCodium and VS Code.** Bring your own model — local or cloud.

![license](https://img.shields.io/badge/license-MIT-blue)
![VSCodium](https://img.shields.io/badge/VSCodium-1.101%2B-blue?logo=vscodium)
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

**Long sessions keep working.** When the context fills, Harny compacts at **turn boundaries**, keeps the recent part verbatim, **carries the state of the work forward** and stops old tool outputs from eating the window. A model that declares no window is not a dead end either: the provider's own rejection tells Harny the real limit, which it then adopts.

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

**Requirements:** the VS Code extension API **1.101+** — i.e. VSCodium 1.101+ as well (VSCodium tracks it). Harny stores sessions with the built-in `node:sqlite`, which needs Node 22.5+.

## Quick start

1. Install Harny and click the **Harny icon** in the Activity Bar.
2. Open **exactly one folder** (Harny is per-workspace: without a single folder it shows a hint instead of a chat).
3. Add your provider **in the panel**: the gear at the **right end of the AI Model row** (⚙, after the model selector) opens **Providers & Models** → **+ New**, paste your key, pick a model (each host's list is fetched live; **Test connection** checks the entry). It lives in Harny's own data folder, never in your project.
   Prefer files? `harny.apiKey` in VS Code settings, or a `config.json` — see [Setup](#setup).
4. Type a request and press **Enter**.

New sessions start in **Analyze**, so your first run is a preview, not a surprise.

## How a session goes

The order things come up in — and, more useful, **where each one lives**. Some of it you set **once** (global), some follows each **session**, and only a couple of things are worth touching **while the agent is working**.

1. **Create a session** (**+ New**). It is written to the database immediately and starts in **Analyze**.
2. **Pick the model** in the AI Model row — or, with no provider yet, open the gear at the **right end of that row** (**Providers & Models** → **+ New** → **Test connection**). That setup is **global**: once is enough, for every future session.
3. **Skills** (optional) are **not a dialog**: they are folders. A `skills`-CLI install and a plain `SKILL.md` both work — project first (`.agents/skills`, `.claude/skills`, `.pi/skills`), then user (`~/.agents/skills`, `~/.pi/agent/skills`, `~/.claude/skills`, `~/.cursor/skills`, …). The **Skills** card lists what it found; a click fills `/skill <name>` in the prompt.
4. **MCP servers** (optional, **global**): the **MCP** card's gear (add/edit/delete + **Test**), or `config.json`. Careful, in Analyze a server's tools only run if you declare what that server is — see [Analyze & Build](#analyze--build).
5. **Housekeeping**: the **Compaction** gear (after **Compact**) sets the whole compaction policy **per session** — the **auto-compaction trigger** (when it starts, default 80% of the usable context) and **how much survives the cut** (*Land at*: a share of the usable context, default **10%** = an eighth of the trigger, i.e. two or three exchanges kept verbatim; `0` means only the summary remains), plus a live preview of the plan the next compaction would run; the label next to it reads `Auto 80% ctx · keep 10%`. The **⚙ All sessions** manager holds the database stats and the **VACUUM** thresholds (**global**).
6. **Tuning** (optional, **per session**): the sampling/context/output sliders, the thinking level, and **Guardrails** (sub-agent cap + Loop Guard parameters).
7. **Analyze or Build**, and **Parallel** — **per session**, and **locked while a run is going** (they are decided once per run, and the pill's tooltip says so).
8. **While it works**: **Enter** queues a message (it runs when this one ends), **Ctrl/Cmd+Enter** **steers** it into the run now, **Esc** stops. A message already queued can be flipped to a steer with its **→ Steer** button. Every fold in the panel (thinking, tool cards, sub-agents, the pending list, a long bubble) is **one chevron that turns**: pointing right when closed, down when open — the same shape the rest of the UI uses, and the box never changes size.

| | where it lives | mid-run? |
|---|---|---|
| providers, keys, MCP servers, VACUUM thresholds | **global** (`config.json` / VS Code settings) | no |
| model, thinking, sliders, context window, output tokens, Guardrails, compaction policy (trigger + landing point) | **per session** | no |
| **Analyze/Build**, **Parallel** | **per session** | **no** — locked while it works: decided once per run, and the pill says why instead of swallowing the click (**Stop** is the way to interrupt) |
| Enter / Ctrl-Cmd+Enter / Esc | per message | always |
| **Compact**, **✂ Cut**, **⎇ Branch** | the transcript itself | no — they restructure the conversation, so they wait for the run |

> Why that split: Mode and Parallel change the agent's **behaviour inside the same request envelope** — same context, same budget, same accounting — while the model, the window and the samplers move the envelope itself, and a run whose envelope changed halfway is not something you want to reconstruct from a transcript later. Behaviour is also where the **promises** live (*Analyze means nothing is written*), so it is decided **once per run**: a run cannot acquire a different mode halfway, and the two pills are locked while it works — with a tooltip, never in silence. Providers and MCP are one level up again: they are the **environment**, set once.

## Setup

### Pick your model

Open the panel and use the gear at the **right end of the AI Model row** → **Providers & Models** → **+ New**: a name, the base URL, the key, and **Test connection** to check it. That is the whole setup, and it keeps keys outside your project.

- **A local model needs no key** — anything non-empty will do, e.g. `ollama` or `llamacpp`. The base URL is the one the **server** listens on: `http://127.0.0.1:11434/v1` for Ollama, `http://127.0.0.1:8090/v1` for llama.cpp.
- **Prefer `127.0.0.1` over `localhost`** in that URL — Harny rewrites it for you, but typing it directly avoids a rare DNS stall inside the extension host.

### Several providers at once (recommended)

For real work, add more providers **in the same editor**: **+ New** once per provider, **Test connection** for each, and **Export/Import models configuration** to carry the whole set to another machine.

Every provider stays active at once: the model dropdown then lists **every model of every provider**, grouped by name, and picking one switches base URL, key and protocol automatically. Two fields in that form are worth knowing:

- **Reasoning** — `effort` (the provider's `reasoning_effort`) or `bool` (an `enable_thinking` flag, for Qwen3/Gemma-style templates). Left unset, Harny sends nothing and the provider's own default applies.
- **Session header** — only when the host needs one (e.g. opencode's `x-opencode-session`).

The data folder follows the VS Code convention (or set `HARNY_HOME` to move it):

- **macOS** `~/Library/Application Support/Code/User/globalStorage/spltek.harny`
- **Windows** `%APPDATA%\Code\User\globalStorage\spltek.harny`
- **Linux** `~/.config/Code/User/globalStorage/spltek.harny`

Everything the panel saves lands here, and it is **re-read live** — no reload, and no need to open the file.

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

The **mode pill says which one you are in from across the room**: quiet gray in Analyze, **orange (accent fill, white label, soft glow) in Build** — the same treatment as Parallel-on. The contrast is the signal, so a run that will write is never a guess.

The Shell tool is **allowlist-first** in Analyze: a command runs only if every segment is a known read-only command (`ls`, `cat`, `grep`, `git status`, `git log`, …). Scripts, interpreters (`python -c`, `node -e`) and anything state-changing are refused. It is a **best-effort filter, not a sandbox** — treat Analyze as a strong guardrail, not a jail.

The promise is one sentence — **in Analyze no resource is modified** — and it covers tools that are not ours. A **file** write can be previewed (we own the tool: validate, show the diff, write nothing). An **external** call cannot: an MCP tool either runs or does not. So each tool **declares** how it keeps the promise, and the default is **refuse** — a tool nobody described (a new MCP server, a plugin, a tool added tomorrow) is never assumed harmless, which is what a name list of "tools that write" silently did.

| in Analyze | runs? |
|---|---|
| the four file tools | yes, as a **validated diff** (nothing written) |
| Shell | only allowlisted read-only commands |
| an MCP tool whose server **declares** `readOnlyHint: true` | yes — if you marked that server **trusted** |
| an MCP tool of a server you marked **read-only** | yes (your statement, even if the server declares nothing) |
| an MCP tool that declares nothing, or `destructiveHint`, or an unrelated tool | **refused**, naming the server and the two ways out |

The protocol is explicit that a server's own hints are **untrusted unless the server is trusted**, so Harny never lets one open the gate by itself: you declare it per server (`trusted`, or `read-only` for old servers that send nothing). Its defaults are conservative on their own — `readOnlyHint: false`, `destructiveHint: true` — so **silence means "assume it modifies"**.

**Switching while it works.** The mode is not a request parameter (the model, the samplers and the window are) but a **behaviour policy, and a promise**: *Analyze* means nothing is written. A promise that can change under a run cannot be trusted, so Mode and Parallel are **decided once per run** — the run is born with them and keeps them to its last tool result, and the two pills are **locked while it works**, exactly like the request parameters. That includes what the run handed to a sub-agent: one delegated with `access: write` finishes under the run's own mode, which is the Build it was delegated under. The lock is never SILENT, though: each pill's tooltip names the policy the run is using and says that **Stop** — which aborts the sub-agents with it — is how to stop now. That is the difference between a lock and a lie: the panel used to keep the buttons quiet and let the click die, which is how it showed one thing while doing another. By the same rule, the model is told: whatever the conversation shows as **PROPOSED**, it re-issues with the file tools once you are in Build.

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
- **Ctrl/Cmd+Enter** → **steers**: injected at the next turn boundary, without restarting the run. The modifier is the **host OS's own** — **⌘** on macOS (Ctrl is accepted too, since the hint says "Ctrl/Cmd"), **Ctrl** on Windows/Linux, where a bare **Win/Super** key is left to the OS.
- An **"Insert in Queue / Steer"** hint (left end of the strip above the prompt, opposite **Collapse all**) shows what Enter will do: the word sits in a pill that turns red — *Steer* — only while you hold the modifier during a run. It is an indicator, never a button: dimmed when nothing is running, and it **never moves the view or takes the focus** — holding ⌘ to copy must not scroll you away from what you are reading.
- **Find in the chat** — **⌘F** on macOS, **Ctrl+F** on Windows/Linux, and while the Harny panel has the focus the chord is **ours**: the extension contributes that keybinding (scoped to `focusedView == harny.chatView`) and runs a command that opens this bar, because inside a webview the key otherwise also reaches VS Code's own find, which opens its widget and takes the focus out of the panel. A webview has no native find, so the shortcut used to do nothing: a bar floats over the transcript's top-right, case-insensitive across every bubble, **Enter**/**Shift+Enter** (or ↑ ↓) step through the matches with wrap, the counter reads `3/17` or *no match*, and **Esc** closes it — Esc closes FIND, never the run. The highlight is painted with the **CSS Custom Highlight API**, *not* a document selection: setting one blurs the field you are typing in (the first cut let you type exactly one character), and nothing is ever injected into a transcript that streaming repaints. Matches are capped at 500, and **every change recomputes the whole set** — a backspace, a ✕ in the field, a query that matches nothing: the previous paint is cleared instead of staying on screen over text that no longer matches. The scan also follows the transcript while the bar is open (a run streams, a section folds), so highlights never point at replaced nodes — and recomputing never scrolls you away from where you are reading.
- **Right-click on the transcript: our own menu** — **Copy** (only when something is selected, like any editor) and **Select all**. It does not depend on the host webview injecting a native one, which Windows, Linux and each VS Code build disagree about. A right-click on a *control* keeps the host's behaviour.
- **Copying during a run works like anywhere else**: ⌘C / Ctrl+C and the right-click **Copy** menu — including from a bubble that is *still streaming*: the live repaint pauses while a selection touches it and catches up when you let go, instead of rebuilding the text under the cursor. A text selection is a copy gesture, so while one exists the modifier does not light the Steer pill, and the native menu is never swallowed on a selection (on macOS it is suppressed only over the chrome, where Ctrl+click *is* a click).
- Pending messages appear as **cancellable bubbles** above the prompt, inside a **collapsible section** whose header carries the counts (`Steer 1 · Queued 2`) — so a folded block still tells you what is waiting. A **new** message re-opens it.
- Each bubble is **one line**, and born folded — it wraps only when you open it. The fold
  appears **only when there is more to see**: it is measured on the rendered bubble (not
  guessed from its length, so narrowing the panel brings the arrow out on its own), it sits
  **with the two commands** rather than in front of the text, and the whole message is in the
  tooltip meanwhile. The **Collapse all** pill closes the pending bubbles too.
- **Attachments show inside the bubble**: the paperclip leads the line and opening the row
  reveals the same previews a user message shows (thumbnail with lightbox, file cards).
- The SECTION scrolls (bounded) when the queue gets long, so the footer never pushes the
  transcript up.
- Each pending message can be **converted**: **→ Steer** (deliver it first, injected into the running loop at its next step) or **→ Queued** (wait for the run, in FIFO order with the others). The two are not two views of the same message — they differ in *when* the text reaches the model — so converting a steer back **also withdraws the draft from the agent**.
- All pending steers are submitted together as **one** message at the next turn boundary. **Stop** clears them.

### How every step is tracked

- **Reasoning** is streamed live as it happens, and passed back on later turns so tool-call chains keep their chain of thought.
- **Tool calls** get a three-section bubble — **Input / Output / Diff**. When a tool touches a file, the Diff section shows the unified diff with the target path and `+N/−M` counts, syntax-highlighted for the main languages.
- **Every turn** ends with a **metrics badge** carrying the mode it ran in (`Build` / `Analyze`) and the *real* provider usage: `Build · openai/gpt-4o · 6.9k in · 74 out · ⚡ 800 · elapsed 2.3s · first token 676ms`. The mode chip keeps the badge's own quiet gray, with **one exception: the word `Build` is in the accent** — the one thing you scan a long transcript for (*which turns actually wrote*) without turning half the lines orange. Turns recorded before the mode was stored show no chip.
- **Diagnostics** go to **Output > Harny**, one line per turn.

### Long sessions

The context window is a hard ceiling. Harny manages it continuously, so a long session keeps working instead of dying at the limit.

**Compaction keeps whole turns — and keeps the transcript.** When the fill crosses the threshold, the OLDEST turns leave the context window and a compact summary takes their place *in it*: the transcript keeps them, readable and searchable, so a long session never becomes amnesia. The window now **begins at that summary**, and the marker is *stored* rather than recomputed — appending a message only ever grows the tail, which is what keeps the provider's prompt cache warm. The cut falls **between complete turns** (your input → the final answer, everything in between) — and falls *inside* one only when that turn alone is bigger than the verbatim budget, because refusing to compact is worse than a cut that is off a boundary. The most recent part — a **share of the usable window** (default 10%, an eighth of the trigger; `Land at` in the Compaction card, where `0` keeps only the last complete turn) — stays **verbatim**, and the summary is written as **schematic lists**: decisions, open threads, the exact next steps and the facts nothing else carries (paths, commands, values, constraints). It sees the **tool calls**, not just the answers — each one named with its target and size (`Write src/foo.ts (240 lines)`) but never its payload, because a `Write` carries the whole file — so `Done` can say *which* file was written instead of that a file was. Its size is a **compression of what it replaces** (about a tenth), capped by the max output the session declares — and that cap is never the budget itself, because a model that reasons spends it before it writes a character — and the result appears in the transcript as an orange user bubble, so you can always see where the window starts.

**The state is carried forward, not re-derived.** Every later compaction **updates** the previous summary — keeping what is still true, adding what changed, dropping what is done — instead of summarizing a summary. That repetition is where a long session quietly loses a fact per generation, in exactly the sessions that cannot afford it.

**Old tool outputs stop consuming the window.** In an agent loop the tool results *are* the context: Harny sends the oldest ones as **one-line stubs that name the tool** (`[Shell output masked to save context…]`) and keeps the newest verbatim — masking what the model is working on right now would break the very next step. It is a **view, not a rewrite**: the transcript, the stored history and any branch keep everything, and the model can re-run the command whenever it needs the data again.

**A rejected request is recovered, never fatal.** If a provider rejects a request as too big, Harny **compacts and re-sends the same turn** — and when the span is larger than the model that would have to read it, it **summarizes the most recent part that fits and DEFERS the rest** — those messages stay in the transcript, above the new checkpoint, outside the window — so a state document is still written. Only a window that can read nothing at all moves **without a summary**, which calls no model and therefore cannot fail. The rejection is also the most reliable statement of a model's real window — a local model that declares none falls back to 128k, which is optimistic — so Harny reads the number out of the provider's own message and **adopts it for the session**, and the threshold stops guessing. Two layers already keep most of this from happening: the request is clamped so that **`input + max_tokens ≤ window`**, and a single tool result is capped to a share of the window (a fixed 50KB would be an entire 8k context, in one command).

**Nothing un-replayable is ever sent.** Every request is checked against the wire rules first: a tool call must be followed by its results, a result must answer the turn above it, no result may be blank, no assistant turn may be empty, and the conversation must open with your input. If a session ever reached such a state, Harny **refuses to send it and names the rule** — instead of letting the provider reject that request *and every one after it*, with a message that says nothing about where the damage is.

**Sub-agents inherit all of it.** A sub-agent runs on the same model as its session, so it sizes its own masking and tool-output caps on the same window — a sub-agent is the one doing the heavy reads — and an overflow **inside** a sub-agent is recovered with the **same** compaction, applied to its own history: one strategy, two consumers, so the two cannot drift apart.

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

The **Loop Guard** card exposes a sensitivity preset (`Off` / `Low` / `Medium` / `High`, in that order — quietest to loudest, `Medium` by default) and **12 tunable parameters**, all persisted per session. **Off** makes the guard completely inert: no detection, no nudges, no stop, *and* no tool-call deduplication (identical calls are re-run) — the parameters stay visible but disabled. Optionally it also guards the **final answer** itself for repetition.

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
- **Two chat modes**: **Analyze** (read-only preview — changes are prepared and diffed but never written; when previews are ready the host asks **once** via a modal whether to switch to Build, with a tip to restart the chat for a clean apply) and **Build** (full tool use, writes for real). The transcript keeps a static, non-clickable note. The mode is persisted **per session** (restored on reopen; new sessions start in Analyze). Both modes and Parallel are **locked while a run is going** (a run is born with its mode and its Parallel setting and keeps them to its last tool result): the pills explain why instead of swallowing the click, and **Stop** is the way to interrupt this one
- **Output-token-limit handling**: the provider's `finish_reason` is propagated; a truncated response is surfaced explicitly ("raise `harny.maxTokens`") instead of failing silently

**Context & long sessions**
- **Compaction** moves the old part of a conversation OUT of the context window and puts a schematic summary at its head — the transcript keeps everything it moved past, readable and searchable: the cut is snapped to **turn boundaries** — unless one turn alone exceeds the budget, where the budget wins — the recent side is kept by a **landing point** — a share of the usable window (default 10%, an eighth of the trigger; per session, `0` = only the last complete turn) — and the two knobs of that policy are **independent**: the landing point cannot be dragged into a value that frees nothing without the modal saying so first (`62% → saved as 36%`, with a line under them that names the limit), and the one rule between them — landing below the trigger, above what the summary and the last complete turn already occupy — is applied when you save — and the summary is a **compression of the span** (about a tenth), capped by the session's declared max output (with a single compression pass if the model overshoots). Runs before a request, at every turn boundary, and after a response
- **The window is VISIBLE in the transcript**: a divider marks where the context begins, carrying the count (`N messages above · kept in the session, out of the context window`), and the checkpoint reads as **one card** — the label with its summary body attached — instead of two unrelated bubbles. The checkpoint's label is **violet** (its own palette token, `--summary-msg`), not the terracotta of a typed prompt: it is neither a message the user wrote nor an answer the model just gave, and the colour says so at a glance. Only the LABEL is tinted — the summary body stays neutral, because that is the text to read — and the ✂ cut tab that slides up over it takes the same violet. The boundary comes from `checkpointStart`, the SAME function the request uses, imported into the webview: the marker and the request cannot disagree about where the window starts
- **What the summarizer actually sees** (`tools/tool-call-text.ts`): the span is serialized with every tool call NAMED — tool, target, size (`Write src/foo.ts (240 lines)`, `Shell npm test`, `Edit src/a.ts (+4/-2)`) — because a bare `[Tool result]` says nothing about which tool produced it or on what, and the state document could not name a file that had been changed. Payloads are never included: a `Write` carries the entire file, so echoing arguments would inflate the span past what the model could read. The transcript's tool bubbles use the SAME describer, so the two can never drift
- **Window trim — the fail-safe** (`sessions/compactor.ts: trimHistory`): the summarizer runs on the *session's* model, so a span larger than that model's window could never be read — and a session whose window just shrank under it could neither compact nor send. Then the window is moved **without a summary**: no model call, so it cannot fail; the state document is carried **verbatim**, so continuity survives; and everything it moves past stays in the transcript. One rescue is enough — the span then fits, and normal summaries resume
- **Carried state**: a later compaction **updates** the document the previous one left (the `synthetic` pair) instead of re-summarizing it, and that document is excluded from the span — so a summary of a summary cannot cost a fact per generation
- **Observation masking**: tool results older than a share of the window are sent as one-line stubs that name the tool (the newest stays verbatim); the stored history, the transcript and any branch are never touched
- **Overflow recovery**: a context-length rejection — 14 provider wordings, plus a provider-independent "our own estimate said we were full" leg — triggers **one compaction and a retry of the same turn**, and the limit the provider itself states is **adopted** as the session window (persisted); that leg counts what the request actually **carries** — text, tool arguments, tool **schemas** (every request pays them), **images** (a flat ceiling each, never the data URI's length, which is off by ~2,500×) and the reasoning passed back — because under-counting makes it fire *less* and it is the one path where a session dies
- **Request clamp**: `input + max_tokens ≤ window`, with a safety margin that **scales** (`min(8192, 5% of the window)` — a fixed 8k is 100% of an 8k window) and a token estimate that counts non-ASCII at 1 token per unit, so CJK is not underestimated 4×
- **Tool-output cap** scaled to the model (`tools/output-budget.ts`): Shell's 50KB and Grep's 30KB are ceilings, not constants — 50KB is an entire 8k context in one command
- **The tally on every line** (`sessions/compaction-tally.ts`): a repair event logs its own detail AND a running count — `… | tally: compaction 3 (2 session/1 sub) · trim 1 (1/0) · widest span 14.2k of 40.0k ceiling · 1 within 10% of the ceiling · trim is the FALLBACK`. A log answers what happened *here*; only a ratio answers whether the trim is a rare rescue or the normal path — and that is a statement about the tuning, not about one event. The line to log is RETURNED by the tally, so an event cannot be logged without being counted. It counts the MECHANISM, never the quality of a summary
- **Wire rules** (`history/conversation-validity.ts`): 8 rules checked at the last point before the wire (results answering their call, no orphans, ids present and unique, no blank results, no empty assistant turn, a user-first conversation, attachments only on user messages). A violation is **named, never silently repaired** — the request is refused instead of being rejected by the provider *and every request after it*. Five of the eight are also prevented at the source (atomic turn groups, id synthesis, non-blank results, the stall nudge)
- **Cross-provider error reading** (`llm/context-overflow.ts`): the rejection wordings and the stated limit, so a backend that phrases the limit differently still recovers

**Parallel / sub-agents**
- The **Parallel** toggle enables the `Delegate` tool: the main agent becomes an **orchestrator** that decomposes a task into independent sub-tasks, each a separate `Agent` with its own ephemeral history (unbounded by default), orchestration depth capped at 1
- Disjoint files run **in parallel**; overlapping writers (or a writer and a reader of the same resource) are **serialized automatically**. A configurable cap limits concurrency. Each sub-agent streams live in its own bubble and has its own **⏹ abort**
- **HARD RULE — decision → action:** the moment the model decides the work is parallelizable, the `Delegate` calls must be in **that same turn**. A turn that reasons "I will parallelize" but contains no `Delegate` call is invalid
- Each `Delegate` carries a meaningful `id`, declared `resources` + `access`, and — when the user attached files — `attachments: [n]` selecting **only** what that sub-task needs
- **`resources` are a coordination declaration, not a sandbox.** They let the host serialize overlapping writers; they do **not** restrict what a sub-agent may read or write, so declare honestly
- With Parallel **OFF** the concept is hidden entirely: `Delegate` is not advertised, the prompt never mentions sub-agents (or even the word "Parallel"), and past `Delegate` turns are filtered out of the conversation
- **Stop vs per-sub-task abort:** the global **Stop** aborts the whole run; the **⏹** on a bubble stops **only that one** — running or still queued behind the cap. Either way a stopped sub-agent is reported as `aborted`, so the orchestrator knows the sub-task did not finish and never treats it as a completed report
- Sub-agents share all tools (except `Delegate`) and the loop guard — **and the same skills catalog**: a sub-agent can activate a skill on its own. The orchestrator can still point it at a specific tool/skill by naming it in the `Delegate`'s `goal`/`context`

**Loop guard**
- Reasoning, empty, failing-tool, error-streak and repeated-tool loops are **broken, not just stopped** — the host interrupts the degenerate behaviour, tells the model how to recover and keeps going; identical read-only calls are cached and identical failing calls are not re-run
- Each type escalates independently, up to `maxNudges` interventions (2 by default), then a final `❌ Loop not resolved […]`
- Every intervention is logged as a light-blue **"Nudge"** bubble and a line in **Output > Harny**

**Sessions**
- **Persistent per-workspace sessions** in a single SQLite database (`<home>/sessions.db`), one agent per session, single right-side view with tabs
- Stored **outside the project folder**, so the agent tools can never read or modify transcripts, and repo cleanups never delete chat history. The panel shows only the current folder's sessions
- **Schema migrations**: the schema is **versioned** (`PRAGMA user_version`) and upgraded **automatically on open** through an ordered, immutable migration list — see **[docs/MIGRATIONS.md](docs/MIGRATIONS.md)**
- **Sessions area** (hideable by clicking the header): each row shows creation/last-modified dates above the name, with ✎ rename, 🗑 delete and **+ New session**. The 🗑 asks **once**, with three answers: **Delete** (the session goes, settings included), **Rewind** (keeps everything up to the session's **first compaction summary** and drops what came after it — the state of the work survives, the tail does not) or **Empty** (the session and its settings stay, the whole transcript goes). Rewind is offered **disabled** on a session that never compacted: there is no summary to rewind to
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
- **Progressive disclosure**: the system prompt lists only `name: description`; the **`Skill` tool** loads the full `SKILL.md` on demand. The model activates a skill itself — the orchestrator **and its sub-agents** get the same catalog — or you force it with `/skill <name> [task]`
- **Skills card** lists the installed skills as clickable text; `/skills` lists them
- **`disable-model-invocation: true`** skills are hidden from the model and can only be activated manually
- **Slash menu**: typing `/` at the START of the prompt opens a picker — arrows/Enter select, Esc closes

**MCP servers**

- Speaks the **Model Context Protocol**: add servers from the panel's **MCP** card — the gear has **add / edit / delete** and a **Test** button, and a server is **either** a command (stdio) **or** a URL (HTTP), with optional args, env and headers. That is the whole setup. **Try it without installing anything**: the repo ships a zero-dependency server at `examples/mcp-hello/server.js` (Command `node`, Args that path — no npm, no npx) whose `search` tool carries a deliberately rich schema (enum, array, nested object, numeric bounds), and a free remote one needs only `{ "url": "https://learn.microsoft.com/api/mcp" }` (Microsoft Learn: official docs, 3 tools, no key) or DeepWiki (`https://mcp.deepwiki.com/mcp`).
- **Transports**: **stdio** (spawned process) and **Streamable HTTP** (POST; JSON or `text/event-stream`; **stateless** by default, **stateful** via `Mcp-Session-Id`)
- Tools are exposed as `mcp__<server>__<tool>` (input schema = the server's)
- **UI**: each row has a **switch** (a pill whose knob slides right when the server is on) — before this the affordance was invisible, with the name as the only toggle; the name still works as a shortcut. Clicking a server's name toggles it on/off, and **`(N tools)`** opens the **tools panel**: every tool the server advertises, with a **checkbox** that decides whether the **model** sees it (checked = exposed, and that is the default). The panel is a draft — **All** / **None** / **Cancel** / **Save** — because saving **reconnects** the server, and a reconnect per click would respawn a process each time. A session that is working locks Save (swapping the tool list under a live turn would break it) and dims the switches. The card shows `(5/8 tools)` as soon as something is hidden. The excluded names are stored per server in `config.json` as **`excludeTools`** — an **exclude** list on purpose, so a server that adds a tool tomorrow exposes it without anyone editing the file:
  ```jsonc
  "mcpServers": { "sqlite": { "command": "npx", "args": ["-y", "mcp-sqlite"],
                               "excludeTools": ["drop_table", "delete_row"] } }
  ```
- **What each server is allowed to do in Analyze** is a per-server declaration, `analyze`: `"read-only"` (every tool of it — for servers that send no hints) or `"trusted"` (believe its own `readOnlyHint: true`); omitted means **none** of its tools runs in Analyze. It is read **live**, so a change lands on the next turn. **Both** have a control in the panel: `excludeTools` is the checkbox on the left of each tool (what the **model** sees), `analyzeTools` is the **shield** on its right (what may run in **Analyze**) — an INCLUDE list, because Analyze is denied by default, and the narrowest statement available: one named tool, so a single safe tool of an otherwise refused server can run there. Where the server's own declaration already allows everything, the shield is marked as inherited and says so instead of pretending a per-tool rule did it — and a save from the panel stays **lossless** (it writes only its own fields, so the keys it does not manage survive).
- **Errors name the cause, and (when we recognise it) the cure**: the panel shows the FIRST lines of the server's stderr — not a slice of its tail — plus a one-line remedy for the failures we can name, e.g. a half-written npx cache (`ENOTEMPTY … ~/.npm/_npx`) says to run `rm -rf ~/.npm/_npx` and Test again. Full logs of every attempt at the critical points (`[mcp]` / `[mcp-http]`) in **Output > Harny**
- **Stop reaches an MCP call, and an MCP result is capped like any other**: the run's abort signal travels all the way down (`ToolContext.signal` → `callTool(…)`), so a `tools/call` is dropped the moment you press Stop — the server is told with the protocol's own `notifications/cancelled`, the late reply is ignored, and the process stays alive for the next turn (before, the call sat until its timeout and the answer arrived after the run was over). The result itself is capped at the **execution boundary** (`tools/output-budget.ts`, the same rule Shell and Grep follow): 10% of the session's usable window, bounded above by 50KB and below by 2KB, with a note that says how to get the rest — only *old* results get masked, so the newest one is exactly the one a fixed ceiling would have let eat the window

**UI**
- **Esc to stop**: press Esc while a run is working to stop it — modals/overlays and native controls keep Esc for themselves
- **Focus always on the prompt**: the caret returns to the input after opening/switching a session, finishing a run, a cut, and after mode/parallel/model/attach interactions
- **Attachments**: **+** button, **paste from clipboard**, or **drag & drop** (hold **Shift** for OS file drops). Images are attached inline as data URIs and sent as multimodal content, text files as inline code blocks, and a pasted/dropped absolute path or `file://` URI attaches that file. In the transcript images render **large** (a third of the chat width, **resizable**, stacked, click for a **full-size lightbox**) and are **persisted with the message**; other files become a **card with a large per-type icon** (PDF / code / Markdown / JSON / sheet / archive, tinted by category) plus name and size. Under the prompt, pending attachments show the same icon small. Binary files copied in Finder/Explorer usually reach the webview only as their **name**, so use the **+** button; an attached binary is detected **from its content** (magic bytes — PDF, ZIP, OLE2, …) and reported to the model as such, never inlined as garbage
- **Plain tool outputs + three-section tool bubbles**: tool outputs are never colorized by line-prefix heuristics (an `ls -la` listing stays plain text); when Edit/Write/StrReplace/Delete touch a file, the bubble gets a third **Diff** section (Input / Output / Diff, collapsed with the bubble) showing the unified diff — a new file as all `+`, a deleted file as all `−` — with the **target file path in azure** after the tool name and `+N/−M` counts in the Diff header
- **Syntax highlighting in Diff sections**: editor-style colors (Prism, one-dark) for TypeScript, JavaScript, Python, Rust, C#, HTML, CSS, JSON, Markdown, Bash, SQL and Go — unknown extensions fall back to plain diff coloring
- **Per-turn metrics badge**: under every assistant turn, `6.9k in · 74 out · ⚡ 800 · elapsed 2.3s · first token 676ms` (hover for detail). Appears as soon as the turn ends (a `turn_meta` event, no transcript re-render), shown for tool-only turns too, captured from the provider stream and persisted with the message
- **Real context accounting**: the context-fill metric prefers the provider-reported input tokens; after a ✂ cut it is recomputed from the **kept** messages and persisted (cutting everything → 0, so it no longer "jumps back" on reload), and after a compaction the kept window's real cumulative-input delta is used. Auto-compaction follows the same numbers
- **Responsive control stack**: cards lay out **1 / 2 / 4 per row** as the panel widens, all share one row height so columns line up, and the stack **scrolls vertically** once it would take more than 75% of the panel height. The panel itself has a **500px horizontal floor** (`max(500px, 32rem)`): below it the window gets a horizontal scrollbar instead of squeezing the controls into nonsense, and the `rem` side takes over past a ~15.6px editor font so the floor grows with the type
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
│   │   │                         #   conversation-validity (the wire rules), observation-masking
│   │   ├── llm/                  # LLMProvider <- OpenAIChatProvider
│   │   │                         #   HttpClient, SSE parser, factory, model-list fetcher,
│   │   │                         #   context-overflow (rejection wordings + the stated limit)
│   │   ├── agent/                # Agent orchestrator (DI), LoopGuard, ToolCallAccumulator,
│   │   │                         #   ThinkingTagParser, SystemPrompt, orchestration + sub-agents
│   │   ├── sessions/             # SessionStore <- SqliteSessionStore (node:sqlite + FTS5), SessionManager, Compactor
│   │   │                         #   (keep budget, summary budget, carried state) + one runtime per open session
│   │   ├── skills/               # Agent Skills (skills.sh): SKILL.md discovery + registry
│   │   ├── mcp/                  # Model Context Protocol: stdio + HTTP clients, manager, tools
│   │   ├── storage/              # Cross-platform path resolution (context.globalStorageUri)
│   │   └── tools/                # Tool interface + ToolRegistry + 14 tools (one file each)
│   │                             #   mode-policy (Analyze preview / Build), FileSystem /
│   │                             #   CommandRunner / HttpClient abstractions, output-budget
│   │                             #   (how much a tool result may carry)
│   ├── chat/
│   │   ├── chat-view.ts          # Host WebviewViewProvider (single right-side view)
│   │   ├── session-registry.ts   # Per-session agents (one agent = one session)
│   │   ├── stream-tee.ts         # Per-session event router + live buffers
│   │   ├── attachment-service.ts # Attach files/images as context
│   │   ├── view-html.ts          # Pure HTML generator (sessions + tabs + chat)
│   │   └── webview/              # Webview client (TS): view.ts + markdown.ts,
│   │       #                       diff-fence.ts, lang-map.ts, pending-section.ts
│   │       #                       (the queue/steer footer);
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

**1600+ unit tests** cover: config (file multi-provider, JSONC, precedence home/workspace), event bus, history, sessions (SQLite store with FTS5 search, **versioned schema migrations** via `PRAGMA user_version`, manager, registry, the cross-folder manager with its open/change-folder actions, the per-session control settings incl. the Loop Guard parameters), **context management** (the absolute keep budget, the schematic-summary prompt and its budget, the carried state, observation masking, the overflow recovery with each provider's real rejection text, the adopted window, the scaled request margin, the window-scaled tool-output cap, the token estimate for non-ASCII), **the wire rules** (every rule at the checker level **and** by fault injection through a real request — a malformed conversation never reaches the provider and is named), the OpenAI-compatible LLM provider (streaming, tool calls, `finish_reason`, the learned `max_completion_tokens`), host-model fetching, all 14 tools (including the Analyze dry-run preview), the mode policy, the agent loop (fake LLM, abort, max turns), the **loop guard** (reasoning/empty/tool-failure/error-streak/tool-repeat detection, tool-call dedup, sensitivity presets, the editable parameter ranges + their clamping), orchestration/sub-agents, **Agent Skills** (SKILL.md parsing + discovery), **MCP** (stdio + Streamable HTTP clients, tool wrapper, manager), markdown/DOM (markdown-it + DOMPurify), the HTML generators, the pending section (its counts, the born-folded bubbles, the fold measured on the rendered row, the attachment previews, the conversions), and the chat view provider (mocked VS Code, incl. the control-stack wiring: sliders, Auto defaults, the collapsible Loop Guard parameters and the responsive layout), the per-turn metrics badge (real usage + timings), the real context accounting (after a ✂ cut / compaction) and the DB compaction + index optimization (VACUUM, `PRAGMA optimize`, FTS5 `optimize`).

### Configuration reference

#### Sources and precedence

Harny reads configuration from **three sources**, in this order:

> **Use the panel.** Everything here has a form in the panel unless stated otherwise, and a save from it is **lossless** — the keys it does not manage survive, so the file and the UI cannot fight. Open the file only to script a machine, to read where a value ended up, or to set the one field without a control (the server-WIDE `analyze` on an MCP server — the per-tool version is the shield in the tools panel); `config.example.jsonc` in the repo is then a starting point. Two kinds live there, and the difference is worth knowing: the **Providers & Models** editor and the **DB** gear (in the sessions manager) write the **GLOBAL** config — the same `config.json` / `harny.*` settings described below, so the setup you do once stays done — while the **AI Model row**, the sliders, **Guardrails** and the **Compaction** gear are **per session** (each session keeps its own). The three sources below are the global ones, read at startup, and the only way to set what has no control at all (`harny.autoOpen`, for instance).

1. **`config.json`** in the extension data folder (`context.globalStorageUri`, or `HARNY_HOME`) — dedicated, **not** in the working folder
2. **VS Code settings** (`harny.*`) — User or Workspace settings
3. **Environment variable** `OPENAI_API_KEY` (key only)

#### VS Code settings (`harny.*`)

> **Only `harny.theme` is listed in the Settings UI.** The other keys below still work exactly as
> before — they are ordinary settings, read from User or Workspace `settings.json` — but the extension
> no longer *contributes* them, so `@ext:spltek.harny` in the Settings page shows the one knob you
> actually reach for and nothing else. Set them from the panel (the **Providers & Models** gear and
> the **DB** gear in the sessions manager write them for you), or add them to `settings.json` by hand;
> the table stays here because those keys are still the contract.

| Setting | Default | Description |
|---------|---------|-------------|
| `harny.theme` | `auto` | Palette: `auto` follows the editor's light/dark kind, `dark` / `light` pin one — the only setting listed in the Settings UI |
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

#### Reasoning, per host

The **Reasoning** select in the provider form (the `thinking` field) says how the reasoning phase is expressed in the request. It is what the per-session **Thinking** radio group needs: those radios stay disabled unless the provider declares one, and `Off` means "send nothing", which is the right answer only for hosts that keep it off by default.

| Reasoning in the form | what is sent | for which host |
|---|---|---|
| `bool` | `chat_template_kwargs.enable_thinking` + `reasoning_effort` | llama.cpp / MLX with a Jinja template (Qwen3, Gemma) |
| `effort` | top-level `reasoning_effort: low/medium/high`; `Off` omits it | OpenAI-style hosts — and the only option for reasoning-**mandatory** models (the gpt-5 family rejects `Off` with a 400) |
| `reasoning` | `reasoning: { effort }`, or `{ enabled: false }` for `Off` | OpenRouter-native, and the *reliable* way to disable models whose default is thinking-on (e.g. `deepseek/deepseek-v4-flash`) |
| `type` | `thinking: { type: "enabled" \| "disabled" }` | DeepSeek/Anthropic-style toggle: on/off, no tiers — the switch that actually works on opencode-go for DeepSeek/Qwen/Kimi |
| *unset* | nothing | Harny sends nothing, the radio group stays disabled, the host default applies |

- The level always travels as the standard `reasoning_effort`; `enable_thinking` is only llama.cpp's on/off toggle. The legacy boolean `enableThinking` is still honored and maps to `bool` with a `medium`/`off` level.
- Reasoning is **passed back** on later turns so tool-call chains keep their chain of thought: `reasoning_content` (llama.cpp / DeepSeek / opencode-go) and the full `reasoning_details` blocks for OpenRouter, captured from the stream and replayed verbatim.
- A provider entry also carries a **default level** (overridable per session) and an optional **`maxTokens`**, which acts as that provider's cap until the session's **Output tokens** control is set — that one then wins.

#### Model lists: let the host answer first

For any host that exposes `GET /v1/models` — OpenAI, OpenRouter, opencode-go, llama.cpp, Ollama, … — there is nothing else to fill: **name + base URL + key** is the whole entry, and the dropdown fills itself. (The top-level `provider` key just picks which one starts selected; every provider stays available.)

- When opening the chat (or on every refresh) Harny fetches the list from `GET {baseUrl}/v1/models` and shows it in the dropdown, grouped by provider.
- The choice is **saved in the config** (top-level `model`, and `provider` if you switch provider), preserving comments and formatting.
- On reopen Harny verifies the saved model still exists: if it was removed it reports it (invalid highlighted option + warning) and invites you to pick a new one.
- If the server is unreachable (e.g. llama.cpp is off) a "host models unavailable" warning appears instead of an empty dropdown.
- When the host reports each model's **context window** (OpenRouter `context_length`, vLLM `max_model_len`, llama.cpp `meta.n_ctx_train`, …) it is shown next to the model (`model · 128k`) and **adopted as the session's context window** on selection. If the host does **not** report it (e.g. **OpenCode Go**, whose `/models` has only `id/object/created/owned_by`), Harny falls back to the **models.dev** catalog (`<provider>.models.<id>.limit.context`, fetched lazily and cached for hours).
- An explicit **`models` list** per provider covers hosts whose list is missing or unhelpful. It is the one provider setting the form does not manage, so it goes in the file — and that is safe: a save from the panel **preserves it**.

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
