import { describe, expect, test } from "bun:test";
import { InProcessTransport } from "../src/index.js";

const env = (sequence, value = {}, schema_version = "1.0") => ({
  value,
  schema_version,
  sequence,
});

describe("InProcessTransport: SyncTransport contract", () => {
  test("publish delivers the envelope to a subscriber of that key", () => {
    const t = new InProcessTransport();
    const seen = [];
    t.subscribe("user:1", (e) => seen.push(e));
    const e = env(1, { name: "ada" });
    t.publish("user:1", e);
    expect(seen).toEqual([e]);
  });

  test("publish to a key with no subscribers is a silent no-op", () => {
    const t = new InProcessTransport();
    expect(() => t.publish("user:nobody", env(1))).not.toThrow();
  });

  test("multiple subscribers all receive, in subscription order", () => {
    const t = new InProcessTransport();
    const order = [];
    t.subscribe("k", () => order.push("a"));
    t.subscribe("k", () => order.push("b"));
    t.subscribe("k", () => order.push("c"));
    t.publish("k", env(1));
    expect(order).toEqual(["a", "b", "c"]);
  });

  test("key isolation: a subscriber only gets its own key's publishes", () => {
    const t = new InProcessTransport();
    const a = [];
    const b = [];
    t.subscribe("a", (e) => a.push(e.sequence));
    t.subscribe("b", (e) => b.push(e.sequence));
    t.publish("a", env(1));
    t.publish("b", env(2));
    t.publish("a", env(3));
    expect(a).toEqual([1, 3]);
    expect(b).toEqual([2]);
  });

  test("unsub stops delivery", () => {
    const t = new InProcessTransport();
    const seen = [];
    const off = t.subscribe("k", (e) => seen.push(e.sequence));
    t.publish("k", env(1));
    off();
    t.publish("k", env(2));
    expect(seen).toEqual([1]);
  });

  test("unsub is idempotent and does not remove a re-subscribed handler", () => {
    const t = new InProcessTransport();
    const seen = [];
    const handler = (e) => seen.push(e.sequence);
    const off = t.subscribe("k", handler);
    off();
    off(); // second call must be a no-op
    // re-subscribe the SAME handler reference; the stale Unsub must not kill it
    t.subscribe("k", handler);
    off(); // calling the old (already-spent) Unsub again must not unsubscribe
    t.publish("k", env(9));
    expect(seen).toEqual([9]);
  });

  test("does not retain the latest value: a late subscriber gets only future publishes", () => {
    const t = new InProcessTransport();
    t.publish("k", env(1)); // no subscribers yet
    const seen = [];
    t.subscribe("k", (e) => seen.push(e.sequence));
    t.publish("k", env(2));
    expect(seen).toEqual([2]); // never sees seq 1
  });

  test("snapshot semantics: a handler unsubscribing mid-delivery still receives the in-flight envelope", () => {
    const t = new InProcessTransport();
    const seen = [];
    let offB;
    t.subscribe("k", () => {
      offB(); // A unsubscribes B during this same delivery
    });
    offB = t.subscribe("k", (e) => seen.push(e.sequence));
    t.publish("k", env(1));
    // B was live at publish time → it receives seq 1 (snapshot), then is gone
    expect(seen).toEqual([1]);
    t.publish("k", env(2));
    expect(seen).toEqual([1]); // not seq 2
  });

  test("snapshot semantics: a handler subscribing mid-delivery does NOT receive the in-flight envelope", () => {
    const t = new InProcessTransport();
    const late = [];
    t.subscribe("k", () => {
      t.subscribe("k", (e) => late.push(e.sequence)); // added during delivery
    });
    t.publish("k", env(1));
    expect(late).toEqual([]); // not in the snapshot for seq 1
    t.publish("k", env(2));
    expect(late).toEqual([2]); // gets subsequent publishes
  });

  test("GC: the key entry is removed once its last subscriber unsubscribes", () => {
    const t = new InProcessTransport();
    const o1 = t.subscribe("k", () => {});
    const o2 = t.subscribe("k", () => {});
    expect(t.keyCount()).toBe(1);
    o1();
    expect(t.keyCount()).toBe(1); // still one live subscriber
    o2();
    expect(t.keyCount()).toBe(0); // last one gone → key GC'd
  });

  test("keyCount tracks distinct keys", () => {
    const t = new InProcessTransport();
    t.subscribe("a", () => {});
    t.subscribe("b", () => {});
    t.subscribe("a", () => {}); // second sub on same key
    expect(t.keyCount()).toBe(2);
  });
});
