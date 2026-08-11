import { describe, expect, test } from "bun:test";
import { InProcessTransport, createServerSource, invalidate, synced } from "../src/index.js";

const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const statsSchema = {
  parse: (v) =>
    v && typeof v === "object" && typeof v.total === "number"
      ? { tag: "Ok", value: v }
      : { tag: "Err", error: "not Stats" },
};

describe("createServerSource: opaque server sources (§13.8)", () => {
  test("exactly one refresh policy is mandatory", () => {
    const t = new InProcessTransport();
    const base = { key: "stats", run: () => ({ total: 1 }), schema: statsSchema, transport: t };
    expect(() => createServerSource(base)).toThrow("exactly one refresh policy");
    expect(() => createServerSource({ ...base, every: 1000, once: true })).toThrow(
      "exactly one refresh policy"
    );
    createServerSource({ ...base, once: true }).stop(); // one policy: fine
  });

  test("once: a single gated publish at seq 1, then nothing", async () => {
    const t = new InProcessTransport();
    const published = [];
    t.subscribe("stats", (e) => published.push(e));
    let total = 1;
    const src = createServerSource({
      key: "stats",
      run: () => ({ total: total++ }),
      schema: statsSchema,
      transport: t,
      once: true,
    });
    await src.start();
    expect(published).toEqual([{ value: { total: 1 }, schema_version: "1.0", sequence: 1 }]);
    expect(src.seed()).toEqual({ value: { total: 1 }, schema_version: "1.0", sequence: 1 });
    expect(src.stats().runs).toBe(1);
    src.stop();
  });

  test("every: polls on the cadence, +1 sequence per REAL change only", async () => {
    const t = new InProcessTransport();
    const published = [];
    t.subscribe("stats", (e) => published.push(e));
    const values = [{ total: 1 }, { total: 1 }, { total: 2 }]; // middle poll: no change
    let i = 0;
    const src = createServerSource({
      key: "stats",
      run: () => values[Math.min(i++, values.length - 1)],
      schema: statsSchema,
      transport: t,
      every: 10,
    });
    await src.start();
    await sleep(35);
    src.stop();
    expect(published[0]).toEqual({ value: { total: 1 }, schema_version: "1.0", sequence: 1 });
    expect(published[1]).toEqual({ value: { total: 2 }, schema_version: "1.0", sequence: 2 });
    expect(published).toHaveLength(2); // the identical poll published nothing
  });

  test("on: an invalidate() bump re-runs; unrelated keys do not", async () => {
    const t = new InProcessTransport();
    let total = 1;
    const src = createServerSource({
      key: "stats",
      run: () => ({ total: total++ }),
      schema: statsSchema,
      transport: t,
      on: "users:changed",
    });
    await src.start();
    expect(src.stats().runs).toBe(1);
    invalidate(t, "posts:changed");
    await tick();
    expect(src.stats().runs).toBe(1); // not our key
    invalidate(t, "users:changed");
    await tick();
    expect(src.stats().runs).toBe(2);
    expect(src.seed().sequence).toBe(2);
    src.stop();
    invalidate(t, "users:changed");
    await tick();
    expect(src.stats().runs).toBe(2); // stopped: listener released
  });

  test("outbound gate: a run error or parse failure never publishes; clients keep last good", async () => {
    const t = new InProcessTransport();
    const published = [];
    const errors = [];
    t.subscribe("stats", (e) => published.push(e));
    const results = [{ total: 1 }, { junk: true }, new Error("db down"), { total: 2 }];
    let i = 0;
    const src = createServerSource({
      key: "stats",
      run: () => {
        const r = results[i++];
        if (r instanceof Error) throw r;
        return r;
      },
      schema: statsSchema,
      transport: t,
      on: "bump",
      onError: (e, ctx) => errors.push(ctx.phase),
    });
    await src.start(); // publishes total:1
    await src.refresh(); // junk → parse gate
    await src.refresh(); // throw → run error
    await src.refresh(); // total:2 → publishes seq 2 (sequences never skip)
    expect(published).toEqual([
      { value: { total: 1 }, schema_version: "1.0", sequence: 1 },
      { value: { total: 2 }, schema_version: "1.0", sequence: 2 },
    ]);
    expect(errors).toEqual(["parse", "run"]);
    src.stop();
  });

  test("mid-run triggers coalesce into exactly one trailing re-run", async () => {
    const t = new InProcessTransport();
    let release;
    let calls = 0;
    const src = createServerSource({
      key: "stats",
      run: () => {
        calls++;
        return calls === 1 ? new Promise((r) => (release = () => r({ total: 1 }))) : { total: calls };
      },
      schema: statsSchema,
      transport: t,
      on: "bump",
    });
    const started = src.start(); // run 1 in flight, unresolved
    void src.refresh();
    void src.refresh();
    void src.refresh(); // three triggers while running
    release();
    await started;
    await tick();
    expect(src.stats().runs).toBe(2); // 1 in-flight + exactly ONE trailing
    src.stop();
  });

  test("E2E: the client side is plain shipped Tier-1: synced(key, Schema) goes live", async () => {
    const t = new InProcessTransport();
    let total = 40;
    const src = createServerSource({
      key: "stats:global",
      run: () => ({ total: ++total }),
      schema: statsSchema,
      transport: t,
      on: "stats:bump",
    });
    await src.start();

    const cell = synced("stats:global", statsSchema, {
      transport: t,
      seed: src.seed(), // the P9 load path: SSR seed straight off the host
    });
    expect(cell.peek()).toEqual({ total: 41 });

    invalidate(t, "stats:bump");
    await tick();
    expect(cell.peek()).toEqual({ total: 42 }); // seq 2 reconciled by the stock replica
    cell.dispose();
    src.stop();
  });
});

describe("createServerSource: invalidation armed before the seed run", () => {
  test("an invalidate landing DURING the seed run coalesces into a trailing re-run", async () => {
    const t = new InProcessTransport();
    const published = [];
    t.subscribe("stats", (e) => published.push(e));
    let state = 1;
    let release;
    const gate = new Promise((r) => (release = r));
    const src = createServerSource({
      key: "stats",
      run: async () => {
        const snapshot = state;
        await gate; // hold the seed run open
        return { total: snapshot };
      },
      schema: statsSchema,
      transport: t,
      on: "stats:bump",
    });
    const started = src.start();
    await tick();
    state = 2;
    invalidate(t, "stats:bump"); // lands mid-seed-run: must not vanish
    release();
    await started;
    await sleep(5); // the trailing re-run
    expect(published.map((e) => [e.sequence, e.value.total])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    src.stop();
  });
});
