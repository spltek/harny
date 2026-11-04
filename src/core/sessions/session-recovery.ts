/**
 * SALVAGING A STORED SESSION.
 *
 * What this is NOT: a defence against a crash in the middle of a write. The store
 * already has that, and it is free — every write is ONE transaction (`BEGIN` …
 * `COMMIT`, with `ROLLBACK` on any error), so a process killed between two
 * statements finds the previous state byte for byte on the next open. The session
 * is either wholly the new one or wholly the old one; the worst case is losing the
 * LAST write, never a half-written one. `sqlite-session-store.test.ts` pins it by
 * killing a save mid-loop and re-opening the FILE.
 *
 * What this IS: the defence for damage a transaction cannot prevent.
 *
 *   1. `unreadable` — a row whose `data` no longer parses. A rotted disk block, a
 *      hand-edited database, a row written by a build that stored another shape.
 *      Without this the JSON.parse in `load()` throws and the session cannot be
 *      OPENED at all: one bad row costs the whole conversation.
 *
 *   2. `invalid_tail` — rows that parse but make a conversation the provider
 *      refuses: an assistant turn whose tool results are missing, a tool result
 *      whose call is gone. Every later request re-sends the same broken sequence,
 *      so the session is wedged forever, not degraded once.
 *      {@link conversationFaults} is the authority on what is broken; the same one
 *      the request builder uses before the wire.
 *
 * The rule is brutal and predictable ON PURPOSE: find the FIRST damage, cut there,
 * keep the head. A hole in the middle would leave `seq` values that are not
 * contiguous (the append path relies on the stored rows being a PREFIX of the
 * history) and tool pairs that are broken on both sides of the hole anyway. A
 * session is a log, and a log damaged half-way is worth the part before the damage.
 *
 * WHERE exactly the cut lands is not the whole turn: it is the damaged message. The
 * head that survives is therefore the conversation the rules already accept — and in
 * the common case (the answer was truncated) it ends with the user's PROMPT, so what
 * the user typed is still on screen and pressing Enter asks again, instead of the
 * question disappearing together with its broken answer.
 *
 * Two deliberate limits, so nothing is lost to a false positive:
 *
 *   · ONLY structural pairing faults are cut (see {@link CUTTABLE_FAULTS}). A
 *     content fault — an empty tool result, an empty assistant line — is a
 *     conversation the guard at the request boundary already refuses BY NAME;
 *     cutting a whole turn of real work for it would be worse than the refusal.
 *   · Nothing is ever written back from here. The trim lives in memory for the
 *     load, and the next ordinary save rewrites the stored rows (the prefix guard
 *     sees the mismatch and replaces them): the repair PERSISTS without this module
 *     ever issuing a destructive statement on a file it just found damaged.
 */

import { conversationFaults, type FaultKind, type PairingMessage } from "../history/conversation-validity";
import type { ChatMessage } from "../history/types";

/** Why a stored session had to lose its tail. */
export type RecoveryReason = "unreadable" | "invalid_tail";

/** What a load salvaged: the messages to USE, and what the database still holds beyond them. */
export interface RecoveredSession {
  messages: ChatMessage[];
  /** How many stored rows were left out of `messages` (0 = nothing was wrong). */
  dropped: number;
  /**
   * Present when the rules found a CUTTABLE fault (see {@link CUTTABLE_FAULTS});
   * `dropped` says how much went. Absent when the session loaded clean.
   */
  reason?: RecoveryReason;
}

/**
 * The faults that mean "this is not a log any more", i.e. the ones worth cutting
 * for. Everything else in {@link conversationFaults} describes a conversation that
 * is structurally sound but says something the wire dislikes: the request builder
 * refuses those with the fault's name, which tells the user more than a silently
 * shortened transcript ever could.
 */
const CUTTABLE_FAULTS: ReadonlySet<FaultKind> = new Set<FaultKind>([
  "missing_tool_results",
  "orphan_tool_result",
  "tool_result_without_id",
]);

