import type { ChatController, SendOptions } from "../core/agent/chat-controller";
import type { ChatHistory } from "../core/history/chat-history";
import type { ChatMessage } from "../core/history/types";
import type { AttachmentInfo, AttachmentPart } from "./attachment-types";
import { SessionLiveState } from "./session-live-state";
import type { SessionLiveProjection } from "./session-live-state";

/** Safety valve for the dedupe scan: a run that never sees a user message again
 * (an endless loop-guard run) still stops scanning at this many messages. It is
 * a BOUND, not a window — see `committedToolCallIds`. */
const MAX_COMMITTED_SCAN = 500;

/** One message to deliver, as it arrives from the view (or from the queue). */
export interface SendIntent {
  text?: string;
  attachments?: AttachmentInfo[];
  /** "queue" = typed while working: the view drew NO bubble for it, so the host
   * shows it when its turn comes. */
  mode?: "queue" | "steer";
}

/** The message as it will be SENT: attachments inlined, `/skill` applied. */
export interface PreparedPrompt {
  /** What the model receives. */
  text: string;
  images?: SendOptions["images"];
  /** Files as metadata, so the bubble shows chips instead of the inlined text. */
  attachments?: SendOptions["attachments"];
  /** What the user typed, when it differs from `text`. */
  displayText?: string;
  attachmentParts?: AttachmentPart[];
}

/**
 * What ONE session's run needs from the host: services and view posts, nothing
 * else. The engine owns the SEQUENCE and the guarantees (the send lock, the status
 * around the run, "refresh only if this is still the visible tab"); the host owns
 * the policy and the services (attachments, compaction, skills, the view).
 *
 * TWO interfaces, not one, because the two operations need very different amounts of
 * the host: `send` runs a whole turn (prepare, compact, start, report), while `abort`
 * only drops a queue and posts a notice. One fat interface forced every `abort` fake to
 * implement FIFTEEN methods it never touches — the defect was visible in this module's
 * own test, which worked around it with a spread. Interfaces now say what they use; a
 * host object satisfying both satisfies each.
 *
 * It is passed per call, not held: the engine stays a state machine that can be
 * exercised with a fake port and no vscode — which is the whole reason the run
 * sequence could leave the provider.
 */
export interface SessionSendPort {
  /** Re-assert the session's run policies (mode, Parallel, cap, loop guard) on the
   * agent right before it runs: a session created before a UI toggle, or a
   * reloaded panel, must not send with stale state. */
  prepareAgent(): void;
  /** False when the session has no model yet: the run cannot start. */
  hasModel(): boolean;
  /** Tell the user — IN the history, so it survives a rebuild — that a model is
   * missing, keeping what they typed. */
  rejectMissingModel(intent: SendIntent): void;
  /** Inline the attachments, apply `/skill`, validate modalities. `undefined` means
   * "already handled": an error was posted or a local command ran. */
  preparePrompt(intent: SendIntent): Promise<PreparedPrompt | undefined>;
  /** Best-effort compaction BEFORE the request (already over the threshold). */
  compactBeforeRun(): Promise<void>;
  /** Best-effort compaction AFTER the response. */
  compactAfterRun(): Promise<void>;
  /** Another message is already queued/draining for this session. */
  isDraining(): boolean;
  /** Park a message for after the current run (the queue lives in the host). */
  enqueue(intent: SendIntent): void;
  /** Deliver the queued messages in order. */
  drain(dispatch: (intent: SendIntent) => Promise<void>): Promise<void>;
  /** True when this session is the visible tab: posts must not clobber another. */
  isActive(): boolean;
  /** Show the queued user's bubble now that its turn has come (the view never drew
   * one when it was typed). */
  showQueuedUser(prompt: PreparedPrompt): void;
  /** The run just started (`agent.send` was invoked). */
  onRunStarted(): void;
  /** The run ended. The host refreshes transcript and status only if this is still
   * the active tab. */
  onRunFinished(hadError: boolean): void;
}

/** What stopping a run needs: drop the pending list, say it was interrupted. Two
 * methods out of seventeen is the measure of how much the old interface over-served. */
export interface SessionAbortPort {
  /** Stop: drop everything still queued/steered so the run does not silently
   * restart from the pending list. */
  clearQueue(): void;
  /** The run was interrupted by the user (red bubble in the transcript). */
  onInterrupted(): void;
  /** Stop a COMPACTION that is rewriting this session's history. Returns whether there
   * was one to stop (the summary is a model call: seconds of visible work). */
  cancelCompaction?(): boolean;
}

