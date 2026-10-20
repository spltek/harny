import type { ToolCall } from "../tools/tool";

/**
 * The kinds of degenerate behaviour the guard knows how to break. Each has its
 * own escalation level, so a recurring loop escalates independently of others.
 */
export type LoopType =
  | "reasoning"
  | "empty"
  | "tool-failure"
  | "error-streak"
  | "tool-repeat"
  | "response";

export const LOOP_TYPES: readonly LoopType[] = [
  "reasoning",
  "empty",
  "tool-failure",
  "error-streak",
  "tool-repeat",
  "response",
];

/**
 * Loop Guard sensitivity preset, persisted per session. `undefined` = "medium".
 * Each level maps to a FULL, hard-coded option set (see the presets below), so
 * the user picks one of four behaviours instead of tuning raw thresholds.
 *
 * Ordered from the QUIETEST to the loudest; the UI renders them in this order,
 * with "off" first: switching the guard off is a real choice, not a hidden flag.
 */
export type LoopGuardSensitivity = "off" | "low" | "medium" | "high";

export const LOOP_GUARD_SENSITIVITIES: readonly LoopGuardSensitivity[] = ["off", "low", "medium", "high"];
export const DEFAULT_LOOP_GUARD_SENSITIVITY: LoopGuardSensitivity = "medium";

/** The level sessions persisted under the PRE-RENAME name ("normal" → "medium").
 * Kept as a literal so old rows keep loading: see normalizeLoopGuardSensitivity. */
const LEGACY_NORMAL = "normal";

/** Fully-resolved internal options: every guard parameter the loop detectors
 * read. Produced from a sensitivity preset by {@link resolveLoopGuardOptions}. */
export interface LoopGuardOptions {
  /** Master switch: `false` (the "off" preset) makes the guard INERT — no
   * detection, no nudges, no stop, and no tool-call deduplication either.
   * The numbers below stay populated so the parameter panel has values to show. */
  enabled: boolean;
  /** Reactive nudges before a type's escalation stops the run. */
  maxNudges: number;
  reasoningThreshold: number;
  reasoningMinTokens: number;
  crossTurnSimilarity: number;
  crossTurnMinLength: number;
  toolFailureRepeats: number;
  errorStreakTurns: number;
  toolRepeatConsecutive: number;
  toolRepeatWindow: number;
  toolRepeatWindowThreshold: number;
  /** Opt-in: also guard the VISIBLE final answer for repetition. */
  guardResponse: boolean;
  /** Trigram-duplication threshold for the answer guard. */
  answerThreshold: number;
  /** Minimum answer tokens before the answer guard runs. */
  answerMinTokens: number;
}

/**
 * The four presets, with every value hard-coded:
 *  · off    — inert: the guard does nothing at all (no detection, no dedup).
 *  · low    — permissive: only clear, sustained loops are flagged.
 *  · medium — the historical defaults, and the default level.
 *  · high   — aggressive: flags loops sooner (more nudges, lower thresholds).
 */
