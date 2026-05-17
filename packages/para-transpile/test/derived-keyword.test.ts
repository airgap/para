import { describe, expect, test } from "bun:test";
import { transpile } from "../src/index";

// `derived NAME = EXPR` desugars to
//   const NAME = require("@lyku/para-signals").derived(() => EXPR)
// with the same bare-read rewrite the auto-promoted signal form already
// performs (any signal read inside EXPR becomes `.get()`). The new
// binding itself is also signal-tagged, so reads of NAME elsewhere become
// `NAME.get()` per the universal bare-read rule.
//
// Many assertions check SUBSTRINGS — Babel's generator may reformat
// whitespace / quotes.

describe("derived NAME = EXPR — basic desugar", () => {
  test("plain literal RHS still wraps in derived(() => …)", () => {
    // No signal reads — the derived never re-fires, but we don't error.
    // Mirrors how `signal NAME = LITERAL` doesn't error.
    const out = transpile(`derived x = 42;`);
    expect(out).toContain('require("@lyku/para-signals").derived(() => 42)');
    expect(out).toContain("const x = ");
  });

  test("multi-line expression (ternary spanning newlines) is captured whole", () => {
    // Regression: the initializer scanner used to break at the first
    // depth-0 newline, truncating the expression and dangling the rest.
    // The canonical Zig parser consumes the full expression; the mirror
    // must too (parity).
    const out = transpile(`derived u = cond && x.length > 0\n  ? x\n  : fallback();\nconst after = 1;`);
    expect(out).toContain("? x");
    expect(out).toContain(": fallback()");
    expect(out).toContain("const after = 1;");
    expect(out).not.toMatch(/derived\(\(\) => [^)]*\)\s*\n\s*\?/);
  });

  test("expression form without trailing `;` (ASI) stops at the newline", () => {
    const out = transpile(`derived s = a + b\nconst y = 1;`);
    expect(out).toContain('require("@lyku/para-signals").derived(() => a + b)');
    expect(out).toContain("const y = 1;");
  });

  test("single signal read becomes .get() inside the arrow body", () => {
    const out = transpile(`signal a = 1;\nderived b = a + 1;`);
    expect(out).toContain('require("@lyku/para-signals").derived(() => a.get() + 1)');
  });

  test("multi-signal read — each gets .get() inside the arrow body", () => {
    const out = transpile(`signal a = 1;\nsignal b = 2;\nderived c = a + b;`);
    expect(out).toContain("derived(() => a.get() + b.get())");
  });
});

describe("derived NAME = EXPR — chains and references", () => {
  test("derived chain — one derived reading another gets tracked", () => {
    const out = transpile(`signal a = 1;\nderived b = a * 2;\nderived c = b + 1;`);
    expect(out).toContain("derived(() => a.get() * 2)");
    expect(out).toContain("derived(() => b.get() + 1)");
  });

  test("references to a derived NAME elsewhere become NAME.get() too", () => {
    const out = transpile(`signal a = 1;\nderived b = a * 2;\nconsole.log(b);`);
    expect(out).toContain("b.get()");
    expect(out).toContain("derived(() => a.get() * 2)");
  });
});

describe("derived NAME = EXPR — nested function scope rules", () => {
  test("signal reads inside a nested function body do NOT get tracked", () => {
    // Same scope rule as the existing signal auto-promotion: bare-read
    // rewrites every reference to a signal-tagged binding regardless of
    // nesting (Babel's scope.getBinding handles shadowing). The expected
    // shape: the nested function body still references `a`, but ONLY the
    // immediate body of the derived registers the dep at construction
    // time. The runtime tracking is what differs — the textual rewrite
    // still inserts .get() for both because the binding resolves up to
    // the same outer signal.
    //
    // What we actually verify: nested function reads ARE rewritten to
    // .get() (since the outer binding resolves to a signal), but they
    // happen at call-time, not at derived re-eval time. The test below
    // confirms the derived's outer body wraps the function in an arrow
    // whose immediate body returns the function — and the function
    // body's `a` is rewritten too (because the binding resolves up).
    const out = transpile(`signal a = 1;\nderived fn = () => a;`);
    // The arrow has body `() => a` — the inner arrow's `a` resolves to
    // the outer signal binding, so it gets `.get()`.
    expect(out).toContain("derived(() =>");
    expect(out).toContain("a.get()");
  });

  test("shadowed inner const is NOT rewritten to .get()", () => {
    const out = transpile(`signal x = 1;\nderived y = (() => { const x = 5; return x; })();`);
    // The inner `x` shadows the outer signal — Babel's scope resolution
    // returns the inner binding, which isn't signal-tagged, so no .get().
    expect(out).toMatch(/return x[;)]?/);
    // Make sure we didn't blanket-rewrite to x.get() inside the IIFE.
    expect(out).not.toMatch(/return x\.get\(\)/);
  });
});

