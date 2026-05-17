import { test, expect } from "bun:test";
import { signal } from "@lyku/para-signals";
import { lowerPuiReactivity } from "../../para-preprocess/src/index.ts";

// LYK-897 (A3): native modules expose status as bare para `Signal<T>`
// (llm `.busy`, camera `.fps`, audio `.active`, gpio `.value`, …). A3's
// question was whether a dedicated `track` keyword is needed. It is NOT:
// a para Signal structurally + behaviourally satisfies the `source`
// convention, so `source NAME = m.busy` already binds a native status
// signal into component reactivity. These tests lock that as a
// guaranteed contract (not an accident) so `source` stays the single
// keyword for "bind any native reactive thing — handle OR bare signal".

test("a para Signal satisfies the source convention structurally", () => {
  const s = signal(0);
  expect(typeof s.peek).toBe("function");
  expect(typeof s.subscribe).toBe("function");
  // no .dispose — the lowering's `onDestroy(() => __src.dispose?.())`
  // is optional-chained, so a signal source tears down as a no-op.
  expect((s as { dispose?: unknown }).dispose).toBeUndefined();
});

test("the source lowering pattern drives reactively off a bare signal", () => {
  // Exactly what `source busy = m.busy` lowers to at runtime.
  const m = { busy: signal(false) };
  const __src = m.busy;
  let busy = __src.peek?.() ?? __src;
  const unsub = __src.subscribe?.((v: boolean) => {
    busy = v;
  });
  expect(busy).toBe(false);
  m.busy.set(true);
  expect(busy).toBe(true);
  unsub?.(); // component unmount → $effect.pre teardown
  m.busy.set(false);
  expect(busy).toBe(true); // no longer observing after teardown
  expect(() => (__src as { dispose?: () => void }).dispose?.()).not.toThrow();
});

test("`source x = m.busy` lowers identically to any source decl", () => {
  const out = lowerPuiReactivity(
    `<script lang="ts">
source busy = m.busy;
</script>
<button disabled={busy}>go</button>`,
    "@lyku/para-ui",
    false,
    false,
  );
  expect(out).toContain(`const __src_busy = m.busy;`);
  expect(out).toContain(`let busy = $state(__src_busy.peek?.() ?? __src_busy);`);
  expect(out).toContain(`$effect.pre(() => __src_busy.subscribe?.((__v: typeof busy) => { busy = __v; }));`);
  expect(out).toContain(`onDestroy(() => __src_busy.dispose?.());`);
});
