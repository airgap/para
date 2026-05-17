import { describe, expect, test } from "bun:test";
import { transpileBare as transpile } from "./_helpers";

describe("range operators", () => {
  test("a..b → __parabunRange(a, b)", () => {
    expect(transpile("const r = 0..5;").trim()).toBe("const r = __parabunRange(0, 5);");
  });

  test("a..=b → __parabunRangeInclusive(a, b)", () => {
    expect(transpile("const r = 0..=5;").trim()).toBe("const r = __parabunRangeInclusive(0, 5);");
  });

  test("identifier bounds", () => {
    expect(transpile("for (const i of start..end) f(i);").trim()).toBe(
      "for (const i of __parabunRange(start, end)) f(i);",
    );
  });

  test("inclusive with identifier bounds", () => {
    expect(transpile("for (const i of 0..=n) f(i);").trim()).toBe(
      "for (const i of __parabunRangeInclusive(0, n)) f(i);",
    );
  });

  test("does not touch spread (...)", () => {
    expect(transpile("const a = [...xs];").trim()).toBe("const a = [...xs];");
  });

  test("does not fire inside strings", () => {
    expect(transpile(`const s = "0..5";`).trim()).toBe(`const s = "0..5";`);
  });

  test("does not fire inside line comments", () => {
    expect(transpile("// 0..5\nconst x = 1;").trim()).toBe("// 0..5\nconst x = 1;");
  });
});
