import { describe, expect, test } from "bun:test";
import { NatsTransport, createClientReplica } from "../src/index.js";

// A minimal in-memory NATS double matching the callback-adapted
// SyncNatsConnection shape: publish(subject, payload) fans out to every
// subscriber of that subject; subscribe returns an unsubscribe.
class FakeNats {
  constructor() {
    this.subjects = new Map(); // subject -> Set<onMessage>
    this.subscribeCalls = 0;
  }
  publish(subject, payload) {
    const set = this.subjects.get(subject);
    if (!set) return;
    for (const onMsg of Array.from(set)) onMsg(payload);
  }
  subscribe(subject, onMessage) {
    this.subscribeCalls++;
    let set = this.subjects.get(subject);
    if (!set) {
      set = new Set();
      this.subjects.set(subject, set);
    }
    set.add(onMessage);
    return () => {
      const s = this.subjects.get(subject);
      if (!s) return;
      s.delete(onMessage);
      if (s.size === 0) this.subjects.delete(subject);
    };
  }
}

// JSON-over-bytes codec: proves encode/decode are actually exercised (payloads
// on the bus are Uint8Array, handlers receive decoded objects). Production
// injects BON/msgpackr; test envelopes use plain numbers so JSON is fine.
const jsonCodec = {
  encode: (env) => new TextEncoder().encode(JSON.stringify(env)),
  decode: (buf) => JSON.parse(new TextDecoder().decode(buf))
};

const env = (sequence, value, schema_version = "1.0") => ({ value, schema_version, sequence });

describe("NatsTransport: SyncTransport contract over a bus", () => {
  test("publish → subscriber receives the codec-roundtripped envelope", () => {
    const nc = new FakeNats();
    const t = new NatsTransport({ connection: nc, codec: jsonCodec });
    const seen = [];
    t.subscribe("user:1", (e) => seen.push(e));
    t.publish("user:1", env(1, { name: "ada" }));
    expect(seen).toEqual([env(1, { name: "ada" })]);
  });

  test("the bus actually carries bytes (codec invoked, not object passthrough)", () => {
    const nc = new FakeNats();
    const t = new NatsTransport({ connection: nc, codec: jsonCodec });
    let busPayload;
    // sniff the raw payload on the subject
    nc.subscribe("synced.user:1", (p) => (busPayload = p));
    t.publish("user:1", env(1, { name: "ada" }));
    expect(busPayload).toBeInstanceOf(Uint8Array);
  });

  test("custom subjectOf maps keys to subjects", () => {
    const nc = new FakeNats();
    const t = new NatsTransport({
      connection: nc,
      codec: jsonCodec,
      subjectOf: (key) => key.replace(":", ".") // "user:1" → "user.1", Lyku-style
    });
    const seen = [];
    t.subscribe("user:1", (e) => seen.push(e.sequence));
    expect(nc.subjects.has("user.1")).toBe(true);
    nc.publish("user.1", jsonCodec.encode(env(9, { name: "x" })));
    expect(seen).toEqual([9]);
  });

  test("local fanout: N subscribers to one key share ONE bus subscription", () => {
    const nc = new FakeNats();
    const t = new NatsTransport({ connection: nc, codec: jsonCodec });
    const a = [];
    const b = [];
    t.subscribe("k", (e) => a.push(e.sequence));
    t.subscribe("k", (e) => b.push(e.sequence));
    expect(nc.subscribeCalls).toBe(1); // not 2: one bus sub, local fanout
    t.publish("k", env(1, {}));
    expect(a).toEqual([1]);
    expect(b).toEqual([1]);
  });

  test("key isolation", () => {
    const nc = new FakeNats();
    const t = new NatsTransport({ connection: nc, codec: jsonCodec });
    const a = [];
    t.subscribe("a", (e) => a.push(e.sequence));
    t.subscribe("b", () => {});
    t.publish("b", env(2, {}));
    expect(a).toEqual([]);
  });

  test("last unsub tears down the bus subscription; unsub is idempotent", () => {
    const nc = new FakeNats();
    const t = new NatsTransport({ connection: nc, codec: jsonCodec });
    const off1 = t.subscribe("k", () => {});
    const off2 = t.subscribe("k", () => {});
    expect(t.keyCount()).toBe(1);
    off1();
    off1(); // idempotent
    expect(t.keyCount()).toBe(1); // off2 still live
    expect(nc.subjects.has("synced.k")).toBe(true);
    off2();
    expect(t.keyCount()).toBe(0);
    expect(nc.subjects.has("synced.k")).toBe(false); // bus sub gone
  });

  test("cross-instance: a publish on one transport reaches a subscriber on another (multi-service)", () => {
    const nc = new FakeNats(); // the shared bus
    const writer = new NatsTransport({ connection: nc, codec: jsonCodec });
    const listener = new NatsTransport({ connection: nc, codec: jsonCodec });
    const seen = [];
    listener.subscribe("user:1", (e) => seen.push(e.value.name));
    writer.publish("user:1", env(1, { name: "from-other-service" }));
    expect(seen).toEqual(["from-other-service"]);
  });

  test("requires a connection", () => {
    expect(() => new NatsTransport({})).toThrow("requires a connection");
  });
});

describe("NatsTransport ↔ createClientReplica (transport-agnostic reconciler)", () => {
  const userSchema = {
    parse: (v) =>
      v && typeof v === "object" && typeof v.name === "string"
        ? { tag: "Ok", value: v }
        : { tag: "Err", error: "not a User" }
  };

  test("the same client reconciler drives correctly over NatsTransport", () => {
    const nc = new FakeNats();
    const transport = new NatsTransport({ connection: nc, codec: jsonCodec });
    const r = createClientReplica({
      key: "user:1",
      schema: userSchema,
      transport,
      seed: env(1, { name: "ada" })
    });
    const r2 = createClientReplica({
      key: "user:1",
      schema: userSchema,
      transport
    }); // seed-less second replica on same key (e.g., another component)

    transport.publish("user:1", env(2, { name: "ada-2" }));

    expect(r.peek()).toEqual({ name: "ada-2" });
    expect(r.peekMeta().sequence).toBe(2);
    expect(r2.peek()).toEqual({ name: "ada-2" }); // both fanned out from one bus sub
    expect(nc.subscribeCalls).toBe(1);
    r.dispose();
    r2.dispose();
    expect(transport.keyCount()).toBe(0);
  });
});