/**
 * ONE session's engine: the object that follows that session and owns its
 * runtime state, independently of the view and of the other sessions.
 *
 * Extraction step #2 (of the strangler plan): besides the LIVE turn, it now owns
 * the session's RUN facts — `sending`, `compacting` and the one `working`
 * predicate. Those used to be two `Set`s on `ChatViewProvider` and five copies of
 * `agent.streaming || sending.has(id)` spread across the switch payload, the live
 * lines, the row locks and the send guard: the same question answered five times,
 * which is exactly how they drifted apart (the destructive row actions were
 * enabled during a send preamble).
 *
 * Next steps move `send` / `abort` / queue in here too, leaving ChatViewProvider
 * a thin router. It deliberately holds no view reference: what the view reads is
 * data (a projection, a summary, two booleans).
 */
export class SessionEngine {
  readonly live = new SessionLiveState();

  /** True while the SEND PREAMBLE of a message is in flight (attachment build,
   * pre-request auto-compaction): the run has not started, but the session is
   * ALREADY busy for the user and must be locked like one. */
  private _sending = false;
  /** True while a compaction of THIS session is running (per session: a global
   * flag made one session's summary swallow another's). */
  private _compacting = false;

  constructor(
    readonly sessionId: string,
    private readonly history: ChatHistory,
    private readonly agent: ChatController,
  ) {}

  get sending(): boolean {
    return this._sending;
  }

  get compacting(): boolean {
    return this._compacting;
  }

  /**
   * Busy = a run is streaming OR a send is being prepared OR the history is being
   * REWRITTEN by a compaction. THE definition: the tab locks, the session rows, the
   * manager, the switch payload and the live lines all read this, so they cannot
   * disagree about what "working" means.
   *
   * The compaction was deliberately left out, on the reasoning that "blocking the user's
   * next message on a summarisation would be the wrong trade". It was not a trade, it was
   * a loss: `performCompaction` rebuilds the transcript from the snapshot it took BEFORE
   * calling the summarizer, so a message sent during that window was appended to the
   * history and then rebuilt away — the user's turn (and the reply already streaming) gone
   * from disk and from the model's window, silently. A message typed now is PARKED for the
   * seconds the summary takes and delivered right after (`resume`, plus the drain at the
   * end of `send`).
   */
  get working(): boolean {
    return this._sending || this.agent.streaming || this._compacting;
  }

  /** A message is being prepared (see `sending`). Always paired with `endSend`. */
  beginSend(): void {
    this._sending = true;
  }

  endSend(): void {
    this._sending = false;
  }

  beginCompaction(): void {
    this._compacting = true;
  }

  endCompaction(): void {
    this._compacting = false;
  }

  /**
   * Deliver a message: run it now, or park it behind the current run.
   *
   * OWNING this decision is the point of the extraction: it used to live in
   * `ChatViewProvider.send`, next to three copies of "is the session busy?".
   */
  async send(intent: SendIntent, port: SessionSendPort): Promise<void> {
    if (this.working || port.isDraining()) {
      port.enqueue(intent);
      return;
    }
    await this.dispatchTracked(intent, port);
    await port.drain((next) => this.dispatchTracked(next, port));
  }

  /**
   * Stop the run (no-op when nothing is streaming). The user regains control: the
   * pending queue is dropped, the live turn is forgotten, and the interruption is
   * written into the history as an `uiOnly` notice — the model already learns about
   * it from the aborted tool results, and a REAL assistant message here would land
   * BETWEEN the turn's `tool_calls` and its results, which every provider rejects
   * on every later request.
   */
  /**
   * Stop the run — and everything under it: `agent.abort()` cuts the stream and the tools in
   * flight AND cascades to the sub-agents (`deps.onAbort` → `subAgents.abortAll()`), so one
   * call stops the whole tree.
   *
   * `reason` is what the persistent note says. The UI's Stop passes nothing ("Processing
   * interrupted"); a HOST-driven stop says why it decided for the user (the workspace folder
   * disappeared) — a stop nobody pressed must not read like an accident.
   *
   * No-op when the session is idle, so a host can call it unconditionally.
   */
  async abort(port: SessionAbortPort, reason?: string): Promise<boolean> {
    if (!this.agent.streaming) {
      // Nothing in the STREAM — but the session can still be busy: a compaction is
      // rewriting the history, and since `working` includes it the panel is showing Stop
      // for exactly that. A Stop that does nothing is a button that lies, so it cancels the
      // summary; the queue goes with it, like any other stop (the user asked to stop, a
      // message parked behind the compaction must not fire afterwards).
      if (!this._compacting) return false;
      const cancelled = port.cancelCompaction?.() === true;
      port.clearQueue();
      return cancelled;
    }
    port.clearQueue();
    this.agent.abort();
    this.live.reset();
    port.onInterrupted();
    this.history.add({
      role: "assistant",
      content: "❌ ⏹ " + (reason ?? "Processing interrupted."),
      timestamp: Date.now(),
      uiOnly: true,
    });
    return true;
  }

  /**
   * Deliver what was parked while the session was rewriting its history.
   *
   * `send` drains by itself at the end of a run, so this is for the compactions that are NOT
   * the tail of a send — the manual Compact button: without it, a message typed during a
   * manual summary would sit in the pending footer until the user typed something else.
   * A no-op while the session is busy (the run holding it drains on its own).
   */
  async resume(port: SessionSendPort): Promise<void> {
    if (this.working || port.isDraining()) return;
    await port.drain((next) => this.dispatchTracked(next, port));
  }

