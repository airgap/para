import { test, expect } from "bun:test";
import { lowerPuiReactivity } from "../src/index.ts";

const lower = (s: string) => lowerPuiReactivity(s, "@lyku/para-ui", false, false);

test("synced NAME = EXPR → reactive view + auto-dispose, imports onDestroy", () => {
  const out = lower(`<script lang="ts">
synced user = synced("user:123", { schema: User });
</script>
<div>{user.name}</div>`);
  expect(out).toContain(`import { onDestroy } from "@lyku/para-ui";`);
  expect(out).toContain(`const __syn_user = synced("user:123", { schema: User });`);
  expect(out).toContain(`let user = $state(__syn_user.peek?.() ?? __syn_user);`);
  expect(out).toContain(
    `$effect.pre(() => __syn_user.subscribe?.((__v: typeof user) => { user = __v; }));`
  );
  expect(out).toContain(`onDestroy(() => __syn_user.dispose?.());`);
  // the keyword line is gone; the inner synced(...) CALL survives intact
  expect(out).not.toMatch(/(^|\n)\s*synced user =/);
});

test("multi-line opts object is captured whole (the derivedInitEnd extent)", () => {
  const out = lower(`<script lang="ts">
synced user = synced("user:123", {
  schema: User,
  schemaVersion: "1.0",
  stream: () => api.streamCurrentUser(),
});
const after = 1;
</script>`);
  // the whole call — across newlines — lands in the backing const
  expect(out).toContain(`stream: () => api.streamCurrentUser(),`);
  expect(out).toContain(`}); let user = $state(__syn_user.peek?.() ?? __syn_user);`);
  // statement after the multi-line decl is preserved, not swallowed
  expect(out).toContain(`const after = 1;`);
});

test("the inner synced(...) call is not re-lowered as a keyword", () => {
  const out = lower(`<script lang="ts">
synced u = synced("k", { schema: S });
</script>`);
  // exactly one backing const — `synced(` (a call) never triggers the keyword
  expect(out.match(/__syn_/g)?.length).toBeGreaterThan(0);
  expect(out).not.toContain(`__syn_synced`);
  expect(out.match(/const __syn_u =/g)).toHaveLength(1);
});

test("synced NAME is read-only: assignments are NOT rewritten", () => {
  const out = lower(`<script lang="ts">
synced s = makeReplica();
s = somethingElse;
</script>`);
  expect(out).toContain(`s = somethingElse;`);
  expect(out).not.toContain(`__syn_s.set(`);
});

test("synced coexists with source + using; onDestroy imported once", () => {
  const out = lower(`<script lang="ts">
source cam = camera.open(dev);
synced user = synced("user:1", { schema: User });
using r = makeResource();
</script>`);
  const imp = out.match(/import \{ ([^}]*) \} from "@lyku\/para-ui";/);
  expect(imp).not.toBeNull();
  const names = imp![1]!.split(",").map((s) => s.trim());
  expect(names.filter((x) => x === "onDestroy")).toHaveLength(1);
  expect(out).toContain(`const __syn_user = synced("user:1", { schema: User });`);
  expect(out).toContain(`onDestroy(() => __syn_user.dispose?.());`);
});

test("no synced decl → no __syn_ / onDestroy injected by this path", () => {
  const out = lower(`<script lang="ts">
signal x = 1;
</script>`);
  expect(out).not.toContain("__syn_");
  expect(out).not.toContain("onDestroy");
});
