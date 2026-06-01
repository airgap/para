import { describe, expect, test } from "bun:test";
import { effect } from "@lyku/para-signals";
import { InProcessTransport, synced } from "../src/index.js";

// Same hand-rolled gate as client.test.js: a valid User has a string `name`.
const userSchema = {
  parse: (v) =>
    v && typeof v === "object" && typeof v.name === "string"
      ? { tag: "Ok", value: v }
      : { tag: "Err", error: "not a User" }
};

const env = (sequence, value, schema_version = "1.0") => ({ value, schema_version, sequence });

/**
 * Controllable fake of a receipt stream ({ listen, close }). `factory` is what
 * `synced({ stream })` receives; `emit` pushes an envelope to the registered
 * listener; `closed` records teardown.
 */
function fakeStream() {
  let cb = null;
  const state = { closed: false, listens: 0 };
  return {
    factory: () => ({
      listen: (fn) => {
        cb = fn;
        state.listens++;
      },
      close: () => {
        state.closed = true;
      }
    }),
    emit: (envelope) => {
      if (cb) cb(envelope);
    },
    state
  };
}

describe("synced — stream bridge + reactive handle", () => {
  test("seed hydrates the handle through to .peek()/.value", () => {
    const s = synced("user:1", { schema: userSchema, seed: env(1, { name: "ada" }) });
    expect(s.peek()).toEqual({ name: "ada" });
    expect(s.value).toEqual({ name: "ada" });
    expect(s.status).toBe("ok");
    s.dispose();
  });

  test("stream envelopes flow into the value (the bridge)", () => {
    const stream = fakeStream();
    const s = synced("user:1", { schema: userSchema, stream: stream.factory });

    expect(stream.state.listens).toBe(1); // stream opened + listened exactly once
    expect(s.peek()).toBeUndefined(); // seed-less: nothing until first receipt

    stream.emit(env(1, { name: "ada" }));
    expect(s.peek()).toEqual({ name: "ada" });

    stream.emit(env(2, { name: "grace" }));
    expect(s.peek()).toEqual({ name: "grace" });
    s.dispose();
  });

  test(".value is a tracked read — a para effect re-runs on apply", () => {
    const stream = fakeStream();
    const s = synced("user:1", { schema: userSchema, stream: stream.factory });

    const seen = [];
    const stop = effect(() => seen.push(s.value?.name ?? null));
    expect(seen).toEqual([null]); // ran once, seed-less

    stream.emit(env(1, { name: "ada" }));
    stream.emit(env(2, { name: "grace" }));
    expect(seen).toEqual([null, "ada", "grace"]);

    stop();
    s.dispose();
  });

  test(".status tracks reconcile state across a skew + recovery", async () => {
    const stream = fakeStream();
    const s = synced("user:1", {
      schema: userSchema,
      schemaVersion: "1.0",
      stream: stream.factory,
      // Recovery snapshot is on the client's compatible version.
      refetch: async () => env(5, { name: "snapshot" }, "1.0")
    });

    stream.emit(env(1, { name: "ada" }, "1.0"));
    expect(s.status).toBe("ok");

    // MAJOR-mismatched envelope: not applied; since a refetch is available the
    // status moves skew → refetching synchronously (recovery in flight).
    stream.emit(env(2, { name: "v2" }, "2.0"));
    expect(s.status).toBe("refetching");
    expect(s.peek()).toEqual({ name: "ada" }); // unchanged — skew did not poison

    await s.whenIdle();
    expect(s.peek()).toEqual({ name: "snapshot" }); // recovered
    expect(s.status).toBe("ok");
    s.dispose();
  });

  test("dispose() closes the stream and stops further updates; idempotent", () => {
    const stream = fakeStream();
    const s = synced("user:1", { schema: userSchema, stream: stream.factory });

    stream.emit(env(1, { name: "ada" }));
    expect(s.peek()).toEqual({ name: "ada" });

    s.dispose();
    expect(stream.state.closed).toBe(true);

    // Post-dispose envelopes are ignored (replica unsubscribed).
    stream.emit(env(2, { name: "grace" }));
    expect(s.peek()).toEqual({ name: "ada" });

    s.dispose(); // idempotent — no throw
  });

  test("injected transport: receipts arrive via transport.publish, stream omitted", () => {
    const tx = new InProcessTransport();
    const s = synced("user:7", { schema: userSchema, transport: tx });

    tx.publish("user:7", env(1, { name: "ada" }));
    expect(s.peek()).toEqual({ name: "ada" });

    s.dispose();
    // Replica unsubscribed → the key is GC'd (no leak).
    expect(tx.keyCount()).toBe(0);
  });

  test("cell override: applied values land in the injected cell", () => {
    const stream = fakeStream();
    let held;
    const writes = [];
    const cell = {
      get: () => held,
      peek: () => held,
      set: (v) => {
        held = v;
        writes.push(v);
      }
    };
    const s = synced("user:1", { schema: userSchema, stream: stream.factory, cell });

    stream.emit(env(1, { name: "ada" }));
    expect(held).toEqual({ name: "ada" });
    expect(writes).toEqual([{ name: "ada" }]);
    s.dispose();
  });

  test("stats are observable through the handle", () => {
    const stream = fakeStream();
    const s = synced("user:1", { schema: userSchema, stream: stream.factory });

    stream.emit(env(1, { name: "ada" })); // applied
    stream.emit(env(1, { name: "dup" })); // stale (<= current)
    stream.emit(env(2, { bad: true })); // parse Err → skew (no refetch)

    expect(s.stats.applied).toBe(1);
    expect(s.stats.ignoredStale).toBe(1);
    expect(s.stats.parseErrors).toBe(1);
    s.dispose();
  });

  describe("argument validation", () => {
    test("throws on a missing/empty key", () => {
      expect(() => synced("", { schema: userSchema })).toThrow(/non-empty string/);
      // @ts-expect-error — exercising the runtime guard
      expect(() => synced(undefined, { schema: userSchema })).toThrow(/non-empty string/);
    });

    test("throws when schema has no parse", () => {
      // @ts-expect-error — exercising the runtime guard
      expect(() => synced("k", {})).toThrow(/schema/);
      // @ts-expect-error — exercising the runtime guard
      expect(() => synced("k", { schema: {} })).toThrow(/schema/);
    });
  });
});
