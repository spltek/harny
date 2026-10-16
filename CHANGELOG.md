# Changelog

All notable changes to **Harny** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Overflow recovery**: a request the provider rejects for being too big is no
  longer a dead end — Harny compacts and re-sends the **same** turn, bounded to two
  attempts. Detection has two independent legs, so it works on every backend: the
  provider's own wording (14 families, each pinned by a real pasted rejection) **and**
  our estimate of the request just sent (an unreadable 4xx at 90%+ of the usable
  budget is treated as size). It never fires on a network failure or on an unrelated
  400 with room to spare, and it does not retry when there was nothing to compact.
- **The model's real context window is learned from that rejection**: a model that
  declares none falls back to 128k — optimistic, so on a small local model the
  compaction threshold never fires until the provider refuses. The rejection states
  the real number, Harny reads it out of the text and adopts it for the session
  (persisted), and the threshold stops guessing.
- **Observation masking**: tool results older than a share of the window are sent as
  one-line stubs naming the tool, while the newest stays verbatim — masking what the
  model is working on would break the very next step. A **view, not a rewrite**: the
  transcript, the stored history and any branch keep everything, and the model can
  re-run the command when it needs the data again.
- **Queue/steer bubbles can be converted** (`→ Steer` / `→ Queued`, next to the
  cancel). The two modes are not two views of the same message — they differ in
  *when* the text reaches the model — so converting a steer back also **withdraws the
  draft from the agent**, instead of letting it be injected into the running loop
  anyway.
- **Transcript action pills**: **Collapse all** (closes every expanded section at
  once) and **Autoscroll**, right-aligned in the always-visible control strip and
  outside the scrolling element, so they never scroll away.
- **A paperclip marks a pending message that carries files**, whose names used to be
  swallowed whenever the message also had text.
- **Sub-agents now inherit the session's context discipline**: they size their own
  observation masking and tool-output caps on the session's window (a sub-agent is the
  one doing the heavy reads, and its Shell/Grep caps used to stay FIXED at 50KB/30KB —
  an entire 8k context), an overflow inside a sub-agent is recovered with the same
  compaction a session uses (applied to its own ephemeral history), and the **Loop Guard
  settings of the session reach the sub-agents** instead of a default preset.

### Changed

- **Compaction keeps whole turns, with an absolute recent budget.** The cut is
  snapped to turn boundaries (your input → the final answer, everything in between),
  the recent side is kept by an **absolute** budget (5% of the usable window, clamped
  to 8k–20k tokens) instead of a fraction — on a 1M window a fraction kept ~600k and
  freed almost nothing — and the summary is written as **schematic lists** (decisions,
  open threads, next steps, and the facts nothing else carries) with a budget derived
  from the room the compaction actually freed.
- **The state of the work is carried forward instead of re-derived**: each later
  compaction **updates** the previous summary — keeping what is still true, adding
  what changed, dropping what is done — and excludes it from the span, so a summary
  of a summary cannot cost a fact per generation.
- **The queue/steer block is a collapsible section** whose header carries the counts
  (`Steer 1 · Queued 2`), so a folded block still says what is waiting. A pending
  message is readable **in full** (it wraps, keeping your own line breaks; the section
  scrolls) and gets a **fold arrow only where the text really wraps past one line** —
  measured on the rendered bubble and re-measured on resize, so narrowing the panel
  brings the arrow out on its own instead of a character count deciding for it.
- **A single tool result is capped to a share of the window** instead of a constant:
  Shell's 50KB is ~12k tokens, i.e. the **entire** window of an 8k model in one
  command, and masking cannot rescue it (it is the newest result). The truncation note
  now says what to do about it (`head`/`tail`, or narrow the command).
- **The request safety margin scales** (`min(8192, 5% of the window)`): a fixed 8k is
  8% of a 100k model but **100% of an 8k one**, leaving it no room for its own answer.
  The token estimate also counts non-ASCII at one token per unit, so CJK transcripts
  are no longer underestimated 4×.
- **The sub-agent header yields on the goal, not on the wrong element**: the goal is
  no longer cut at 60 characters in JS (it clipped a wide panel for nothing and still
  overflowed a narrow one) and it is the only element that shrinks — all the way to
  nothing if needed — while the status chip follows it left.
- **The brand mark is a splash mark**: 6rem (≈78px) instead of 2.4rem (≈31px, because
  the rem base is the editor font), and it lives as a design token in
  `view-config.ts` so the number has one home.
- **Picking a session collapses the sessions list** and its search field: the gesture
  is over and the transcript gets the space back. An **empty** session re-expands it,
  since its hero points at the list itself.

### Fixed

- **A response could appear to start mid-word when the model reasoned in the middle of
  its answer.** The turn carried the text in two halves around a reasoning phase; the
  view closed the answer bubble at the reasoning and opened a new one for the
  continuation, so the second half read as if the beginning had been lost. The answer is
  now **one bubble** — with the reasoning as a collapsible line just above it — and the
  text continues in place. (Nothing was ever lost: the full text was in the session and
  in the transcript.)
