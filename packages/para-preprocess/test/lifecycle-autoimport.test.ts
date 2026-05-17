import { test, expect } from "bun:test";
import { lowerPuiReactivity } from "../src/index.ts";

const lower = (s: string) => lowerPuiReactivity(s, "@lyku/para-ui", false, false);

// `mount` was retired as a keyword (2026-05-17). Lifecycle/navigation are
// plain Svelte/SvelteKit calls; .pui only removes the import boilerplate.

test("onMount(() => …) is a plain call, auto-imported from the runtime", () => {
  const out = lower(`<script lang="ts">
onMount(() => { console.log("up"); });
</script>`);
  expect(out).toContain(`import { onMount } from "@lyku/para-ui";`);
  expect(out).toContain(`onMount(() => { console.log("up"); })`);
});

test("`mount { … }` is NOT sugar anymore — left untouched (not lowered to onMount)", () => {
  const out = lower(`<script lang="ts">
mount { doStuff(); }
</script>`);
  expect(out).not.toContain(`onMount(`);
  expect(out).not.toContain(`import { onMount }`);
});

test("SvelteKit nav hooks auto-import from $app/navigation", () => {
  const out = lower(`<script lang="ts">
afterNavigate(() => track());
beforeNavigate((n) => maybeBlock(n));
</script>`);
  const navImp = out.match(/import \{ ([^}]*) \} from "\$app\/navigation";/);
  expect(navImp).not.toBeNull();
  const navNames = navImp![1]!.split(",").map(s => s.trim());
  expect(navNames).toContain("afterNavigate");
  expect(navNames).toContain("beforeNavigate");
  expect(out).not.toContain(`from "@lyku/para-ui"`); // nav hooks are NOT runtime imports
});

test("does not double-import when the user already imported it", () => {
  const out = lower(`<script lang="ts">
import { onMount } from "svelte";
onMount(() => init());
</script>`);
  // exactly one onMount import (the user's), no injected duplicate
  expect(out.match(/onMount/g)!.filter(Boolean)).toHaveLength(2); // import + call
  expect(out).not.toContain(`import { onMount } from "@lyku/para-ui";`);
});

test("member access / non-call usage does not trigger an import", () => {
  const out = lower(`<script lang="ts">
const x = lib.afterNavigate;
const y = "afterNavigate";
</script>`);
  expect(out).not.toContain(`from "$app/navigation"`);
});

test("effect is still a keyword (reactive primitive — unaffected by the mount retirement)", () => {
  const out = lower(`<script lang="ts">
effect syncThing();
</script>`);
  expect(out).toContain(`$effect(() => syncThing())`);
});
