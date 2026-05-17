// Decimal class — unit tests. Validates correctness of the headline
// "0.1 + 0.2 === 0.3" property, scale alignment, division/rounding, and
// toString round-trips.

import { describe, expect, test } from "bun:test";
import { __paraDec, Decimal, type RoundingMode } from "../src/index";

describe("Decimal — headline correctness", () => {
  test("0.1 + 0.2 === 0.3 (the whole point)", () => {
    expect(Decimal.from("0.1").plus("0.2").eq("0.3")).toBe(true);
  });

  test("0.1 * 3 === 0.3 (the same pain)", () => {
    expect(Decimal.from("0.1").times("3").eq("0.3")).toBe(true);
  });

  test("repeating-divide 1/3 yields 20 threes at default precision", () => {
    expect(Decimal.from("1").dividedBy("3", { precision: 20 }).toString()).toBe("0.33333333333333333333");
  });

  test("100 / 8 produces 12.5 exactly", () => {
    expect(Decimal.from("100").dividedBy("8").toString()).toBe("12.5");
  });

  test("negative arithmetic: -0.5 + 0.5 === 0", () => {
    expect(Decimal.from("-0.5").plus("0.5").eq("0")).toBe(true);
  });

  test("scale alignment: 0.001 + 1000 === 1000.001", () => {
    expect(Decimal.from("0.001").plus("1000").toString()).toBe("1000.001");
  });
});

describe("Decimal.from — parsing", () => {
  test("integer", () => {
    expect(Decimal.from("42").toString()).toBe("42");
  });

  test("negative integer", () => {
    expect(Decimal.from("-7").toString()).toBe("-7");
  });

  test("decimal", () => {
    expect(Decimal.from("3.14").toString()).toBe("3.14");
  });

  test("leading zero in fractional", () => {
    expect(Decimal.from("0.0825").toString()).toBe("0.0825");
  });

  test("explicit positive sign", () => {
    expect(Decimal.from("+1.5").toString()).toBe("1.5");
  });

  test("scientific notation positive exp", () => {
    expect(Decimal.from("1.5e3").toString()).toBe("1500");
  });

  test("scientific notation negative exp", () => {
    expect(Decimal.from("1.5e-3").toString()).toBe("0.0015");
  });

  test("scientific notation explicit + sign", () => {
    expect(Decimal.from("1e+2").toString()).toBe("100");
  });

  test("just decimal point with leading dot", () => {
    expect(Decimal.from(".5").toString()).toBe("0.5");
  });

  test("just decimal point with trailing dot", () => {
    expect(Decimal.from("5.").toString()).toBe("5");
  });

  test("from bigint", () => {
    expect(Decimal.from(123n).toString()).toBe("123");
  });

  test("from number — small integer", () => {
    expect(Decimal.from(42).toString()).toBe("42");
  });

  test("from number — small decimal preserves source", () => {
    // Number(0.1) round-trips through toString to "0.1".
    expect(Decimal.from(0.1).toString()).toBe("0.1");
  });

  test("from another Decimal returns the same instance", () => {
    const d = Decimal.from("1.5");
    expect(Decimal.from(d)).toBe(d);
  });

  test("rejects empty string", () => {
    expect(() => Decimal.from("")).toThrow();
  });

  test("rejects pure garbage", () => {
    expect(() => Decimal.from("abc")).toThrow();
  });

  test("rejects NaN-like number", () => {
    expect(() => Decimal.from(NaN)).toThrow();
  });

  test("rejects Infinity-like number", () => {
    expect(() => Decimal.from(Infinity)).toThrow();
  });
});

describe("Decimal — arithmetic", () => {
  test("plus exact (no scale shift)", () => {
    expect(Decimal.from("1.5").plus("2.5").toString()).toBe("4.0");
  });

  test("minus", () => {
    expect(Decimal.from("10").minus("3").toString()).toBe("7");
  });

  test("minus with scale shift", () => {
    expect(Decimal.from("1").minus("0.001").toString()).toBe("0.999");
  });

  test("times integers", () => {
    expect(Decimal.from("7").times("6").toString()).toBe("42");
  });

  test("times decimals — exact", () => {
    expect(Decimal.from("0.1").times("0.1").toString()).toBe("0.01");
  });

  test("times — large bigint", () => {
    expect(Decimal.from("999999999999999999").times("999999999999999999").toString()).toBe(
      "999999999999999998000000000000000001",
    );
  });

  test("dividedBy — exact terminating", () => {
    expect(Decimal.from("1").dividedBy("4").toString()).toBe("0.25");
  });

  test("dividedBy — short alias .div", () => {
    expect(Decimal.from("1").div("4").toString()).toBe("0.25");
  });

  test("dividedBy — by negative", () => {
    expect(Decimal.from("1").dividedBy("-4").toString()).toBe("-0.25");
  });

  test("dividedBy — repeating with precision 5", () => {
    expect(Decimal.from("1").dividedBy("3", { precision: 5 }).toString()).toBe("0.33333");
  });

  test("dividedBy — repeating with precision 10", () => {
    expect(Decimal.from("1").dividedBy("3", { precision: 10 }).toString()).toBe("0.3333333333");
  });

  test("dividedBy — by zero throws", () => {
    expect(() => Decimal.from("1").dividedBy("0")).toThrow();
  });

  test("dividedBy — zero divided by anything is zero", () => {
    expect(Decimal.from("0").dividedBy("7").eq("0")).toBe(true);
  });

  test("neg flips sign", () => {
    expect(Decimal.from("3.14").neg().toString()).toBe("-3.14");
  });

  test("neg twice is identity", () => {
    expect(Decimal.from("3.14").neg().neg().toString()).toBe("3.14");
  });

  test("abs of negative", () => {
    expect(Decimal.from("-5").abs().toString()).toBe("5");
  });

  test("abs of positive is unchanged", () => {
    expect(Decimal.from("5").abs().toString()).toBe("5");
  });
});

