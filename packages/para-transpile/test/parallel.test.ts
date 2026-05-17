import { describe, expect, test } from "bun:test";
import { transpile } from "../src/index";

describe("parallel — expression form `parallel { … }`", () => {
  test("single key", () => {
    expect(transpile("const x = await parallel { user: fetchUser(id) };").trim()).toBe(
      "const x = await Promise.all([fetchUser(id)]).then(([__pb0]) => ({ user: __pb0 }));",
    );
  });

  test("multi key — keys come out in source order", () => {
    expect(
      transpile(
        "const x = await parallel { user: fetchUser(id), posts: fetchPosts(id), comments: fetchComments(id) };",
      ).trim(),
    ).toBe(
      "const x = await Promise.all([fetchUser(id), fetchPosts(id), fetchComments(id)]).then(([__pb0, __pb1, __pb2]) => ({ user: __pb0, posts: __pb1, comments: __pb2 }));",
    );
  });

  test("empty parallel {}", () => {
    expect(transpile("const x = await parallel {};").trim()).toBe("const x = await Promise.all([]).then(() => ({}));");
  });

  test("string key", () => {
    expect(transpile(`const x = await parallel { "weird-key": f() };`).trim()).toBe(
      `const x = await Promise.all([f()]).then(([__pb0]) => ({ "weird-key": __pb0 }));`,
    );
  });

  test("chains with ..!", () => {
    expect(transpile("const x = await parallel { a: f() } ..! e => fallback;").trim()).toBe(
      "const x = await Promise.all([f()]).then(([__pb0]) => ({ a: __pb0 })).catch(e => fallback);",
    );
  });

  test("used as a return value", () => {
    const out = transpile("async function f() { return await parallel { a: g(), b: h() }; }").trim();
    expect(out).toContain("Promise.all([g(), h()])");
    expect(out).toContain("a: __pb0, b: __pb1");
  });

  test("does not fire inside string literals", () => {
    expect(transpile(`const s = "parallel { x: y }";`).trim()).toBe(`const s = "parallel { x: y }";`);
  });

  test("does not fire inside comments", () => {
    expect(transpile(`// parallel { x: y }\nconst x = 1;`).trim()).toBe(`// parallel { x: y }\nconst x = 1;`);
  });

  test("reorder source keys, results follow names", () => {
    // Regression for the headline footgun: changing source order of keys
    // shouldn't silently change result shape (other than the names).
    const a = transpile("const x = await parallel { user: f(), posts: g() };").trim();
    const b = transpile("const x = await parallel { posts: g(), user: f() };").trim();
    expect(a).toContain("user: __pb0, posts: __pb1");
    expect(b).toContain("posts: __pb0, user: __pb1");
    // Both Promise.all arrays match their key order:
    expect(a).toContain("Promise.all([f(), g()])");
    expect(b).toContain("Promise.all([g(), f()])");
  });
});

describe("parallel — statement form `parallel let|const … = …, …`", () => {
  test("single decl with let", () => {
    expect(transpile("parallel let x = f();").trim()).toBe("const [x] = await Promise.all([f()]);");
  });

  test("single decl with const", () => {
    expect(transpile("parallel const x = f();").trim()).toBe("const [x] = await Promise.all([f()]);");
  });

  test("multi decl with long names", () => {
    expect(
      transpile(
        "parallel let theDataFromServer = fetchA(), theDataFromOtherServer = fetchB(), fooBarBazBim = fetchC();",
      ).trim(),
    ).toBe(
      "const [theDataFromServer, theDataFromOtherServer, fooBarBazBim] = await Promise.all([fetchA(), fetchB(), fetchC()]);",
    );
  });

  test("per-decl ..! is preserved per-binding", () => {
    expect(transpile("parallel let a = f1() ..! d1, b = f2() ..! d2;").trim()).toBe(
      "const [a, b] = await Promise.all([f1().catch(d1), f2().catch(d2)]);",
    );
  });

  test("typescript annotation is allowed", () => {
    // Type annotations are stripped by the downstream TS pipeline; here we
    // just verify the statement parses and the right RHS is captured.
    expect(transpile("parallel let x: User = fetchUser();").trim()).toBe(
      "const [x] = await Promise.all([fetchUser()]);",
    );
  });

  test("works inside a function body", () => {
    const out = transpile(`async function f() { parallel let a = g(), b = h(); return a + b; }`).trim();
    expect(out).toContain("const [a, b] = await Promise.all([g(), h()]);");
    expect(out).toContain("return a + b");
  });

  test("does not fire inside strings", () => {
    expect(transpile(`const s = "parallel let x = 1;";`).trim()).toBe(`const s = "parallel let x = 1;";`);
  });

  test("does not fire when `parallel` is a plain identifier", () => {
    // `parallel(x)` — call expression, leave alone.
    expect(transpile("parallel(x);").trim()).toBe("parallel(x);");
    // `parallel.foo` — property access, leave alone.
    expect(transpile("parallel.foo;").trim()).toBe("parallel.foo;");
    // `parallel = 1` — assignment, leave alone.
    expect(transpile("parallel = 1;").trim()).toBe("parallel = 1;");
  });
});

