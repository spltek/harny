/**
 * A NUMBER YOU CAN TYPE.
 *
 * The panel is a wall of sliders, and a slider is a fine way to EXPLORE a range and a terrible way
 * to express a decision: nudging 32 768 out of a track that spans two million is not an edit, it is
 * a lottery. So the number that already sits beside every slider becomes the second way in.
 *
 * Three rules make that safe, and they all live here so that every field inherits them:
 *
 * 1. A character that cannot belong to the number NEVER ENTERS THE BOX. The decision is taken on
 *    `beforeinput`, on the string the keystroke WOULD produce, and the keystroke is cancelled — no
 *    flash of garbage, no caret to reposition, nothing to undo. `pattern` and `type="number"` both
 *    validate AFTER the text is already in, and `type="number"` is worse than useless here: it
 *    hands back an EMPTY `.value` for anything it dislikes (so "typing" and "wrong" look
 *    identical) and it opens the door to `e`, `+`, `-` and the wheel. Hence a plain text box and
 *    this mask.
 * 2. The mask is a SHAPE, not a value: `""`, `"0."`, `"-"`, `"128k"` are all legal PARTIAL entries,
 *    because refusing them mid-keystroke would make the field impossible to fill left to right.
 *    Only the MAXIMUM is enforced while typing (a digit that would overflow it is refused); the
 *    minimum cannot be, since every value is built out of digits smaller than itself.
 * 3. TYPING IS NOT A DECISION. The draft stays a draft: it moves the slider (so the track never
 *    contradicts the number being written) but sends nothing. `Enter`, `↑`/`↓` and leaving the box
 *    commit; `Escape` throws the draft away. Committing hands the value to `commit`, which is the
 *    caller's EXISTING path — it clamps, posts, re-renders. The engine never decides what the
 *    final value is, so a typed number cannot bypass a clamp the slider respects, and the host
 *    stays the single source of truth.
 *
 * `empty` is where "Auto" lives. A nullable knob (the three sampler values) has no number to show
 * when nothing is sent, so the box is BLANK with the word Auto as its placeholder, and blank is
 * what commits back to `null`. A field that simply has an "off" position (max parallel
 * sub-agents) passes the number that means off. A field with neither (context window) omits it:
 * an empty box is not an answer, and committing one puts the previous value back instead of
 * inventing a zero. Note the trap this design has to dodge: `Number("")` is `0`, which is a
 * perfectly good explicit value — so emptiness is decided on the STRING, never on the parse.
 */

/** The domain of one field. Kept as a mutable OBJECT the caller owns: the sampler's cap follows
 *  the selected radio (0–2 for temperature, 0–1 for top_p) and the field must read it live. */
export interface NumberBounds {
  min: number;
  max: number;
  /** The slider's grain, also the `↑`/`↓` step. */
  step: number;
  /** Whole numbers only (a nudge count is not "2.5"). */
  integer?: boolean;
  /** Token counts also accept `128k` / `1.5M`, because that is how people write them. */
  tokens?: boolean;
}

export interface NumberFieldOptions {
  input: HTMLInputElement;
  /** The slider this number belongs to: kept in step with the DRAFT. */
  range?: HTMLInputElement | null;
  bounds: NumberBounds;
  /**
   * What an EMPTY box means: `null` = nothing is sent (Auto), a number = that value (Off).
   * Absent = an empty box is not an answer (committing one reverts).
   */
  empty?: number | null;
  /** The caller's existing send path: clamp, post, and render the value that survived. */
  commit: (value: number | null) => void;
  /**
   * Called with the DRAFT every time it becomes a number (`undefined` when it is not one yet).
   * Only for callers whose answer is the box itself rather than a message: the alert's rows keep
   * their numbers in a local draft, and "what you see is what you send" has to hold while the
   * text is still being typed, not just at the commit.
   */
  onDraft?: (value: number | undefined) => void;
}

export interface NumberField {
  /** Show the value the model holds; `null`/`undefined` = the empty state (Auto). */
  render(value: number | null | undefined): void;
}

