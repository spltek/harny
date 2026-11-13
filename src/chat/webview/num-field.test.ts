// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createNumberField,
  decimalsOf,
  formatNumber,
  isDraft,
  parseNumber,
  sanitizeDraft,
  type NumberBounds,
} from "./num-field";

const TEMPERATURE: NumberBounds = { min: 0, max: 2, step: 0.1 };
const CONTEXT: NumberBounds = { min: 1000, max: 2000000, step: 1000, integer: true, tokens: true };
const COUNT: NumberBounds = { min: 1, max: 10, step: 1, integer: true };

let input: HTMLInputElement;
let range: HTMLInputElement;

beforeEach(() => {
  document.body.innerHTML = '<input type="text" id="v" /><input type="range" id="r" min="0" max="2" step="0.1" />';
  input = document.getElementById("v") as HTMLInputElement;
  range = document.getElementById("r") as HTMLInputElement;
});

/** A keystroke the way a browser would deliver it: the mask sees it first. */
function type(text: string): boolean {
  const event = new InputEvent("beforeinput", { data: text, inputType: "insertText", cancelable: true });
  const allowed = input.dispatchEvent(event);
  if (allowed) input.value += text; // the default action, which jsdom does not perform
  return allowed;
}

function commitWith(key: string): void {
  input.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true }));
}

describe("num-field — the mask is a SHAPE", () => {
  it("accepts every PARTIAL number a person types left to right", () => {
    for (const draft of ["", "0", "0.", "0.7", "12", ".5"]) {
      expect(isDraft(draft, TEMPERATURE), draft).toBe(true);
    }
  });

  it("refuses a second separator, letters and signs where the domain has none", () => {
    expect(isDraft("0.0.1", TEMPERATURE)).toBe(false);
    expect(isDraft("0x1", TEMPERATURE)).toBe(false);
    expect(isDraft("-1", TEMPERATURE)).toBe(false);
    // A sign IS legal where negatives exist.
    const signed: NumberBounds = { min: -5, max: 5, step: 1, integer: true };
    expect(isDraft("-5", signed)).toBe(true);
    expect(isDraft("5-", signed)).toBe(false);
  });

  it("token counts accept one k/M suffix, and only at the end", () => {
    expect(isDraft("128k", CONTEXT)).toBe(true);
    expect(isDraft("1.5M", CONTEXT)).toBe(true);
    expect(isDraft("k128", CONTEXT)).toBe(false);
    expect(isDraft("1k2", CONTEXT)).toBe(false);
    // …and nothing else does: a temperature has no suffixes.
    expect(isDraft("1k", TEMPERATURE)).toBe(false);
  });

  it("sanitizes a whole pasted string into something the field can hold", () => {
    expect(sanitizeDraft(" 0.75 ", TEMPERATURE)).toBe("0.75");
    expect(sanitizeDraft("0.7.5", TEMPERATURE)).toBe("0.75");
    expect(sanitizeDraft("12abc", TEMPERATURE)).toBe("12");
    expect(sanitizeDraft("128kb", CONTEXT)).toBe("128K");
    expect(sanitizeDraft("-3", COUNT)).toBe("3"); // no negatives in this domain
  });

  it("parses suffixes, separators and half-typed numbers", () => {
    expect(parseNumber("0.")).toBe(0);
    expect(parseNumber("0,7")).toBe(0.7);
    expect(parseNumber("128k")).toBe(128000);
    expect(parseNumber("1.5M")).toBe(1500000);
    expect(parseNumber("")).toBeUndefined();
    expect(parseNumber(".")).toBeUndefined();
  });

  it("formats integers without a phantom decimal", () => {
    expect(formatNumber(4, COUNT)).toBe("4");
    expect(formatNumber(0.7, TEMPERATURE)).toBe("0.7");
    expect(decimalsOf(0.1)).toBe(1);
    expect(decimalsOf(0.05)).toBe(2);
    expect(decimalsOf(1)).toBe(0);
  });
});

