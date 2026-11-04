/**
 * THE RULES A CONVERSATION MUST SATISFY TO BE SENT.
 *
 * A chat request is not "whatever is in the session": it must be a sequence the
 * provider accepts. Harny speaks the OpenAI chat-completions protocol (with the
 * strict-server quirks this codebase already met: "Empty tool_calls is not
 * supported", a hard context ceiling counting input + max_tokens, …), and every
 * rule below was either observed in the wild or would break the WHOLE request —
 * not degrade it. One broken sequence wedges the session on every later send,
 * because the same conversation is re-sent each time.
 *
 * The rules, and who guarantees them:
 *
 *  1. A turn that called tools must be followed IMMEDIATELY by one `tool` message
 *     per `toolCallId` — no message in between.        [prevented: group append]
 *  2. A `tool` message must answer the assistant turn above it.   [same]
 *  3. Every `tool` message must carry its id (the wire drops it otherwise).
 *                                                        [prevented: accumulator
 *                                                         synthesizes missing ids]
 *  4. Tool-call ids must be unique inside a turn, and answered once each.
 *  5. A `tool` result must not be empty: a blank payload is rejected by strict
 *     servers AND tells the model nothing about what happened.
 *                                                      [prevented: executeToolSafely]
 *  6. An assistant message with neither text nor tool calls says nothing and is
 *     rejected by strict servers.                        [prevented: the stall
 *                                                         guard nudges instead]
 *  7. The conversation must start with the actual input (a `user` message).
 *  8. Attachments (images) belong to USER messages only: the wire turns them into
 *     a multimodal payload, which other roles do not accept.
 *
 * Rules 1–2 are the ones that actually bit us; 3–8 are cheap insurance against a
 * producer that does not exist yet (or a session stored by an older build). This
 * module is the SINGLE place where "acceptable to send" is defined: the request
 * builder checks it after building the payload, and refuses to send when it fails
 * — naming the fault instead of letting the provider answer with an opaque 400.
 *
 * Checks run on the CONVERSATION (what actually goes out), so `uiOnly` messages
 * are skipped: they are never sent, so they cannot break anything — even when they
 * sit between a call and its results in storage.
 */

export type FaultKind =
  | "missing_tool_results"
  | "orphan_tool_result"
  | "tool_result_without_id"
  | "duplicate_tool_call_id"
  | "empty_tool_result"
  | "empty_assistant"
  | "conversation_starts_with_role"
  | "attachment_outside_user";

export interface ConversationFault {
  /** Index in the conversation of the message at fault. */
  index: number;
  kind: FaultKind;
  /** Ids (tool calls/results) or the role involved — for the message. */
  ids: string[];
}

/**
 * What the rules need to see. Structural on purpose: it validates the stored
 * history (`ChatMessage`) and the outgoing request (`LLMMessage`) with the SAME
 * rules, so the check can sit at the last point before the wire.
 */
export interface PairingMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  toolCalls?: { id?: string }[];
  toolCallId?: string;
  images?: string[];
  uiOnly?: boolean;
  /** True on the synthetic pair a compaction leaves (see checkpointStart). */
  synthetic?: boolean;
}

/**
 * Every way the conversation is unfit to send (empty = valid). Pure and
 * side-effect free: used as the request-boundary check AND as the test oracle, so
 * each rule lives in exactly one place.
 */
export function conversationFaults(messages: PairingMessage[]): ConversationFault[] {
  const conversation = messages.filter((m) => !m.uiOnly);
  const faults: ConversationFault[] = [];

  // Rule 7: the request opens with the input. The system prompt is prepended by
  // the request builder, so the first USER-ish message must be a user one: a
  // conversation starting with the model's own words has no anchoring request.
  const first = conversation.find((m) => m.role !== "system");
  if (first && first.role !== "user") {
    faults.push({ index: conversation.indexOf(first), kind: "conversation_starts_with_role", ids: [first.role] });
  }

  for (let i = 0; i < conversation.length; i++) {
    const m = conversation[i];

    // Rule 8: attachments only on user messages.
    if (m.role !== "user" && m.images && m.images.length > 0) {
      faults.push({ index: i, kind: "attachment_outside_user", ids: [m.role] });
    }

    if (m.role === "tool") {
      // Rule 2 (owner) and 3 (its own id).
      let k = i - 1;
      while (k >= 0 && conversation[k].role === "tool") k--;
      const owner = k >= 0 ? conversation[k] : undefined;
      const ids = owner?.role === "assistant" ? (owner.toolCalls ?? []).map((tc) => tc.id) : [];
      if (!m.toolCallId) {
        faults.push({ index: i, kind: "tool_result_without_id", ids: [] });
      } else if (owner?.role !== "assistant" || !ids.includes(m.toolCallId)) {
        faults.push({ index: i, kind: "orphan_tool_result", ids: [m.toolCallId] });
      }
      // Rule 5: a blank result is rejected by strict servers and says nothing.
      if (!(m.content ?? "").trim()) {
        faults.push({ index: i, kind: "empty_tool_result", ids: [m.toolCallId ?? "?"] });
      }
      continue;
    }

    if (m.role === "assistant") {
      const calls = m.toolCalls ?? [];

      // Rule 6: neither text nor tool calls — nothing to say.
      if (calls.length === 0 && !(m.content ?? "").trim()) {
        faults.push({ index: i, kind: "empty_assistant", ids: [] });
        continue;
      }

      if (calls.length === 0) continue;

      // Rule 4: unique ids inside the turn.
      const all = calls.map((tc) => tc.id).filter((id): id is string => !!id);
      const duplicates = all.filter((id, n) => all.indexOf(id) !== n);
      if (duplicates.length > 0) {
        faults.push({ index: i, kind: "duplicate_tool_call_id", ids: [...new Set(duplicates)] });
      }

      // Rules 1 and 4: the results are the CONTIGUOUS run right after, one per
      // id, and each id is answered exactly once.
      const answered: string[] = [];
      for (let j = i + 1; j < conversation.length && conversation[j].role === "tool"; j++) {
        const id = conversation[j].toolCallId;
        if (id) answered.push(id);
      }
      const missing = all.filter((id) => !answered.includes(id));
      if (missing.length > 0) faults.push({ index: i, kind: "missing_tool_results", ids: missing });
      const twice = answered.filter((id, n) => answered.indexOf(id) !== n);
      if (twice.length > 0) {
        faults.push({ index: i, kind: "duplicate_tool_call_id", ids: [...new Set(twice)] });
      }
    }
  }

  return faults;
}