const LOOP_GUARD_PRESETS: Record<LoopGuardSensitivity, LoopGuardOptions> = {
  off: {
    enabled: false,
    // Mirror of "medium": nothing reads these while the guard is inert, but the
    // parameter panel still needs something sensible to show.
    maxNudges: 2,
    reasoningThreshold: 0.5,
    reasoningMinTokens: 60,
    crossTurnSimilarity: 0.85,
    crossTurnMinLength: 120,
    toolFailureRepeats: 2,
    errorStreakTurns: 3,
    toolRepeatConsecutive: 3,
    toolRepeatWindow: 16,
    toolRepeatWindowThreshold: 3,
    guardResponse: false,
    answerThreshold: 0.6,
    answerMinTokens: 300,
  },
  medium: {
    enabled: true,
    maxNudges: 2,
    reasoningThreshold: 0.5,
    reasoningMinTokens: 60,
    crossTurnSimilarity: 0.85,
    crossTurnMinLength: 120,
    toolFailureRepeats: 2,
    errorStreakTurns: 3,
    toolRepeatConsecutive: 3,
    toolRepeatWindow: 16,
    toolRepeatWindowThreshold: 3,
    guardResponse: false,
    answerThreshold: 0.6,
    answerMinTokens: 300,
  },
  high: {
    enabled: true,
    maxNudges: 3,
    reasoningThreshold: 0.45,
    reasoningMinTokens: 50,
    crossTurnSimilarity: 0.75,
    crossTurnMinLength: 120,
    toolFailureRepeats: 2,
    errorStreakTurns: 2,
    toolRepeatConsecutive: 2,
    toolRepeatWindow: 10,
    toolRepeatWindowThreshold: 2,
    guardResponse: false,
    answerThreshold: 0.5,
    answerMinTokens: 200,
  },
  low: {
    enabled: true,
    maxNudges: 2,
    reasoningThreshold: 0.65,
    reasoningMinTokens: 120,
    crossTurnSimilarity: 0.92,
    crossTurnMinLength: 120,
    toolFailureRepeats: 2,
    errorStreakTurns: 5,
    toolRepeatConsecutive: 4,
    toolRepeatWindow: 20,
    toolRepeatWindowThreshold: 4,
    guardResponse: false,
    answerThreshold: 0.7,
    answerMinTokens: 400,
  },
};

/** Whether an untrusted value is a valid sensitivity level. The PRE-RENAME
 * name ("normal") is NOT valid here: only {@link normalizeLoopGuardSensitivity}
 * accepts it, and only to migrate it to "medium". */
export function isLoopGuardSensitivity(value: unknown): value is LoopGuardSensitivity {
  return value === "off" || value === "low" || value === "medium" || value === "high";
}

/** Resolve a sensitivity level (or `undefined` = medium) into the full option
 * set. An unknown value falls back to "medium". `includeResponse` enables the
 * opt-in final-answer guard (default off) — meaningless while the guard is OFF,
 * where it is forced back to false so nothing can re-enable the guard sideways. */
export function resolveLoopGuardOptions(
  level?: LoopGuardSensitivity | null,
  includeResponse = false,
): LoopGuardOptions {
  const base =
    level === "off" || level === "low" || level === "high" ? LOOP_GUARD_PRESETS[level] : LOOP_GUARD_PRESETS.medium;
  if (!base.enabled) return base;
  return base.guardResponse === includeResponse ? base : { ...base, guardResponse: includeResponse };
}

/** Validate an untrusted value (e.g. a persisted session field) into a level,
 * or `undefined` (= medium). Sessions saved before the rename persist "normal":
 * it maps to "medium", the same behaviour it always had. */
export function normalizeLoopGuardSensitivity(value: unknown): LoopGuardSensitivity | undefined {
  if (value === LEGACY_NORMAL) return "medium";
  return isLoopGuardSensitivity(value) ? value : undefined;
}

/** Every NUMERIC Loop Guard parameter (everything except the flags), i.e. the
 * knobs the UI exposes as editable fields. */
export type LoopGuardNumericKey = Exclude<keyof LoopGuardOptions, "guardResponse" | "enabled">;

/** The editable range of one Loop Guard parameter. */
export interface LoopGuardFieldRange {
  key: LoopGuardNumericKey;
  min: number;
  max: number;
  step: number;
  /** Counts/tokens are integers; 0..1 ratios are not. */
  integer: boolean;
}

/**
 * Sensible editing ranges for every Loop Guard parameter. The sensitivity
 * presets are just POINTS inside these ranges. This is the ONE source of
 * truth: the UI builds its fields from it and the host clamps incoming
 * overrides to it.
 */
