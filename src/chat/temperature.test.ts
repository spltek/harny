import { describe, it, expect } from "vitest";
import { clampTemperature, toTemperature } from "./temperature";

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