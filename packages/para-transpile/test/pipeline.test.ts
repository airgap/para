import { describe, expect, test } from "bun:test";
import { transpile } from "../src/index";

describe("pipeline operator", () => {
  test("x |> f → f(x)", () => {
    expect(transpile("const r = x |> f;").trim()).toBe("const r = f(x);");
  });

  test("chains left-to-right", () => {
    expect(transpile("const r = x |> f |> g;").trim()).toBe("const r = g(f(x));");
  });

  test("function-target form: x |> f(y) → f(y)(x)", () => {
    expect(transpile("const r = x |> f(y);").trim()).toBe("const r = f(y)(x);");
  });

  test("placeholder: x |> f(_, y) → f(x, y)", () => {
    expect(transpile("const r = x |> f(_, y);").trim()).toBe("const r = f(x, y);");
  });

  test("placeholder in middle: x |> f(a, _, b) → f(a, x, b)", () => {
    expect(transpile("const r = x |> f(a, _, b);").trim()).toBe("const r = f(a, x, b);");
  });

  test("method shorthand: x |> .method() → x.method()", () => {
    expect(transpile("const r = x |> .toUpperCase();").trim()).toBe("const r = x.toUpperCase();");
  });

  test("method shorthand with prop chain", () => {
    expect(transpile("const r = user |> .profile.name;").trim()).toBe("const r = user.profile.name;");
  });

  test("does not fire inside strings", () => {
    expect(transpile(`const s = "x |> f";`).trim()).toBe(`const s = "x |> f";`);
  });

  // LYK-914: pipelines inside `{ }` statement blocks must lower (were
  // silently no-op'd — the `findNextTopLevelPipe` brace-depth bug).
  describe("inside blocks (LYK-914)", () => {
    test("function body", () => {
      expect(transpile("function r(){ return data |> transform; }")).toBe("function r(){ return transform(data); }");
    });

    test("arrow block body", () => {
      expect(transpile("const r = x => { return data |> f; };")).toBe("const r = x => { return f(data); };");
    });

    test("control-flow block", () => {
      expect(transpile("if (z) { data |> sink; }")).toBe("if (z) { sink(data); }");
    });

    test("chain inside a fun body", () => {
      expect(transpile("fun run(){ const y = a |> b |> c; }")).toBe("function run(){ const y = c(b(a)); }");
    });

    test("arrow body passed as a call argument (paren-nested block)", () => {
      expect(transpile("arr.map(x => { return x |> f; })")).toBe("arr.map(x => { return f(x); })");
      expect(transpile("setTimeout(() => { go |> run; }, 10)")).toBe("setTimeout(() => { run(go); }, 10)");
    });

    test("desugared effect body (transformBlocks runs first)", () => {
      expect(transpile("effect { count |> log }")).toBe('require("@lyku/para-signals").effect(() => { log(count) })');
    });

    test("pipeline composes with chain op in a block", () => {
      expect(transpile("function r(){ a |> b ..! e; }")).toBe("function r(){ b(a).catch(e); }");
    });

    test("placeholder + chain inside a fun body", () => {
      expect(transpile("fun load(){ items |> filter(_, ok) |> first }")).toBe(
        "function load(){ first(filter(items, ok)) }",
      );
    });

    test("object/expression literal braces are deliberately left alone", () => {
      // (LHS scan would mis-bound a `:`-keyed property value — separate,
      // rarer concern; leaving it unchanged is a no-op, not a regression.)
      expect(transpile("const o = { k: x |> f };")).toBe("const o = { k: x |> f };");
    });

    test("top-level still works (no regression)", () => {
      expect(transpile("data |> top;")).toBe("top(data);");
    });
  });
});