export const LOOP_GUARD_FIELD_RANGES: readonly LoopGuardFieldRange[] = [
  { key: "maxNudges", min: 1, max: 10, step: 1, integer: true },
  { key: "reasoningThreshold", min: 0.05, max: 1, step: 0.05, integer: false },
  { key: "reasoningMinTokens", min: 10, max: 500, step: 10, integer: true },
  { key: "crossTurnSimilarity", min: 0.05, max: 1, step: 0.05, integer: false },
  { key: "crossTurnMinLength", min: 0, max: 1000, step: 10, integer: true },
  { key: "toolFailureRepeats", min: 1, max: 10, step: 1, integer: true },
  { key: "errorStreakTurns", min: 1, max: 10, step: 1, integer: true },
  { key: "toolRepeatConsecutive", min: 1, max: 10, step: 1, integer: true },
  { key: "toolRepeatWindow", min: 1, max: 50, step: 1, integer: true },
  { key: "toolRepeatWindowThreshold", min: 1, max: 10, step: 1, integer: true },
  { key: "answerThreshold", min: 0.05, max: 1, step: 0.05, integer: false },
  { key: "answerMinTokens", min: 10, max: 1000, step: 10, integer: true },
];

/** Clamp a partial set of overrides to the editable ranges, dropping unknown
 * keys and non-finite values. Returns `undefined` when nothing valid remains. */
export function clampLoopGuardOverrides(input: unknown): Partial<LoopGuardOptions> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const src = input as Record<string, unknown>;
  const out: Partial<LoopGuardOptions> = {};
  for (const r of LOOP_GUARD_FIELD_RANGES) {
    const v = src[r.key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    (out as Record<string, number>)[r.key] = Math.min(r.max, Math.max(r.min, r.integer ? Math.round(v) : v));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The hard-coded presets, exposed as COPIES so the UI can show the values
 * behind each sensitivity level without duplicating them. */
export function loopGuardPresets(): Record<LoopGuardSensitivity, LoopGuardOptions> {
  return {
    off: { ...LOOP_GUARD_PRESETS.off },
    low: { ...LOOP_GUARD_PRESETS.low },
    medium: { ...LOOP_GUARD_PRESETS.medium },
    high: { ...LOOP_GUARD_PRESETS.high },
  };
}

/** The full resolved option set for the "medium" preset (the guard default). */
export const DEFAULT_LOOP_GUARD_OPTIONS: LoopGuardOptions = LOOP_GUARD_PRESETS.medium;

export interface ToolOutcome {
  name: string;
  args: Record<string, unknown>;
  isError: boolean;
  content: string;
}

export interface TurnObservation {
  content: string;
  thinking: string;
  toolCalls: ToolCall[];
  toolResults: ToolOutcome[];
}

export type LoopDecision =
  | { kind: "continue" }
  /** Break the loop and CONTINUE: log a note + inject a corrective `nudge`. */
  | { kind: "react"; type: LoopType; level: number; nudge: string; note: string }
  /** Escalation exhausted: stop the run with a clear diagnostic. */
  | { kind: "stop"; type: LoopType; level: number; message: string; note: string };

interface ReactionMessages {
  nudge: string;
  note: string;
  stop: string;
}

/**
 * One-shot corrective prompt injected when the model repeats the SAME tool call
 * (name + arguments) 3+ times. The usual cause is retrying an identical Shell
 * command instead of switching tools — so point it at Glob/Grep/Read and tell
 * it to change approach or conclude.
 */
export function repeatedCallNudge(name?: string): string {
  return (
    `You called the SAME tool ("${name ?? "?"}") with identical arguments 3+ times without making progress. ` +
    "STOP repeating it. Change approach NOW: use Glob to locate files, Grep to search and Read to inspect — " +
    "prefer these over Shell. If a command failed or returned nothing, do not run it verbatim again: use different " +
    "arguments or a different tool, or conclude. Then write your final report."
  );
}

/**
 * Rolling window of recent per-turn tool-call signatures. The consecutive
 * counter (`signatureRepeats`) only sees A/A/A; a cycle like A/B/A/B — two
 * identical WebFetch calls alternating, the classic sub-agent web loop — never
 * repeats back-to-back and would slip through. Counting occurrences inside a
 * window catches both shapes. Signatures include the full arguments, so
 * legitimate repeated *work* (different files/commands) never matches.
 */
export const SIGNATURE_WINDOW = 16;
/** How many times the same signature may recur in the window before it is a loop. */
export const SIGNATURE_REPEAT_LIMIT = 3;

/** Deterministic JSON stringify (sorted keys) so identical calls share a key. */
export function stableArgs(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableArgs).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableArgs(obj[k])}`).join(",")}}`;
}

