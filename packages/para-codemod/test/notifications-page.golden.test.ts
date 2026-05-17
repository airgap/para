import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { svelteToPui } from "../src/index.ts";
import { lowerPuiReactivity } from "../../para-preprocess/src/index.ts";

// Golden test: the real Lyku component the C4 precursor hand-mapped.
// The .svelte source is vendored as a frozen fixture (NOT read from the
// sibling /raid/lyku checkout) so the test is hermetic — para's CI does
// not check out lyku. Refresh it deliberately if the codemod contract
// changes, the same way you'd update any golden.
const SRC = fileURLToPath(new URL("./fixtures/NotificationsPage.svelte", import.meta.url));
const original = readFileSync(SRC, "utf8");
const { code, notes } = svelteToPui(original);

test("rule 1/2 — $state → signal (typed, generic, uninitialized)", () => {
  expect(code).toContain("signal activeCategory: CategoryFilter = 'all';");
  expect(code).toContain("signal loading = true;");
  expect(code).toContain("signal offset = 0;");
  expect(code).toContain("signal deletingIds = new Set<bigint>();");
  // uninitialized $state() for bind:this — synthesized `= undefined`
  expect(code).toContain("signal listEl: HTMLDivElement | undefined = undefined;");
  expect(code).not.toContain("$state(");
});

test("rule 3 — single-line + multi-line + object $derived", () => {
  expect(code).toContain("derived currentUser = stores.users.get(-1n);"); // single-line
  expect(code).toContain("derived allNotifications {"); // multi-line chained → block
  expect(code).toContain("derived filteredNotifications {"); // multi-line ternary → block
  expect(code).toContain("derived unreadCounts {"); // multi-line object literal → block
  expect(code).not.toMatch(/\$derived\b/);
});

test("rule 4 — $derived($store) → source + fromStore import", () => {
  expect(code).toContain("source phrasebook = fromStore(phrasebookStore);");
  expect(code).toContain('import { fromStore } from "@lyku/para-signals";');
});

test("rule 5 — $effect → effect block; onMount left verbatim (keyword retired)", () => {
  // `mount` was retired 2026-05-17: it mapped to onMount(), a library
  // call, not a Para primitive. The codemod no longer converts it — the
  // onMount call survives verbatim and lowerPuiReactivity auto-imports it.
  expect(code).toContain("effect {");
  expect(code).toMatch(/\bonMount\s*\(\s*\(\)\s*=>\s*\{/);
  expect(code).not.toMatch(/\bmount\s*\{/);
  expect(code).not.toMatch(/\$effect\s*\(/);
});

test("rule 6 — onMount dropped from svelte import (lowering auto-imports it), untrack kept", () => {
  expect(code).toMatch(/import\s*\{\s*untrack\s*\}\s*from\s*['"]svelte['"]/);
  expect(code).not.toMatch(/import\s*\{[^}]*onMount[^}]*\}\s*from\s*['"]svelte['"]/);
});

test("non-reactive code + template are byte-preserved", () => {
  // a representative non-reactive const survives verbatim
  expect(code).toContain("const CATEGORY_MAP: Record<CategoryFilter, string[]> = {");
  expect(code).toContain("function formatTime(posted: Date) {");
  // markup after </script> is identical (preprocess only touches <script>)
  const tail = (s: string) => s.slice(s.lastIndexOf("</script>"));
  expect(tail(code)).toBe(tail(original));
});

test("ROUND-TRIP: codemod output lowers cleanly through lowerPuiReactivity", () => {
  // The strongest correctness gate: the .pui the codemod emits must be
  // valid Para that the real build-path lowering accepts and turns back
  // into the expected Svelte 5 constructs.
  let lowered = "";
  expect(() => {
    lowered = lowerPuiReactivity(code, "@lyku/para-ui", false, false);
  }).not.toThrow();
  expect(lowered).toContain("$state("); // signals lowered
  expect(lowered).toContain("$derived"); // derived (=/.by) lowered
  expect(lowered).toContain("onMount(() => {"); // mount block lowered
  expect(lowered).toContain("$effect(() => {"); // effect block lowered
  expect(lowered).toContain("__src_phrasebook"); // source(fromStore) bridge
  expect(lowered).toContain("onDestroy(() => __src_phrasebook.dispose?.());");
});

test("notes record what converted (audit trail)", () => {
  expect(notes.some(n => n.startsWith("rule4"))).toBe(true);
  expect(notes.some(n => n.startsWith("rule3b"))).toBe(true);
  expect(notes.some(n => n.startsWith("rule5"))).toBe(true);
  expect(notes).toContain("dropped `onMount` from the svelte import (lowering auto-imports it)");
});