describe("Decimal — comparisons", () => {
  test("eq same value different scale", () => {
    // 1.0 and 1 are equal even though their internal repr differs.
    expect(Decimal.from("1.0").eq("1")).toBe(true);
  });

  test("eq different values", () => {
    expect(Decimal.from("1").eq("2")).toBe(false);
  });

  test("lt", () => {
    expect(Decimal.from("1").lt("2")).toBe(true);
    expect(Decimal.from("2").lt("1")).toBe(false);
    expect(Decimal.from("1").lt("1")).toBe(false);
  });

  test("gt", () => {
    expect(Decimal.from("2").gt("1")).toBe(true);
    expect(Decimal.from("1").gt("2")).toBe(false);
    expect(Decimal.from("1").gt("1")).toBe(false);
  });

  test("lte / gte boundary", () => {
    expect(Decimal.from("1").lte("1")).toBe(true);
    expect(Decimal.from("1").gte("1")).toBe(true);
    expect(Decimal.from("0.999").lte("1")).toBe(true);
    expect(Decimal.from("1.001").gte("1")).toBe(true);
  });

  test("compareTo returns -1 / 0 / 1", () => {
    expect(Decimal.from("1").compareTo("2")).toBe(-1);
    expect(Decimal.from("2").compareTo("1")).toBe(1);
    expect(Decimal.from("1").compareTo("1")).toBe(0);
  });

  test("isZero / isNegative / isPositive", () => {
    expect(Decimal.from("0").isZero()).toBe(true);
    expect(Decimal.from("-1").isNegative()).toBe(true);
    expect(Decimal.from("1").isPositive()).toBe(true);
    expect(Decimal.from("0").isNegative()).toBe(false);
    expect(Decimal.from("0").isPositive()).toBe(false);
  });
});

describe("Decimal — toString round-trips", () => {
  const ROUND_TRIP_CASES = [
    "0",
    "1",
    "-1",
    "42",
    "3.14",
    "0.5",
    "0.0825",
    "1000",
    "1000.001",
    "-0.0001",
    "0.33333333333333333333",
    "999999999999999999",
  ];
  for (const s of ROUND_TRIP_CASES) {
    test(`toString round-trip: ${s}`, () => {
      expect(Decimal.from(s).toString()).toBe(s);
    });
  }
});

describe("Decimal — toNumber", () => {
  test("0.1 → 0.1 (Number representation lands here)", () => {
    expect(Decimal.from("0.1").toNumber()).toBe(0.1);
  });

  test("0.1 + 0.2 .toNumber() lands on 0.3 (rounding luck)", () => {
    // Decimal arithmetic gives exact 0.3, then toNumber() goes through
    // parseFloat("0.3") which yields exactly 0.3 as a JS Number.
    expect(Decimal.from("0.1").plus("0.2").toNumber()).toBe(0.3);
  });

  test("integer toNumber", () => {
    expect(Decimal.from("42").toNumber()).toBe(42);
  });

  test("toNumber is documented-lossy for huge values", () => {
    // 2^53 + 1 is not representable as a Number — this lossily collapses to 2^53.
    const tooBig = "9007199254740993";
    expect(Decimal.from(tooBig).toNumber()).toBe(9007199254740992);
  });
});

describe("Decimal — toBigInt", () => {
  test("integer toBigInt", () => {
    expect(Decimal.from("42").toBigInt()).toBe(42n);
  });

  test("decimal truncates toward zero", () => {
    expect(Decimal.from("3.7").toBigInt()).toBe(3n);
    expect(Decimal.from("-3.7").toBigInt()).toBe(-3n);
  });
});