- **A `refresh` landing mid-run could wipe the answer being written.** The view rebuilds
  the transcript from committed messages, and the in-flight turn is not committed yet, so
  a compaction (or a ✂ cut) during a stream dropped the live text and the following deltas
  started a new bubble mid-word. The live text now travels with the refresh — one path
  (`refreshTranscript`) carries it, the view restores it — and the playback is pinned to
  the bottom again.
- **A Stop during a tool call could leave a conversation no provider accepts.** The
  assistant turn carrying `tool_calls` was written before its results, and the
  interruption notice landed between the two: every later request re-sent that history
  and was rejected with an opaque 400. The turn group is now written in **one step**,
  and the **wire rules are complete**: 8 rules checked at the last point before the
  request, with five of them prevented at the source (atomic turn groups, id synthesis,
  non-blank results, the stall nudge). A violation is **named, never silently
  repaired** — the request is refused instead of being rejected by the provider *and
  every request after it*.
- **Reasoning models that reject `max_tokens` by name now work.** No model list keeps
  up with that rule, so the provider follows the server's own instruction: rename the
  field to `max_completion_tokens` and retry once — and remember it **per model and
  endpoint**, so no later turn wastes a round trip on it.
- **The context budget is sized to what the provider actually accepts.** The
  compaction threshold and the footer measured the input against the raw window, while
  the provider counts `input + max_tokens`: a 1M-window session died with "you
  requested 1050820 tokens" while the footer read a harmless 66%.
- **A queued message is visible from the moment it starts running.** It vanished for
  the whole of its run: the view does not append a bubble for a pending send (the
  host owns that list) and the host never told it the item had been dispatched.
- **A steered message keeps its attachments in its bubble**: the files reached the
  model, but the event carried no field for them, so the bubble could not show them.
- **Layout**: a **500px floor** keeps the controls from being squeezed (450px is the
  measured minimum, 500 ships with margin on top of it), and the session card no
  longer sits 5px from the tab strip.

## [0.2.1] - 2026-10-14

### Fixed

- **Release workflow never ran**: `release.yml` was rejected by GitHub as a
  "workflow file issue" (zero jobs) because a step condition referenced the
  `secrets` context, which GitHub does not allow in a step `if`. The Marketplace
  guard now runs inside the step, so GitHub Releases and gallery publishing
  actually happen.
- **Version step is idempotent**: releasing a tag created by `npm version` no
  longer fails with `npm error Version not changed`.

### Changed

- **Open VSX publishing uses trusted publishing (OIDC)**: the release workflow
  no longer needs a long-lived `OVSX_PAT` secret.

## [0.2.0] - 2026-10-14

### Added

- **Per-session Analyze/Build mode and Parallel switch**: both are now persisted
  in the session row (new baseline columns `mode` and `parallel`) and restored on
  reopen. Each new session starts in **Analyze** with **Parallel OFF**. Parallel
  is no longer a single global switch. (Baseline schema edited in place — the
  product is unreleased, so no migration: an existing `sessions.db` must be
  deleted.)

### Removed

- **Dead config flags `contextFiles` / `autoApprove`**: parsed but never used
  (placeholders from the first commit — Harny has no auto-context and no
  tool-confirmation flow). Removed from `HarnyConfig`, the VS Code settings, the
  `config.json` schema and the README.
- **`subagentMaxTurns` config knob**: the optional cap on a sub-agent's tool
  turns is gone from `HarnyConfig`, the VS Code settings, the `config.json`
  schema and the README. Sub-agents are UNBOUNDED by default (like the
  orchestrator); the loop guard and Stop are the safeguards. The internal
  per-run `maxTurns` mechanism is kept (tests / future UI).

### Changed

- **"Parallelism means sub-tasks" (Parallel ON)**: the prompt now states it as an
  identity **and a MUST**, with independence as the criterion and a MODE-AWARE
  conflict rule: only two blockers — a **dependency**, and (in **Build** only) a
  **write conflict** (same file/dir with at least one writer). In **Analyze
  nothing is written**, so the same resource is never a conflict and two readers
  always run together. When there is no dependency and no write conflict → you
  **MUST** emit N `Delegate` calls in the SAME turn, and a turn that plans to
  parallelize but contains no `Delegate` call is INVALID. Own tool calls run
  serially. The prompt is written for both strong and small models (short
  sentences, ordered questions, examples).
- **Parallel OFF hides the concept**: no `Delegate` tool, no mention of
  sub-agents or "Parallel" anywhere in the model-facing prompt, and past
  `Delegate` turns filtered out of the conversation — the model does not know
  sub-tasks exist.
- **Parallel enforcement removed**: the old hard rules are gone (the
  delegate-only first turn, the blocking of non-Delegate calls, the
  "must delegate" nudge and the host-forced sub-agent). The model has its full
  tool set from the first turn, plus `Delegate`. Conflict analysis and backend
  serialization are unchanged.
