import { test, expect } from "bun:test";
import { lowerPuiReactivity } from "../src/index.ts";

const lower = (s: string) => lowerPuiReactivity(s, "@lyku/para-ui", false, false);

test("sync feed :: T[] from query(...) → syncedQuery + reactive array + auto-dispose (§13.3)", () => {
  const out = lower(`<script lang="ts">
sync feed :: Post[] from query({ where: p => p.authorId == userId, orderBy: p => p.createdAt, limit: 50 });
</script>
<ul>{#each feed as p}<li>{p.text}</li>{/each}</ul>`);
  expect(out).toContain(
    `const __syn_feed = syncedQuery(Post, { where: p => p.authorId == userId, orderBy: p => p.createdAt, limit: 50 });`
  );
  expect(out).toContain(`let feed = $state(__syn_feed.peek?.() ?? []);`);
  expect(out).toContain(`$effect.pre(() => __syn_feed.subscribe?.((__v: typeof feed) => { feed = __v; }));`);
  expect(out).toContain(`onDestroy(() => __syn_feed.dispose?.());`);
  expect(out).toContain(`import { syncedQuery } from "@lyku/para-sync";`);
  expect(out).not.toMatch(/sync feed ::/);
});

test("presence NAME :: Schema in CHANNEL → presence + reactive Map + auto-dispose (§13.4)", () => {
  const out = lower(`<script lang="ts">
presence cursors :: Cursor in \`doc:\${docId}\`;
</script>
<div>{cursors.size} here</div>`);
  expect(out).toContain("const __pre_cursors = presence(`doc:${docId}`, Cursor);");
  expect(out).toContain(`let cursors = $state(__pre_cursors.peek?.() ?? new Map());`);
  expect(out).toContain(`$effect.pre(() => __pre_cursors.subscribe?.((__v: typeof cursors) => { cursors = __v; }));`);
  expect(out).toContain(`onDestroy(() => __pre_cursors.dispose?.());`);
  expect(out).toContain(`import { presence } from "@lyku/para-sync";`);
  expect(out).not.toMatch(/presence cursors ::/);
});

test("plain sync :: T from KEY is untouched by the feed lowering", () => {
  const out = lower(`<script lang="ts">
sync user :: User from \`user:\${id}\`;
</script>`);
  expect(out).toContain("const __syn_user = synced(`user:${id}`, User);");
  expect(out).not.toContain("syncedQuery");
});

test("feed + single-object sync coexist and import both symbols on one line", () => {
  const out = lower(`<script lang="ts">
sync user :: User from \`user:\${id}\`;
sync feed :: Post[] from query({ limit: 20 });
</script>`);
  expect(out).toMatch(/import \{ synced, syncedQuery \} from "@lyku\/para-sync";/);
  expect(out).toContain("const __syn_user = synced(`user:${id}`, User);");
  expect(out).toContain("const __syn_feed = syncedQuery(Post, { limit: 20 });");
});

test("a string containing ')' inside the query spec doesn't truncate the match", () => {
  const out = lower(`<script lang="ts">
sync feed :: Post[] from query({ where: p => p.tag == "a)b" });
</script>`);
  expect(out).toContain(`const __syn_feed = syncedQuery(Post, { where: p => p.tag == "a)b" });`);
});