/** Stable identity of a tool call (name + normalised arguments). */
export function callSignature(name: string, args: Record<string, unknown>): string {
  return `${name}|${stableArgs(args)}`;
}

/** Tokenise text for repetition analysis (Unicode-aware, lowercase). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Fraction of repeated word-trigrams in `text` (0 = all distinct, 1 = fully
 * repeated). A degenerate reasoning loop repeats the same phrasing, so this
 * ratio gets close to 1 while normal reasoning stays low.
 */
export function trigramDuplication(text: string): number {
  const tokens = tokenize(text);
  const total = tokens.length - 2;
  if (total <= 0) return 0;
  const seen = new Set<string>();
  for (let i = 0; i < total; i++) seen.add(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  return 1 - seen.size / total;
}

/** True when a reasoning block is stuck repeating itself. Short texts are
 * ignored (too few trigrams to be significant). */
export function isRepetitiveThinking(text: string, threshold = 0.5, minTokens = 60): boolean {
  if (tokenize(text).length < minTokens) return false;
  return trigramDuplication(text) >= threshold;
}

/** Jaccard similarity of the word sets of two reasoning blocks (0..1). */
export function thinkingSimilarity(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Stateful, per-run loop guard. It does NOT touch the filesystem or the LLM:
 * the Agent feeds it observations and applies the returned `LoopDecision`.
 *
 * `options.enabled === false` (the "off" preset) makes every method a no-op:
 * no detection, no nudges, no stop — and no tool-call deduplication either,
 * because "off" has to mean off (the UI tooltip says so).
 *
 * Design:
 *  · every loop type escalates INDEPENDENTLY (up to `options.maxNudges` reactive
 *    nudges, then a final stop);
 *  · a type whose condition is no longer met is reset, so legitimate repeats
 *    separated by progress never accumulate;
 *  · tool-call repetition is broken at the SOURCE (cached successful read-only
 *    results are reused, identical failing calls are not re-run) instead of
 *    merely nudging after the fact;
 *  · repetition is detected BOTH consecutively (A/A/A) and inside a rolling
 *    window, so alternating cycles (A/B/A/B, A/B/C/A/B/C) are caught too.
 */
export class LoopGuard {
  private readonly levels = new Map<LoopType, number>();
  private lastSignature: string | null = null;
  private signatureRepeats = 0;
  /** Recent per-turn signatures (oldest first), for cyclic-loop detection. */
  private readonly recentSignatures: string[] = [];
  private errorStreak = 0;
  private prevThinking = "";

  /** Read-only results reused for identical calls (cleared on any side-effect). */
  private readonly readCache = new Map<string, string>();
  /** Signatures that already failed: never re-run verbatim (cleared on writes). */
  private readonly failed = new Map<string, string>();
  /** Signatures currently executing (a turn never starts the same call twice). */
  private readonly inFlight = new Set<string>();

  private lastThinkingCheck = 0;
  private reasoningBroken = false;
  /** Response (final answer) guard state — only active when `guardResponse`. */
  private lastAnswerCheck = 0;
  private responseBroken = false;

  constructor(private options: LoopGuardOptions = DEFAULT_LOOP_GUARD_OPTIONS) {}

  /** Re-configure the guard (per-session settings changed). State is NOT reset:
   * the caller resets per run anyway. */
  setOptions(options: LoopGuardOptions): void {
    this.options = options;
  }

  /** Reset the whole guard (a new user message starts a fresh run). */
  reset(): void {
    this.levels.clear();
    this.lastSignature = null;
    this.signatureRepeats = 0;
    this.recentSignatures.length = 0;
    this.errorStreak = 0;
    this.prevThinking = "";
    this.readCache.clear();
    this.failed.clear();
    this.inFlight.clear();
    this.lastThinkingCheck = 0;
    this.reasoningBroken = false;
    this.lastAnswerCheck = 0;
    this.responseBroken = false;
  }

  /** Reset the per-turn reasoning detector (keeps the escalation levels). */
  beginTurn(): void {
    this.lastThinkingCheck = 0;
    this.reasoningBroken = false;
    this.lastAnswerCheck = 0;
    this.responseBroken = false;
  }

  // ── Mid-stream reasoning loop ─────────────────────────────────────────

  /**
   * Feed the accumulated reasoning text. Returns true ONCE when a within-turn
   * reasoning loop is detected, so the caller can cut the stream and nudge.
   * Cheap enough to call on every delta (amortised: re-checks at most every
   * 200 chars).
   */
  observeThinking(fullText: string): boolean {
    if (!this.options.enabled) return false;
    if (this.reasoningBroken) return false;
    if (fullText.length < 200) return false;
    if (fullText.length - this.lastThinkingCheck < 200) return false;
    this.lastThinkingCheck = fullText.length;
    if (isRepetitiveThinking(fullText, this.options.reasoningThreshold, this.options.reasoningMinTokens)) {
      this.reasoningBroken = true;
      return true;
    }
    return false;
  }

  /** Escalate a reasoning loop detected mid-stream. */
  noteReasoningLoop(): LoopDecision {
    return this.escalate("reasoning", {
      nudge:
        "Your reasoning is LOOPING: the same content is repeating over and over without progress. " +
        "STOP reasoning now. Either call the next tool, or write your final answer to the user.",
      note: "reasoning loop detected — the reasoning was cut short and the model was told to act.",
      stop: "Reasoning loop not resolved after repeated interventions.",
    });
  }

  // ── Mid-stream response (final answer) loop — opt-in ───────────────

  /**
   * Feed the accumulated VISIBLE answer text. Returns true ONCE when a response
   * loop is detected, so the caller can cut the stream and nudge. Disabled
   * unless `options.guardResponse` is set. Amortised: re-checks every 200 chars.
   */
  observeAnswer(fullText: string): boolean {
    if (!this.options.enabled) return false;
    if (!this.options.guardResponse || this.responseBroken) return false;
    if (fullText.length < 200) return false;
    if (fullText.length - this.lastAnswerCheck < 200) return false;
    this.lastAnswerCheck = fullText.length;
    if (isRepetitiveThinking(fullText, this.options.answerThreshold, this.options.answerMinTokens)) {
      this.responseBroken = true;
      return true;
    }
    return false;
  }

  /** Escalate a response loop detected mid-stream. */
  noteAnswerLoop(): LoopDecision {
    return this.escalate("response", {
      nudge:
        "Your final answer is LOOPING: the same content is repeating over and over without progress. " +
        "STOP repeating it. Finish the answer concisely, or call the next tool if more work is needed.",
      note: "response loop detected — the answer was cut short and the model was told to stop repeating.",
      stop: "Response loop not resolved after repeated interventions.",
    });
  }

  // ── Tool-call deduplication (break loops at the source) ────────────────

  /**
   * Decide before executing a tool call. Read-only calls that already ran in
   * this run return the cached result; identical failing calls are refused
   * instead of re-run; a call already in flight this turn is refused.
   */
  beforeToolCall(
    tc: ToolCall,
    readOnly: boolean,
  ): { mode: "run" } | { mode: "reuse"; content: string } | { mode: "refuse"; content: string } {
    // OFF means inert: no cache reuse, no refusal of a repeated failure and no
    // in-flight dedup either — the call runs exactly as if there were no guard.
    if (!this.options.enabled) return { mode: "run" };
    const sig = callSignature(tc.name, tc.arguments);
    const previousError = this.failed.get(sig);
    if (previousError !== undefined) {
      return {
        mode: "refuse",
        content:
          `⛔ Loop guard: this identical ${tc.name} call already failed and was NOT re-run. ` +
          `Previous error:\n${previousError}\nChange the arguments or use a different approach.`,
      };
    }
    if (readOnly) {
      const cached = this.readCache.get(sig);
      if (cached !== undefined) {
        return {
          mode: "reuse",
          content:
            `♻️ Loop guard: reused the cached result of an identical ${tc.name} call ` +
            `(it already ran this run and no file has changed since; not executed again).\n${cached}`,
        };
      }
    }
    // An identical call already IN FLIGHT this turn (parallel batch) is never
    // started twice. This applies to EVERY kind — two identical Delegates in
    // one turn are deduped WITHOUT caching the result (a Delegate is not
    // read-cacheable and must stay retryable on a later turn).
    if (this.inFlight.has(sig)) {
      return {
        mode: "refuse",
        content: `⛔ Loop guard: an identical ${tc.name} call is already running this turn; not started twice.`,
      };
    }
    this.inFlight.add(sig);
    return { mode: "run" };
  }

  /** Record the outcome of a tool call that actually ran. */
  afterToolCall(tc: ToolCall, isError: boolean, content: string, readOnly: boolean): void {
    if (!this.options.enabled) return;
    const sig = callSignature(tc.name, tc.arguments);
    this.inFlight.delete(sig);
    if (isError) {
      if (!this.failed.has(sig)) this.failed.set(sig, content.slice(0, 600));
      return;
    }
    if (readOnly) {
      this.readCache.set(sig, content.slice(0, 20000));
      return;
    }
    // A side-effect (write / shell / delegate) may have changed the disk:
    // cached reads are stale and a previously-failed call may now succeed.
    this.readCache.clear();
    this.failed.clear();
  }

  // ── Per-turn classification + escalation ──────────────────────────────

  /**
   * Classify a completed turn and return what to do. Only ONE condition is
   * acted on per turn (highest priority); the others reset their level.
   */
  observeTurn(obs: TurnObservation): LoopDecision {
    if (!this.options.enabled) return { kind: "continue" };
    const hasTools = obs.toolCalls.length > 0;
    const allFailed = obs.toolResults.length >= 1 && obs.toolResults.every((r) => r.isError);

    if (hasTools) {
      const signature = obs.toolCalls.map((t) => callSignature(t.name, t.arguments)).join("&");
      if (signature === this.lastSignature) this.signatureRepeats++;
      else {
        this.lastSignature = signature;
        this.signatureRepeats = 1;
      }
      this.recentSignatures.push(signature);
      if (this.recentSignatures.length > this.options.toolRepeatWindow) this.recentSignatures.shift();
    } else {
      this.lastSignature = null;
      this.signatureRepeats = 0;
      this.recentSignatures.length = 0;
    }

    if (allFailed) this.errorStreak++;
    else this.errorStreak = 0;

    let active: LoopType | null = null;
    let messages: ReactionMessages | null = null;

    if (!hasTools && !obs.content.trim()) {
      active = "empty";
      messages = {
        nudge: obs.thinking.trim()
          ? "You produced reasoning but no answer and no tool call. Continue NOW: call the next tool, or give your final answer to the user."
          : "Your last turn was empty (no text, no tool call). Continue NOW: call the next tool, or give your final answer to the user.",
        note: "empty turn (no text, no tool call) — the model was nudged to continue.",
        stop: "The model kept producing empty turns with no text and no tool call.",
      };
    } else if (allFailed && this.signatureRepeats >= this.options.toolFailureRepeats) {
      active = "tool-failure";
      messages = {
        nudge:
          "Your last tool call(s) failed with the SAME arguments as before, and identical failures are no longer " +
          "re-run. Do NOT repeat them. Re-Read the target, fix the arguments, or use a different tool/approach.",
        note: "the same failing tool call repeated — it was not re-run and a corrective was injected.",
        stop: "The model kept repeating the same failing tool call.",
      };
    } else if (allFailed && this.errorStreak >= this.options.errorStreakTurns) {
      active = "error-streak";
      const names = obs.toolResults.map((r) => r.name).join(", ");
      messages = {
        nudge:
          `${this.errorStreak} turns in a row ended with ALL tools failing (${names}). Step back: state the blocker in ` +
          "one line, then try a DIFFERENT approach (different tool or arguments). Do not repeat the same failing calls.",
        note: `error streak (${this.errorStreak} turns of failures) — the model was asked to change strategy.`,
        stop: `The model could not recover after ${this.errorStreak} consecutive turns of tool errors (${names}).`,
      };
    } else if (
      !allFailed &&
      (this.signatureRepeats >= this.options.toolRepeatConsecutive ||
        this.signatureFrequency() >= this.options.toolRepeatWindowThreshold)
    ) {
      active = "tool-repeat";
      messages = {
        nudge: repeatedCallNudge(obs.toolCalls[0]?.name),
        note: "identical successful tool call repeated three times — the model was told to change approach.",
        stop: `The model called "${obs.toolCalls[0]?.name ?? "?"}" with identical arguments without making progress.`,
      };
    } else if (
      this.options.guardResponse &&
      isRepetitiveThinking(obs.content, this.options.answerThreshold, this.options.answerMinTokens)
    ) {
      active = "response";
      messages = {
        nudge:
          "Your previous answer repeated itself. Do NOT repeat it: give a concise, complete answer or take the next action.",
        note: "response loop detected in the answer — the model was told to stop repeating.",
        stop: "The model kept repeating the same answer.",
      };
    } else {
      const similarity = thinkingSimilarity(this.prevThinking, obs.thinking);
      if (obs.thinking.trim().length > this.options.crossTurnMinLength && similarity >= this.options.crossTurnSimilarity) {
        active = "reasoning";
        messages = {
          nudge:
            "Your reasoning is repeating the SAME content as the previous turn. Stop re-reasoning and act: call the " +
            "next tool or write your final answer.",
          note: "cross-turn reasoning loop — the model was told to stop re-reasoning and act.",
          stop: "The model kept repeating the same reasoning across turns.",
        };
      }
    }

    this.prevThinking = obs.thinking;

    // A type that is no longer active must not carry its escalation forward.
    for (const t of LOOP_TYPES) if (t !== active) this.levels.delete(t);

    if (!active || !messages) return { kind: "continue" };
    return this.escalate(active, messages);
  }

  /** Highest number of times any single turn-signature recurs in the window.
   * Catches non-consecutive cycles (A/B/A/B) that `signatureRepeats` cannot. */
  private signatureFrequency(): number {
    const counts = new Map<string, number>();
    let max = 0;
    for (const sig of this.recentSignatures) {
      const n = (counts.get(sig) ?? 0) + 1;
      counts.set(sig, n);
      if (n > max) max = n;
    }
    return max;
  }

  private escalate(type: LoopType, m: ReactionMessages): LoopDecision {
    const level = (this.levels.get(type) ?? 0) + 1;
    this.levels.set(type, level);
    if (level > this.options.maxNudges) {
      return { kind: "stop", type, level, message: m.stop, note: m.note };
    }
    return { kind: "react", type, level, nudge: m.nudge, note: m.note };
  }
}
