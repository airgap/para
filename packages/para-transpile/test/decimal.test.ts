// `Nd` decimal literal lowering — `Nd` → `__paraDec("N")`.

import { describe, expect, test } from "bun:test";
import { transpile } from "../src/index";
import { transpileBare } from "./_helpers";

describe("decimal literal lowering", () => {
  test('0.1d → __paraDec("0.1")', () => {
    expect(transpileBare("const x = 0.1d;").trim()).toBe(`const x = __paraDec("0.1");`);
  });

  test('integer 1d → __paraDec("1")', () => {
    expect(transpileBare("const x = 1d;").trim()).toBe(`const x = __paraDec("1");`);
  });

  test("100.25d preserves exact source", () => {
    expect(transpileBare("const x = 100.25d;").trim()).toBe(`const x = __paraDec("100.25");`);
  });

  test("trailing-dot 5.d", () => {
    expect(transpileBare("const x = 5.d;").trim()).toBe(`const x = __paraDec("5.");`);
  });

  test("leading-dot .5d", () => {
    expect(transpileBare("const x = .5d;").trim()).toBe(`const x = __paraDec(".5");`);
  });

  test("scientific notation 1.5e3d", () => {
    expect(transpileBare("const x = 1.5e3d;").trim()).toBe(`const x = __paraDec("1.5e3");`);
  });

  test("scientific notation negative exponent 1.5e-3d", () => {
    expect(transpileBare("const x = 1.5e-3d;").trim()).toBe(`const x = __paraDec("1.5e-3");`);
  });

  test("multiple literals on one line", () => {
    expect(transpileBare("const a = 0.1d, b = 0.2d, c = 0.3d;").trim()).toBe(
      `const a = __paraDec("0.1"), b = __paraDec("0.2"), c = __paraDec("0.3");`,
    );
  });

  test("does not fire on identifiers ending in d (1d vs id)", () => {
    expect(transpileBare("let id = 1; id = id + 1;").trim()).toBe("let id = 1; id = id + 1;");
  });

  test("does not fire on `do` keyword", () => {
    expect(transpileBare("do { f(); } while (false);").trim()).toBe("do { f(); } while (false);");
  });

  test("does not fire on a number followed by `do`", () => {
    expect(transpileBare("for (let i = 0; i < 10; i++) do { f(); } while (false);").trim()).toBe(
      "for (let i = 0; i < 10; i++) do { f(); } while (false);",
    );
  });

  test("does not fire inside string literal", () => {
    expect(transpileBare(`const s = "0.1d";`).trim()).toBe(`const s = "0.1d";`);
  });

  test("does not fire inside line comment", () => {
    expect(transpileBare("// 0.1d here\nconst x = 1;").trim()).toBe("// 0.1d here\nconst x = 1;");
  });

  test("does not fire inside block comment", () => {
    expect(transpileBare("/* 0.1d */ const x = 1;").trim()).toBe("/* 0.1d */ const x = 1;");
  });

  test("does not fire on hex literal 0xdead", () => {
    expect(transpileBare("const x = 0xdead;").trim()).toBe("const x = 0xdead;");
  });

  test("does not fire on bigint literal 1n", () => {
    expect(transpileBare("const x = 1n;").trim()).toBe("const x = 1n;");
  });

  test("does not fire on `1de` (longer identifier suffix)", () => {
    // `1de` is a syntax error in raw JS — but if a user's source contains
    // the substring inside something else (e.g. a property access shape
    // we don't expect), we don't want to grab it.
    expect(transpileBare("const x = obj.1de;").trim()).toBe("const x = obj.1de;");
  });

  test("does not fire on property access like obj.5d", () => {
    // Not legal JS but if it appears we shouldn't transform it.
    expect(transpileBare("const x = obj.5d;").trim()).toBe("const x = obj.5d;");
  });

  test("operates inside arrow function body", () => {
    expect(transpileBare("const f = () => 0.1d;").trim()).toBe(`const f = () => __paraDec("0.1");`);
  });

  test("chained arithmetic via .plus", () => {
    expect(transpileBare("const x = 0.1d.plus(0.2d);").trim()).toBe(
      `const x = __paraDec("0.1").plus(__paraDec("0.2"));`,
    );
  });

  test("inside an array literal", () => {
    expect(transpileBare("const xs = [0.1d, 0.2d, 0.3d];").trim()).toBe(
      `const xs = [__paraDec("0.1"), __paraDec("0.2"), __paraDec("0.3")];`,
    );
  });

  test("injects bun:wrap import when used", () => {
    const out = transpile("const x = 0.1d;");
    expect(out).toContain(`import {`);
    expect(out).toContain(`__paraDec`);
    expect(out).toContain(`from "bun:wrap"`);
  });

  test("does NOT inject bun:wrap import when no decimal literal present", () => {
    const out = transpile("const x = 0.1;");
    expect(out).not.toContain(`__paraDec`);
  });
});
