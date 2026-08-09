import { test, expect } from "bun:test";
import { lowerPuiReactivity } from "../src/index.ts";

const lower = (s: string) => lowerPuiReactivity(s, "@lyku/para-ui", false, false);

test("sync NAME :: SCHEMA from query(...) → syncedOne inside the tracked bridge (§13.7)", () => {
  const out = lower(`<script lang="ts">
sync user :: User from query({ where: u => u.id == id });
</script>
<h1>{user?.name}</h1>`);
  expect(out).toContain(`let user = $state(undefined as any);`);
  expect(out).toContain(`const __sq_user = syncedOne(User, { where: u => u.id == id });`);
  // The bridge is ONE $effect.pre: construct → seed → subscribe → teardown.
  expect(out).toContain(`const __ss_user = __sq_user.peek?.();`);
  expect(out).toContain(`if (__ss_user !== undefined) user = __ss_user;`);
  expect(out).toContain(`__sq_user.subscribe?.((__v: typeof user) => { user = __v; })`);
  expect(out).toContain(`return () => { __un_user?.(); __sq_user.dispose?.(); };`);
  expect(out).toContain(`import { syncedOne } from "@lyku/para-sync";`);
  expect(out).not.toMatch(/sync user ::/);
  // Re-key + unmount ride the effect teardown, no construct-once onDestroy.
  expect(out).not.toContain(`onDestroy(() => __sq_user`);
});

test("the [] + query collection form still goes to syncedQuery, not syncedOne", () => {
  const out = lower(`<script lang="ts">
sync feed :: Post[] from query({ limit: 20 });
</script>`);
  expect(out).toContain(`syncedQuery(Post, { limit: 20 })`);
  expect(out).not.toContain("syncedOne");
});

test("the keyed form is untouched: query() only fires the scalar pass, keys stay evaluate-once", () => {
  const out = lower(`<script lang="ts">
sync user :: User from \`user:\${id}\`;
</script>`);
  expect(out).toContain("const __syn_user = synced(`user:${id}`, User);");
  expect(out).not.toContain("syncedOne");
});

test("scalar, collection, and keyed sync coexist; imports merge onto one line", () => {
  const out = lower(`<script lang="ts">
sync me :: User from query({ where: u => u.id == myId });
sync feed :: Post[] from query({ limit: 20 });
sync flags :: Flags from "flags:global";
</script>`);
  expect(out).toMatch(/import \{ synced, syncedQuery, syncedOne \} from "@lyku\/para-sync";/);
  expect(out).toContain(`syncedOne(User, { where: u => u.id == myId })`);
  expect(out).toContain(`syncedQuery(Post, { limit: 20 })`);
  expect(out).toContain(`synced("flags:global", Flags)`);
});

test("a string containing ')' inside the spec doesn't truncate the match", () => {
  const out = lower(`<script lang="ts">
sync user :: User from query({ where: u => u.tag == "a)b" });
</script>`);
  expect(out).toContain(`syncedOne(User, { where: u => u.tag == "a)b" })`);
});

test("multi-line query spec keeps its extent (matchParen scan)", () => {
  const out = lower(`<script lang="ts">
sync user :: User from query({
  where: u => u.id == id,
});
</script>`);
  expect(out).toContain(`syncedOne(User, {
  where: u => u.id == id,
})`);
});

test("member-expression schema annotation", () => {
  const out = lower(`<script lang="ts">
sync user :: schemas.User from query({ where: u => u.id == id });
</script>`);
  expect(out).toContain(`syncedOne(schemas.User, { where: u => u.id == id })`);
});
