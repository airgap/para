import { describe, expect, test } from "bun:test";
import { InProcessTransport, createQueryAuthority, syncedOne, syncedQuery } from "../src/index.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

const userSchema = {
  parse: (v) =>
    v && typeof v === "object" && typeof v.name === "string"
      ? { tag: "Ok", value: v }
      : { tag: "Err", error: "not a User" },
};

// A tiny in-memory "database" the evaluate closure reads — the stand-in for
// what lockstep-pg-compiled SQL does in production.
function makeDb(rows) {
  const table = new Map(rows.map((r) => [r.id, r]));
  return {
    table,
    authority(transport, extra = {}) {
      return createQueryAuthority({
        transport,
        schema: userSchema,
        keyOf: (r) => `user:${r.id}`,
        evaluate: (spec) => {
          const all = [...table.values()].filter(spec.where ?? (() => true));
          if (spec.orderBy) all.sort((a, b) => (spec.orderBy(a) < spec.orderBy(b) ? -1 : 1));
          return spec.limit ? all.slice(0, spec.limit) : all;
        },
        readSetOf: () => ({ table: "users" }),
        ...extra,
      });
    },
  };
}

describe("createQueryAuthority — read-set invalidation (plan step 3)", () => {
  test("constructor guards", () => {
    expect(() => createQueryAuthority({})).toThrow("`transport`");
    const t = new InProcessTransport();
    expect(() => createQueryAuthority({ transport: t })).toThrow("`evaluate`");
    expect(() => createQueryAuthority({ transport: t, evaluate: () => [] })).toThrow("`keyOf`");
    expect(() => createQueryAuthority({ transport: t, evaluate: () => [], keyOf: (r) => r.id })).toThrow(
      "`schema`"
    );
  });

  test("subscribe → initial membership with gated, sequenced seeds", async () => {
    const t = new InProcessTransport();
    const db = makeDb([{ id: 1, name: "ada" }, { id: 2, name: "grace" }]);
    const auth = db.authority(t);
    const deltas = [];
    auth.subscribe({ where: (u) => true }).listen((m) => deltas.push(m));
    await tick();
    expect(deltas).toHaveLength(1);
    expect(deltas[0].keys).toEqual(["user:1", "user:2"]);
    expect(deltas[0].seeds["user:1"]).toEqual({
      value: { id: 1, name: "ada" },
      schema_version: "1.0",
      sequence: 1,
    });
  });

  test("wrote() on an intersecting table republishes ONLY changed rows (+1 sequence)", async () => {
    const t = new InProcessTransport();
    const db = makeDb([{ id: 1, name: "ada" }, { id: 2, name: "grace" }]);
    const auth = db.authority(t);
    auth.subscribe({}).listen(() => {});
    await tick();

    const published = [];
    t.subscribe("user:1", (e) => published.push(e));
    t.subscribe("user:2", (e) => published.push(e));

    db.table.set(1, { id: 1, name: "ada lovelace" }); // change row 1 only
    await auth.wrote({ table: "users", rowKey: "user:1" });
    expect(published).toEqual([
      { value: { id: 1, name: "ada lovelace" }, schema_version: "1.0", sequence: 2 },
    ]); // row 2 untouched — deep-equal short-circuit

    await auth.wrote({ table: "users" }); // nothing changed since
    expect(published).toHaveLength(1); // no spurious republish, sequences never skip
  });

  test("a non-intersecting write triggers NO evaluation at all", async () => {
    const t = new InProcessTransport();
    const db = makeDb([{ id: 1, name: "ada" }]);
    const auth = db.authority(t);
    auth.subscribe({}).listen(() => {});
    await tick();
    const before = auth.stats().evaluations;
    await auth.wrote({ table: "posts" });
    expect(auth.stats().evaluations).toBe(before);
  });

  test("membership change (a row starts matching) emits a delta seeded for the new row only", async () => {
    const t = new InProcessTransport();
    const db = makeDb([{ id: 1, name: "ada" }]);
    const auth = db.authority(t);
    const deltas = [];
    auth.subscribe({ where: (u) => u.name.startsWith("a") }).listen((m) => deltas.push(m));
    await tick();
    expect(deltas[0].keys).toEqual(["user:1"]);

    db.table.set(3, { id: 3, name: "alan" });
    await auth.wrote("users");
    expect(deltas).toHaveLength(2);
    expect(deltas[1].keys).toEqual(["user:1", "user:3"]);
    expect(deltas[1].seeds["user:3"].sequence).toBe(1);
  });

  test("unchanged membership emits NO delta on wrote()", async () => {
    const t = new InProcessTransport();
    const db = makeDb([{ id: 1, name: "ada" }]);
    const auth = db.authority(t);
    const deltas = [];
    auth.subscribe({}).listen((m) => deltas.push(m));
    await tick();
    db.table.set(1, { id: 1, name: "ada l." }); // value change, same membership
    await auth.wrote("users");
    expect(deltas).toHaveLength(1); // value rode the transport, not the membership channel
  });

  test("outbound parse gate: a malformed row is skipped + reported, never published", async () => {
    const t = new InProcessTransport();
    const errors = [];
    const db = makeDb([{ id: 1, name: "ada" }, { id: 2, junk: true }]);
    const auth = db.authority(t, { onError: (e, ctx) => errors.push([e, ctx.phase]) });
    const deltas = [];
    auth.subscribe({}).listen((m) => deltas.push(m));
    await tick();
    expect(deltas[0].keys).toEqual(["user:1"]); // the malformed row never became a member
    expect(errors).toEqual([["not a User", "parse"]]);
  });

  test("close() unregisters: later writes neither evaluate nor emit", async () => {
    const t = new InProcessTransport();
    const db = makeDb([{ id: 1, name: "ada" }]);
    const auth = db.authority(t);
    const deltas = [];
    const stream = auth.subscribe({});
    stream.listen((m) => deltas.push(m));
    await tick();
    stream.close();
    const before = auth.stats().evaluations;
    db.table.set(1, { id: 1, name: "changed" });
    await auth.wrote("users");
    expect(auth.stats().evaluations).toBe(before);
    expect(deltas).toHaveLength(1);
  });

  test("row-key narrowed read-sets skip writes to other rows", async () => {
    const t = new InProcessTransport();
    const db = makeDb([{ id: 1, name: "ada" }]);
    const auth = db.authority(t, {
      readSetOf: (spec) => ({ table: "users", rowKeys: [`user:${spec.id}`] }),
      evaluate: (spec) => [db.table.get(spec.id)].filter(Boolean),
    });
    auth.subscribe({ id: 1 }).listen(() => {});
    await tick();
    const before = auth.stats().evaluations;
    await auth.wrote({ table: "users", rowKey: "user:99" });
    expect(auth.stats().evaluations).toBe(before); // provably disjoint — skipped
    await auth.wrote({ table: "users", rowKey: "user:1" });
    expect(auth.stats().evaluations).toBe(before + 1);
  });
});

