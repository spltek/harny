import en from "./en.help.json";

/**
 * THE UI COPY THAT EXPLAINS THE PANEL — kept out of the code that renders it.
 *
 * The explanations used to live as `title="…"` attributes in the markup and as `LG_TIPS` in
 * `view.ts`: prose in three files, untranslatable, and impossible to review as a body of writing.
 * Here a bundle is DATA — `src/i18n/<locale>.help.json` — and the code asks for a KEY.
 *
 * Two rules make the indirection worth its cost, and both are pinned by tests:
 *   · a key that does not exist is a test failure (`tips-contract.test.ts` reads the sources);
 *     at runtime it degrades to NO tooltip, never to the string "undefined" on screen;
 *   · a `{placeholder}` the call site forgot stays VISIBLE (the braces survive): a wrong number
 *     on screen is a bug report, a silently empty one is not.
 *
 * A second language is a new JSON file and a `registerBundle` call: no call site changes, because
 * no call site knows any text.
 */

/** One language file. `locale` is repeated inside the file so a copy-pasted bundle cannot lie. */
export interface Bundle {
  locale: string;
  /** Hover explanations, by key. */
  tips: Record<string, string>;
  /** The short on-screen names (Loop Guard field labels today), by the same key. */
  labels: Record<string, string>;
}

export type Section = "tips" | "labels";
/** Values interpolated into `{name}` placeholders. */
export type Vars = Record<string, string | number>;

export const DEFAULT_LOCALE = "en";

const BUNDLES = new Map<string, Bundle>([[en.locale, en as Bundle]]);
let active = DEFAULT_LOCALE;

/** Lookups that found nothing, in order: the only honest way to notice a hole in production. */
const misses: string[] = [];

const PLACEHOLDER = /\{(\w+)\}/g;

/** Replace `{name}` with its value. A missing value is RECORDED and left in place. */
function render(section: Section, key: string, text: string, vars?: Vars): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const value = vars?.[name];
    if (value === undefined) {
      misses.push(`${section}:${key}{${name}}`);
      return whole;
    }
    return String(value);
  });
}

/** The text for a key, from the active bundle, falling back to English. */
function lookup(section: Section, key: string): string {
  const text = BUNDLES.get(active)?.[section][key] ?? BUNDLES.get(DEFAULT_LOCALE)?.[section][key];
  if (text === undefined) {
    misses.push(`${section}:${key}`);
    return "";
  }
  return text;
}

/** The explanation for a control. `""` when the key is unknown — an empty tooltip, never a stack. */
export function tip(key: string, vars?: Vars): string {
  const text = lookup("tips", key);
  return text ? render("tips", key, text, vars) : "";
}

/** The short on-screen name for a key. */
export function label(key: string): string {
  return lookup("labels", key);
}

/** The language in use. */
export function currentLocale(): string {
  return active;
}

/** Switch language. Unknown locales are refused (and leave the current one alone). */
export function setLocale(next: string): boolean {
  if (!BUNDLES.has(next)) return false;
  active = next;
  return true;
}

/** Add (or replace) a language. The way a second language arrives, and how a test proves the
 *  English fallback still answers for a bundle that translates only a few keys. */
export function registerBundle(bundle: Bundle): void {
  BUNDLES.set(bundle.locale, bundle);
}

/** Every lookup that came up empty since the last reset, e.g. `tips:lg.p.maxNudges{min}`. */
export function missing(): string[] {
  return [...misses];
}

/** Back to English with a clean slate. Tests only. */
export function resetI18n(): void {
  active = DEFAULT_LOCALE;
  misses.length = 0;
}
