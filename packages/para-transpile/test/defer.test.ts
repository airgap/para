import { beforeEach, describe, expect, test } from "bun:test";
import { _resetDeferCounter, transformDefer } from "../src/transforms/defer";

beforeEach(() => _resetDeferCounter());

// Tests target transformDefer() in isolation — the full transpile()
// pipeline runs the using-polyfill afterwards which rewrites these raw
// `using` declarations into try/catch/finally blocks. The polyfill has
// its own dedicated tests; here we want to verify the defer lowering
// itself.
const transpile = transformDefer;

describe("defer", () => {
  test("simple sync defer", () => {
    expect(transpile("defer cleanup();")).toBe("using __paraDefer0 = __parabunDefer0(() => cleanup());");
  });

  test("defer with property access", () => {
    expect(transpile("defer fs.closeSync(fd);")).toBe("using __paraDefer0 = __parabunDefer0(() => fs.closeSync(fd));");
  });

  test("defer await", () => {
    expect(transpile("defer await flush();")).toBe(
      "await using __paraDefer0 = __parabunAsyncDefer0(async () => flush());",
    );
  });

  test("multiple defers in same scope get unique names", () => {
    const out = transpile("defer a();\ndefer b();\ndefer c();");
    expect(out).toContain("__paraDefer0");
    expect(out).toContain("__paraDefer1");
    expect(out).toContain("__paraDefer2");
  });

  test("does not fire inside string", () => {
    expect(transpile(`const s = "defer foo()";`)).toBe(`const s = "defer foo()";`);
  });

  test("does not fire on identifier `defer` (e.g. `defer.foo`)", () => {
    expect(transpile("const x = defer.foo;")).toBe("const x = defer.foo;");
  });

  test("inside an inner block", () => {
    const out = transpile("function f() { defer cleanup(); doWork(); }");
    expect(out).toBe("function f() { using __paraDefer0 = __parabunDefer0(() => cleanup()); doWork(); }");
  });
});
