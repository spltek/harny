#!/usr/bin/env node
/**
 * usage-report — "am I spending too much?" answered with the numbers Harny already stored.
 *
 * READ-ONLY by construction: the database is opened with `readOnly: true`, so a report can never
 * become a mutation. It reads `<harny home>/sessions.db` (the same file the extension opens) and
 * prints, per session, where the tokens actually went:
 *
 *   · TURNS / INPUT / OUTPUT — provider-reported usage, summed over the assistant turns;
 *   · INPUT/turn — the average prompt size: this is what the CONTEXT pays per request, and it is
 *     the number that decides whether a session is expensive;
 *   · CACHED% — the share served from the provider's prompt cache. ~0 with a growing input means
 *     the prefix is being invalidated (mode switch, tool toggle, compaction) or the backend has no
 *     caching at all;
 *   · THINK — the tokens of reasoning carried by the history (chars / 4): reasoning is echoed back
 *     on every later request, so this is INPUT nobody asked for twice;
 *   · DELEG — how many Delegate calls the session made (each one is a fresh conversation with the
 *     whole system prompt and tool schemas, on the same machine);
 *   · CMP — how many compaction pairs are in the transcript.
 *
 * Usage:
 *   node scripts/usage-report.mjs                 # the 15 most recent sessions
 *   node scripts/usage-report.mjs --all           # every session
 *   node scripts/usage-report.mjs --session <id>  # one session, turn by turn
 *   node scripts/usage-report.mjs --db <path>     # an explicit database file
 *
 * The home resolution mirrors src/core/storage/home.ts: HARNY_HOME, else the extension's
 * globalStorage folder for the editor in use (vscodium, code, code-insiders, cursor…).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const EXTENSION_ID = "spltek.harny";
const APP_SUPPORT = join(homedir(), "Library", "Application Support");
const ELECTRON_APPS = [
  "VSCodium",
  "VSCodium - Insiders",
  "Code",
  "Code - Insiders",
  "Cursor",
  "Windsurf",
  "Trae",
  "Positron",
];

/** Candidate homes, in the order the extension could have used them. */
function candidateDbPaths() {
  const out = [];
  if (process.env.HARNY_HOME) out.push(join(process.env.HARNY_HOME, "sessions.db"));
  for (const app of ELECTRON_APPS) {
    // macOS: ~/Library/Application Support/<app>/User/globalStorage/…
    out.push(join(APP_SUPPORT, app, "User", "globalStorage", EXTENSION_ID, "sessions.db"));
    // Linux/Windows shapes (harmless here, free portability for the next machine)
    out.push(join(homedir(), ".config", app, "User", "globalStorage", EXTENSION_ID, "sessions.db"));
    out.push(join(homedir(), "AppData", "Roaming", app, "User", "globalStorage", EXTENSION_ID, "sessions.db"));
  }
  return out;
}

