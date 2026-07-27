// Compile-smoke: the emitted bindings for the 2026-07 sync tranche
// (query-derived §10.7, scalar query §13.7, server source §13.8) must
// actually COMPILE under the real Svelte 5 compiler in runes mode — the
// seam none of the string-shape tests cover. Pipeline mirrors production:
// para-preprocess lowering → TS strip (Bun.Transpiler, what the svelte
// preprocess step does) → svelte.compile.
import { test, expect } from "bun:test";
import { compile } from "svelte/compiler";
import { lowerPuiReactivity } from "../src/index.ts";

const stripTs = new Bun.Transpiler({ loader: "ts" });

function compilePui(src: string): { js: string; warnings: string[] } {
  const lowered = lowerPuiReactivity(src, "svelte", false, false, "test.pui");
  // Strip TS from the script block and drop lang="ts", as the svelte
  // preprocess chain does before the compiler runs.
  const processed = lowered.replace(
    /<script([^>]*)>([\s\S]*?)<\/script>/,
    (_m, attrs, body) =>
      `<script${attrs.replace(/\s*lang="ts"/, "")}>${stripTs.transformSync(body)}</script>`
  );
  const out = compile(processed, { runes: true, generate: "client", filename: "test.svelte" });
  return { js: out.js.code, warnings: out.warnings.map((w) => w.code) };
}

test("query-derived cell (§10.7) compiles under runes", () => {
  const { js } = compilePui(`<script lang="ts">
import { User } from "./models.js";
import { graphql } from "./api.js";
prop id: string;
derived user :: User = graphql.userById(id);
</script>
{#if user.data}<h1>{user.data.name}</h1>{:else if user.pending}<p>…</p>{/if}`);
  expect(js).toContain("querySignal");
  expect(js).toContain("$.state"); // runes-mode client output
});

test("scalar query sync (§13.7) compiles under runes", () => {
  const { js } = compilePui(`<script lang="ts">
import { User } from "./models.js";
prop id: bigint;
sync user :: User from query({ where: u => u.id == id });
</script>
<h1>{user?.name ?? "nobody"}</h1>`);
  expect(js).toContain("syncedOne");
});

test("server-source sync (§13.8) compiles under runes", () => {
  const { js } = compilePui(`<script lang="ts">
import { Stats } from "./models.js";
import { db } from "./db.server.js";
prop orgId: number;
sync stats :: Stats from server db.total(orgId) every 30000;
</script>
<p>{stats?.total}</p>`);
  expect(js).toContain("subKey(");
  expect(js).not.toContain("db.total"); // the opaque expression never reaches the client build
});

test("the whole family coexists in one component and compiles", () => {
  const { js } = compilePui(`<script lang="ts">
import { User, Post, Stats } from "./models.js";
import { db } from "./db.server.js";
import { api } from "./api.js";
prop id: bigint;
signal q = "";
sync me :: User from query({ where: u => u.id == id });
sync feed :: Post[] from query({ limit: 20 });
sync flags :: User from \`flags:\${id}\`;
sync stats :: Stats from server db.total(id) on "stats:bump";
derived found :: Post = api.search(q);
</script>
<p>{me?.name} / {feed.length} / {stats?.total} / {found.data?.title}</p>`);
  for (const call of ["syncedOne", "syncedQuery", "synced(", "subKey(", "querySignal"]) {
    expect(js).toContain(call);
  }
});
