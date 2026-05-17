import { describe, expect, test } from "bun:test";
import { transpile } from "../src/index";

// Parity with the canonical Zig lowering
// (test/bundler/transpiler/parabun-is.test.js):
//   EXPR is Type      → Type.parse(EXPR).tag === "Ok"
//   EXPR is not Type  → Type.parse(EXPR).tag !== "Ok"

describe("is type-guard operator", () => {
  test('`x is Type` → Type.parse(x).tag === "Ok"', () => {
    expect(transpile("const ok = input is User;")).toBe('const ok = User.parse(input).tag === "Ok";');
  });

  test('`x is not Type` → Type.parse(x).tag !== "Ok"', () => {
    expect(transpile("const bad = input is not User;")).toBe('const bad = User.parse(input).tag !== "Ok";');
  });

  test("in `if` predicate", () => {
    expect(transpile("if (req is User) { foo(); }")).toBe('if (User.parse(req).tag === "Ok") { foo(); }');
  });

  test("in ternary", () => {
    expect(transpile('const x = (val is User) ? "ok" : "no";')).toBe(
      'const x = (User.parse(val).tag === "Ok") ? "ok" : "no";',
    );
  });

  test("chained left-hand expression", () => {
    expect(transpile("const ok = obj.user is User;")).toBe('const ok = User.parse(obj.user).tag === "Ok";');
  });

  test("multiple `is` in one expression", () => {
    expect(transpile("const r = (a is User) || (b is Post);")).toBe(
      'const r = (User.parse(a).tag === "Ok") || (Post.parse(b).tag === "Ok");',
    );
  });

  test("as a return value (inside a block — region-based, block-aware)", () => {
    expect(transpile("function check(x) { return x is User; }")).toBe(
      'function check(x) { return User.parse(x).tag === "Ok"; }',
    );
  });

  test("inside a fun body", () => {
    expect(transpile("fun guard(v){ if (v is Cat) v.meow(); }")).toBe(
      'function guard(v){ if (Cat.parse(v).tag === "Ok") v.meow(); }',
    );
  });

  test("only Capitalized RHS triggers — `is x` stays an identifier", () => {
    expect(transpile("const is = 5;\nconst r = is + 1;")).toBe("const is = 5;\nconst r = is + 1;");
  });

  test("not rewritten inside strings", () => {
    expect(transpile('const s = "x is User";')).toBe('const s = "x is User";');
  });

  test("composes with pipeline: (x is T) result piped", () => {
    expect(transpile("const r = (x is User) |> assertTrue;")).toBe(
      'const r = assertTrue((User.parse(x).tag === "Ok"));',
    );
  });
});
