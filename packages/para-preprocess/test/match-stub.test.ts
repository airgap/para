import { test, expect } from "bun:test";
import { matchTypeStubSpans } from "../src/index.ts";

// `matchTypeStubSpans` is the single source for `.pui` (pui-transform)
// and the legacy `transformParabunToTS` non-`.pui` path. Applying the
// canonical stub must match the proven shipped shape
// `((__pm: any): any => null as any)(SUBJECT)`. These assertions ARE the
// drift guard against parabun-lsp.ts's `transformMatchBlock`.

function stub(src: string): string {
  const spans = matchTypeStubSpans(src);
  let out = "";
  let cursor = 0;
  for (const s of spans) {
    out += src.slice(cursor, s.start);
    out += `((__pm: any): any => null as any)(${s.subject})`;
    cursor = s.end;
  }
  out += src.slice(cursor);
  return out;
}

test("single-line match → subject-typed any stub", () => {
  expect(stub(`const r = match status { 200 => "ok", _ => "no" }`)).toBe(
    `const r = ((__pm: any): any => null as any)(status)`,
  );
});

test("multi-line match collapses; subject preserved verbatim", () => {
  const src = `const r = match getStatus() {\n  200 => "ok",\n  _ => "no"\n}`;
  expect(stub(src)).toBe(`const r = ((__pm: any): any => null as any)(getStatus())`);
});

test("match inside a function body (block-position) is found", () => {
  expect(stub(`function f(n){ return match n { 1 => "a", _ => "b" }; }`)).toBe(
    `function f(n){ return ((__pm: any): any => null as any)(n); }`,
  );
});

test("`match` as an identifier is left alone", () => {
  expect(stub(`const match = 42;\nconsole.log(match);`)).toBe(`const match = 42;\nconsole.log(match);`);
});

test("`match.foo` member access is left alone", () => {
  expect(stub(`const r = match.foo;`)).toBe(`const r = match.foo;`);
});

test("`match` inside a string is not rewritten", () => {
  expect(stub('const s = "match x { 1 => 2 }";')).toBe('const s = "match x { 1 => 2 }";');
});

test("nested match: outer span covers the whole expression (arms discarded)", () => {
  const src = `const r = match a { 1 => match b { 2 => "x", _ => "y" }, _ => "z" }`;
  // Outer brace-match swallows the inner match too — fine, arms are
  // discarded into the `any` stub anyway.
  expect(stub(src)).toBe(`const r = ((__pm: any): any => null as any)(a)`);
});

test("two sibling matches each get their own stub", () => {
  const src = `const a = match x { 1 => "o", _ => "?" }\nconst b = match y { 2 => "t", _ => "?" }`;
  expect(stub(src)).toBe(
    `const a = ((__pm: any): any => null as any)(x)\nconst b = ((__pm: any): any => null as any)(y)`,
  );
});

test("subject with member/call chain preserved", () => {
  expect(stub(`const r = match e.kind { 'click' => 1, _ => 0 }`)).toBe(
    `const r = ((__pm: any): any => null as any)(e.kind)`,
  );
});
