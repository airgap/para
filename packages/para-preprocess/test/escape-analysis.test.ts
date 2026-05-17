import { test, expect } from "bun:test";
import { lowerPuiReactivity } from "../src/index.ts";

const lower = (s: string, hmr = false) => lowerPuiReactivity(s, "@lyku/para-ui", false, hmr);

test("provably-local signal → $state-only, no para bridge, no import", () => {
  const out = lower(`<script lang="ts">
signal count = 0;
count = count + 1;
</script>
<button onclick={() => count++}>{count}</button>`);
  expect(out).toContain(`let count = $state(0);`);
  expect(out).not.toContain("__sig_count");
  expect(out).not.toContain("@lyku/para-signals");
  // plain assignment stays native $state (not rewritten to .set())
  expect(out).toContain(`count = count + 1;`);
});

test("signal observed via signalOf → keeps the bridge form + import", () => {
  const out = lower(`<script lang="ts">
signal shared = 0;
const s = signalOf(shared);
</script>`);
  expect(out).toContain(`import { signal } from "@lyku/para-signals";`);
  expect(out).toContain(`const __sig_shared = signal(0);`);
  expect(out).toContain(`$state(__sig_shared.peek())`);
});

test("per-name signalOf precision: only the signalOf'd name bridges", () => {
  const out = lower(`<script lang="ts">
signal a = 1;
signal b = 2;
const x = signalOf(a);
</script>`);
  // a is signalOf'd → bridge; b is purely local → inlined (hardening:
  // the old coarse file-level gate would have bridged both).
  expect(out).toContain(`const __sig_a = signal(1);`);
  expect(out).toContain(`let b = $state(2);`);
  expect(out).not.toContain(`__sig_b`);
});

test("alias chain into signalOf still forces the bridge (correctness)", () => {
  const out = lower(`<script lang="ts">
signal x = 0;
const y = x;
const h = signalOf(y);
</script>`);
  // y is signalOf'd and y aliases x → x must keep the bridge.
  expect(out).toContain(`const __sig_x = signal(0);`);
  expect(out).not.toContain(`let x = $state(0);`);
});

test("untraceable signalOf arg → conservative coarse fallback (all bridge)", () => {
  const out = lower(`<script lang="ts">
signal a = 1;
signal b = 2;
const h = signalOf(getCell());
</script>`);
  // signalOf(<expr>) can't be resolved to a name → keep the proven
  // bridge for every signal (no false inline).
  expect(out).toContain(`const __sig_a = signal(1);`);
  expect(out).toContain(`const __sig_b = signal(2);`);
});

test("signal flowing into provide/context → keeps the bridge", () => {
  const out = lower(`<script lang="ts">
signal theme = "dark";
provide theme = theme;
</script>`);
  expect(out).toContain(`const __sig_theme = signal("dark");`);
  expect(out).not.toContain(`let theme = $state("dark");`);
});

test("exported signal → keeps the bridge", () => {
  const out = lower(`<script lang="ts">
signal n = 0;
export { n };
</script>`);
  expect(out).toContain(`const __sig_n = signal(0);`);
});

test("mixed: local inlined, escaping bridged, in one component", () => {
  const out = lower(`<script lang="ts">
signal local = 0;
signal exposed = 1;
const h = signalOf(exposed);
</script>`);
  // Hardened: only `exposed` (signalOf'd) bridges; `local` inlines.
  expect(out).toContain(`let local = $state(0);`);
  expect(out).not.toContain(`__sig_local`);
  expect(out).toContain(`const __sig_exposed = signal(1);`);
});

test("local signal still HMR-irrelevant: hmr=true doesn't bridge a local cell", () => {
  const out = lower(
    `<script lang="ts">
signal count = 0;
</script>`,
    true,
  );
  // No para signal → nothing for the HMR registry to preserve; plain $state.
  expect(out).toContain(`let count = $state(0);`);
  expect(out).not.toContain("hmrSignal");
  expect(out).not.toContain("__sig_count");
});

test("escaping signal under hmr=true still gets the registry bridge", () => {
  const out = lower(
    `<script lang="ts">
signal shared = 0;
const s = signalOf(shared);
</script>`,
    true,
  );
  expect(out).toContain(`import { signal, hmrSignal } from "@lyku/para-signals";`);
  expect(out).toContain(`hmrSignal(import.meta.url + "::shared", () => signal(0))`);
});
