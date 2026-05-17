import { describe, expect, test } from "bun:test";
import { transpile } from "../src/index";

describe("..> (then operator)", () => {
  test("..> desugars to .then", () => {
    expect(transpile("const x = p ..> handler;").trim()).toBe("const x = p.then(handler);");
  });

  test("chained ..> ..>", () => {
    expect(transpile("const x = p ..> f ..> g;").trim()).toBe("const x = p.then(f).then(g);");
  });

  test("arrow handler", () => {
    expect(transpile("const x = p ..> v => v + 1;").trim()).toBe("const x = p.then(v => v + 1);");
  });

  test("chains ..> with ..!", () => {
    expect(transpile("const x = p ..> f ..! handler;").trim()).toBe("const x = p.then(f).catch(handler);");
  });

  test("chains ..> with ..&", () => {
    expect(transpile("const x = p ..> f ..& cleanup;").trim()).toBe("const x = p.then(f).finally(cleanup);");
  });

  test("full chain ..> ..! ..&", () => {
    expect(transpile("const x = p ..> f ..! handler ..& cleanup;").trim()).toBe(
      "const x = p.then(f).catch(handler).finally(cleanup);",
    );
  });

  test("|> binds tighter than ..>", () => {
    // data |> transform ..> next → transform(data).then(next)
    expect(transpile("const x = data |> transform ..> next;").trim()).toBe("const x = transform(data).then(next);");
  });

  test("does not fire inside string literals", () => {
    expect(transpile(`const s = "p ..> q";`).trim()).toBe(`const s = "p ..> q";`);
  });

  test("does not fire inside template literals", () => {
    expect(transpile("const s = `p ..> q`;").trim()).toBe("const s = `p ..> q`;");
  });

  test("does not fire inside line comments", () => {
    expect(transpile(`// p ..> q\nconst x = 1;`).trim()).toBe(`// p ..> q\nconst x = 1;`);
  });

  test("does not fire inside block comments", () => {
    expect(transpile(`/* p ..> q */\nconst x = 1;`).trim()).toBe(`/* p ..> q */\nconst x = 1;`);
  });

  test("does fire inside template interpolation", () => {
    expect(transpile("const s = `${p ..> q}`;").trim()).toBe("const s = `${p.then(q)}`;");
  });

  test("multi-line file", () => {
    const input = `
const result = fetch("/api")
  ..> r => r.json()
  ..! console.error
  ..& cleanup;
`;
    const out = transpile(input).trim();
    expect(out).toContain(".then(r => r.json())");
    expect(out).toContain(".catch(console.error)");
    expect(out).toContain(".finally(cleanup)");
  });

  test("bare arrow handler on a single line", () => {
    expect(transpile("const x = p ..> r => r.json();").trim()).toBe("const x = p.then(r => r.json());");
  });

  test("chain of three with bare arrows on a single line", () => {
    expect(transpile("const x = p ..> r => r.json() ..! err => defaults ..& () => done();").trim()).toBe(
      "const x = p.then(r => r.json()).catch(err => defaults).finally(() => done());",
    );
  });

  test("bare arrow with nullary `() => ...` handler", () => {
    expect(transpile("const x = p ..& () => done();").trim()).toBe("const x = p.finally(() => done());");
  });

  test("inner chain inside parens stays nested", () => {
    expect(transpile("const x = p ..! err => (recover() ..! finalFallback);").trim()).toBe(
      "const x = p.catch(err => (recover().catch(finalFallback)));",
    );
  });

  test("mix of bare arrow and named handler in one chain", () => {
    expect(transpile("const x = p ..> r => r.value ..! handler ..& done;").trim()).toBe(
      "const x = p.then(r => r.value).catch(handler).finally(done);",
    );
  });

  test("parenthesized arrow form still works (regression)", () => {
    expect(transpile("const x = promise ..> (r => r.json());").trim()).toBe("const x = promise.then((r => r.json()));");
  });

  test("end-of-statement bare arrow without trailing semicolon", () => {
    expect(transpile("const x = p ..> r => r.json()").trim()).toBe("const x = p.then(r => r.json())");
  });

  describe("leading-dot sugar", () => {
    // `..> .json()` is shorthand for `..> (__pcv) => __pcv.json()`. The leading
    // `.` is unambiguous in chain-op handler position because the chain op
    // itself just consumed the LHS, so there's nothing to the left of the dot
    // to read a property from.

    test("..> .json() — single method call", () => {
      expect(transpile("const x = p ..> .json();").trim()).toBe("const x = p.then((__pcv) => __pcv.json());");
    });

    test("..> .data — property access (no parens)", () => {
      expect(transpile("const x = p ..> .data;").trim()).toBe("const x = p.then((__pcv) => __pcv.data);");
    });

    test("..> .users[0].id — chained property + index + property", () => {
      expect(transpile("const x = p ..> .users[0].id;").trim()).toBe("const x = p.then((__pcv) => __pcv.users[0].id);");
    });

    test("..> .toString() — argless method call", () => {
      expect(transpile("const x = p ..> .toString();").trim()).toBe("const x = p.then((__pcv) => __pcv.toString());");
    });

    test("..> .map(x => x * 2) — inner arrow argument", () => {
      // The inner `x => x * 2` is an argument to `.map`; the synthesized arrow
      // wraps the whole `.map(...)` call, not the inner `x => x * 2`.
      expect(transpile("const x = p ..> .map(x => x * 2);").trim()).toBe(
        "const x = p.then((__pcv) => __pcv.map(x => x * 2));",
      );
    });

    test("..! .message — error message extraction", () => {
      expect(transpile("const x = p ..! .message;").trim()).toBe("const x = p.catch((__pcv) => __pcv.message);");
    });

    test("..! .stack — property on error", () => {
      expect(transpile("const x = p ..! .stack;").trim()).toBe("const x = p.catch((__pcv) => __pcv.stack);");
    });

    test("mixes bare arrow and leading-dot in the same chain", () => {
      expect(transpile("const x = p ..> .json() ..! err => defaults ..& () => done();").trim()).toBe(
        "const x = p.then((__pcv) => __pcv.json()).catch(err => defaults).finally(() => done());",
      );
    });

    test("identifier handler still works (regression — no leading dot)", () => {
      expect(transpile("const x = p ..> parseJson;").trim()).toBe("const x = p.then(parseJson);");
    });

    test("parens-wrapped arrow still works (regression — leading paren, not dot)", () => {
      expect(transpile("const x = p ..> ((r) => r.json());").trim()).toBe("const x = p.then(((r) => r.json()));");
    });

    test("..& deliberately doesn't get the sugar (no implicit receiver)", () => {
      // `.finally` callbacks receive no value — the leading-dot sugar would
      // bind to nothing. Leave the handler as-is so the downstream parser
      // surfaces the leading-dot as the syntax error it is.
      const out = transpile("const x = p ..& .hide();").trim();
      // The handler text is left alone — no `__pcv` arrow synthesized for ..&.
      expect(out).toContain(".finally(.hide())");
      expect(out).not.toContain("__pcv");
    });

    test("end-to-end multi-line chain", () => {
      const input = `
const data = await (
  fetch(url)
    ..> .json()
    ..! err => defaults
    ..& () => spinner.hide()
);
`;
      const out = transpile(input).trim();
      expect(out).toContain(".then((__pcv) => __pcv.json())");
      expect(out).toContain(".catch(err => defaults)");
      expect(out).toContain(".finally(() => spinner.hide())");
    });
  });
});