describe("end to end: authority ⇄ client spine", () => {
  test("syncedOne goes LIVE: a write flows authority → transport → replica → scalar", async () => {
    const t = new InProcessTransport();
    const db = makeDb([{ id: 1, name: "ada" }]);
    const auth = db.authority(t);
    const one = syncedOne(userSchema, {
      transport: t,
      membership: auth.subscribe({ where: (u) => u.id === 1 }),
    });
    const seen = [];
    one.subscribe((v) => seen.push(v?.name));
    await tick();
    expect(seen).toEqual(["ada"]); // silent until the authority's first membership fact

    db.table.set(1, { id: 1, name: "ada lovelace" });
    await auth.wrote("users");
    expect(seen).toEqual(["ada", "ada lovelace"]); // per-row envelope reconciled seq 1→2

    db.table.delete(1);
    await auth.wrote("users");
    expect(seen).toEqual(["ada", "ada lovelace", undefined]); // deletion = membership fact
    one.dispose();
    auth.dispose();
  });

  test("syncedQuery collection stays ordered + live through the same authority", async () => {
    const t = new InProcessTransport();
    const db = makeDb([{ id: 2, name: "grace" }, { id: 1, name: "ada" }]);
    const auth = db.authority(t);
    const feed = syncedQuery(userSchema, {
      transport: t,
      membership: auth.subscribe({ orderBy: (u) => u.name }),
    });
    await tick();
    expect(feed.peek().map((u) => u.name)).toEqual(["ada", "grace"]);

    db.table.set(3, { id: 3, name: "alan" });
    await auth.wrote("users");
    expect(feed.peek().map((u) => u.name)).toEqual(["ada", "alan", "grace"]);
    feed.dispose();
    auth.dispose();
  });
});
