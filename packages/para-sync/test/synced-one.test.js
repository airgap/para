import { describe, expect, test } from "bun:test";
import { InProcessTransport, syncedOne } from "../src/index.js";

const userSchema = {
  parse: (v) =>
    v && typeof v === "object" && typeof v.name === "string"
      ? { tag: "Ok", value: v }
      : { tag: "Err", error: "not a User" },
};
const env = (sequence, value, schema_version = "1.0") => ({ value, schema_version, sequence });

function memStream() {
  let cb;
  return {
    listen(fn) {
      cb = fn;
    },
    emit(m) {
      cb?.(m);
    },
    close() {},
  };
}

describe("syncedOne: scalar query sync (§13.7)", () => {
  test("requires a schema with parse()", () => {
    expect(() => syncedOne(undefined, {})).toThrow("`schema` (with parse) is required");
  });

  test("seed hydrates the scalar immediately (ready at construction)", () => {
    const t = new InProcessTransport();
    const one = syncedOne(userSchema, {
      transport: t,
      seed: { keys: ["user:1"], seeds: { "user:1": env(1, { id: 1, name: "ada" }) } },
    });
    expect(one.ready()).toBe(true);
    expect(one.peek()).toEqual({ id: 1, name: "ada" });
    one.dispose();
  });

  test("pre-ready: peek() is undefined and subscribe stays SILENT (the SWR gate)", () => {
    const t = new InProcessTransport();
    const mem = memStream();
    const one = syncedOne(userSchema, { transport: t, membership: mem });
    const seen = [];
    one.subscribe((v) => seen.push(v));
    expect(one.ready()).toBe(false);
    expect(one.peek()).toBeUndefined();
    expect(seen).toEqual([]); // no emission before the first membership fact

    mem.emit({ keys: ["user:1"], seeds: { "user:1": env(1, { id: 1, name: "ada" }) } });
    expect(one.ready()).toBe(true);
    expect(seen).toEqual([{ id: 1, name: "ada" }]); // ONE emission, never an undefined flash
    one.dispose();
  });

  test("ready with an empty key set emits a REAL undefined (no row matches)", () => {
    const t = new InProcessTransport();
    const mem = memStream();
    const one = syncedOne(userSchema, { transport: t, membership: mem });
    const seen = [];
    one.subscribe((v) => seen.push(v));
    mem.emit({ keys: [] });
    expect(one.ready()).toBe(true);
    expect(seen).toEqual([undefined]);
    one.dispose();
  });

  test("per-row value delta updates the scalar (per-row reconcile)", () => {
    const t = new InProcessTransport();
    const one = syncedOne(userSchema, {
      transport: t,
      seed: { keys: ["user:1"], seeds: { "user:1": env(1, { id: 1, name: "ada" }) } },
    });
    t.publish("user:1", env(2, { id: 1, name: "ada l." }));
    expect(one.peek()).toEqual({ id: 1, name: "ada l." });
    one.dispose();
  });

  test("membership removal transitions to undefined: a deleted row is never retained", () => {
    const t = new InProcessTransport();
    const mem = memStream();
    const one = syncedOne(userSchema, {
      transport: t,
      membership: mem,
      seed: { keys: ["user:1"], seeds: { "user:1": env(1, { id: 1, name: "ada" }) } },
    });
    const seen = [];
    one.subscribe((v) => seen.push(v));
    expect(seen).toEqual([{ id: 1, name: "ada" }]);
    mem.emit({ keys: [] });
    expect(seen).toEqual([{ id: 1, name: "ada" }, undefined]);
    one.dispose();
  });

  test("key replacement swaps the scalar to the new row", () => {
    const t = new InProcessTransport();
    const mem = memStream();
    const one = syncedOne(userSchema, {
      transport: t,
      membership: mem,
      seed: { keys: ["user:1"], seeds: { "user:1": env(1, { id: 1, name: "ada" }) } },
    });
    mem.emit({ keys: ["user:2"], seeds: { "user:2": env(1, { id: 2, name: "grace" }) } });
    expect(one.peek()).toEqual({ id: 2, name: "grace" });
    expect(one.row()).toBeDefined();
    one.dispose();
  });

  test("a row failing the parse gate never reaches the scalar", () => {
    const t = new InProcessTransport();
    const one = syncedOne(userSchema, {
      transport: t,
      seed: { keys: ["user:1"], seeds: { "user:1": env(1, { junk: true }) } },
    });
    expect(one.peek()).toBeUndefined(); // gated out: malformed row is recovery, not data
    one.dispose();
  });

  test("subscribe returns an unsubscribe; dispose is idempotent", () => {
    const t = new InProcessTransport();
    const mem = memStream();
    const one = syncedOne(userSchema, { transport: t, membership: mem });
    const seen = [];
    const stop = one.subscribe((v) => seen.push(v));
    stop();
    mem.emit({ keys: ["user:1"], seeds: { "user:1": env(1, { id: 1, name: "ada" }) } });
    expect(seen).toEqual([]);
    one.dispose();
    one.dispose();
  });

  test("limit defaults to 1 but an explicit multi-row membership still yields the FIRST row", () => {
    const t = new InProcessTransport();
    const mem = memStream();
    const one = syncedOne(userSchema, { transport: t, membership: mem });
    mem.emit({
      keys: ["user:2", "user:1"],
      seeds: { "user:2": env(1, { id: 2, name: "grace" }), "user:1": env(1, { id: 1, name: "ada" }) },
    });
    expect(one.peek()).toEqual({ id: 2, name: "grace" }); // server order wins
    one.dispose();
  });
});
