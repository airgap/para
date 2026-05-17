import { test, expect } from "bun:test";
import { lowerPuiReactivity, splitDeclarators, parseDeclarator } from "../src/index.ts";
import { _puiLoweredCode } from "../../../editors/lsp/pui-transform.ts";

const lower = (s: string) => lowerPuiReactivity(s, "@lyku/para-ui", false, false);

// ── splitDeclarators: top-level comma only ──
test("splitDeclarators: plain list", () => {
  expect(splitDeclarators("a = 1, b = 2")).toEqual(["a = 1", "b = 2"]);
});
test("splitDeclarators: comma inside generic type args is protected", () => {
  expect(splitDeclarators("m: Record<string, number> = {}, n = 1")).toEqual([
    "m: Record<string, number> = {}",
    "n = 1",
  ]);
});
test("splitDeclarators: comma inside object / array / arrow defaults protected", () => {
  expect(splitDeclarators("o = { a: 1, b: 2 }, p = [1, 2], q = (e, i) => e + i")).toEqual([
    "o = { a: 1, b: 2 }",
    "p = [1, 2]",
    "q = (e, i) => e + i",
  ]);
});
test("splitDeclarators: nested generics", () => {
  expect(splitDeclarators("x: Map<string, Array<[number, string]>> = new Map(), y = 0")).toEqual([
    "x: Map<string, Array<[number, string]>> = new Map()",
    "y = 0",
  ]);
});
test("splitDeclarators: single declarator unchanged", () => {
  expect(splitDeclarators("foo: string = ''")).toEqual(["foo: string = ''"]);
});

// ── parseDeclarator: name / :type / =default boundary ──
test("parseDeclarator: annotated + default", () => {
  expect(parseDeclarator("foo: string = 'x'")).toEqual({ name: "foo", type: "string", default: "'x'" });
});
test("parseDeclarator: inferred default", () => {
  expect(parseDeclarator("bar = 3")).toEqual({ name: "bar", type: undefined, default: "3" });
});
test("parseDeclarator: annotated, no default", () => {
  expect(parseDeclarator("baz: number")).toEqual({ name: "baz", type: "number", default: undefined });
});
test("parseDeclarator: arrow default not split at =>", () => {
  expect(parseDeclarator("cb: (n: number) => void = (n) => {}")).toEqual({
    name: "cb",
    type: "(n: number) => void",
    default: "(n) => {}",
  });
});
test("parseDeclarator: comparison/strict-eq inside default not treated as boundary", () => {
  expect(parseDeclarator("flag = (a >= b)")).toEqual({ name: "flag", type: undefined, default: "(a >= b)" });
});

// ── prop: multi-declarator folds into ONE $props() ──
test("prop: multi-declarator merges into single $props() destructure", () => {
  const out = lower(`<script lang="ts">
prop foo: string = '', bar = 3;
</script>
<b>{foo}{bar}</b>`);
  expect(out).toContain(`let { foo = '', bar = 3 }: { foo?: string; bar?: any } = $props();`);
  expect(out).not.toContain("prop foo");
  expect((out.match(/\$props\(\)/g) ?? []).length).toBe(1);
});

test("prop: multi-declarator across two statements still ONE $props()", () => {
  const out = lower(`<script lang="ts">
prop a: number, b = 2;
prop c: string = 'z';
</script>`);
  expect(out).toContain(`let { a, b = 2, c = 'z' }: { a: number; b?: any; c?: string } = $props();`);
  expect((out.match(/\$props\(\)/g) ?? []).length).toBe(1);
  // line count preserved (second prop statement blanked, not removed)
  expect(out.split("\n").length).toBe(
    `<script lang="ts">\nprop a: number, b = 2;\nprop c: string = 'z';\n</script>`.split("\n").length,
  );
});

test("prop: generic-typed declarator with following declarator", () => {
  const out = lower(`<script lang="ts">
prop opts: Record<string, number> = {}, label = 'hi';
</script>`);
  expect(out).toContain(`let { opts = {}, label = 'hi' }: { opts?: Record<string, number>; label?: any } = $props();`);
});

// ── signal: multi-declarator → per-name cells on one line ──
test("signal: multi-declarator, all component-local → $state each", () => {
  const out = lower(`<script lang="ts">
signal a = 1, b = 2;
</script>
<b>{a}{b}</b>`);
  expect(out).toContain(`let a = $state(1); let b = $state(2);`);
  expect(out).not.toContain("signal a");
});

test("signal: line count preserved (single source line)", () => {
  const src = `<script lang="ts">\nsignal x = 0, y = 0;\n</script>\n<i>{x}{y}</i>`;
  const out = lower(src);
  expect(out.split("\n").length).toBe(src.split("\n").length);
});

test("signal: comma inside initializer is not a declarator boundary", () => {
  const out = lower(`<script lang="ts">
signal pair = [1, 2], label = 'p';
</script>
<b>{label}</b>`);
  expect(out).toContain(`let pair = $state([1, 2]); let label = $state('p');`);
});

// ── editor↔build parity on multi-declarator (hmr=false) ──
test("parity: pui-transform output matches lowerPuiReactivity for multi-declarator", () => {
  for (const body of [
    `prop foo: string = '', bar = 3;`,
    `signal a = 1, b = 2;`,
    `prop opts: Record<string, number> = {}, n = 0;\nsignal p = [1, 2], q = 9;`,
  ]) {
    const src = `<script lang="ts">\n${body}\n</script>\n<b>x</b>`;
    expect(_puiLoweredCode(src, "x.pui")).toBe(lower(src));
  }
});
