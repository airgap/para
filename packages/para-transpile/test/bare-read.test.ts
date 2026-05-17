import { describe, expect, test } from "bun:test";
import { transpile } from "../src/index";

// These tests exercise the AST pass that rewrites bare signal reads /
// writes inside tracked contexts. Each test feeds .pts source through
// the full transpile() pipeline and asserts the final JS output.
//
// Many assertions check for SUBSTRINGS rather than exact bytes because
// Babel's generator may reformat whitespace / quotes.

describe("bare-read inside effect block", () => {
  test("identifier read becomes .get()", () => {
    const out = transpile(`signal count = 0;\neffect { console.log(count); }`);
    expect(out).toContain("count.get()");
    expect(out).not.toMatch(/console\.log\(count\)/);
  });

  test("bare assignment becomes .set()", () => {
    const out = transpile(`signal count = 0;\neffect { count = 5; }`);
    expect(out).toContain("count.set(5)");
  });

  test("compound assignment (+=) lowers to set + get", () => {
    const out = transpile(`signal n = 0;\neffect { n += 3; }`);
    expect(out).toContain("n.set(n.get() + 3)");
  });

  test("post-increment (++) lowers to set + value-recovery comma expression", () => {
    // Post-inc: `n++` evaluates to the OLD value. Canonical emits
    // `(n.set(n.get() + 1), n.get() - 1)` — the right side recovers the
    // pre-increment value. We match.
    const out = transpile(`signal n = 0;\neffect { n++; }`);
    expect(out).toContain("n.set(n.get() + 1)");
    expect(out).toContain("n.get() - 1");
  });

  test("post-decrement (--) lowers to set + value-recovery comma expression", () => {
    const out = transpile(`signal n = 5;\neffect { n--; }`);
    expect(out).toContain("n.set(n.get() - 1)");
    expect(out).toContain("n.get() + 1");
  });

  test("pre-increment (++) returns new value via .get()", () => {
    const out = transpile(`signal n = 0;\nconst v = ++n;`);
    expect(out).toContain("n.set(n.get() + 1)");
    // Pre-inc recovered value is just `n.get()` (no offset).
    expect(out).toMatch(/n\.set\(n\.get\(\) \+ 1\), n\.get\(\)\)/);
  });

  test("multi-signal expression — each gets .get()", () => {
    const out = transpile(`signal a = 1;\nsignal b = 2;\neffect { console.log(a + b); }`);
    expect(out).toContain("a.get()");
    expect(out).toContain("b.get()");
  });
});

describe("bare-read inside when predicate and body", () => {
  test("predicate identifier becomes .get()", () => {
    const out = transpile(`signal ready = false;\nwhen ready { go(); }`);
    expect(out).toContain("ready.get()");
  });

  test("predicate with logical ops — both signals tracked", () => {
    const out = transpile(`signal a = false;\nsignal b = false;\nwhen a && b { both(); }`);
    expect(out).toContain("a.get()");
    expect(out).toContain("b.get()");
  });

  test("body identifier becomes .get()", () => {
    const out = transpile(`signal n = 0;\nsignal go = false;\nwhen go { console.log(n); }`);
    expect(out).toContain("n.get()");
  });
});

describe("auto-promotion: signal initializer that reads other signals", () => {
  test("simple binary op promotes to derived", () => {
    const out = transpile(`signal a = 1;\nsignal b = a + 1;`);
    expect(out).toContain('require("@lyku/para-signals").derived(() => a.get() + 1)');
    expect(out).not.toContain('require("@lyku/para-signals").signal(a + 1)');
  });

  test("chained derivations", () => {
    const out = transpile(`signal a = 1;\nsignal b = a * 2;\nsignal c = b + a;`);
    expect(out).toContain("derived(() => a.get() * 2)");
    expect(out).toContain("derived(() => b.get() + a.get())");
  });

  test("standalone signal (no signal reads) stays signal()", () => {
    const out = transpile(`signal x = 0;`);
    expect(out).toContain('require("@lyku/para-signals").signal(0)');
    expect(out).not.toContain("derived");
  });

  test("self-reference does NOT auto-promote to derived", () => {
    // The auto-promotion scan excludes the binding currently being
    // declared, so `signal x = x;` doesn't get .signal() → .derived()
    // promotion. (The bare-read pass DOES still rewrite the inner `x`
    // to `x.get()` per canonical's universal rule — TDZ-erroring at
    // runtime, same as base JS, but transpile is consistent.)
    const out = transpile(`signal x = x;`);
    expect(out).not.toContain("derived");
    expect(out).toContain(".signal(x.get())");
  });
});

describe("bare-read scope rules", () => {
  test("non-signal binding is not rewritten", () => {
    const out = transpile(`const plain = 5;\nsignal s = 0;\neffect { console.log(plain, s); }`);
    expect(out).toContain("s.get()");
    // `plain` is just a const, not a signal — no .get() call should be inserted.
    expect(out).not.toMatch(/plain\.get\(\)/);
  });

  test("shadowing — inner non-signal hides outer signal", () => {
    const out = transpile(`signal x = 0;\nfunction f() { const x = 5; return x; }\neffect { console.log(x); }`);
    // Outer x in effect → `.get()`. Inner x in f → bare reference.
    expect(out).toContain("x.get()");
    // Babel may rename the inner one; just ensure we didn't blanket-rewrite.
    expect(out).toMatch(/return x[;)]?/);
  });

  test("signal read outside any tracked context is also rewritten", () => {
    // Canonical Parabun rewrites EVERY signal-binding reference to .get(),
    // not just those inside effect/when/derived bodies. Tracked contexts
    // are about WHAT re-fires, not about whether to insert .get().
    const out = transpile(`signal x = 0;\nconsole.log(x);`);
    expect(out).toContain("x.get()");
  });
});

describe("bare-read inside ~> binding", () => {
  test("~> LHS reads get tracked", () => {
    const out = transpile(`signal name = "world";\nname ~> document.title;`);
    // The ~> rewrite produces `effect(() => { document.title = name; })`.
    // Then bare-read should turn `name` into `name.get()`.
    expect(out).toContain("name.get()");
  });
});
