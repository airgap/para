import { describe, expect, test } from "bun:test";
import { transpile } from "../src/index";

// Note: the `pure` strip is intentionally column-preserving — `pure ` (5
// chars) becomes 5 spaces. Don't `.trim()` the output or the leading spaces
// disappear and the assertion looks misleading.

describe("pure keyword strip", () => {
  test("pure function NAME(...) → 5 spaces + function", () => {
    expect(transpile("pure function add(a, b) { return a + b; }")).toBe("     function add(a, b) { return a + b; }");
  });

  test("pure async function", () => {
    expect(transpile("pure async function load() { return 1; }")).toBe("     async function load() { return 1; }");
  });

  test("pure (x) => arrow", () => {
    expect(transpile("const f = pure (x) => x * 2;")).toBe("const f =      (x) => x * 2;");
  });

  test("pure x => arrow", () => {
    expect(transpile("const f = pure x => x * 2;")).toBe("const f =      x => x * 2;");
  });

  test("does not touch identifier `pure` (e.g. `pure.foo`)", () => {
    expect(transpile("const x = pure.foo;")).toBe("const x = pure.foo;");
  });

  test("does not fire inside strings", () => {
    expect(transpile(`const s = "pure function foo() {}";`)).toBe(`const s = "pure function foo() {}";`);
  });
});
