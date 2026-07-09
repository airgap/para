import { describe, expect, test } from "bun:test";
import {
  InProcessTransport,
  createClientReplica,
  createIntent,
  defineAuthority,
  writableFields,
  guardOptimistic,
  mergeFields,
} from "../src/index.js";

const anySchema = { parse: (value) => ({ tag: "Ok", value }) };
const env = (sequence, value, schema_version = "1.0") => ({ value, schema_version, sequence });
const unionTags = (mine, theirs) => [...new Set([...(mine ?? []), ...(theirs ?? [])])];

describe("defineAuthority / writableFields", () => {
  test("normalizes 'server' / 'lww' / merge-fn; rejects garbage", () => {
    const a = defineAuthority({ views: "server", title: "lww", tags: unionTags });
    expect(a.views).toEqual({ class: "server" });
    expect(a.title).toEqual({ class: "A" });
    expect(a.tags.class).toBe("B");
    expect(a.tags.merge).toBe(unionTags);
    expect(() => defineAuthority({ x: "nope" })).toThrow(/'server' \| 'lww'/);
  });

  test("writableFields = the A + B fields (not @server)", () => {
    const a = defineAuthority({ views: "server", title: "lww", tags: unionTags });
    expect([...writableFields(a)].sort()).toEqual(["tags", "title"]);
  });
});

describe("guardOptimistic — the write gate (§13.2)", () => {
  const authority = defineAuthority({ views: "server", title: "lww", tags: unionTags });

  test("resets a @server field a client tried to write; keeps A/B writes", () => {
    const base = { title: "a", views: 10, tags: ["x"] };
    const next = { title: "b", views: 999, tags: ["x", "y"] }; // client illegally bumped views
    expect(guardOptimistic(authority, base, next)).toEqual({ title: "b", views: 10, tags: ["x", "y"] });
  });

  test("no-op when nothing violates, and for non-object values", () => {
    const base = { title: "a", views: 1, tags: [] };
    const ok = { title: "b", views: 1, tags: ["z"] };
    expect(guardOptimistic(authority, base, ok)).toEqual(ok);
    expect(guardOptimistic(authority, 1, 2)).toBe(2);
  });
});

describe("mergeFields — Class-B reconcile (§13.2)", () => {
  const authority = defineAuthority({ views: "server", title: "lww", tags: unionTags });

  test("@merge field resolves via its fn; @server/@lww take theirs", () => {
    const mine = { title: "local", views: 5, tags: ["x", "local"] };
    const theirs = { title: "server", views: 42, tags: ["x", "server"] };
    const base = { title: "a", views: 1, tags: ["x"] };
    expect(mergeFields(authority, mine, theirs, base)).toEqual({
      title: "server", // lww → theirs
      views: 42, // server → theirs
      tags: ["x", "local", "server"], // merge → union
    });
  });

  test("non-object theirs / no authority → theirs verbatim", () => {
    expect(mergeFields(authority, {}, null, {})).toBe(null);
    expect(mergeFields(undefined, { a: 1 }, { a: 2 }, {})).toEqual({ a: 2 });
  });
});

describe("authority wired into the write path + reconciler", () => {
  test("createIntent strips a @server field write from the optimistic arm", () => {
    const t = new InProcessTransport();
    const r = createClientReplica({ key: "d:1", schema: anySchema, transport: t, seed: env(1, { title: "a", views: 3 }) });
    const authority = defineAuthority({ views: "server", title: "lww" });
    const edit = createIntent({
      replica: r,
      authority,
      optimistic: (title) => ({ title, views: 999 }), // tries to write @server views
    });
    edit.apply("b");
    expect(r.peek()).toEqual({ title: "b", views: 3 }); // views kept at the server value
  });

  test("createClientReplica merges @merge fields on a steady-state echo", () => {
    const t = new InProcessTransport();
    const authority = defineAuthority({ title: "lww", tags: unionTags });
    const r = createClientReplica({ key: "d:2", schema: anySchema, transport: t, seed: env(1, { title: "a", tags: ["x"] }), authority });

    r.applyLocal({ title: "a", tags: ["x", "local"] }); // a local optimistic edit to the merge field
    t.publish("d:2", env(2, { title: "b", tags: ["x", "server"] })); // server echo

    expect(r.peek()).toEqual({ title: "b", tags: ["x", "local", "server"] });
    expect(r.peekMeta().sequence).toBe(2);
  });

  test("without authority the reconciler is a plain overwrite (Tier-1 unchanged)", () => {
    const t = new InProcessTransport();
    const r = createClientReplica({ key: "d:3", schema: anySchema, transport: t, seed: env(1, { tags: ["x"] }) });
    r.applyLocal({ tags: ["x", "local"] });
    t.publish("d:3", env(2, { tags: ["server"] }));
    expect(r.peek()).toEqual({ tags: ["server"] }); // full overwrite, no merge
  });
});
