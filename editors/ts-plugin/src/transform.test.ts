import { describe, expect, test } from "bun:test";
import { containsParabunSyntax, transformParabunToTS } from "./transform";

describe("Parabun → TS plugin transform", () => {
  describe("containsParabunSyntax", () => {
    test("detects pure / fun / |> (existing)", () => {
      expect(containsParabunSyntax("pure (x) => x")).toBe(true);
      expect(containsParabunSyntax("fun foo() {}")).toBe(true);
      expect(containsParabunSyntax("a |> b")).toBe(true);
    });

    test("detects schema / match / effect / when / signal / arena / ::", () => {
      expect(containsParabunSyntax("schema User { id: int }")).toBe(true);
      expect(containsParabunSyntax("match x { 1 => 'a' }")).toBe(true);
      expect(containsParabunSyntax("effect { console.log(x) }")).toBe(true);
      expect(containsParabunSyntax("when x { foo() }")).toBe(true);
      expect(containsParabunSyntax("signal count = 0")).toBe(true);
      expect(containsParabunSyntax("arena { foo() }")).toBe(true);
      expect(containsParabunSyntax("function f(req:: User) {}")).toBe(true);
    });

    test("plain TS passes through", () => {
      expect(containsParabunSyntax("function foo(x: number) { return x; }")).toBe(false);
      expect(containsParabunSyntax("const m = { model: 'x' }")).toBe(false);
    });
  });

  describe("desugars", () => {
    test("`::` validation marker → plain `:` annotation (position-preserving)", () => {
      const out = transformParabunToTS(`function f(req:: User) { return req.id }`);
      // Second `:` becomes a space — keeps column alignment.
      expect(out).toMatch(/function f\(req:\s+User\)/);
      expect(out).not.toContain("::");
    });

    test("`schema X { ... }` → typed alias + const stub", () => {
      const out = transformParabunToTS(`
schema User {
  id: int,
  email: Email
}
`);
      expect(out).toContain("type User = {");
      expect(out).toMatch(/id:\s*number/);
      expect(out).toMatch(/email:\s*string/);
      expect(out).toContain("const User:");
      expect(out).toContain("parse:");
      expect(out).toContain("schema:");
      expect(out).not.toContain("schema User");
    });

    test("`schema X { ... }` maps refinements + arrays + optional fields to TS types", () => {
      const out = transformParabunToTS(`
schema Post {
  id: UUID,
  age: int(0..150)?,
  tags: [str](1..=10),
  status: "draft" | "published"
}
`);
      expect(out).toMatch(/id:\s*string/); // UUID → string
      expect(out).toMatch(/age\?:\s*number/); // int? → number?
      expect(out).toMatch(/tags:\s*string\[\]/); // [str] → string[]
      expect(out).toMatch(/status:\s*"draft"\s*\|\s*"published"/);
    });

    test("`is Type` emits __paraIs_Type calls + helper preludes", () => {
      const out = transformParabunToTS(`
schema User { id: int }
const ok = req is User
if (req is not User) bail()
`);
      expect(out).toContain("__paraIs_User(req)");
      expect(out).toContain("!__paraIs_User(req)");
      // Typed predicate helper for narrowing.
      expect(out).toMatch(/const __paraIs_User = \(v: any\): v is User =>/);
    });

    test("`export schema X { ... }` keeps export", () => {
      const out = transformParabunToTS(`
export schema User {
  id: int
}
`);
      expect(out).toContain("export const User:");
    });

    test("`schema X from EXPR` → typed wrapper call so tsc sees parse/is/schema", () => {
      const out = transformParabunToTS(`schema User from userSchema`);
      expect(out).toContain("const User = __paraFromSchema(() => (userSchema))");
      expect(out).toContain("declare function __paraFromSchema");
      expect(out).not.toContain("const User: any");
    });

    test("`schema X = EXPR` (single-line, non-brace) → typed wrapper call", () => {
      const out = transformParabunToTS(`schema User = userSchema`);
      expect(out).toContain("const User = __paraFromSchema(() => (userSchema))");
      expect(out).toContain("declare function __paraFromSchema");
      expect(out).not.toContain("const User: any");
    });

    test("`export schema X = { multi-line }` wraps the body in __paraFromSchema", () => {
      const out = transformParabunToTS(`
export schema User = {
  properties: { id: { type: "integer" } },
  required: ["id"]
}
`);
      // The body is wrapped so `User.parse(...)` / `User.id` resolve.
      expect(out).toContain("export const User = __paraFromSchema(() => (");
      expect(out).toContain('properties: { id: { type: "integer" } }');
      expect(out).toContain('required: ["id"]');
      expect(out).toContain("declare function __paraFromSchema");
    });

    // schema X declarations also emit a `type X = (typeof X)["schema"]`
    // so users can write `satisfies Foo<X>` without `typeof X` AND get
    // the unwrapped schema body — which is 1.5-2.2x faster for heavy
    // generics like `PostgresTableModel<S>` because tsc doesn't have to
    // walk the `{...} & S` intersection that the full helper return
    // type carries.
    test("`schema X = ...` emits a type alias bound to the unwrapped body", () => {
      const out = transformParabunToTS(`
schema User = { properties: { id: { type: "integer" } } }
`);
      expect(out).toContain("const User = __paraFromSchema(() => (");
      expect(out).toContain(`type User = (typeof User)["schema"]`);
    });

    test("`export schema X = ...` exports BOTH the const and the type alias", () => {
      const out = transformParabunToTS(`
export schema User = { properties: { id: { type: "integer" } } }
`);
      expect(out).toContain("export const User = __paraFromSchema(() => (");
      expect(out).toContain(`export type User = (typeof User)["schema"]`);
    });

    test("`schema X from <expr>` (ingest form) also emits the type alias", () => {
      const out = transformParabunToTS(`
import schemaJSON from "./external.json"
schema External from schemaJSON
`);
      expect(out).toContain("const External = __paraFromSchema(() => (schemaJSON))");
      expect(out).toContain(`type External = (typeof External)["schema"]`);
    });

    test("`match EXPR { ... }` → IIFE stub", () => {
      const out = transformParabunToTS(`
const r = match status {
  200 => "ok",
  _ => "no"
}
`);
      expect(out).toContain("((__m: any): any => null as any)(status)");
      expect(out).not.toContain("match status");
    });

    // Regression: a single-line `match e { ... }` used to swallow the
    // enclosing function's closing brace because the body regex required
    // `\n\s*\}` to terminate. With the brace-balanced scan, the close
    // `}` of the function survives.
    test("single-line match preserves enclosing braces", () => {
      const out = transformParabunToTS(
        `function f(v: unknown): string {\n  return match typeof v { 'string' => 'S', _ => 'O' }\n}`,
      );
      expect(out).toContain("((__m: any): any => null as any)(typeof v)");
      expect(out).not.toContain("match typeof");
      // Both the function's open and close brace must remain.
      expect(out.split("{").length).toBe(out.split("}").length);
    });

    test("match with object-literal arms doesn't get truncated by inner `}`", () => {
      const out = transformParabunToTS(
        `function f(v: unknown): { k: string } {\n  return match typeof v {\n    'string' => { k: 'S' },\n    _ => { k: 'O' },\n  }\n}`,
      );
      expect(out).toContain("((__m: any): any => null as any)(typeof v)");
      // Function body's outer `}` survives the transform.
      expect(out.trim().endsWith("}")).toBe(true);
    });

    test("`effect { body }` → IIFE", () => {
      const out = transformParabunToTS(`effect { console.log("hi") }`);
      expect(out).toContain('(() => { console.log("hi") }');
    });

    test("`when not { ... }` → else", () => {
      const out = transformParabunToTS(`when not { foo() }`);
      expect(out).toContain("else { foo() }");
    });

    test("`when x { ... }` → if (x)", () => {
      const out = transformParabunToTS(`when ready { go() }`);
      expect(out).toContain("if (ready) { go() }");
    });

    test("`signal NAME = ...` → let NAME: any", () => {
      const out = transformParabunToTS(`signal count = 0`);
      expect(out).toContain("let count: any");
    });

    test("`arena { body }` → sync IIFE", () => {
      const out = transformParabunToTS(`arena { foo() }`);
      expect(out).toContain("(() => { foo() }");
    });

    test("existing `pure` / `fun` / `..!` / `|>` still desugar", () => {
      const out = transformParabunToTS(`fun foo() { return p ..! err => 0 }`);
      expect(out).toContain("function foo()");
      expect(out).toContain(".catch(");
    });

    test("LYK-827: injects `declare const _: any` when `_` is used as expression-context lambda", () => {
      const out = transformParabunToTS(`const r = arr.filter(_ > 0);`);
      expect(out).toContain("declare const _: any");
    });

    test("LYK-827: does NOT inject when `_` is declared as a const", () => {
      const out = transformParabunToTS(`const _ = require("lodash"); const r = _.map(arr, x => x);`);
      expect(out).not.toContain("declare const _: any");
    });

    test("LYK-827: does NOT inject when `_` is declared as let/var", () => {
      const out = transformParabunToTS(`let _ = "placeholder"; arr.filter(x => x._);`);
      expect(out).not.toContain("declare const _: any");
    });

    test("LYK-827: does NOT inject when `_` is a function parameter", () => {
      const out = transformParabunToTS(`function ignore(_) { return null; }`);
      expect(out).not.toContain("declare const _: any");
    });

    test("LYK-827: does NOT inject when `_` is an import binding", () => {
      const out = transformParabunToTS(`import { _ } from "underscore"; const r = arr.map(x => _(x));`);
      expect(out).not.toContain("declare const _: any");
    });

    test("LYK-827: does NOT inject when source has no `_` at all", () => {
      const out = transformParabunToTS(`const r = arr.filter(x => x > 0);`);
      expect(out).not.toContain("declare const _: any");
    });
  });
});
