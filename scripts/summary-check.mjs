#!/usr/bin/env node
/**
 * Measure ONE thing: can the work be resumed from the state document alone?
 *
 * A compaction replaces the past with a single document, so that document carries the
 * whole job. Its own prompt states the test — "an agent that has ONLY this document must
 * be able to continue" — so this asks exactly that and COUNTS what the document cannot
 * answer. No past is sent, no quality is opined, no model is special-cased: one call,
 * one mission, one number.
 *
 *   node scripts/summary-check.mjs --list --filter deepseek   # what the provider offers
 *   node scripts/summary-check.mjs --session "Test compact"   # the negative control
 *   node scripts/summary-check.mjs                            # newest document
 *   node scripts/summary-check.mjs --doc summary.md            # any document, no DB
 *
 * The API key is read from the extension's config at runtime and never printed.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const HOME = join(homedir(), "Library/Application Support/Code/User/globalStorage/spltek.harny");
const config = JSON.parse(readFileSync(join(HOME, "config.json"), "utf8"));
const providerName = arg("provider", config.provider ?? "openrouter");
const provider = config.providers?.[providerName] ?? {};
const model = arg("model", "openrouter/free");
const base = (provider.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
const auth = { authorization: `Bearer ${provider.apiKey ?? ""}` };

// ---- --list: the provider itself says what it has, instead of us guessing ids --------
if (args.includes("--list")) {
  const res = await fetch(`${base}/models`, { headers: auth });
  const raw = await res.text();
  if (!res.ok) {
    console.error(`HTTP ${res.status} from ${providerName}: ${raw.slice(0, 300)}`);
    process.exit(1);
  }
  const filter = arg("filter", "");
  const ids = (JSON.parse(raw).data ?? []).map((m) => m.id).filter((id) => id.includes(filter));
  console.log(ids.length ? ids.join("\n") : `(no id matching "${filter}")`);
  process.exit(0);
}

// ---- --generate: the REAL summary prompt over the WHOLE past, in ONE call -----------
// This is what the design says a compaction IS: a separate agent, maximum context, all
// the past, one Markdown document. The product instead plans against the SESSION's window
// (and reserves 8192 output + 2000 prompt), so it summarizes a slice. Here: no slice.
if (args.includes("--generate")) {
  const sessionName = arg("session", null);
  if (!sessionName) throw new Error("--generate needs --session");
  const db = join(HOME, "sessions.db");
  const rows = (sql) => JSON.parse(execFileSync("sqlite3", ["-json", db, sql], { encoding: "utf8" }) || "[]");
  const id = rows(`SELECT id FROM sessions WHERE name='${sessionName.replace(/'/g, "''")}' LIMIT 1;`)[0]?.id;
  if (!id) throw new Error(`no session named "${sessionName}"`);
  const pair = rows(
    `SELECT seq FROM messages WHERE session_id='${id}' AND role='user' ` +
      "AND COALESCE(data,'') LIKE '%synthetic%' ORDER BY seq DESC LIMIT 1;",
  )[0];
  if (!pair) throw new Error("no checkpoint in that session");
  const span = rows(
    `SELECT role, COALESCE(content,'') AS content FROM messages ` +
      `WHERE session_id='${id}' AND seq < ${pair.seq} ORDER BY seq;`,
  );
  const transcript = span.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");
  // The prompt is READ FROM THE SOURCE, so it cannot drift from what the product sends.
  const src = readFileSync(new URL("../src/core/sessions/compactor.ts", import.meta.url), "utf8");
  const prompt = src.match(/const SUMMARY_PROMPT = `([\s\S]*?)`;/)?.[1];
  if (!prompt) throw new Error("SUMMARY_PROMPT not found in compactor.ts");

  console.error(
    `span: ${span.length} messages, ${transcript.length} chars (~${Math.round(transcript.length / 4)} tokens)`,
  );
  const gen = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...auth,
      ...(provider.sessionHeader ? { [provider.sessionHeader]: "harny-summary-check" } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: transcript },
      ],
      temperature: 0.3,
    }),
  });
  const genRaw = await gen.text();
  if (!gen.ok) {
    console.error(`HTTP ${gen.status} from ${providerName}: ${genRaw.slice(0, 400)}`);
    process.exit(1);
  };
  const summary = (JSON.parse(genRaw).choices?.[0]?.message?.content ?? "").trim();
  const out = arg("out", null);
  if (out) writeFileSync(out, summary);
  console.log(summary);
  console.error(`\nsummary: ${summary.length} chars${out ? ` -> ${out}` : ""}`);
  process.exit(0);
}

// ---- the document: the newest synthetic state, or one handed to us -------------------
let doc = null;
let label = "(document)";
const docPath = arg("doc", null);
if (docPath) {
  doc = readFileSync(docPath, "utf8");
} else {
  const db = join(HOME, "sessions.db");
  const q = (sql) => execFileSync("sqlite3", [db, sql], { encoding: "utf8" }).trim();
  const sessionName = arg("session", null);
  const id = sessionName
    ? q(`SELECT id FROM sessions WHERE name='${sessionName.replace(/'/g, "''")}' LIMIT 1;`)
    : q(
        "SELECT session_id FROM messages WHERE role='assistant' AND COALESCE(data,'') LIKE '%synthetic%' " +
          "ORDER BY timestamp DESC LIMIT 1;",
      );
  if (!id) throw new Error("no synthetic state document found");
  label = q(`SELECT name FROM sessions WHERE id='${id}';`);
  // The state is the ASSISTANT half; the user half is only the orange label.
  doc = q(
    `SELECT content FROM messages WHERE session_id='${id}' AND role='assistant' ` +
      "AND COALESCE(data,'') LIKE '%synthetic%' ORDER BY seq DESC LIMIT 1;",
  );
}

// ---- ONE mission: resume the work, and say what is missing --------------------------
const mission = [
  "You have ONLY the document below about a coding session. Nothing else.",
  "",
  "Answer in exactly this form:",
  'NEXT: <the one concrete next action, or "unknown">',
  "UNKNOWN: <a numbered list of what you cannot determine from this document alone>",
  "",
  "<document>",
  doc,
  "</document>",
].join("\n");

// ---- one call ----------------------------------------------------------------------
const headers = { "content-type": "application/json", ...auth };
// Some providers route per conversation and refuse the call without an id (OpenCode Go
// answers MissingSessionID). Any stable value works: this is a probe, not a session.
if (provider.sessionHeader) headers[provider.sessionHeader] = "harny-summary-check";
if (base.includes("openrouter.ai")) {
  headers["http-referer"] = "https://github.com/spltek/harny";
  headers["x-title"] = "harny";
}

const res = await fetch(`${base}/chat/completions`, {
  method: "POST",
  headers,
  body: JSON.stringify({ model, messages: [{ role: "user", content: mission }], temperature: 0 }),
});
const raw = await res.text();
if (!res.ok) {
  console.error(`HTTP ${res.status} from ${providerName}: ${raw.slice(0, 400)}`);
  process.exit(1);
}

// ---- the numbers -------------------------------------------------------------------
const reply = (JSON.parse(raw).choices?.[0]?.message?.content ?? "").trim();
const next = (reply.match(/NEXT:\s*(.+)/i)?.[1] ?? "").trim();
const unknownBlock = reply.split(/UNKNOWN:/i)[1] ?? "";
const unknowns = (unknownBlock.match(/^\s*\d+\./gm) ?? []).length;

console.log(`model:    ${model} (${providerName})`);
console.log(`session:  ${label}`);
console.log(`document: ${doc.length} chars`);
console.log("--- reply ---");
console.log(reply);
console.log("--- verdict ---");
console.log(`NEXT:     ${next || "(none)"}`);
console.log(`UNKNOWNS: ${unknowns}`);
