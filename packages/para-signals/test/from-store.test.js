import { test, expect } from "bun:test";
import { fromStore } from "../src/index.js";

// Minimal Svelte writable-store contract: subscribe fires the current
// value synchronously, then on every set; returns an unsubscribe.
function writable(initial) {
  let value = initial;
  const subs = new Set();
  return {
    set(v) {
      value = v;
      for (const s of subs) s(v);
    },
    subscribe(run) {
      subs.add(run);
      run(value);
      return () => subs.delete(run);
    },
    _subCount: () => subs.size,
  };
}

test("fromStore conforms to the source convention", () => {
  const a = fromStore(writable(1));
  expect(typeof a.peek).toBe("function");
  expect(typeof a.subscribe).toBe("function");
  expect(typeof a.dispose).toBe("function");
});

test("peek reads the store's current value (and leaves no subscription)", () => {
  const s = writable("hi");
  const a = fromStore(s);
  expect(a.peek()).toBe("hi");
  s.set("bye");
  expect(a.peek()).toBe("bye");
  expect(s._subCount()).toBe(0); // transient: peek subscribed then unsubscribed
});

test("subscribe gets current value immediately + updates; unsub stops them", () => {
  const s = writable(0);
  const a = fromStore(s);
  const seen = [];
  const unsub = a.subscribe(v => seen.push(v));
  expect(seen).toEqual([0]); // Svelte stores fire current value synchronously
  s.set(1);
  s.set(2);
  expect(seen).toEqual([0, 1, 2]);
  unsub();
  expect(s._subCount()).toBe(0);
  s.set(3);
  expect(seen).toEqual([0, 1, 2]); // no longer observing
});

test("integrates with the `source` lowering pattern (no leak)", () => {
  // Exactly what `source x = fromStore(store)` runs at runtime.
  const s = writable("a");
  const __src = fromStore(s);
  let x = __src.peek?.() ?? __src;
  const teardown = __src.subscribe?.(v => {
    x = v;
  });
  expect(x).toBe("a");
  s.set("b");
  expect(x).toBe("b");
  teardown(); // $effect.pre cleanup on unmount
  __src.dispose?.(); // onDestroy — no-op
  s.set("c");
  expect(x).toBe("b"); // unmounted: stale-free
  expect(s._subCount()).toBe(0);
});
