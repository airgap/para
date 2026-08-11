import { describe, expect, test } from "bun:test";
import { effect } from "@lyku/para-signals";
import { InProcessTransport, createClientReplica } from "../src/index.js";

// Hand-rolled parse gate matching para-schema's Result shape: a valid User has
// a string `name`. Anything else is a schema-skew / malformed Err.
const userSchema = {
  parse: (v) =>
    v && typeof v === "object" && typeof v.name === "string"
      ? { tag: "Ok", value: v }
      : { tag: "Err", error: "not a User" }
};

const env = (sequence, value, schema_version = "1.0") => ({ value, schema_version, sequence });

describe("createClientReplica: Tier 1 reconciler", () => {
  test("SSR seed hydrates the replica (hydration parse gate, Ok)", () => {
    const t = new InProcessTransport();
    const r = createClientReplica({
      key: "user:1",
      schema: userSchema,
      transport: t,
      seed: env(1, { name: "ada" })
    });
    expect(r.peek()).toEqual({ name: "ada" });
    expect(r.peekMeta()).toMatchObject({ sequence: 1, schemaVersion: "1.0", status: "ok" });
    expect(r.stats.applied).toBe(1);
  });

  test("in-order receipt applies and the value is reactive (DOM would react)", () => {
    const t = new InProcessTransport();
    const r = createClientReplica({
      key: "user:1",
      schema: userSchema,
      transport: t,
      seed: env(1, { name: "ada" })
    });
    const seen = [];
    const stop = effect(() => seen.push(r.get()?.name)); // tracks the cell
    expect(seen).toEqual(["ada"]);

    t.publish("user:1", env(2, { name: "ada-2" }));
    t.publish("user:1", env(3, { name: "ada-3" }));

    expect(seen).toEqual(["ada", "ada-2", "ada-3"]); // effect re-ran each apply
    expect(r.peekMeta().sequence).toBe(3);
    expect(r.stats.applied).toBe(3); // seed + 2 receipts
    stop();
  });

  test("stale / duplicate / out-of-order receipts are ignored", () => {
    const t = new InProcessTransport();
    const r = createClientReplica({
      key: "user:1",
      schema: userSchema,
      transport: t,
      seed: env(5, { name: "base" })
    });
    t.publish("user:1", env(5, { name: "dup" })); // == cur → ignore
    t.publish("user:1", env(3, { name: "old" })); // < cur → ignore
    expect(r.peek()).toEqual({ name: "base" });
    expect(r.stats.ignoredStale).toBe(2);
    expect(r.stats.applied).toBe(1);
  });

  test("refetch resolving null (no envelope for the key) → stale, not a crash", async () => {
    const t = new InProcessTransport();
    const r = createClientReplica({
      key: "user:1",
      schema: userSchema,
      transport: t,
      seed: env(1, { name: "ada" }),
      refetch: () => Promise.resolve(null) // server: nothing synced / deleted
    });
    t.publish("user:1", env(2, { nope: true })); // malformed → Err → recovery
    expect(r.stats.refetches).toBe(1);
    await r.whenIdle();
    expect(r.peekMeta().status).toBe("stale"); // explicit verdict, not an NPE swallowed by the catch
    expect(r.peek()).toEqual({ name: "ada" }); // last good value stands
  });

  test("parse Err on receipt → skew, cell NOT poisoned, refetch recovers", async () => {
    const t = new InProcessTransport();
    const r = createClientReplica({
      key: "user:1",
      schema: userSchema,
      transport: t,
      seed: env(1, { name: "ada" }),
      refetch: () => Promise.resolve(env(10, { name: "fetched" }))
    });
    t.publish("user:1", env(2, { nope: true })); // malformed → Err
    expect(r.peek()).toEqual({ name: "ada" }); // not poisoned
    expect(r.stats.parseErrors).toBe(1);
    expect(r.stats.refetches).toBe(1);

    await r.whenIdle();
    expect(r.peek()).toEqual({ name: "fetched" }); // recovered from snapshot
    expect(r.peekMeta()).toMatchObject({ sequence: 10, status: "ok" });
  });

  test("hydration skew (bad SSR value) → skew then refetch recovers", async () => {
    const t = new InProcessTransport();
    const r = createClientReplica({
      key: "user:1",
      schema: userSchema,
      transport: t,
      seed: env(1, { broken: true }), // SSR embedded a shape the client can't parse
      refetch: () => Promise.resolve(env(4, { name: "recovered" }))
    });
    expect(r.stats.parseErrors).toBe(1);
    expect(r.peekMeta().status).not.toBe("ok"); // skew/refetching, not applied

    await r.whenIdle();
    expect(r.peek()).toEqual({ name: "recovered" });
    expect(r.peekMeta()).toMatchObject({ sequence: 4, status: "ok" });
  });

  test("sequence gap → the gapped full-object envelope commits directly, no refetch", () => {
    const t = new InProcessTransport();
    let refetched = 0;
    const r = createClientReplica({
      key: "user:1",
      schema: userSchema,
      transport: t,
      seed: env(1, { name: "base" }),
      refetch: () => {
        refetched++;
        return Promise.resolve(env(5, { name: "snap@5" }));
      }
    });
    t.publish("user:1", env(5, { name: "jumped" })); // cur=1, got 5 → gap
    expect(r.stats.gaps).toBe(1);
    expect(refetched).toBe(0); // full-object envelope IS the snapshot
    expect(r.peek()).toEqual({ name: "jumped" });
    expect(r.peekMeta()).toMatchObject({ sequence: 5, status: "ok" });
    // a later in-order receipt resumes normally from the resynced sequence
    t.publish("user:1", env(6, { name: "after" }));
    expect(r.peek()).toEqual({ name: "after" });
  });

  test("gap commit without refetch configured still lands ok (reconnect self-heals)", () => {
    const t = new InProcessTransport();
    const r = createClientReplica({
      key: "user:1",
      schema: userSchema,
      transport: t,
      seed: env(1, { name: "base" })
      // no refetch: pre-2026-08-10 this parked the replica on 'stale'
    });
    t.publish("user:1", env(9, { name: "rejoined" }));
    expect(r.stats.gaps).toBe(1);
    expect(r.peek()).toEqual({ name: "rejoined" });
    expect(r.peekMeta()).toMatchObject({ sequence: 9, status: "ok" });
  });

  test("no refetch available → Err leaves replica stale, uncrashed", () => {
    const t = new InProcessTransport();
    const r = createClientReplica({
      key: "user:1",
      schema: userSchema,
      transport: t,
      seed: env(1, { name: "ada" })
      // no refetch
    });
    t.publish("user:1", env(2, { bad: 1 }));
    expect(r.peek()).toEqual({ name: "ada" });
    expect(r.peekMeta().status).toBe("stale");
    expect(r.stats.refetches).toBe(0);
  });

  test("seed-less boot: the first receipt of any sequence becomes the baseline", () => {
    const t = new InProcessTransport();
    const r = createClientReplica({ key: "user:1", schema: userSchema, transport: t });
    expect(r.peekMeta().status).toBe("stale"); // uninitialized
    t.publish("user:1", env(7, { name: "first" }));
    expect(r.peek()).toEqual({ name: "first" });
    expect(r.peekMeta().sequence).toBe(7);
    expect(r.stats.applied).toBe(1);
    // subsequent steady-state rules apply from seq 7
    t.publish("user:1", env(7, { name: "dup" }));
    expect(r.stats.ignoredStale).toBe(1);
  });

  test("dispose stops delivery (idempotent)", () => {
    const t = new InProcessTransport();
    const r = createClientReplica({
      key: "user:1",
      schema: userSchema,
      transport: t,
      seed: env(1, { name: "ada" })
    });
    r.dispose();
    r.dispose(); // idempotent
    t.publish("user:1", env(2, { name: "after-dispose" }));
    expect(r.peek()).toEqual({ name: "ada" });
    expect(r.stats.applied).toBe(1);
    expect(t.keyCount()).toBe(0); // unsubscribed → key GC'd
  });

  test("key isolation: a replica only ingests its own key", () => {
    const t = new InProcessTransport();
    const r = createClientReplica({
      key: "user:1",
      schema: userSchema,
      transport: t,
      seed: env(1, { name: "ada" })
    });
    t.publish("user:2", env(2, { name: "other" })); // different key
    expect(r.peek()).toEqual({ name: "ada" });
    expect(r.stats.applied).toBe(1);
  });
});