/** The digits after the separator: `0.1` → 1, `0.05` → 2, `1` → 0. */
export function decimalsOf(step: number): number {
  const text = String(step);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** A decimal separator: any fractional domain, and the token counts (`1.5M` is how a million and a
 *  half gets written) even though the RESULT is whole. */
function takesSeparator(bounds: NumberBounds): boolean {
  return !bounds.integer || bounds.tokens === true;
}

/** Can this whole string be in a field like this? (A SHAPE test, not a value test.) */
export function isDraft(text: string, bounds: NumberBounds): boolean {
  const sign = bounds.min < 0 ? "-?" : "";
  const body = takesSeparator(bounds) ? "\\d*[.,]?\\d*" : "\\d*";
  const suffix = bounds.tokens ? "[KkMm]?" : "";
  return new RegExp(`^${sign}${body}${suffix}$`).test(text);
}

/**
 * Keep only what the field can hold: the rescue pass for everything that does not arrive one
 * character at a time (paste, drag, IME, autofill). One decimal separator, at most one suffix, a
 * sign only where negatives exist and only at the front.
 */
export function sanitizeDraft(raw: string, bounds: NumberBounds): string {
  let out = "";
  let separator = false;
  let suffix = false;
  for (const ch of raw) {
    if (ch >= "0" && ch <= "9") {
      if (!suffix) out += ch;
    } else if ((ch === "." || ch === ",") && takesSeparator(bounds) && !separator && !suffix) {
      out += ch;
      separator = true;
    } else if (ch === "-" && bounds.min < 0 && out === "") {
      out += ch;
    } else if (bounds.tokens && !suffix && out !== "" && "KkMm".includes(ch)) {
      out += ch.toUpperCase();
      suffix = true;
    }
  }
  return out;
}

/** `"128k"` → 128000, `"1.5M"` → 1500000, `"0."` → 0. `undefined` = not a number yet. */
export function parseNumber(text: string): number | undefined {
  const clean = text.trim().replace(",", ".");
  const match = /^(-?\d*(?:\.\d*)?)([KkMm]?)$/.exec(clean);
  // `"-"` and `"."` reach this line too: they match the pattern, and the finiteness check below
  // is what turns them into "not a number yet" (`Number("-")` is NaN). One guard, not three.
  if (!match || match[1] === "") return undefined;
  const scale = match[2] === "" ? 1 : match[2].toUpperCase() === "K" ? 1e3 : 1e6;
  const n = Number(match[1]) * scale;
  return Number.isFinite(n) ? n : undefined;
}

/** The text a value wears when it is not being typed into. Integers lose a `.0` nobody wrote. */
export function formatNumber(value: number, bounds: NumberBounds): string {
  return String(bounds.integer ? Math.round(value) : value);
}

/** The string the keystroke would produce, without touching the box. */
function spliced(input: HTMLInputElement, data: string): string {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  return input.value.slice(0, start) + data + input.value.slice(end);
}

export function createNumberField(options: NumberFieldOptions): NumberField {
  const { input, bounds, commit } = options;
  const range = options.range ?? null;
  /** The value the model holds — what `Escape` and a failed commit put back. */
  let held: number | null = null;

  const render = (value: number | null | undefined): void => {
    // `Number.isFinite` alone would do the job at runtime but it does not NARROW `value`, and the
    // cast that would buy the narrowing is exactly the kind of lie this field is careful about.
    held = typeof value === "number" && Number.isFinite(value) ? value : null;
    // A blank box does not drag the slider to `min`: Auto has no number, and the caller puts the
    // track where the provider's default lives. Only a real value moves it from here.
    // `held === options.empty` needs no type guard: `empty: null` is Auto, not an off value, and
    // that case has already returned; `empty: undefined` can never equal a number.
    if (held === null || held === options.empty) {
      input.value = "";
      return;
    }
    input.value = formatNumber(held, bounds);
    if (range) range.value = String(held);
  };

  const commitDraft = (): void => {
    const raw = input.value.trim();
    if (raw === "") {
      if (options.empty !== undefined) {
        commit(options.empty);
        return;
      }
      render(held); // nothing to say, and blank is not an answer: put the old number back
      return;
    }
    const parsed = parseNumber(raw);
    if (parsed === undefined) {
      render(held);
      return;
    }
    const clamped = Math.min(bounds.max, Math.max(bounds.min, parsed));
    commit(bounds.integer ? Math.round(clamped) : clamped);
  };

  const caretToEnd = (): void => {
    try {
      input.setSelectionRange(input.value.length, input.value.length);
    } catch {
      // A field that refuses selection (it should not) still keeps its text.
    }
  };

  // Typing over a value REPLACES it: the number is short, and nobody wants to aim at it.
  input.addEventListener("focus", () => {
    if (input.value !== "") input.select();
  });

  // THE MASK. `insert*` only: deleting is always allowed (a box you cannot correct is a box you
  // cannot fill). The candidate is judged WHOLE, so a stray character cannot slip in beside a
  // legal one.
  input.addEventListener("beforeinput", (event) => {
    const e = event as InputEvent;
    if (e.data === null) return; // deletions, drops, compositions: nothing to judge
    if (e.inputType && !e.inputType.startsWith("insert")) return;
    const next = spliced(input, e.data);
    if (!isDraft(next, bounds)) {
      event.preventDefault();
      return;
    }
    // The only VALUE rule that survives left-to-right typing: a digit that would overflow the cap
    // is not "a character of this number" any more, so it does not enter. `?? max` says the rest:
    // an unfinished number cannot overflow anything.
    const over = parseNumber(next) ?? bounds.max;
    if (over > bounds.max) event.preventDefault();
  });

  // The same rule for the WHOLE string: paste, drag, IME and autofill never arrive one key at a
  // time. Then the slider follows a draft that is already a legal value — nothing is sent.
  input.addEventListener("input", () => {
    const clean = sanitizeDraft(input.value, bounds);
    if (clean !== input.value) {
      input.value = clean;
      caretToEnd();
    }
    const draft = parseNumber(input.value);
    // `NaN` stands for "not a number yet": every comparison against it is false, so the track
    // cannot be moved by an unfinished draft and this guard needs no `undefined` test of its own.
    // (`draft` itself stays untouched: `onDraft` has to keep telling `undefined` from `0`.)
    const shown = draft ?? Number.NaN;
    if (range && shown >= bounds.min && shown <= bounds.max) {
      range.value = String(shown);
    }
    options.onDraft?.(draft);
  });

  input.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === "Enter") {
      event.preventDefault();
      commitDraft();
      input.blur();
      return;
    }
    if (key === "Escape") {
      event.preventDefault();
      render(held);
      input.blur();
      return;
    }
    if (key === "ArrowUp" || key === "ArrowDown") {
      // A discrete gesture, not a draft: it commits, like one notch of the slider.
      event.preventDefault();
      const base = parseNumber(input.value) ?? held ?? bounds.min;
      const stepped = base + (key === "ArrowUp" ? bounds.step : -bounds.step);
      const bounded = Math.min(bounds.max, Math.max(bounds.min, stepped));
      const grain = 10 ** decimalsOf(bounds.step);
      commit(bounds.integer ? Math.round(bounded) : Math.round(bounded * grain) / grain);
    }
  });

  // Leaving the box is the ordinary way to be done with it.
  input.addEventListener("blur", commitDraft);

  return { render };
}
