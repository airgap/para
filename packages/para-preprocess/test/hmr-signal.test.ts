import { test, expect } from "bun:test";
import { lowerPuiReactivity } from "../src/index.ts";
import { signal, hmrSignal } from "../../para-signals/src/index.js";

// `count` is exported → it escapes the component, so it keeps the para
// bridge (and thus the HMR registry form). LYK-886 only inlines provably
// component-local signals to plain `$state`; HMR identity-preservation is
// meaningless for those (a local cell resetting on reload is normal
// component-state behavior, exactly like Svelte's own `$state`).
const SRC = `<script lang="ts">
signal count = 0;
export { count };
</script>
<button>{count}</button>`;

test("hmr=false is byte-identical to the pre-F2.2 bridge form", () => {
  expect(lowerPuiReactivity(SRC, "@lyku/para-ui", false, false)).toBe(
    `import { signal } from "@lyku/para-signals";\n` +
      `<script lang="ts">\n` +
      `const __sig_count = signal(0); let count = $state(__sig_count.peek()); ` +
      `$effect.pre(() => __sig_count.subscribe((__v: typeof count) => { count = __v; }));\n` +
      `export { count };\n` +
      `</script>\n` +
      `<button>{count}</button>`,
  );
});

test("hmr=true emits the import.meta.hot-gated registry form + hmrSignal import", () => {
  const dev = lowerPuiReactivity(SRC, "@lyku/para-ui", false, true);
  expect(dev).toContain(`import { signal, hmrSignal } from "@lyku/para-signals";`);
  expect(dev).toContain(
    `const __sig_count = (import.meta.hot ? hmrSignal(import.meta.url + "::count", () => signal(0)) : signal(0));`,
  );
  // The $state / $effect.pre tail is unchanged from the non-HMR form.
  expect(dev).toContain(
    `let count = $state(__sig_count.peek()); $effect.pre(() => __sig_count.subscribe((__v: typeof count) => { count = __v; }));`,
  );
});

test("hmr form is a single line (line count unchanged)", () => {
  const dev = lowerPuiReactivity(SRC, "@lyku/para-ui", false, true);
  // import (own line, linePreserving=false) + 5 source lines.
  expect(dev.split("\n")).toHaveLength(6);
});

test("hmrSignal preserves identity, value and subscribers across a module re-eval", () => {
  const KEY = "file:///App.pui::count";
  const moduleEval = () => hmrSignal(KEY, () => signal(0));

  const first = moduleEval();
  first.set(42);

  const afterHmr = moduleEval(); // module re-evaluated by vite HMR
  expect(afterHmr).toBe(first); // same instance — identity preserved
  expect(afterHmr.peek()).toBe(42); // value survived (not reset to 0)

  let seen: number | undefined;
  const unsub = first.subscribe(v => {
    seen = v;
  });
  const afterHmr2 = moduleEval();
  afterHmr2.set(99);
  expect(seen).toBe(99); // subscriber registered before HMR still fires
  unsub();
});

test("hmrSignal initializes a fresh key from its factory", () => {
  const s = hmrSignal("file:///Other.pui::x", () => signal(7));
  expect(s.peek()).toBe(7);
});