describe("num-field — what the box does", () => {
  it("cancels a keystroke that cannot belong to the number, before it is ever in the box", () => {
    const commit = vi.fn();
    createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit }).render(0.5);
    input.value = "";
    expect(type("x")).toBe(false);
    expect(input.value).toBe("");
    // A letter never even reaches the box, so nothing was committed and nothing was shown.
    expect(commit).not.toHaveBeenCalled();
  });

  it("refuses a digit that would overflow the cap, and only that digit", () => {
    createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit: vi.fn() }).render(0.2);
    input.value = "";
    expect(type("2")).toBe(true);
    // "2" is fine; a second digit would make 25 > max.
    expect(type("5")).toBe(false);
    expect(input.value).toBe("2");
  });

  it("takes a WHOLE pasted string down to its legal prefix", () => {
    createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit: vi.fn() });
    input.value = "0.7.5k";
    input.dispatchEvent(new Event("input"));
    expect(input.value).toBe("0.75");
  });

  it("moves the slider with the draft but sends NOTHING", () => {
    const commit = vi.fn();
    createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit }).render(null);
    input.value = "1.5";
    input.dispatchEvent(new Event("input"));
    expect(range.value).toBe("1.5");
    expect(commit).not.toHaveBeenCalled();
  });

  it("leaves the slider alone while the draft is not a number yet", () => {
    createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit: vi.fn() }).render(0.7);
    input.value = "";
    input.dispatchEvent(new Event("input"));
    expect(range.value).toBe("0.7");
  });

  it("commits on Enter and leaves the box", () => {
    const commit = vi.fn();
    createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit }).render(null);
    input.value = "1.4";
    commitWith("Enter");
    expect(commit).toHaveBeenCalledWith(1.4);
    expect(document.activeElement).not.toBe(input);
  });

  it("commits when the box loses focus — the ordinary way to be done with it", () => {
    const commit = vi.fn();
    createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit }).render(null);
    input.value = "0.3";
    input.dispatchEvent(new Event("blur"));
    expect(commit).toHaveBeenCalledWith(0.3);
  });

  it("throws the draft away on Escape, without committing", () => {
    const commit = vi.fn();
    const field = createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit });
    field.render(0.7);
    input.value = "1.9";
    commitWith("Escape");
    expect(commit).not.toHaveBeenCalled();
    expect(input.value).toBe("0.7");
  });

  it("steps by the slider's grain on ↑/↓, and commits at once", () => {
    const commit = vi.fn();
    createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit }).render(0.7);
    commitWith("ArrowUp");
    expect(commit).toHaveBeenLastCalledWith(0.8);
    commitWith("ArrowDown");
    expect(commit).toHaveBeenLastCalledWith(0.6);
  });

  it("clamps an out-of-range commit to the domain instead of trusting the typist", () => {
    const commit = vi.fn();
    createNumberField({ input, range, bounds: CONTEXT, empty: null, commit }).render(200000);
    input.value = "0.2k"; // 200, under the 1000-token floor
    input.dispatchEvent(new Event("blur"));
    expect(commit).toHaveBeenLastCalledWith(1000);
  });
});

describe("num-field — the EMPTY state", () => {
  it("commits `null` for a blank box when nothing is a legal answer (Auto)", () => {
    const commit = vi.fn();
    createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit }).render(0.7);
    input.value = "";
    input.dispatchEvent(new Event("blur"));
    expect(commit).toHaveBeenCalledWith(null);
  });

  it("commits the OFF value for a blank box where blank means off", () => {
    const commit = vi.fn();
    createNumberField({ input, range, bounds: COUNT, empty: 0, commit }).render(4);
    input.value = "";
    input.dispatchEvent(new Event("blur"));
    expect(commit).toHaveBeenCalledWith(0);
  });

  it("keeps `0` a REAL value: blank is Auto, zero is zero", () => {
    const commit = vi.fn();
    createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit }).render(null);
    input.value = "0";
    input.dispatchEvent(new Event("blur"));
    // The trap this guards: Number("") === 0, so an empty box must never be read as a typed zero.
    expect(commit).toHaveBeenCalledWith(0);
  });

  it("shows the OFF value as blank, and Auto as blank with its placeholder", () => {
    const field = createNumberField({ input, range, bounds: COUNT, empty: 0, commit: vi.fn() });
    field.render(0);
    expect(input.value).toBe("");
    field.render(4);
    expect(input.value).toBe("4");
    field.render(null);
    expect(input.value).toBe("");
  });

  it("puts the old value back when a blank box is not an answer", () => {
    const commit = vi.fn();
    const field = createNumberField({ input, range, bounds: CONTEXT, commit });
    field.render(200000);
    input.value = "";
    input.dispatchEvent(new Event("blur"));
    expect(commit).not.toHaveBeenCalled();
    expect(input.value).toBe("200000");
  });
});

