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

// Literal-membership mirror of the canonical Zig lowering
// (test/bundler/transpiler/parabun-is.test.js, "literal-membership").
// String literals are re-quoted to double (matching the Zig printer) so
// the chain is byte-equal after parity normalisation, which preserves
// quote style; the always-parens vs the printer's minimal parens IS
// canonicalised by the AST normaliser. Verified end-to-end: parity
// runner (debug parabun vs this mirror) green on fixtures/is-membership.pts.
describe("is literal-membership operator", () => {
  test("string union → parenthesised === OR-chain", () => {
    expect(transpile("const r = s is 'a' | 'b' | 'c';")).toBe('const r = (s === "a" || s === "b" || s === "c");');
  });

  test("single literal → (s === lit)", () => {
    expect(transpile("const r = s is 'only';")).toBe('const r = (s === "only");');
  });

  test("numeric union", () => {
    expect(transpile("const r = n is 1 | 2 | 3;")).toBe("const r = (n === 1 || n === 2 || n === 3);");
  });

  test("`is not` → De-Morgan !== / &&", () => {
    expect(transpile("const r = s is not 'a' | 'b';")).toBe('const r = (s !== "a" && s !== "b");');
  });

  test("property-path operand", () => {
    expect(transpile("const r = obj.kind is 'a' | 'b';")).toBe('const r = (obj.kind === "a" || obj.kind === "b");');
  });

  test("precedence-safe inside a larger expression", () => {
    expect(transpile("const z = a && s is 'x' | 'y';")).toBe('const z = a && (s === "x" || s === "y");');
  });

  test("no collision: `is Capitalized` still the schema guard", () => {
    expect(transpile("const r = input is User;")).toBe('const r = User.parse(input).tag === "Ok";');
  });

  test("lowercase-ident RHS untouched (neither membership nor schema)", () => {
    expect(transpile("const is = 5; const r = is + 1;")).toBe("const is = 5; const r = is + 1;");
  });

  test("string literal containing a pipe is not split", () => {
    expect(transpile("const r = s is 'a|b' | 'c';")).toBe('const r = (s === "a|b" || s === "c");');
  });
});
