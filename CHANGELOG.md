# Changelog

All notable changes to **Harny** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Code is coloured wherever code is shown — a tool's Input (always), an output whose FILE says what language it is, the fenced blocks of an answer, the Diff — and a language nobody can PROVE stays plain.** The three new surfaces are: **Input**, in every bubble, because `formatArgs` stringifies the arguments so the language is never a guess; **Output**, only when the file the tool touched has an extension the bundle knows (`Read`/`Write`/`Edit` and friends carry it in their own arguments, which is why the panel needs no wire change — `ls`, `grep`, `glob` and a shell's stdout stay plain, because tokenizing them invents keywords and strings that read as a rendering bug, not as help); and a **fenced block**, through markdown-it's `highlight` hook, which is the only place where the language is still declared AND the body is still source — re-tokenizing the already-escaped HTML is how a `&lt;` ends up painted as a string. `src/chat/webview/highlight.ts` is the ONE door (`highlightToHtml`), and it answers `null` — "leave the text alone" — for no language, no grammar, a blank body, or anything over **`HIGHLIGHT_MAX_CHARS = 12 000`**, the same 12 000 the output is already cut at, so "what you can see" and "what is coloured" cannot disagree; tokenizing is synchronous on the webview's thread and every rebuild of the transcript re-paints every bubble. The promise this feature would quietly break is the TEXT: the HTML it returns has a byte-identical `textContent` (Prism escapes what it emits), because `extractPath` reads a tool's Input back with `JSON.parse` to find the file — and therefore the language of the Output and the whole Diff section. `highlight.test.ts` pins that, not the colours. Two defects paid for on the way: `wrapCodeBlocks`'s label regex was `\w+`, so a fence labelled `c++` or `c#` fell through to the bare-`<pre><code>` rule and left a `</div>` with no opening tag (now any label, with a test that counts the two sides), and both new lookups are `hasOwnProperty` — a fence label is MODEL-WRITTEN, so `__proto__` used to resolve to `Object.prototype` and be handed to Prism as if it were a grammar (`Prism.languages` is a plain object, so the door checks it too). The Read trailer (`[Truncated: lines 1-2 of 900]`) is put back as text, after the tokens: it is a note ABOUT the file, and colouring it painted the last line of a truncated read as source. On the stylesheet side the token scope is now `:is(.fd-body, .code-block, .tool-args, .tool-result) .token` — a new surface must opt in, and a surface that opts into the engine without opting into the sheet would render PERFECT tokens in the inherited colour, i.e. look exactly like "no highlighting" while every DOM assertion passed. `src/chat/webview/token-scope.test.ts` pins that list in both directions (nothing dead, nothing unwritten) and the single door (only `highlight.ts` and — for the diff, line by line — `view.ts` may call `Prism.highlight`). **⌘F had to be fixed for this, and the fix repairs a bug the Diff already had**: `find.ts` scanned one TEXT NODE at a time, so a phrase that crossed a token boundary (`function foo`, where `function` is a span of its own) simply did not exist — the coloured code was the text nobody could search. It now concatenates the text nodes of a BLOCK (`.msg`, a diff line, a `pre`, a `li`…), searches the concatenation and maps the offsets back onto the nodes, so a match may span inline markup but never two bubbles or two diff lines; the empty-text-node guard it made unnecessary is gone rather than kept as a branch no test could tell from its absence, and two new tests assert where a match POINTS (the `anchorNode`, not only the count), because a correct count over a range one character short looks fine and is not. The mapping tables in `lang-map.ts` are now exhaustive in `lang-map.test.ts` and checked against the BUNDLE (`every id must have a grammar`) — a mutation run showed the price of testing by example: 23 alias entries whose value could be blanked without a single red test. Two new floors come with the feature and are wired into `mutate:ratchet` / `mutate:baseline`: **`npm run mutate:syntax`** (`highlight.ts` + `lang-map.ts`, 71 mutants, **100 %**, 0 known holes) and **`npm run mutate:find`** (the scanned range `find.ts:108-169`, 57 mutants, **94,74 %**, 3 named equivalent mutants documented in the source and recorded in `survivors-baseline.json` — the `?.` on a node that always has a parent, and two junk initialisers whose junk can never be selected because `nodeAt` resolves to the highest part that starts at or before the offset). The webview window moved with `view.ts` (`6831-6850` → `6862-6881`) and was re-measured at **100 %**, 0 new holes: `ratchet-anchors.test.ts` is what says so when a range slides.

### Fixed

- **The Windows leg's real-file tests get 60 s, not 20 — and now they say where the seconds went instead of only that they ran out.** The previous ceiling was set one measurement short: this file takes 2.3 s on `ubuntu-24.04`, 4.5 s on `macos-latest` and **14.2 s** on a healthy `windows-latest` (17.4 s with the rest of the suite running beside it, so contention is only +23%), where its heaviest test alone costs **1.3–1.7 s** — repeating within 0.3 s from run to run. What is _not_ repeatable is the host: one `windows-latest` run took the same file to **59.9 s**, with `a PINNED VACUUM owes a COPY` at **21 s** — 16× that test's own normal cost — while the CPU burnt stayed at 15–110 ms per phase, i.e. the thread was parked on the filesystem, not computing. So the 20 s was racing a degraded runner and lost the same way the 5 s default had; the assertions are untouched, because this ceiling is a hang guard, not a speed assertion (speed lives in `sqlite-store.perf.test.ts`, against p95 thresholds) and it is paid for only when a host is degraded. Two corrections to what 1.2.1 shipped: antivirus is **not** the cost — `RealTimeProtectionEnabled` is False on `windows-latest` and a flushed 1 MB write measures p50 **7.6 ms** / max **15.2 ms** there — and the worst test is 1.3–1.7 s, not 3.6 s. What costs is the VOLUME: ~34 MB of synchronous writes per case (8 MB of `fill`, 13 MB rebuilt by the VACUUM, 13 MB copied back by the checkpoint). Every phase over 1 s is now logged with **wall clock against CPU**, computed rather than asserted — `[real-file-io] maintain (VACUUM + checkpoint): 588 ms of wall clock for 94 ms of CPU — the thread was WAITING on the filesystem, not computing (degraded host, not this code)` — so the next red diagnoses itself: silence under 1 s on every platform, and a line that names the phase that ate the minute.

## [1.2.1] - 2026-11-16

### Fixed

- **The event-loop figure in the telemetry line was off by a full sampling period: an idle host read 51 ms of "lag", so the busy threshold was true forever and every stall was overstated by 50 ms.** `monitorEventLoopDelay` records the INTERVAL between two of its own callbacks (`RecordDelta`, `src/histogram-inl.h`), not the lateness of one, and `NativeLagProbe.read()` passed those intervals straight through as milliseconds of delay. Measured on the built code: an idle loop read **51.1 ms**, a 200 ms stall **249.8 ms** — exactly `lateness + RESOLUTION_MS`. Two consequences, both invisible to the tests: `BUSY_LAG_MS = 25` was true on an idle host, so the "prints nothing on an idle host" window logic printed a line every 30 s anyway; and every stall was reported a quarter too high. `read()` now subtracts the sampling period, which is exact rather than a fudge — the sampler cannot fire EARLY, so `interval - RESOLUTION_MS` is the lateness: idle reads **2.2 ms**, a 200 ms stall reads **198.2 ms**. Why 1.2.0's tests missed it: the only test touching the real probe asserted `maxMs >= RESOLUTION_MS`, a quantity the broken version returned as a constant, so it passed on macOS and Windows by a hair and landed at **49.61** on ubuntu, failing the release gate — the failure was real, it just pointed at the wrong line. That test now lets the sampler take its first sample before stalling (the FIRST callback after `start()` is a baseline, not a measurement: a stall beginning in that same turn is swallowed, which is exactly what hid this while it was being measured) and asserts late milliseconds.
- **"Focus" now reads as LIT instead of as hovered: the armed pill wears the panel's ON light — the accent gradient and the soft halo that "Build" and "Parallel" already wear — where both states used to be the same pixels.** It carried its state with the very recipe the hover paints (accent text, accent edge, accent wash), so a Focus you had just switched on and a Focus the pointer happened to rest on were indistinguishable, and the state that matters — a mode that is armed — was the quieter of the two readings. ON now takes the light the two other modes in the panel already take: `linear-gradient(135deg, var(--accent), var(--accent-strong))`, white on top, and `0 0 12px var(--accent-glow)` around the pill, matching `#mode-btn.is-agent` (Build) and the shape `#parallel-btn.is-on` (Parallel) uses in its own hue. Hover is untouched and stays a flat wash, so "on" is a light and "hover" is a tint; when the two meet, the halo **deepens** (`0 0 16px var(--accent-glow-strong)`, the same move Parallel makes on hover) instead of washing the state away under the pointer. No transition and no pulse: a pill that breathes while you read is a distraction. Measured in a headless render, not assumed — rest, hover, on and on+hover resolve to four different computed looks in both palettes — and the markup suite pins the two halves, including that the hover rule cannot repaint an armed pill.

## [1.2.0] - 2026-11-16

### Added

- **The transcript can follow the run for you: the "Focus" pill opens the section the agent is working in and folds the one it has left behind — which is what makes steering practical, because reading a live run and deciding to cut in are the same moment.** Every section (a thinking block, a tool card) is born folded, and that is right for reading _back_ and wrong for reading _now_: following a run by hand is one click per thought and one click per tool, and the thing you cannot do while clicking is judge whether the run is going where you want. Armed, the mode does it instead — and it folds the section the agent **left behind**, not the one it **finished**, which is the whole design: a tool card folded the instant its `toolResult` lands would close in the one moment its output is worth reading, so the fold waits for the NEXT activation and the result stays on screen while the run moves on. Three rules keep the mode from fighting the reader. **One open at a time**: parallel calls activate two bubbles in the same turn, and "everything active is open" is the wall of cards this mode exists to avoid, so the newest wins and the previous folds — the same shape the transcript already has, read top to bottom, and no special case for `Parallel` anywhere. **Sub-agent logs are not its business**: they are bodies opened by hand, on purpose, and `focusTargetOf` names them out before the selector can pick them up (a `Delegate` bubble wears `.msg.tool` too). **A manual toggle wins for that section, for good**: the header's own click and "Collapse all" mark the body (`data-focus-manual`), and Focus then neither opens nor closes it however active it is — while the section born after it carries no mark and behaves normally, which is exactly the handover asked for (_"the next one opens as default and folds when it is done"_). Marking is what "Collapse all" does to the sections it actually closes, never to the already-folded ones: disarming the mode across the transcript on one press would leave it looking broken. State is a single reference, `focusOpened` — the ONE body Focus opened itself and therefore the only one it may close again — released on `resetStreamState` (so `done`, `interrupted`, a refusal, a session switch and every rebuild start clean), and releasing is what the end of a turn needs: the transcript now comes to rest on the ANSWER, which has no fold of its own and is open by nature — leave the last card open and it sits UNDER the answer, in a run that is already finished. The reference is dropped and not folded when the body it named is gone, because a rebuild throws the DOM away (`isConnected`) and folding a detached node is work thrown away. A rebuild is not an activation: history replays through `addThinkingBlock(..., { pulse: false })` and stays folded, so a `refresh` never re-opens half the transcript — with one exception, because a run that CONTINUES must not be left with nothing on screen: `replayLiveTurn` re-opens the call it is still inside (`liveToolEl()` asks for `tool-call-pending`, so the ones already done stay folded — the transcript's business, not the mode's). The mode is a **mode**, not an action, and the three pills are not interchangeable: the other two fire once and disable themselves, this one ships enabled, carries its state in `aria-pressed`, is painted with the hover recipe held steady (accent text, edge and wash — no transition, no pulse: a pill that breathes in the corner of your eye while you read is a distraction), and survives a webview reload through `getState`/`setState` like the collapsed control stack. Arming it **mid-run** does not wait for the next step: it opens what is live right now (the reasoning in flight, else the tool still running). Cost, because this sits in the streaming path: `focusOn` runs once per STEP of a run — a section born, or a settled block waking up (`"Thought during this answer"`) — and never per delta, while the per-delta path only calls `focusOff`, whose first line bails out on a single comparison whenever Focus holds nothing open, so a run with the mode off (the default) pays one branch per delta and nothing else. Pin, 12 tests in the view suite plus the markup and the tooltip contract: the pill arms/disarms without toggling the control stack and is never disabled; the reasoning opens and folds when the tool starts; the tool stays open after its own result and folds at the NEXT step; two parallel calls leave exactly one open; `done` closes what was left, so the answer is the only thing left open; disarming closes what it opened; arming mid-run opens the live tool but not one whose result has already landed; a `Delegate` log stays shut; a hand-folded section stays folded while the agent is still inside it **and** a hand-opened one is not folded behind the reader's back; "Collapse all" closes the live section and leaves it closed while the next one still works; a `switchView` rebuild comes back folded, except the running tool it re-opens; the mode is restored from persisted state. README ("How every step is tracked") and the site's _Nothing is hidden_ card now say what the mode is for.

### Fixed

- **The Windows leg stopped being red on a stopwatch: the tests that write real megabytes to a real file get 20 s, not the 5 s default.** `main` went red on `windows-latest` with ONE failure — `dbVacuumStats carries the footprint BEFORE any click` — and it was not an assertion: it timed out. The suite has 2926 tests and the problem is one file's two compaction blocks, so the first question was WHERE the seconds go, and they are in the bytes: one `fill()` — 2000 messages of 2 KB, saved and then deleted — writes **31.7 MB** (16.0 MB `sessions.db` + 15.7 MB `-wal`, 4105 pages of which 2301 end up free) and costs **123 ms** here against **~1,2 s** on the Windows runner, where every page passes through Defender and NTFS; the file's ~15 fills are ~600 MB of real IO, and its 28.6 s against 1.9 s is that multiplier. It is the only file that owns the problem — 10 of the 16 tests at or above 1 s on that runner are in it (19.4 s of its 28.6 s). Nothing in the product is wrong, which is why this is a budget and not a fix: `openFile()` + migrations cost 1.2 ms, the file's first test pays 18 ms and not seconds, `dbVacuumStats()` is three `PRAGMA`s and two `stat`s, the FTS table is `external-content`, and each save is ONE transaction. The two blocks now declare their budget once (`describeRealFileIo`: 20 s) instead of inheriting a default measured on another OS; the assertions are untouched, and everything else keeps 5 s so a real hang still fails fast. Not a global `testTimeout` (it would hide hangs in the other 129 files), not a smaller `fill()` (the free pages it leaves ARE the subject of those tests), not `{ timeout }` per test (Prettier expands a call with a third argument and reindents ~500 lines of bodies). Proven on the test that failed rather than assumed: with a 6.8 s busy-wait injected it now passes at 6908 ms where it used to die at 5000.

- **The hover card now survives a live run: a scroll closes it only when it takes its anchor away, instead of closing it on any scroll at all.** `installTips` dismissed on every `scroll` anywhere in the panel, and both ways to read that rule were wrong in the same direction: a wheel moved while reading was pressed on quietly, and the case that actually happens was made impossible — the transcript streams and scrolls ITSELF as it grows, sixty times a second, so over a running turn the card had to survive the feed to be read, and it never did. The pill that suffers most was the new one: hover "Focus" during a run and the card opened on the timer and vanished on the next frame, which reads as a tooltip that works everywhere except where it was needed. The dismissal was written for the case it was really about — a card floating over content it no longer describes — and that is a fact about the ANCHOR, not about the document, so the card now follows its anchor across a scroll (`place()`) and closes only when the anchor has left the viewport or the document (`anchorGone`): a still anchor (the transcript toolbar sits above the scroller and never moves) means a still card, a moving one means a card that moves with it. Cost: one `getBoundingClientRect` per scroll event, and only while a card is up — the handler returns on its first line otherwise, so the streaming feed pays nothing. Click (`pointerdown`), Escape and a `resize` still dismiss. Pin in `tips.test.ts`: a scroll that leaves the anchor where it is keeps the card open; a scroll that moves it re-places the card (asserted on `style.top`, not on "does not throw"); a scroll that takes the anchor out of the viewport closes it — three outcomes the old rule could not tell apart, because it answered all three the same way.

- **The panel no longer spends its CPU repainting a pulse: the streaming beat is composited, so it costs 0% of the webview main thread instead of up to 18%.** The three working indicators — the answer bubble being written, the live thinking block and every running sub-agent — beat with `@keyframes stream-border-pulse{,-violet}`, which animated `border-color` and `box-shadow`. Those are **paint** properties: every frame of a 1.2s `infinite` cycle invalidated style and repainted the box, so the renderer ran a style recalculation **60 times a second for the whole duration of a stream**, and the cost grew with the transcript because each recalculation walked the document. Measured with Chrome DevTools protocol on the real `media/view.css` (1200 bubbles, four live areas — the answer, the thinking block and two sub-agents, i.e. one multi-tool turn): **9.3% of the main thread and 60 recalcs/s at HEAD, 0.0% and 0 recalcs/s after** — the same measurement on a hand-built page with the same four areas reads 18.3% before and 0.0% after, and the cost scales with the DOM (3.5% at 30 bubbles, 3.9% at 400, 7.8% at 1200 with a single pulse). That waste lands exactly when it hurts: while the answer is streaming, competing with the markdown paints the pacer (`minGap`) exists to protect. Now the border is static (full accent, or the sub-agent violet) and the **halo** is an overlay `::after` animated with `opacity`, which the compositor runs off the main thread; the settling states keep the graceful ~0.7s fade by keeping the same overlay and sliding its opacity to 0. The phase lock that makes every area beat together is preserved: `phaseLockPulse()` cannot put an inline style on a pseudo-element, so the same offset travels as the inherited custom property `--pulse-delay` (`animation-delay: var(--pulse-delay)`), and both are cleared when an area settles so a reused bubble cannot inherit a stale phase. The look is unchanged — screenshots of the four areas frozen at the peak and at the dim half of the cycle differ by at most **7/255** on a single channel, i.e. the alpha ramp of the glow. Pin: the bubble carries both `animationDelay` and `--pulse-delay` as negative offsets, and the keyframes stay `opacity`-only (anything animated on these boxes must be `opacity` or `transform`), because the cheap-looking alternative is the one that burns a core.

- **A compaction no longer "works only at the second click": the first one either takes effect or says why not — and clicking again can no longer make the file BIGGER.** `maintain()` swallowed every failure (`catch { /* best effort */ }`) and the panel mapped `vacuumed === false` to _"Nothing to reclaim: the database was already compact and the indexes optimal."_ The real silence, though, was not an exception at all: `PRAGMA wal_checkpoint(TRUNCATE)` returns `(busy, log, checkpointed)` **instead of throwing**, and `exec()` throws the row away — while in WAL mode the pages a `VACUUM` rebuilds live in `sessions.db-wal` until a checkpoint copies them back. Measured on a 78 MB database emptied of three quarters of its rows: with a second connection holding a read snapshot, the page counters reached `free=0` on the **first** pass while the file stayed at 156 MB, and every further `VACUUM` appended another full copy of the database to a `-wal` nobody could truncate — 100 → 120 → 140 MB. So clicking again did not merely fail to help, it grew the file; and the pass that finally emptied it (140 → 19.5 MB) looked like the only one that had done anything. Now `maintain()` measures the real size **before** touching anything, drains the WAL and **reads** the checkpoint row, and when that checkpoint is `busy` it **writes nothing** — no FTS `optimize`, no `VACUUM` — returning `walCheckpointBusy: true` with `vacuumed: false` and an unchanged before/after: the file cannot grow, and the call after the reader leaves takes pages **and** file together in one pass. The report also carries `bytesOnDisk`/`walBytes` (`dbPath` + `fs.size`, absent in the in-memory tests) and the modal shows them, so _"did it empty"_ and _"how much is reclaimable"_ stop being one confusing number. Pin: a file-backed WAL database emptied by ONE `maintain()` (footprint of `sessions.db` + `-wal` strictly smaller, `freePages` 0, no `walCheckpointBusy`); a run with a reader holding a snapshot that reports `walCheckpointBusy: true`, `vacuumed: false`, `error` undefined and leaves the footprint **byte-identical**; and the run after the reader leaves, which empties both. The reader is detected by the drain itself, so it is visible from the **first** click in practice (a live database always carries WAL frames); only a click on an empty WAL cannot tell and compacts once — which is why the repetition, the part that piled up copies, is what gets refused. Replayed against the real store and the real migrations, 60 sessions of 80 messages then 55 deleted: one click with a single window took the file from 32.03 MB to 2.71 MB, while with a second connection reading it three clicks wrote nothing and kept it at 32.03 MB, and the click after that connection left took it to 2.71 MB. In the panel, a failed compaction says _"Compaction FAILED: <reason>"_, and a refused one says another connection is reading the file and that nothing was changed (never "nothing to reclaim"). A compaction that could not be delivered is now **remembered**, because a `busy` checkpoint is a fact another connection owns and no number of retries can learn when it lets go. The store keeps what it owes the file as one of three states — `none`, `compact` (the pass never started: it was refused, so the whole thing is still to do) or `copy` (the `VACUUM` ran and its pages are sitting in the `-wal`) — and pays the debt at the first **observation** of a free WAL rather than on a stopwatch: the `finally` of `saveMessages`/`saveSettings`, a session delete, the end of a turn, the panel coming up. The two debts are not the same work, and that difference is the whole bug: `copy` runs **only** `wal_checkpoint(TRUNCATE)`, `compact` runs the full pass — because repeating the `VACUUM` is what appended one more full copy per click. Measured on the real store after a pinned `VACUUM` of a 32 MB file: one bare checkpoint took it to 4.95 MB, while a second `VACUUM` cost 16 ms, reported the same `freePages`, wrote nothing new — and put 4.98 MB back into the `-wal`. A real failure (a full disk) is **not** a debt and is never retried by itself: it would fail the same way, and the state machine would turn an honest error into a loop. So the panel says _"the compaction is QUEUED: it runs by itself as soon as that reader is done — no need to click again"_ for a refusal, _"the pages are compacted… they are COPIED into the file as soon as it is free (no second VACUUM is needed or wanted)"_ for a pinned pass, and, when the copy finally lands, what the file went from and to (`bytesOnDisk + walBytes`, the footprint the user sees in Finder) instead of a fresh _"Nothing to reclaim"_. Pin: a refused pass reports `pendingMaintenance: "compact"` and leaves the footprint **byte-identical**, and the `settlePending()` after the reader leaves ends `none` with the file smaller; a pinned pass reports `"copy"`, and settling it moves bytes while the **page count does not change** — that count is what proves no second `VACUUM` ran; a plain `saveMessages` pays the debt with no click at all; six settlements with the reader still there leave the footprint identical six times and lose nothing; a `VACUUM` that throws reports the error and owes nothing. **More threads**, the case that matters: four worker threads, each an OS connection of its own, reading in held snapshots and writing, `busy_timeout = 0` on our side so the checkpoint reports instead of waiting, while the host thread attempts 500 compactions — 19 `VACUUM`s, 481 refusals, peak footprint **equal to the starting size** (not one byte added), `integrity_check` `ok`, the surviving session complete and the deleted one still deleted; then one `settlePending()` took 12.25 MB to 0.17 MB. A forced click — the panel passes `freeRatioThreshold: 0` on purpose — also stops being a rewrite: the free list is re-measured **after** the two optimizes (merging FTS segments is what frees pages) and when it is **0** nothing is written at all, so a click on an already-compact database costs nothing instead of rewriting every page to reclaim zero bytes — measured under the same four reader threads, 500 attempts now produce **one** `VACUUM` and leave the remaining ones finding no free page, where before each of them copied the whole file again. The panel answers that click with the state instead of a verb — _"Nothing to reclaim: 0 free of 2190 pages and the indexes already optimal — the file is 8.6 MB, nothing was written"_ — where it used to say _"Vacuumed & optimized in 0.0s"_ on numbers that had nowhere left to go (the reported "I click and click and nothing changes"), and `dbVacuumStats()` carries the footprint as well, so the "8.8 MB on disk (64 KB in the WAL)" line is on screen **before** the first click instead of appearing only in the report And a pass that ENDS at 0 free pages now says it is the last one — the reported "always two VACUUM & optimize to reach the plateau" was the panel admitting on the second click what the first had already done: the run that empties the free list is the only run left, so the button stops at "Nothing left to reclaim" instead of inviting another, and a click that writes nothing shows ONE block of numbers — the "↓ after the VACUUM" arrow over an identical copy invented a second stage that never happened.

### Changed