describe("num-field — render", () => {
  it("writes the value into the box and the track, and clears what was typed", () => {
    const field = createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit: vi.fn() });
    field.render(0.7);
    expect(input.value).toBe("0.7");
    expect(range.value).toBe("0.7");
    input.value = "1.9";
    field.render(0.7);
    expect(input.value).toBe("0.7");
  });

  it("does not drag the slider to min for Auto: the caller owns the default", () => {
    const field = createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit: vi.fn() });
    field.render(0.7);
    range.value = "1"; // the provider default, where the caller parks an Auto track
    field.render(null);
    expect(range.value).toBe("1");
    expect(input.value).toBe("");
  });

  it("treats a non-finite value as Auto", () => {
    const field = createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit: vi.fn() });
    field.render(Number.NaN);
    expect(input.value).toBe("");
  });

  it("reads the bounds LIVE, so a field can change scale under it", () => {
    const bounds: NumberBounds = { min: 0, max: 2, step: 0.1 };
    const commit = vi.fn();
    createNumberField({ input, range, bounds, empty: null, commit }).render(null);
    bounds.max = 1; // Top-P
    input.value = "";
    expect(type("1")).toBe(true);
    expect(type("5")).toBe(false); // 15 > 1
    input.value = "1.4";
    input.dispatchEvent(new Event("blur"));
    expect(commit).toHaveBeenCalledWith(1);
  });
});

describe("num-field — onDraft (the callers whose answer IS the box)", () => {
  it("reports every draft that is a number, and `undefined` while it is not one yet", () => {
    const onDraft = vi.fn();
    createNumberField({ input, range, bounds: CONTEXT, commit: vi.fn(), onDraft });
    input.value = "128k";
    input.dispatchEvent(new Event("input"));
    expect(onDraft).toHaveBeenLastCalledWith(128_000);
    input.value = "";
    input.dispatchEvent(new Event("input"));
    expect(onDraft).toHaveBeenLastCalledWith(undefined);
    // The mask's rescue pass runs first, so what is reported is what the box HOLDS.
    input.value = "1.5M";
    input.dispatchEvent(new Event("input"));
    expect(onDraft).toHaveBeenLastCalledWith(1_500_000);
  });

  it("is optional: a field that only sends on commit needs no draft hook", () => {
    const field = createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit: vi.fn() });
    field.render(0.5);
    input.value = "1.5";
    expect(() => input.dispatchEvent(new Event("input"))).not.toThrow();
    expect(range.value).toBe("1.5");
  });
});

const NEG: NumberBounds = { min: -5, max: 5, step: 1, integer: true };
const COUNT_ONLY: NumberBounds = { min: 1, max: 10, step: 1, integer: true };

