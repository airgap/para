import { test, expect } from "bun:test";
import { extractServerSources, lowerPuiReactivity } from "../src/index.ts";

const lower = (s: string, moduleId?: string) =>
  lowerPuiReactivity(s, "@lyku/para-ui", false, false, moduleId);

const SRC = `<script lang="ts">
import { Stats } from "@app/models";
import { db } from "./db.server.js";
prop orgId: bigint;
sync stats :: Stats from server db.slowAggregate(orgId) every 30000;
</script>
<p>{stats?.total}</p>`;

test("client side: tracked synced(subKey(...)) binding; the server expression is GONE", () => {
  const out = lower(SRC, "src/Stats.pui");
  expect(out).toContain(`let stats = $state(undefined as any);`);
  expect(out).toContain(
    `const __sv_stats = synced(subKey("src/Stats.pui#stats", [orgId]), Stats);`
  );
  expect(out).toContain(`return () => { __un_stats?.(); __sv_stats.dispose?.(); };`);
  expect(out).toContain(`import { synced, subKey } from "@lyku/para-sync";`);
  expect(out).not.toContain("slowAggregate"); // the opaque expression never reaches the client
  expect(out).not.toMatch(/from server/);
});

test("extractServerSources: server module hoists the import, binds params, carries the policy", () => {
  const r = extractServerSources(SRC, { moduleId: "src/Stats.pui" });
  expect(r.diagnostics).toEqual([]);
  expect(r.sources).toHaveLength(1);
  expect(r.sources[0]).toMatchObject({
    name: "stats",
    declId: "src/Stats.pui#stats",
    schema: "Stats",
    params: ["orgId"],
    policy: "{ every: (30000) }",
  });
  expect(r.serverModule).toContain(`import { db } from "./db.server.js";`);
  expect(r.serverModule).toContain(`import { Stats } from "@app/models";`); // schema is isomorphic
  expect(r.serverModule).toContain(`run: ({ orgId }) => (db.slowAggregate(orgId)),`);
  expect(r.serverModule).toContain(`policy: { every: (30000) },`);
  // The client emission in the same result carries the SAME declId → same subKey.
  expect(r.code).toContain(`subKey("src/Stats.pui#stats", [orgId])`);
});

test("a missing refresh policy is a compile error naming all three options", () => {
  expect(() =>
    lower(`<script lang="ts">
import { db } from "./db.server.js";
sync stats :: Stats from server db.slowAggregate();
</script>`)
  ).toThrow(/refresh policy.*every MS.*on KEY.*once/s);
});

test("`on` and `once` policies parse; a policy word inside the expression does not terminate it", () => {
  const r = extractServerSources(
    `<script lang="ts">
import { db } from "./db.server.js";
sync a :: S from server db.q({ label: "run every day" }) on "users:changed";
sync b :: S from server db.count() once;
</script>`,
    { moduleId: "m" }
  );
  expect(r.diagnostics).toEqual([]);
  expect(r.sources[0]!.expr).toBe(`db.q({ label: "run every day" })`);
  expect(r.sources[0]!.policy).toBe(`{ on: ("users:changed") }`);
  expect(r.sources[1]!.policy).toBe(`{ once: true }`);
});

test("an import used on BOTH sides of the boundary is a compile error", () => {
  expect(() =>
    lower(`<script lang="ts">
import { db } from "./db.server.js";
sync stats :: Stats from server db.count() once;
const local = db.version;
</script>`)
  ).toThrow(/BOTH sides of the server boundary/);
});

test("the schema import is exempt from the boundary rule (isomorphic value)", () => {
  const out = lower(`<script lang="ts">
import { Stats } from "@app/models";
import { db } from "./db.server.js";
sync stats :: Stats from server db.agg() once;
const empty = Stats.parse({});
</script>`);
  expect(out).toContain("Stats.parse({})"); // client keeps using the schema freely
});

test("`this` in a server expression is a compile error", () => {
  expect(() =>
    lower(`<script lang="ts">
import { db } from "./db.server.js";
sync stats :: Stats from server db.q(this.org) once;
</script>`)
  ).toThrow(/`this` cannot cross the server boundary/);
});

test("multiple params re-key positionally; ambient globals stay ambient", () => {
  const r = extractServerSources(
    `<script lang="ts">
import { db } from "./db.server.js";
prop orgId: bigint;
signal window = "30d";
sync report :: Report from server db.report(orgId, window, Math.floor(Date.now() / 86400000)) every 60000;
</script>`,
    { moduleId: "m" }
  );
  expect(r.diagnostics).toEqual([]);
  expect(r.sources[0]!.params).toEqual(["orgId", "window"]);
  expect(r.code).toContain(`subKey("m#report", [orgId, window])`);
  expect(r.serverModule).toContain(`run: ({ orgId, window }) => (db.report(orgId, window, Math.floor(Date.now() / 86400000))),`);
});

test("a file with no server sources is returned untouched", () => {
  const src = `<script lang="ts">\nsync user :: User from \`user:\${id}\`;\n</script>`;
  const r = extractServerSources(src);
  expect(r.code).toBe(src);
  expect(r.serverModule).toBeUndefined();
  expect(r.sources).toEqual([]);
});