function parseArgs(argv) {
  const args = { all: false, session: null, db: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") args.all = true;
    else if (a === "--session") args.session = argv[++i] ?? null;
    else if (a === "--db") args.db = argv[++i] ?? null;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

const HELP = `usage-report — where the tokens went, straight from sessions.db (read-only)

  node scripts/usage-report.mjs                 the 15 most recent sessions
  node scripts/usage-report.mjs --all           every session
  node scripts/usage-report.mjs --session <id>  one session, turn by turn
  node scripts/usage-report.mjs --db <path>     an explicit database file
`;

/** Compact one number for a table cell. */
function num(v) {
  if (v === undefined || v === null || Number.isNaN(v)) return "—";
  const n = Number(v);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

function pct(part, whole) {
  if (!whole) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

/** SQLite INTEGER can come back as BigInt from node:sqlite. */
function n(v) {
  if (typeof v === "bigint") return Number(v);
  return typeof v === "number" ? v : Number(v ?? 0);
}

/** Everything the report needs about one session, in one pass over its rows. */
function sessionStats(db, sessionId) {
  const rows = db
    .prepare("SELECT seq, role, content, data FROM messages WHERE session_id = ? ORDER BY seq")
    .all(sessionId);
  const s = {
    turns: 0,
    input: 0,
    output: 0,
    cached: 0,
    cacheWrite: 0,
    maxInput: 0,
    thinkingChars: 0,
    assistantChars: 0,
    toolChars: 0,
    delegateCalls: 0,
    synthetic: 0,
    images: 0,
    perTurn: [],
  };
  for (const r of rows) {
    let m;
    try {
      m = JSON.parse(r.data);
    } catch {
      continue; // an unreadable row is not worth failing the whole report over
    }
    const chars = typeof m.content === "string" ? m.content.length : 0;
    if (m.role === "tool") s.toolChars += chars;
    if (m.role === "assistant") {
      s.assistantChars += chars;
      if (typeof m.thinking === "string") s.thinkingChars += m.thinking.length;
      const meta = m.meta ?? {};
      if (typeof meta.inputTokens === "number") {
        s.turns++;
        s.input += meta.inputTokens;
        s.output += n(meta.outputTokens);
        s.cached += n(meta.cachedTokens);
        s.cacheWrite += n(meta.cachedWriteTokens);
        s.maxInput = Math.max(s.maxInput, meta.inputTokens);
        s.perTurn.push({
          seq: n(r.seq),
          input: meta.inputTokens,
          output: n(meta.outputTokens),
          cached: n(meta.cachedTokens),
          thinking: typeof m.thinking === "string" ? m.thinking.length : 0,
          calls: Array.isArray(m.toolCalls) ? m.toolCalls.length : 0,
        });
      }
      for (const tc of m.toolCalls ?? []) {
        if (tc?.name === "Delegate") s.delegateCalls++;
      }
    }
    if (Array.isArray(m.images)) s.images += m.images.length;
    if (m.synthetic) s.synthetic++;
  }
  return s;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  const path = args.db ?? candidateDbPaths().find((p) => existsSync(p));
  if (!path) {
    console.error("No sessions.db found. Pass --db <path> or set HARNY_HOME.");
    process.exitCode = 2;
    return;
  }
  console.log(`db: ${path}\n`);

  const db = new DatabaseSync(path, { readOnly: true });
  const sessions = db
    .prepare(
      `SELECT id, name, folder, updated_at, message_count, model, model_provider,
              thinking_level, context_window, compaction_threshold_percent,
              max_parallel_sub_agents, mode, parallel
         FROM sessions ORDER BY updated_at DESC`,
    )
    .all();

  const picked = args.session
    ? sessions.filter((s) => s.id === args.session)
    : args.all
      ? sessions
      : sessions.slice(0, 15);
  if (picked.length === 0) {
    console.error(args.session ? `No session with id ${args.session}.` : "No sessions.");
    return;
  }

  const head = [
    "session",
    "when",
    "model",
    "msg",
    "turns",
    "input",
    "out",
    "in/turn",
    "maxIn",
    "cache",
    "think",
    "deleg",
    "cmp",
  ];
  const widths = head.map((h) => h.length);
  const table = [];
  const totals = { turns: 0, input: 0, output: 0, cached: 0, delegateCalls: 0, thinkingChars: 0 };

  for (const s0 of picked) {
    const st = sessionStats(db, s0.id);
    totals.turns += st.turns;
    totals.input += st.input;
    totals.output += st.output;
    totals.cached += st.cached;
    totals.delegateCalls += st.delegateCalls;
    totals.thinkingChars += st.thinkingChars;
    const when = s0.updated_at ? new Date(n(s0.updated_at)).toISOString().slice(0, 16).replace("T", " ") : "—";
    const model = `${s0.model_provider ?? "?"}/${String(s0.model ?? "?")
      .split("/")
      .pop()}`.slice(0, 30);
    const row = [
      String(s0.name ?? s0.id).slice(0, 24),
      when,
      model,
      num(s0.message_count),
      num(st.turns),
      num(st.input),
      num(st.output),
      num(st.turns ? Math.round(st.input / st.turns) : 0),
      num(st.maxInput),
      pct(st.cached, st.input),
      num(st.thinkingChars / 4),
      num(st.delegateCalls),
      num(st.synthetic / 2),
    ];
    table.push({ row, id: s0.id, s: s0, st });
    row.forEach((c, i) => (widths[i] = Math.max(widths[i], c.length)));
  }

  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(line(head));
  console.log(line(widths.map((w) => "─".repeat(w))));
  for (const t of table) console.log(line(t.row));

  // The bottom line, and the two ratios that answer the question.
  console.log(
    `\nTOTAL ${num(totals.turns)} turns · input ${num(totals.input)} · output ${num(totals.output)}` +
      ` · cached ${pct(totals.cached, totals.input)} · thinking carried ~${num(totals.thinkingChars / 4)} tokens` +
      ` · ${num(totals.delegateCalls)} Delegate call(s)`,
  );

  // Per-session detail, turn by turn, when asked for ONE session.
  if (args.session && table.length === 1) {
    const { id, s, st } = table[0];
    console.log(`\n── ${s.name} (${id}) ─────────────────────────────`);
    console.log(
      `model ${s.model} · window ${num(s.context_window)} · compaction at ${s.compaction_threshold_percent ?? 80}%` +
        ` · parallel ${s.parallel ? "ON" : "off"} · max sub-agents ${num(s.max_parallel_sub_agents)}`,
    );
    console.log(
      `stored: assistant text ${num(st.assistantChars)} chars · tool output ${num(st.toolChars)} chars` +
        ` · thinking ${num(st.thinkingChars)} chars · images ${num(st.images)} · compaction pairs ${num(st.synthetic / 2)}`,
    );
    console.log("\nseq    input   out  cache  think   calls");
    for (const t of st.perTurn) {
      console.log(
        `${String(t.seq).padEnd(5)} ${num(t.input).padStart(6)} ${num(t.output).padStart(5)}` +
          ` ${pct(t.cached, t.input).padStart(6)} ${num(t.thinking / 4).padStart(6)} ${String(t.calls).padStart(6)}`,
      );
    }
  }

  db.close();
}

main();
