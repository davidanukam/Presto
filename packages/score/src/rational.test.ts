import { describe, expect, it } from "vitest";
import { add, eq, mul, r, toNumber } from "./rational";
import { parseInterval, transposePitch } from "./pitch";

describe("rationals", () => {
  it("keeps eighths, dots, and triplets exact", () => {
    const eighth = r(1, 2);
    const dotted = add(eighth, r(1, 4));
    const triplet = mul(r(1), r(2, 3));
    expect(eq(dotted, r(3, 4))).toBe(true);
    expect(eq(triplet, r(2, 3))).toBe(true);
    expect(toNumber(triplet)).toBeCloseTo(2 / 3);
    expect(triplet).toEqual({ n: 2, d: 3 });
  });
});

describe("spelling", () => {
  it("transposes C up a minor third to E-flat", () => {
    const interval = parseInterval("m3")!;
    expect(transposePitch({ step: "C", alter: 0, octave: 4 }, interval)).toEqual({
      step: "E",
      alter: -1,
      octave: 4,
    });
  });

  it("transposes C up an octave", () => {
    expect(transposePitch({ step: "C", alter: 0, octave: 4 }, parseInterval("P8")!)).toEqual({
      step: "C",
      alter: 0,
      octave: 5,
    });
  });
});
