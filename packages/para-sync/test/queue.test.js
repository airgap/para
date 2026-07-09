import { describe, expect, test } from "bun:test";
import {
  InProcessTransport,
  createClientReplica,
  createQueuedIntent,
  createMemoryStore,
  createLocalStorageStore,
  createMemorySnapshot,
  localStorageSnapshot,
} from "../src/index.js";

const anySchema = { parse: (value) => ({ tag: "Ok", value }) };
const env = (sequence, value, schema_version = "1.0") => ({ value, schema_version, sequence });

// Minimal Web Storage shim for the localStorage adapters.
class MockStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}

describe("durable stores", () => {
  test("createMemoryStore: append upserts by op-id, list keeps issue order, remove/clear", async () => {
    const s = createMemoryStore();
    await s.append({ opId: "op-1", v: 1, key: "k", input: "A" });
    await s.append({ opId: "op-2", v: 1, key: "k", input: "B" });
    await s.append({ opId: "op-1", v: 5, key: "k", input: "A" }); // upsert same op-id
    expect((await s.list()).map((r) => [r.opId, r.v, r.input])).toEqual([
      ["op-1", 5, "A"],
      ["op-2", 1, "B"],
    ]);
    await s.remove("op-1");
    expect((await s.list()).map((r) => r.opId)).toEqual(["op-2"]);
    await s.clear();
    expect(await s.list()).toEqual([]);
  });

  test("createLocalStorageStore: durable across instances on the same storage", async () => {
    const storage = new MockStorage();
    const s1 = createLocalStorageStore("ws1", storage);
    await s1.append({ opId: "op-1", v: 1, key: "cart:1", input: { sku: "X" } });
    await s1.append({ opId: "op-2", v: 1, key: "cart:1", input: { sku: "Y" } });
    // a fresh instance (a "reload") sees the same persisted log
    const s2 = createLocalStorageStore("ws1", storage);
    expect((await s2.list()).map((r) => r.input.sku)).toEqual(["X", "Y"]);
    await s2.remove("op-1");
    expect((await createLocalStorageStore("ws1", storage).list()).map((r) => r.opId)).toEqual(["op-2"]);
  });

  test("localStorageSnapshot: round-trips one envelope per key", () => {
    const storage = new MockStorage();
    const snap = localStorageSnapshot("channel:9", storage);
    expect(snap.load()).toBeUndefined();
    snap.save(env(7, { name: "general" }));
    expect(localStorageSnapshot("channel:9", storage).load()).toMatchObject({ sequence: 7, value: { name: "general" } });
  });
});

describe("read-side durability (createClientReplica persist)", () => {
  test("cold start seeds from the persisted snapshot; SSR seed wins over it", () => {
    const snap = createMemorySnapshot();

    // session 1: commits persist the confirmed envelope
    const t1 = new InProcessTransport();
    const r1 = createClientReplica({ key: "u:1", schema: anySchema, transport: t1, seed: env(3, { name: "ada" }), persist: snap });
    t1.publish("u:1", env(4, { name: "ada-2" }));
    expect(snap.load()).toMatchObject({ sequence: 4, value: { name: "ada-2" } });
    r1.dispose();

    // session 2: cold start, NO seed and NO network → seeds from the snapshot
    const r2 = createClientReplica({ key: "u:1", schema: anySchema, transport: new InProcessTransport(), persist: snap });
    expect(r2.peek()).toEqual({ name: "ada-2" });
    expect(r2.peekMeta()).toMatchObject({ sequence: 4, status: "ok" });
    r2.dispose();

    // an SSR seed, when present, wins over the persisted snapshot
    const r3 = createClientReplica({ key: "u:1", schema: anySchema, transport: new InProcessTransport(), seed: env(9, { name: "fresh" }), persist: snap });
    expect(r3.peek()).toEqual({ name: "fresh" });
    expect(r3.peekMeta().sequence).toBe(9);
    r3.dispose();
  });

  test("only server-authoritative commits persist — never the optimistic overlay", () => {
    const snap = createMemorySnapshot();
    const t = new InProcessTransport();
    const r = createClientReplica({ key: "c:1", schema: anySchema, transport: t, seed: env(1, { n: 0 }), persist: snap });
    r.applyLocal({ n: 99 }); // optimistic local write
    expect(r.peek()).toEqual({ n: 99 });
    expect(snap.load()).toMatchObject({ sequence: 1, value: { n: 0 } }); // snapshot stays at the confirmed baseline
    r.dispose();
  });
});

