import { describe, it, expect, afterEach } from "vitest";
import { label, tip, missing, resetI18n, setLocale, registerBundle, currentLocale, DEFAULT_LOCALE } from "./index";
import en from "./en.help.json";

/**
 * The catalog is data, so these tests are about the ENGINE (lookup, interpolation, fallback,
 * honest failures) and about the FILE staying reviewable. Whether every key the panel asks for
 * exists is a different question, answered against the sources in `tips-contract.test.ts`.
 */

afterEach(resetI18n);

describe("the explanation catalog", () => {
  it("answers a key from the English bundle", () => {
    expect(tip("compact.run")).toContain("older turns");
    expect(tip("find.close")).toBe("Close (Esc).");
  });

  it("fills {placeholders} without leaving the braces behind", () => {
    const text = tip("lg.p.maxNudges", { min: 1, max: 10 });
    expect(text).toContain("Range 1–10.");
    expect(text).not.toContain("{");
  });

  it("leaves a placeholder the call site forgot VISIBLE, and records it", () => {
    // Visible on purpose: "Range 1–{max}" on screen is a bug report; an empty string is not.
    const text = tip("lg.p.maxNudges", { min: 1 });
    expect(text).toContain("{max}");
    expect(missing()).toEqual(["tips:lg.p.maxNudges{max}"]);
  });

  it("shows no tooltip at all for an unknown key — never the string 'undefined'", () => {
    const text = tip("no.such.key");
    expect(text).toBe("");
    expect(text).not.toContain("undefined");
    expect(missing()).toEqual(["tips:no.such.key"]);
  });

  it("falls back to English for a bundle that translates only part of the catalog", () => {
    registerBundle({ locale: "it", tips: { "compact.run": "Riassume i turni più vecchi." }, labels: {} });
    expect(setLocale("it")).toBe(true);
    expect(currentLocale()).toBe("it");
    expect(tip("compact.run")).toBe("Riassume i turni più vecchi.");
    // Not translated: still an answer, rather than a hole.
    expect(tip("find.close")).toBe("Close (Esc).");
    expect(missing()).toEqual([]);
  });

  it("refuses a language it does not have, and keeps the current one", () => {
    expect(setLocale("xx")).toBe(false);
    expect(currentLocale()).toBe(DEFAULT_LOCALE);
  });

  it("keeps the same key space for labels and tips", () => {
    expect(label("lg.p.maxNudges")).toBe("Nudges");
    expect(label("no.such.key")).toBe("");
    expect(missing()).toEqual(["labels:no.such.key"]);
  });
});

describe("the English bundle itself", () => {
  const sections = ["tips", "labels"] as const;
  const keys = (section: (typeof sections)[number]): string[] => Object.keys(en[section]);

  it("declares the locale it is", () => {
    expect(en.locale).toBe(DEFAULT_LOCALE);
  });

  it("every entry is one line of prose that a translator can work on", () => {
    for (const section of sections) {
      for (const [key, value] of Object.entries(en[section])) {
        expect(value, `${section}:${key} must not be empty`).not.toBe("");
        expect(value, `${section}:${key} must be trimmed`).toBe(value.trim());
        // A reviewable tooltip is a sentence or two, not a paragraph: the card is 21rem wide.
        expect(value.length, `${section}:${key} is too long for the card`).toBeLessThanOrEqual(220);
      }
    }
  });

  it("keeps keys sorted, so a translation diff reads as one block per control", () => {
    for (const section of sections) expect(keys(section)).toEqual([...keys(section)].sort());
  });

  it("gives every labelled Loop Guard field an explanation under the SAME key", () => {
    // The field is built from one key per parameter: the label names it, the tip explains it.
    for (const key of keys("labels")) expect(en.tips[key], `no tip for ${key}`).toBeTruthy();
  });
});
