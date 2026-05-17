import { describe, expect, test } from "bun:test";
import { transpileBare as transpile } from "./_helpers";

describe("memo declaration form", () => {
  test("memo NAME(arg) { body } — single arg", () => {
    expect(transpile("memo fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }")).toBe(
      "const fib = __parabunMemo(function (n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }, 1)",
    );
  });

  test("memo NAME(a, b) { body } — multi arg", () => {
    expect(transpile("memo add(a, b) { return a + b; }")).toBe(
      "const add = __parabunMemo(function (a, b) { return a + b; }, 2)",
    );
  });

  test("memo with zero args", () => {
    expect(transpile("memo singleton() { return Date.now(); }")).toBe(
      "const singleton = __parabunMemo(function () { return Date.now(); }, 0)",
    );
  });

  test("memo async NAME(args) { body }", () => {
    expect(transpile("memo async loadUser(id) { return await db.get(id); }")).toBe(
      "const loadUser = __parabunMemo(async function (id) { return await db.get(id); }, 1)",
    );
  });

  test("export memo NAME(args) { body }", () => {
    expect(transpile("export memo norm(s) { return s.trim(); }")).toBe(
      "export const norm = __parabunMemo(function (s) { return s.trim(); }, 1)",
    );
  });
});

describe("memo arrow form", () => {
  test("const x = memo (a) => body", () => {
    expect(transpile("const dbl = memo (x) => x * 2;")).toBe("const dbl = __parabunMemo((x) => x * 2, 1);");
  });

  test("const x = memo (a, b) => body", () => {
    expect(transpile("const sum = memo (a, b) => a + b;")).toBe("const sum = __parabunMemo((a, b) => a + b, 2);");
  });

  test("const x = memo arg => body — single-arg shorthand", () => {
    expect(transpile("const dbl = memo x => x * 2;")).toBe("const dbl = __parabunMemo(x => x * 2, 1);");
  });

  test("memo async (a) => body", () => {
    expect(transpile("const load = memo async (k) => k;")).toBe("const load = __parabunMemo(async (k) => k, 1);");
  });
});

describe("memo non-matches", () => {
  test("memo(5) — call expression — left alone", () => {
    expect(transpile("const x = memo(5);")).toBe("const x = memo(5);");
  });

  test("memo.foo — property access — left alone", () => {
    expect(transpile("const x = memo.foo;")).toBe("const x = memo.foo;");
  });

  test("memo = 1 — assignment to ident — left alone", () => {
    expect(transpile("memo = 1;")).toBe("memo = 1;");
  });

  test("does not fire inside string", () => {
    expect(transpile(`const s = "memo fib(n)";`)).toBe(`const s = "memo fib(n)";`);
  });
});
