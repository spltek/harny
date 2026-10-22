# Changelog

All notable changes to **Harny** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.1] - 2026-10-22

### Fixed

- **A warning in the Problems panel, gone.** The manifest declared
  `onView:harny.chatView`, which VS Code and VSCodium have generated *implicitly* from
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
- **The Settings UI shows ONE setting: the theme.** Opening *Settings* from the extension used to list
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
  fragment: insert *what*? The two-word fix makes the line self-explanatory without touching the
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
  this category, while *"any OpenAI-compatible endpoint works out of the box"* is the promise that
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
- **The live card says so.** The two VACUUM sliders inside *All sessions* are global settings stored
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
  against the body (`position: relative`), which *is* the panel content: the card keeps the floor
  width and scrolls away together with the rest of the panel. All eight dialogs share ONE rule now
  (they used to carry eight drifting copies); each card centres with `margin: auto` +
  `max-height: 100%` — centring that survives a card taller than the screen, where the old
  `translate(-50%,-50%)` pushed the first field above the top edge and made it unreachable — and
  `overflow: auto` scrolls the DIALOG, never the window. Backdrops stay `fixed`, so they keep
  covering the visible slice while the dialog itself scrolls with the content.

- **The panel grew a second, phantom scrollbar.** `body` was `height: 100vh`, which is measured
  *without* scrollbars: the moment the horizontal bar appeared (~15px) the body was that much taller
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
  the span it removes, and the summarizer runs on the *session's* model — so a span larger than that
  model's window can never be read. A session that had filled up on a big model and was then switched
  to a small one could therefore neither compact (the summary request was rejected for length) nor
  send (the request was too long), and died with an opaque error. In that case the window now moves
  **without a summary**: no model call, so it cannot fail; the state document is carried **verbatim**,
  so continuity survives; and everything it moves past stays in the session, readable and searchable.
  One rescue is enough — the span then fits and normal summaries resume. Sub-agents follow the same
  rule (they share the model), on their own ephemeral history.

- **Compaction tally** (`sessions/compaction-tally.ts`): each compaction and trim now logs its own
  event AND a running count on the same line, because the question that decides whether the budget is
  right cannot be read off a single event — *is the trim a rare rescue, or the normal path?* The line
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
  inert**: no reasoning/answer detection, no per-turn classification, no nudges, no stop — *and* no
  tool-call deduplication either, because "off" has to mean off (identical read-only calls are re-run,
  identical failures are retried). The tooltip says exactly that, and the 12 parameter sliders stay
  in place, dimmed and disabled, instead of disappearing: hiding them would change the card's height
  on every level switch, and that row is what the column-count measurement reads. `Medium` remains the
  default — pinned by a test on `DEFAULT_LOOP_GUARD_OPTIONS`, on the bare guard and on the UI.

### Changed

- **The summary request is ONE message: the data first, the instructions last.** They used to sit in
  the `system` role with the transcript *after* them — the opposite of what long-context guidance
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
  session does not become amnesia, and the boundary is a *stored* marker rather than a position
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
  model row, competing with the controls that actually *do* something, and it was the only indicator
  wearing a button's clothes. It moved to the strip above the prompt: `Insert in` followed by the
  word `Queue` (neutral pill) or `Steer` (muted red pill with its glow), on the LEFT — the same slot
  geometry as `Collapse all`/`Follow` on the right, same 18px height, so nothing reflows. The
  behaviour is unchanged *exactly*: Steer only while a run is active **and** Ctrl/Cmd is held, back
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
  they are **safety promises**: *Analyze* means nothing is written, and a promise that can
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
  the text) that block floated in the middle of a wide bubble: the message *looked* centred
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

[Unreleased]: https://github.com/spltek/harny/compare/v0.6.0...HEAD
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
