import { describe, expect, test } from "bun:test";
import { transpile } from "../src/index";

// Cross-cutting tests — transforms should compose cleanly when more than
// one Para operator appears in the same expression.

describe("integration: pipeline + error-chain", () => {
  test("data |> transform ..! handler", () => {
    expect(transpile("const r = data |> transform ..! handler;")).toBe("const r = transform(data).catch(handler);");
  });

  test("data |> transform ..& cleanup", () => {
    expect(transpile("const r = data |> transform ..& cleanup;")).toBe("const r = transform(data).finally(cleanup);");
  });

  test("data |> transform ..! handler ..& cleanup", () => {
    expect(transpile("const r = data |> transform ..! handler ..& cleanup;")).toBe(
      "const r = transform(data).catch(handler).finally(cleanup);",
    );
  });
});

describe("integration: pipeline + ranges", () => {
  test("range piped through filter via placeholder", () => {
    const out = transpile("const evens = 0..=20 |> filter(_, even);");
    expect(out).toContain('import { __parabunRangeInclusive } from "bun:wrap";');
    expect(out).toContain("const evens = filter(__parabunRangeInclusive(0, 20), even);");
  });
});

describe("integration: pure + pipeline", () => {
  test("pure function + pipeline call", () => {
    const out = transpile(`pure function sq(x) { return x * x; }\nconst r = 5 |> sq |> sq;`);
    expect(out).toContain("     function sq(x) { return x * x; }");
    expect(out).toContain("const r = sq(sq(5));");
  });
});