describe("Decimal — rounding modes", () => {
  // Showcase: dividing 1 by 0.7 with different rounding modes at low precision.
  // Exact value of 1 / 0.7 is 1.42857142857142857142857... — so at
  // precision 3 the relevant digits are "1.42|857..." (last digit = 2,
  // digit being rounded = 8 ≥ 5 → all "round up" modes go to 1.43,
  // truncate → 1.42).
  const cases: Array<[RoundingMode, string]> = [
    ["DOWN", "1.42"],
    ["UP", "1.43"],
    ["HALF_UP", "1.43"],
    ["HALF_DOWN", "1.43"],
    ["HALF_EVEN", "1.43"],
    ["FLOOR", "1.42"],
    ["CEILING", "1.43"],
  ];
  for (const [mode, expected] of cases) {
    test(`1 / 0.7 @ precision 3, ${mode} → ${expected}`, () => {
      expect(Decimal.from("1").dividedBy("0.7", { precision: 3, roundingMode: mode }).toString()).toBe(expected);
    });
  }

  // Banker's rounding distinctive case: tie (.5) rounds to even.
  test("HALF_EVEN: 0.125 → 0.12 (round to even, 2 is even)", () => {
    // 0.125 / 1 with precision 2 → keep 2 sig digits, round. Coef tail is 5, last kept is 2.
    expect(Decimal.from("0.125").dividedBy("1", { precision: 2, roundingMode: "HALF_EVEN" }).toString()).toBe("0.12");
  });

  test("HALF_EVEN: 0.135 → 0.14 (round to even, 4 is even)", () => {
    expect(Decimal.from("0.135").dividedBy("1", { precision: 2, roundingMode: "HALF_EVEN" }).toString()).toBe("0.14");
  });

  test("HALF_UP: 0.125 → 0.13 (always away from zero on tie)", () => {
    expect(Decimal.from("0.125").dividedBy("1", { precision: 2, roundingMode: "HALF_UP" }).toString()).toBe("0.13");
  });

  test("HALF_DOWN: 0.125 → 0.12 (always toward zero on tie)", () => {
    expect(Decimal.from("0.125").dividedBy("1", { precision: 2, roundingMode: "HALF_DOWN" }).toString()).toBe("0.12");
  });

  test("FLOOR: -0.125 / 1 @ p=2 → -0.13 (toward -∞)", () => {
    expect(Decimal.from("-0.125").dividedBy("1", { precision: 2, roundingMode: "FLOOR" }).toString()).toBe("-0.13");
  });

  test("CEILING: -0.125 / 1 @ p=2 → -0.12 (toward +∞)", () => {
    expect(Decimal.from("-0.125").dividedBy("1", { precision: 2, roundingMode: "CEILING" }).toString()).toBe("-0.12");
  });
});

describe("Decimal — General Decimal Arithmetic spec spot-checks", () => {
  // Hand-picked cases from Mike Cowlishaw's GDA test suite
  // (https://speleotrove.com/decimal/dectest.html), addition tests in the
  // dec*.decTest files. We don't try to cover the corpus — just enough to
  // catch obvious bugs in scale alignment and sign handling.
  test("addx004: 12 + 7.00 = 19.00", () => {
    expect(Decimal.from("12").plus("7.00").toString()).toBe("19.00");
  });

  test("addx016: 1E+2 + 1E+4 = 10100", () => {
    expect(Decimal.from("1E+2").plus("1E+4").toString()).toBe("10100");
  });

  test("addx021: 1.234 + 76.54 = 77.774 (mixed scale)", () => {
    expect(Decimal.from("1.234").plus("76.54").toString()).toBe("77.774");
  });

  test("subx004: 0.10 - 0.10 = 0.00", () => {
    // Our toString collapses zero to "0" regardless of exp — the canonical
    // GDA result is "0.00" but we deliberately deviate (zero is the only
    // value where exp-preservation costs more than it's worth). Verify
    // both: the canonical equality holds, and our toString is "0".
    const result = Decimal.from("0.10").minus("0.10");
    expect(result.eq("0")).toBe(true);
    expect(result.toString()).toBe("0");
  });

  test("mulx005: 1.20 * 3 = 3.60", () => {
    expect(Decimal.from("1.20").times("3").toString()).toBe("3.60");
  });

  test("divx016: 12345 / 2 = 6172.5", () => {
    expect(Decimal.from("12345").dividedBy("2").toString()).toBe("6172.5");
  });

  test("divx022: 1 / 2 = 0.5", () => {
    expect(Decimal.from("1").dividedBy("2").toString()).toBe("0.5");
  });

  test("comx0x : -0.0 == 0", () => {
    expect(Decimal.from("-0").eq("0")).toBe(true);
  });
});

describe("__paraDec — runtime helper", () => {
  test("returns a Decimal", () => {
    expect(__paraDec("1.5")).toBeInstanceOf(Decimal);
  });

  test("preserves the source string exactly", () => {
    expect(__paraDec("0.1").toString()).toBe("0.1");
  });

  test("round-trips through arithmetic", () => {
    expect(__paraDec("0.1").plus(__paraDec("0.2")).eq(__paraDec("0.3"))).toBe(true);
  });
});

describe("Decimal.isDecimal", () => {
  test("recognizes a Decimal", () => {
    expect(Decimal.isDecimal(Decimal.from("1"))).toBe(true);
  });

  test("rejects a number", () => {
    expect(Decimal.isDecimal(42)).toBe(false);
  });

  test("rejects a plain object", () => {
    expect(Decimal.isDecimal({ coef: 1n, exp: 0 })).toBe(false);
  });
});
