import { describe, expect, test } from "bun:test";
import { transformUsingPolyfill } from "../src/transforms/using-polyfill";
import { injectUsingHelpers } from "../src/transforms/inject-helpers";

// transformUsingPolyfill walks the AST and rewrites `using` /
// `await using` declarations into TS-style try/catch/finally blocks
// that call __addDisposableResource and __disposeResources. Helpers are
// injected separately by injectUsingHelpers — the transform itself just
// emits the calls.

describe("using polyfill — sync", () => {
  test("single `using` decl is wrapped in try/catch/finally", () => {
    const out = transformUsingPolyfill(`{
  using x = make();
  use(x);
}`);
    expect(out).toContain("__addDisposableResource(");
    expect(out).toContain(", make(), false");
    expect(out).toContain("__disposeResources(");
    expect(out).toContain("try {");
    expect(out).toContain("} catch (");
    expect(out).toContain("} finally {");
    expect(out).not.toContain("using x = make()");
  });

  test("env tracker uses object shape with stack/error/hasError", () => {
    const out = transformUsingPolyfill(`{
  using x = make();
}`);
    expect(out).toMatch(/const __paraEnv\d+ = \{\s*stack: \[\],\s*error: undefined,\s*hasError: false/);
  });

  test("multiple `using` decls share one env + try block", () => {
    const out = transformUsingPolyfill(`{
  using a = m1();
  using b = m2();
  use(a, b);
}`);
    // One env decl, one try, two __addDisposableResource calls.
    const envCount = (out.match(/__paraEnv\d+ = \{/g) ?? []).length;
    expect(envCount).toBe(1);
    const addCount = (out.match(/__addDisposableResource\(/g) ?? []).length;
    expect(addCount).toBe(2);
  });
});

describe("using polyfill — await using", () => {
  test("await using decl marks env async", () => {
    const out = transformUsingPolyfill(`async function f() {
  await using x = open();
  await use(x);
}`);
    // The third arg to __addDisposableResource is `true` for async.
    expect(out).toContain(", open(), true");
    // The dispose call gets awaited because the block contains an await using.
    expect(out).toContain("await __disposeResources(");
  });

  test("mixed sync + await using picks async dispose", () => {
    const out = transformUsingPolyfill(`async function f() {
  using a = m1();
  await using b = m2();
  use(a, b);
}`);
    expect(out).toContain(", m1(), false");
    expect(out).toContain(", m2(), true");
    expect(out).toContain("await __disposeResources(");
  });
});

describe("using polyfill — non-matches", () => {
  test("source without `using` is returned verbatim", () => {
    const src = `const x = 1;\nconst y = make();\nuse(x, y);\n`;
    expect(transformUsingPolyfill(src)).toBe(src);
  });

  test("source with `using` keyword inside a string is untouched", () => {
    // Pre-flight regex `\busing\s` matches inside the string but the parse
    // pass sees no real `using` decls — falls through with the AST emit
    // (which may reformat whitespace). We only assert that the polyfill
    // didn't emit any helper calls.
    const out = transformUsingPolyfill(`const s = "using foo = make()";`);
    expect(out).not.toContain("__addDisposableResource");
    expect(out).not.toContain("__disposeResources");
  });

  test("malformed source is returned verbatim (parse failure)", () => {
    const src = "function f() { using x = ; }";
    const out = transformUsingPolyfill(src);
    expect(out).toBe(src);
  });
});

describe("inject-helpers", () => {
  test("injects helper preamble when __addDisposableResource is referenced", () => {
    const src = `const x = __addDisposableResource(env, make(), false);`;
    const out = injectUsingHelpers(src);
    expect(out).toContain("function __addDisposableResource(");
    expect(out).toContain("function __disposeResources(");
    expect(out.endsWith(src)).toBe(true);
  });

  test("injects when __disposeResources is referenced even without add", () => {
    const src = `function cleanup() { return __disposeResources(env); }`;
    const out = injectUsingHelpers(src);
    expect(out).toContain("function __addDisposableResource(");
  });

  test("does NOT inject when no helper references appear", () => {
    const src = `const x = 1;`;
    expect(injectUsingHelpers(src)).toBe(src);
  });

  test("does NOT double-inject when helpers already defined", () => {
    const src = `function __addDisposableResource(env, value, async) { return value; }
const x = __addDisposableResource(env, make(), false);`;
    expect(injectUsingHelpers(src)).toBe(src);
  });
});
