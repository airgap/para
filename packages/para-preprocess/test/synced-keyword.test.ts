import { test, expect } from "bun:test";
import { lowerPuiReactivity } from "../src/index.ts";

const lower = (s: string) => lowerPuiReactivity(s, "@lyku/para-ui", false, false);

test("synced NAME = ARGS → wraps synced(ARGS) + reactive view + auto-dispose", () => {
  const out = lower(`<script lang="ts">
synced user = "user:123", { schema: User };
</script>
<div>{user?.name}</div>`);
  // ARGS wrapped in synced(...) — no redundant inner synced( at the call site
  expect(out).toContain(`const __syn_user = synced("user:123", { schema: User });`);
  expect(out).toContain(`let user = $state(__syn_user.peek?.() ?? __syn_user);`);
  expect(out).toContain(
    `$effect.pre(() => __syn_user.subscribe?.((__v: typeof user) => { user = __v; }));`
  );
  expect(out).toContain(`onDestroy(() => __syn_user.dispose?.());`);
  expect(out).not.toMatch(/(^|\n)\s*synced user =/);
});

test("auto-imports synced from @lyku/para-sync (and onDestroy)", () => {
  const out = lower(`<script lang="ts">
synced user = "user:1", { schema: User };
</script>`);
  expect(out).toContain(`import { synced } from "@lyku/para-sync";`);
  expect(out).toContain(`import { onDestroy } from "@lyku/para-ui";`);
});

test("a hand-authored synced import is not duplicated", () => {
  const out = lower(`<script lang="ts">
import { synced } from "@lyku/para-sync";
synced user = "user:1", { schema: User };
</script>`);
  expect(out.match(/from "@lyku\/para-sync"/g)).toHaveLength(1);
});

test("multi-line opts captured whole (key + opts across newlines)", () => {
  const out = lower(`<script lang="ts">
synced user = \`user:\${id}\`, {
  schema: User,
  schemaVersion: "1.0",
  stream: () => api.streamUser(id),
};
const after = 1;
</script>`);
  expect(out).toContain("const __syn_user = synced(`user:${id}`, {");
  expect(out).toContain(`stream: () => api.streamUser(id),`);
  expect(out).toContain(`}); let user = $state(__syn_user.peek?.() ?? __syn_user);`);
  expect(out).toContain(`const after = 1;`); // statement after is preserved
});

test("synced NAME is read-only: assignments are NOT rewritten", () => {
  const out = lower(`<script lang="ts">
synced s = "k", { schema: S };
s = somethingElse;
</script>`);
  expect(out).toContain(`s = somethingElse;`);
  expect(out).not.toContain(`__syn_s.set(`);
});

test("synced coexists with source + using; onDestroy imported once", () => {
  const out = lower(`<script lang="ts">
source cam = camera.open(dev);
synced user = "user:1", { schema: User };
using r = makeResource();
</script>`);
  const imp = out.match(/import \{ ([^}]*) \} from "@lyku\/para-ui";/);
  expect(imp).not.toBeNull();
  const names = imp![1]!.split(",").map((s) => s.trim());
  expect(names.filter((x) => x === "onDestroy")).toHaveLength(1);
  expect(out).toContain(`const __syn_user = synced("user:1", { schema: User });`);
});

test("sync NAME :: SCHEMA from KEY → synced(KEY, SCHEMA) + reactive view", () => {
  const out = lower(`<script lang="ts">
sync user :: User from \`user:\${id}\`;
</script>
<div>{user?.name}</div>`);
  expect(out).toContain("const __syn_user = synced(`user:${id}`, User);");
  expect(out).toContain(`let user = $state(__syn_user.peek?.() ?? __syn_user);`);
  expect(out).toContain(`onDestroy(() => __syn_user.dispose?.());`);
  expect(out).toContain(`import { synced } from "@lyku/para-sync";`);
  expect(out).not.toMatch(/(^|\n)\s*sync user ::/);
});

test("sync...from with a plain string key", () => {
  const out = lower(`<script lang="ts">
sync me :: User from "currentUser";
</script>`);
  expect(out).toContain(`const __syn_me = synced("currentUser", User);`);
});

test("sync NAME : TYPE from KEY (single colon) → type-only, no schema arg", () => {
  const out = lower(`<script lang="ts">
sync user : User from \`user:\${id}\`;
</script>
<div>{user?.name}</div>`);
  // single colon: synced(KEY) with NO schema, and a TS type annotation on $state
  expect(out).toContain("const __syn_user = synced(`user:${id}`);");
  expect(out).toContain(`let user: User = $state(__syn_user.peek?.() ?? __syn_user);`);
  expect(out).not.toContain(", User)"); // schema is NOT passed (type-only)
  expect(out).toContain(`onDestroy(() => __syn_user.dispose?.());`);
});

test("`::` (validate) and `:` (type-only) are distinguished", () => {
  const validated = lower(`<script lang="ts">
sync a :: User from "k";
</script>`);
  expect(validated).toContain(`const __syn_a = synced("k", User);`); // schema passed
  expect(validated).not.toContain(`let a: User`); // type inferred, not annotated

  const typed = lower(`<script lang="ts">
sync b : User from "k";
</script>`);
  expect(typed).toContain(`const __syn_b = synced("k");`); // no schema
  expect(typed).toContain(`let b: User = $state`); // annotated
});

test("sync...from is read-only: assignments are NOT rewritten", () => {
  const out = lower(`<script lang="ts">
sync s :: S from "k";
s = other;
</script>`);
  expect(out).toContain(`s = other;`);
  expect(out).not.toContain(`__syn_s.set(`);
});

test("no synced decl → no __syn_ / synced import injected by this path", () => {
  const out = lower(`<script lang="ts">
signal x = 1;
</script>`);
  expect(out).not.toContain("__syn_");
  expect(out).not.toContain(`from "@lyku/para-sync"`);
});
