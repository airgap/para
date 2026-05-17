import { test, expect } from "bun:test";
import { promiseSignal } from "../src/index.js";

const tick = () => new Promise(r => setTimeout(r, 0));

test("starts pending, satisfies the source convention", () => {
  const ps = promiseSignal(() => new Promise(() => {}));
  expect(typeof ps.peek).toBe("function");
  expect(typeof ps.subscribe).toBe("function");
  expect(typeof ps.dispose).toBe("function");
  expect(ps.peek()).toEqual({ data: undefined, error: undefined, pending: true });
  ps.dispose();
});

test("resolve → { data, pending:false }", async () => {
  const ps = promiseSignal(() => Promise.resolve(42));
  await tick();
  expect(ps.peek()).toEqual({ data: 42, error: undefined, pending: false });
});

test("reject → { error, pending:false }", async () => {
  const err = new Error("boom");
  const ps = promiseSignal(() => Promise.reject(err));
  await tick();
  expect(ps.peek()).toEqual({ data: undefined, error: err, pending: false });
});

test("subscribe observes the pending → settled transition", async () => {
  const ps = promiseSignal(() => Promise.resolve("ok"));
  const seen = [];
  ps.subscribe(v => seen.push(v.pending));
  await tick();
  expect(ps.peek().data).toBe("ok");
  expect(seen).toContain(false); // saw the settle
});

test("dispose before settle drops the late result (no stale state)", async () => {
  let resolve;
  const ps = promiseSignal(() => new Promise(r => (resolve = r)));
  ps.dispose();
  resolve("late");
  await tick();
  expect(ps.peek()).toEqual({ data: undefined, error: undefined, pending: true });
});

test("thunk receives an AbortSignal that aborts on dispose", async () => {
  let received;
  const ps = promiseSignal(abort => {
    received = abort;
    return new Promise(() => {});
  });
  expect(received).toBeInstanceOf(AbortSignal);
  expect(received.aborted).toBe(false);
  ps.dispose();
  expect(received.aborted).toBe(true);
});
