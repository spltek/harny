/**
 * Preprocess JSONC text for JSON.parse:
 * - removes // and /* *\/ comments (string contents preserved)
 * - removes trailing commas before } or ]
 */
export function preprocessJsonc(text: string): string {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];

    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }

    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    if (c === ",") {
      // Drop a trailing comma: look ahead past whitespace/comments for } or ]
      const j = skipWhitespaceAndComments(text, i + 1);
      if (text[j] === "}" || text[j] === "]") {
        i++;
        continue;
      }
    }

    out += c;
    i++;
  }
  return out;
}

function skipWhitespaceAndComments(text: string, start: number): number {
  let j = start;
  while (j < text.length) {
    const c = text[j];
    if (/\s/.test(c)) {
      j++;
      continue;
    }
    if (c === "/" && text[j + 1] === "/") {
      while (j < text.length && text[j] !== "\n") j++;
      continue;
    }
    if (c === "/" && text[j + 1] === "*") {
      j += 2;
      while (j < text.length && !(text[j] === "*" && text[j + 1] === "/")) j++;
      j += 2;
      continue;
    }
    break;
  }
  return j;
}

interface JsoncToken {
  type: "string" | "symbol" | "word";
  raw: string;
  start: number;
  end: number; // exclusive
  depth: number; // brace depth at the start of the token
}

/**
 * Lightweight tokenizer over raw JSONC text (strings + comments preserved
 * verbatim). Tracks brace depth so we can locate top-level members.
 */
type ScanResult = { tokens: JsoncToken[]; openBrace: number };

function scanJsonc(text: string): ScanResult {
  const tokens: JsoncToken[] = [];
  let i = 0;
  let depth = 0;
  let openBrace = -1;

  const push = (type: JsoncToken["type"], start: number, end: number): void => {
    tokens.push({ type, raw: text.slice(start, end), start, end, depth });
  };

  while (i < text.length) {
    const c = text[i];
    if (c === "\"") {
      const start = i;
      i++;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === "\"") {
          i++;
          break;
        }
        i++;
      }
      push("string", start, i);
      continue;
    }
    if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      if (text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++;
      } else {
        i += 2;
        while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
        i += 2;
      }
      continue; // comments are skipped (we do not need to emit them)
    }
    if (c === "{") {
      if (openBrace === -1 && depth === 0) openBrace = i;
      push("symbol", i, i + 1);
      depth++;
      i++;
      continue;
    }
    if (c === "}") {
      push("symbol", i, i + 1);
      depth--;
      i++;
      continue;
    }
    if (c === ":" || c === "," || c === "[" || c === "]") {
      push("symbol", i, i + 1);
      i++;
      continue;
    }
    if (/[\w\-]/.test(c)) {
      const start = i;
      while (i < text.length && /[\w\-]/.test(text[i])) i++;
      push("word", start, i);
      continue;
    }
    i++; // whitespace & anything else
  }
  return { tokens, openBrace };
}

function parseStringToken(raw: string): string {
  try {
    return JSON.parse(raw) as string;
  } catch {
    return raw.replace(/^"/, "").replace(/"$/, "");
  }
}

/**
 * Set the value of a TOP-LEVEL string key in JSONC text, preserving comments
 * and formatting. Returns the new text; returns the original if the key could
 * not be written (only possible when there is no top-level object).
 *
 *   {
 *     // keep me
 *     "apiKey": "sk-x",
 *     "model": "old",   // replaced
 *     "nested": { "model": "untouched" }
 *   }
 */
export function setTopLevelString(text: string, key: string, value: string): string {
  const { tokens, openBrace } = scanJsonc(text);
  if (openBrace === -1) return text;

  let keyIndex = -1;
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    if (tok.depth !== 1) continue;
    if (tok.type !== "string") continue;
    if (parseStringToken(tok.raw) !== key) continue;
    // The key must be followed (skipping comments/whitespace) by a colon.
    const colon = findNextMeaningful(tokens, t + 1, ":");
    if (colon === -1) continue;
    keyIndex = t;
    break;
  }

  const quoted = JSON.stringify(value);

  if (keyIndex === -1) {
    // Key not found: insert right after the opening brace.
    const after = text.slice(openBrace + 1);
    const nextMeaningful = after.search(/\S/);
    const startsEmpty = nextMeaningful === -1 || after[nextMeaningful] === "}";
    const insert = startsEmpty
      ? `"${key}": ${quoted}`
      : `"${key}": ${quoted}, `;
    return text.slice(0, openBrace + 1) + insert + after;
  }

  // Replace the value token after `key:` (whitespace/comments are not
  // tokenized, so the token right after the colon IS the value).
  const colon = findNextMeaningful(tokens, keyIndex + 1, ":");
  if (colon === -1) return text;
  const valueEnd = tokens[colon + 1]?.end ?? colon;
  const valueStart = tokens[colon + 1]?.start ?? colon;
  return text.slice(0, valueStart) + quoted + text.slice(valueEnd);
}

function findNextMeaningful(tokens: JsoncToken[], from: number, symbol: string): number {
  for (let t = from; t < tokens.length; t++) {
    if (tokens[t].type === "symbol" && tokens[t].raw === symbol) return t;
  }
  return -1;
}