/** One line naming every fault — for the dev log and the explicit error. */
export function describeFaults(faults: ConversationFault[]): string {
  return faults
    .map((f) => {
      const ids = f.ids.length > 0 ? ` [${f.ids.join(", ")}]` : "";
      switch (f.kind) {
        case "missing_tool_results":
          return `#${f.index}: assistant with tool_calls${ids} is not followed by their tool results`;
        case "orphan_tool_result":
          return `#${f.index}: tool result${ids} does not answer the assistant turn above it`;
        case "tool_result_without_id":
          return `#${f.index}: tool result without a tool_call_id`;
        case "duplicate_tool_call_id":
          return `#${f.index}: tool-call id${ids} is used twice`;
        case "empty_tool_result":
          return `#${f.index}: tool result${ids} has no content`;
        case "empty_assistant":
          return `#${f.index}: assistant message with no text and no tool calls`;
        case "conversation_starts_with_role":
          return `#${f.index}: the conversation starts with a ${f.ids[0]} message, not the user's input`;
        case "attachment_outside_user":
          return `#${f.index}: ${f.ids[0]} message carries attachments (only user messages may)`;
      }
    })
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

/** The minimum {@link checkpointStart} needs to see — structural, so the stored
 * history (`ChatMessage`) AND the webview's own message shape both fit without a
 * cast. The boundary is a property of `synthetic` and nothing else. */
interface CheckpointMessage {
  role: string;
  synthetic?: boolean;
}

/**
 * The index of the message that OPENS the newest SUMMARY CHECKPOINT (0 when the
 * session has none).
 *
 * A checkpoint is the synthetic pair a compaction leaves: a `user` label
 * ("Summary of past interactions") and the `assistant` summary itself. It is the
 * ONE point the context window starts from — everything before it stays in the
 * session, readable and searchable, but is no longer sent to the model.
 *
 * The marker is STORED, never recomputed from a position or a token count. That
 * is what keeps the request prefix stable between turns, and therefore the
 * provider's prompt cache warm: a boundary that moved by itself every turn would
 * invalidate the cache on every request.
 *
 * Returns the START of the pair, so the checkpoint itself is always included —
 * the model needs it: it is the state of the work it is continuing.
 */
export function checkpointStart(messages: readonly CheckpointMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m.synthetic) continue;
    // The pair is [user(label), assistant(summary)]: when the newest synthetic
    // message is the summary, the boundary is the label above it. A lone
    // synthetic message is a boundary on its own.
    return m.role === "assistant" && i > 0 && messages[i - 1]?.synthetic ? i - 1 : i;
  }
  return 0;
}

/**
 * The cut point (EXCLUSIVE) that ENDS the OLDEST summary checkpoint: where a
 * transcript stops when it is REWOUND to its first summary.
 *
 * The counterpart of {@link checkpointStart}, which finds the NEWEST checkpoint —
 * the one the context window starts from. A rewind keeps the history up to and
 * including the FIRST summary and drops everything after it, so what is left is a
 * session whose whole past is condensed into that single state document: the
 * latest checkpoint of the shortened array IS the pair that was kept, and the
 * model's window opens on it exactly as a compaction leaves it.
 *
 * Returns 0 when there is no summary at all: nothing to rewind to.
 */
export function firstCheckpointEnd(messages: readonly CheckpointMessage[]): number {
  const i = messages.findIndex((m) => m.synthetic === true);
  if (i < 0) return 0;
  // Cut AFTER the pair, never between its halves: a label without its summary
  // would open the window on a promise with no state behind it.
  return i + 1 < messages.length && messages[i + 1]?.synthetic ? i + 2 : i + 1;
}