describe("num-field — the mask's edge cases (every branch a paste can reach)", () => {
  it("a separator exists only where the domain has fractions OR token suffixes", () => {
    expect(isDraft("1.5", COUNT_ONLY)).toBe(false); // whole numbers, no tokens
    expect(isDraft("1.5", CONTEXT)).toBe(true); // tokens: 1.5M is how a million and a half is written
    expect(sanitizeDraft("1.5", COUNT_ONLY)).toBe("15");
    expect(sanitizeDraft("1,5", COUNT_ONLY)).toBe("15");
  });

  it("keeps ONE separator, comma or dot, and drops the rest", () => {
    expect(sanitizeDraft("0,7", TEMPERATURE)).toBe("0,7");
    expect(sanitizeDraft("1,5.2", TEMPERATURE)).toBe("1,52");
    expect(sanitizeDraft("::0.7", TEMPERATURE)).toBe("0.7");
  });

  it("a suffix swallows what follows it, and needs a number in front of it", () => {
    expect(sanitizeDraft("1k5", CONTEXT)).toBe("1K");
    expect(sanitizeDraft("1kk", CONTEXT)).toBe("1K");
    expect(sanitizeDraft("k5", CONTEXT)).toBe("5"); // a suffix alone is not a number
    expect(sanitizeDraft("1.5m", CONTEXT)).toBe("1.5M");
  });

  it("a sign lives only at the front, and only where negatives exist", () => {
    expect(sanitizeDraft("-5", NEG)).toBe("-5");
    expect(sanitizeDraft("5-3", NEG)).toBe("53");
    expect(sanitizeDraft("--2", NEG)).toBe("-2");
    expect(sanitizeDraft("-5", COUNT_ONLY)).toBe("5");
  });

  it("drops everything that is not part of the number", () => {
    expect(sanitizeDraft("abc", TEMPERATURE)).toBe("");
    expect(sanitizeDraft(" 1 2 ", TEMPERATURE)).toBe("12");
    expect(sanitizeDraft("", TEMPERATURE)).toBe("");
  });

  it("parses only a WHOLE number with an optional suffix", () => {
    expect(parseNumber(" 128 ")).toBe(128);
    expect(parseNumber("2k")).toBe(2000);
    expect(parseNumber("2m")).toBe(2_000_000);
    expect(parseNumber("1.5M!")).toBeUndefined();
    expect(parseNumber("x12")).toBeUndefined();
    expect(parseNumber("-")).toBeUndefined();
    expect(parseNumber("abc")).toBeUndefined();
  });
});

describe("num-field — focus, caret and the events the mask lets through", () => {
  it("selects the whole number on focus, so typing replaces it", () => {
    const field = createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit: vi.fn() });
    field.render(0.7);
    input.focus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(3);
  });

  it("leaves the caret at the end after cleaning a paste", () => {
    createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit: vi.fn() });
    input.value = "0.7.5";
    input.dispatchEvent(new Event("input"));
    expect(input.value).toBe("0.75");
    expect(input.selectionStart).toBe(4);
  });

  it("judges the keystroke on the string it WOULD produce, selection included", () => {
    createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit: vi.fn() });
    input.value = "0.5";
    input.setSelectionRange(0, 3); // everything selected: "9" would REPLACE it
    expect(type("9")).toBe(false); // 9 > max, so the digit never lands
    input.setSelectionRange(0, 3);
    expect(type("1")).toBe(true); // 1 is inside the domain
  });

  it("never blocks a DELETION: a box you cannot correct is a box you cannot fill", () => {
    createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit: vi.fn() });
    input.value = "0.5";
    const del = new InputEvent("beforeinput", { inputType: "deleteContentBackward", cancelable: true });
    expect(input.dispatchEvent(del)).toBe(true);
    expect(del.defaultPrevented).toBe(false);
  });

  it("does not move the track for a draft it cannot use", () => {
    createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit: vi.fn() }).render(0.7);
    input.value = "99"; // above max
    input.dispatchEvent(new Event("input"));
    expect(range.value).toBe("0.7");
    input.value = "0."; // not a value yet? it is 0 — but it is BELOW nothing here…
    input.dispatchEvent(new Event("input"));
    expect(range.value).toBe("0");
  });

  it("does not move the track below the minimum either", () => {
    createNumberField({ input, range, bounds: CONTEXT, empty: null, commit: vi.fn() }).render(2000);
    const before = range.value;
    input.value = "0"; // 0 tokens is not a window
    input.dispatchEvent(new Event("input"));
    expect(range.value).toBe(before);
  });

  it("works without a slider at all", () => {
    createNumberField({ input, bounds: TEMPERATURE, empty: null, commit: vi.fn() }).render(0.4);
    expect(input.value).toBe("0.4");
    input.value = "1.2";
    expect(() => input.dispatchEvent(new Event("input"))).not.toThrow();
  });

  it("cancels the keys it owns, so the page does not also react", () => {
    createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit: vi.fn() }).render(0.5);
    for (const key of ["Enter", "Escape", "ArrowUp", "ArrowDown"]) {
      const ev = new KeyboardEvent("keydown", { key, cancelable: true });
      input.dispatchEvent(ev);
      expect(ev.defaultPrevented, key).toBe(true);
    }
  });

  it("steps from the MINIMUM when the box is empty and nothing is held", () => {
    const commit = vi.fn();
    createNumberField({ input, range, bounds: CONTEXT, empty: null, commit });
    input.value = "";
    commitWith("ArrowUp");
    expect(commit).toHaveBeenLastCalledWith(2000); // 1000 + one 1000-token notch
  });

  it("puts the held value back when the box holds something that is not a number", () => {
    const commit = vi.fn();
    const field = createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit });
    field.render(0.7);
    input.value = ".";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new Event("blur"));
    expect(commit).not.toHaveBeenCalled();
    expect(input.value).toBe("0.7");
  });
});