  /** One message, with the SEND lock held across its whole async preamble: a second
   * send arriving before `agent.send` starts is queued instead of launching an
   * overlapping run on the same agent. */
  private async dispatchTracked(intent: SendIntent, port: SessionSendPort): Promise<void> {
    // `run` travels by reference so the report stays correct even when `dispatch` THROWS
    // after the run started (a rejected `agent.send`): the run began, so its end must be
    // reported. A message that never started (empty, no model, `/skills`) reports
    // nothing — otherwise every empty Enter would cost a refresh.
    const run = { started: false, hadError: false };
    this.beginSend();
    try {
      await this.dispatch(intent, run, port);
    } finally {
      // RELEASE THE LOCK FIRST, THEN REPORT. The host computes `workingIds` from
      // `working` (= sending || agent.streaming): reporting from inside the lock published
      // a session that had just FINISHED as still working — and nothing came after to
      // correct it (the run's last event was already consumed), so the tab and its ×
      // stayed locked.
      this.endSend();
      if (run.started) port.onRunFinished(run.hadError);
    }
    // The post-response fill comes AFTER the report, in this order on purpose: the
    // compaction posts its own bubble, status and refresh, and the view expects that
    // sequence whole (bubble → status-in → refresh → pointer to the card → release).
    // It sits outside the SEND lock because the run it belongs to is over — but NOT
    // outside the BUSY gate: `working` includes the compaction, so a message typed
    // meanwhile is parked instead of being written into a history that is about to be
    // rebuilt from a pre-summary snapshot. The drain below is what delivers it.
    if (run.started) await port.compactAfterRun();
  }

  /**
   * The run, step by step. The ORDER is the contract and it is deliberate:
   *  · the empty message is dropped BEFORE the model check (an empty Enter must not
   *    nag about a missing model);
   *  · the prompt is prepared before compacting, because a local command
   *    (`/skills`) never reaches the model and must not trigger a compaction;
   *  · the agent is started BEFORE the status is posted, so the host's working set
   *    is already non-empty and the session row locks from the first instant;
   *  · the live turn is reset after the budget, so a replayed projection can never
   *    describe the PREVIOUS run.
   */
  private async dispatch(
    intent: SendIntent,
    run: { started: boolean; hadError: boolean },
    port: SessionSendPort,
  ): Promise<void> {
    port.prepareAgent();
    const rawText = typeof intent.text === "string" ? intent.text : "";
    const attached = intent.attachments ?? [];
    if (!rawText.trim() && attached.length === 0) return;
    if (!port.hasModel()) {
      port.rejectMissingModel(intent);
      return;
    }
    const prompt = await port.preparePrompt(intent);
    if (!prompt) return; // an error was posted, or a local command ran
    await port.compactBeforeRun();
    this.live.reset();
    // A QUEUED message: the view deliberately drew no bubble when it was typed (it
    // sat in the pending footer), so the host shows it NOW — attachments included —
    // or the transcript stays empty until the end-of-run refresh.
    if (intent.mode === "queue" && port.isActive()) port.showQueuedUser(prompt);
    run.started = true;
    const sending = this.agent.send(prompt.text, {
      images: prompt.images,
      attachments: prompt.attachments,
      displayText: prompt.displayText,
      attachmentParts: prompt.attachmentParts,
    });
    port.onRunStarted();
    const unsub = this.agent.onEvent((event) => {
      if (event.type === "error") run.hadError = true;
    });
    try {
      await sending;
    } finally {
      unsub();
    }
  }

  /** Everything the view needs to rebuild the in-flight turn (or undefined). */
  projection(): SessionLiveProjection | undefined {
    return this.live.projection(this.committedToolCallIds());
  }

  /** Ids of the tool calls the history already contains (replay dedupe). */
  private committedToolCallIds(): Set<string> {
    const ids = new Set<string>();
    const messages: ChatMessage[] = this.history.all();
    // The recorder is reset when a run STARTS (`send`) and when it ENDS
    // (`done`/`error`), so every call it holds belongs to the messages of the
    // CURRENT run — i.e. everything after the last user prompt. Scanning by
    // STRUCTURE (stop at the prompt) instead of an arbitrary 100-message window
    // is what makes this exact: a long run (many tool batches) can never push a
    // committed call out of reach and resurrect it as a duplicate bubble.
    const floor = Math.max(0, messages.length - MAX_COMMITTED_SCAN);
    for (let i = messages.length - 1; i >= floor; i--) {
      const message = messages[i];
      if (message.role === "user") break; // the run's prompt: nothing before it
      for (const tc of message.toolCalls ?? []) if (tc.id) ids.add(tc.id);
    }
    return ids;
  }
}