- **The always-on telemetry probe stopped waking the extension host twenty times a second: the event-loop histogram is native, and the only timer left is the 30 s report.** `Telemetry` measured loop lag with `setInterval(tick, 50)`: a JavaScript callback firing 20 times a second for as long as a chat panel existed, to answer the question "is the host busy?" — the measurement was itself on the thread it was measuring, and it meant a sleeping extension host could never truly idle (50 ms also being the granularity, since the lag was the drift of that timer). It is now `perf_hooks.monitorEventLoopDelay({ resolution: 50 })`: a native histogram sampled without any JavaScript callback, same 50 ms resolution, mean/p95/max read only when a line is about to be printed — **600 times fewer wake-ups** (one per 30 s window instead of one per 50 ms), and the numbers that identify saturation are the same. The line is still printed only when something moved (traffic in the window or a delay at or above 25 ms) through the `HARNY_DEBUG`-gated log, and the window still resets the counters and the histogram together; `stop()` now disables the histogram as well, so a closed panel leaves no probe behind. The seam is exercised without a stopwatch: `LagProbe` is injected, so the tests drive the window (`start`/`stop` idempotent, one line when busy and **none** when idle, counters and histogram reset at the window's end, a single 40 ms stall enough to report with no traffic at all) while one test runs the REAL probe — blocks the thread for 200 ms and asserts the histogram records at least one 50 ms step, then that a `reset()` takes it back to zero.

## [1.1.1] - 2026-11-14

### Fixed

- **The extension no longer carries a document that is not for you: `REVIEW.md`, 62 KB of design notes in Italian, is out of the package and out of the repository.** `vsce` packs the **working tree** and not the git index, and the file was tracked — so 1.1.0 delivered it into the extension folder of everyone who installed, next to `readme.md`, where it reads as documentation for something that does not exist. The notes are the maintainer's, written between releases: they now live **one folder above the repository**, and no ignore line names them anywhere — an ignore entry still names the file and hides a leak (`git add -f`, a copy under another name) instead of preventing it. What stands in its place is a test: the file must not exist in the working tree, and since both packers read the same disk, its absence is the whole guard. It was removed from the **history** as well (`git filter-repo`), so no clone can bring it back. Pin: the packed `.vsix` carries 11 entries (the manifest and `[Content_Types].xml`, `package.json`, changelog, readme, LICENSE, `dist/extension.js`, `media/view.js`, the three icons), and `src/package-manifest.test.ts` asserts that absence together with its positive half — the runtime paths must still be **inside**, or an `.vscodeignore` that excluded everything would pass every "nothing leaks" check and publish an extension with no code.

### Changed

- **Every mutation `break` floor now sits one mutant above the loss it has to catch, instead of "the score minus about 0,05".** A fixed 0,05 margin means one mutant in a file of 2000 and a **twentieth** of one in a file of 100 — and on the small matrices it was not even the loss it claimed to catch: `webview` holds 10 mutants, so the first survivor is worth 10 points and a 95 % floor left five mutants of slack; `chat-panel` holds 9, `session-recovery` 56. Each of the ten configs now carries the smallest 2-decimal value **strictly above** `score - one mutant` (Stryker fails when `score < break`, so the post-loss score itself would still pass): default 94,35 → 94,34, compactor 92,68 → 92,60, loop-guard 95,81 → 95,72, overflow 91,38 → 91,14, tool-scope 97 → 96,12, mode-policy 94,88 → 94,83, webview 95 → 90,01, chat-panel 93,75 → 88,89, num-field 99,46 → 99,29, session-recovery 98 → 96,43. Each number comes from a real run of that config; `high` stays the measured score and `low` follows `break`. The percentage remains the **alarm** and not the gate: `scripts/mutation-gate.mjs` is what fails a run on a NEW survivor, because a percentage also moves for reasons that are not regressions (a different mutant count, a shifted line range).

## [1.1.0] - 2026-11-14

### Added

- **Every prompt you wrote is closed by Harny's mark, hung OUTSIDE the orange bubble, on its right edge.** The mark is **as tall as the STRAIGHT RUN of the bubble's border** — one line box, `1.4em`, the space between the two rounded corners — written as that expression and not as 18px, so it follows the type if the font moves; and it is **15/11 of that height wide**, because the drawing is the whole logo (the bubble _and_ the caret answering beside it) and its canvas is 15:11. The bubble's `margin-right` is the same expression plus the 6px of distance, and the `max-width` subtracts it from the same cap: `.msg` stops a bubble at 92 % of `#messages`, and 92 % + the mark's column does not fit in a narrow panel — the logo is wider than it is tall, so the column is wider than the bubble's padding. Without that subtraction the excess lands on the left (it is the margin box that `align-self: flex-end` aligns) and a long prompt bleeds out of the transcript. With that measurement the mark is also, by construction, **aligned to the first line**: it starts where the line box starts (`top: 8px`, the bubble's radius), so a four-line prompt keeps it beside the first line and never beside the third, and the test forbids the other way in the negative (`top: 50%`). Outside and not inside because the width of the bubble **is** the message: a mark in the corner either eats a line of text or detaches the bubble from the edge on every single prompt. So `left: 100%` puts it past the edge and the `has-avatar` class makes the bubble pay for the column with a margin — no wrapper, no change to `#messages` and **no change to the bubble's shape**, which stays the usual 8px lozenge on all four corners. It is decoration (`aria-hidden`, `pointer-events: none`, `user-select: none`) and it asks for **no weight**: it is a solid, not an outline. The drawing is **the logo**, `media/icons/harny.svg`, and it took three passes to get it right — each one corrected by a defect seen on screen. First an outline in `currentColor` (like every other mark in the panel): **a 1,5 outline next to a filled bubble reads as something smaller than the bubble** — a line drawing is almost all empty space — so the file kept the solid and the logo's gradient. Then, to fit it in a square slot, the composition was **cropped to the bubble**, throwing away the caret that answers: half the mark, and the mark read at once as a broken logo. On top of that the square canvas left air above and below the drawing, so the signature sat **a couple of pixels lower** than the bubble it signs. Now the file is **the whole logo**, mapped once from the original drawing (which works in thousandths: `translate(-3.045 1.123) scale(0.024664)`) with an **isotropic** factor (k = 24/880) on its own box: 170..1050 × 118..763,33 → **24 × 17,6, that is 15:11**, which is the mark's proportion. The canvas _is_ the artwork's box, the ink touches all four edges, and the CSS gives the mark a box of the same shape: the two tops and the two bottoms are the same line, and the height is that of a line box. Measured on the render: proportion 1,3636 like the file, and the ink fills the box to all four edges — while in the old square crop the drawn bubble came out proportionally smaller. (A square canvas is right for a glyph; an image keeps its shape — it is that folder's second exception, together with the gradient.) The prompt's caret stays **a hole in the solid** (`fill-rule: evenodd`, it is a sub-shape of the mark, not a stroke): what shows through it is the panel, as in the app icon. The answering one, instead, is **a stroke** — the logo's polyline, `stroke-width` 52 in thousandths that is 1,42 here, with round caps — so colour lives per element and not on the root: the file is not uniform, it is a solid plus a line, exactly as the brand draws it. The gradient travels **inside** the file, which is the only exception to that folder's rule "no `id`, no gradients", and the exception has a precise reason: copies of the file are byte-for-byte identical, so repeated `id`s all resolve to the same colour, whereas a paint server defined once in the panel and merely referenced here would leave the mark **empty** precisely in the contact sheet, which loads every file as an `<img>`, that is, as a document of its own — a mark nobody can look at is the failure that folder exists to prevent. Consequences on the ground: the `color: var(--muted-2)` declaration leaves the CSS (there is nothing left to tint: the signature's grey no longer exists, and the panel now has two oranges — the prompt and its signature — not one), the sheet shows the mark without the `invert` filter that turns all the others (`img.native`, because inverting an orange gradient gives its complement) and in its own 15:11 box instead of a square one, and the folder's README updates the rules (own canvas and per-element colour) and the weight table (solids drop to five, and the mark gets a row of its own). The `person-round.svg` that was there has been **deleted together with its row in the sheet**, not left orphaned: the orange bubble already says "a person wrote this", the mark says the same thing and says **whose**. The bubbles the user did NOT write do not carry it: the nudge (the label and the blue already say it) and the synthetic checkpoint (it already carries the `history` mark, and its full-width card with the reserved margin would run off the right edge).

### Fixed

- **Clicking the session you are ALREADY reading no longer reloads it.** The row of the session on screen went through the whole open path: the veil came up over the transcript (`switching`), the host re-read the messages, rebuilt the transcript and re-posted the session list, and every row action was redrawn — for a click whose only visible effect should have been the list collapsing out of the way. `ChatViewProvider.isShowing(id)` now answers the one question that matters — **open AND on screen** (`activeId === id` and the runtime still exists, so a closed or deleted tab is not "showing" by accident of a stale `activeId`) — and both entry points honour it: `openSessionId` returns before touching the registry, and `setActive` returns before posting `switching`. In the panel, the row of the active session posts nothing and raises no veil, while a row for a session that is open but **not** showing still switches to it (and its own veil still explains the wait); the tab click already had this guard. Pin: with the runtime gone the same click opens again, a second `setActive` on the active tab posts **nothing at all**, and a switch to another OPEN tab still sends `switching` + `switchView`; in the client, re-picking the active row posts no `openSession`, shows no veil, and still collapses the list. Three older tests used `switchTab`/`setActive` on the tab that was already active as a shortcut to "give me a fresh `switchView`": they now open a second tab first, which is what the message they assert on is actually for. The two Stryker surgical ranges moved with their lines (`chat-view.ts:4304-4323`, `view.ts:6639-6658`), both still at **100 %**.

- **The panel is no longer a blank area until the network answers: the first page after a reload is drawn WITHOUT the host-model fetches, with the veil already up.** The case is the one a session in another folder produces every time: `openFolder` reloads the window, the new host starts with an empty model cache, and `buildConfig` awaits `Promise.allSettled` over **every** provider — that is, the slowest one, up to the 5 s abort, which behind a proxy that accepts the connection and then goes quiet becomes the whole wait. Both the `webview.html` assignment and the `switchView` rode on that await, so for seconds the Harny area was **nothing** — not "empty and veiled" — and then everything appeared at once. `refresh()` now tells the **first paint** apart (`painted` stays false until a page has been handed over) and `buildHtml({ firstPaint: true })` passes `fetchHosts: false` to `buildConfig`: the only network waits in that method go away, and the rest (settings, skills, MCP, the limits catalog) is local and unchanged — so the page has its structure, its tabs and its **transcript** immediately, not an empty shell. It is the REAL page, not a second `webview.html`: assigning a page REPLACES the document, and the veil would go away with it. The page says in its own state what it is still missing (`veil`/`veilName`), the client raises `#switch-veil` **before** the `ready` hello (the last useful moment: a `postMessage` sent earlier is dropped), and the `switchView` that answers the hello takes it down; the session name is there when the host already knows it, otherwise it stays "Opening session…". The 0,12 s fade-in delay does the rest: a build that lands quickly never shows the veil at all. The live model lists arrive with the handshake, as before. Pin: with a `fetchModelInfos` that **never settles** the HTML is assigned anyway (a build that awaited it would leave `webview.html` empty and the `waitFor` would time out), with `veil: true` and no models and no errors — no host was asked, so nothing can be red; `ready` delivers the live list; a later `refresh()` is a **full** build and does not raise the veil again (a veil on every rebuild would flash on every setting change). In the client, `veil` in the initial state raises the veil with the given name and the first `switchView` takes it down. The two Stryker surgical ranges moved with their lines (`chat-view.ts:4304-4323`, `view.ts:6639-6658`) instead of being deleted: both stay at **100 %**.

- **The read-only guard no longer lets a substituted command run: `cat <(rm -rf x)` passed as a read.** A process substitution is not a redirect, so no rule looked at it and it travelled inside an argument of a command on the allowlist — while the shell EXECUTES its contents. The four markers that can hide a command (`$(`, the backtick, `>(` and `<(`) now make the segment unsafe, and they live in **one function only** (`hasSubstitution`) called both by the check and by the refusal message: the two halves can no longer diverge, and the refusal says _why_ (reason `substitution`, the offending segment, and the phrase "command substitution" even when the offender is `<(`). `<(` was the missing one, and it is the most insidious of the four because it reads as input — the form a user writes to _read_ something. In the other direction the guard refused a harmless command: `echo x >>/dev/null` read as a write because `>+` **backtracks** — when the sink exemption (`/dev/null`, `2>&1`, `> =`) fails on the second `>`, the engine retries on the first, which is not exempt, and the line lands in the "writes" branch. `>+(?!>)` anchors the check to the **end** of the `>` run, that is, where the sink really begins. Pin: the four markers tried inside read-only commands, the message that names them (and `cat /dev/fd/9`, the harmless sibling, which stays a read because it executes nothing), `echo '$(rm -rf x)'` refused even though the shell would treat it as text — the side to err on is the cautious one —, `>>/dev/null` staying a read while `echo x >> out` stays a write, and the escape inside single quotes; the file's mutation score goes from **77,25 to 92,96 %** (tests 88 → 96, `break` threshold 77 → 92), where the remaining survivors are the redundant guards and the numeric coercions accepted on purpose.

- **At the end of a turn the panel ALWAYS unlocks: the lock cannot outlive the turn that lit it.** Every control in the panel (model gear, MCP, sliders, mode, Loop Guard, tab × and row commands) is switched off by `sessionBusy()`, that is, by `streamingActive || workingIds.has(activeId)` — and `workingIds` is a set the **host** writes, with a `status`. Between the end of the stream and that post there is a window: the terminal message (`done`, `interrupted`, `denied`, `error`) tells the panel that this session has stopped streaming, the Working bar disappears… and the set still lists the session, so everything stays inert until some other message arrives. With the `status` that usually follows right after, the window was invisible; when the post is late, or never comes (the host leaves `onRunFinished` early when the session is no longer the active one), the panel stayed locked with the bar already gone — the symptom "the working ends but nothing unlocks". Now the transition to idle **releases the active session** inside `setStreaming`: it is the only fact that message proves, and it is not a guess about the host — the rest of the set stays as it is, because an "unlock everything" would let you close a session that is still working in the background. The release is one for all terminal messages (the same point where tabs are switched off), and the list rows and the tab × are repainted by the **same** release (`applyWorkingRows`, now used by the `status` handler too instead of being copied there), so no surface is left showing the finished turn. Watch out for the opposite case, which the test pins: the first paint answers `setStreaming(false)` with a set that legitimately lists the session (a run was already in flight when the panel was born), so it releases only a **transition**, not a call. Pin: after `status { active: true, workingIds: ["a"] }` a `done` alone turns the gear, the sliders and Compact back on and re-enables the commands of row `a`; an `interrupted` re-enables `a` and leaves `b` (working in the background) off — with the release mutated both fail.

- **The error bubble's ⎇ tab was black: on a red bubble it was not made of the same material.** The tab has a neutral background (`--surface-2`) that _looks like_ the normal bubble's background — and on every other bubble it reads as a tab cut out of the bubble itself. The error bubble, though, is not `--surface-2`: it carries a 15 % red wash and an `--error` border of its own, so the same grey tab over that red reads as a black piece stuck onto somebody else's bubble. Now the error bubble's tab **inherits** background and border from the bubble (`background-color: inherit`, `border-color: inherit`) instead of repeating the tint: it cannot diverge, and it answers on its own in both themes. For the inheritance to be safe the error bubble's background became **opaque and taken from the palette** (`--error-bg`: the same wash already composed over `--bg`, `#331919` in dark and `#fadfde` on paper, that is, the same pixels as before): the raised tab overlaps the bubble **above** itself, and an inherited alpha would let that bubble show through the tab. The rule is written with `:where()` so that it has **zero specificity** — a normal selector (0,4,0) would have beaten `.branch-at:hover:not(:disabled)` (0,3,0) and would have silently switched off the hover reaction (the tab lighting up orange, as on the other bubbles). The test pins the two declarations, the absence of the full-specificity form, the hover rule that must keep winning, the background taken from the palette (and without `rgba(`) and the role present in **both** themes.

### Changed

- **The mark beside a prompt is now as tall as the bubble's STRAIGHT RUN, not as the bubble.** It used to be measured on the whole height (`8px` of padding on top + `8px` below + one line of text): a logo stretching all the way to the rounded corners, where the corners are not — the bubble is rounded by `8px`, so the vertical part of its border starts 8px lower and ends 8px higher. The mark now takes **exactly that measurement**: `top: 8px` (the radius, which is also the bubble's padding) and `height: 1.4em`, that is, **one line of text** — smaller than before, and yet centred on a one-line bubble by construction, not by compensation. The width follows the file's proportion (15:11) and the reserved column — the bubble's margin and the `max-width` cap — narrows with it, with the same expression: `calc(1.4em * 15 / 11 + 6px)`. The mark stays **aligned to the FIRST line** even on a four-line prompt, because it starts where the line box starts, not where the bubble starts. The assertions in `src/chat/view-html.test.ts` pin the new measurement, including a `not.toMatch` that fails the test if anyone brings the `16px` of padding back into the mark's measurement.
- **The bubble goes back to the orange it was; the mark does NOT — it keeps its original tan.** The two were tied together (the logo chased the bubble's colour), and the tie turned out to be wrong in its direction: the bubble is the panel's **accent**, the mark is the **brand**, and the mark must not become a smaller copy of the bubble nor lose the colour it has always had. So `PALETTES.dark["user-msg"]` is **`#d95f27`** again (and `#b8531d` in the light theme), that is, exactly as it was before, and with it come back the contrast of the white text (**3,74:1** instead of 2,86:1) and the unity of the accent family — buttons, links, active borders and bubble again **the same orange**. The two brand files stay at the tan **`#d08856`**, the midpoint of the gradient the logo has always been drawn with, now flat: the drawing does not change, only the paint stopped being a document (no `linearGradient`, no `id`), and the marketplace PNG is still redrawn in that colour. **The two hex values are pinned separately** in `src/chat/icons.test.ts` — the mark against `#d08856`, the bubble against `#d95f27`, plus an `expect(brand).not.toBe(userMsg)` that is the line preventing the tie from coming back: if someone puts the logo back on the palette, or the palette back on the logo, the test says so instead of letting the mark drift.
- **The logo GOES BACK to its original colour — the tan — and the prompt bubble follows it, instead of the mark chasing the bubble.** The gradient the logo has always been drawn with (`#DB9462` → `#C67B49`, lit from the top left) becomes **one flat colour, `#d08856`**, which is its **midpoint**: one value only, because a bubble is a flat surface and cannot carry a gradient, and two slightly different tans would read as two mistakes. That literal is written in **both** places — the two brand files (`media/icons/harny.svg`, `harny-app.svg`) and the `user-msg` palette entry — so the signature beside a prompt and the bubble that signs are **the same colour**, not two neighbours; the literal `fill`/`stroke` stays (never `var()`): the files are also rendered on their own, and a variable that does not resolve paints **black**. In the light theme the bubble drops to **`#c67b49`**, that is, the dark end of the same gradient: on paper the mid tan loses the weight it needs, and it is the same rule the light palette already followed (a bubble one shade deeper). **`harny.png` was redrawn** in the same colour (256×256, alpha, derived from the square frame as before). **A number to watch**: white on `#d08856` sits at **2,86:1** (it was 3,74:1 with the burnt orange) and on `#c67b49` at **3,32:1** (it was 4,89:1) — the prompt's text stays white, so the bubble is now less contrasted than before; if that bothers you the two roads are dark ink on the bubble (the pairing the mark itself draws: black caret on tan) or a deeper tan, and it is one line in `view-config.ts`. The tests follow: `icons.test.ts` keeps comparing the colour of the two files with `PALETTES.dark["user-msg"]`, which is what makes this choice verifiable instead of decorative.
- **The panel's mark was an INVALID XML file, and nothing noticed: now every icon is PARSED.** Explaining the brand's new colour, the long comment in `media/icons/harny.svg` ended up containing the custom property's name — two dashes in a row (`--user-msg`) — and **an XML comment cannot contain them**: the file was invalid, and the symptom was not an error but an **empty rectangle** where the mark should have been (activity bar, hero, contact sheet, marketplace listing). No step could see it: the artwork travels as **text** (esbuild `loader: .svg: text`), so no compiler reads it, and the tests asserted on a **string** — which stays perfectly valid even when the document is not. Now `src/chat/icons.test.ts` does the opposite of what it did before: it **parses every file in `media/icons/`** with a real XML parser (jsdom's `image/svg+xml` mode, the one that throws instead of recovering as HTML would) and additionally rejects a `--` inside a comment outright, with a message that names the cause — because "invalid token" points at a line in the middle of the prose and tells nobody that the offender is a dash. The drawing has not changed by a pixel: only the notes.
- **Harny's mark is made of the SAME orange as the bubble: `#d95f27`, that is `--user-msg` — no longer a gradient of its own.** The signature on every prompt was born with a brand gradient (`#DB9462` → `#C67B49`), a warm brown that next to the orange bubble read as what it was: an **almost**. The mark that signs a prompt must be made of the prompt's own paint, so it takes the bubble's colour (`PALETTES.dark["user-msg"]`) and carries it **literally**, not as `var(--user-msg)`: the file is also rendered as a document of its own — the contact sheet loads it as an `<img>` and it is the base of the marketplace PNG — where no panel variable exists, and a `var()` that does not resolve paints **black**, which is the one outcome worse than an almost. The value is pinned **against the palette** (`src/chat/icons.test.ts` reads `PALETTES.dark["user-msg"]` and compares it with the `fill` and the `stroke` of the two brand files), so the day the bubble moves the test says the mark did not follow it, instead of letting it drift; the `harny-app.svg` box stays square and in the same drawing, and the drift test compares the paint of the two frames. With the gradient goes **the last exception** to `media/icons/`'s rule "no `id`, no gradients", and not because the rule was softened: a file that nothing outside it can resolve (preview, `<img>`, PNG) must not depend on something defined inside itself, and the paint is now a colour. Two declared differences remain: in the light theme the bubble is one shade deeper (`#b8531d`) and a single file cannot follow the theme — the brand keeps its tint, as `harny-app.svg` does — and the mark stays **the only file with a literal paint** instead of `currentColor`, because it is a figure and not a glyph. **`harny.png` was redrawn** from the same drawing: 256×256 with an alpha channel, derived from the square frame (path flattened and filled with the **even-odd** rule, which is what digs the prompt's caret into the bubble, the caret traced with round caps) sampled 8× and reduced — there is no rasteriser in the toolchain (no `sharp`, no `resvg`) and both Quick Look and headless Chrome refused the job, so the PNG is drawn from the file's geometry instead of from a screenshot of it: two files, one drawing, and the folder's README now says so (with the PNG's provenance) instead of leaving it to whoever has to regenerate it.
- **A Queued/Steer bubble is always WHOLE: the row fold no longer exists.** The `›` that opened and closed the message has been **removed**, not hidden: no chevron, no `text-collapsed` state, no `max-height` and no `mask-image`, and no measurement — `pending-fold.ts` (`needsCollapseControl`), its `ResizeObserver` and the re-measure on every resize were deleted together with the button, because a row that does not close has nothing to measure, nothing to re-tune and no state to keep in agreement with the DOM. The reason is what the use case has said all along: what you write while the agent works is an order or a correction, not a document, and the clamp paid a chevron on **every** row (12px of ink in front, plus a second one after the pill in the first version) to hide two lines that were usually already there. **One** fold remains, the one that is needed: the section header, because a long queue is the only thing that can eat the transcript — and the section is what scrolls. Instead of the fold the row opens with the **mode's mark**, exactly where a tool call carries its icon. Cleanups that follow, all together: `.pending-actions button:not(.pending-toggle)` loses the `:not` (the two commands are now the row's only buttons, so the shield that defended them from the fold defends nothing any more), **Collapse all** no longer counts pending bubbles (`openCount`/`collapseAll` leave the section's interface: there is nothing to close, and the tab speaks only about transcript sections), and the two keys `pending.expand`/`pending.collapse` leave the catalog — the tip contract forbids orphan entries. Pin: the row has no `.pending-toggle` at all and is not born `text-collapsed` (not even where a measurement would say "two lines", because nobody measures any more), the mark is the first child and the order mark→pill→text→commands is fixed, and the sheet no longer contains `pending-toggle`, `text-collapsed`, `fold-off` or `mask-image`: the test pins the **absence**, so the machinery cannot come back one element at a time. The webview's Stryker window moved with the file (`view.ts:6585-6604`).

- **The parallel sub-agent scale reads from less to more: `1..99` of cap, and the notch at the top (100) means "no limit".** The scale used to be `0..100` with `0` = no cap, that is, the most permissive value at the point where a slider says "the minimum": the notch next to `1` (the most restrictive cap there is) was the absence of a cap. A slider reads left to right as "less → more", so the sentinel belongs **at the end**: `const PARALLEL_MAX = 99` and `PARALLEL_NO_LIMIT = PARALLEL_MAX + 1` as the track POSITION (`min="1" max="100"`), translated into `0` in one place only (`capFromTrack`) — `0` stays the wire's word, not a number on the scale. The sentinel is not a cap: `renderParallel` gives it `aria-valuetext="No limit"`, because read as written it would announce "101 sub-agents". The box's domain is now `1..99` (`bounds.min` = 1) and the number scale is what it is: **a typed `0` is a number and lands on the first notch**, it is no longer the only way to write "no limit" — which has its two doors, the empty box (placeholder `∞`, `empty: 0`) and the track's last position, and the two always show the same state because the thumb parks there even when the `0` comes from the config. The default stays **4** (absent ≠ unlimited) and the orange fill follows the thumb, not the cap's arithmetic: 40 is 39 % of the track and 100 is not the end. `syncRangeFills` does not change — it is the general formula, and that is why the fill's test had to move, not the code. The tooltip (`param.parallel`) says the three things together: default 4, up to 99, last notch or empty box = no limit.
- **Every explanation in the panel is a catalog key, not a sentence in a `title`: one machinery (`data-tip` + `setTip`) and a contract that defends it.** The OS tooltip was where the copy went to die: it cannot be translated, cannot be styled, arrives after a second of waiting and cannot be shown on a `disabled` control — which is exactly the control that most needs to explain itself (a gear switched off while a run is working). The panel now writes **keys**: the markup (`src/chat/view-html.ts`) carries `data-tip="mode.analyze"` and the like, the `view` (`src/chat/webview/view.ts`, `mcp-card.ts`, `mcp-tools-popover.ts`, `pending-section.ts`) uses `setTip(el, key, args)` for everything that depends on state, and the words live in **`src/i18n/en.help.json`** (149 cards + 12 labels). `installTips()` resolves key and arguments (`data-tip-args`, URL-encoded) into **one card** per document: `aria-describedby` on the control, a bubble with `role="tooltip"`, `position: fixed` so that no `overflow: hidden` can clip it, and opening on `focus-visible` too — so it is reachable from the keyboard, which a `title` never was. What stays in a `title` is **data**: a path, a session name, a size, a tool's description. A value is not an explanation and must not be translated. The lock reasons are keys as well (`locked.gear`, `locked.mcp`, `mode.lockedRun`, `mode.locked`): a switched-off gear can no longer stay mute, because the card lives on the element and not on the browser's tooltip. The card belongs to the parameter's **title**, not to the slider under it: the markup puts `data-tip` on the parameter labels (`param.ctxWindow`, `param.outputTokens`, `param.presence`, `param.parallel`, `param.sensitivity`, …) and the CSS lights that name up when the pointer is on the field (`.field:hover > .field-label[data-tip]`, the gesture the Loop Guard fields already made on their own). The dotted underline on hover is gone: it read as a link and made the whole panel shake on every movement. The cursor is decided by `tips.ts` and nobody else: when an element receives a card, the module looks at what the element IS — a value, a title, a metric ask for one (`cursor: help`), a button, a label with a radio inside, a clickable row keep their own cursor (the computed style's `pointer` counts as a control, so a session name does not dress up as a question). Decided once, where the card attaches: the token values (`200000`, `8000`, the sampler slider's number that follows the radio, every `.lg-value`) have the same card as their title, instead of being the one mute spot. **`src/chat/tips-contract.test.ts`** (18 tests) keeps the two halves aligned in both directions: every `data-tip` and every key passed to `setTip` must resolve, no orphan entry in the catalog, the `{placeholder}`s must be the ones the view really provides, the Loop Guard fields' labels must fit in 10px and must not repeat inside the card, no element may carry both `title` and `data-tip`, and — the rule that cleaned up the tail — **no webview module writes prose into a `title`**, not even when the sentence comes from a local variable (`const why = cond ? "…" : "…"; el.title = why;`, the way the last ones had survived the first scan). And the explanations have a switch: **Interactive help**, on the Sessions row before the `+`, because it is about the PANEL and not about the list underneath. Switched on, every control explains itself as before; switched off — and that is the **default** — the panel says nothing: no card, no question mark, no name lighting up under the pointer, and the only element still answering is the switch itself (`data-tip-always`): a mute switch would be a trap with no way back. The explanation nobody asked for is noise on a surface this dense: the panel teaches when it is asked, not as soon as the mouse passes by. The switch **writes nothing to disk** — no entry in `settings.json`, no `setState` — but it does not live in the page either: VS Code destroys the page every time the panel is hidden, so a flag kept there would forget the answer on the next reopening, which is exactly what makes a switch look broken. The state lives in the **process's memory** (`interactiveHelp` in `ChatViewProvider`), comes back to the new page inside the `init` the panel already receives and disappears on a window reload: the life of this run, not a preference to be kept. The filter lives in TWO places that cannot diverge — `tips.ts` refuses the card (`mayExplain`, both from the pointer and from the keyboard) and the CSS closes every cursor and every label behind `body.help-on` — because a per-element rule does not cover what is born afterwards. The last Restricted Mode card is pinned against the host's hint (`mode.untrusted` = `untrustedModeHint()`), because two copies of the same sentence that diverge say two different things about the same folder. The last sentence that lived outside the catalog is a key too: the two sliders of the "Model limits unknown" alert explained their own range with `AlertField.hint`, prose built by the host and pushed into a system `title` (`Detected for this model: 128000 tokens…`) — the only place where the tip scan could not see it. Now `AlertField` carries `hintKey` + `hintArgs`: the number stays the host's (it is the only one that talks to the provider), the words are the catalog's (`alert.detected` shared by the two fields because it is the same sentence, `alert.ctxUnknown` and `alert.outUnknown` kept apart because a context window and an output cap are unknown for different reasons). Two new pins: the contract refuses a returning `hint?:` on the interface and checks that every key sent by the host exists and receives its own `{tokens}`; the view's test resolves the cards on BOTH controls of every field (slider and box are one control) and checks that none carries a `title` any more. The card lives `position: fixed` with `z-index: 120`, **above the whole scale of modals** (50 providers/MCP, 60 sessions, 70 model/vacuum, 100 compaction, 110 alert): `data-tip` also sits on controls INSIDE modals, and a card under a modal's veil is not "a little behind" — it is an explanation that does not exist on screen, while the old system `title` worked everywhere. The pin is not the number but the invariant: the test reads the `z-index` of every surface from the sheet and fails if one appears that would cover the card (with 60 it fails on `compact-settings-modal`), and it checks `pointer-events: none`, so the card floating over a modal does not steal a click from it. The webview's Stryker window moved with the file (the five anchors of the `textDelta` case: the exact lines are in `stryker/webview.conf.json`, the only place that can say it without going stale) and measures **100 %** on 10 mutants against a 90 threshold — the window stops at `settleThinkingBlock()` because the `if (resultEl)` that follows is a guard dead by construction (`ensureResult()` never returns `null`): mutating it crashes the test runner instead of killing a test, and an equivalent mutant must not be hidden behind an error.
- **The mode is called like the button that produces it: `Queue`, not `Queued` — and the badge's pill and the "Insert prompt in …" pill are the SAME pill, so they have the same width.** "Queued" was a participle: it described the state of a message you had already stopped writing, while the labels that CONVERT said `→ Queue` and the footer's hint had said `Queue` all along — three names for one thing twenty pixels apart. Now the name is one (`Queue`, `Steer`: badge, the header's counts `Steer (1) · Queue (2)`, the `→ Queue` button) and upper case is only the CSS's rendering. The width is **measured, not guessed**: the pill is a grid with ONE cell and a hidden sizer (`visibility: hidden`, `aria-hidden`) holding **both** labels stacked in its own cell, so it reports the wider of the two — in any font, at any zoom, with no number to keep aligned and with no way for converting a message to change its measurement (the text does not slide under the pointer). The same recipe is stitched onto the two selectors (`.pending-badge` and `#insert-hint-word`: same padding, same `letter-spacing`, same weight, same `text-transform`, same `font-size`), and it is this — not a shared constant — that makes the two boxes identical on screen: a local copy of the declarations in either place breaks the test. The sizer is **double** because `Queue` and `Steer` are not equally wide in a proportional font, and measuring only one would have tied the width to the current mode. The **same measure line is on the button that CONVERTS** — `→ Queue` on a steer bubble, `→ Steer` on a queued one: without it, each was as wide as its own words, so the commands of the two rows did not line up in a column and converting a message widened the button under the pointer; now it is `inline-grid` with the same double sizer, and in **upper case** like the badge (`→ QUEUE`, `→ STEER`), because the two pills of a row must read as one family instead of a label and a sentence. The only differences left are per-site and concern the **height** (a bubble's line box against the footer's 18px strip). Pin: the sizer holds `["Queue", "Steer"]` on both sides, the visible label is the mode's, the shared recipe is one and the footer's pill inherits padding, `letter-spacing`, `font-size` and `display: inline-grid` from it.

## [1.0.3] - 2026-11-09

### Changed

- **A session that already lives in this folder opens with ONE click — and the picker stays next to it, as its own gesture.** The `this folder` row of All sessions offered `Change folder & open…` as its only action, so opening a session of the current folder began by choosing a folder: the same one. That was read as a wasted round trip, but the trip was not wasted — it is the only way to take a session to ANOTHER folder from inside its own, and it had simply been glued to the wrong gesture. The rule in `src/chat/webview/session-folder.ts` now answers THREE cases instead of two: `open` (a usable folder that is not this window's — open it there, the window switches first), `here` (the session already points at this folder — open it here, no reload, nothing to survive) and `pick` (no folder stored, or the folder is gone — the picker repairs the pointer and the session opens where it now points). The `here` row keeps both buttons: `Open session` as the primary and `Open elsewhere…` beside it, which is the same picker as before (`sessionsManagerChangeFolder`, the pointer moves, the transcript stays where it is, and the session opens there). Not "Move…": nothing is relocated on disk. `open` and `pick` rows are unchanged — one button each — and the home list keeps its single `Open session`. The form also STEPS ASIDE when the open is launched: `openSessionAt` posts `sessionsManagerClose` (the page closes the form only if it is up, so the home list — same open, no form — is untouched), and the post sits BEHIND the open rather than at the click, because that is the only point that knows the gesture went through: a cancelled `Open elsewhere…` picker never reaches it and leaves the list where it is, for a second attempt. Both Stryker hunks moved with their files (`view.ts:6335-6370`, `chat-view.ts:4215-4234`) and kept their anchors, so the floors still cover the statements they were measured on (96 % against a floor of 90). Pinned in `session-folder.test.ts` (three cases, both labels, the second gesture offered on `here` only), `view.test.ts` (the `this folder` row sends `sessionsManagerOpenFolder`, `Open elsewhere…` sends `sessionsManagerChangeFolder`, no second button elsewhere) and `chat-view.test.ts` (that open resumes the session here: no picker, no reload, no marker, the session really is open, and the form is told to close — while a cancelled picker posts nothing).

## [1.0.2] - 2026-11-09

### Changed

- **A session is opened, not its folder — so the buttons say `Open session` and `Change folder & open…`, and the second one now finishes the job.** The row actions were named after their MECHANISM: `Open folder` in fact switched the workspace and then opened the session (a reload, `PendingOpens`, the session there when the window came back), which read as if the folder were the point; `Change folder…` only re-pointed the pointer and opened nothing, so on a session whose folder was gone or unset — the one case where the picker is the ONLY way back in — the user had to click a second time, on a row that had just been re-pointed for them. Both are fixed in one place: `openSessionAt(id, folder)` decides between "open it here" (the `isCurrent` shortcut, no reload, no marker) and "switch the window first", and `changeSessionFolder` now ends with it, so the picker is a DETOUR and never a separate errand (cancelling the picker still changes nothing). The labels follow the outcome (`src/chat/webview/session-folder.ts`, one rule for both surfaces — the home list and the All-sessions form), the pre-picker notice says "Pick a new one. The session opens there." instead of leaving the reload to surprise, and the form's hint no longer tells the user to "open that folder in VS Code". Pinned: a pick that lands on ANOTHER folder opens it there, a pick that lands on THIS folder opens it here with no reload and no `remember` debris, and a broken-folder `Open session` still falls back to the picker and then opens what it re-pointed.

### Fixed

- **A compaction no longer eats the message you sent while it was summarizing — five concurrency holes, each closed where it happens.** `working` ("THE definition" of busy: the tab lock, the session rows, the manager, the switch payload) deliberately left the compaction out, on the reasoning that blocking the next message on a summarisation would be a bad trade. It was not a trade: `performCompaction` rebuilds the transcript from the snapshot it took BEFORE the summarizer call, so a message appended during those seconds was rebuilt away — silently, from disk and from the model's window, together with the reply already streaming. A compaction is now part of `working`, and it is **cancellable**: `SessionAbortPort.cancelCompaction` is wired through `abort` (the panel shows Stop for exactly that state, so a Stop that did nothing was a button that lied) and a parked message is delivered right after (`engine.resume`, for the compactions that are not the tail of a send — the manual Compact button). The queue drain reads `engine.working` instead of guessing. Second, the invariant that makes the rebuild safe is now checked instead of assumed: `performCompaction` compares the history it is about to overwrite with the snapshot it planned from (`appendedSince`, by IDENTITY), and when messages arrived meanwhile it **abandons** the compaction (`false`, one log line) rather than rewriting over them — and the host's own `AbortController` per session is tracked in `compactionAborts`, so an abort from the panel reaches the summary that is actually running. Third, the third-party writes are no longer read-then-write: `rename` became `upsertName` (an `UPDATE` of name/`updated_at`/`message_count`, the row created only when `changes === 0`) and `saveSettings` `UPDATE`s only the columns in the patch (`SETTING_COLUMNS` + `settingAssignments`), so two windows — one renaming, one tweaking a slider — can no longer clobber each other's row, and `revision` is never touched by a settings write. Fourth, `deleteSession` re-checks `isWorking` AFTER its confirmation modal (a run started while the dialog was open), and re-reads the transcript it is about to delete instead of using the one it looked at before the dialog. Fifth, the posts that carry a session now say WHICH one (`compactStart`, `compactDone`, `interrupted` and the rest joined the ones that already did): the page already filters on that, and a message without it can land on the wrong tab — the "session opened from another folder shows an empty log" shape of bug. Bonus, same class: a refresh that was superseded while `buildHtml` ran no longer installs its stale HTML (`refreshSeq`). Pinned with a test per hole — `session-engine.test.ts` (busy while compacting, Stop cancels the compaction, `resume` delivers), `pending-input-queue.test.ts` (nothing drains under a compaction), `panel-modal-queue.test.ts` (a rebuild re-shows the modal on the new page — see below), `chat-view.test.ts` (a message that arrives during the summary survives it; a superseded build is dropped), `sqlite-session-store.concurrency.test.ts` (two real connections: rename-then-settings keeps both, `revision` untouched).
- **A modal that was queued before the page was listening no longer freezes the panel.** `post` writes into a DOCUMENT: a request posted while the HTML had just been assigned and the script was not running yet fell on the floor, so no answer ever came back — the promise stayed pending, `hasPending()` stayed true, every later `refresh()` deferred behind a dialog nobody had seen, and the stall guard gave up two minutes later. The queue now separates "queued" from "ON SCREEN": `flush()` shows the head on the document that says hello (`ready`), `pageReplaced()` forgets that a modal is on screen when a rebuild wipes the DOM (the answer stays open — the same question is simply asked again on the new page), and a refresh defers behind `hasShown()` rather than `hasPending()`, because a request that has not been delivered yet is not in any document, and the rebuild is precisely what brings the page that will show it.

## [1.0.1] - 2026-11-09

### Fixed

- **A session opened during a folder change no longer comes up with an EMPTY transcript.** Field report: opening a session that lives in _another_ folder switches the window to it, and the session that opened is then there with its tab — and no messages; closing the view and reopening it brings them back. Two half-failures added up to that, and each one alone is invisible. First, the page could be BUILT before the session was active: the gesture is finished by `resumeSession` as soon as the view OBJECT exists, and `buildHtml` runs before `setActive` completes, so the HTML on screen was drawn from the previous state. Second — and this is the half that kept it empty — the message that would have corrected it was **dropped**: `webview.html = …` only _starts loading a document_, and VS Code delivers a `postMessage` to a document, not to a queue, so the `switchView` carrying the messages landed nowhere and nothing sent it again. The fix is a handshake rather than a retry: the page's script says `{ type: "ready" }` as its **last** statement (`webview/view.ts`, after every listener it registered), and the host answers by re-sending the WHOLE current state — `postSwitchView(true)`, with the session list too, since the HTML may have been built before the opened session became visible in it. Because the answer is built from the truth at that moment and not from a snapshot, it also reconciles the opposite order of events (a page that comes up while the open is still in flight simply receives the `switchView` the open itself posts afterwards), one message per page load, no timers, no retries, nothing to leak. Two deliberate non-changes: `runWhenReady` still runs an action as soon as `this.view` exists — the early drain is the **fallback** for a page that never says hello (an old cached bundle is served cache-busted, but a drain that waits for a message that never comes would freeze the gesture instead of blanking a transcript) — and `refresh()` keeps draining after the HTML is handed over. Pinned in three places, each one checked to fail without the fix: the reported sequence end to end (`resolveWebviewView` → `resumeSession` → `ready` → the **last** `switchView` carries the session's messages, `chat-view.test.ts`), the answer including the session list (a `false` there is the tab-click shape and leaves a row missing), and the client actually sending the hello exactly once (`webview/view.test.ts`). The Stryker hunk moved with the file and the bundle is rebuilt.

## [1.0.0] - 2026-11-02

**The version catches up with how Harny ships.** What changes here is the
promise attached to the number. A VS Code extension **auto-updates** — publishing _is_ the update
mechanism (`docs/RELEASE.md`) — so the pre-1.0 freedom to break things "between
minor versions" was never real: a `0.9 → 0.10` break would have reached every
installed user in silence. `1.0.0` does not claim the code is finished, it
claims the opposite and more useful thing: **fixes stay fixes, minors only add,
and a break is a major**. The half of that contract that costs real work was
already built — the schema is versioned through `PRAGMA user_version` with
tested migrations and golden rules (`docs/MIGRATIONS.md`) — and the half that
was missing, the rules for the other public surfaces (settings keys, the
`config.json` shape, command ids, session folders), is now written down in
the same place the number lives.

### Added

- **A damaged session is SALVAGED instead of being unopenable — and the new module is a mutation floor.** Durability was already there and is free: every write is ONE transaction (`BEGIN` … `COMMIT`, `ROLLBACK` on any error), so a process killed between two statements finds the previous state byte for byte, and `sqlite-session-store.test.ts` pins it by killing a save mid-loop and re-opening the **file**. What a transaction cannot prevent is damage to a row that is already committed — a rotted disk block, a hand-edited database, a row written by a build that stored another shape — and the old `load()` had exactly one answer to it: `JSON.parse` throws, the session cannot be OPENED at all, and one bad row costs the whole conversation. `src/core/sessions/session-recovery.ts` is the other answer, in two cases it keeps apart. **`unreadable`**: the first row that does not parse (or parses to something that is not a message) ends the log — that row and everything after it are dropped, and the head is kept, because a log damaged half-way is worth the part before the damage (`seq` stays a contiguous prefix, which the append path relies on; a hole would leave pairs broken on both sides of it). **`invalid_tail`**: rows that parse but make a conversation the provider REFUSES — an assistant turn whose results are missing, a tool result whose call is gone. `conversationFaults` decides, the same oracle the request builder consults before the wire, so the salvage cannot disagree with the refusal; only the STRUCTURAL faults are cut, never a content one (an empty tool result is a refusal already named to the user, and cutting a whole turn of real work for it would be worse than the refusal). Two decisions are worth reading before changing anything: the cut lands on the damaged **message**, not on the whole turn, so the common case (an answer truncated by a crash) keeps the user's PROMPT and leaves a conversation waiting for its answer instead of deleting what they typed; and `unreadable` is still the reason reported when the salvaged head also dangles — it is the root cause, and the head is trimmed anyway, because a salvage that hands back a conversation the provider refuses is a session that opens and then refuses every request. Nothing is ever written back from here: the trim lives in memory for the load (`LoadedSession.repaired`), and the next ordinary save rewrites the stored rows because the prefix guard sees the shorter history — the repair PERSISTS without this module issuing a destructive statement on a file it just found damaged. On the panel side `SessionRuntime.recovered` is one-shot: the first open after a salvage posts an info alert naming how many messages went and why, and opening the same session again is silent. Twenty-one unit tests plus forty store tests hold it (2508 in the suite), each checked against a mutant; 56 mutants of the module were measured and **`npm run mutate:session-recovery` fails below 98 %** (55 killed, 0 uncovered, 1 named equivalent: `catch {}` around `JSON.parse` falls through to the same `isMessage` rejection, so no test can tell the two apart). Two side effects of being honest about soundness: the store's perf fixture built its 300 "heavy" rows as assistant steps followed by orphan tool results, which after this change measured a **one**-message session and called it 300, and the `chat-panel` hunk had slid eight lines past its own anchors (the range check in `ratchet-anchors.test.ts` is what made it loud) — it is now `chat-view.ts:4011-4025`, measured again at 100 %.
- **Two windows on one database no longer delete each other's turns.** One machine, two VS Code windows, ONE `<home>/sessions.db`: each window is an extension host with its own connection, and each keeps the transcript it loaded. The store protects writes with a prefix guard (the stored rows must still be the head of the array it is handed), but that guard is a **comparison, not a compare-and-swap**: the rows it consults are read OUTSIDE the transaction, and it only asks whether `seq` runs `0…storedCount-1`. A window that never saw the other's append therefore passes it, reaches the `replace` branch, and `DELETE FROM messages` removes turns it had never read — no error, no warning, and the losing conversation is simply gone. The fix makes the race _detectable_ instead of undetectable: `sessions.revision` (migration 5, additive) is bumped **inside the same transaction that writes the messages**, handed back with the summary on every read and write, and sent back by the next save. `PersistentChatHistory` carries it (`adopt` on load, the store's answer after each save — never `revision + 1`, only the transaction knows) and a save whose token no longer matches is **refused** with a `SessionConflictError` before a single row is touched, leaving the other window's transcript intact. Three decisions are worth reading before changing anything. First, a refusal is **never retried**: retrying with the new token would `replace` exactly what the refusal just protected, so the history **blocks** — the messages stay on screen (nothing is silently dropped), later saves are no-ops, and the block is released only by `adopt`, i.e. by reopening the session from disk, which the panel's one-shot alert spells out. Second, only a `SessionConflictError` is swallowed: a `SQLITE_BUSY` keeps travelling, because a retryable lock is not a lost session and hiding it would hide a disk problem behind a concurrency story. Third, the token is bumped by `saveMessages` **alone** — a rename or a settings write changes no message, and a false conflict is a save the user never asked to lose. The panel's four REBUILDS (✂ cut, rewind/empty, compaction, window trim) are the destructive writes and used to call the store directly with `{ replace: true }` and no token at all; they go through `PersistentChatHistory.rebuild`, the only writer that can combine `replace` with the token, so `SessionRuntime.history` is typed as the concrete history (a `ChatHistory`-typed field could not have carried it). Pinned where it happens: `sqlite-session-store.concurrency.test.ts` uses **two real connections on a real file** — the stale save is refused _and_ the other window's turn is still on disk afterwards — and a **second real process** (a child holding the write lock) for the lock itself; sixteen tests in total, each checked against a mutant.

### Fixed

- **A session's `updated` date follows the session while it runs.** Field report: _"the list keeps saying the session was updated hours ago, even though I have been working in it all afternoon."_ The store was never the problem — `saveMessages` bumps `updatedAt` on every write — but the panel is only told about the list when the VIEW changes (a tab switch, a rename, a rebuild), so the row of a session you were actively using froze at whatever it said when the panel was last drawn, and opening the All-sessions form was what finally corrected it. The tempting fix is to re-send and re-render the whole list, which is the wrong one twice over: the list is a `SELECT *` over the session table and one turn writes several times (the user message, then one write per committed tool batch), and re-rendering the rows rebuilds the action buttons under the pointer, which flash. So a write now produces a **row patch**: `PersistentChatHistory` gained the one hook a save has (`onSaved`, called with the summary the store just returned, so nothing re-reads the row), the registry hands every history a listener that reads it **lazily** — a runtime spawned before the panel exists still reports, and one spawned after does too — and the panel (`noteSessionActivity`) coalesces a burst into ONE `sessionMeta` message (200 ms, last value wins per session) that the view applies by patching the two dates **in place** in `.srow[data-id] .smeta`, text and tooltip. Two deliberate non-changes: the rows are **not re-sorted** (`updatedAt` is the list's sort key, but moving rows under a reading user because a background session committed is worse than a stale order — the next real render sorts), and the All-sessions form is **not patched** at all, since it reads the list it needs when it opens. The listener is registered by the panel in its OWN constructor (`registry.observeHistoryWrites`) rather than as an optional dependency of the composition root: an optional dep is still a valid object without it, so that wiring could have been dropped in silence. Pinned layer by layer — seven tests, each checked against a mutant: a real write travelling `registry → history → store → provider → message` (`chat-view.test.ts`), the second burst after the window posting again, the hook on BOTH ways a runtime is born plus a LATE registration, and the client patching the same DOM node in place, ignoring an id it does not know and leaving the form alone (`webview/view.test.ts`) — and the seam itself, which no unit test can see (the message name, the shape of `meta`, the `.srow[data-id] .smeta` selector), is driven end to end over the REAL page in the new `session-list-dates.integration.test.ts`. The Stryker hunk moved with the file and the bundle is rebuilt.
- **`npm run mutate:*` runs again — and the two floors it could no longer see.** Every mutation run died before a single mutant: this repo compiles with **TypeScript 7** (the native port), whose JavaScript API is down to two exports, and Stryker's sandbox preprocessor reads `tsconfig.json` through `ts.parseConfigFileTextToJson`. `tsconfigFile` is read by that preprocessor and by nothing else (no type-checking plugin here), and the preprocessor skips silently when the file is not in the sandbox — so every `stryker/*.conf.json` now points it at a path no file has. That is safe only while the rewrite is a no-op, which is exactly what `src/mutation-config.test.ts` pins from three sides: the API is still absent (if it comes back, delete the workaround, not the test), our tsconfig still has no `extends`/`references` to rewrite, and every config carries the setting — one born without it crashes on its first sandbox. Measuring again found what the silence had hidden, and both hunks are now above their floors: `chat-view.ts` sat at 75% against 80, `view.ts` at 89.29 against 90. Killed with tests, each checked against its mutant: the skills payload of a re-render (spread in, so an empty object silently dropped it), a compaction that must still report **success** with no panel resolved (`this.view?.` mutated away threw, and the throw was swallowed by the compaction's own catch as "overflow compaction failed"), and a text chunk arriving with no running turn (dropped, not `push(null, …)`, which paints into nothing). One survivor was **removed instead of tested**: `if (currentThinkingBlock) settleThinkingBlock();` repeated the function's own first line, so `if (true)` could not be distinguished from it — the guard is gone, the intent stays in the comment. 96% and 100% now, with the range moved to `view.ts:6321-6356` and its anchor kept. The third red floor, `compactor` at 82.12% against 83, was older than this work — the file had changed after the floor was measured (`d8e7ac0`) — and is now **90.36%**, with the floor moved to 90 where the measurement actually is. It was not a floor to lower: the plans, the rebuilt histories and the numbers were all pinned, and what no test pinned were the **decisions** in between — the `<=` that says a two-message view is never compacted, the walk that must stop inside the budget, `at - activeStart - 2` that counts only the messages that actually left the window (a mutant with `+` was invisible until a test carried a checkpoint in the middle of a history instead of at index 0), a `?? ""` over a message that lost its content, a `trim()` that keeps a whitespace-only summary from being carried as state, and the ratio (not a guess) the summarizer's input is solved from. 56 mutants remain and are stated as equivalent rather than left as debt: `Number(v)` on a value that is already a number, `?.` on what the types guarantee, `m[1].trim()` on a group the regex already trimmed.
- **A second window's write waited instead of vanishing, and a second window's activation no longer re-runs the migrations.** `node:sqlite`'s `DatabaseSync` defaults `busy_timeout` to **0**, so the instant one host is mid-transaction the other throws `database is locked` on its first statement: `PersistentChatHistory.persist()` had no `try`/`catch`, so that throw rose through the turn's commit and the write was lost in silence — measured, not assumed: with `{ timeout: 1500 }` the same write waits 1583 ms and succeeds. The connection now sets `PRAGMA busy_timeout = 5000` before anything else (before the migrations, which is the case that mattered most: two windows restored at launch used to make the LOSER of that race die inside activation). Waiting cannot self-deadlock here — the two connections are in different processes. Second half of the same race: the write transactions are now `BEGIN IMMEDIATE` instead of the default `DEFERRED`, so the decision they make (append or replace) is made against a database nobody else can move; with DEFERRED the reads ran unlocked and the later upgrade to a writer could fail on `SQLITE_BUSY_SNAPSHOT`, i.e. _after_ the decision. `applyMigrations` gets the same treatment **and re-reads `user_version` inside the lock**: the loser of a concurrent activation now finds nothing to do instead of failing on `table already exists`. The pragma is asserted and the wait is measured (a child process holds the lock for 400 ms; the save waits >200 ms and lands), and with `busyTimeoutMs: 0` the same write fails fast and writes **nothing** — the lock is taken before the first row, so a busy database can never leave a half-rewritten transcript behind.

### Changed

- **Opening the sessions list re-evaluates its order.** The list is ranked by `updatedAt`, most recently touched first — but only when it is _read_ from the store: a live write patches the affected row's two dates **without moving the row** (deliberate, see `1.0.0`: re-sorting under a pointer that is about to click a row is worse than a stale order). The consequence was that a list left open, or one whose section you simply reopened, could be ranked by dates that had already changed — the row saying "updated 2 minutes ago" sat below one saying "updated 3 hours ago". Opening the section is now that "next real render": it posts `{ type: "refreshSessions" }` and the host answers with a fresh `sessionsForView()` — one `SELECT *`, **not** a `switchView`, so the transcript, the config and the in-flight turn are untouched. The order stays the host's to own (`SessionManager.list()` sorts, `sessionsForView()` keeps this folder ahead of sessions open elsewhere): the view draws what it is given, which is what keeps a single definition of "the order" — see `webview/view.test.ts` (asks on open, never on collapse; draws the fresh rank without touching the transcript) and `chat-view.test.ts` (`refreshSessions` re-reads the store and stays scoped to the workspace folder). Both Stryker hunks moved with their files.

## [0.9.8] - 2026-11-02

### Fixed

- **⌘C / Ctrl+C copies the transcript every time, not just the first time.** Field report: _"the first ⌘C loads the clipboard, then it keeps the first capture for ever — and the paste ends up in the prompt."_ The panel never had a copy handler: it relied on the browser's own copy, which reads the **focused frame's selection**. That is the transcript only while the DOM selection is alive AND the panel's focus is still there; the caret returns to the prompt after every `done` (and a repaint of the live bubble rebuilds its nodes), and from then on Chromium copies the **textarea's** selection — an empty one — so the clipboard keeps its previous content, which is also why the paste landed in the prompt holding old text. The chord is now owned, exactly like ⌘F: a capture-phase `keydown` reads the selection **at that keystroke**, `preventDefault`s the native path and writes the text itself (`navigator.clipboard`, with `execCommand` as the fallback for a webview where the write is refused). Two consequences are the point of the fix: the same passage can be copied twice and the next one replaces it, and the selection SURVIVES the copy instead of being collapsed by a focus change. It also remembers the last real selection over the transcript as a **cloned range** (`lastSelectionRange`, refreshed on `selectionchange` and on `mouseup`) and falls back to it when the DOM selection is gone — honoured only while its nodes are still on screen, so a rebuild invalidates it instead of resurrecting text that is no longer there. A control carrying its **own** selection (a prompt the user select-all'd) is left to the browser, which is the only one that can see it, and the context menu's Copy now reports from the same source. Four tests pin it: every keystroke replaces the clipboard, a copy still lands after the caret went back to the prompt, a textarea's own selection stays the browser's, and nothing at all happens with no selection.

- **Editing an MCP's tools no longer switches the server back ON in the session.** Field report: _"if I change the tool settings of an mcp, when I save, if the mcp was disabled it must stay that way."_ The tools panel's Save answers one question — which of this server's tools may the model see — but it also wrote the OTHER answer: `setMcpToolSelection` rebuilt the session scope's `mcp` list from the selection, pushing the server in as soon as one tool was picked. So a server the user had switched OFF (the card's switch, `scope.mcp` empty) came back ON behind their back, and un-ticking the last tool switched a used one OFF. The save now only touches the flag lists: `mcp` gains the server **only if it was already there** (`off` and `analyze` behave as before), which keeps the old, deliberate meaning of "expose no tool of this server" — a server the session WAS using, left with every tool off, still drops out of the scope — while a switched-off server stays off and simply records the choice for when it is switched on. With it, the same invariant at the CONFIG level: the editor modal kept the `enabled: true` it had loaded, so a background push that disabled a server while the modal was open (the card's name toggle, a second panel, an edit of the config file) was undone by a plain Save. The Enabled switch now follows the payload until the user actually moves it (`enabledTouched`), and after that it is the user's — no push overwrites it. Pinned by three tests, one per layer: the host writes the scope without moving the switch (`chat-view.test.ts`), the modal keeps a disabled server disabled and keeps an explicit un-tick (`mcp-editor.test.ts`), and the end-to-end panel test now asserts the card's switch is still OFF after a tools save and that flipping it is what makes the saved choice reach the model (`mcp-tools.integration.test.ts`).

- **Reasoning that resumes MID-answer now extends the turn's thinking block instead of opening a second one.** Reported from the field: a `Thinking…` block, then the answer, then a second `Thought during this answer` block right under it — and at the next repaint the two folded back into one. That was the panel contradicting itself: the host keeps **one** `thinking` string per segment (it appends every delta, before AND during the answer), so the finished turn, the replay after a tab switch and the compaction rebuild all render ONE block, while the live view showed two for as long as the run lasted. The block is now the segment's own from the moment it opens: `settleThinkingBlock()` stops its pulse when the answer starts but **keeps the node** (`settledThinkingBlock`), and the next reasoning delta appends to it and re-pulses it instead of creating a sibling — same position (above the bubble), same `Thinking…` label, one item from the first chunk to the last. The rules that already existed are untouched: merging happens **per segment**, so a tool call still closes the block for good (`clearThinkingBlock`) and the reasoning after it opens its own, because extending the old one would file it above the tool output it is about; a stray `.` still cannot re-open a settled block (`hasMeaningfulThinking`); and a rebuild that throws the node away fails the `isConnected` check and falls back to a fresh block. The ratchet hunk moved by the same 21 lines (`stryker/webview.conf.json` 6193-6225) and its anchor now names `settleThinkingBlock`, so the mutation floor kept covering the statements it was measured on. Two tests drive it: a resumed reasoning asserting ONE block holding both halves above ONE answer bubble, and a tool boundary asserting the second phase gets a block of its own.

## [0.9.7] - 2026-11-02

### Fixed

- **The one compaction that cuts inside a turn now SAYS it is doing so.** Every cut opens a turn, with a single deliberate exception: when the window is one turn bigger than the keep budget there is no boundary above it to use, and the alternative was never compacting at all (every Compact fell back to a trim, forever). That exception was silent, which made a card landing in the middle of a task look like a bug rather than a decision. The plan now carries `splitTurn` end to end — `planCompactionToBudget` fills it, `CompactedHistory` passes it on, the compaction hot path logs it (sessions and sub-agents alike) — and the shape it promises is pinned by tests: the span is never cut between a tool call and its results (`toSummarize` never ends on an assistant carrying `toolCalls`, `kept` never opens on an orphan `tool`), so the boundary is always a STEP boundary and both halves stay sendable.

- **A compacted session could start in the MIDDLE of its own history, and never healed.** Field report: a long session reopened with a dangling thinking block on top, the one-line tool cards above the first question the user ever asked, and the "Summary of past interactions" checkpoint hundreds of messages in. The splice that rewrites the history after a compaction put `summarized` — the NEWER chunk of the span, chosen by a **token budget** — in front of `deferred`, the older part the summary request could not read. Nothing was ever lost (`past` is copied verbatim, not dropped), but the two chunks were printed in the wrong order, so a cut that can land anywhere — mid-turn, between an assistant step and the tool results it fired — was hoisted above the session's own beginning. Worse, it was permanent: everything above the newest checkpoint is `past`, copied verbatim by every later compaction, so the debris moved down the transcript instead of out of it. The splice is now chronological — `[past][deferred][summarized][checkpoint][kept]` — and a test drives a real deferral through `maybeCompactDuringRun` and asserts that the oldest message stays at index 0 while the chunk that WAS summarized sits below it, in `rt.history` and in what `saveMessages` persisted (same order, nothing dropped).
- **A stored history that is already scrambled is now REPAIRED, not just left alone (migration 4).** Fixing the splice stops new damage; it cannot put a braided transcript back, because after a few compactions the segments do not merely follow each other — their time ranges OVERLAP, so no block-level reorder can untangle them. Migration 4 rewrites only the sessions whose past contains a step backwards in time, sorting it by the timestamp every message carries (stable, so messages sharing a millisecond — an assistant step and the tool results it fired — keep their order and stay glued together), keeps `seq` dense from 0 and rebuilds the external-content FTS index. It leaves **no copy behind**: no snapshot file next to `sessions.db`, no backup table — the whole upgrade already runs in one transaction (a failure rolls back to the previous version byte for byte), a healthy session is never even read back, and the only thing a copy would preserve is the old order of a transcript that was out of order by definition. On the session that paid for it — 3268 messages, 3199 above the checkpoint, four interleaved segments across two days — the head went from a mid-turn `🔧 Tool: Grep` at 10:01 to the first user input at 09:43, with zero backwards steps left in `past` and the same 3268 rows.

## [0.9.6] - 2026-11-01

### Added

- **Two SURGICAL mutation ratchets: `npm run mutate:webview` (90 %) and `npm run mutate:chat-panel` (80 %).** The two files behind this release's field reports — `src/chat/webview/view.ts` and `src/chat/chat-view.ts` — are 7000 and 3900 lines, so mutating them whole is a night's work, and neither was protected by anything: the fixes below could have been undone by the next commit with every command still green. Both configs mutate a line RANGE instead: the `textDelta` branch where a padding chunk used to settle the reasoning (22 mutants, **90.91 %**, 24 s) and `refreshTranscript` where the liveness flag travels with the replay data (10 mutants, **80.00 %**, 10 s). Measured, not assumed, in both directions: the webview ratchet exits 0 at `break: 90` and **exits 1** at `break: 99`. The two remaining survivors in each hunk are named rather than chased — `if (currentThinkingBlock)`/`if (resultEl)` with a null operand are no-ops only a defensive branch reaches, `this.view?.webview` needs a refresh with no view at all, and `{ skills: … } → {}` needs a caller that asks for the catalog, which no host test drives. **A range is the one thing a config cannot check on itself**, and the failure is silent by construction: lines inserted above the hunk slide the range onto other code, Stryker finds "no mutants found" and exits 0, so a floor becomes decorative without a single red test. `src/ratchet-anchors.test.ts` therefore reads every `stryker*.conf.json`, resolves each ranged entry and asserts three things — that the slice still contains the exact statements its floor was measured on (proven loud: moving the range to `6150-6185` fails with ``the range no longer covers `case "textDelta": {` ``), that it is still mostly code rather than blank lines or comments, and that no ranged config is born with `break: 0`, which is what `npm run mutate` uses ON PURPOSE to measure.

- **Mutation testing is now a RATCHET on `compactor.ts`.** The suite proves the compaction band derives from the declared window, but "the tests pass" says nothing about the code they never REACH — and a compaction bug is the expensive kind (a session losing its own work). `npm run mutate:compactor` (`stryker run stryker.compactor.conf.json`) mutates `src/core/sessions/compactor.ts` with the project's own vitest runner and **fails below 83 %**: 541 mutants, 450 killed, 88 survived, 2 with no coverage, in **4 minutes** on 4 workers (`coverageAnalysis: "perTest"`, 23.55 tests per mutant on average). The first run scored **76.92 %** and paid for itself in the same hour: the forward cut of `snapCutToGroup` — `turnStart` finds no input behind the boundary, so the only cut that keeps whole turns walks AHEAD to the next one — had **zero** coverage; the `SUMMARY_OVERSHOOT` guard was exercised only in its "squeeze" direction (nothing asked what happens when the budget is 0 or negative, or when the summary overshoots the budget but stays inside the tolerated band); and `splitSummary`'s `---` split had no test of its own, so the separator a MODEL writes (`-----`, padded with spaces, CRLF) was only ever tried in its happy shape. Eight tests later the score was **81.52 %** — and a ninth, the `system`/`uiOnly` filter decided below, took it to **83.36 %**, the six no-coverage mutants are **two** (a `?? ""` on a field the type already forbids from being absent), and one of the new tests documented a behaviour nobody had stated: a `---` with nothing above it is **not** a separator — the generic prompt is used and the separator stays in the body, because dropping it would take the document with it. Two notes for whoever runs it next: TypeScript 7 dropped `parseConfigFileTextToJson`, which Stryker's `TSConfigPreprocessor` calls, so `tsconfigFile` points at a path that does **not** exist, which makes that preprocessor a no-op instead of a crash; and the survivors in `filter((m) => m.role !== "system" && !m.uiOnly)` were the subject of a decision, not a test to be written on the spot: the history never carries a `system` message (`agent.ts` prepends it per request, and a summary is stored as a synthetic `user`), so no test FEEDING one can fail for a reason a real session would hit. But the filter is the contract of an exported function whose callers are not all in this file, and "no caller passes it today" is how a guard gets deleted by the next person who reads the same comment. So the guard stays and is now pinned: `serializeConversation` and `planCompactionToBudget` must both drop a `system` and a `uiOnly` message, asserted with the input a caller COULD pass — `tokensBefore` included, because a filter applied in one function and forgotten in the other is exactly how a system prompt ends up inside a summary. Ten mutants, one test.

- **Mutation testing ratchets FIVE modules, each with the floor its own measurement justified.** The single-module ratchet proved the shape; `npm run mutate` now mutates `compactor.ts`, `agent/loop-guard.ts`, `llm/context-overflow.ts`, `tools/tool-scope.ts` and `tools/mode-policy.ts` in one run and only **measures** (`thresholds.break: 0`), because a single number over five modules cannot say which one moved. The floors live one config per module — `mutate:compactor` (83 %), `mutate:loop-guard` (79 %), `mutate:overflow` (74 %), `mutate:tool-scope` (96 %), `mutate:mode-policy` (77 %), and `mutate:ratchet` for all five in order. Each floor is the score measured on the day it was set, so the number can only go up: a branch added without a test now fails a command instead of quietly lowering a percentage nobody reads. Proven to bite in both directions rather than assumed — 96.12 % exits 0 at `break: 96` and **exits 1** at `break: 99`. Two notes for whoever touches it: `--thresholds.break` does **not** exist on Stryker's CLI (only `--mutate` does), which is why the per-module flavour is a config file and not a flag; and `"extends"` is not compatible with the TypeScript-7 workaround described in the entry above — the extended config crashed the sandbox with `ts.parseConfigFileTextToJson is not a function`, so each config carries the shared ten lines itself. The floors are deliberately near the measured value (0.4–1 point), which is the point of a ratchet: the margin is not room to regress, it is only room for the non-determinism of a mutant that times out.

- **`mode-policy.ts` went from 54.53 % to 77.25 %, and the run got FASTER.** The weakest module in the tree held the strongest claim — it is the filter that decides whether a shell command is safe to run in Analyze — and two thirds of its untested mutants were two different problems wearing the same number. The first was a HOLE: the backslash escape inside double quotes (`"a\\\"; rm -rf /"`) was never exercised in any of the three functions that parse a command line (`stripQuoted`, `splitSegments`, `tokenize`), `git`'s bare invocation and `git worktree list` had no test at all, and the value-skipping of `git branch --contains <sha>` / `--sort <name>` was dead code. Those are now pinned in both directions — a `;` or a `>` inside an ESCAPED string stays an argument (the shell agrees, so refusing it was over-strict and allowing it would have been a hole), while `git symbolic-ref HEAD refs/heads/main` and `git branch new-branch` are refused. The second was not a hole: 169 of the survivors were `StringLiteral` mutants on the allowlist's own entries, and for a SECURITY ALLOWLIST the table **is** the contract — "`less` may read, `rm` may not" is behaviour, not prose, unlike the nudge sentences in `loop-guard` that no test should pin. Every entry nobody had ever run now has its read invocation (`htop`, `systeminfo`, `Get-Service`, `git rev-list`, `git check-attr`…) and every `find`/`fd` action that turns a search into a write or a command has its refusal (`-execdir`, `-fls`, `-fprint0`, `--exec-batch`…). No-coverage mutants went 51 → 5, killed 393 → 569, and the run dropped from **5m58s to ~3m** because a mutant no test kills costs a full test run to find out. Two more cases finished the job and each one was a MISTAKE IN THE TEST first, which is the useful part: `git\ status` is refused (the escaped space joins the name, so it is not `git` — fail-closed and correct), and `curl https://x` is ALLOWED, so it was the wrong witness for a "not in the allowlist" assertion (`docker ps` is the one). Six of the remaining survivors are `?? ""` fallbacks on `command[i + 1]` inside the escape branches: reachable only by a command that ENDS on a backslash (`echo "a\`), which the shell itself rejects — so they are pinned as "the parser must not invent a character", not as a feature. The three survivors left are the wording of the four refusal causes, which the message tests already cover by effect.

One new assertion failed on its first run and was **not** a test to fix: `git branch --list 'feat*'` is refused. `--list` takes an optional pattern but is not in `GIT_BRANCH_VALUE_FLAGS`, so the pattern is read as a positional — and a positional on `git branch` creates one. The filter erred on the safe side, which is the right side to err on, but it was too strict: a harmless listing was blocked. Widening a security filter's surface is its own change and not a side effect of a mutation run, so that run left the behaviour alone and a characterisation test named itself "fail-closed, too strict". That change has since been made on its own: `-l`/`--list` are now in `GIT_OPTIONAL_VALUE_FLAGS`, **optional** on purpose — the pattern is consumed only when the next token is not a flag, because a blind skip is how `git branch --list --force` would hide `--force` from the read-flag check — and `--list=<pattern>` is accepted as well. What is still refused is the positional the old rule was protecting: `git branch --list 'feat*' new-branch` creates a branch, and so does `git tag -l 'v1*' v1.0.0`. The "too strict" test was replaced by one that pins **both** sides.

- **Two guards against the test that cannot fail.** The `createNew` bug (see _Fixed_) was invisible to every import-based audit: a string `type` crossing the webview boundary has no type checker, and a test that sends one nobody handles is GREEN, because "nothing happened" is exactly what an absence assertion calls success. `src/chat/message-contract.test.ts` reads both sides — the 60 `case` labels of `onMessage` and the 58 types the suite actually sends — and fails on a type with no handler (naming the file that sends it), and on a handler no test drives unless it is one of two declared gaps (`attachPath`, not covered yet; `dragDebug`, diagnostics only, with a stale entry in that list failing too). `src/chat/assertion-contract.test.ts` takes the other half: a test that drives the host and whose EVERY expectation is a negation (`.not.…` or `toHaveBeenCalledTimes(0)`) must say so in its title. It does not forbid negative tests — the twelve in the suite are legitimate ("a cancelled dialog changes nothing", "refuses to rename a session that is still working") — it forbids the DISGUISE, a title claiming an action over a body that only checks the world did not move. Both were proven to bite before being trusted: a throwaway test file sending `totallyBogusType` and calling itself "opens a tab" made each one fail with `file:line`, then was deleted.
- **The compaction band is now PROVEN to derive from whatever a session declares, at any scale.** The recipe behind `usableContext` / `shouldCompact` / `autoTargetPercent` / `targetTokensFor` was covered piece by piece, but nothing asserted the property that ties the four together — the trigger is a share of the **usable** context (window − reply reserve), never of the declared window — at more than one size, and one real session died of exactly that (1M declared, 384k for the reply, a 400 with 63% of the window in use). `compactor.test.ts` gains a `the compaction band is DERIVED from the declared window` block: the same assertions run over **8k, 32k, 128k, 1M and 2M** windows (usable → trigger exclusive at the boundary → landing point at a tenth, always above 0 and under the trigger), the usable-not-raw property is asserted at BOTH ends of the range (89 293 on 128k, 830 000 on 1M — each under 80% of its own window and past its usable trigger), and the 1M/384k configuration is proven to be a **legitimate choice** (664 576 of usable input, trigger 531 660.8, landing 66 458) rather than a contradiction. There is deliberately **no recommended window** in it: the shipped defaults are an observation — the last case only asks that they leave a _reachable_ trigger — so a session that needs a larger context, which is the whole reason the knobs are per-session, changes the numbers and not the rules.
- **An unknown tool now wears a DRAWN question badge instead of the 🔧 emoji.** `media/icons/unknown.svg` (Lucide `badge-question-mark`, geometry verbatim, weight 1.5 like the family) is the fallback in `toolIcon`, so a name that matches nothing we ship stops being the only "mark" in the panel that is not artwork in `media/icons/` — an emoji inside a `span.tool-emoji` that every OS drew differently, sat outside the 1.25× head-icon rule, and claimed "some tool" where the truth is "no tool". Registered in `ICON_NAMES` like any other drawing (the sheet, the `currentColor` rule and the "artwork lives on disk" test all apply), the `.tool-emoji` rules are gone from `media/view.css`, and the fallback is now pinned by comparing against `icon("unknown")` instead of a string literal.
- **Every tool the registry ships is now PROVEN to wear its own mark.** Field report: _"the greplike tool still wears the stock wrench icon"_ — a card wearing the default wrench. The wrench is the fallback for a name nobody has drawn, and the mapping (`TOOL_ARTWORK` in `src/chat/icons.ts`) and the registry (`src/core/tools/`) are two places that nothing compared: a tool added to one and not the other simply rendered `🔧` over a name a reader recognises, which looks like a bug and is one. `icons.test.ts` now reads the names out of each tool's own `definition`, cross-checks the count against the tools `create-default-tools.ts` actually wires up, and fails if any of them falls back. The hunt it replaces turned up the real culprit, which was **not** an icon: see the entry below.

- **The home list (no single folder open) now carries rename and delete on each session row.** When the window has no usable folder, the sessions list is a _workspace picker_ — the whole row opens or replaces the folder of that session — so it was built with no per-session keys at all. That is too strict for the two keys that need no working directory: `rename` and `delete` act **by ID** on the stored row (`store.rename` / `store.remove` are plain queries on the central DB), so they are exactly what you reach for when you land in a window with no folder and notice a session you would rather not keep. `branch` stays out on purpose: a branch is a **new** session and every session belongs to a folder — home mode is precisely "there is no folder", and `store.create` stamps the CURRENT root, so a copy made here would be born outside every workspace and live nowhere. It keeps its one click away in _All sessions_, where a folder can be picked first. Same icons, same tooltips and the same rule as a normal row (a **working** session's keys are disabled, with the reason in the title). Two details that make it safe: the buttons `stopPropagation` so acting on a row never _opens_ its folder, and the row's Enter/Space handler now ignores keys that come from a child control — otherwise ⏎ on ✎ would have selected a workspace instead of renaming, a write gesture disguised as another one. The `home shell` webview tests encode the new policy (two keys, no branch) instead of the old "no keys at all".

### Changed

- **A release can no longer be published from a tree that one OS has not blessed.** `release.yml` ran `npm test` on `ubuntu-24.04` alone and then published to the GitHub Release, the Marketplace and Open VSX — which is how `v0.9.5` and `v0.9.6` got tagged while `windows-latest` had been red for twelve commits: the one runner that could see the difference was never asked. "Green" is now defined **once**, in `.github/workflows/test-matrix.yml` (a `workflow_call` matrix over ubuntu, macOS and Windows, `fail-fast: false` so a red leg is never cancelled by another red one), and both workflows CALL it rather than spelling it: `ci.yml`'s `test` job is the call, `release.yml` gates on it with `needs: verify`, and `ci.yml`'s own dev `.vsix` waits for it too. `needs:` on a matrix job waits for EVERY leg, so one red OS publishes nothing — and the gate is given the ref that will be packaged (`with: ref:`), because a hand-run release carries the tag as an INPUT while the triggering ref is still `main`: the old shape could bless `main` and ship the tag, one green tick over two different trees. `src/workflows.test.ts` pins the wiring, since a YAML file's mistakes are silent until they are irreversible: it reads the workflows (a small indentation reader, no phantom `yaml` dependency) and fails when a shipping job does not reach the gate, when ANY workflow other than the gate runs the suite or declares an OS matrix, when the gate loses an OS or goes `fail-fast`, or when the gate is asked for a different ref than the release checks out — five regressions, each proven loud by mutation. `actionlint` clean on all three.

- **One place names the gateway, and it is the model SELECTOR — not the badge under every turn.** The selector read `openrouter/free · 200k · out 8k`: a model whose name already carries a slash, with nothing saying who would serve it. It now reads `OPENROUTER · openrouter/free · 200k · out 8k` — the provider first, upper-cased and dimmed by CSS (a `.mb-provider` span, `text-transform` in the stylesheet so the datum itself stays lower-case in the tooltip and in the DOM) and pinned with `flex: none`, because the row is nowrap and ellipsized and the ellipsis has to eat the MODEL: the gateway is the word that makes a model unambiguous, so it must not be the part that gets cut. Which entry it names is the preference that marks `is-current` in the menu — `activeProvider` first, then any provider serving that model — so button and menu cannot contradict each other. A flat model list (a host that predates `providerModels`) gets no prefix and no dangling separator. The badge goes the OTHER way on purpose: the provider leaves the line (it repeats under every turn, next to mode, tokens and timings, on a row that is nowrap and ellipsized) and stays one hover away in the tooltip, `provider:` beside `model:`; `provider/model` was also wrong on its own terms — that very model name made it read `openrouter/openrouter/free`. In the selector the provider is a label; under a bubble it was noise.

- **`clampTargetPercent` no longer carries a condition that cannot decide anything.** Mutation testing left `v <= 0` alive in `if (v <= 0 || v < floor || floor > max)`, and it was right: `floor` is derived as `Math.max(PERCENT_UNIT, …)` and is therefore never below 1, so `v < floor` already answers for every `v` at or under 0 and the first operand could be deleted without changing a single outcome (`0` stays the documented minimum, and both the `0` and the `1 … floor−1` collapse are still pinned by tests). A condition that can never be the deciding one reads like a rule and teaches the next reader a boundary that is not there. The tests around it now keep the edge honest in both directions: a floor **above** the ceiling collapses to 0 even when the value sits above both, and a floor **equal** to it still lands on the ceiling.

- **An Analyze refusal now names the CAUSE instead of blaming the mode.** Every blocked command used to come back as "Analyze is READ-ONLY: … is not in the read-only command allowlist", which was a lie for half of them: `cat f >> out` is refused for the redirection, and `find . -delete` for the flag, while `cat` and `find` are allowlisted. Three different fixes (change the command, drop the flag, switch mode) wore one sentence, and that sentence reads like a statement about the SESSION — which is how an agent concludes that the mode changed under it when only its command was refused, then keeps planning writes it cannot run. The message is now three lines: `enforced mode: ANALYZE (read-only)` first, so the refusal says what the ENFORCEMENT sees and never has to be inferred from the failure; the failing rule next (`the MODE is the reason` for a redirection to a real file, `not in the read-only allowlist` for an unknown command, `this invocation can write or execute` for an allowlisted command with a write flag, plus command substitution and empty); and what to do instead. The classification lives in `readOnlyRefusal`, the ONE implementation `isSafeReadCommand` now delegates to, so the check and the explanation cannot drift apart — a message describing a rule the guard does not apply is worse than no message. `mode-policy.test.ts` pins the enforced-mode line and one case per cause.
- **One switch, defined once, and every on/off control in the panel is it.** Field report: _"every toggle in the project must look the same — take the one that enables and disables the MCP tools as the reference"_. They were not: the MCP tools popover wore a 26×12 accent pill, the MCP form's `enabled` flag a 26×14 restyled checkbox with a 10px knob, the Loop Guard's "Include response" an 11px native tick, and a third native checkbox rule (`.ctl-inline input[type="checkbox"]`) dressed nothing at all. Same question, four answers, and two state channels (`aria-checked` for the buttons, `.checked` for the inputs) — which is how one control drifts, one call site at a time. It is now `src/chat/webview/switch.ts` plus ONE stylesheet block (`.harny-switch`, at the top of `media/view.css` next to the other shared controls): `createSwitch()` builds the button shape, a native `<input type="checkbox" class="harny-switch">` is the markup shape where a form already reads `.checked`, and the single rule answers `[aria-checked="true"]` and `:checked` alike — so the two shapes cannot drift. `setSwitch()`/`switchIsOn()` are the one way to write and read the state, whatever the shape. The sites keep only what is theirs: the popover row places it 3px down, the form row sets `flex: none`. Drift is now a test failure, not a look nobody notices: `switch.test.ts` covers both shapes and both channels, `view-html` asserts the page ships exactly TWO native checkboxes and both wear the class and `role="switch"`, `dom-contract` (with `switch.ts` in its module list) refuses a written-but-unstyled class and the reverse, and the CSS pins still hold the geometry (track as tall as the knob, travel = track − knob, the shared `--knob-sphere`).
- **The "exclude this tool from Analyze" setting is PER SESSION now, and it is a switch like the one that turns the tool on.** It used to be a shield glyph that wrote `analyzeTools` into `config.json` — so one click in one conversation spoke for every conversation of every folder, the same bug the exposure switch already had and lost. It now lives where the rest of a session's decisions live (`ToolScope.analyze`, the same JSON column, no migration): the switch edits a draft, Save writes ONE scope row, and the file keeps its role as the **seed** a new session starts from, exactly like `excludeTools`. The label says what it does ("Analyze" next to the pill, a one-line legend above the list, and titles that spell out the three states: declared by this conversation, refused, or inherited from the server). Same rules as its neighbour: a draft until Save, disabled while the model cannot see the tool, `readOnly` kept apart from `analyzeFlag` so a server's own declaration is shown as inherited and cannot be switched off from here.
- **The verdict is applied where the session is known.** The registry is global — one `McpTool` serves every tab — so the tool can answer only for the INSTALL (`McpManager` no longer hands it the file's per-tool list) and `Agent.analyzePolicyFor` overlays the session's declaration, widening only (refuse → read-only): a conversation can declare a server's tool read-only, never revoke the server's own statement, which is a fact of the install. `reconcileToolScope`/`toolScopeFor` drop declarations about servers that are gone, and a row written before the key existed declares nothing — the strict answer, so an upgrade cannot widen a session.
- **The per-tool control in the MCP form is the SERVER'S OWN TOGGLE, not a checkbox.** The popover that chooses which tools of a server the model sees asked its question with a checkbox, while the card three rows above asked the very same question ("is this ON in this conversation?") with the accent pill. Two visual languages for one meaning, in one panel. The row now builds a `<button class="mcp-switch" role="switch" aria-checked>` — the same class, so the same track, knob, accent, disabled state and hover, with no rule of its own beyond `margin-top`/`align-self` (pinned: a width, height or background there would be a second control wearing the same name). A `<button>` inside the `<label>` the row used to be is ambiguous at best, so the row is now a `<div>` and the old "click anywhere toggles" is explicit: the switch flips on click, the row delegates to it (a bigger target, like the server list's name), and the Analyze cluster stops its own clicks so the two controls never collide. `checked` becomes `aria-checked` throughout.
- **Tests: the two surfaces are tied together.** `mcp-tools-popover.test` works on the switches (state read from `aria-checked`, one press = one flip, the row-aggregate shortcut, the Analyze switch not falling through, a stale switch left over from a closed popover staying inert, the inherited and inert states, and the label/legend words); `view` gains the integration claim — the per-tool class, role and attribute are asserted EQUAL to the server row's (`#mcp-list .mcp-switch`), for BOTH pills of a row, and no `input[type=checkbox]` is left in the form; `view-html` pins the stylesheet side (the popover rule only PLACES the pill, and the old `.mcp-pop-row input` hook is gone); `agent.test` proves the per-session gate end to end through the agent (one tool declared read-only in the scope runs, its sibling still refuses), and `mcp-tools.integration.test` proves the panel's Save writes the SESSION and leaves the file byte-identical.

### Removed

- **A sweep of everything `src` exports that nothing calls.** A whole-repo audit (every exported symbol, counted against the files that reference it) came back with 73 exports used **only inside their own file** — mostly `*Deps`/`*Options` interfaces, plus `MaskingResult`, `TurnObservation`, `SessionSearchHit` and friends. They were not deleted, they were _un-exported_: the type is still there, the promise that someone outside may use it is gone. Ten more had no reference at all and are deleted outright: `CONTEXT_STEP` (the spinner step nothing stepped by), `TodoStatus` (a union nothing narrowed), `UserMessage` (a narrowed alias), and the five `= undefined` stubs in the `vscode` resolver module that no test ever named.
- **`SIGNATURE_WINDOW` / `SIGNATURE_REPEAT_LIMIT` — the loop guard's old policy, still on the wall.** `16` and `3`, superseded by `toolRepeatWindow` / `toolRepeatWindowThreshold` in the per-sensitivity presets, and unused even by the file that declared them. Two constants that read like the tuning of the anti-loop detector while the detector reads `options.*`: the kind of duplicate that survives until someone "fixes" the wrong one. Their rationale (why a rolling window catches A/B/A/B when a consecutive counter cannot) moved onto the fields that actually govern it.
- **`fallbackTitle` — a title helper nobody called.** The store and the UI both spell `"New Session"` themselves; the helper was reachable only from its own three tests.
- **`LOOP_GUARD_SENSITIVITIES` / `DEFAULT_LOOP_GUARD_SENSITIVITY` — the preset list, duplicated.** The panel hard-codes the four radios and `resolveLoopGuardOptions` falls back to `medium` on its own, so the exported array and its default were a third copy that only the tests read.
- **`isFullAccessMode` / `ToolParameter` — two dead re-exports.** The predicate was the negation of `isAnalyzeMode` (which IS used), the interface was superseded by the inline schema in `ToolDefinition`; both survived as barrel lines with no caller.
- **`StaticConfigProvider` left the production tree.** A twelve-line in-memory `ConfigProvider` that five suites use and no shipped code constructs — a fake that reads like a feature. It now lives in `src/core/config/static-config-provider.test-utils.ts` and the five imports point there; nothing else changed.
- **`CompactionSettings.enabled` — a switch nothing read.** It looked like the way to turn auto-compaction off, it shipped as `true`, and no line of code ever consulted it: `shouldCompact` reads only `thresholdPercent`, `needsCompact` never looked, and no field, message or form ever wrote it. A knob that is promised and not honoured is worse than a missing one — it invites a report ("I turned it off and it still compacted") that reads as a mystery instead of a one-line answer. Gone from the interface and from `DEFAULT_COMPACTION`, so the policy is exactly the two numbers it always was: the threshold, and the AUTO landing share derived from it. Turning auto-compaction off was never a feature; when it becomes one it will be a session field with a test, not a comment-shaped promise.
- **`planManualCompaction` — the fraction entry point nobody called.** Its own doc comment already admitted that the host goes through `planForTarget`; a sweep of `src` (tests excluded) found **zero** callers, and inside `compactor.ts` the name appeared exactly once — its definition. Removed with the five test cases that existed only to keep it honest: the token-based `planCompactionToBudget` is what the host and those cases were really exercising, and it keeps its own coverage (including the turn-snapping contract that keeps a kept tail replayable).

### Fixed

- **The Restricted Mode contract was asserted in POSIX, and the only runner that could see it has been red for twelve commits.** `defaultSkillRoots` builds every root with `join`, so on the Windows runner it returns `\home\u\.agents\skills`; the pin for "an untrusted folder contributes NO roots" filtered on the literal `/home/u` prefix, which is true on macOS and Ubuntu for the wrong reason (nothing starts with that string) and false on Windows for the right one (every root does). The assertion is now built with the same `join` the implementation uses, and `skill-roots.win32.test.ts` runs this file's contracts with `path.win32.join` in its module graph, so the Windows SHAPE is an input on every OS instead of an accident of where CI happens to run — the guard against exactly this was `bundle-fresh`, which compares artifacts and cannot see a path dialect. Proven loud rather than assumed: with the literal restored, the new file fails on macOS with the byte-identical CI assertion (`expected [ '\home\u\.agents\skills', …(6) ] to deeply equal []`). The product was never wrong — only the test that claims the contract was — but a red Windows job is not a neutral fact when the release workflow ships a `.vsix` regardless; `dcd2ce9` is where it started and `c892cf2` is the last commit Windows blessed.
- **Renaming a provider realigned the dropdown and then sent the next turn to the WRONG SERVER.** Field report: after a rename everything looked right, and the first request died with `❌ Connection to the host refused … ECONNREFUSED 127.0.0.1:8090`; re-selecting the same model made it work again. Nothing was down: the turn had gone to the local llama server, which is simply the FIRST provider in `config.json`. `openProvidersEditor` dropped the `activeProvider` the host sent, `commitProviderForm` rewrote the providers key and kept no memory of which entry was active, and `saveProvidersEditor` — seeing no `activeProvider` in the payload — wrote nothing, leaving the file pointing at a name that no longer existed. `activeProviderName` then did what it documents: `providers[data.provider] ? data.provider : names[0]`, a silent fallback to whoever is listed first. The screen agreed with itself because the button finds a model under ANY provider, and the routing only showed up one request later. Fixed on both sides, and each half covers a case the other cannot: the editor now carries the active name through a rename or a delete (and says nothing about it otherwise — picking a model owns that choice), while `saveProvidersEditor` **follows a PROVEN rename** (the active name is on disk, gone from the new map, exactly one key out and one in) and otherwise **drops** a name that resolves to nothing instead of keeping the dangling key, which also covers a stale client and a hand-edited payload. A `provider` that still names a surviving entry is never touched by an out-of-date payload. The host test reproduces the exact read the report produced (`baseUrl: http://127.0.0.1:8090/v1`) and fails without the fix; the two view tests fail with `expected undefined to be 'OPENROUTER'`. The mutation range moved with the insertions and the anchor test caught it (`the range no longer covers `case "textDelta": {``), twice — `6138-6170` → `6172-6204`, still **90.91 %**.

- **Both fixes above would have shipped as NOTHING: the committed bundle was stale.** The panel does not run `src/chat/webview/view.ts` — it runs `media/view.js`, the minified bundle built from it and committed, and `npm run check` never builds it: the suite imports the SOURCE through Vite, so every test stayed green while the file the webview actually loads still carried the old `textDelta` order and the old liveness pairing. The stylesheet already had this guard (`view-css.test.ts` fails when `media/view.css` and the generated module drift); the bundle, which is the half that mattered here, had none. `src/bundle-fresh.test.ts` now rebuilds the same esbuild config into a temp file and compares the bytes, saying what to run rather than what differs — proven loud on the exact bundle this release had committed (`media/view.js is stale — run npm run build and commit the bundle`) and green on the rebuilt one. `scripts/build-webview.mjs` honours `WEBVIEW_OUT` so the test and the build cannot diverge into two configs; the test deliberately does NOT run `npm run build`, which would repair the drift instead of reporting it.

- **One thought, two thinking blocks — the second completing the sentence of the first.** Field report: the reasoning of a single turn appeared as two collapsible blocks back to back. `textDelta` settled the live thinking block on the _first_ content chunk, before asking whether that chunk was worth an answer bubble at all: a padding chunk (`"\n"` between two reasoning segments) cannot create a bubble (`!currentRawText.trim()` → break) but was still enough to CLOSE the reasoning. The next delta then opened a second block, continuing the same thought. The two rules now agree — the block settles only once the answer is real, i.e. after the meaningful-text check — and the test that pins it (`a padding chunk does NOT split one reasoning into two blocks`) fed the exact sequence and counted **2** blocks before the fix. Reasoning that arrives DURING an answer is unaffected: that one still gets its own "Thought during this answer" line above the bubble. Mutating the hunk afterwards found one more pin worth having, in the same branch: a delta with NO `content` at all (`currentRawText += undefined` paints the word "undefined"), so the empty-chunk guard has to stay first and must not settle the block either — and a third, older hole nobody had covered: the picker's answer de-duplicates WITHIN one batch too (`seen.add`), which is what keeps a repeated path to a single chip.
- **The Working bar vanished mid-run, and with it the place the answer was being painted.** Reported as _"the working label disappeared, yet everything kept going"_, seen around an automatic compaction. The rebuild carried the live text **paired with** the liveness flag (`...(agent.streaming && live ? { streaming: true, … })`), and a mid-run compaction fires at a TURN BOUNDARY — exactly where the committed text has already left the live projection (`projection()` → `undefined`, because `tool_result` clears `_thinking`/`_answer`). The refresh therefore arrived with **no `streaming` field**: the webview's `restoreLiveStream` returned immediately, the bar stayed hidden (nothing else restores it mid-run — the auto path deliberately posts no `status`), and since `ensureResult()` needs the bar as its insertion anchor, the rest of the answer had nowhere to be painted. `streaming` is now a fact about the RUN and is always sent, while the replay fields stay conditional. Pinned at the host level (`a mid-run refresh says the run is ALIVE even with nothing left to replay`: `streaming === true` with `projection()` undefined and still zero `status` posts) and at the webview level (`a MID-RUN rebuild keeps the working bar, and the answer keeps painting`). That measurement added a third assertion to the host test: this path must NOT carry the skills catalog — `withSkills` defaulting to `true` would ship it on every rebuild, and no test noticed.

- **A test that asserted nothing: `{type:"createNew"}` never reached a handler.** The folder-scoping test for session-name uniqueness sent a message type that no `switch` in `ChatViewProvider` handles, so `onMessage` fell through and the assertion "no _Name already in use_ alert was posted" was true for the trivial reason that nothing happened — the behaviour it claims to pin (a name used in ANOTHER folder does not collide) was untested. It now sends `newSession`, answers the naming modal the way the panel does, and also checks that the tab count grew: if the rule ever leaks across folders the alert appears, and if the flow ever stops running again the count stays put. Found by an audit of the string-keyed surfaces (message types, command ids, config keys, CSS classes) — the ones no import can betray.
- **"Open folder" from a second instance brought the FIRST window forward.** With a folder already open in another window (the ordinary case while developing: the real VSCodium and the Extension Development Host), choosing that same folder in Harny made the other window jump to the front instead of loading the folder where the click happened. The call was `vscode.openFolder(uri, false)` — the deprecated boolean form, where `false` only means "do not FORCE a new window" and leaves the choice to VS Code, whose heuristic reuses a window that already shows that workspace. It now passes the options object with **`forceReuseWindow: true`**: all three flows (the home picker, "New session" with no folder, a session row's folder) mean exactly one thing — THIS window shows that folder. It also silences the deprecation warning in the extension host log. And the flows now ask the question they were skipping: **is that folder already this window's workspace?** If it is, there is nothing to open — `openSessionFolder` simply opens the session here (`WorkspaceActions.isCurrent`, with the same no-op guard inside `open()` as a second belt, so a future caller cannot ask VS Code to reopen the workspace it is already in, and no reload is spent for nothing). The debug side gets its own fix: `.vscode/launch.json` now gives the Extension Development Host (and the test host) a separate `--user-data-dir`/`--extensions-dir` under `.vscode/` (gitignored), so a debug instance no longer shares the real profile's window bookkeeping — which is what made the two windows look like one instance to begin with.
- **`Unknown tool: Greplike" string="true` — a call whose NAME FIELD carried the arguments, answered with nothing.** Found in a stored transcript (`sessions.db`, turn with two calls: the real `Grep`, then a second whose name was an arguments fragment with `{}` arguments). The name never was a name, but the reply was a mute one-liner, so the model had no way to learn that the NAME was the problem — it could only repeat it, and the transcript kept a bubble that read as a tool Harny forgot to draw. A tool result is the model's ONLY channel for a mistake, so it now carries the diagnosis and the list: `unknownToolMessage` (`src/core/tools/unknown-tool.ts`) says a name with quotes, spaces or `=` is an ARGUMENTS fragment in the wrong field and asks for ONE call per tool with valid JSON, or — for a plausible-but-absent name — that no tool by that name was offered; in both cases it lists **what this turn offered** (`offeredToolNames`, read from the same `toolDefinitions` sent to the model, so a tool switched off for the session is never suggested back into a second refusal). The panel stops painting such a name as if it were a tool: the bubble is marked (`data-tool-invalid`) and the header wears the error colour in the mono face, and a runaway name is clamped at 44 chars with the exact emission kept in the `title` — same rule for the sub-agent log line and the working bar.

- **The Steer pill could stay lit with no key held** ("every now and then the steer state gets stuck"): after ⌘⇧4/⌘⇧5 on macOS the screenshot or screen-recording overlay takes Cmd's `keyup` for itself, and the VS Code window is never deactivated — so neither `keyup` nor the existing `blur` fallback ever reached the panel. It was not cosmetic: `effectiveSendMode()` reads the same flag, so the next plain ⏎ would have **steered** into the running loop instead of queueing. The state is now re-derived from any event that carries the truth — a keystroke (in the **capture** phase, so it lands _before_ the Enter handler that reads it), a mouse move or press, window `focus`, and `visibilitychange` — the way a browser corrects a stuck key. Two rules keep it platform-neutral: the recovery **only ever clears** (setting stays the business of a bare modifier keydown, so nothing else can light the pill), and it asks the same predicate the pill uses (`⌘`/Ctrl on macOS, Ctrl on Windows and Linux), so a `mousemove` while the modifier _is_ held keeps it lit and a tap of the Super/Windows key still does nothing. Covered on all three OSes: macOS in the default suite, Windows and Linux in the explicitly re-pinned block.
- **In a folder opened untrusted, the panel was EMPTY — no view, no icon, nothing to hover.** Field report: _"Harny does not appear in the panel when there are untrusted-folder problems"_. Nothing was crashing: the extension was **disabled**. An extension that does not declare `capabilities.untrustedWorkspaces` is put in VS Code's (and VSCodium's — same Workbench) _Disabled in Restricted Mode_ bucket, and a disabled extension contributes nothing at all: the activity-bar entry and the `harny.chatView` webview simply do not exist, so the side bar is blank with no hint, no error and no log line. The manifest now declares `"supported": "limited"` with a sentence explaining the limit, and the limit is REAL — worth stating, because `true` would have made the panel reappear while letting Harny write files and run commands in a folder the user has not vetted, which is exactly what Workspace Trust exists to prevent. Until the folder is trusted a session runs as Analyze, the contract the stack already honours end to end: file tools prepare VALIDATED previews, Shell keeps to the read allowlist, tools without a read-only policy are refused. The verdict is one live function (`workspace.isTrusted`), and it becomes a mode in one place (`ChatViewProvider.effectiveMode`) that everything downstream follows — the system prompt, the tool list, the turn badge, the pill — so the panel can never show a Build that silently previews. `Agent.setMode` coerces too, because a preference SAVED in a trusted folder, a reload or a sub-agent inheriting write access would otherwise walk straight past the panel; `setMode("agent")` while untrusted is refused with the reason in the transcript (the `denied` contract), the same note the _Switch to Build_ CTA writes instead of asking a question whose answer cannot be honoured. The stored preference is left untouched, so trusting the folder gives Build back with no second click, and `workspace.onDidGrantWorkspaceTrust` rebuilds the panel on the spot. The workspace's own skills stop loading meanwhile (a checked-in `SKILL.md` is workspace content like any other); the panel disables the Build choice and says why in its title; and `package-manifest` now pins the declaration, because the failure mode of forgetting it is _silence_. **A delegated writer is a reader too**: `Agent` now exposes the mode it actually ACCEPTED (`mode`), and the sub-agent report is built from that instead of from the access it asked for — otherwise a helper whose "write access" resolved to Analyze reported `done` with no files touched, and the orchestrator could not tell a real write from a preview. Its escalation note also stops pointing at "re-delegate with access write" in this state (the folder is what has to change, not the access level), which would have sent a model round the same loop until the turn budget ran out.

- **The suite is green on Windows again — the two failures were the tests' fault, not the product's.** `extension activate (smoke)` compared the page against a RAW path (`"workspaceFolder":"C:\Users\…"`) while the page carries it JSON-ENCODED (`C:\\Users\\…`): it could only pass on POSIX. It now encodes the expectation the same way the page does. The other was `view-css`: the generated module is committed with LF, but a Windows checkout delivered `media/view.css` with CRLF (`core.autocrlf=true`), so the pin compared different bytes. `.gitattributes` (`* text=auto eol=lf`) now normalises in the repo AND in the working tree, the generator normalises `\r\n`, and the pin normalises both sides — three layers, because one is never enough when the artifact is committed.

## [0.9.5] - 2026-10-31

### Added

- **The stylesheet is a file again, not a template literal.** `view-html.ts` held ~2,300 lines of CSS inside the string that builds the page: no formatter, no linter, no type check — and a stray backtick in a CSS comment was a syntax error nobody could catch (it happened TWICE while adding one rule). The sheet now lives in `media/view.css` and reaches the page through the generated module `src/chat/view-css.ts` (`npm run gen:css`, run before every bundle): JSON-encoded, so it cannot end a literal or start an interpolation, with `view-css.test.ts` failing if the two ever drift apart. Importing the `.css` directly was tried and rejected on evidence: Vitest stubs every CSS import (`?raw` included), and keeping Vite's CSS pipeline out of the way needed a chain of hacks — a generated string needs neither bundler to agree on anything. `view-html.ts`: 3,001 → 666 lines.
- **Test fixtures are typed like production.** The stream chunks that drive the agent tests come from one shared, typed builder (`src/core/llm/stream-chunks.test-utils.ts`) instead of three local copies, and the host fixtures take options (`makePanel({ visible })`) instead of positional flags. The reason is on record: a hand-written chunk literal typechecked and failed at RUNTIME, in a test meant to prove something else — the compiler should say no first.

- **The panel opens on its sessions even with NO folder open.** The first screen used to be a dead end — _"Harny needs a single open folder"_ — that also hid the one thing worth showing: sessions live in a single central database keyed by folder, so the full history is available with no root at all. The sessions card now stays on screen in that state and becomes a **workspace picker**: every folder's sessions, most recent first, each row carrying its folder path in the mono face, and **the whole row is the control** (pointer, focus ring, Enter/Space). The trailing label says what the click does — **Open folder**, or **Change folder…** when that path is gone — and the hero names the reason (**No folder is open** / **3 folders are open — Harny needs exactly one**) with **Open folder…** as the one action. Nothing per-session is offered there (branch/rename/delete act on a session that cannot be shown yet; they stay one click away in All sessions), and the gear is hidden because that form would list the very same rows.
- **`workspaceFolderCount` and the root's PATH travel with the config** (host → view), so a multi-root window is told how many folders it has (instead of "no folder is open") and the hero can name a folder that went missing.
- **A folder that is GONE is never hidden.** `folderMissing` was already computed at list time; what was missing was the SCREEN. Now a workspace whose folder was deleted on disk is **not "ready"** any more (`workspaceReady` also checks that the root exists), so the panel falls back to the home, which NAMES it — _"The workspace folder /path no longer exists"_ — reassures (_"Your sessions are safe"_) and offers **Open another folder…**; the list stops being filtered by the dead root, so it shows every workspace again (that is the picker). A session row whose folder is gone carries a visible **`/path — missing`** line (not just a tooltip) and its **tab turns red**. Clicking either opens the picker instead of silently doing nothing, which is what `openSession` did — the host refuses to open a session whose folder is missing, so a row that looked healthy was a click that went nowhere. And it is noticed **without any interaction**: every other path is reactive, so a folder deleted from outside (`rm -rf`, a mount that drops) left the panel claiming a workspace until the next click — the first symptom being a tool failing with `ENOENT`. `WorkspaceRootWatch` (`src/chat/workspace-watch.ts`) polls the root with ONE `stat` every 5 s, reports the verdict only when it CHANGES (both ways: a mount that comes back brings the chat back) and rebuilds the panel; a poll rather than `fs.watch`, which behaves differently per platform on a deleted directory and cannot even be armed when the folder is already gone.
- **A click into another workspace now FINISHES instead of restarting.** Opening a folder reloads the extension host, so the click that asked for it had nothing left to carry it: you picked a session, the window reloaded, and the panel showed a home screen that had forgotten. The intent is written to `globalState` (the only store that survives the reload) **before** the folder opens, and consumed once on activation (`src/chat/pending-open.ts`): a row opens its folder _and then the session_, and **New session** with no folder leaves the naming modal waiting on the other side. Two rules bound it — the marker is honoured only in the folder it names (any other activation discards it) and only for five minutes (a reload takes seconds), and it is always consumed, so it can never fire in the wrong project nor twice. The panel also gained `runWhenReady`: a gesture that arrives before the page exists now waits for it, because a `postMessage` into a webview that is not there yet lands nowhere.

### Changed

- **Where the panel speaks is a TABLE now, not a judgement call.** Five surfaces can carry a fact (hero, session row, in-panel dialog, transcript note, native toast) and each one used to be chosen at the call site — which is how one fact ended up announced three times at once. `chat/notice-policy.ts` is the counterpart of the webview's LOCK TABLE: `routeNotice("workspace-gone", {panelVisible, sessionOpen})` answers `ask` / `toast` / `silent`, so a dialog opens only where it can be SEEN and ANSWERED, a toast only where no panel exists, and nothing when the panel's own home already says it and offers the picker. The rule is pinned by tests, not by prose.
- **A refused send is an EVENT, not a dialog.** The host answers a send it cannot run with a typed `denied` (`{action, reason}`) instead of opening a modal: the panel takes back the paint it had already made — the optimistic user bubble AND its "Working…" bar — and says why in the transcript, exactly where the message would have appeared. That closes the class of bug where a refusal left a message shown as sent and a bar nothing would ever clear, and it keeps the doctrine: a dialog is a QUESTION, and nobody is being asked anything here.
- **Opening a folder has ONE implementation.** The three flows that need a workspace — the home CTA, a session row and "New session" — went through two copies of `commands.executeCommand("vscode.openFolder", …)` plus an ad-hoc picker. They now share `WorkspaceActions` over an injected `WorkspacePorts` (`src/chat/workspace-actions.ts`): the dialog and the reload live in one adapter, and the flows are unit-tested without a host. The _open-vs-pick_ rule — and its wording — is likewise one pure function (`src/chat/webview/session-folder.ts`) shared by the home list and the All-sessions form, instead of two copies that could disagree about a gesture that reloads the window.
- **"New session" with no folder open asks for a folder instead of refusing.** The old alert named _File → Open Folder_ and stopped; the picker is the answer to the same question, and cancelling still changes nothing.

### Fixed

- **A reasoning block that says nothing no longer holds a line in the transcript.** Some providers emit a lone `.` (or just punctuation) as a separator, and the panel faithfully opened a _"Thought during this answer"_ section with a single dot inside it — space taken in the story of a run, for something that was never a thought. The block is now not CREATED until the reasoning contains a letter or a digit: punctuation alone waits in a buffer, and when a real sentence arrives the block opens there — still above the answer bubble, with the dot inside it. The same rule applies to the REPLAY path (`liveThinking` restored on a rebuild), which is the other way it came back. Nothing is filtered from the stream: dropping a legitimate "…" or "?" mid-thought would be the worse bug — the choice is only whether a SECTION is shown. (A first attempt hid the block with a `hidden` class; the sheet has no generic `.hidden` rule, only per-id ones, so the class was a no-op — a rule that is not in the stylesheet is not a rule.)
- **The engine will not work — or keep working — without its folder.** The root is now a PRECONDITION of using it, enforced in three places that share one rule (`workspaceReady`) and one set of words (`core/agent/workspace-gone.ts`): a **send** is refused before it becomes a run — the panel does not even paint its optimistic "Working…" for it, because nothing would ever arrive to clear it (play on a dead folder opens the re-point dialog instead, and typing/attaching stay allowed: the decision may be "later"); every **tool call** is refused when the root is gone — the net for the window before the next poll — with a message written for the MODEL (_"this is NOT an empty project… do not scaffold"_), which is the sentence that stops the re-create-the-folder reflex; and the **watcher STOPS** a run in flight (`abort` carries the reason into the transcript) as soon as the folder disappears, which cascades to its sub-agents. Before this, a run whose folder was deleted kept going, `Write` re-created the folder (`mkdir -p` of the parent) and the session silently "healed" to an empty ghost. A dialog that blocks the panel would be a second problem — _while a run is going_. So the order is: **abort first** (the run and its sub-agents stop, the reason is written in the transcript), **then** ask — in the panel's own dialog ("Folder no longer available… Pick a new one.", OK → the picker). Blocking is harmless once nothing is running, and there is nothing else on screen saying it: no banner, no toast on top of it. The toast survives only as the fallback for a panel that is NOT on screen (`panelVisible()`), where a modal cannot be shown at all.
- **A running session keeps its CHAT (and its STOP) even when the folder is gone.** The home rule was "no usable folder ⇒ picker", which took the entire control stack — STOP included — away from a session that was **still running**: the stream kept drawing over the hero, the live turn could not be interrupted by hand, and the panel looked like a dead end (reported from the field, with a screenshot of exactly that). A session that is open now WINS: the chat and its controls stay, and the reason is stated IN the transcript — a banner naming the dead path with **Change folder…** one click away, the same route as the red row. The picker is for "nothing to talk to".
- **A panel that froze behind a dialog nobody could answer.** `PanelModalQueue.cancelAll()` documented itself as "called when the webview page is rebuilt with a modal open" — and nothing called it, so the guard was a promise, not a mechanism. The hole it was meant to cover is real: `refresh()` skips the rebuild when a modal is ALREADY pending, but `buildHtml()` is async (config, skills, MCP status — hundreds of ms), so a modal could OPEN in the middle of a build and the page was replaced underneath it. Its DOM vanished, the answer never arrived, the queue stayed non-empty for ever — and since every later `refresh()` defers behind a pending modal, the panel stopped updating entirely: the frozen "interface blocked" state, with the folder already gone and a red row as the only thing on screen. The rebuild now DEFERS when a modal opened while the page was being built, and `dispose()` cancels whatever is still waiting (a flow must not hang on a webview that no longer exists).
- **The home hero could be clipped out of reach.** `.empty-hero` centred its content with a plain flex centering, which on a short panel pushes the TOP of an overflowing column out of the scrollable area: the message (_"The workspace folder /… no longer exists"_) disappeared while the button underneath stayed visible, so a state that explains itself read as a mystery. It is `safe center` now (centred when it fits, top-aligned when it does not) and the list is capped at 45vh instead of 55vh, so the explanation always has room.
- **A stuck dialog can no longer make the panel unrecoverable.** Belt to the brace above: the modal overlay covers the whole panel, so one dialog nobody can answer takes every control with it ("I cannot change mode/parallel"). `ModalStallGuard` puts the deferral on a clock: if a modal is pending WHILE a rebuild waits behind it for more than two minutes, the dialog is cancelled and the panel rebuilds itself, with a line in _Output > Harny_. It fires only on that combination — a dialog left open while nothing wants to redraw is the user reading, and is left alone.

## [0.9.4] - 2026-10-30

### Fixed

- **A run no longer sends another session's model — or none at all.** The config a request carries was
  written into ONE shared override layer, from whichever tab was visible, and the agent re-reads its config
  at every turn. Opening a new session (no model yet) cleared the layer, so the running session's next
  request went out with the config file's model and **no `x-opencode-session`** — OpenCode Go answers
  `400 MissingSessionID`, and closing/reopening the session "fixed" it because that re-derived the layer.
  Switching to another session was worse and silent: the running turn was sent under THAT session's model
  and conversation id. The compaction summarizer had the same defect from its own side (it was built over
  the host chain), so a summary taken mid-run failed the same way; sub-agents inherit the session's config
  and are now covered by a test.

### Changed

- **Each session's config is DERIVED on every read, never stored.** `SessionConfigProvider(base, derive)`
  asks the runtime for the session's overrides at the moment of use, so there is no copy to keep in sync and
  no ordering to get right. It replaced a per-session override layer plus the four mechanisms that existed
  only to refresh it (`applySessionModel`, `applyAllSessionModels`, `reapplyActiveAfterRemoval`, the
  `applyBudget` port step) — every new path that changes a session was a chance to forget one, and forgetting
  once is the same bug again. `MemoryOverrideConfigProvider` and the output-clamp step went with it: the
  clamp is computed from the live context at every read, which is strictly fresher than a value written
  before the run. Measured cost of a derived read: **0.025 ms**.

## [0.9.3] - 2026-10-29

### Added

- **A test that compares the palette's surfaces as RELATIONSHIPS, not values.** `src/chat/view-config.test.ts`
  holds four invariants per theme: the code block sits below the answer card (by a visible step, not a rounding
  error), the answer card stands out from the page, hover stands out more than the card, and every surface
  compared is a plain `#rrggbb` so those comparisons mean something. The direction of "above" flips between the
  themes — on near-black you rise by getting lighter, on paper by getting darker — so only DISTANCES are asserted.
  A hex-per-role test would have failed on every taste change while missing the inversion below; this one was
  verified by restoring the old value, and it fails with _"light: tool-bg must sit below assistant-msg"_.

### Changed

- **Tool calls no longer sit on a card.** A tool bubble was a filled rectangle one shade _lighter_ than the page in
  the dark theme, so a long run accumulated a stack of cards that competed with the answers for attention. It keeps
  its hairline border and loses the fill: the bubble now reads as an outline on the page, the way the thinking
  block always has. `--tool-bg` is untouched — code blocks, inline code and table headers inside an answer still
  need their card.
- **The light theme had its code blocks RAISED instead of recessed.** `--tool-bg` sat a step _below_ the answer
  bubble in the dark theme (`#1a1a1a` under `#1e1e1e`) and a step _above_ it in the light one (`#f7f4f1` over
  `#f4f1ed`): one role with two opposite meanings, unnoticed because the palette tests only checked that a role
  EXISTS in both themes, never what it means. It is `#eeebe7` now — deeper than the card, as in the dark theme.

### Removed

- **`minus.svg` is gone: the only mark in the folder that nothing drew.** It had no call site, in any commit
  — `git log -S'icon("minus"'` over the whole history returns nothing. Its six users were the stepper
  buttons (`ctx`, `out`, `samp`, each with `+` and `−`) that `63d895e` replaced with sliders; the FILE was
  created later, by the refactor that moved every glyph out of the markup, so it was born orphaned and
  stayed that way. Cost of keeping it was 167 bytes on disk and 506 in the bundle — nothing: it is removed
  because `media/icons/` says it holds what the panel DRAWS, and one exception turns that sentence into a
  preference. The `+` it used to pair with survives (it is "new session"); if a stepper ever comes back,
  the drawing comes back with it.

## [0.9.2] - 2026-10-28

### Changed

- **The "Model limits unknown" dialog now ASKS for the two numbers, instead of pointing at another card.** A local model
  whose server reports nothing (llama.cpp & friends) opened a wall of text saying "set them from the Window / Output
  controls" — and by the time you found that card, the session was already sending the defaults. The dialog is a form:
  the same two sliders as the Window card (context window **1 000 → 2 000 000**, output tokens **8 → 524 288**),
  pre-filled with the values in use, so **OK without touching anything changes nothing**. A side the host DID report is
  not re-typed from scratch: its own limit is the ceiling of the slider, so it can only be lowered. The answer is saved
  on the session and remembered for that model, so coming back to it no longer asks again — and it is deliberately not
  written back as the model's ceiling, or an underestimate you typed would be impossible to correct from the Window
  card without switching model first.
- **The two token sliders got the scales they were missing.** Context window now runs **1 000 → 2 000 000**, output
  tokens **8 → 524 288** (it stopped at 512 000, so a 524k model could not be typed in), and the defaults follow what
  Harny really sends: context **128 000** (unchanged) and output **8 192** instead of 16 384 — the same number as
  `harny.maxTokens`, so the slider and the setting no longer disagree. Because the output MINIMUM is now 8, its step
  went from 256 to **8**: a step that does not divide the range leaves the thumb unable to reach the ceiling, which is
  exactly what happened when the slider restarted from 8 with a 256 stride. A smaller minimum also means a tiny
  `max_tokens` is finally expressible — 123 is no longer silently raised to 256.

## [0.9.1] - 2026-10-28

### Changed

- **The task list lives in ONE place: the `TodoWrite` block.** The footer above the input is gone, with its engine, its
  lifecycle rules and its stops — a second copy that needed its own rules (when to hide, what to do on a session switch,
  how to silence it) and that could still show a finished `6/6` of an old subject while a new run was working. The block
  in the transcript already scrolls next to the conversation, and it is the record.
- **A finished task reads as done, not as deleted.** The rows are a checkbox and the text — no numbering, because the
  order of the rows IS the plan — and a completed task is BOLD in full ink behind a green ticked box. No strikethrough
  and no dimming: a line across the words is the universal sign of "gone", and a finished task is the opposite. The four
  "baffi" marks (`todo-pending`/`-active`/`-done`/`-cancelled`) went with the old rendering.
- **The README no longer says the VS Code Marketplace listing is not live.** It is: `spltek.harny` is
  published there, so `Install` now points at it first and keeps the `.vsix` as the manual route.
- **The three destructive session answers ask once more.** Delete / Rewind / Empty now turn the same dialog into a second
  question, with the consequences named (`There is no undo`), the other answers removed and the focus on Cancel — so a
  doubled Enter cannot confirm. Cancel answers "nothing", it does not fall back to the choice that opened it.

## [0.9.0] - 2026-10-27

### Added

- **The ON/OFF of an MCP server and the tools left out are PER SESSION.** Installing a server is a machine fact
  (`config.json`); using it is a conversation's decision. A new session starts with **every server off** and every
  built-in available, then switches on what it needs — and can switch off a single built-in, or a single tool inside a
  server it uses. One JSON column on the session (migration v3), read live at every turn: a change lands on the next
  one, with nothing to reconnect. Sub-agents inherit it, so a tool that is off cannot be used through a delegate. The
  tools the config leaves out are the SEED a new session starts from; a save no longer writes `excludeTools` (that key
  is not the panel's to own) and no longer respawns the server — the Analyze shields are read live, so saving one stops
  costing a reconnect.

- **Removing an MCP server is refused while a RUNNING session is using it.** The turn already has that server's tools in
  the list it was given, so deleting it mid-flight could only surface as `Unknown tool` on the very next call. The brake is
  as narrow as the danger: it looks at the OPEN sessions, and only at the ones that are working AND have that server on —
  a server nobody uses, or used by an idle session, is removed without friction (the next run simply will not see it). The
  editor stays open and says why; editing the config file by hand still bypasses it, where the graceful path (a tool that
  vanished returns an error result and the turn continues) remains tested.

- **Each MCP server has a real SWITCH now — a pill whose knob slides right when the server is on.** The control
  existed but was INVISIBLE: the server's name was the toggle and nothing on screen said so, so the only way to find
  out was to click something and see what happened. The row now leads with a `role="switch"` button whose
  `aria-checked` drives the look (off: white veil with a gray dot at the left — the "disabled" reading; on: ACCENT
  track with a WHITE dot), and
  the name still works as a shortcut — the leading `●` is gone, since the switch now carries the state. The track is
  exactly as tall as the knob (26×12 with a 12×12 knob, no border, knob flush) so the switch reads as one object; that
  took resetting `min-height`, `padding` and `box-shadow`, because the global `button` rule's `min-height: 1.54rem`
  BEATS `height` and left a ~25px track with the knob stuck at the top and empty space below it. The guard while a run
  is working became visible too: the switches dim with a tooltip ("Stop the run first — a mid-run toggle only lands on
  the next turn") instead of silently swallowing the click. Because a run can start or stop between two config pushes —
  and the card is deliberately NOT redrawn when the mcp section is unchanged — the switches are refreshed on every
  streaming change, so what is on screen cannot lag behind what is being enforced.

- **Every knob in the panel wears the SAME shadow, and every slider is orange.** `--knob-shadow` in `:root` is one
  value (0 1px 2px at 60%), used by the MCP switch's dot and by **every slider thumb** — those are a plain orange
  circle (`var(--accent)`, 14px) with that shadow, which is all they needed: an earlier attempt composed a
  gradient-on-gradient custom property for the thumb, the browser dropped the whole `background` as invalid at
  computed-value time, and the ball vanished leaving only its rim on screen. `accent-color` can colour the native thumb but cannot shade it,
  so the range inputs draw their own parts in both engines (`::-webkit-slider-thumb` / `::-moz-range-thumb`). The
  filled part of the track stays **orange**: a thin rounded 4px bar, orange left of the knob, neutral to the right.
  WebKit has no `::-slider-progress`, so the view writes `--fill` (a percentage) into that gradient; Firefox draws the
  same fill with its native progress pseudo-element. `--fill` is DERIVED state, and
  one rule owns it for **every** slider: `syncRangeFills()` reconciles them all (writing only what drifted) and
  runs on `input`/`change`/`click` in the BUBBLE phase — i.e. after the panel's own handlers, so a handler that
  re-bounds another knob (the compaction trigger driving the landing slider) is already done when it looks — after
  **every host message** (a partial `config` push, which is what changing the model sends, writes the context
  slider's `.value` from its own handler and never through `renderViewState`: the knob went to 100% while the orange
  fill stayed at 6%) and once per render. No call site has to remember.

- **The two compaction knobs are independent now, and the one rule between them is stated instead of applied behind your
  back.** The landing slider used to have a maximum DERIVED from the trigger (`threshold − 1`), re-written on every movement
  of the other knob and on every preview message. That was the bug: shrinking `max` makes the browser clamp the WIDGET
  while the draft keeps its number, so the label and the knob disagreed — and each later write put the knob where the
  stale draft pointed, clamped again. Both knobs now have their own fixed range (1..100 and 0..100), moving one never
  moves the other (AUTO excepted, which follows the trigger by definition), and the physical rule that remains — landing
  at or above the trigger frees nothing — is applied ONCE when you save, with the label saying the number it will
  actually store (`62% → saved as 36%`). The Save handler also reads the DRAFT instead of the widget, which is how an
  auto value could be stored as an explicit choice. A **note under the knobs follows the EFFECTS** of the pair you
  picked, live: it names the limit it hit ("landing at 90% with the trigger at 60% would free nothing: it is saved as
  59%") or the other one ("below 8% there is nothing left to free — the summary and the last turn already occupy that
  much"), and disappears when the pair makes sense.

- **A single MCP tool can be declared read-only for Analyze — the shield in the tools panel.** `analyze` was a per-SERVER
  declaration, so allowing one safe tool meant vouching for every tool of that server (or hand-editing `config.json`,
  since nothing in the panel touched the key). Each tool row now carries a **shield** next to the exposure checkbox:
  two questions, two controls — the checkbox decides what the MODEL sees, the shield decides what may run in **Analyze**.
  It writes `analyzeTools` on the server, an **INCLUDE** list on purpose: exposure is allowed by default (a server that
  adds a tool tomorrow should be usable), while Analyze is **denied** by default (a new tool must prove itself), so the
  narrowest statement is the one that is explicitly written down. The per-tool statement wins over the server's, it is
  read **live** (no reconnect needed to take effect, though the panel's Save reconnects anyway for the exclusion list
  it shares), and where the server-level declaration already allows everything the shield shows as **inherited** and
  says so instead of pretending a per-tool rule did it. The refusal the model receives names this third way out, the
  README stops calling `analyze` file-only, and `config.example.jsonc` finally documents the MCP block (the server-wide
  `analyze` is the one field with no control in the form).

- **⌘F now opens Harny's find, not VS Code's.** Inside a webview the chord also reached the host, which opened
  its own find widget and took the focus out of the panel — the webview's `preventDefault` cannot stop the host from
  acting on the same key. The extension now contributes that keybinding, **scoped to `focusedView == harny.chatView`**
  (nowhere else does it take the key), and runs a command that tells the panel to open its bar; the message path also
  `stopPropagation`s the original key for hosts that deliver it to the page. The command is registered at runtime and
  deliberately absent from `contributes.commands`, so the palette stays clean — a manifest test now enforces that every
  Harny keybinding is view-scoped instead of banning them all.

- **Three gaps found in the final review, each fixed with the test that locks it.** _Copy_ claimed success when the
  clipboard API was missing (`await navigator.clipboard?.writeText` resolves to `undefined`) and never tried the legacy
  path — it now reports the truth. _Find_ counted a hit inside a FOLDED section and then scrolled to a `display: none`
  node, so the jump did nothing: the match now opens its ancestors (chevron and state included). And a fold header is a
  **disclosure button** for the keyboard and the screen reader (role, tab stop, Enter/Space, `aria-expanded`), not just a
  clickable `div`; the debounced search is also disarmed on close, where it used to fire after the bar was gone and clear
  whatever the user had selected in the meantime.

- **The queue/steer header puts each count in parentheses**: `Steer (1) · Queued (2)` instead of `Steer 1 · Queued 2`,
  so the label reads as a name with a count beside it rather than as a number that belongs to the word.

- **The fold arrow is one chevron that turns, not a triangle swapped for another triangle.** Every collapsible header
  wrote `"▶"` closed and `"▼"` open, in eight places across two modules: a filled triangle changes shape and weight as it
  opens, and reads heavier than the chevrons the rest of the panel already uses (`#ctl-toggle-btn`, `.mode-btn-chevron`,
  `.lg-collapse`). Now ONE svg points right when closed and turns down when open, in the same 0.15s as the other folds —
  the state is a class (`is-open`), the box stays 12px, nothing shifts, and the hover takes the accent colour. The
  drawing and the state live in `webview/fold.ts` (one `toggleMarkup` / `setToggle` / `setButtonToggle`), so the six
  copies of the string literals are gone; the per-bubble fold button gains `aria-expanded` with it.

- **The icons at the head of a bubble are a quarter larger — and no bubble grew.** The tool card, thinking, sub-agent
  and synthetic-summary marks are painted through `transform: scale(1.25)`, not a larger `width`/`height`: a transform
  does not enter the layout, so a 16px mark inside a 13px box keeps every row, gap and bubble exactly the height it had.
  1.5× was tried first and read as too big; the value is one number in one rule. The emoji fallback for a tool nobody has
  drawn (`🔧`) is wrapped in `span.tool-emoji` so it is scaled with them: a bare glyph could not be targeted, and an
  unscaled emoji beside the larger marks looks like a bug.

- **Find in the chat (⌘F / Ctrl+F), which did not exist at all.** A webview has no native find — the browser's ⌘F
  belongs to the host window and never reaches the panel — so the shortcut was dead. A small bar over the transcript's
  top-right searches every bubble case-insensitively, `Enter`/`Shift+Enter` step through the matches (wrapping), the
  counter says `3/17` or _no match_, and `Esc` closes find instead of stopping the run. Matches are capped at 500, and a
  list built before more text arrived is rebuilt rather than pointing at ranges that no longer exist.

- **Typing in the find field no longer stops after one character.** The first cut used the document SELECTION as the
  highlight, and setting one blurs the field you are typing in (Chromium drops the focus on the body): the chat scrolled
  to the match and the next keystroke went nowhere. Highlights are now painted with the **CSS Custom Highlight API**,
  which needs no selection at all — the caret never leaves the field, the current match stands out from the others, and
  nothing is injected into a transcript that streaming repaints. A host without the API falls back to the selection, and
  then only while nothing of ours is focused: keeping the caret wins over painting.

- **Every change to the query recomputes ALL the highlights, and the scan follows the transcript.** The paint used to live
  inside the "show the current match" step, which returns early when there is no match: emptying the field (the ✕, or
  backspace to nothing) or typing something that matches nothing left the PREVIOUS highlights on screen, marking text that
  no longer matched. The paint is now unconditional — an empty result is a paint of nothing — and while the bar is open a
  `MutationObserver` re-scans the transcript (debounced 300 ms, and **without scrolling**): a list of ranges pointing into
  nodes that streaming replaced paints nothing, or paints the wrong span.

- **A context menu we own, on the transcript.** Whether a webview gets a native menu with Copy is not a contract —
  Windows, Linux and each VS Code build disagree — so right-clicking the prose now opens ours: **Copy** (enabled only
  with a selection, as in any editor) and **Select all**, anchored at the pointer, closing on Esc, an outside click or a
  scroll. Chrome inside the transcript keeps the host's own behaviour, and Ctrl+click on macOS keeps working.

- **Text that is still streaming can be selected and copied.** The live bubble is repainted per delta
  (`innerHTML = renderMarkdown(...)`), which dropped any selection under the cursor — so a passage could not be copied
  until the answer had finished. The repaint is now **deferred** while a selection intersects that node (the raw text
  keeps accumulating, nothing is lost) and lands as soon as the selection goes away: while you hold it the text simply
  waits for you, then catches up in one go.

- **Copying during a run works, and holding ⌘ no longer scrolls you away from what you are reading.** Two bugs shared
  one cause. The Queue/Steer **indicator** called the same helper a real decision did, so merely holding Ctrl/Cmd
  switched the mode AND ran `followAndFocus()`: the transcript jumped to the last message, following re-armed itself,
  and the focus went to the prompt — which discarded the selection the keystroke was about to copy. The indicator now
  only paints; the view and the caret move on a real decision (a send, a pending change). And the `contextmenu` handler
  suppressed the native menu everywhere outside inputs, so **Copy existed only as a shortcut**: it is now suppressed
  only on macOS over the chrome (where Ctrl+click _is_ a click), and **never** on a text selection anywhere.

- **The keyboard now follows the host OS, where it must.** The Steer modifier is the OS's own — **⌘** on macOS (Ctrl
  accepted too, as the hint says "Ctrl/Cmd"), **Ctrl** on Windows/Linux, where a bare **Win/Super** key is the OS's and
  must not hijack the next message; the context-menu rule exists for macOS's Ctrl+click and is now macOS-only.
  Everything else (Enter, Shift+Enter, Esc, arrows, Tab) is deliberately identical everywhere.

- **Stop cancels an in-flight MCP call, and an MCP result is capped like any other tool's.** Both were the same gap, at
  the **execution boundary** where a result enters the conversation. The run's `AbortSignal` now travels down
  (`ToolContext.signal` → `McpClient.callTool(…)`), so a `tools/call` is dropped the moment you press Stop: the server
  gets the protocol's own `notifications/cancelled`, the pending entry is discarded, the late reply is ignored and the
  process stays alive for the next turn — before this the call sat until its timeout and the answer arrived when the
  run was already over. The result is passed through `toolOutputCapChars` (10% of the session's usable window, at most
  50KB, at least 2KB) with the same truncation note Shell and Grep use: observation masking only touches OLD results,
  so the newest one — the one the model is waiting for — was the one a fixed ceiling had let eat the window. The HTTP
  client aborts its `fetch` on the same signal, and a cancel is never reported as a timeout.

- **The MCP editor can configure an HTTP server — URL and headers are fields now.** It had only Command / Args / Env,
  so a `url` server existed only if you hand-edited `config.json` — while the README promised "a command (stdio) **or**
  a URL (HTTP)". The form now has a **URL (HTTP)** field and a **Headers** box (`KEY=VALUE` or `KEY: VALUE`, the HTTP
  convention), and the two transports are kept honestly exclusive: typing a URL DROPS the leftover `command`/`args`/
  `env`, because the normalizer prefers `command` and a stale one would make "switch it to HTTP" silently do nothing;
  clearing the URL keeps the command it had, and a save with neither is refused rather than written as a server with
  no transport (which the normalizer deletes). Headers round-trip like env: loaded into the box, re-parsed on save, an
  emptied box clears them instead of writing `{}`.

- **A zero-install MCP server ships in the repo: `examples/mcp-hello/server.js`.** Plain Node, no dependencies, four
  read-only tools (`hello`, `add`, `now`, `search`) — it is the answer to the case that started this: when `npx` cannot
  install anything (a half-written `~/.npm/_npx` cache, an npm in a bad state), every MCP server "fails" and there is
  no way to tell the panel from the install. Point Harny at `node` + that path and the panel, the tool list and the
  gate are exercised with no network at all. `search` exists on purpose: a remote doc server only ever shows string
  parameters, so this one carries a **rich schema** — `required`, an enum, an array with `items`, a two-level nested
  object, numeric `minimum`/`maximum` and defaults — and echoes the arguments it received, normalized, so a call
  SHOWS how the model's JSON arrived (`limit: 999` → `50`, `sort: "nope"` → `relevance`, `tags: ["a", 7, "b"]` →
  `["a","b"]`). `mcp-client.test.ts` spawns the server, asserts the schema survives ingestion untouched and runs a
  tool, so the example cannot rot.

- **An MCP server's tools are now a list you can prune, one checkbox at a time.** `(N tools)` used to open a
  read-only popover: it answered "what does this server expose?" and nothing else, so a server with forty tools
  — half of them writes you never want the model to reach for — was all-or-nothing: keep it, or turn the whole
  server off. That popover is now the **tools panel**: every tool the server advertises, each with the checkbox
  that decides whether the MODEL sees it (**checked = exposed, and that is the default**, so nothing changes for
  anyone who never opens it), the name in mono, the description clamped to two lines, and a count in the header
  (`18 of 24 enabled`). Excluded rows dim, the card's key reads `(18/24 tools)` instead of `(24 tools)`, and a
  **filter box** appears once a server has more than eight tools. The choice is a DRAFT — **All / None / Cancel /
  Save** — because saving RECONNECTS the server (that is what rebuilds the tool list the model is offered), and a
  reconnect per checkbox click would respawn an MCP process each time; Save is disabled until something actually
  changes, refused while a session is working (swapping the tool list under a live turn would break it) and, on a
  failed write, keeps the panel OPEN with the draft intact. The names live in `config.json` as **`excludeTools`**
  on the server's own entry: an exclude list on purpose, so a server that adds a tool tomorrow exposes it without
  anyone editing the file.

- **Two config-round-trip bugs, found while wiring that panel — both fixed.** `normalizeMcpServers` did not carry
  the per-server declarations, so `analyze` (`read-only` / `trusted`, documented in the README and the only thing
  standing between Analyze and an external call) was **dropped on every read AND every write**: a policy set in the
  file never reached the manager, and any save from the panel deleted it. And the editor rebuilt a server from its
  OWN fields, so saving one stripped `analyze` and turned an **HTTP** server (no `command`) into a broken stdio
  entry — a save documented as "lossless" was in fact lossy in two directions. Both now go through
  `McpServerCommon` (`enabled`, `analyze`, `excludeTools`) and the editor spreads the entry it was given, so what
  it does not manage survives it. `excludeTools` is sanitized on the way in (trimmed, de-duplicated, unknown values
  dropped) and an empty list is **deleted** rather than written as `[]`.

- **The session trash asks ONE question with THREE answers: delete / rewind / empty.** It used to ask a plain
  yes/no ("Delete session X? This removes its transcript and settings"), which is the wrong question for the case
  that actually comes up: a session that grew too big, where throwing away the _state of the work_ is a last
  resort and the usual intent is "start over, but keep what we decided so far". Clicking 🗑 (in the sessions list
  and in the All-sessions manager alike) now opens one in-panel dialog with the three outcomes spelled out:
  **Delete** removes the session, transcript and settings included; **Rewind** keeps everything up to the
  session's **first compaction summary** and drops everything after it — the transcript then ENDS on that state
  document, which is exactly where the model's window opens, so the session continues from its condensed past
  with a nearly empty context; **Empty** keeps the session (name, per-session settings, tab and position) and
  drops only the whole transcript. **Rewind is offered DISABLED when the session never compacted**, because there
  is no summary to rewind to — shown rather than hidden, so the set of answers does not move around between one
  session and the next. Both rewrites are the same bookkeeping as a ✂ cut down to zero messages: `saveMessages`
  with `replace`, the context metric re-estimated from what is left (the summary pair for a rewind, 0 for an
  empty), the cache counters dropped since they described a prefix that no longer exists, and the vacuum
  suggestion checked. They also work on a CLOSED session (only the store is touched), and none of them is
  allowed to touch a session that is still working. Underneath, the modal is no longer a two-button dialog: the
  host sends `extraActions` (`value`, `text`, tooltip, disabled) and the webview builds those buttons at runtime,
  answering `modalResponse` with the action's own `value` — so the next question with more than two answers needs
  no new modal, only new buttons. The footer wraps for the same reason (`flex-wrap` on `.alert-actions`). One new
  pure function carries the cut: `firstCheckpointEnd(messages)` in `conversation-validity.ts`, the counterpart of
  `checkpointStart` — it lands AFTER the oldest synthetic pair, never between its halves, and returns 0 when there
  is no summary at all. The flow is also covered END TO END, host ⇄ webview, in
  `session-cleanup.integration.test.ts`: the provider runs over a real in-memory store, the page is the one
  `renderViewHtml` produces, the client is the real bundle module, and the test only CLICKS (the row's 🗑, then an
  answer in the dialog). That file exists because the two unit suites cannot see the seam: renaming the real page's
  `#alert-ok` leaves all 33 fixture-based webview/HTML tests green while the integration one goes red on all four
  cases — the failure mode this dialog could have shipped with.

- **A session switch now says that it is happening.** Neither opening a session nor switching tab is instant:
  the host rebuilds the config (`buildConfig` awaits) and may be finishing a turn, and the new state only travels
  once that is done. Until then the OLD transcript sat there looking final, so the click read as lost — which is
  how a user ends up clicking three more times. Now the transcript is covered by a soft veil (a 2px
  `backdrop-filter` blur) with a small card in the middle: a terracotta arc turning and the name of what is
  opening (`Opening “Debug”…`). It comes up the instant you click — the view names the session from the list it
  already has, so nothing is added to the very click being made feel fast — and the host also announces the
  switch (`{type:"switching", id}`) as its FIRST message, so switches it starts itself (a row, the manager, a
  branch) get the same treatment. Two details keep it honest: the veil fades in with a **120ms delay**, so a
  switch that lands quickly shows nothing at all (a spinner that flashes for 40ms is worse than no spinner), and
  an 8s safety net takes it down if the state never arrives, so a failure cannot leave a spinner spinning
  forever. It covers ONLY the transcript and never eats clicks: the strip and the session list stay live, so a
  wrong click is corrected at once. The markup gains a `#messages-wrap` (the veil's positioned parent); `#messages`
  stays unpositioned on purpose, because its children are measured with `getBoundingClientRect`.

- **Session tabs can be dragged left or right.** The strip only ever showed the sessions in the order
  they were opened, so the tab you were working on could sit at the far end of a long row and the only
  way to bring it closer was to close and reopen everything. Dragging a tab now moves it wherever you
  drop it, and the move is SHOWN before you release: the tab itself lifts out of the strip and follows
  the pointer as a tilted, shadowed GHOST (same node, so its name travels with it), while a dashed SLOT
  of exactly its width hops between the other tabs with an accent bar on its leading edge — the drop
  position is drawn, not guessed, and the tab lands precisely where the slot was. The new order is
  committed on release, one message to the host; cancelling (or a `switchView` arriving mid-drag)
  snaps the strip back. It is deliberately NOT HTML5 drag & drop: that channel is already claimed by
  the window-level file-drop handlers, which would have read a tab drag as a file drop (empty
  `dataTransfer`, the "drag-over" glow, a pointless attach attempt). Pointer events also give the two
  things a tab strip needs — a click/tap still switches session (a 4px threshold tells them apart, and
  the click a drag leaves behind is swallowed) and the strip auto-scrolls while the pointer is held
  near one of its edges, so a tab can be carried past the visible row. Host-side the order is the
  registry's insertion order, so `reorder` rebuilds it: runtimes are untouched (no reload, no
  re-render of the transcript) and a stale or partial list can never lose a tab — unknown ids are
  ignored and open sessions missing from the list are appended.

- **A tool call now wears the mark of ITS tool.** The transcript header read `🔧 Read` for every tool in the
  registry — the same wrench for `StrReplace`, for `Grep`, for `Delegate`, and for anything an MCP server
  exposed — and the thinking block opened on a 🤔. Both are gone: `media/icons/` now holds one drawing per
  tool (`read`, `write`, `strreplace`, `edit`, `shell`, `grep`, `glob`, `skill`, `todowrite`, `websearch`,
  `webfetch`, `readlints`, `thinking`), `src/chat/icons.ts` maps a tool NAME to its artwork (`toolIcon`), and
  the bubble, the working bar and the sub-agent log all ask that map. Rules worth knowing: **Delete has no file
  of its own** — it is the same drawing as the session trash, one file, so the two can never drift; **every MCP
  tool shares one mark** (the plug), because there can be any number of them and a per-server drawing would be
  noise; and a name nobody has drawn **keeps the wrench**, since a tool must still read as "some tool" rather
  than leaving a hole in the header. The thinking block's label is the brain, in both places it appears (live
  reasoning and the "thought during this answer" note). Weight is deliberately not uniform yet: most marks are
  `stroke-width 1.5`, the ones that arrived as production drawings keep their own (the trash and the swap
  arrows are 2) and `skill` is the only filled one — `media/icons/icon-sheet.html` shows them all at
  14 · 16 · 24 · 48 px on both surfaces, which is how that decision gets settled.

- **One weight for the tool marks, and the bot that was missing.** The marks had arrived in two weights — the trash
  kept the 2 it had as a row button while everything else was 1.5 — so the set is now uniform at 1.5 on the same
  24×24 grid. The one drawing that genuinely serves two families (the trash: Delete's mark _and_ the session
  row's button, where it sits next to a 13 px pencil at 2) is still ONE file: `icon()` now lets the caller
  override an artwork attribute, so the row asks for `stroke-width="2"` and the transcript gets 1.5. A second
  copy of the file was the alternative, and a copy is exactly how two marks drift apart. `skill` remains the only
  filled mark, because it came in that way — a fill is not a weight. The sub-agent/Delegate mark is now the bot
  face that came in as an SVG (head, eyes, antenna, ears, geometry verbatim), with its 20% face fill dropped like
  the replace mark's, so the glyph matches the rest of the set.

- **The TodoWrite list is now a list you can SEE.** It lived only inside the tool output: every update landed in a
  `.tool-details` that is collapsed by default, and the tool is called once per change, so the transcript filled
  with closed bubbles and the task list was effectively invisible — never in an answer, never in a thinking
  block. The result of a TodoWrite call now renders as a **Tasks block** under its tool header (`2/5` plus the
  rows), readable without expanding anything, and there is **one block per transcript**: a new update replaces
  the previous one instead of piling up stale copies. The raw output stays inside the details, where it belongs.
  Each row carries a mark from a new family of four — one box, four "baffi" (`todo-pending`, `todo-active`,
  `todo-done`, `todo-cancelled`) — so the states read as four faces of the same thing; a completed row is struck
  through with its tick tinted. Parsing keys on the `[status]` bracket, not on the emoji, so the list keeps
  working if those emoji markers ever go away.

- **…and it is pinned above the input too.** The block stops the list being invisible, but it still scrolls away with
  the conversation. The same list now also lives in a footer above the input (`2/5 Tasks` + the rows), fed by the same
  parser and the same rows — one builder, two views, so they can never disagree about a task. It is hidden until the
  model writes a list, mirrors every update instead of appending, clears on a session switch (a refresh re-fills it
  from the transcript, so a reload shows it again), and the list scrolls inside its own box so a long one can never
  push the input off screen.

### Changed

- **One reader for the MCP payload's flags** (`webview/mcp-tool-flags.ts`): the card's `(N/M tools)` count and the tools
  popover's starting draft both read `off`/`analyzeFlag`, and each carried a copy of the rule.

- **A DOM contract test between the modules and `view-html`**: splitting `view.ts` moved the code that WRITES classes
  away from the file that DEFINES them, with nothing linking the two at compile time. Every class a module writes must now
  be either STYLED in `view-html.ts` or a HOOK something selects (a `querySelector` in a module or a test); anything else
  is a name nobody uses. It also fails if a new module writes DOM without being listed, so the check cannot rot.
  Writing it found four things on the first run — including my own regex bug (`querySelectorAll?` means
  `querySelectorAl` + optional `l`, so plain `querySelector(` never matched, and the hook side was silently empty).

- **The MCP editor is its own module too** (`webview/mcp-editor.ts`, 277 lines, 98.7% covered): the local draft of the
  server map, the form, Test and the save as the WHOLE map. Two rules are pinned because an extraction is exactly where
  they get lost: the keys the form does NOT edit (`analyze`, `excludeTools`, anything else) SURVIVE a save, and switching
  a server to HTTP DELETES the leftover `command` (the normalizer prefers it, so the switch would silently do nothing).
  Coverage 98.7%; the two uncovered lines are null guards over a list that cannot hold them.

- The extraction arc, in total: `view.ts` **7.512 → 6.675 lines** (−837), with five modules that each own a concern and
  carry their own tests — `find` (97%), `mcp-card` (100%), `mcp-tools-popover` (96.5%), `mcp-editor` (98.7%).
  The router-contract test now scans every module, so a route cannot move out of `view.ts` unnoticed.

- **The MCP tools popover is its own module** (`webview/mcp-tools-popover.ts`, 336 lines, 96.5% covered): the draft, the
  filter, the counts, the two controls per tool (the session's checkbox and the Analyze shield with its inherited/inert
  states) and the Save as INTENT. `busy` is a **getter**, not a boolean: the popover outlives the moment it was built, and
  the Save is the one button whose job is to refuse while a run is in flight — a captured flag would go stale exactly then.
  Writing the tests was worth it twice: a transcription slip had left `syncShield()` uncalled (the shields existed with no
  class, so they were invisible AND unfindable), and a line-based edit had silently deleted the assertion on the session's
  intent — both found by a mutation that did NOT bite. `view.ts` is now 6.869 lines (−311 in this phase; 7.512 → 6.869
  across the three extractions).

- **The MCP card is its own module** (`webview/mcp-card.ts`, 204 lines, **100% covered**): one row per installed server, the
  SESSION switch, the `(N/M tools)` button and the status line, with the redraw signature that keeps the rows from being
  rebuilt under the cursor. `view.ts` keeps the tools popover (a draft with its own state), the editor modal and the
  messages; the card takes a `post` callback and an `openTools` hook.
  The busy flag is read **at click time**, not when the row was built: rows survive a run starting, so a captured flag
  stayed live for ever — the NAME is a plain span that cannot be `disabled`, which made it the real hole (a stale closure
  posted `toggleMcpServer` mid-run). Both are pinned, and the switch's own guard is proven with a dispatched click.
  The router-contract test now scans **every** webview module (it caught `setToolScope`/`toggleMcpServer` moving out of
  `view.ts` the moment they did).

- **Find is its own module** (`webview/find.ts`, ~300 lines): the bar's state machine, the scan and its 500-match cap, the
  two highlight layers, the navigation, the debounce and the rescan that follows the transcript. It takes its elements as
  parameters and one injected callback (`reveal`, opening a folded section so a match is visible), so it is testable on its
  own — `find.test.ts` covers the cap, the timers (armed, replaced, disarmed, fired), the no-Highlight-API fallback and the
  caret rule. `view.ts` keeps only the wiring that belongs to the panel: the elements and the ⌘F chord.
  Writing those tests found two real things: the engine painted highlights for a bar that was not on screen (a
  programmatic write to the field, or a debounce landing after Esc), now guarded; and one view test had been green while
  NEVER opening the bar (it computed the chord's modifier with a different regex than the app's `isMacPlatform`, which also
  knows `darwin`) — it now opens through the host route, and the chord stays covered by the platform tests.

- **The tool scope has ONE spelling, and it lives on the host.** The panel used to rebuild `mcp__server__tool`
  prefixes to compare them with the session's list — two spellings of the same truth, which is how a server named
  `files-extra` (registered as `files_extra`) could never be switched on. Now the host decorates each tool with
  `off: true` when this session has it switched off, and the panel sends back **intent** (the names it wants enabled):
  turning that into scope names, sanitizing them and merging them with every other decision is the host's job. The
  webview no longer imports the naming rule at all.

- **One owner for "what is inert while a run works".** The policy lived in seven functions across three call paths, which
  is how the same bug was reported four times in two days (each fix right, each landing on one path). It is now a
  declarative table (`LOCK_TABLE` in `view.ts`): one row per control, a predicate for when it locks, an optional tooltip.
  Adding a control is one line of data instead of a search through the file. Two axes, named: `activeBusy` (the session on
  screen runs — anything that would change the request it already sent) and `anyBusy` (reserved; nothing is machine-wide
  today). A control that is never locked says so (`never`) rather than being absent. A twenty-row test table pins the
  behaviour across three scenarios plus a run started from the panel — written FIRST, as the net for the refactor, and
  verified to fail on three different rows.

- **Icons and glyphs are graphic ASSETS now, not markup buried in the code.** Every icon the panel draws used to be an
  SVG string inlined in the middle of a template literal (twenty of them in `view-html.ts`) or in an `ICON_GLYPHS`
  record inside the webview bundle — so the only way to redraw one was to edit TypeScript, and the same gear appeared
  four times, character for character, with no single place to change it. The artwork now lives in `media/icons/` as
  one file per icon — ONE flat folder, chrome and transcript marks together, because the split between "ui" and
  "glyphs" was a judgement rather than a fact and the sub-agent mark kept landing on the wrong side of it — and the
  code only asks for a name and a size: `icon("gear", 14)`. `src/chat/icons.ts` is the single registry in front of them,
  typed, so a typo in a call site fails `npm run typecheck` instead of rendering nothing. The files are still
  **inlined at build time** (esbuild `loader: {".svg": "text"}`, and an svg-as-text plugin in vitest so the jsdom
  tests keep asserting on the real markup): no runtime fetch, no `asWebviewUri`, no CSP entry to add, no async
  render, and nothing new to ship — `media/icons/` is excluded from the VSIX precisely because it is inlined. The
  file badge keeps being per-extension data: its colour and label are substituted into the artwork template at
  render time (and the label is now escaped, which it was not). `media/icons/README.md` states the drawing rules —
  24x24 viewBox, no `width`/`height` on the root, `currentColor` everywhere, no ids or gradients, comments allowed
  because they are stripped — so a restyle is a matter of opening that folder, not of searching for `<svg`.

### Fixed

- **The suite no longer mirrors the HOST's OS.** `jsdom` derives `navigator.userAgent` from the machine it runs on
  (`darwin` on a Mac, `linux`/`win32` on CI), and the fixture "reset" it with `delete navigator.userAgent` — a **no-op**,
  because `userAgent` is a getter on the prototype. So the ⌘/Ctrl matrix and the Chrome-only context-menu suppression were
  green on macOS and **red on Ubuntu and Windows**, while the non-macOS branches of `isMacPlatform()` were never executed
  anywhere. The platform is now PINNED in the fixture (a known macOS UA), a guard test asserts the pin itself — so
  removing it turns red wherever it runs — and the non-macOS behaviour (Ctrl only, native menu kept on controls) has its
  own tests instead of happening by accident.

- **The models gear is locked while THIS session works.** It stayed clickable during a run, so it opened the manager and
  offered a model switch for a request already sent — the trap the model dropdown and the mode pills already refuse. The
  lock follows the session you are looking at, not the machine: another session's run no longer freezes your gear, while
  the sessions manager stays reachable either way (a blanket lock would have made it unreachable on a busy day). It is
  derived from the streaming flag AND the working set, because at bootstrap only the latter is known — and the lock is
  applied from `setStreaming` itself, the one point every way of starting a run passes through (the optimistic Play path
  never sends a `status` message, which is why the first version of this fix left the gear clickable for a run started
  from the panel). The **MCP gear** follows the same rule for a stronger reason: saving a server reconnects it and swaps
  the tool list under the turn that already received it, so it is inert while THIS session works (and stays reachable
  while another one does — it is not a per-session control). Both entry points also guard the handler itself, so a future
  caller cannot bypass the disabled state.

- **A reasoning-only model can no longer brick a session.** A turn that ends with neither text nor a tool call (only
  thinking — common with `…reasoning:free` models) left an empty assistant message in the conversation, and the
  replayability check then refused to send ANY further request: the session was dead for good, with an error that said
  "bug in Harny". That one rule is now **repaired instead of refused** — an empty assistant turn carries no information,
  so it is dropped before sending — while the other wire rules keep refusing, because there the missing half is real
  data and the fault is the only signal that names its producer.

- **Toggling one MCP server no longer stirs the whole card.** Two separate causes, reported as one symptom ("they all
  move around"). **(a)** the toggle saved the flag and called `connect()`, which disposes EVERY client and reconnects
  every server: clicking one row killed and respawned the other `npx` processes, and their status churned with them.
  `connect(only?)` now reconnects one server — closes just that client, drops just its tools by prefix, removes just
  its status — and re-sorts the statuses into the config's own key order, so a row can never jump to the bottom. The
  toggle and the tools panel pass the name; a save from the editor (any server may have changed) still does a full
  pass. A `pid` tool in the tests proves it: the untouched server answers with the SAME pid afterwards. **(b)** the
  row carried the error text in a wrapping span, and an npm log (or an HTTP body — the messages got much longer with
  the new diagnostics) wrapped to three lines and pushed everything below it. The row is ONE line now (`flex`,
  `nowrap`, `ellipsis`, `min-width: 0` so it can shrink) with the full text in the tooltip, and the list is no longer
  rebuilt when the mcp section is unchanged: config pushes are frequent (metrics, tokens), and re-creating the rows
  under the cursor also made a click land on a node that had just been removed.

- **An MCP server that dies now says WHY — and, when we recognise it, what to do.** The exit message was a
  `stderr.slice(-300)` of the tail, so a failing `npx` install (npm prints the cause FIRST and the echo LAST) reached
  the panel as `MCP server exited (code=190 signal=-): y not empty, rename '…/content-disposition' -> …` — the middle
  of "directory not empty", with the one line that names the fault (`npm error code ENOTEMPTY`) cut off. The client
  keeps **both ends** of stderr (4 KB head + 2 KB tail), builds a bounded message out of them, waits for `close` when
  it comes before the `exit` report, and appends a **remedy** for the failures we can name: `ENOTEMPTY` / `~/.npm/_npx`
  → "run `rm -rf ~/.npm/_npx` and Test again", `EACCES` → check path and permissions, `ENOENT` → not on PATH. The
  same for HTTP: a non-2xx answer used to be dumped raw (`HTTP 503: {"jsonrpc":"2.0","error":…,"id":null}`); it is
  now one line — the message EXTRACTED from the JSON-RPC error, a web page named for what it is, plus the cure for
  401/403 ("put the credentials in the Headers box"), 404/405 (wrong path) and 429 (rate limited).

- **A server that died AFTER connecting stayed green with its tools still registered.** `onExit` existed on the stdio
  client and nobody subscribed to it: after a crash the card kept saying ok, the tools stayed in the registry, and
  every call failed with "MCP server is not running" until someone reconnected by hand. The manager now marks that
  server down (with the real exit message), withdraws its tools **by prefix** and lets the registry re-register; a
  deliberate `close()` marks the client `disposed`, so a reconnect is never mistaken for a crash.

- **The MCP `inputSchema` was rebuilt instead of forwarded.** Only `type`, `properties` and `required` survived, so
  `oneOf`/`anyOf`, `additionalProperties`, `$defs`/`$ref` and defaults were dropped — a schema using a `$ref` arrived
  pointing at nothing. It is passed through now (`type: "object"` and a `properties` fallback are still ours), which
  is what the spec asks of a client.

- **Two MCP tools could silently collapse into one.** `a-b` and `a_b` sanitize to the same Harny name
  (`mcp__server__a_b`): the registry kept the first and the second vanished without a word. The collision is logged,
  the first wins, and the count on the card says what the model actually gets.

- **`Test` demanded a command, so every remote server was untestable.** With the URL filled in and the command
  legitimately empty, the panel answered "Enter a command first". It now accepts either transport; the editor's
  **Save** is also refused while a run is working, because saving reconnects the servers — the guard the name toggle
  and the tools panel already had.

- **`McpManager.connect()` is serialized.** Activation fires `void mcp.connect()` and the UI fires its own (a save, a
  toggle, the tools panel): two passes could run at once, each calling `dispose()` and killing the other's handshake
  mid-flight — and two concurrent spawns of the same `npx -y <package>` extract into the SAME `_npx` cache entry,
  which is one of the ways npm reaches the `ENOTEMPTY` above. Calls now queue, and a failed pass cannot block the next.

## [0.8.2] - 2026-10-23

### Fixed

- **The session list is no longer emptied by switching tabs, and tabs keep their names.** The host
  re-sends the list only when it really changes (create, rename, branch, delete, opening from a row);
  on a plain tab click it omits it, and the omitted list means "keep the one you have". The webview
  turned that omission into `[]` — which is TRUTHY — so EVERY click emptied the list, and with no id
  left to look up every tab fell back to the generic "Session" label: two symptoms, one coercion. The
  old tests could not catch it because they posted an explicit `sessions: []`, i.e. they exercised the
  other branch; the new one posts a payload with no `sessions` key at all, which is what the host
  actually sends.
- **The × on a tab sits on the tab's right edge.** The close button used to hug the end of the name,
  so tabs of different widths had their × at different distances from the edge. The label now takes
  the free space (`flex: 1; min-width: 0`), which also keeps a long name ellipsizing correctly.

## [0.8.1] - 2026-10-23

### Fixed

- **The prompt size is re-based when a provider reports the cache OUTSIDE `prompt_tokens`.** Two
  conventions coexist on the wire (OpenAI: `prompt_tokens` INCLUDES the cached subset; Anthropic:
  reads arrive separately as `cache_read_input_tokens`, which this provider already summed). A third,
  mixed shape exists — a gateway that sends the UNCACHED prompt as `prompt_tokens` and the cached
  count as a subset field — and there the two numbers sit on different bases, so `cached` exceeds the
  prompt we counted and every ratio built from them is impossible (a "cache 100%" that is an artefact,
  not a fully cached turn). The anomaly is the detector (a SUBSET cannot exceed its whole), so the
  base is corrected without knowing which provider is talking; the same total keeps `total_tokens`
  consistent. This is not cosmetic: that number is what the context bar shows and what triggers the
  automatic compaction, and an understated context compacts TOO LATE.

## [0.8.0] - 2026-10-23

### Added

- **`SessionLiveState`** (`src/chat/session-live-state.ts`): the per-session recorder of the
  in-flight turn — thinking/answer, tool calls with a capped copy of their output, sub-agents with
  their status (`queued`/`running`/`done`/`failed`/`aborted`) and their nested log. Bounded by
  hard caps (40 tool calls, 200 nested events, 2 KB per output) because with many sessions open
  this state must not grow without limit. It is pure — no vscode, no view — and unit-tested
  directly.
- **`SessionEngine`** (`src/chat/session-engine.ts`): ONE per open session, created by the
  registry, owning that recorder and the `projection()` the view is rebuilt from. Extraction step
  #1 of the strangler plan that moves `send` / `abort` / queue / compaction out of
  `ChatViewProvider`. Its `projection()` also drops the tool calls the history ALREADY contains
  (the batch commit is asynchronous): without that dedupe a rebuild would paint a bubble twice.
- **`liveTurn`** travels with `switchView`, `refresh` and the initial page state. The view
  replays the in-flight bubbles with the SAME builders the live events use, keeps them registered
  in `pendingToolCalls` (so the events still arriving keep updating them instead of being
  dropped for lack of a bubble), and places the live text correctly — a preamble written before
  the Delegate calls stays ABOVE them, an answer written after a tool result goes BELOW — via
  `textAfterTools`.

- **ONE global cap on LLM requests (8 in flight), shared by every session and every sub-agent.**
  The per-session sub-agent cap MULTIPLIES: ten open sessions with Parallel on and a cap of four are
  forty requests against the same provider key — a self-inflicted 429 storm, where the agent backs
  off, the run stalls and the user reads it as a network error. The per-session cap still says how
  wide ONE run may fan out; this bounds what the whole extension asks of the provider at once. It is
  a FAIR FIFO gate (a chatty session cannot starve the other nine), the slot covers the WHOLE stream
  (`yield*` forwards `return()`/`throw()`, so an early `break`, an error and an aborted signal all
  free it), and a request whose signal aborts while QUEUED never reaches the provider at all.
  Installed on the provider FACTORY, which is the only seam reaching every turn: the agent builds a
  provider per turn, so a cap on a provider instance would cover one request.
- **The context-token metric is coalesced, not written per turn.** It was one `saveSettings` — a
  synchronous, single-threaded SQLite transaction (upsert + a count query) — on EVERY usage report,
  i.e. every turn of every session: ten streaming sessions meant ten transactions per turn for a
  number the UI reads from MEMORY and the next turn recomputes anyway. Now a burst collapses into one
  write of the LAST value (400 ms), and the write happens immediately when the run ends, when the tab
  is CLOSED (before its runtime disappears) and on `dispose()`. A metric must never take a run down,
  so a failing write is logged and swallowed.
- **`ChatViewProvider.dispose()`**, registered on the extension context: it stops the telemetry probe
  (it used to keep sampling a host that was going away), clears both coalescing timers, and flushes
  the pending metric while the store is still open. The one-shot startup vacuum check is no longer a
  floating `setTimeout`.

- **The prompt and its attachments belong to the SESSION, not to the panel.** Switching tab used to
  drop the attachment chips while KEEPING the typed text — the worst of both: your files vanished and
  a draft written for another session followed you around. Both are now parked per session and
  restored when you come back (chips, thumbnails and sizes included); sending consumes that session's
  draft, and closing/deleting a session frees it. The TEXT also survives a webview reload via
  `setState`; attachments do not, because a pasted image can be a 15 MB data URI and that is not
  what the webview state is for.
- **A session you come back to is where you left it.** Scroll position and open sections lived only
  in the page, and every switch (and every run-end refresh) rebuilds the transcript from history: you
  were always thrown back to the end with everything folded. Both are now remembered per session. The
  rule respects what you were doing: a session you were FOLLOWING stays pinned to the bottom (the
  live turn keeps growing), one you had scrolled up returns to that exact offset. Sections are keyed
  by their position in the transcript — appends only ADD at the end, so the indexes stay valid across
  a rebuild — and the live streaming block is deliberately excluded: it follows the stream, never the
  saved state. The `refresh` path keeps its scroll ANCHOR (which survives content growth better than
  an absolute offset) and takes only the sections from here. A transcript that SHRANK — a compaction,
  a ✂ cut, a branch — was rewritten in the middle, so the positional keys no longer point at what
  they did: the saved set is DROPPED (sections come back closed, the default of a fresh session) and
  the scroll is kept. Guessing is the one outcome worth avoiding: opening a section nobody asked for
  is worse than closing the one you were reading. The size is tracked PER SESSION, so switching from
  a long session to a short one is not mistaken for a rewrite.
- **Telemetry for the multi-session questions.** Set `HARNY_DEBUG` and one line every 30 s reports
  what decides the NEXT optimisation: the **event-loop lag** (p95/max — in a single-threaded host
  everything shares that thread), the **webview traffic** (messages and approximate bytes), and the
  **SQLite write timings** per operation (count, avg, p95, max — the store is synchronous, so a slow
  COMMIT is a stall for every other streaming session). Idle windows print nothing; with the flag off
  the cost is a timer tick and two counters.
- **The webview→host message CONTRACT is now a test.** The boundary is untyped in both directions —
  the webview writes `postMessage({ type: "x" })`, the provider answers with `case "x":` — so a typo
  or a forgotten route fails SILENTLY: the click does nothing and nothing throws. `router-contract.test.ts`
  reads the two sources and asserts both directions: every type the webview POSTS has a route, and
  every route is producible from the webview (no dead routes left behind by a removed feature).
  Today's inventory is already consistent (51 posted types, 55 routes), so the test is a guard rather
  than a fix. The parsers are brace/paren-matched — a nested `data: { … }` payload must not truncate
  the read — and they are **mutation-tested**: synthetic sources prove a typo and a dead route are
  both caught, and a real mutation on the product files confirmed the failure message NAMES the
  offending type.
- **The measurement is a TEST, not a profiler session.** Two measured suites print their numbers and
  assert on SHAPE (O(1) vs O(n)) with generous absolute ceilings, so they run in CI and survive a
  slower machine:
  - `sqlite-store.perf.test.ts`: an append costs the same at 20 and at 400 messages (0.06 ms at both —
    no whole-history rewrite), 20 sessions × 15 turns of `saveMessages` + `saveSettings` take ~29 ms in
    total, reading 300 messages back takes 0.3 ms. **Verdict: the store is NOT the wall — the writer
    stays on the host thread, and that decision now has a number behind it.**
  - `session-live-state.perf.test.ts`: 100 000 events across 20 sessions cost 8 ms (0.08 µs/event), a
    normal 2000-event turn costs 0.06 ms, the caps hold after 3 MB of runaway tool output, and the
    projection that crosses to the webview stays around 90 KB.
- **The recorded live turn is freed on `done`/`error`** — the recorder already resets itself when the
  run ends, so an idle session holds nothing. (The earlier claim that it kept ~80 KB until the next
  send was wrong; a test now pins the real behaviour.)
- **The handshake between the global cap and Stop is tested end to end**: a request parked in the
  semaphore's queue, then `abort()` → `done`, no `error` event. The two modules are coupled by the
  error NAME (`"AbortError"`); if it ever drifts, a normal Stop turns into a red "provider failed"
  bubble, and this test fails first.
- **A draft's ATTACHMENTS now survive a webview reload too.** Only the typed text used to be kept in
  the webview state, so a window reload silently dropped the files you had picked (the worst kind of
  loss: they are not on screen, so nothing reminds you). The state now carries the files per session
  as well, with an explicit BUDGET: a file's payload (a pasted screenshot is a data URI) is kept only
  up to 256KB. Past that the chip is still there — name and size — but marked ⚠ and `needsReattach`,
  and sending it is REFUSED with a visible note instead of shipping an empty attachment the model
  would read as a real file. `drafts` keeps its old `{key: text}` shape, so a state written by an
  older version still loads.
- **The webview test harness now keeps its `setState`.** It used to be a no-op, which made the whole
  persistence path untestable: a test could seed a state but never see what the view wrote. It now
  stores, and `reloadView()` rebuilds the DOM and re-imports the module while the state carries over —
  a real reload, so the save/restore ROUND TRIP is what gets tested. (The fresh DOM matters as much
  as the fresh module: re-importing alone left the old instance's click listeners on the same buttons,
  and one click ran two views.)

### Changed

- **`StreamTee` is a pure ROUTER now.** It records every open session's events into that
  session's engine (`rt.engine.live.apply`) and forwards only the ACTIVE one to the view; the
  shared buffers and their `liveOf`/`clear` API are gone. Recording is deliberately NOT gated on
  "active": that gate was the bug.

- **The engine's port split in two, because the old one over-served it.** `SessionEnginePort` had 17
  methods and `abort()` used two of them (the other fifteen were for `send`), which forced every
  `abort` fake to implement a stand-in — the defect was visible in this module's own test, where
  `{ ...port, clearQueue }` existed only to silence the compiler. It is now `SessionSendPort` (14,
  also dropping `postError`, which the engine never called) and `SessionAbortPort` (2). The host still
  builds ONE object (`SessionSendPort & SessionAbortPort`), so no call site changed shape.
- **The RUN moved into the engine: `send` and `abort` live there now.** The sequence — prepare the
  agent, validate, build the prompt, compact, clamp the budget, reset the live turn, start the run,
  post the status, refresh only if the session is still the visible tab, evaluate the post-response
  fill — IS the contract, and it now sits in one place that can be exercised with a fake port and no
  vscode (`session-engine.send.test.ts`, 13 tests; `session-engine.ts` at 100% line coverage). The
  host keeps what belongs to it — prompt building (attachments, `/skill`, modalities) and the view
  posts — behind an explicit `SessionEnginePort`. Two behaviours moved verbatim, with their
  ordering comments: the status is still posted AFTER `agent.send` (so the row locks from the first
  instant) and `/skills` still never triggers a compaction. The interruption notice
  (`❌ ⏹ Processing interrupted.`) now lives next to the history it writes, `uiOnly` included: a real
  assistant message there would split a turn's `tool_calls` from its results, which every provider
  rejects on every later request.
- **The session's RUN facts moved to its engine.** `sending` and `compacting` were two `Set`s on
  `ChatViewProvider`, and `agent.streaming || sending.has(id)` was repeated in five places (the send
  guard, `isWorking`, the switch payload, the live lines, the initial HTML). They are now
  `engine.sending`, `engine.compacting` and ONE `engine.working` predicate that everything reads — the
  same question answered once. That duplication is exactly how the destructive row actions ended up
  enabled during a send preamble: two of the five copies had been fixed, three had not.
  No behaviour change: the 1793 tests that existed before this move pass untouched (only the four
  that reached into the private Sets now drive `engine.beginSend()` / `beginCompaction()`, which is
  the honest way to say what they simulate).
- **The two setup gears stay USABLE while sessions work.** A blanket lock meant that with several
  concurrent runs you could never open the managers again. What is destructive stays locked where it
  lives: the rows of a working session (branch/rename/delete), and now the providers **save** itself,
  which the host refuses while anything streams — a provider edit rewrites the endpoint/key that
  every open run resolves on its NEXT request.
- **Config pushes are gated on the ACTIVE session and coalesced.** Every session reports token usage
  at every turn; a hidden one used to rebuild and post the whole config for numbers nobody could see.
  The noisy callers (usage, background compaction) now skip the push entirely when they are not the
  active session, and bursts collapse into one build+post.
- **A plain tab switch no longer re-sends the sessions list.** `currentFolderSessions()` is a
  `SELECT *` on the session table and it ran on every click; the list only changes when a session is
  created, branched, renamed or closed, and those paths still send it (`undefined` now means "keep
  the list you have").

### Fixed

- **A session open in a tab can no longer vanish from the list.** The main list is the current
  folder's, which is right — but an OPEN session was filtered out by the same rule, so switching the
  workspace folder (or opening a cross-folder session from Manage) left a tab you could not get back
  to, next to an empty list saying "No sessions yet. Create a new session." — a lie about the session
  sitting right above it. The list is now the folder's sessions PLUS every open session that lives
  elsewhere (dimmed, its folder in the tooltip), recomputed on open too since opening can add a row.
  Name uniqueness stays scoped to the FOLDER (`sessionNameTaken` keeps reading
  `currentFolderSessions`), so two folders may still share a name; and the empty state now says "No
  sessions in this folder", which is true in every case.
- **A finished session no longer stays "working" (and its tab × no longer stays locked).** Two
  defects added up, and the screenshot that reported it was right about both. First, the end-of-run
  report was fired from INSIDE the send lock (`working = sending || agent.streaming`), so the session
  was published to the view as still working — and nothing ever corrected it: the run's last event had
  already been consumed. `workingIds` drives the tab ×, the row actions and the working indicators, so
  a stale set locks them for good. The report now happens with the lock ALREADY released. Second, the
  recorder's `summary()` invented a `{kind:"working", label:"working…"}` phase for an EMPTY recorder —
  and `done` empties it, so the last thing a finishing session did was label itself "working…". The
  assumption in its comment ("callers ask only while it works") was false: the router asks on every
  event. Both paths are gone: the per-session live line, the tab/session-list label and the "Running
  now" panel were removed at the user's request, and `summary()` went with them — the recorder keeps
  exactly what the view is rebuilt from (`projection()`), and `workingIds` stays as the single source
  of "this session is busy".
- **A session that kept working while you looked elsewhere no longer forgets what it was
  doing.** The transcript is rebuilt from `getMessages()`, and the assistant turn — tool calls
  included — reaches the history only when the WHOLE tool batch completes, in ONE atomic
  `addGroup` write (`agent.ts`). In Parallel that batch can run for minutes, so switching tab (or
  letting the webview reload) rebuilt the view from a history that did not contain the Delegate
  calls yet: the "Working…" bar survived, the sub-agent bubbles did not — and they only appeared
  after Stop, because stopping is what forces the batch to commit. Two causes, both fixed: the
  live state was TEXT-ONLY (`liveThinking`/`liveAnswer`), and every non-text event
  (`tool_call`/`tool_result`/`subagent_start`/`subagent_event`) was forwarded only
  `if (active)` and never recorded, so it was gone the moment that session stopped being the
  visible tab.
- **The ⏹ you already pressed stays pressed.** Aborting ONE sub-agent was UI state only: switching
  tab and back rebuilt the bubble with an ENABLED abort button, as if the request had never been
  made (the host no-ops a dead id, so nothing bad happened — the panel just lied). The request is
  now part of the recorded call (`abortRequested`) and the replay restores the pending, disabled
  button. Two related leaks fixed in the same path: the nested tool-line map is released on every
  rebuild instead of keeping detached nodes, and a replayed sub-agent log is painted immediately
  instead of waiting for the next animation frame.

- **A session being PREPARED can no longer be edited away.** "Busy" meant `agent.streaming` only, so
  during the SEND PREAMBLE (attachment build, pre-request auto-compaction — seconds, not milliseconds)
  branch / rename / delete / truncate looked enabled and were refused only by the host's silent
  guard; the runtime they would have mutated already had a run on the way. `workingIds` now uses the
  same `isWorking` as the send path — streaming, or preparing a send, or draining the queue — so the
  tab ×, the row actions and the manager all agree with the host.
- **Switching tabs can no longer show you the wrong session.** `postSwitchView` awaits the
  config build, so two quick clicks were two switches in flight: the older one could land LAST
  and paint the tab you had already left — with the config of the current one (model, mode,
  Parallel, window). The host now drops a stale switch (`switchSeq`, kept SEPARATE from
  `configSeq` so an unrelated config push cannot invalidate a legitimate switch) and the webview
  ignores a switch older than the one it has applied.
- **A sent message stays visible while its PREAMBLE runs.** The attachment build and the
  pre-request auto-compaction happen BEFORE `agent.streaming` flips: coming back to that session
  showed an idle transcript — no working bar, unlocked input — while the host considered it busy.
- **Compaction is per session.** The "is a compaction running" flag was GLOBAL: Compact on B was
  a silent no-op while A was summarizing, B's auto-compaction was skipped, and returning to a
  compacting session showed nothing (the "● Compacting…" bubble is DOM-only and was left
  pointing at a detached node, so it never came back). The flag is now a set of session ids, the
  bubble is restored from the per-session state on switch, and the node reference is released on
  every rebuild.
- **Streamed messages say WHICH session they belong to.** A delta of the session you just
  switched to can arrive before its `switchView` (the switch awaits a config build): it is now
  dropped by the view instead of being drawn into the tab you are leaving. Nothing is lost — the
  switchView replays that session's whole live turn.

## [0.7.1] - 2026-10-22

### Fixed

- **A warning in the Problems panel, gone.** The manifest declared
  `onView:harny.chatView`, which VS Code and VSCodium have generated _implicitly_ from
  `contributes.views` since 1.74: the `package.json` schema flagged it as removable, so every
  checkout showed a permanent warning on line 51. It is now declared nowhere and still fires — the
  editor registers the implicit event before it activates the extension, which is exactly what the
  hand-written one did. `onStartupFinished` STAYS: no contribution generates it, and it is what wakes
  Harny up at startup for `harny.autoOpen`.

## [0.7.0] - 2026-10-22

### Added

- **Harny keeps its own look in BOTH themes — it no longer lives only in the dark.** The panel used
  to carry ONE hardcoded palette, so changing the editor theme did nothing to it. It now carries TWO
  palettes with the same role names (terracotta on anthracite, terracotta on warm paper) and asks the
  editor only WHICH one is live: VS Code stamps the theme KIND on the webview body (`vscode-light`,
  `vscode-dark`, `vscode-high-contrast`, `vscode-high-contrast-light`) and swaps that class on a
  theme change **without reloading the page**, so the panel re-skins instantly — no host round-trip,
  no lost prompt. Dark is the BASE rule, not a branch: a page with no class (unit tests, the very
  first paint before VS Code adds its own) gets the palette Harny always had. `color-scheme` rides
  along, because it is the part CSS cannot fake: it is what makes the browser draw NATIVE widgets
  (the provider `<select>`, the sliders, the search fields' clear button, the scrollbars) in the
  right scheme instead of always-dark.
- **`harny.theme`** (`auto` | `dark` | `light`, default `auto`): follow the editor, or PIN one palette
  so the panel keeps its look when the editor is the other kind. The pinned class is emitted on the
  body and wins over the editor's by SOURCE ORDER — the one invariant that makes the setting work at
  all, and a test guards it.

### Changed

- **The manifest now declares the API version it actually requires.** `devDependencies` asked for
  `@types/vscode: ^1.85.0` while `engines.vscode` said `^1.101.0`: the floor was two years older than
  the minimum supported editor, so a fresh checkout could happily compile against types the extension
  is not allowed to use. They now agree, and `npm ci` installs the same types as before (1.140).
- **The Settings UI shows ONE setting: the theme.** Opening _Settings_ from the extension used to list
  eleven keys — the provider preset, the API key, the base URL, the model, the token budget, the
  sampler, the thinking knobs, `autoOpen` and the two DB thresholds — next to a panel that already has
  a form for each of them (and a `config.json` the panel writes). They were removed from
  `contributes.configuration`, so `@ext:spltek.harny` now returns the palette switch alone. Nothing
  breaks for an existing setup: the keys are still READ from `settings.json` (User or Workspace) with
  the same defaults (now supplied by the code, which also clamps them), and the panel still WRITES
  them; they are simply no longer advertised as settings.
- **Every colour in the stylesheet is now a ROLE, defined twice in `view-config.ts`.** 60 roles, and a
  missing light value is a type error (`Palette` is derived from the dark object). The ~150 literals
  that had accumulated were folded into them: nine greys became a four-rung ladder (`--fg-dim`,
  `--muted`, `--muted-2`, `--muted-3`), the white-alpha overlays became `--overlay-1…4` (black-alpha
  on paper, where "a slightly lighter patch" does not exist), recessed blocks `--sink-1/2`, scrims
  `--backdrop`, the button-key shadow `--key-shadow`, floating cards `--modal-shadow`, the scrollbars
  `--scroll-thumb`, the accent tints and halos `--accent-tint*` / `--accent-line` / `--accent-glow*`,
  and the Prism tokens `--code-*` (one-dark and one-light are the two readings of the same roles, so
  a diff is readable instead of washed out). What stays literal is deliberate: what is drawn ON the
  terracotta (attachment chip, key bevels, bubble text) and what must be dark in both themes (the
  image lightbox and its scrim).
- **The light palette DARKENS the accent instead of lightening it.** `#d95f27` on white sits at
  ~3.2:1; the light theme's `#b8531d` keeps white text on a user bubble at ~4.9:1 and the accent as a
  link/label colour above 4.5:1, with the semantic hues moved to their 700-ish step (`#98c379` on
  white is 2:1, `#2f7d32` is 4.9:1).

### Fixed

- **A CSS declaration that never applied.** `.build-cta-static .build-cta-text` asked for
  `var(--fg-muted)` — a role that exists in no palette: the declaration was invalid, so the colour
  silently fell back to the inherited one. It now asks for `--muted-2`.

### Security

- **Two advisories closed in the markdown pipeline.** `dompurify` 3.4.16 → 3.4.17
  (GHSA-c6gr-qvv4-5v3f: the SMIL `attributeName="href"` guard was skipped when `PARSER_MEDIA_TYPE` is
  `application/xhtml+xml`) and `markdown-it` 15.0.2 → 15.0.3 (GHSA-vfgh-jcmw-g37q and
  GHSA-gfr2-rv44-r23c: quadratic-time DoS on inline HTML and on a single multi-line link reference
  definition). Both sit on the path of everything the model writes into the transcript, so the panel
  was rendering untrusted text through them; `npm audit` is now clean. The remaining patch bumps
  (`vitest`, `@vitest/coverage-v8`, `prettier`, `@types/node`, `ignore`) ride along, and no declared
  range had to change.

## [0.6.0] - 2026-10-22

### Fixed

- **A wide table scrolls inside its own frame instead of pushing the answer off the panel.** The
  scroll container was `display: inline-block`, so `max-width: 100%` resolved against the table's
  own content instead of the transcript: the box grew to the full width of the table and the panel
  clipped it, with no way to reach the right-hand columns. It is now `display: block` with
  `width: fit-content; max-width: 100%; overflow-x: auto` — the table keeps its natural width, the
  frame never exceeds the transcript, and a styled horizontal scrollbar makes the overflow visible.
  Covered by six assertions in `view-html.test.ts` (container rule, per-side behaviour and the
  scrollbar styling, which browsers only paint with an explicit height).

### Changed

- **“Insert prompt in Queue” instead of “Insert in Queue”.** The indicator above the prompt read as a
  fragment: insert _what_? The two-word fix makes the line self-explanatory without touching the
  behaviour — the pill still shows `Queue`, and `Steer` only while a run is active AND Ctrl/Cmd is
  held, and the webview still rewrites just the single word inside it.

## [0.5.3] - 2026-10-21

### Added

- **A Marketplace listing that can be FOUND.** The manifest had no `keywords`: the extension could
  only be reached by typing its name, never by searching for what it does. It now carries the terms
  people actually search (`ai`, `agent`, `chat`, `llm`, `local llm`, `ollama`, `llama.cpp`,
  `openrouter`, `deepseek`, `mcp`, `model context protocol`, `skills`, …), plus a `galleryBanner`
  matching the app's anthracite and a `bugs` link. The tagline sells the PROTOCOL instead of
  rehearsing the baseline: `tool-calling` and `streaming` are the price of entry for any extension in
  this category, while _"any OpenAI-compatible endpoint works out of the box"_ is the promise that
  says what the thing actually is (one wire, every provider — local or cloud). No behaviour changes:
  this release exists to put the extension on the VS Code Marketplace with a listing that does it
  justice (Open VSX, where it has been published since 0.2.0, gets the same metadata).

## [0.5.2] - 2026-10-21

### Changed

- **The modals now follow one rule, and a test enforces it: drafts commit, overlays dismiss, prompts
  name the verb.** A dialog that edits a DRAFT has `Save` + `Cancel` (Providers & Models, MCP
  servers, Compaction); a dialog whose content is LIVE, or that only shows something, has `Close`
  (All sessions, Select model, VACUUM); a PROMPT or an ACTION names what it will do (`Create`,
  `Branch`, `Rename`, `Cut`, `Delete`, `VACUUM & optimize indexes`) instead of a bare `OK`.
  `Cancel` only exists where something can actually be cancelled — the model picker said `Cancel`
  while applying the choice on click, which taught the wrong thing about every other dialog.
- **The live card says so.** The two VACUUM sliders inside _All sessions_ are global settings stored
  as you move them, in a dialog that otherwise promises nothing is applied: they now carry an
  `applies immediately` badge, with the reason in the tooltip.

### Fixed

- **Switching provider or MCP server no longer throws the edit away.** The form was loaded straight
  over whatever had been typed, with no warning and nothing to undo (the most likely reason the
  Save/Cancel pair felt pointless). The form is now committed into the DRAFT before the selection
  moves — on a switch, on `+ New` and on `Delete`, which also stops a pending RENAME from being lost
  — and nothing is written until `Save`. `Cancel` still discards the whole draft.
- **A `Save` that never gets an answer comes back.** The Providers save button disabled itself on
  click and was re-enabled only by the host's reply: if that reply was lost the button stayed dead
  until the modal was reopened. A watchdog restores it after 8 seconds.

## [0.5.1] - 2026-10-21

### Fixed

- **The `reasoning_content` 400, reproduced live and finally closed.** 0.5.0 sent the empty pass-back
  only in the `reasoning` dialect: the gateway that was actually failing (`opencode-go`) declares
  `type`, so the gate never fired. Live probes against it also proved that no "normal" shape
  reproduces the error — not the synthetic state document, not a details-only message, not the whole
  152-message history from the real database, not the real `x-opencode-session` id. The ONE shape
  that does is the request that ENDS with a `tool` result (the loop-back after a tool call) when the
  assistant turn carrying `tool_calls` left no reasoning behind:
  `[user, assistant(tool_calls), tool]` → 400 `The reasoning_content in the thinking mode must be
passed back to the API`, and the same request with `reasoning_content: ""` → 200. So:
  - the pass-back covers `reasoning` AND `type`;
  - it also switches on by itself when the HISTORY proves the upstream reasons (an assistant message
    with plaintext `thinking`), whatever the knob says — the requirement belongs to the upstream,
    not to our field names. Reasoning that came back as `reasoning_details` never triggers it: that
    is passed back verbatim, and inventing a plaintext field there is the OPPOSITE 400;
  - the thinking dialect is computed ONCE per request, so the payload (`thinking` / `reasoning` /
    `chat_template_kwargs`) and the pass-back cannot disagree about which protocol is in force.
    Proof with the real converter against the live gateway: old payload → 400
    `invalid_request_error`, new payload → 200, the only delta being `reasoning_content: ""`.

- **Cancel in the Compaction card now really cancels.** The sliders wrote straight into the LIVE state
  (`compactionThresholdPct` & co.), so closing with Cancel left the unsaved trigger behind: reopening
  showed a policy that was never stored, and a later `config` push could snap it back — the same
  click looked broken in one session and fine in the next. The modal now edits a DRAFT, snapshotted
  from the stored policy on open; Save is the only commit, Cancel just closes. The card says so
  (`Nothing here applies until you press Save`), and a regression test pins the whole round trip
  (edit → Cancel → reopen comes back on the stored values, nothing posted).

## [0.5.0] - 2026-10-21

### Fixed

- **`reasoning_content` is passed back on EVERY assistant message in the `reasoning` dialect.**
  The pass-back existed but was conditional on the message having captured reasoning, and Harny
  stores `thinking` only when it is non-empty. So any assistant message without it — a turn made
  with another model in the same session, the synthetic state document a compaction writes, the
  forced final report, a turn that reasoned zero tokens — went back without the field, and the
  NEXT request failed with `The reasoning_content in the thinking mode must be passed back to the
API`. It is now sent as an empty string when there is nothing to send, in that dialect only
  (`bool`, `effort`, `type`, `unspecified` are byte-for-byte unchanged, because an unexpected
  field where it is not wanted is the opposite 400). **Superseded by 0.5.1**: the dialect that was
  actually failing is `type`, and the shape is the tool-call loop-back.

### Changed

- **The checkpoint's label has its own colour: violet.** It used to inherit the terracotta of a typed
  prompt, which is exactly what it is not — neither a message the user wrote nor an answer the model
  just gave. It now reads as its own thing at a glance (`--summary-msg`, one palette token in
  `view-config.ts`). Only the LABEL is tinted: the summary body stays neutral, because that is the
  text to read, and the ✂ cut tab that slides up over the header takes the same violet (with a
  deeper violet on hover) instead of flashing the accent orange.

- **Compaction has a LANDING POINT instead of a fixed recent budget.** The verbatim tail used to be
  a constant — 5% of the usable window, floor 8k, cap 20k tokens — three numbers that contradicted
  each other: on a 32k model the 8k floor was a quarter of the window, on a 1M one it was invisible.
  It is now a **percentage of the usable context left after a compaction** (`Land at`, per session),
  and everything else is derived from it: the tail is whatever the summary does not take, so the
  rebuilt window cannot land above the target. The summary is paid out of the SAME budget (two
  passes, model-free), which is what removes the need for a cap.
- **Defaults, all derived:** `Land at` defaults to an **eighth of the trigger** (10% with the default
  80%, 8% at 60%) — two or three exchanges stay verbatim. It is a real slider position, and `0` is
  a real choice too — "as low as the structure allows", i.e. only the last complete turn survives.
  **"Auto" names the TRIGGER** (the automatic compaction), never the landing point. The ceiling is
  the trigger minus one — landing at or above it would free nothing and the next turn would compact
  again — and the floor is what the summary plus the last complete turn already occupy, so it moves
  with the session's own work; anything below it simply means `0`. Why not lower: the summary's own
  budget (a tenth of the span, capped by the declared output) comes OUT of the landing point, so a
  target under ~5% leaves the tail with nothing and collapses to the structural minimum. A few
  visible exchanges also sharpen the summary itself: Harny tells the summarizer what the tail
  already shows and to leave it out (`keptPreview`).
- **The Compaction card is two SLIDERS** (auto-compaction trigger + landing point) with live value
  labels, a **Default** button that restores the derived landing point, and a **preview of the
  plan**: how many messages would enter the summary, how many stay verbatim, where the window would
  land, and how many messages the summary cannot read in one request. The numbers come from the
  host, which runs the SAME planner the compaction runs — a preview that disagreed with the outcome
  would be worse than none.
- **The summary's output budget is derived per call.** The `SUMMARY_MAX_TOKENS = 8192` constant is
  gone: the budget is a share of the span it replaces, capped by the output the session DECLARES, and
  the cap travels with each call (`maxReplyTokens`). `MIN_SUMMARY_TOKENS` is now
  `SUMMARY_QUALITY_FLOOR`, named for what it is — a quality floor for the document, not a context cap.

### Added

- **Migration 2** (`compaction_target_percent`): the per-session landing point. Non-destructive, and
  `NULL` means Auto, so every existing session keeps the behaviour it has today.

## [0.4.1] - 2026-10-20

### Changed

- **"Imported from …" / "Exported to …" moved onto their own line, UNDER the buttons.** The feedback
  was a `span` inside the Providers & Models button row, so a full path
  (`/Users/…/harny-providers.json`) squeezed Export/Import and shoved Cancel/Save sideways. It is now
  a full-width `role="status"` row below the strip: it wraps long paths, and takes no space at all
  while it has nothing to say (`:empty`).

### Fixed

- **The dialogs are laid out in the PANEL, not in the viewport.** With the panel narrower than its
  width floor the window grows a horizontal bar, and the dialogs — Providers & Models, Select model,
  All sessions, MCP, Compact, name/confirm — were pinned to the viewport (`position: fixed`), which
  knows nothing about that floor: the Providers form was squeezed down to the visible slice while the
  panel below still laid out at its floor, the card re-centred every time the bar appeared, and it
  stayed put while the panel scrolled sideways. The overlay is now `position: absolute; inset: 0`
  against the body (`position: relative`), which _is_ the panel content: the card keeps the floor
  width and scrolls away together with the rest of the panel. All eight dialogs share ONE rule now
  (they used to carry eight drifting copies); each card centres with `margin: auto` +
  `max-height: 100%` — centring that survives a card taller than the screen, where the old
  `translate(-50%,-50%)` pushed the first field above the top edge and made it unreachable — and
  `overflow: auto` scrolls the DIALOG, never the window. Backdrops stay `fixed`, so they keep
  covering the visible slice while the dialog itself scrolls with the content.

- **The panel grew a second, phantom scrollbar.** `body` was `height: 100vh`, which is measured
  _without_ scrollbars: the moment the horizontal bar appeared (~15px) the body was that much taller
  than the area actually drawn, so the window also scrolled vertically. `html` and `body` are now
  `height: 100%`, which always matches the viewport the panel is drawn in; the width-floor test still
  pins `html { min-width: max(500px, 32rem); overflow-x: auto }`.

## [0.4.0] - 2026-10-20

### Added

- **Sub-agents get the same skills catalog as the orchestrator.** A delegated sub-agent now
  receives the installed Agent Skills (name + description) in its own system prompt — the same
  progressive-disclosure catalog the orchestrator has — so it can activate a skill on its own
  when the task matches one, instead of being blindly unaware of them. `disable-model-invocation`
  skills stay hidden, exactly as for the orchestrator, and an absent catalog keeps the previous
  behaviour. To keep the split honest, the orchestrator's planning rules now tell it to **steer**
  a sub-agent — naming the tool or skill it must use, in `goal`/`context`, when that matters.

- **Window trim — the fail-safe for a window that shrank under a session.** A compaction summarizes
  the span it removes, and the summarizer runs on the _session's_ model — so a span larger than that
  model's window can never be read. A session that had filled up on a big model and was then switched
  to a small one could therefore neither compact (the summary request was rejected for length) nor
  send (the request was too long), and died with an opaque error. In that case the window now moves
  **without a summary**: no model call, so it cannot fail; the state document is carried **verbatim**,
  so continuity survives; and everything it moves past stays in the session, readable and searchable.
  One rescue is enough — the span then fits and normal summaries resume. Sub-agents follow the same
  rule (they share the model), on their own ephemeral history.

- **Compaction tally** (`sessions/compaction-tally.ts`): each compaction and trim now logs its own
  event AND a running count on the same line, because the question that decides whether the budget is
  right cannot be read off a single event — _is the trim a rare rescue, or the normal path?_ The line
  to log is returned by the tally, so an event cannot be logged without being counted, and the trim
  line now carries WHY it fired (`span 41.2k > ceiling 8.9k`). It counts the mechanism, not the
  quality of a summary: it cannot tell whether the state document carried the right facts.

  **What it found on its first run.** `maxSummaryInputTokens` subtracts the summary budget (a fixed
  8,192) and the prompt reserve from the window, then floors the rest — so at 10,194 tokens or less
  the ceiling is exactly 0 and NO span can be read at all. But a non-zero ceiling is not enough: the
  span grows with the window (~80% minus the kept tail) while the subtraction stays fixed, so the
  span still loses up to roughly 28,000, and the two alternate in a transition band to ~30,000 above
  that (measured on the real functions). Below it every compaction is a trim and the state document
  is never written. The knob is now measured; scaling it to the window is NOT part of this change.

- **Loop Guard grows an `Off` state.** The guard had only three sensitivities, so a user who found the
  corrective nudges disruptive had no way to say so — every level still detected, nudged and could
  stop the run. `Off` is a real fourth preset, first in the row, and it makes the guard **completely
  inert**: no reasoning/answer detection, no per-turn classification, no nudges, no stop — _and_ no
  tool-call deduplication either, because "off" has to mean off (identical read-only calls are re-run,
  identical failures are retried). The tooltip says exactly that, and the 12 parameter sliders stay
  in place, dimmed and disabled, instead of disappearing: hiding them would change the card's height
  on every level switch, and that row is what the column-count measurement reads. `Medium` remains the
  default — pinned by a test on `DEFAULT_LOOP_GUARD_OPTIONS`, on the bare guard and on the UI.

### Changed

- **The summary request is ONE message: the data first, the instructions last.** They used to sit in
  the `system` role with the transcript _after_ them — the opposite of what long-context guidance
  recommends ("put longform data at the top; a query at the end can improve quality by up to 30% on
  20k+ token inputs"), and a shape that depends on the `system` role being honoured at all. Now:
  `<transcript>…</transcript>` and then the task, in a single user message. The tags are **closed**
  (they used to be opened and never closed), and nothing relies on the system role, so a summarizer
  that downweights it — a guard model, a small local one — still gets a task it can follow.

- **Adding a queue or a steer, converting one into the other, or cancelling one brings the view back
  to the live edge and the caret back into the prompt.** Each of those is the user talking about the
  run in progress, and each moves the pending footer — a place the reader is not looking at if they
  scrolled away. A re-push of the SAME list (what a reload sends) leaves position and focus alone.

- **Compaction no longer discards the part of a conversation it summarizes.** The summarized span
  stays in the session — still in the transcript, still searchable — and the **context window begins
  at the summary** instead of the span being replaced by it. Nothing is lost any more, so a long
  session does not become amnesia, and the boundary is a _stored_ marker rather than a position
  recomputed every turn — which is also what keeps the provider's prompt cache warm. A ✂ cut stays
  physical: cutting at or before a summary removes it, and the surviving past becomes the window
  again. The `README` and the manual-compact dialog now describe what actually happens.

- **The context window is now VISIBLE in the transcript.** The summary pair rendered as two unrelated
  bubbles and the past looked exactly like the live context, so a long session grew with no cue about
  what the model still receives. A divider now marks the boundary and carries the count (`N messages
above · kept in the session, out of the context window`), and the checkpoint reads as ONE card — the
  label with its summary body attached — instead of two bubbles. The boundary comes from
  `checkpointStart`, the SAME function the request uses, imported into the webview: the marker and the
  request cannot disagree about where the window begins.

- **A compaction now says so WHERE YOU ARE.** The card that opens the window is the head of the
  transcript — several screens above the bottom, which is exactly where you are while following the
  stream. So the compaction was invisible: the bar dropped and nothing else happened. A line now
  appears at the bottom (`🧹 Context compacted · the summary is above ↑`) and clicking it scrolls to
  the card. It appears only when a compaction actually happened: the provisional "Compacting…"
  bubble is now REMOVED when nothing was moved, instead of being finalized into a block claiming
  "the older messages were summarized" either way.

- **A span bigger than the summary request can read is no longer a dead end.** It used to fall back to the
  trim: no state document at all, and everything the span held left the window unrecorded. The summary now
  takes the most RECENT part that fits — the work closest to now is the work that matters — and the
  messages it could not read are **DEFERRED**: they stay in the transcript, ABOVE the new checkpoint,
  outside the window, eligible for a later summary. Nothing is destroyed to buy room, which is the whole
  point. A window that shrank under a full session, or an 8k model, now gets a real state document instead
  of only a trim. Only a window that can read NOTHING still trims (it calls no model, so it cannot fail).

- **The compaction's numbers are measured or proportional — no flat guesses left.** Three constants
  were calibrated for one window size and wrong at every other:
  - the prompt reserve was a flat **2000**: ~6% of a 33k window, ~0.2% of a 1M one. It is now
    **MEASURED** from the prompt we actually send (~1.1k), because a constant string we own has a size
    that is a fact;
  - the **previous state document** travels INSIDE the summary request and was counted nowhere, so a
    big document pushed the request past the window in silence. It is counted now;
  - the summary's own budget was **half the window**: 12k on a 33k model, and an impossible ~450k on a
    1M one — where the reply was also capped far below the instruction. It is now a **COMPRESSION of
    the span** it replaces (10:1), and the only hard limit is the max output declared for the session.
    The CAP is deliberately NOT that budget: it is what the model may spend to produce it, and a model
    that reasons spends the budget before writing a character. Measured on a real session: cap = the
    budget gave an EMPTY reply 3 times out of 3; cap = the declared output gave a real document 3 out
    of 3.

  The consequence is the point: **an 8k window can summarize again.** It previously could not at all —
  8192 + 2000 left nothing — so a local model only ever got the trim, never a state document.

- **A reply that is not the document is a FAILED compaction, not a summary.** Free and auto-routed
  models sometimes answer the summary request with something else entirely — `User Safety: safe`,
  a refusal, an empty stream. `splitSummary` accepted any text as the body, so that reply was written
  into the state document: 108 messages / 236k chars of tool output reduced to two useless lines, with
  nothing reporting it. It now counts as a failure and lands on the trim, which carries the PREVIOUS
  state verbatim — the chain survives. Being strict is safe precisely because that fallback exists.

- **Older checkpoints fold into ONE row.** A compaction folds the previous summary into the new one,
  but a TRIM cannot (it calls no model): it carries the state verbatim and starts a NEW marker,
  leaving the old pair where it was. A session whose window shrank several times therefore piled up
  orange cards — half-cards, in fact, since only the newest gets the body styling. The pairs above
  the boundary are now a single dim line (`3 earlier summaries, folded into the one below`): their
  content is already inside the newest summary, so re-rendering their bodies said nothing new.

- **The autoscroll pill says what it DOES: `Follow`.** It is not a toggle — it is disabled while you
  are already at the bottom — so its label has to name the click, not the mode: `Autoscroll`, greyed
  out, described the very state the button was already in. The tooltip keeps the whole behaviour
  (jump to the latest message and follow the stream). Order and placement are unchanged: a pill that
  appears or disappears beside a neighbour reflows the row under the cursor, which is why these two
  never move.

- **The compaction threshold reads `Auto: 80% ctx`.** It used to spell out `Auto Compact threshold:
80%`, which was the widest thing on the metrics row for a number that is a status, not a control.
  The shorter form says the same in about half the width (~72px against ~154px, measured), which is
  the slack the row needs now that the panel can be dragged narrower.

- **The panel's horizontal floor drops from 600px to 500px.** The floor is not a guess: 450px is the
  measured minimum at which the ask box keeps its placeholder on one line and the control row is not
  squeezed, and the reference width ships with a margin over it — that margin is the tolerance you
  feel while dragging the panel narrower before the scrollbar appears. It is now ~50px (a ninth)
  instead of ~150px (a third), and the `rem` side of `max(500px, 32rem)` takes over past a ~15.6px
  editor font instead of ~18.75px, so large fonts are covered exactly as before. Measured slack at
  the floor is still ~88px in the widest metrics state.

- **Build paints the mode pill orange.** The mode selector was deliberately colourless in both
  modes — a coloured icon was "the last loud thing on a row of quiet controls" — which left the pill
  saying the same thing twice (word + tooltip) and nothing you could catch from the corner of your
  eye. Build now fills the pill with the accent gradient and turns its icon, label and chevron white
  (the same recipe as Parallel-on, glow included), while **Analyze keeps the quiet gray**: the
  contrast between the two states is the signal, so you never have to re-read the word to know which
  mode the next run will use. The pending dashed edge survives the transparent border.

- **The per-turn badge puts the accent on the WORD `Build`, not on the line.** Each answer carries a
  badge naming the mode it ran in; painting the whole row orange was tried and reverted once for
  being the loudest thing on half a long transcript — but leaving Build indistinguishable from
  Analyze was the opposite error. The compromise is a single orange word inside the chip: it is the
  one thing you scan a transcript for ("which turns actually wrote"), it competes with nothing, and
  the model/provider/token text stays gray.

- **The Queue/Steer pill is now an `Insert in …` hint in the control strip.** The pill sat in the
  model row, competing with the controls that actually _do_ something, and it was the only indicator
  wearing a button's clothes. It moved to the strip above the prompt: `Insert in` followed by the
  word `Queue` (neutral pill) or `Steer` (muted red pill with its glow), on the LEFT — the same slot
  geometry as `Collapse all`/`Follow` on the right, same 18px height, so nothing reflows. The
  behaviour is unchanged _exactly_: Steer only while a run is active **and** Ctrl/Cmd is held, back
  to Queue on key release, on blur, or when the run ends, with the same one-shot `followAndFocus()`
  per real switch. It is still a pure indicator (a span, no click handler); when nothing is running
  it is dimmed instead of `disabled`. The model row also got ~169px of its width back.

- **The Loop Guard row reads `Off` / `Low` / `Medium` / `High` — quietest to loudest.** It shipped as
  `High` / `Normal` / `Low`, i.e. backwards against the way the row is read, with the default in the
  middle and no way to express "none". The order is now the dial it always was, and `Normal` is
  **renamed `Medium` end to end** — the persisted value included (`LoopGuardSensitivity`, the presets,
  the radio ids/values, the CSS, the tests, the README). Sessions saved under the old name still load:
  `normalizeLoopGuardSensitivity` maps `"normal"` → `"medium"`, and it is the single choke point for
  both reads and writes of the session row, so the migration cannot be forgotten on one path. Sub-agents
  inherit the same guard, so they follow their session's level — Off included.

### Fixed

- **One turn bigger than the verbatim budget made every compaction a NO-OP.** The cut is snapped to a
  whole turn; when a single turn exceeded the keep budget — a dozen tool cycles under one request —
  that left nothing above the cut but the synthetic checkpoint pair, which is filtered out. The
  planner answered "nothing to summarize", the session fell back to a trim, and the next attempt hit
  the same wall: it could never write a state document again (observed three times in a row). The
  budget now wins over the group in that case, walking back over a leading tool message so a kept
  result never loses the call that owns it — and only when the span above is worth a model call,
  because turning a no-op into a request would spend a summary to produce nothing.

- **An empty reply is a FAILURE, not a fabricated document.** A silent model used to produce
  `## Goal <title> / ## Progress No details available.` — a document that passes the structural check
  while carrying nothing, and that REPLACES the previous state instead of preserving it. Empty now
  means: trim, which carries that state verbatim. A reply that is not the document at all gets **one
  retry** before giving up, because an auto-router can land on a guard model or a model can lose the
  thread (measured: 4 runs in 5 succeeded on the same input).

- **The Working bar beats on the cycle that starts with the run.** It is created a line before the
  pulse clock is reset, so it was locked to the PREVIOUS cycle while every bubble born later locked
  to the new one — the bar and the `compacting` bubble pulsed up to a third of a cycle apart
  (measured: 333 ms of 1200), with everything else in sync. The clock reset now re-locks whatever is
  already pulsing, so the invariant holds whatever the creation order.

- **The summarizer could not see what the tools had done.** `serializeConversation` emitted
  `[Assistant]: <text>` and then bare `[Tool result]` lines: `m.toolCalls` was dropped entirely, so
  the model writing the state document could not tell a `Write` from a `Grep` and had no idea which
  file had been changed or which command had produced the output in front of it. Since the summary
  is the ONLY thing that crosses the window, `## Done` could never name a file — the one fact the
  next turns cannot re-derive. The span now carries a named, payload-free line per call
  (`Write src/foo.ts (240 lines)`, `Shell npm test`, `Edit src/a.ts (+4/-2)`), the prompt says what
  those lines are, and the describer lives in `tools/tool-call-text.ts` — shared with the transcript's
  tool bubbles, because the webview knowing how to describe a call while the compactor did not is
  exactly the drift that a second copy would reintroduce. Payloads stay out: a `Write` carries the
  entire file, so echoing arguments would push the span past what the model could read.

- **The request estimate ignored whole payloads, so the overflow safety net was wider than designed.**
  The "our own estimate said we were full" leg decides whether a rejection it cannot READ was a size
  problem, and it counted only text, tool arguments and the system prompt — missing the tool SCHEMAS
  (every request pays ~3.6k tokens for them), `images`, and the reasoning blocks that are passed back
  on every later turn. Under-counting makes that leg fire LESS often, and it is the one path where a
  session dies instead of recovering. Images get a flat ceiling: a data URI's length is wrong by
  ~2,500× (attachments are never downscaled, while vision is priced per image at ANY size), and
  over-counting here costs one compaction — the safe direction.

- **A compaction that could not be made now falls back to a trim instead of failing.** The
  summarizer's ceiling is our PREDICTION of its own request size, and a prediction can be wrong — a
  previous state document larger than the fixed prompt reserve allows for, a provider phrasing the
  limit differently, a transient failure. When it was wrong the summary request was sent anyway, got
  rejected, and the error surfaced: the compaction did not happen, on a session that then had no way
  to shrink. The summary is the GOOD path and the trim is the one that CANNOT fail (it calls no
  model), so a failed summary now lands on the trim, with one line in the log saying why. Sub-agents
  follow the same rule — they share the model, so they shared the failure. A Stop is the only
  exception: there the user asked to cancel, and degrading would be doing the work they cancelled.

- **The transcript no longer jumps when it is rebuilt.** A `refresh` wipes `#messages` and re-renders
  it — and a wipe plus a re-render in the same task means the browser never resets `scrollTop`: it
  keeps the old PIXEL OFFSET, which in the new content is a different place. While you follow the
  bottom nothing showed, because `scrollDown()` took you back there; once you had scrolled up to
  read, the view landed somewhere arbitrary — typically around the middle — and whether it happened
  at all depended on how much the two heights differed. A compaction triggers exactly this refresh
  and changes the transcript's height the most, which is where it surfaced. The refresh now anchors
  on the BUBBLE under the top edge and puts it back (`getBoundingClientRect`, never `offsetTop`: the
  scroller is not positioned), and does NOTHING when the list changed under the anchor or the reader
  sits in the bottom padding — a wrong scroll would be worse than none.

- **A mid-run compaction shows its result immediately, like the manual one.** The auto path — the
  one that fires at the threshold — only posted `compactStart`/`compactDone`, so the transcript was
  never rebuilt: the divider and the summary card appeared only at the next UNRELATED refresh, and a
  stand-in bubble claimed the older messages had been summarized in the meantime. The manual path
  already rebuilt the transcript; the two are now aligned. The difference that survives is
  deliberate: the auto path still posts no `status`, because the run is in flight and the working
  indicator must keep showing. The webview was already built for it — its `refresh` handler states
  that a refresh can land MID-RUN on a compaction and restores the in-flight stream.

## [0.3.2] - 2026-10-16

### Added

- **Attachment previews INSIDE a queue/steer bubble.** The paperclip still leads the line, and
  opening the row reveals exactly what a user message shows — the thumbnail with its lightbox
  and the file cards — because it is the same renderer, so the two can never drift apart.

### Changed

- **Queue / steer bubbles are ONE LINE, born folded, and open on demand.** A pending message
  is a queued intention, not a document: it takes a single line whatever was pasted into it
  (the whole text rides in its tooltip) and the SECTION keeps the scroll, so a long queue can
  no longer push the transcript up. The fold is a bare chevron sitting WITH the two commands
  instead of in front of the text, and it is offered only where a measurement ON THE RENDERED
  ROW says there is a second line (`pending-fold.ts`) or where the message carries
  attachments; the transcript's **Collapse all** closes the pending bubbles with everything
  else.
- **The mode pill on the AI Model row is quiet AND colourless, like the controls next to it.**
  It was a saturated gradient (terracotta / violet) with a white icon + label and a glow, which
  made the row's quietest element the loudest thing in it. It is now the same dark pill as
  `Queue` / `Parallel`, with both of its icons in the row's muted gray: the LABEL is what says
  which mode you are in, and no colour carries it anywhere — the menu's icons are neutral too,
  and the accent marks only which row is SELECTED. The label also reserves the width of the
  longest mode name, so switching Analyze ⇄ Build never moves the pill or its neighbours.
- **The `Build` / `Analyze` chip in the per-turn badge is now gray like the rest of the
  badge.** An accent-tinted `Build` turned half the lines of a long transcript into the
  loudest text in the panel, competing with the answer it only annotates; the word itself
  already says which mode the turn ran in.
- **Analyze/Build and Parallel are decided ONCE PER RUN and LOCKED while it works.**
  They are not request parameters — the model, the window and the samplers stay locked — but
  they are **safety promises**: _Analyze_ means nothing is written, and a promise that can
  change under a run cannot be trusted. Both ways it broke were real. A **writer sub-agent**
  delegated before a switch to Analyze kept writing while the pill said Analyze. And a switch
  to Build **erased the "Nothing has been applied" footer** on files that were still
  untouched, because that footer read the live mode instead of the run's. A run is now born
  with its mode and its Parallel setting and keeps them to its last tool result, so every
  turn of it reads the same policies and nothing already emitted can change meaning — and the
  two pills are disabled while it works, with the **request parameters** they now belong to.
  The lock is not silent, which is what made this row lie in the first place: each pill's
  tooltip names the policy the run is using and says that **Stop** is how to stop now.

### Fixed

- **A user bubble with attachments no longer reads as centre-aligned.** The bubble centres its
  TEXT on purpose — a one-character message sits in the middle of its 48px floor — and it does
  so with a shrink-to-fit, left-aligned block inside. With an attachment (usually wider than
  the text) that block floated in the middle of a wide bubble: the message _looked_ centred
  while the previews sat at the left. The bubble now declares the attachment, and the text
  takes the full width, starting where the previews do. The caption under a preview is
  left-aligned with it as well.
- **The panel no longer gets stuck when the window is resized during a run** (visible on
  Windows, with parallel sub-agents). Two causes, both in the webview. Every sub-agent delta
  re-rendered its WHOLE live log as Markdown on the spot — hundreds of renders of a log that
  grows into the tens of KB, each followed by the forced layout of `scrollDown()` — while
  only the main stream coalesced into a frame; with several sub-agents the message backlog
  never drained, so the UI stopped following the run. And the ONLY paint channel was
  `requestAnimationFrame`, which Chromium starves for the entire duration of a window resize
  (and while the webview is hidden): buffered text had no way to land. Now a sub-agent's live
  text goes through the same coalescer — one per bubble, so parallel streams never overwrite
  each other's pending paint — the pacing follows the MEASURED render cost (a 40 ms render is
  not repeated 60×/s), a `setTimeout` fallback paints the buffered chunk even when no frame
  arrives, short text still paints immediately so the stream stays instant, and the resize
  handlers (input height, control columns, the pending-bubble fold) run once per frame
  instead of once per event.

## [0.3.1] - 2026-10-16

### Changed

- **The listing description leads with what Harny IS** — fast and packed with
  features, built on a SOLID core — instead of a comparison to another product.
  It is the line every gallery shows at the top of the page (the manifest's
  `description`), so it is the first thing a reader sees.

## [0.3.0] - 2026-10-16

> **The 0.2.1 items below reach the galleries for the first time with this release** — that
> version was tagged and released on GitHub, but its publishing step failed (no trusted
> publisher registered), so anyone updating from **0.2.0** gets both sections at once.

### Added

- **The per-turn badge leads with the MODE the turn ran in** (`Build` accent-tinted,
  `Analyze` quiet), before the model and the timings. With the switch now working mid-run, a
  transcript can hold turns that only prepared previews and turns that wrote — and this is
  where you tell them apart at a glance, instead of digging into `Output > Harny`. Turns
  recorded before this existed simply show no chip.
- **A tool now DECLARES how it keeps Analyze's promise** (`read-only`, `preview`, `guarded`,
  `refuse`), instead of the mode policy holding a list of names: the list was blind to every
  dynamic tool and deaf to a core tool that forgot to appear in it. Production's default is
  **refuse**, so a tool nobody described — a new MCP server, a plugin, a tool added tomorrow —
  is never assumed harmless, and a missing declaration cannot reopen the hole.
- **Per-server declaration for MCP in Analyze** (`analyze: "trusted" | "read-only"` in
  `~/.harny/config.json`): `read-only` states that every tool of that server changes nothing
  (for servers that send no hints), `trusted` believes the server's own `readOnlyHint: true`.
  Omitted means **none** of its tools runs in Analyze. Read live, so a change lands on the next
  turn. (Config file only for now: the panel's editor does not offer the field yet.)
- **MCP tool hints are kept** (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`): they used to be dropped at ingestion, and they are what a trusted server is
  believed on.
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
  _when_ the text reaches the model — so converting a steer back also **withdraws the
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
  compaction a session uses (applied to its own ephemeral history), the **Loop Guard
  settings of the session reach the sub-agents** instead of a default preset, and a
  sub-agent **frees room at every turn boundary** like the session does — instead of
  waiting for the provider to refuse the request.

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

- **An MCP tool that writes ran FOR REAL in Analyze.** The gate asked "is this name in the list
  of file-mutating tools?" and an MCP tool is named `mcp__<server>__<tool>`, chosen by the
  server: `mcp__db__drop_table` was therefore "not mutating" and executed, silently — no note to
  the model, no sign to you. Analyze promises that **no resource is modified**, and an external
  call cannot be previewed the way a file write can, so the rule is now: in Analyze a tool runs
  only if something proves it changes nothing — your per-server declaration, or, for a server
  you marked trusted, its own `readOnlyHint: true`. Everything else is **refused**, naming the
  server and the two ways out. The protocol's own defaults (`readOnlyHint: false`,
  `destructiveHint: true`) mean silence is read as "it modifies".
- **Switching Analyze/Build — or Parallel — while the session was working did
  nothing.** Both switches are disabled together with the rest of the controls during a
  run, so the click was dropped in silence and the run kept the settings it started with:
  the UI showed Build while the agent still behaved as Analyze, and Parallel OFF while
  sub-agents were still spawned. They are not request parameters (the model, the samplers
  and the window are, and those stay locked) but two **behaviour policies the agent
  re-reads at every turn**, so they now stay usable and the change lands at the **next
  turn boundary** — the same moment a steer is applied. A mode change can no longer
  rewrite a turn already in flight either: the mode is **frozen when a turn starts**, so a
  tool call the model had already emitted cannot change meaning (an Analyze preview
  becoming a real write, with the diff never shown). The per-turn diagnostic line in
  **Output > Harny** now carries `mode=` and `parallel=`, which is what makes such a
  report diagnosable after the fact.
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
  repaired** — the request is refused instead of being rejected by the provider _and
  every request after it_.
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
- **Diagnostics**: per-turn lines in _Output > Harny_, an optional request log
  (`HARNY_DEBUG=1`), per-turn metrics badges and real context accounting.

[Unreleased]: https://github.com/spltek/harny/compare/v1.2.1...HEAD
[1.2.1]: https://github.com/spltek/harny/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/spltek/harny/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/spltek/harny/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/spltek/harny/compare/v1.0.3...v1.1.0
[1.0.3]: https://github.com/spltek/harny/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/spltek/harny/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/spltek/harny/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/spltek/harny/compare/v0.9.8...v1.0.0
[0.9.8]: https://github.com/spltek/harny/compare/v0.9.7...v0.9.8
[0.9.7]: https://github.com/spltek/harny/compare/v0.9.6...v0.9.7
[0.9.5]: https://github.com/spltek/harny/compare/v0.9.4...v0.9.5
[0.9.4]: https://github.com/spltek/harny/compare/v0.9.3...v0.9.4
[0.9.3]: https://github.com/spltek/harny/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/spltek/harny/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/spltek/harny/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/spltek/harny/compare/v0.8.2...v0.9.0
[0.8.2]: https://github.com/spltek/harny/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/spltek/harny/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/spltek/harny/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/spltek/harny/compare/v0.7.0...v0.7.1
[0.6.0]: https://github.com/spltek/harny/compare/v0.5.3...v0.6.0
[0.5.3]: https://github.com/spltek/harny/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/spltek/harny/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/spltek/harny/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/spltek/harny/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/spltek/harny/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/spltek/harny/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/spltek/harny/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/spltek/harny/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/spltek/harny/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/spltek/harny/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/spltek/harny/releases/tag/v0.2.0
[0.1.0]: https://github.com/spltek/harny/releases/tag/v0.1.0
