import type { ChatMessage } from "./types";

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
 * The cut point (EXCLUSIVE) that includes the turn at `index` AND the results of
 * the tools it called.
 *
 * Used by ⎇ branch, which copies "up to and including this reply": a reply can
 * carry both text and tool calls, and cutting right after the message would leave
 * the copied session with a call whose results stayed behind — a session that is
 * born unable to send anything. When the results are NOT there (an already
 * damaged history) the call is left out too, so the damage is never propagated.
 */
export function cutAfterTurn(messages: ChatMessage[], index: number): number {
  const end = index + 1;
  const m = messages[index];
  if (!m || m.role !== "assistant" || !m.toolCalls?.length) return end;
  const expected = m.toolCalls.map((tc) => tc.id).filter((id): id is string => !!id);
  let j = end;
  while (j < messages.length && messages[j].role === "tool") j++;
  const answered = new Set(messages.slice(end, j).map((t) => t.toolCallId));
  if (expected.some((id) => !answered.has(id))) return index;
  return j;
}

/**
 * The start index a KEPT TAIL may safely begin at, moving BACK when the chosen
 * boundary would leave tool results whose call is not in the tail: a conversation
 * that starts with a `tool` message has no `tool_calls` above it, and the
 * provider rejects it. Used by compaction, which picks its boundary by token
 * count and cannot know where the turn boundaries are.
 */
export function snapTailStart(messages: ChatMessage[], index: number): number {
  let start = Math.max(0, Math.min(index, messages.length));
  while (start > 0 && messages[start]?.role === "tool") start--;
  return start;
}
