import { describe, it, expect } from "vitest";
import { clampTemperature, toTemperature, clampTopP, toTopP } from "./temperature";

describe("temperature helpers", () => {
  it("clamps into 0–2 and rounds to one decimal", () => {
    expect(clampTemperature(2.5)).toBe(2);
    expect(clampTemperature(-1)).toBe(0);
    expect(clampTemperature(0.777)).toBe(0.8);
    expect(clampTemperature(0)).toBe(0);
  });

  it("returns undefined (Auto) for invalid values", () => {
    expect(clampTemperature(NaN)).toBeUndefined();
    expect(clampTemperature(Infinity)).toBeUndefined();
    expect(toTemperature("abc")).toBeUndefined();
  });

  it("coerces null / undefined to Auto", () => {
    expect(toTemperature(null)).toBeUndefined();
    expect(toTemperature(undefined)).toBeUndefined();
  });
});
describe("top_p clamp", () => {
  it("clamps to 0.0–1.0 with one decimal; invalid -> Auto (undefined)", () => {
    expect(clampTopP(1.5)).toBe(1);
    expect(clampTopP(-0.5)).toBe(0);
    expect(clampTopP(0.94)).toBe(0.9);
    expect(clampTopP(Number.NaN)).toBeUndefined();
  });

  it("toTopP coerces JSON values (null/undefined/NaN -> Auto)", () => {
    expect(toTopP("0.8")).toBe(0.8);
    expect(toTopP(null)).toBeUndefined();
    expect(toTopP(undefined)).toBeUndefined();
    expect(toTopP("nope")).toBeUndefined();
  });
});
