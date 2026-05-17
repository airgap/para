import { describe, expect, test } from "bun:test";
import { transpile } from "../src/index";

// `fun` → `function`. Mirrors the Zig lexer (js_lexer.zig: `fun`
// identifier == `function` keyword in parabun files). NOT
// length-preserving — `fun ` (4) → `function ` (9).

describe("fun keyword", () => {
  test("fun NAME(...) declaration", () => {
    expect(transpile("fun add(a, b) { return a + b; }")).toBe("function add(a, b) { return a + b; }");
  });

  test("async fun", () => {
    expect(transpile("async fun load() { return 1; }")).toBe("async function load() { return 1; }");
  });

  test("fun as a function expression", () => {
    expect(transpile("const f = fun (x) { return x; };")).toBe("const f = function (x) { return x; };");
  });

  test("generator fun*", () => {
    expect(transpile("fun* gen() { yield 1; }")).toBe("function* gen() { yield 1; }");
  });

  test("generic fun<T>", () => {
    expect(transpile("fun id<T>(x: T): T { return x; }")).toBe("function id<T>(x: T): T { return x; }");
  });

  test("TS type annotations are preserved (not stripped)", () => {
    expect(transpile("fun load(): Promise<void> { return Promise.resolve(); }")).toBe(
      "function load(): Promise<void> { return Promise.resolve(); }",
    );
  });

  test("member access `.fun` is untouched", () => {
    expect(transpile("obj.fun(1);")).toBe("obj.fun(1);");
  });

  test("identifier `fun` as a value is untouched", () => {
    expect(transpile("const x = fun;")).toBe("const x = fun;");
    expect(transpile("return fun;")).toBe("return fun;");
  });

  test("`fun` inside a string is untouched", () => {
    expect(transpile('const s = "fun foo() {}";')).toBe('const s = "fun foo() {}";');
  });

  test("keyword rewrite is independent of body contents", () => {
    // Operator lowering inside blocks is a separate @para/transpile
    // concern — transformFun only owns the keyword itself.
    expect(transpile("fun run() { return data; }")).toBe("function run() { return data; }");
  });
});
