import { describe, expect, test } from "bun:test";
import {
  signal,
  derived,
  effect,
  batch,
  untrack,
  resource,
  fromAsyncIter,
  fromStream,
  fromEventTarget,
  throttled,
  debounced,
  __test,
} from "../src/index.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));

describe("core: signal / derived / effect / batch / untrack", () => {
  test("signal read+write", () => {
    const s = signal(1);
    expect(s.get()).toBe(1);
    s.set(2);
    expect(s.get()).toBe(2);
  });

  test("derived recomputes on dep change", () => {
    const s = signal(2);
    const d = derived(() => s.get() * 10);
    expect(d.get()).toBe(20);
    s.set(3);
    expect(d.get()).toBe(30);
  });

  test("effect fires immediately and on changes", () => {
    const s = signal(1);
    const seen = [];
    const stop = effect(() => seen.push(s.get()));
    s.set(2);
    s.set(3);
    expect(seen).toEqual([1, 2, 3]);
    stop();
    s.set(4);
    expect(seen).toEqual([1, 2, 3]);
  });

  test("batch defers effects", () => {
    const a = signal(1);
    const b = signal(2);
    const seen = [];
    effect(() => seen.push(a.get() + b.get()));
    batch(() => {
      a.set(10);
      b.set(20);
    });
    expect(seen).toEqual([3, 30]);
  });

  test("untrack reads without subscribing", () => {
    const tracked = signal(1);
    const skipped = signal(100);
    let runs = 0;
    effect(() => {
      runs++;
      tracked.get() + untrack(() => skipped.get());
    });
    skipped.set(200);
    expect(runs).toBe(1);
    tracked.set(2);
    expect(runs).toBe(2);
  });
});

describe("resource: lifecycle + alive + use()", () => {
  test("setup exports become handle properties", () => {
    const r = resource(({ signal: sig }) => {
      const a = sig(1);
      const b = sig("x");
      return { a, b };
    });
    expect(r.a.get()).toBe(1);
    expect(r.b.get()).toBe("x");
    expect(r.alive.get()).toBe(true);
  });

  test("dispose runs cleanups in reverse order", () => {
    const order = [];
    const r = resource(({ onDispose }) => {
      onDispose(() => order.push("first-registered"));
      onDispose(() => order.push("second-registered"));
      return {};
    });
    r.dispose();
    expect(order).toEqual(["second-registered", "first-registered"]);
    expect(r.alive.get()).toBe(false);
  });

  test("dispose is idempotent", () => {
    let calls = 0;
    const r = resource(({ onDispose }) => {
      onDispose(() => calls++);
      return {};
    });
    r.dispose();
    r.dispose();
    r.dispose();
    expect(calls).toBe(1);
  });

  test("[Symbol.dispose] calls dispose()", () => {
    let cleaned = false;
    const r = resource(({ onDispose }) => {
      onDispose(() => (cleaned = true));
      return {};
    });
    r[Symbol.dispose]();
    expect(cleaned).toBe(true);
  });

  test("setup throw rolls back partial cleanups", () => {
    let cleaned = false;
    expect(() => {
      resource(({ onDispose }) => {
        onDispose(() => (cleaned = true));
        throw new Error("setup failed");
      });
    }).toThrow(/setup failed/);
    expect(cleaned).toBe(true);
  });

  test(".use(fn) auto-disposes on resource close", () => {
    const r = resource(({ signal: sig }) => ({ v: sig(1) }));
    let runs = 0;
    r.use(() => {
      runs++;
      r.v.get();
    });
    expect(runs).toBe(1);
    r.v.set(2);
    expect(runs).toBe(2);
    r.dispose();
    r.v.set(3); // signal still settable but no observers; effect was disposed
    expect(runs).toBe(2);
  });

  test("alive signal flips to false on dispose (one final notification)", () => {
    const r = resource(({ signal: sig }) => ({ v: sig(0) }));
    const seen = [];
    effect(() => seen.push(r.alive.get()));
    expect(seen).toEqual([true]);
    r.dispose();
    expect(seen).toEqual([true, false]);
  });
});

describe("fromAsyncIter", () => {
  test("pumps values from an async generator into a signal", async () => {
    async function* src() {
      yield 1;
      await sleep(5);
      yield 2;
      yield 3;
    }
    const r = fromAsyncIter(src(), 0);
    await sleep(30);
    expect(r.value.get()).toBe(3);
    r.dispose();
  });

  test("dispose calls iterator.return() to stop the source", async () => {
    let returnCalled = false;
    const src = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            return new Promise(resolve => setTimeout(() => resolve({ value: Math.random(), done: false }), 5));
          },
          return() {
            returnCalled = true;
            return Promise.resolve({ done: true });
          },
        };
      },
    };
    const r = fromAsyncIter(src);
    await sleep(20);
    r.dispose();
    await sleep(10);
    expect(returnCalled).toBe(true);
  });
});

