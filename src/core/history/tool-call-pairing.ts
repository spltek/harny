/**
 * The tool-call pairing invariant, as the providers enforce it:
 *
 *   An assistant message carrying `toolCalls` MUST be followed IMMEDIATELY by one
 *   `tool` message per `toolCallId` (no other message in between), and a `tool`
 *   message must belong to the assistant turn right before it.
 *
 * Breaking it is not a degradation: the provider rejects the WHOLE request with a
 * 400 ("An assistant message with 'tool_calls' must be followed by tool messages
 * responding to each 'tool_call_id'"), so a single broken pair wedges the session
 * on every subsequent send — the failure mode this module exists to make visible.
 *
 * Violations are reported on the CONVERSATION (what actually goes out), so
 * `uiOnly` messages are skipped: they are never sent, so they cannot break the
 * pairing — even when they sit between a call and its results in storage.
 */

export interface PairingViolation {
  /** Index in the conversation of the message at fault. */
  index: number;
  kind: "missing_results" | "orphan_tool_result";
  /** The tool-call ids involved (unanswered calls, or the orphan's id). */
  ids: string[];
}

/**
 * What the invariant needs to see. Structural on purpose: it validates the stored
 * history (`ChatMessage`) and the outgoing request (`LLMMessage`) with the SAME
 * rule, so the check can sit at the last point before the wire.
 */
export interface PairingMessage {
  role: "system" | "user" | "assistant" | "tool";
  toolCalls?: { id?: string }[];
  toolCallId?: string;
  uiOnly?: boolean;
}

/**
 * Every way the conversation violates the pairing invariant (empty = valid).
 * Pure and side-effect free: used as the request-boundary check AND as the test
 * oracle, so the rule lives in exactly one place.
 */
export function toolCallPairingViolations(messages: PairingMessage[]): PairingViolation[] {
  const conversation = messages.filter((m) => !m.uiOnly);
  const violations: PairingViolation[] = [];

  for (let i = 0; i < conversation.length; i++) {
    const m = conversation[i];

    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      // The results must be the CONTIGUOUS run of tool messages right after.
      const expected = m.toolCalls.map((tc) => tc.id).filter((id): id is string => !!id);
      const answered = new Set<string>();
      for (let j = i + 1; j < conversation.length && conversation[j].role === "tool"; j++) {
        const id = conversation[j].toolCallId;
        if (id) answered.add(id);
      }
      const missing = expected.filter((id) => !answered.has(id));
      if (missing.length > 0) violations.push({ index: i, kind: "missing_results", ids: missing });
      continue;
    }

    if (m.role === "tool") {
      // Belongs to the assistant turn immediately above (through its own run of
      // tool messages, so a batch's second result is not flagged).
      let k = i - 1;
      while (k >= 0 && conversation[k].role === "tool") k--;
      const owner = k >= 0 ? conversation[k] : undefined;
      const ids = owner?.role === "assistant" ? (owner.toolCalls ?? []).map((tc) => tc.id) : [];
      if (!owner || owner.role !== "assistant" || !m.toolCallId || !ids.includes(m.toolCallId)) {
        violations.push({ index: i, kind: "orphan_tool_result", ids: [String(m.toolCallId ?? "?")] });
      }
    }
  }

  return violations;
}

/** One line naming every violation — for the dev log and the explicit error. */
export function describePairingViolations(violations: PairingViolation[]): string {
  return violations
    .map((v) =>
      v.kind === "missing_results"
        ? `#${v.index}: assistant with tool_calls [${v.ids.join(", ")}] is not followed by their tool results`
        : `#${v.index}: tool result ${v.ids.join(", ")} does not answer the assistant turn above it`,
    )
    .join("; ");
}

/**
 * The index of the message that OPENS the turn containing `index`.
 *
 * A turn is an INPUT and everything it produced: a `user` message (a real prompt,
 * a harness nudge, a steer — all inputs) followed by whatever the model did until
 * the next input. Cutting by index alone can land in the middle of one, so every
 * cut is snapped to a group: from an input, to its final answer, with everything
 * in between.
 */
export function turnStart(messages: PairingMessage[], index: number): number {
  const from = Math.max(0, Math.min(index, messages.length));
  for (let k = from; k > 0; k--) {
    if (messages[k]?.role === "user") return k;
  }
  return 0; // a head with no input (a synthetic summary/system message)
}

/**
 * The cut point (EXCLUSIVE) that ENDS the turn containing `index`: the index of
 * the next turn's input (or the end of the conversation).
 *
 * Used by ⎇ branch, which copies "up to and including this reply": a reply can
 * carry text AND tool calls, and the model may continue with more tool turns
 * before it answers. Stopping at the clicked message (or right after its own
 * results) would copy half a turn — and could leave the copy with an unanswered
 * call, i.e. a session that cannot send anything. The whole group is copied
 * instead.
 */
export function turnEnd(messages: PairingMessage[], index: number): number {
  const from = Math.max(0, Math.min(index, messages.length));
  for (let k = from + 1; k < messages.length; k++) {
    if (messages[k]?.role === "user") return k;
  }
  return messages.length;
}