describe("num-field — the last branches", () => {
  it("a sign is dropped where the domain STARTS at zero", () => {
    const fromZero: NumberBounds = { min: 0, max: 2, step: 0.1 };
    expect(sanitizeDraft("-0.5", fromZero)).toBe("0.5");
    expect(sanitizeDraft("a5", NEG)).toBe("5"); // a sign is the ONLY non-digit letter let through
  });

  it("reads a box holding only spaces as EMPTY, not as a number", () => {
    const commit = vi.fn();
    createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit }).render(0.7);
    input.value = "   ";
    input.dispatchEvent(new Event("blur"));
    expect(commit).toHaveBeenCalledWith(null);
  });

  it("does not move a caret that was already where it belonged", () => {
    createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit: vi.fn() }).render(0.7);
    input.setSelectionRange(1, 1); // in the middle of "0.7", nothing to clean
    input.dispatchEvent(new Event("input"));
    expect(input.selectionStart).toBe(1);
  });

  it("sends the caret to the end when a paste had to be cut down", () => {
    createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit: vi.fn() });
    input.value = "0.7.5";
    input.setSelectionRange(0, 0);
    input.dispatchEvent(new Event("input"));
    expect(input.selectionStart).toBe(4); // after "0.75"
  });

  it("lets a DELETION through even when its payload is not a number", () => {
    createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit: vi.fn() }).render(0.5);
    const del = new InputEvent("beforeinput", { inputType: "deleteContentBackward", data: "x", cancelable: true });
    expect(input.dispatchEvent(del)).toBe(true);
  });

  it("steps from the DRAFT, not from the value the model holds", () => {
    const commit = vi.fn();
    createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit }).render(0.7);
    input.value = "0.5"; // what is in the box right now
    commitWith("ArrowUp");
    expect(commit).toHaveBeenLastCalledWith(0.6);
  });
});

describe("num-field — the keys it does NOT own, and the edges of the track", () => {
  it("leaves every other key alone", () => {
    const commit = vi.fn();
    createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit }).render(0.5);
    const ev = new KeyboardEvent("keydown", { key: "a", cancelable: true });
    input.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });

  it("leaves the box on Enter and on Escape — the keyboard equivalent of clicking away", () => {
    for (const key of ["Enter", "Escape"]) {
      createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit: vi.fn() }).render(0.5);
      input.focus();
      expect(document.activeElement).toBe(input);
      commitWith(key);
      expect(document.activeElement, key).not.toBe(input);
    }
  });

  it("follows a draft that sits exactly ON the maximum", () => {
    createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit: vi.fn() }).render(0.5);
    input.value = "2";
    input.dispatchEvent(new Event("input"));
    expect(range.value).toBe("2");
  });
});

