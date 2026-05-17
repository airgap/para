import { describe, expect, test } from "bun:test";
import { transpile } from "../src/index";

describe("error-chain operators", () => {
  test("..! desugars to .catch", () => {
    expect(transpile("const x = p ..! handler;").trim()).toBe("const x = p.catch(handler);");
  });

  test("..& desugars to .finally", () => {
    expect(transpile("const x = p ..& cleanup;").trim()).toBe("const x = p.finally(cleanup);");
  });

  test("chains ..! before ..&", () => {
    expect(transpile("const x = p ..! a ..& b;").trim()).toBe("const x = p.catch(a).finally(b);");
  });

  test("multiple ..! in sequence", () => {
    expect(transpile("const x = p ..! first ..! second;").trim()).toBe("const x = p.catch(first).catch(second);");
  });

  test("arrow handler", () => {
    expect(transpile("const x = p ..! err => fallback;").trim()).toBe("const x = p.catch(err => fallback);");
  });

  test("does not fire inside string literals", () => {
    expect(transpile(`const s = "p ..! q";`).trim()).toBe(`const s = "p ..! q";`);
  });

  test("does not fire inside template literals", () => {
    expect(transpile("const s = `p ..! q`;").trim()).toBe("const s = `p ..! q`;");
  });

  test("does not fire inside line comments", () => {
    expect(transpile(`// p ..! q\nconst x = 1;`).trim()).toBe(`// p ..! q\nconst x = 1;`);
  });

  test("does not fire inside block comments", () => {
    expect(transpile(`/* p ..! q */\nconst x = 1;`).trim()).toBe(`/* p ..! q */\nconst x = 1;`);
  });

  test("does fire inside template interpolation", () => {
    expect(transpile("const s = `${p ..! q}`;").trim()).toBe("const s = `${p.catch(q)}`;");
  });

  test("multi-line file", () => {
    const input = `
const cleanup = () => console.log("done");
const result = fetch("/api")
  ..! console.error
  ..& cleanup;
`;
    const out = transpile(input).trim();
    expect(out).toContain(".catch(console.error)");
    expect(out).toContain(".finally(cleanup)");
  });
});