describe("createQueuedIntent — offline queued mutations (§13.5)", () => {
  test("apply persists a durable record; confirm/reject remove it", async () => {
    const store = createMemoryStore();
    const t = new InProcessTransport();
    const r = createClientReplica({ key: "cart:1", schema: anySchema, transport: t, seed: env(1, { items: [] }) });
    const q = createQueuedIntent({ replica: r, key: "cart:1", store, optimistic: (x, c) => ({ items: [...c.items, x] }) });

    const a = q.apply("A");
    const b = q.apply("B");
    await q.flushed();
    expect((await store.list()).map((r) => r.input)).toEqual(["A", "B"]);

    q.confirm(a.opId);
    await q.flushed();
    expect((await store.list()).map((r) => r.opId)).toEqual([b.opId]);

    q.reject(b.opId);
    await q.flushed();
    expect(await store.list()).toEqual([]);
    expect(r.peek()).toEqual({ items: [] }); // reject drained the run → baseline
  });

  test("onEcho dedupe/suppress drops the durable record", async () => {
    const store = createMemoryStore();
    const t = new InProcessTransport();
    const r = createClientReplica({ key: "p:1", schema: anySchema, transport: t, seed: env(1, { liked: false }) });
    const q = createQueuedIntent({ replica: r, key: "p:1", store, optimistic: (_, c) => ({ liked: !c.liked }) });
    const { opId, v } = q.apply();
    await q.flushed();
    expect((await store.list()).length).toBe(1);
    expect(q.onEcho({ opId, v })).toBe("dedupe");
    await q.flushed();
    expect(await store.list()).toEqual([]);
  });

  test("offline round-trip: queue offline, survive a reload, replay + confirm on reconnect", async () => {
    // durable across the "reload": both the mutation log and the read snapshot
    const log = createMemoryStore();
    const snap = createMemorySnapshot();
    const mk = (replica, send) =>
      createQueuedIntent({ replica, key: "cart:1", store: log, optimistic: (x, c) => ({ items: [...c.items, x] }), send });

    // ── session 1: online baseline, then go offline and queue two adds ──
    const t1 = new InProcessTransport();
    const r1 = createClientReplica({ key: "cart:1", schema: anySchema, transport: t1, seed: env(5, { items: [] }), persist: snap });
    const q1 = mk(r1, () => {});
    q1.apply("A");
    q1.apply("B");
    await q1.flushed();
    expect(r1.peek()).toEqual({ items: ["A", "B"] });
    expect((await log.list()).map((r) => r.input)).toEqual(["A", "B"]);
    r1.dispose();

    // ── session 2: cold start (reload), offline: seed from the durable snapshot ──
    const t2 = new InProcessTransport();
    const r2 = createClientReplica({
      key: "cart:1",
      schema: anySchema,
      transport: t2,
      persist: snap,
      refetch: async () => env(8, { items: ["Z"] }), // reconnect resync source (server moved on)
    });
    expect(r2.peek()).toEqual({ items: [] }); // confirmed baseline, not the optimistic overlay
    expect(r2.peekMeta().sequence).toBe(5);

    const sent = [];
    const q2 = mk(r2, (e) => sent.push(e));

    // ── reconnect: a gapped receipt triggers the reconciler's refetch, which
    //    reseeds the fresh server baseline (seq 8, items ["Z"]) ──
    t2.publish("cart:1", env(8, { items: ["Z"] })); // 8 > 5+1 → gap → refetch
    await r2.whenIdle();
    expect(r2.peek()).toEqual({ items: ["Z"] });
    expect(r2.peekMeta().sequence).toBe(8);

    // ── replay the durable log onto the fresh baseline, in op-id order ──
    const resent = await q2.replay();
    expect(resent.map((r) => r.opId)).toEqual(["op-1", "op-2"]); // ORIGINAL op-ids reused
    expect(resent.map((r) => r.v)).toEqual([1, 2]); // fresh intent versions on the new replica
    expect(r2.peek()).toEqual({ items: ["Z", "A", "B"] }); // folded onto the fresh baseline
    expect(sent.map((e) => e.value.items)).toEqual([
      ["Z", "A"],
      ["Z", "A", "B"],
    ]);

    // ── server confirms both → the durable log drains ──
    for (const x of resent) q2.confirm(x.opId);
    await q2.flushed();
    expect(await log.list()).toEqual([]);
    expect(q2.pendingCount()).toBe(0);
    r2.dispose();
  });

  test("guards: bad store / missing key throw", () => {
    const t = new InProcessTransport();
    const r = createClientReplica({ key: "k:1", schema: anySchema, transport: t, seed: env(1, {}) });
    expect(() => createQueuedIntent({ replica: r, key: "", store: createMemoryStore(), optimistic: () => ({}) })).toThrow(/key/);
    expect(() => createQueuedIntent({ replica: r, key: "k:1", store: {}, optimistic: () => ({}) })).toThrow(/MutationStore/);
  });
});