describe("fromStream", () => {
  test("pumps a ReadableStream into a signal", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue("a");
        controller.enqueue("b");
        controller.enqueue("c");
        controller.close();
      },
    });
    const r = fromStream(stream, "");
    await sleep(20);
    expect(r.value.get()).toBe("c");
    r.dispose();
  });

  test("dispose cancels the reader", async () => {
    let cancelled = false;
    let closed = false;
    const stream = new ReadableStream({
      pull(controller) {
        return new Promise(resolve => {
          setTimeout(() => {
            // Stream may already have been cancelled: don't enqueue
            // through a closed controller.
            if (!closed) {
              try {
                controller.enqueue(Math.random());
              } catch {}
            }
            resolve();
          }, 5);
        });
      },
      cancel() {
        cancelled = true;
        closed = true;
      },
    });
    const r = fromStream(stream);
    await sleep(20);
    r.dispose();
    await sleep(20);
    expect(cancelled).toBe(true);
  });
});

describe("fromEventTarget", () => {
  test("listens for events and updates the signal", () => {
    const target = new EventTarget();
    const r = fromEventTarget(target, "ping", { initial: 0, map: e => e.detail });
    target.dispatchEvent(new CustomEvent("ping", { detail: 7 }));
    expect(r.value.get()).toBe(7);
    target.dispatchEvent(new CustomEvent("ping", { detail: 9 }));
    expect(r.value.get()).toBe(9);
    r.dispose();
  });

  test("dispose removes the listener", () => {
    const target = new EventTarget();
    const r = fromEventTarget(target, "ping", { initial: 0, map: e => e.detail });
    target.dispatchEvent(new CustomEvent("ping", { detail: 1 }));
    expect(r.value.get()).toBe(1);
    r.dispose();
    target.dispatchEvent(new CustomEvent("ping", { detail: 99 }));
    expect(r.value.get()).toBe(1);
  });
});

describe("throttled", () => {
  test("emits leading immediately then trailing after window", async () => {
    const s = signal(0);
    const t = throttled(s, 50);
    const seen = [];
    effect(() => seen.push(t.value.get()));
    expect(seen).toEqual([0]);
    s.set(1); // leading: emits now (gap from 0)
    s.set(2); // coalesced
    s.set(3); // coalesced; trailing should fire ~50ms later with 3
    await sleep(80);
    expect(seen[seen.length - 1]).toBe(3);
    expect(seen).toContain(1);
    t.dispose();
  });

  test("dispose stops both the upstream effect and the trailing timer", async () => {
    const s = signal(0);
    const t = throttled(s, 30);
    s.set(1);
    s.set(2);
    t.dispose();
    s.set(3);
    await sleep(50);
    // Last value seen should not be 3 (effect was disposed).
    expect(t.value.peek()).not.toBe(3);
  });
});

describe("debounced", () => {
  test("only emits after silence", async () => {
    const s = signal(0);
    const d = debounced(s, 30);
    const seen = [];
    effect(() => seen.push(d.value.get()));
    expect(seen).toEqual([0]); // initial signal value
    s.set(1);
    await sleep(10);
    s.set(2);
    await sleep(10);
    s.set(3);
    await sleep(50);
    // After 30ms of silence following the last `3`, the debounced
    // signal should emit 3. Initial seen was [0]; expect to see 3 next.
    expect(seen[seen.length - 1]).toBe(3);
    expect(seen).not.toContain(1);
    expect(seen).not.toContain(2);
    d.dispose();
  });

  test("dispose clears pending timer", async () => {
    const s = signal(0);
    const d = debounced(s, 30);
    s.set(99);
    d.dispose();
    await sleep(60);
    expect(d.value.peek()).not.toBe(99);
  });
});

import { proxySignal } from "../src/index.js";

