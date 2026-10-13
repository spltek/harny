# Changelog

All notable changes to **Harny** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Undo last run**: before a writer run touches files, Harny snapshots the
  declared resources (files; declared directories are walked, vendored/build dirs
  skipped). After a run that changed files, an **Undo run** button restores the
  previous contents and deletes the files it created. Text-only and best-effort
  (binaries and oversized files are left untouched), and one-shot.

### Changed

- **"Parallelism means sub-tasks" (Parallel ON)**: the prompt now states it as an
  identity **and a MUST**: PARALLELIZABLE (2+ independent items — the same
  operation on different targets, OR different tasks that do not depend on each
  other, e.g. look something up and create a file) → you **MUST** emit N
  `Delegate` calls in the SAME turn, and a turn that plans to parallelize but
  contains no `Delegate` call is INVALID. Own tool calls in one turn run serially
  (calling several tools at once is **not** parallelism). The permissive wording
  ("you do not have to delegate", "judgment call") was removed.
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

[Unreleased]: https://github.com/spltek/harny/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/spltek/harny/releases/tag/v0.1.0
