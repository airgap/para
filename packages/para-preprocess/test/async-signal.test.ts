import { test, expect } from "bun:test";
import { lowerPuiReactivity } from "../src/index.ts";

const lower = (s: string) => lowerPuiReactivity(s, "@lyku/para-ui", false, false);

test("async signal NAME = EXPR → promiseSignal source bridge + dispose", () => {
  const out = lower(`<script lang="ts">
async signal user = api.getUser(id);
</script>
{#if user.pending}…{:else if user.error}err{:else}{user.data}{/if}`);
  expect(out).toContain(`const __as_user = promiseSignal(() => (api.getUser(id)));`);
  expect(out).toContain(`let user = $state(__as_user.peek?.() ?? __as_user);`);
  expect(out).toContain(`$effect.pre(() => __as_user.subscribe?.((__v: typeof user) => { user = __v; }));`);
  expect(out).toContain(`onDestroy(() => __as_user.dispose?.());`);
  expect(out).toContain(`import { promiseSignal } from "@lyku/para-signals";`);
  expect(out).toContain(`import { onDestroy } from "@lyku/para-ui";`);
});

test("async signal does NOT get matched by the plain signal lowering", () => {
  const out = lower(`<script lang="ts">
async signal x = fetch(u);
</script>`);
  expect(out).not.toContain("__sig_x");
  expect(out).toContain("__as_x");
});

test("async signal decl is a single line (2 own-line imports + 4 src)", () => {
  const src = `<script lang="ts">
async signal d = load();
</script>
<p>{d.pending}</p>`;
  // own-line imports: para-ui onDestroy + para-signals promiseSignal (2)
  // + the 4 source lines; the decl itself is one line.
  const lines = lower(src).split("\n");
  expect(lines).toHaveLength(6);
  expect(lines.filter(l => l.includes("__as_d"))).toHaveLength(1);
});

test("async signal NAME is read-only: assignments not rewritten", () => {
  const out = lower(`<script lang="ts">
async signal r = q();
r = whatever;
</script>`);
  expect(out).toContain(`r = whatever;`);
  expect(out).not.toContain(`__as_r.set(`);
});

test("para-signals import merges signal + promiseSignal in deterministic order", () => {
  const out = lower(`<script lang="ts">
signal n = 0;
const h = signalOf(n);
async signal a = go();
</script>`);
  // n escapes (signalOf) → signal import; async → promiseSignal. One line, ordered.
  expect(out).toContain(`import { signal, promiseSignal } from "@lyku/para-signals";`);
});

test("async signal only → promiseSignal import without signal", () => {
  const out = lower(`<script lang="ts">
async signal a = go();
</script>`);
  expect(out).toContain(`import { promiseSignal } from "@lyku/para-signals";`);
  expect(out).not.toContain(`import { signal`);
});
