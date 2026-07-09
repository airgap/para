import { describe, expect, test } from "bun:test";
import { InProcessTransport, syncedQuery } from "../src/index.js";

// A Post row: needs a string `text`.
const postSchema = {
  parse: (v) =>
    v && typeof v === "object" && typeof v.text === "string"
      ? { tag: "Ok", value: v }
      : { tag: "Err", error: "not a Post" },
};
const env = (sequence, value, schema_version = "1.0") => ({ value, schema_version, sequence });

// A hand membership stream for tests.
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

describe("syncedQuery — typed collections (§13.3)", () => {
  test("seed membership hydrates ordered rows; the array reflects row values", () => {
    const t = new InProcessTransport();
    const feed = syncedQuery(postSchema, {
      transport: t,
      seed: {
        keys: ["post:1", "post:2"],
        seeds: { "post:1": env(1, { id: 1, text: "a" }), "post:2": env(1, { id: 2, text: "b" }) },
      },
    });
    expect(feed.peek()).toEqual([{ id: 1, text: "a" }, { id: 2, text: "b" }]);
    expect(feed.rowKeys()).toEqual(["post:1", "post:2"]);
    expect(feed.size()).toBe(2);
  });

  test("a per-row value delta updates the array reactively (per-row reconcile)", () => {
    const t = new InProcessTransport();
    const feed = syncedQuery(postSchema, {
      transport: t,
      seed: { keys: ["post:1"], seeds: { "post:1": env(1, { id: 1, text: "a" }) } },
    });
    const seen = [];
    const stop = feed.subscribe((rows) => seen.push(rows.map((r) => r.text)));
    expect(seen).toEqual([["a"]]);

    t.publish("post:1", env(2, { id: 1, text: "a2" })); // in-order row delta
    expect(seen).toEqual([["a"], ["a2"]]);
    expect(feed.peek()).toEqual([{ id: 1, text: "a2" }]);
    stop();
  });

  test("membership insert (seeded), reorder, and remove — without re-parsing rows", () => {
    const t = new InProcessTransport();
    const mem = memStream();
    const feed = syncedQuery(postSchema, {
      transport: t,
      membership: mem,
      seed: { keys: ["post:1"], seeds: { "post:1": env(1, { id: 1, text: "a" }) } },
    });

    mem.emit({ keys: ["post:1", "post:2"], seeds: { "post:2": env(1, { id: 2, text: "b" }) } }); // insert
    expect(feed.peek()).toEqual([{ id: 1, text: "a" }, { id: 2, text: "b" }]);

    mem.emit({ keys: ["post:2", "post:1"] }); // reorder (no seeds → no re-parse)
    expect(feed.peek()).toEqual([{ id: 2, text: "b" }, { id: 1, text: "a" }]);

    mem.emit({ keys: ["post:2"] }); // remove post:1
    expect(feed.peek()).toEqual([{ id: 2, text: "b" }]);
    expect(feed.size()).toBe(1);
    expect(feed.row("post:1")).toBeUndefined(); // its replica was disposed + dropped
  });

  test("row(key) exposes the row replica (with Tier-2 seams for a per-row §13.5 mutation)", () => {
    const t = new InProcessTransport();
    const feed = syncedQuery(postSchema, {
      transport: t,
      seed: { keys: ["post:1"], seeds: { "post:1": env(1, { id: 1, text: "a" }) } },
    });
    const replica = feed.row("post:1");
    expect(replica.peek()).toEqual({ id: 1, text: "a" });
    expect(typeof replica.nextIntent).toBe("function");
    expect(typeof replica.applyLocal).toBe("function");
  });

  test("dispose tears down the membership stream and every row replica", () => {
    const t = new InProcessTransport();
    let closed = false;
    const mem = { listen() {}, close: () => (closed = true) };
    const feed = syncedQuery(postSchema, {
      transport: t,
      membership: mem,
      seed: { keys: ["post:1"], seeds: { "post:1": env(1, { id: 1, text: "a" }) } },
    });
    feed.dispose();
    expect(closed).toBe(true);
    expect(feed.size()).toBe(0);
    expect(feed.peek()).toEqual([]);
  });

  test("guards: missing schema or transport throw", () => {
    expect(() => syncedQuery(null, { transport: new InProcessTransport() })).toThrow(/schema/);
    expect(() => syncedQuery(postSchema, {})).toThrow(/transport/);
  });
});
