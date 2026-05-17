import { test, expect } from "bun:test";
import { safeMigrate } from "../src/index.ts";

// Deterministic invariant test with injected compile/lower stubs — does
// NOT depend on a specific real codemod bug staying a bug.

const okCompile = (s: string) => {
  if (s.includes("__BOOM__")) throw new Error("synthetic compile error");
  return {};
};

test("INVARIANT: if migration would regress, original is returned UNCHANGED", () => {
  const src = `<script lang="ts">\nlet x = $state(1);\n</script>\n<p>{x}</p>`;
  // baseline (src) has no __BOOM__ → compiles. The lower stub injects
  // __BOOM__ → migrated "fails to compile" → must be rejected.
  const r = safeMigrate(src, okCompile, code => "__BOOM__" + code);
  expect(r.migrated).toBe(false);
  expect(r.code).toBe(src); // byte-identical original
  expect(r.skippedReason).toMatch(/would regress/);
});

test("happy path: migrated output emitted when it compiles", () => {
  const src = `<script lang="ts">\nlet x = $state(1);\n</script>\n<p>{x}</p>`;
  const r = safeMigrate(src, okCompile, code => code /* passthrough lower */);
  expect(r.migrated).toBe(true);
  expect(r.code).toContain("signal x = 1;");
  expect(r.code).not.toBe(src);
});

test("no-op: nothing transformable → unchanged, migrated=false, no skip reason", () => {
  const src = `<script lang="ts">\nconst CONSTANT = 42;\n</script>\n<p>hi</p>`;
  const r = safeMigrate(src, okCompile, code => code);
  expect(r.migrated).toBe(false);
  expect(r.code).toBe(src);
  expect(r.skippedReason).toBeUndefined();
});

test("pre-existing failure is NOT counted as a regression (still migrated)", () => {
  // original already fails to compile (contains __BOOM__); migration
  // doesn't introduce the failure → not rejected on regression grounds.
  const src = `<script lang="ts">\nlet x = $state(1); // __BOOM__\n</script>`;
  const r = safeMigrate(src, okCompile, code => code);
  expect(r.migrated).toBe(true); // baseline already broken → migration allowed
});

test("real fork compile + lower: a clean component round-trips migrated", async () => {
  const { compile } = await import("../../para-svelte/packages/svelte/src/compiler/index.js");
  const { lowerPuiReactivity } = await import("../../para-preprocess/src/index.ts");
  const src = `<script lang="ts">\nlet count = $state(0);\nconst dbl = $derived(count * 2);\n</script>\n<button onclick={() => count++}>{dbl}</button>`;
  const r = safeMigrate(src, compile as never, lowerPuiReactivity);
  expect(r.migrated).toBe(true);
  expect(r.code).toContain("signal count = 0;");
  expect(r.code).toContain("derived dbl = count * 2;");
});
