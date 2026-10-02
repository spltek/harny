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
  | "tool-repeat";

export const LOOP_TYPES: readonly LoopType[] = [
  "reasoning",
  "empty",
  "tool-failure",
  "error-streak",
  "tool-repeat",
];

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
 * Design:
 *  · every loop type escalates INDEPENDENTLY (up to `maxLevel` reactive nudges,
 *    then a final stop);
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

  constructor(private readonly maxLevel = 2) {}

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
  }

  /** Reset the per-turn reasoning detector (keeps the escalation levels). */
  beginTurn(): void {
    this.lastThinkingCheck = 0;
    this.reasoningBroken = false;
  }

  // ── Mid-stream reasoning loop ─────────────────────────────────────────

  /**
   * Feed the accumulated reasoning text. Returns true ONCE when a within-turn
   * reasoning loop is detected, so the caller can cut the stream and nudge.
   * Cheap enough to call on every delta (amortised: re-checks at most every
   * 200 chars).
   */
  observeThinking(fullText: string): boolean {
    if (this.reasoningBroken) return false;
    if (fullText.length < 200) return false;
    if (fullText.length - this.lastThinkingCheck < 200) return false;
    this.lastThinkingCheck = fullText.length;
    if (isRepetitiveThinking(fullText)) {
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
      if (this.inFlight.has(sig)) {
        return {
          mode: "refuse",
          content: `⛔ Loop guard: an identical ${tc.name} call is already running this turn; not started twice.`,
        };
      }
    }
    this.inFlight.add(sig);
    return { mode: "run" };
  }

  /** Record the outcome of a tool call that actually ran. */
  afterToolCall(tc: ToolCall, isError: boolean, content: string, readOnly: boolean): void {
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
      if (this.recentSignatures.length > SIGNATURE_WINDOW) this.recentSignatures.shift();
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
    } else if (allFailed && this.signatureRepeats >= 2) {
      active = "tool-failure";
      messages = {
        nudge:
          "Your last tool call(s) failed with the SAME arguments as before, and identical failures are no longer " +
          "re-run. Do NOT repeat them. Re-Read the target, fix the arguments, or use a different tool/approach.",
        note: "the same failing tool call repeated — it was not re-run and a corrective was injected.",
        stop: "The model kept repeating the same failing tool call.",
      };
    } else if (allFailed && this.errorStreak >= 3) {
      active = "error-streak";
      const names = obs.toolResults.map((r) => r.name).join(", ");
      messages = {
        nudge:
          `${this.errorStreak} turns in a row ended with ALL tools failing (${names}). Step back: state the blocker in ` +
          "one line, then try a DIFFERENT approach (different tool or arguments). Do not repeat the same failing calls.",
        note: `error streak (${this.errorStreak} turns of failures) — the model was asked to change strategy.`,
        stop: `The model could not recover after ${this.errorStreak} consecutive turns of tool errors (${names}).`,
      };
    } else if (!allFailed && (this.signatureRepeats >= 3 || this.signatureFrequency() >= SIGNATURE_REPEAT_LIMIT)) {
      active = "tool-repeat";
      messages = {
        nudge: repeatedCallNudge(obs.toolCalls[0]?.name),
        note: "identical successful tool call repeated three times — the model was told to change approach.",
        stop: `The model called "${obs.toolCalls[0]?.name ?? "?"}" with identical arguments without making progress.`,
      };
    } else {
      const similarity = thinkingSimilarity(this.prevThinking, obs.thinking);
      if (obs.thinking.trim().length > 120 && similarity >= 0.85) {
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
    if (level > this.maxLevel) {
      return { kind: "stop", type, level, message: m.stop, note: m.note };
    }
    return { kind: "react", type, level, nudge: m.nudge, note: m.note };
  }
}
