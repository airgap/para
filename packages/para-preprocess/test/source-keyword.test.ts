import { test, expect } from "bun:test";
import { lowerPuiReactivity } from "../src/index.ts";

const lower = (s: string) => lowerPuiReactivity(s, "@lyku/para-ui", false, false);

test("source NAME = EXPR → reactive view + auto-dispose, imports onDestroy", () => {
  const out = lower(`<script lang="ts">
source meter = audioMeter();
</script>
<div>{meter}</div>`);
  expect(out).toContain(`import { onDestroy } from "@lyku/para-ui";`);
  expect(out).toContain(`const __src_meter = audioMeter();`);
  expect(out).toContain(`let meter = $state(__src_meter.peek?.() ?? __src_meter);`);
  expect(out).toContain(`$effect.pre(() => __src_meter.subscribe?.((__v: typeof meter) => { meter = __v; }));`);
  expect(out).toContain(`onDestroy(() => __src_meter.dispose?.());`);
});

test("source is a single line (line count unchanged)", () => {
  const src = `<script lang="ts">
source cam = camera.open(dev);
</script>
<video>{cam}</video>`;
  // import own-line (linePreserving=false) + 4 source lines = 5
  expect(lower(src).split("\n")).toHaveLength(5);
});

test("source coexists with signal, using, plain onMount() call; onDestroy deduped + onMount auto-imported", () => {
  const out = lower(`<script lang="ts">
signal n = 0;
source cam = camera.open(dev);
using r = makeResource();
onMount(() => { n = 1; });
</script>`);
  // onDestroy appears once in the import despite using + source both needing it
  const imp = out.match(/import \{ ([^}]*) \} from "@lyku\/para-ui";/);
  expect(imp).not.toBeNull();
  const names = imp![1]!.split(",").map(s => s.trim());
  expect(names.filter(x => x === "onDestroy")).toHaveLength(1);
  // onMount is a plain call now (mount keyword retired). Auto-imported.
  expect(names).toContain("onMount");
  expect(out).toContain(`const __src_cam = camera.open(dev);`);
  expect(out).toContain(`onDestroy(() => __src_cam.dispose?.());`);
  // n is local (no signalOf/export/provide) → inlined, not bridged
  expect(out).toContain(`let n = $state(0);`);
});

test("source NAME is read-only: assignments are NOT rewritten", () => {
  const out = lower(`<script lang="ts">
source s = sensor();
s = somethingElse;
</script>`);
  // unlike signal, no __src_s.set() rewrite: plain passthrough
  expect(out).toContain(`s = somethingElse;`);
  expect(out).not.toContain(`__src_s.set(`);
});

test("no source decl → no onDestroy injected by source path", () => {
  const out = lower(`<script lang="ts">
signal x = 1;
</script>`);
  expect(out).not.toContain("__src_");
  expect(out).not.toContain("onDestroy");
});