- **Dev build watches both bundles**: `npm run dev` now builds and watches the
  extension host AND the webview, so `dist/extension.js` and `media/view.js` no
  longer go stale while developing. A rebuild still needs a window reload.

### Fixed

- **MCP stdio servers are killed with their process tree**: `McpStdioClient.close()`
  used a bare `child.kill()`, leaving the server's own children alive. It now
  uses the shared `killTree` (process group on POSIX, `taskkill /T /F` on
  Windows), and the server is spawned as a process-group leader.
- **Fire-and-forget config pushes cannot become unhandled rejections**:
  `pushConfig` / `postSwitchView` now catch and log a failure; the next push
  recovers the UI.
- **Changing the model no longer clears the prompt**: switching model persists the
  choice to `config.json`, and the config-file watcher used to rebuild the whole
  webview (wiping the typed prompt, scroll and streaming state). Config changes
  now use a **lightweight refresh** (re-apply the per-model overrides + push the
  config) that preserves the panel; only an `editor.fontSize` change still
  rebuilds the HTML.
- **Mode/controls stay in sync (Analyze vs Build)**: `pushConfig` is async, so
  an older config response could resolve AFTER a newer one and revert the UI —
  e.g. show **Build** while the host/agent was still in Analyze, making every
  tool behave as read-only. Config pushes now carry a monotonic `configSeq`;
  the host drops stale results and the webview ignores any config older than the
  last applied. A `setMode` with no active runtime re-pushes the host's truth
  instead of leaving the UI optimistically out of sync.
- **Reliable "Switch to Build" call to action**: the highlighted banner was
  triggered by a marker string in the answer, so it disappeared whenever the
  model wrote its own "switch to Build" line (exactly what the prompt asks for)
  and never appeared for previews prepared by delegated sub-agents. It is now
  driven by the real condition (a preview was prepared, directly or by a
  sub-agent) and persisted as a message flag, so it also survives a transcript
  reload.
- **"Switch to Build" is now a one-shot modal**: when Analyze prepares previews,
  the host asks **once** whether to switch to Build — with a tip to restart the
  chat (new session + repeat the request) so the changes are applied from a
  clean Build context. The transcript keeps only a static, non-clickable note,
  so a stale button can no longer be clicked on a past turn.
- **The preview footer LISTS what sub-agents prepared**, and a read-only
  sub-agent that could not write now reports it explicitly, so the orchestrator
  can re-delegate it with write access.
- **A working session's tab cannot be closed**: the × was already disabled in
  the UI, but the host now also refuses `closeTab` while a run is in flight
  (streaming/sending/draining), closing the start-of-run race. Closing VS Code
  still stops everything.

## [0.1.0] - 2026-08-25

First release: an AI coding harness for VS Code over the OpenAI Chat
Completions protocol.

### Added

- **Chat Completions + streaming**: `/v1/chat/completions` with SSE streaming,
  tool-calling and `finish_reason` handling; OpenAI, OpenAI-compatible hosts
  (Ollama, LM Studio, llama.cpp) and Anthropic's OpenAI-compatible endpoint.
- **14 tools**: Read, Write, StrReplace, Edit, Delete, Shell, Grep, Glob, Skill,
  TodoWrite, WebSearch, WebFetch, ReadLints, Delegate (plus dynamic
  `mcp__<server>__<tool>` tools from MCP servers).
- **Two chat modes**: **Analyze** (read-only preview — file tools run as
  validated dry-run diffs, and Shell is guarded by an **allowlist-first**
  read-only policy including git read commands) and **Build** (full tool use).
- **Parallel sub-agents**: the `Delegate` tool launches independent sub-tasks,
  with resource-conflict analysis, automatic serialization of overlapping
  writers, a configurable concurrency cap and per-sub-task abort.
- **Loop guard**: reasoning / empty / tool-failure / error-streak / tool-repeat
  loops are detected and broken, with per-session sensitivity and tunable
  parameters.
- **Persistent sessions in a single SQLite database** (`node:sqlite` + FTS5 full
  text search), tagged per workspace folder, with **versioned schema migrations**
  (`PRAGMA user_version`), DB compaction (VACUUM + index/FTS optimization),
  branch / cut / rename / delete and an all-folders manager.
- **Agent Skills** (skills.sh) with progressive disclosure and manual `/skill`
  activation; **MCP** servers over stdio and Streamable HTTP.
- **Per-session controls** (sliders): context window and output tokens (the
  scale follows the model's real limits), sampler (temperature/top-p), penalties,
  thinking level and every Loop Guard parameter.
- **Attachments**: files/images via the picker, paste or drag & drop; images sent
  as multimodal content; **binary files detected from their content** (magic
  bytes) and never inlined as garbage.
- **Diagnostics**: per-turn lines in *Output > Harny*, an optional request log
  (`HARNY_DEBUG=1`), per-turn metrics badges and real context accounting.

[Unreleased]: https://github.com/spltek/harny/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/spltek/harny/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/spltek/harny/releases/tag/v0.2.0
[0.1.0]: https://github.com/spltek/harny/releases/tag/v0.1.0