describe("num-field — the branches the mask can reach that no test was watching", () => {
  it('reads an empty string as NOT a number, the trap `Number("")` sets', () => {
    expect(parseNumber("")).toBeUndefined();
    expect(parseNumber("-")).toBeUndefined();
    expect(parseNumber(".")).toBeUndefined();
    expect(parseNumber("-.")).toBeUndefined();
    // La forma è giusta, il VALORE è infinito: la finitezza è un controllo suo, non del formato.
    expect(parseNumber("9".repeat(400))).toBeUndefined();
  });

  it("judges the keystroke at the CARET, not at the end of the box", () => {
    createNumberField({ input, range: null, bounds: CONTEXT, empty: null, commit: vi.fn() });
    input.value = "1200";
    input.setSelectionRange(1, 1); // fra "1" e "2": "15200" sta nel dominio…
    expect(type("5")).toBe(true);
    // …mentre una insertion misurata sulla fine del box darebbe "12005200", fuori dal tetto.
  });

  it("lets a composition through when it arrives WITHOUT data", () => {
    createNumberField({ input, range: null, bounds: TEMPERATURE, empty: null, commit: vi.fn() });
    input.value = "0.5";
    const ev = new InputEvent("beforeinput", { inputType: "insertText", data: null, cancelable: true });
    expect(input.dispatchEvent(ev)).toBe(true);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("moves the caret to the end EXPLICITLY after a clean, and never with nothing to clean", () => {
    createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit: vi.fn() });
    const setSelection = vi.spyOn(input, "setSelectionRange");
    input.value = "0.7.5";
    input.dispatchEvent(new Event("input"));
    expect(input.value).toBe("0.75");
    // Il setter di `.value` porta già il caret in fondo, quindi qui si pinna l'intenzione: se
    // questa chiamata sparisce, in un motore che non si comporta così il caret resta a metà.
    expect(setSelection).toHaveBeenCalledWith(4, 4);
    setSelection.mockClear();
    input.dispatchEvent(new Event("input")); // niente da pulire: niente da riposizionare
    expect(setSelection).not.toHaveBeenCalled();
  });

  it("calls select() only when there is a number to select", () => {
    const field = createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit: vi.fn() });
    const select = vi.spyOn(input, "select");
    field.render(0.7);
    input.focus();
    expect(select).toHaveBeenCalledTimes(1);
    input.blur();
    input.value = "";
    select.mockClear();
    input.focus(); // un box vuoto non ha niente da selezionare
    expect(select).not.toHaveBeenCalled();
  });

  it("never cancels a legal keystroke", () => {
    createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit: vi.fn() });
    input.value = "0.";
    const ev = new InputEvent("beforeinput", { data: "5", inputType: "insertText", cancelable: true });
    input.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("still reports the draft with no slider to move", () => {
    const onDraft = vi.fn();
    createNumberField({ input, bounds: TEMPERATURE, empty: null, commit: vi.fn(), onDraft });
    input.value = "0.5";
    input.dispatchEvent(new Event("input"));
    // Con `range` assente il percorso non deve toccare il DOM dello slider: se lo tocca, lancia
    // prima di arrivare qui, e questo spy resta muto.
    expect(onDraft).toHaveBeenLastCalledWith(0.5);
  });

  it("does not touch the slider while the draft is not a number yet", () => {
    const onDraft = vi.fn();
    createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit: vi.fn(), onDraft }).render(0.7);
    input.value = "-"; // a shape the mask allows, a value it does not have yet
    input.dispatchEvent(new Event("input"));
    expect(onDraft).toHaveBeenLastCalledWith(undefined);
    expect(range.value).toBe("0.7"); // the track keeps the held value, not a stringified `undefined`
  });

  it("never throws out of its own listeners: a field with NO draft hook is legal", () => {
    // jsdom reports an exception thrown inside a listener as an `error` event on the window instead
    // of failing the test, so the listener is what has to be watched — that is where a missing
    // optional call would show up in the panel as a dead box, not as a stack trace.
    const errors: string[] = [];
    const onError = (e: Event): void => void errors.push(String((e as ErrorEvent).message ?? e.type));
    window.addEventListener("error", onError);
    try {
      const commit = vi.fn();
      createNumberField({ input, range, bounds: TEMPERATURE, empty: null, commit });
      input.value = "0.5";
      input.dispatchEvent(new Event("input")); // a numeric draft, nobody to report it to
      input.value = "-";
      input.dispatchEvent(new Event("input")); // not a number yet, still nobody
      commitWith("Enter");
    } finally {
      window.removeEventListener("error", onError);
    }
    expect(errors).toEqual([]);
  });
});
