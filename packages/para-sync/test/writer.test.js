import { describe, expect, test } from "bun:test";
import { effect } from "@lyku/para-signals";
import {
  InProcessTransport,
  createClientReplica,
  createIntent,
  createOpIds,
} from "../src/index.js";

// A permissive counter/entity gate (para-schema Result shape).
const anySchema = { parse: (value) => ({ tag: "Ok", value }) };
const env = (sequence, value, schema_version = "1.0") => ({ value, schema_version, sequence });

// A real Tier-1 replica seeded with `value`, plus its transport (to feed echoes).
function seededReplica(value) {
  const t = new InProcessTransport();
  const r = createClientReplica({ key: "e:1", schema: anySchema, transport: t, seed: env(1, value) });
  return { t, r };
}

describe("createOpIds", () => {
  test("issues monotonically in a total order (the §13.5 replay anchor)", () => {
    const next = createOpIds("op");
    expect([next(), next(), next()]).toEqual(["op-1", "op-2", "op-3"]);
  });
});

describe("createIntent — Tier-2 optimistic write machine (§13.1)", () => {
  test("apply flips the local cell, tags (opId,v), emits, and goes pending", () => {
    const { r } = seededReplica({ liked: false, count: 0 });
    const sent = [];
    const like = createIntent({
      replica: r,
      optimistic: (_, cur) => ({ liked: true, count: cur.count + 1 }),
      send: (e) => sent.push(e),
      nextOpId: createOpIds(),
    });

    const intent = like.apply();
    expect(r.peek()).toEqual({ liked: true, count: 1 }); // optimistic flip is instant
    expect(intent).toMatchObject({ opId: "op-1", v: 1 });
    expect(sent).toEqual([{ opId: "op-1", v: 1, value: { liked: true, count: 1 } }]);
    expect(like.pendingCount()).toBe(1);
    expect(like.peekStatus()).toBe("pending");
  });

  test("confirm clears pending and returns to idle (no cell change of its own)", () => {
    const { r } = seededReplica({ n: 0 });
    const inc = createIntent({ replica: r, optimistic: (_, c) => ({ n: c.n + 1 }) });
    const { opId } = inc.apply();
    expect(inc.confirm(opId)).toBe(true);
    expect(inc.pendingCount()).toBe(0);
    expect(inc.peekStatus()).toBe("idle");
    expect(inc.confirm(opId)).toBe(false); // already cleared
    expect(inc.stats.confirmed).toBe(1);
  });

  test("reject rolls the cell back to the run baseline once pending drains", () => {
    const { r } = seededReplica({ liked: false, count: 7 });
    const like = createIntent({ replica: r, optimistic: () => ({ liked: true, count: 8 }) });
    const { opId } = like.apply();
    expect(r.peek()).toEqual({ liked: true, count: 8 });
    expect(like.reject(opId)).toBe(true);
    expect(r.peek()).toEqual({ liked: false, count: 7 }); // reverted to baseline
    expect(like.peekStatus()).toBe("idle");
    expect(like.stats.rolledBack).toBe(1);
  });

  test("custom rollback delta is honored", () => {
    const { r } = seededReplica({ text: "hello" });
    const edit = createIntent({
      replica: r,
      optimistic: (t) => ({ text: t }),
      rollback: () => ({ text: "(reverted)" }),
    });
    const { opId } = edit.apply("world");
    expect(r.peek()).toEqual({ text: "world" });
    edit.reject(opId);
    expect(r.peek()).toEqual({ text: "(reverted)" });
  });

  test("onEcho: our own current-version echo → 'dedupe' and clears pending", () => {
    const { r } = seededReplica({ n: 0 });
    const inc = createIntent({ replica: r, optimistic: (_, c) => ({ n: c.n + 1 }) });
    const { opId, v } = inc.apply();
    expect(inc.onEcho({ opId, v })).toBe("dedupe");
    expect(inc.pendingCount()).toBe(0);
    expect(inc.stats.deduped).toBe(1);
  });

  test("onEcho: unknown op-id → 'pass' (a foreign change the reconciler applies)", () => {
    const { r } = seededReplica({ n: 0 });
    const inc = createIntent({ replica: r, optimistic: (_, c) => ({ n: c.n + 1 }) });
    inc.apply();
    expect(inc.onEcho({ opId: "someone-else", v: 99 })).toBe("pass");
    expect(inc.onEcho({ value: 1, sequence: 5 })).toBe("pass"); // a plain Tier-1 receipt
    expect(inc.stats.foreign).toBe(2);
    expect(inc.pendingCount()).toBe(1); // our intent is untouched
  });

  test("Class-A flicker kill: stale own echo is suppressed, latest wins (Like/Unlike)", () => {
    // like (v1), then unlike (v2). Server echoes v1 AFTER we've moved to v2.
    const { r } = seededReplica({ liked: false });
    const toggle = createIntent({ replica: r, optimistic: (_, c) => ({ liked: !c.liked }) });

    const a = toggle.apply(); // v1: liked=true
    const b = toggle.apply(); // v2: liked=false
    expect(r.peek()).toEqual({ liked: false });
    expect(a.v).toBe(1);
    expect(b.v).toBe(2);

    // stale echo of v1 arrives — a newer local intent (v2) exists → suppress
    expect(toggle.onEcho({ opId: a.opId, v: a.v })).toBe("suppress");
    expect(r.peek()).toEqual({ liked: false }); // NOT flipped back to liked
    expect(toggle.stats.suppressed).toBe(1);

    // echo of v2 (current) → dedupe
    expect(toggle.onEcho({ opId: b.opId, v: b.v })).toBe("dedupe");
    expect(toggle.pendingCount()).toBe(0);
  });

  test("multi-pending reject leaves a newer optimistic value; baseline restores on drain", () => {
    const { r } = seededReplica({ items: [] });
    const add = createIntent({ replica: r, optimistic: (x, c) => ({ items: [...c.items, x] }) });
    const a = add.apply("A"); // items:[A]
    const b = add.apply("B"); // items:[A,B]
    expect(r.peek()).toEqual({ items: ["A", "B"] });

    add.reject(a.opId); // b still pending → keep the newer optimistic value
    expect(r.peek()).toEqual({ items: ["A", "B"] });
    expect(add.pendingCount()).toBe(1);

    add.reject(b.opId); // run drains → revert to the confirmed baseline
    expect(r.peek()).toEqual({ items: [] });
    expect(add.peekStatus()).toBe("idle");
  });

  test("status is reactive (a component could render 'saving…')", () => {
    const { r } = seededReplica({ n: 0 });
    const inc = createIntent({ replica: r, optimistic: (_, c) => ({ n: c.n + 1 }) });
    const seen = [];
    const stop = effect(() => seen.push(inc.status));
    expect(seen).toEqual(["idle"]);
    const { opId } = inc.apply();
    inc.confirm(opId);
    expect(seen).toEqual(["idle", "pending", "idle"]);
    stop();
  });

  test("shares the replica's intent counter (INV-sync-12: one monotonic v)", () => {
    const { r } = seededReplica({ n: 0 });
    const a = createIntent({ replica: r, optimistic: (_, c) => ({ n: c.n + 1 }), nextOpId: createOpIds("a") });
    const b = createIntent({ replica: r, optimistic: (_, c) => ({ n: c.n + 1 }), nextOpId: createOpIds("b") });
    expect(a.apply().v).toBe(1);
    expect(b.apply().v).toBe(2); // same underlying replica.nextIntent()
    expect(a.apply().v).toBe(3);
    expect(r.peekIntent()).toBe(3);
  });

  test("integration: optimistic value is overwritten by the authoritative receipt", () => {
    const { t, r } = seededReplica({ n: 0 });
    const inc = createIntent({ replica: r, optimistic: () => ({ n: 1 }) });
    const seen = [];
    const stop = effect(() => seen.push(r.get().n));

    const { opId, v } = inc.apply(); // optimistic n=1
    expect(r.peek()).toEqual({ n: 1 });

    // server confirms + the reconciler receives the authoritative value (n=1, seq 2)
    expect(inc.onEcho({ opId, v })).toBe("dedupe");
    t.publish("e:1", env(2, { n: 1 })); // authoritative apply via Tier-1 ingest
    expect(r.peekMeta().sequence).toBe(2); // reconciler advanced to the confirmed seq
    expect(r.peek()).toEqual({ n: 1 });
    // seed(0) → optimistic(1) → authoritative receipt(1); the receipt re-applies a
    // fresh object, so the effect re-runs even though `n` is unchanged.
    expect(seen).toEqual([0, 1, 1]);
    stop();
  });

  test("guards: a non-replica or missing optimistic throws", () => {
    expect(() => createIntent({ replica: {}, optimistic: () => ({}) })).toThrow(/createClientReplica handle/);
    const { r } = seededReplica({});
    expect(() => createIntent({ replica: r })).toThrow(/optimistic/);
  });
});