describe("proxySignal: deep-reactive object/array state", () => {
  test("primitive / non-plain values pass through unchanged", () => {
    expect(proxySignal(5)).toBe(5);
    expect(proxySignal("hi")).toBe("hi");
    expect(proxySignal(null)).toBe(null);
    const d = new Date();
    expect(proxySignal(d)).toBe(d);
  });

  test("top-level property: read tracks, write notifies", () => {
    const state = proxySignal({ count: 0 });
    let seen = -1;
    const stop = effect(() => {
      seen = state.count;
    });
    expect(seen).toBe(0);
    state.count = 5;
    expect(seen).toBe(5);
    state.count = 7;
    expect(seen).toBe(7);
    stop();
  });

  test("nested object: deep mutation fires", () => {
    const state = proxySignal({ user: { name: "a", age: 1 } });
    let name = "";
    const stop = effect(() => {
      name = state.user.name;
    });
    expect(name).toBe("a");
    state.user.name = "b";
    expect(name).toBe("b");
    stop();
  });

  test("nested object: replace whole subtree", () => {
    const state = proxySignal({ user: { name: "a" } });
    let name = "";
    const stop = effect(() => {
      name = state.user.name;
    });
    expect(name).toBe("a");
    state.user = { name: "z" };
    expect(name).toBe("z");
    stop();
  });

  test("array: indexed read + write", () => {
    const state = proxySignal(["a", "b", "c"]);
    let v = "";
    const stop = effect(() => {
      v = state[0];
    });
    expect(v).toBe("a");
    state[0] = "z";
    expect(v).toBe("z");
    stop();
  });

  test("array: length tracks push", () => {
    const state = proxySignal([1, 2]);
    let len = 0;
    const stop = effect(() => {
      len = state.length;
    });
    expect(len).toBe(2);
    state.push(3);
    expect(len).toBe(3);
    state.push(4, 5);
    expect(len).toBe(5);
    stop();
  });

  test("array: iteration via for...of", () => {
    const state = proxySignal([1, 2, 3]);
    let sum = 0;
    const stop = effect(() => {
      sum = 0;
      for (const x of state) sum += x;
    });
    expect(sum).toBe(6);
    state.push(4);
    expect(sum).toBe(10);
    stop();
  });

  test("new key: `in` and Object.keys re-fire on add", () => {
    const state = proxySignal({ a: 1 });
    let hasB = false;
    let keys = [];
    const stop1 = effect(() => {
      hasB = "b" in state;
    });
    const stop2 = effect(() => {
      keys = Object.keys(state);
    });
    expect(hasB).toBe(false);
    expect(keys).toEqual(["a"]);
    state.b = 2;
    expect(hasB).toBe(true);
    expect(keys).toEqual(["a", "b"]);
    stop1();
    stop2();
  });

  test("delete property: clears + notifies", () => {
    const state = proxySignal({ a: 1, b: 2 });
    let v = -1;
    const stop = effect(() => {
      v = state.a ?? -1;
    });
    expect(v).toBe(1);
    delete state.a;
    expect(v).toBe(-1);
    stop();
  });

  test("re-proxy is a no-op (no double-proxying)", () => {
    const a = proxySignal({ x: 1 });
    const b = proxySignal(a);
    expect(b).toBe(a);
  });

  test("derived over proxy field tracks correctly", () => {
    const state = proxySignal({ a: 2, b: 3 });
    const d = derived(() => state.a * state.b);
    expect(d.get()).toBe(6);
    state.a = 5;
    expect(d.get()).toBe(15);
    state.b = 7;
    expect(d.get()).toBe(35);
  });
});

describe("empty-subs guard (PLAN synced<T> Prereq A)", () => {
  // The guard is a performance optimization that is SEMANTICALLY TRANSPARENT,
  // so behavior-only assertions can't distinguish it from the old code (both
  // produce identical effect-firing). We assert it deterministically via the
  // drain counter: a subscriber-less write must perform ZERO drains.

  test("subscriber-less set() performs zero drains (and value still observable)", () => {
    __test.resetDrainCount();
    const s = signal(0);
    s.set(1);
    s.set(2);
    s.set(3);
    expect(__test.drainCount()).toBe(0); // pre-guard this was 3
    expect(s.get()).toBe(3);
    expect(s.peek()).toBe(3);
  });

  test("subscribed set() still drains once per write and fires effects", () => {
    const s = signal(0);
    const seen = [];
    const stop = effect(() => seen.push(s.get()));
    __test.resetDrainCount();
    s.set(1);
    s.set(2);
    expect(seen).toEqual([0, 1, 2]);
    expect(__test.drainCount()).toBe(2);
    stop();
  });

  test("removing the last subscriber returns set() to the zero-drain path", () => {
    const s = signal(0);
    const stop = effect(() => s.get());
    stop(); // disposes the effect → unsubscribes from s
    __test.resetDrainCount();
    s.set(1);
    expect(__test.drainCount()).toBe(0);
    expect(s.get()).toBe(1);
  });

  test("equality short-circuit unaffected (no drain on same-value write)", () => {
    __test.resetDrainCount();
    const s = signal(7);
    s.set(7); // Object.is-equal → returns before the guard
    expect(__test.drainCount()).toBe(0);
  });

  test("guard does not break batched coalescing (one drain at batch exit)", () => {
    const a = signal(1);
    const b = signal(2);
    const seen = [];
    effect(() => seen.push(a.get() + b.get()));
    __test.resetDrainCount();
    batch(() => {
      a.set(10);
      b.set(20);
    });
    expect(seen).toEqual([3, 30]);
    expect(__test.drainCount()).toBe(1);
  });
});