describe("para — shorthand alias for parallel", () => {
  test("statement form: `para let` lowers identically to `parallel let`", () => {
    expect(transpile("para let a = f1(), b = f2();").trim()).toBe(transpile("parallel let a = f1(), b = f2();").trim());
  });

  test("statement form: `para const` lowers identically to `parallel const`", () => {
    expect(transpile("para const x = f();").trim()).toBe(transpile("parallel const x = f();").trim());
  });

  test("statement form: `para let` with one decl", () => {
    expect(transpile("para let x = f();").trim()).toBe("const [x] = await Promise.all([f()]);");
  });

  test("statement form: per-decl ..! preserved", () => {
    expect(transpile("para let a = f1() ..! d1, b = f2() ..! d2;").trim()).toBe(
      "const [a, b] = await Promise.all([f1().catch(d1), f2().catch(d2)]);",
    );
  });

  test("expression form: `para { … }` lowers identically to `parallel { … }`", () => {
    expect(transpile("const x = await para { a: f1(), b: f2() };").trim()).toBe(
      transpile("const x = await parallel { a: f1(), b: f2() };").trim(),
    );
  });

  test("expression form: bare `para { … }` lowering shape", () => {
    expect(transpile("const x = await para { user: fetchUser(id) };").trim()).toBe(
      "const x = await Promise.all([fetchUser(id)]).then(([__pb0]) => ({ user: __pb0 }));",
    );
  });

  test("mixed in one file: `parallel` and `para` decls coexist", () => {
    const out = transpile("parallel let a = f1(); para let b = f2();").trim();
    expect(out).toContain("const [a] = await Promise.all([f1()]);");
    expect(out).toContain("const [b] = await Promise.all([f2()]);");
  });

  test("`para` as a regular identifier still works", () => {
    expect(transpile("const para = 5; const x = para + 1;").trim()).toBe("const para = 5; const x = para + 1;");
  });

  test("`para()` as a function call doesn't trigger the keyword", () => {
    expect(transpile("function para() {} para();").trim()).toBe("function para() {} para();");
  });

  test("`para.foo` as a property access doesn't trigger", () => {
    expect(transpile("para.foo;").trim()).toBe("para.foo;");
  });

  test("`import { para }` doesn't trigger", () => {
    expect(transpile(`import { para } from "somewhere";`).trim()).toBe(`import { para } from "somewhere";`);
  });

  test("`para = 1` assignment doesn't trigger", () => {
    expect(transpile("para = 1;").trim()).toBe("para = 1;");
  });

  test("`para` followed by an unrelated identifier doesn't trigger", () => {
    // e.g. `paratrooper`, `paragraph` — `\b` keeps these from matching.
    expect(transpile("const paragraph = 1; const paratrooper = 2;").trim()).toBe(
      "const paragraph = 1; const paratrooper = 2;",
    );
  });

  test("does not fire inside string literals", () => {
    expect(transpile(`const s = "para { x: y }";`).trim()).toBe(`const s = "para { x: y }";`);
    expect(transpile(`const s = "para let x = 1;";`).trim()).toBe(`const s = "para let x = 1;";`);
  });
});