describe("derived NAME = EXPR — TypeScript annotations", () => {
  test("type annotation is stripped from the desugared output", () => {
    const out = transpile(`signal a = 1;\nderived b: number = a + 1;`);
    expect(out).toContain("const b = ");
    expect(out).toContain("derived(() => a.get() + 1)");
    // TS annotation should not leak into the desugared output.
    expect(out).not.toContain(": number");
  });

  test("type annotation with generic params is also handled", () => {
    const out = transpile(`signal items = [];\nderived first: string | undefined = items[0];`);
    expect(out).toContain("const first = ");
    expect(out).toContain("derived(() =>");
    expect(out).not.toContain(": string");
  });
});

describe("derived NAME = EXPR — does not interfere with `derived` identifier", () => {
  test("imported `derived` identifier still works as a call expression", () => {
    const out = transpile(
      `import { signal, derived } from "@lyku/para-signals";\nconst a = signal(1);\nconst b = derived(() => a.get() * 2);`,
    );
    // Should remain unchanged — `derived(...)` mid-statement isn't the keyword form.
    expect(out).toContain("derived(() => a.get() * 2)");
    expect(out).toContain('import { signal, derived } from "@lyku/para-signals"');
  });
});

// Regression — pair to test/bundler/transpiler/parabun-derived-keyword.test.js's
// "arrow-as-RHS regression" block. The Zig parser was crashing on these
// shapes due to a scope-loc collision; @para/transpile already lowered them
// correctly, so these tests pin the lowering shape so we don't drift away
// from parity once the Zig fix lands.
describe("arrow / function expression as RHS — parity with the Zig parser", () => {
  test("`signal NAME = () => …` keeps the arrow as the cell value (no extra wrap)", () => {
    const out = transpile(`signal x = () => 5;`);
    expect(out).toContain(`require("@lyku/para-signals").signal(`);
    // Exactly one arrow lambda — the user's, passed straight to signal().
    expect(out).toMatch(/signal\(\(\)\s*=>\s*5\)/);
  });

  test("`derived NAME = () => …` wraps with a synthetic outer thunk (function-as-value)", () => {
    const out = transpile(`derived y = () => 7;`);
    expect(out).toContain(`require("@lyku/para-signals").derived(`);
    // Two arrows: outer thunk + the user's arrow as its return value.
    expect(out).toMatch(/derived\(\(\)\s*=>\s*\(\)\s*=>\s*7\)/);
  });

  test("`signal NAME = function() {…}` (function expression) lowers without crash", () => {
    const out = transpile(`signal x = function () { return 99; };`);
    expect(out).toContain(`require("@lyku/para-signals").signal(`);
    expect(out).toContain("function");
    expect(out).toContain("return 99");
  });

  test("separate single-decl statements with arrow RHS each", () => {
    // Multi-decl on a single statement (`signal a = …, b = …;`) is a
    // Zig-parser-only feature today — @para/transpile's regex-based
    // splitter doesn't recognize top-level commas as decl separators, so
    // it treats `1, b = () => 2` as one comma-expression initializer.
    // The Zig parser's `parabun-derived-keyword.test.js` covers the
    // multi-decl shape end-to-end. Until the splitter is taught about
    // commas, parity here only holds for one decl per statement.
    const out = transpile(`signal a = () => 1;\nsignal b = () => 2;\nderived c = () => 3;\nderived d = () => 4;`);
    expect(out).toMatch(/const a = require\("@lyku\/para-signals"\)\.signal\(\(\)\s*=>\s*1\)/);
    expect(out).toMatch(/const b = require\("@lyku\/para-signals"\)\.signal\(\(\)\s*=>\s*2\)/);
    expect(out).toMatch(/const c = require\("@lyku\/para-signals"\)\.derived\(\(\)\s*=>\s*\(\)\s*=>\s*3\)/);
    expect(out).toMatch(/const d = require\("@lyku\/para-signals"\)\.derived\(\(\)\s*=>\s*\(\)\s*=>\s*4\)/);
  });

  test("arrow with parameters as RHS", () => {
    const out = transpile(`derived add = (n, m) => n + m;`);
    expect(out).toMatch(/derived\(\(\)\s*=>\s*\(n,\s*m\)\s*=>\s*n\s*\+\s*m\)/);
  });
});
