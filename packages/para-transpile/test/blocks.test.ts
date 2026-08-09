import { describe, expect, test } from "bun:test";
import { transpile } from "../src/index";

describe("signal declaration", () => {
  test("simple", () => {
    expect(transpile("signal x = 0;")).toBe(`const x = require("@lyku/para-signals").signal(0);`);
  });

  test("with type annotation", () => {
    expect(transpile("signal x: number = 0;")).toBe(`const x = require("@lyku/para-signals").signal(0);`);
  });

  test("with complex initializer (object)", () => {
    expect(transpile("signal user = { name: 'a', age: 0 };")).toBe(
      `const user = require("@lyku/para-signals").signal({ name: 'a', age: 0 });`,
    );
  });

  test("with array initializer", () => {
    expect(transpile("signal items: Todo[] = [];")).toBe(`const items = require("@lyku/para-signals").signal([]);`);
  });

  test("multiple on separate lines", () => {
    const out = transpile("signal a = 1;\nsignal b = 2;");
    expect(out).toBe(
      `const a = require("@lyku/para-signals").signal(1);\nconst b = require("@lyku/para-signals").signal(2);`,
    );
  });

  test("does not fire inside string", () => {
    expect(transpile(`const s = "signal x = 0";`)).toBe(`const s = "signal x = 0";`);
  });
});

describe("effect block", () => {
  test("simple body", () => {
    expect(transpile("effect { console.log(x); }")).toBe(
      `require("@lyku/para-signals").effect(() => { console.log(x); })`,
    );
  });

  test("multi-statement body", () => {
    const out = transpile("effect { a(); b(); c(); }");
    expect(out).toBe(`require("@lyku/para-signals").effect(() => { a(); b(); c(); })`);
  });

  test("nested braces in body", () => {
    expect(transpile("effect { if (x) { y(); } }")).toBe(
      `require("@lyku/para-signals").effect(() => { if (x) { y(); } })`,
    );
  });

  test("does not fire inside string", () => {
    expect(transpile(`const s = "effect { foo }";`)).toBe(`const s = "effect { foo }";`);
  });
});

describe("effect single-statement form (effect STMT;)", () => {
  test("`effect EXPR;` → EXPRESSION-bodied effect(() => EXPR) (implicit return / cleanup preserved)", () => {
    const out = transpile(`effect appSync.sync();\nconst x = 1;`);
    expect(out).toBe(`require("@lyku/para-signals").effect(() => appSync.sync())\nconst x = 1;`);
    // NOT a block body: a block would discard a teardown return.
    expect(out).not.toContain("=> {");
  });

  test("teardown-returning effect keeps its implicit return (the useKeybind case)", () => {
    const out = transpile(`effect useKeybind("nav.home", () => goto("/"));`);
    expect(out).toBe(`require("@lyku/para-signals").effect(() => useKeybind("nav.home", () => goto("/")))`);
  });

  test("multi-line single-statement body is captured whole", () => {
    const out = transpile(`effect store.sync(n)\n  ? a()\n  : b();\nconst y = 1;`);
    expect(out).toContain(`require("@lyku/para-signals").effect(() => store.sync(n)`);
    expect(out).toContain("? a()");
    expect(out).toContain(": b()");
    expect(out).toContain("const y = 1;");
  });

  test("disambiguation: `effect(` / `effect.x` / `effect=` stay plain identifiers", () => {
    expect(transpile(`effect();`)).toBe(`effect();`);
    expect(transpile(`effect.foo();`)).toBe(`effect.foo();`);
    expect(transpile(`effect = makeEffect();`)).toBe(`effect = makeEffect();`);
  });

  test("`effect:` label is not hijacked", () => {
    expect(transpile(`effect: for (;;) break effect;`)).toBe(`effect: for (;;) break effect;`);
  });

  test("block form still works (regression)", () => {
    expect(transpile("effect { a(); b(); }")).toBe(`require("@lyku/para-signals").effect(() => { a(); b(); })`);
  });
});

describe("arena block", () => {
  test("simple body", () => {
    expect(transpile("arena { work(); }")).toBe(`require("@lyku/para-arena").scope(() => { work(); })`);
  });
});

describe("when block", () => {
  test("when EXPR { body }", () => {
    expect(transpile("when count > 5 { fire(); }")).toBe(
      `require("@lyku/para-signals").when(() => count > 5, () => { fire(); })`,
    );
  });

  test("when not EXPR { body } negates the predicate", () => {
    expect(transpile("when not online { showOffline(); }")).toBe(
      `require("@lyku/para-signals").when(() => !(online), () => { showOffline(); })`,
    );
  });

  test("nested braces in body", () => {
    expect(transpile("when x { if (y) { z(); } }")).toBe(
      `require("@lyku/para-signals").when(() => x, () => { if (y) { z(); } })`,
    );
  });

  test("complex predicate", () => {
    expect(transpile("when a && b > 5 { go(); }")).toBe(
      `require("@lyku/para-signals").when(() => a && b > 5, () => { go(); })`,
    );
  });
});

// Predicate-less paired `when X { } when not { }` is NOT canonical Para
// (zero parabun corpus coverage; the Zig parser rejects it: see the P2
// boundary doc). The mirror's paired-form path was removed. Consecutive
// `when` blocks are independent: each carries its own predicate.
describe("consecutive when blocks (independent, not paired)", () => {
  test("when X { } when not Y { }: Y is its own predicate", () => {
    const out = transpile("when a { f(); } when not b { g(); }");
    expect(out).toContain(`when(() => a, () => { f(); })`);
    expect(out).toContain(`when(() => !(b), () => { g(); })`);
  });
});
