import { test, expect } from "bun:test";
import { querySignal } from "../src/index.js";

const tick = () => new Promise(r => setTimeout(r, 0));

// A toy schema whose parse doubles the value — proves the cell stores
// the PARSED value, not the raw settle.
const Doubler = { parse: v => ({ tag: "Ok", value: v * 2 }) };
const RejectAll = { parse: () => ({ tag: "Err", error: "expected nothing" }) };
const Identity = { parse: v => ({ tag: "Ok", value: v }) };

test("requires a schema with parse()", () => {
  expect(() => querySignal(() => 1, undefined)).toThrow("no parse(value) method");
  expect(() => querySignal(() => 1, { schema: true })).toThrow("no parse(value) method");
});

test("starts pending, satisfies the source convention", () => {
  const qs = querySignal(() => new Promise(() => {}), Identity);
  expect(typeof qs.peek).toBe("function");
  expect(typeof qs.subscribe).toBe("function");
  expect(typeof qs.dispose).toBe("function");
  expect(qs.peek()).toEqual({ data: undefined, error: undefined, pending: true });
  qs.dispose();
});

test("resolve → parse Ok → the PARSED value lands in data", async () => {
  const qs = querySignal(() => Promise.resolve(21), Doubler);
  await tick();
  expect(qs.peek()).toEqual({ data: 42, error: undefined, pending: false });
});

test("parse Err → error state, no throw, data cleared", async () => {
  const qs = querySignal(() => Promise.resolve("junk"), RejectAll, { prev: { data: "old" } });
  await tick();
  expect(qs.peek()).toEqual({ data: undefined, error: "expected nothing", pending: false });
});

test("reject → { error, pending:false }", async () => {
  const err = new Error("net down");
  const qs = querySignal(() => Promise.reject(err), Identity);
  await tick();
  expect(qs.peek()).toEqual({ data: undefined, error: err, pending: false });
});

test("sync throw in thunk routes to error", async () => {
  const qs = querySignal(() => {
    throw new Error("sync boom");
  }, Identity);
  await tick();
  expect(qs.peek().error?.message).toBe("sync boom");
});

test("a throwing parse routes to error, never escapes", async () => {
  const qs = querySignal(() => Promise.resolve(1), {
    parse: () => {
      throw new Error("parse blew up");
    },
  });
  await tick();
  expect(qs.peek().error?.message).toBe("parse blew up");
});

test("a non-Result parse return is surfaced as an error", async () => {
  const qs = querySignal(() => Promise.resolve(1), { parse: v => v });
  await tick();
  expect(qs.peek().error?.message).toContain("non-Result");
});

test("stale-while-revalidate: prev.data seeds the pending state", () => {
  const qs = querySignal(() => new Promise(() => {}), Identity, {
    prev: { data: { name: "cached" }, error: undefined, pending: false },
  });
  expect(qs.peek()).toEqual({ data: { name: "cached" }, error: undefined, pending: true });
  qs.dispose();
});

test("settle replaces the stale seed", async () => {
  const qs = querySignal(() => Promise.resolve("fresh"), Identity, { prev: { data: "cached" } });
  expect(qs.peek().data).toBe("cached");
  await tick();
  expect(qs.peek()).toEqual({ data: "fresh", error: undefined, pending: false });
});

test("dispose before settle drops the late result (latest-wins across re-keys)", async () => {
  let resolve;
  const qs = querySignal(() => new Promise(r => (resolve = r)), Identity, { prev: { data: "kept" } });
  qs.dispose();
  resolve("late");
  await tick();
  expect(qs.peek()).toEqual({ data: "kept", error: undefined, pending: true });
});

test("thunk receives an AbortSignal that aborts on dispose", () => {
  let received;
  const qs = querySignal(s => {
    received = s;
    return new Promise(() => {});
  }, Identity);
  expect(received?.aborted).toBe(false);
  qs.dispose();
  expect(received?.aborted).toBe(true);
});

test("subscribe observes the pending → settled transition", async () => {
  const qs = querySignal(() => Promise.resolve("ok"), Identity);
  const seen = [];
  qs.subscribe(v => seen.push(v.pending));
  await tick();
  expect(qs.peek().data).toBe("ok");
  expect(seen).toContain(false);
});
