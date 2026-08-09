import { test, expect } from "bun:test";
import { lowerPuiReactivity } from "../src/index.ts";

const lower = (s: string) => lowerPuiReactivity(s, "@lyku/para-ui", false, false);

test("derived NAME :: SCHEMA = EXPR → querySignal bridge inside one $effect.pre (§10.7)", () => {
  const out = lower(`<script lang="ts">
derived user :: User = graphql.userById(id);
</script>
<h1>{user.data?.name}</h1>`);
  expect(out).toContain(`let user = $state({ data: undefined, error: undefined, pending: true });`);
  expect(out).toContain(`let __qdv_user;`);
  expect(out).toContain(`const __qd_user = querySignal(() => (graphql.userById(id)), User, { prev: __qdv_user });`);
  // SWR seed + shadow update on every settle.
  expect(out).toContain(`if (__sd_user !== undefined) { __qdv_user = __sd_user; user = __sd_user; }`);
  expect(out).toContain(`__qd_user.subscribe?.((__v: typeof user) => { __qdv_user = __v; user = __v; })`);
  // Cleanup path is the $effect.pre teardown: re-key AND unmount.
  expect(out).toContain(`return () => { __un_user?.(); __qd_user.dispose?.(); };`);
  expect(out).toContain(`import { querySignal } from "@lyku/para-signals";`);
  expect(out).not.toMatch(/derived user ::/);
  // No onDestroy needed: the effect teardown covers unmount.
  expect(out).not.toContain(`onDestroy(() => __qd_user`);
});

test("plain derived NAME = EXPR is untouched (still $derived)", () => {
  const out = lower(`<script lang="ts">
derived total = price * qty;
</script>`);
  expect(out).toContain(`const total = $derived(price * qty);`);
  expect(out).not.toContain("querySignal");
});

test("single-colon TS annotation stays with the plain derived pass (no gate)", () => {
  const out = lower(`<script lang="ts">
derived total: number = price * qty;
</script>`);
  expect(out).toContain(`const total = $derived(price * qty);`);
  expect(out).not.toContain("querySignal");
});

test("gated and plain derived coexist; each consumed by exactly one pass", () => {
  const out = lower(`<script lang="ts">
derived user :: User = api.user(id);
derived greeting = "hi " + (user.data?.name ?? "there");
</script>`);
  expect(out).toContain(`querySignal(() => (api.user(id)), User, { prev: __qdv_user })`);
  expect(out).toContain(`const greeting = $derived("hi " + (user.data?.name ?? "there"));`);
});

test("multi-line initializer extent (derivedInitEnd continuation scan)", () => {
  const out = lower(`<script lang="ts">
derived report :: Report = api.report({
  org: orgId,
  window: "30d",
});
</script>`);
  expect(out).toContain(`querySignal(() => (api.report({
  org: orgId,
  window: "30d",
})), Report, { prev: __qdv_report })`);
});

test("member-expression schema annotation", () => {
  const out = lower(`<script lang="ts">
derived user :: schemas.User = api.user(id);
</script>`);
  expect(out).toContain(`querySignal(() => (api.user(id)), schemas.User, { prev: __qdv_user })`);
});

test("querySignal import dedups against a hand-authored para-signals import", () => {
  const out = lower(`<script lang="ts">
import { querySignal } from "@lyku/para-signals";
derived user :: User = api.user(id);
</script>`);
  expect(out.match(/from "@lyku\/para-signals"/g)).toHaveLength(1);
});

test("derived block form is untouched by the query pass", () => {
  const out = lower(`<script lang="ts">
derived grouped {
  const rows = items.filter(i => i.on);
  return rows;
}
</script>`);
  expect(out).toContain(`const grouped = $derived.by(() => {`);
  expect(out).not.toContain("querySignal");
});
