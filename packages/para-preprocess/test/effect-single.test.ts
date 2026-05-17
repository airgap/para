import { test, expect } from "bun:test";
import { lowerPuiReactivity } from "../src/index.ts";

const lower = (s: string) => lowerPuiReactivity(s, "@lyku/para-ui", false, false);

test("`effect EXPR;` → EXPRESSION-bodied $effect(() => EXPR) (implicit return / cleanup preserved)", () => {
  const out = lower(`<script lang="ts">
effect appSync.sync();
const x = 1;
</script>`);
  expect(out).toContain(`$effect(() => appSync.sync())`);
  expect(out).toContain(`const x = 1;`);
  expect(out).not.toContain("effect appSync");
  expect(out).not.toContain("$effect(() => {"); // not block-bodied
});

test("teardown-returning effect keeps its implicit return (the useKeybind case)", () => {
  const out = lower(`<script lang="ts">
effect useKeybind("nav.home", () => goto("/"));
</script>`);
  expect(out).toContain(`$effect(() => useKeybind("nav.home", () => goto("/")))`);
});

test("multi-line single-statement body captured whole", () => {
  const out = lower(`<script lang="ts">
effect store.sync(n)
  ? a()
  : b();
const y = 1;
</script>`);
  expect(out).toContain(`$effect(() => store.sync(n)`);
  expect(out).toContain("? a()");
  expect(out).toContain(": b()");
  expect(out).toContain("const y = 1;");
});

test("disambiguation: effect( / effect.x / effect= stay plain identifiers", () => {
  const out = lower(`<script lang="ts">
effect();
effect.foo();
effect = makeEffect();
</script>`);
  expect(out).toContain("effect();");
  expect(out).toContain("effect.foo();");
  expect(out).toContain("effect = makeEffect();");
  expect(out).not.toContain("$effect(() => { effect");
});

test("block form still lowers (regression)", () => {
  const out = lower(`<script lang="ts">
effect { a(); b(); }
</script>`);
  expect(out).toContain(`$effect(() => { a(); b(); })`);
});