describe("schema-version skew gate", () => {
  const mk = (schemaVersion, refetch) =>
    (() => {
      const t = new InProcessTransport();
      const r = createClientReplica({
        key: "user:1",
        schema: userSchema,
        transport: t,
        schemaVersion,
        refetch,
        seed: env(1, { name: "ada" }, schemaVersion),
      });
      return { t, r };
    })();

  test("minor difference (same major) is compatible → applies", () => {
    const { t, r } = mk("3.1");
    t.publish("user:1", env(2, { name: "ada-2" }, "3.4")); // minor diff
    expect(r.peek()).toEqual({ name: "ada-2" });
    expect(r.stats.applied).toBe(2);
    expect(r.stats.schemaSkews).toBe(0);
  });

  test("major difference is a breaking skew → not applied, refetch fired", async () => {
    const { t, r } = mk("3.9", () =>
      Promise.resolve(env(10, { name: "recovered" }, "3.9")),
    );
    t.publish("user:1", env(2, { name: "v4-shape" }, "4.0")); // major diff
    expect(r.peek()).toEqual({ name: "ada" }); // not applied
    expect(r.stats.schemaSkews).toBe(1);
    expect(r.stats.refetches).toBe(1);
    await r.whenIdle();
    expect(r.peek()).toEqual({ name: "recovered" }); // recovered via refetch
  });

  test("no schemaVersion set → version gate inert (applies regardless)", () => {
    const t = new InProcessTransport();
    const r = createClientReplica({
      key: "user:1",
      schema: userSchema,
      transport: t,
      seed: env(1, { name: "ada" }),
    });
    t.publish("user:1", env(2, { name: "ada-2" }, "9.9")); // wild version, no gate
    expect(r.peek()).toEqual({ name: "ada-2" });
    expect(r.stats.schemaSkews).toBe(0);
  });

  test("malformed/missing version is lenient (parse gate is the backstop)", () => {
    const { t, r } = mk("3.1");
    t.publish("user:1", env(2, { name: "ada-2" }, "garbage")); // unparseable version
    expect(r.peek()).toEqual({ name: "ada-2" }); // not blocked by version gate
    expect(r.stats.schemaSkews).toBe(0);
  });
});