/**
 * Parse the `data` column of a session's rows, in `seq` order, stopping at the
 * first row that does not parse: that row and everything after it are dropped
 * (`reason: "unreadable"`). A row that parses to something that is not a message is
 * treated the same way — a shape no producer of ours writes.
 */
export function parseStoredRows(rows: readonly string[]): RecoveredSession {
  const messages: ChatMessage[] = [];
  for (const raw of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { messages, dropped: rows.length - messages.length, reason: "unreadable" };
    }
    if (!isMessage(parsed)) return { messages, dropped: rows.length - messages.length, reason: "unreadable" };
    messages.push(parsed);
  }
  return { messages, dropped: 0 };
}

/**
 * Cut a tail the conversation rules reject. Returns `messages` untouched when the
 * conversation is sound — which is every session this build wrote, since the group
 * append and the tool accumulator are what prevent these shapes in the first place
 * (see the header of `conversation-validity.ts`).
 */
export function trimInvalidTail(messages: readonly ChatMessage[]): RecoveredSession {
  // The rules run on the CONVERSATION (what would be sent), so `uiOnly` rows are
  // invisible to them. Remember where each visible message sits in storage, so the
  // cut lands on a storage index.
  const conversation: PairingMessage[] = [];
  const storeIndex: number[] = [];
  messages.forEach((m, i) => {
    if (m.uiOnly) return;
    conversation.push(m);
    storeIndex.push(i);
  });

  const faults = conversationFaults(conversation);
  const first = faults.find((f) => CUTTABLE_FAULTS.has(f.kind));
  if (!first) return { messages: [...messages], dropped: 0 };

  // Cut AT the damaged message: the head before it has no fault at all (the fault list
  // is in index order and every structural one is cuttable), so what survives is a
  // conversation the rules accept on its own — a call without its results cannot be
  // kept, but the prompt that asked for it can, and losing it would delete the only
  // part of the turn the user wrote.
  const cut = storeIndex[first.index] ?? messages.length;
  return {
    messages: messages.slice(0, cut),
    dropped: messages.length - cut,
    // Unconditional: reaching this line MEANS the rules found damage, and the cut is
    // what tells how much of the log it cost. A `dropped: 0` here would be a fault on
    // a message that is not in storage at all — not a shape `conversationFaults` reports.
    reason: "invalid_tail",
  };
}

/**
 * The whole salvage, in the order that matters: parse first (the rules need messages),
 * then the rules — on the head that survived, because a missing middle is exactly what
 * leaves a call dangling at the end of it. Cheap by construction: one pass to parse,
 * one to check.
 *
 * The REPORTED reason is the parse damage when there was any: it is the root cause, and
 * naming the dangling call instead would send the reader looking for damage that is
 * somewhere else. The head is still trimmed, because a load must hand back a
 * conversation the request builder accepts — a salvage that keeps a dangling call is a
 * session that opens and then refuses every request.
 */
export function recoverSession(rows: readonly string[]): RecoveredSession {
  const parsed = parseStoredRows(rows);
  const trimmed = trimInvalidTail(parsed.messages);
  if (parsed.reason) {
    return { messages: trimmed.messages, dropped: rows.length - trimmed.messages.length, reason: parsed.reason };
  }
  return trimmed.reason ? trimmed : parsed;
}

/** A stored row is a message if it is an object with a string role — nothing more is required to OPEN it. */
function isMessage(value: unknown): value is ChatMessage {
  // `?.` covers the two shapes JSON can produce that are not objects: `null` and a
  // primitive (where `.role` is `undefined`, not a throw). A stored row is a message
  // when it carries a usable role, and an empty one is not usable: every consumer
  // switches on it.
  const role = (value as { role?: unknown } | null)?.role;
  return typeof role === "string" && role.length > 0;
}
