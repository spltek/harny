import type { ToolCall } from "../tools/tool";

/**
 * May this call's ARGUMENTS be trusted?
 *
 * ONE responsibility, and it belongs to nobody else: a tool call can be stopped mid-emission by
 * the output-token limit (`finish_reason: "length"`), and what arrives is half an argument. A
 * `Write` whose `contents` was cut writes a TRUNCATED FILE; a `Shell` whose command was cut runs
 * something else; a `Delegate` whose `goal` was cut starts a sub-agent on half a task. None of
 * these is recoverable by looking at the result afterwards — by then the file is on disk.
 *
 * WHY A MODULE AND NOT A BRANCH IN THE AGENT:
 *  · the refusal must hold for EVERY caller — the session agent, every sub-agent, every delegated
 *    child — and they all share one choke point (`Agent.executeToolSafely`), so the rule and its
 *    wording live together and the agent only asks "may this run?";
 *  · the wording is the model's ONLY channel to learn why it failed, so it is part of the rule,
 *    not an `if` with a template next to it;
 *  · it is pure, so every edge case is testable without an LLM, a tool, or a run.
 *
 * THE DISTINCTION THAT MAKES IT PRECISE. Two different facts arrive on a call:
 *  · `repaired` / `malformed` — the JSON did not arrive CLEAN. On a healthy turn this is normal
 *    (models emit sloppy or fenced JSON) and is repaired on purpose; see tool-call-accumulator.
 *  · `truncated` — the STREAM was cut. Only together do they mean "this is half an argument".
 * A cut turn whose JSON happened to close before the cut (`truncated` alone) is a COMPLETE call
 * and must run: refusing it would turn a rare hiccup into a lost turn for no reason.
 */

/** The finish reason that means "the model was stopped by its output budget", spelled once. */
const TRUNCATED_FINISH_REASON = "length";

/**
 * Stamp every call of a CUT turn with {@link ToolCall.truncated}.
 *
 * Pure and allocation-free on the normal path: when the turn was not cut the SAME array is
 * returned, so a healthy turn pays one comparison and keeps its calls untouched.
 *
 * The stamp travels WITH the call (a field, not agent state) for two reasons: nothing stale can
 * survive into the next turn, and every consumer of a `ToolCall` — the executor, a sub-agent, a
 * test, the transcript on disk — reads the same fact without asking the agent.
 */
export function markTruncatedCalls(calls: ToolCall[], finishReason: string | undefined): ToolCall[] {
  if (finishReason !== TRUNCATED_FINISH_REASON || calls.length === 0) return calls;
  return calls.map((call) => ({ ...call, truncated: true }));
}

/**
 * The refusal shown to the model for a call whose arguments cannot be trusted, or `undefined`
 * when the call may run.
 *
 * Deliberately `undefined` for an unclean call on a turn that was NOT cut: that is the
 * `malformed` path the agent already owns, with a different diagnosis and a different remedy
 * ("emit valid JSON", not "you were cut — split the work"). Keeping them apart is what lets each
 * message say the one thing that helps.
 */
export function argumentIntegrityRefusal(call: ToolCall): string | undefined {
  if (!call.truncated) return undefined;
  // A cut turn with CLEANLY parsed arguments is a complete call: the model emitted the closing
  // brace and was stopped afterwards. It runs. Only an argument that had to be reconstructed — or
  // could not be parsed at all — is half of something.
  const why = call.malformed
    ? "nothing parseable arrived"
    : call.repaired
      ? "they had to be rebuilt from an incomplete fragment"
      : "";
  if (!why) return undefined;
  return (
    `Tool ${call.name}: NOT executed — this call was cut by the output-token limit ` +
    `(finish_reason=length), so its arguments are incomplete: ${why}. Running a reconstructed ` +
    `argument would write or execute something you never asked for. Re-emit this call with the ` +
    `COMPLETE arguments, or split the work into smaller steps.`
  );
}
