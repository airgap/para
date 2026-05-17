import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPool, pmap, preduce, run, disposeWorkers } from "../src/index.js";

// Each describe creates its own pool and disposes after the block.
// Bun's `afterEach` runs across describe boundaries too.

describe("pmap", () => {
  let pool;
  beforeEach(() => (pool = createPool({ concurrency: 4 })));
  afterEach(async () => pool.dispose());

  test("returns mapped values for plain arrays", async () => {
    const out = await pool.pmap(x => x * 2, [1, 2, 3, 4, 5, 6, 7, 8]);
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
  });

  test("returns same TypedArray subclass for typed input", async () => {
    const arr = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const out = await pool.pmap(x => x + 1, arr);
    expect(out).toBeInstanceOf(Float32Array);
    expect(Array.from(out)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("preserves original index across chunk boundaries", async () => {
    const out = await pool.pmap((_, i) => i, [0, 0, 0, 0, 0, 0, 0, 0]);
    expect(out).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("respects concurrency option", async () => {
    const small = await pool.pmap(x => x * 10, [1, 2], { concurrency: 1 });
    expect(small).toEqual([10, 20]);
  });

  test("propagates errors thrown inside the worker fn", async () => {
    await expect(
      pool.pmap(
        x => {
          if (x === 3) throw new Error("boom");
          return x;
        },
        [1, 2, 3, 4],
      ),
    ).rejects.toThrow(/boom/);
  });
});

describe("preduce", () => {
  let pool;
  beforeEach(() => (pool = createPool({ concurrency: 4 })));
  afterEach(async () => pool.dispose());

  test("sum reduction over typed array", async () => {
    const arr = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const total = await pool.preduce((a, b) => a + b, arr, 0);
    expect(total).toBe(55);
  });

  test("fused mapFn applies before reducer", async () => {
    const arr = [1, 2, 3, 4, 5];
    const total = await pool.preduce((a, b) => a + b, arr, 0, { mapFn: x => x * x });
    expect(total).toBe(55); // 1 + 4 + 9 + 16 + 25
  });

  test("partials fold combines associative reducers correctly", async () => {
    // Max is associative; chunk maxes then final-fold gives the global max.
    const max = await pool.preduce((a, b) => (a > b ? a : b), [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5], -Infinity);
    expect(max).toBe(9);
  });
});

describe("run (one-off dispatch)", () => {
  let pool;
  beforeEach(() => (pool = createPool({ concurrency: 2 })));
  afterEach(async () => pool.dispose());

  test("runs a pure fn off-thread and returns its result", async () => {
    const out = await pool.run((a, b) => a + b, [40, 2]);
    expect(out).toBe(42);
  });

  test("supports async fns", async () => {
    const out = await pool.run(async x => x * 3, [7]);
    expect(out).toBe(21);
  });

  test("propagates thrown errors", async () => {
    await expect(
      pool.run(() => {
        throw new Error("nope");
      }),
    ).rejects.toThrow(/nope/);
  });

  test("multiple concurrent calls share the pool", async () => {
    const outs = await Promise.all([
      pool.run(x => x + 1, [1]),
      pool.run(x => x + 1, [2]),
      pool.run(x => x + 1, [3]),
      pool.run(x => x + 1, [4]),
    ]);
    expect(outs).toEqual([2, 3, 4, 5]);
  });
});

describe("AbortSignal", () => {
  let pool;
  beforeEach(() => (pool = createPool({ concurrency: 2 })));
  afterEach(async () => pool.dispose());

  test("pre-aborted signal rejects immediately", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(pool.run(x => x, [1], { signal: ctrl.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  test("aborting mid-flight terminates the worker and rejects", async () => {
    const ctrl = new AbortController();
    const slow = pool.run(
      // 500ms busy loop in the worker.
      ms => {
        const end = Date.now() + ms;
        while (Date.now() < end) {}
        return "done";
      },
      [500],
      { signal: ctrl.signal },
    );
    setTimeout(() => ctrl.abort(), 30);
    await expect(slow).rejects.toMatchObject({ name: "AbortError" });
  });

  test("pool is still usable after an abort (worker was replaced)", async () => {
    const ctrl = new AbortController();
    const slow = pool.run(
      ms => {
        const end = Date.now() + ms;
        while (Date.now() < end) {}
        return "should not see";
      },
      [500],
      { signal: ctrl.signal },
    );
    setTimeout(() => ctrl.abort(), 20);
    await expect(slow).rejects.toMatchObject({ name: "AbortError" });
    // New work should run cleanly on the replacement worker.
    const out = await pool.run(x => x * 2, [21]);
    expect(out).toBe(42);
  });

  test("queued task aborted before dispatch never runs", async () => {
    // Saturate the pool with two slow tasks; queue a third with a
    // signal we abort before any worker can pick it up.
    const slow = ms =>
      pool.run(
        m => {
          const end = Date.now() + m;
          while (Date.now() < end) {}
          return m;
        },
        [ms],
      );
    const a = slow(120);
    const b = slow(120);
    const ctrl = new AbortController();
    const queued = pool.run(x => x * 9, [11], { signal: ctrl.signal });
    ctrl.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    await Promise.all([a, b]);
  });
});

describe("timeout", () => {
  let pool;
  beforeEach(() => (pool = createPool({ concurrency: 2 })));
  afterEach(async () => pool.dispose());

  test("rejects with TimeoutError when fn exceeds timeout", async () => {
    const slow = pool.run(
      ms => {
        const end = Date.now() + ms;
        while (Date.now() < end) {}
        return "done";
      },
      [500],
      { timeout: 30 },
    );
    await expect(slow).rejects.toMatchObject({ name: "TimeoutError" });
  });

  test("does not fire when fn finishes in time", async () => {
    const out = await pool.run(x => x + 1, [1], { timeout: 5000 });
    expect(out).toBe(2);
  });
});

describe("worker recycling (maxTasksPerWorker)", () => {
  test("recycles worker after N tasks completed", async () => {
    const pool = createPool({ concurrency: 1, maxTasksPerWorker: 3 });
    try {
      // Run 6 tasks. With 1 worker recycled every 3, this should
      // complete cleanly. Stats.completed should be 6.
      for (let i = 0; i < 6; i++) {
        const r = await pool.run(x => x + 1, [i]);
        expect(r).toBe(i + 1);
      }
      expect(pool.stats().completed).toBe(6);
    } finally {
      await pool.dispose();
    }
  });
});

describe("transfer list", () => {
  test("caller-supplied Transferable is sent zero-copy", async () => {
    const pool = createPool({ concurrency: 1 });
    try {
      const buf = new Uint8Array(1024);
      buf[0] = 7;
      const out = await pool.run(u8 => u8[0] * 2, [buf], { transfer: [buf.buffer] });
      expect(out).toBe(14);
      // Buffer was transferred — its byteLength should be 0 here.
      expect(buf.byteLength).toBe(0);
    } finally {
      await pool.dispose();
    }
  });
});

describe("stats / dispose", () => {
  test("stats reports worker counts and completion total", async () => {
    const pool = createPool({ concurrency: 3 });
    try {
      const s0 = pool.stats();
      expect(s0.workers).toBe(3);
      expect(s0.busy).toBe(0);
      expect(s0.idle).toBe(3);
      expect(s0.completed).toBe(0);
      await pool.run(x => x + 1, [10]);
      expect(pool.stats().completed).toBeGreaterThanOrEqual(1);
    } finally {
      await pool.dispose();
    }
  });

  test("dispose rejects queued tasks", async () => {
    const pool = createPool({ concurrency: 1 });
    // Saturate the worker.
    const busy = pool.run(
      ms => {
        const end = Date.now() + ms;
        while (Date.now() < end) {}
        return "ok";
      },
      [200],
    );
    // Queue a second task.
    const queued = pool.run(x => x, [1]);
    await pool.dispose();
    await expect(queued).rejects.toThrow(/disposed/);
    // The in-flight task was killed by dispose; await it but ignore result.
    await busy.catch(() => {});
  });

  test("dispose is idempotent", async () => {
    const pool = createPool({ concurrency: 2 });
    await pool.dispose();
    await pool.dispose();
  });
});

describe("functional API uses default singleton", () => {
  afterEach(() => disposeWorkers());

  test("pmap via default pool", async () => {
    const out = await pmap(x => x * 2, [1, 2, 3]);
    expect(out).toEqual([2, 4, 6]);
  });

  test("preduce via default pool", async () => {
    const total = await preduce((a, b) => a + b, [1, 2, 3, 4], 0);
    expect(total).toBe(10);
  });

  test("run via default pool", async () => {
    const r = await run((a, b) => a * b, [6, 7]);
    expect(r).toBe(42);
  });
});

describe("pool lifecycle (alive + use)", () => {
  test("alive starts true; flips false on dispose; use(fn) auto-tears-down", async () => {
    const pool = createPool({ concurrency: 2 });
    expect(pool.alive.get()).toBe(true);
    let runs = 0;
    pool.use(() => {
      runs++;
      pool.alive.get();
    });
    expect(runs).toBe(1);
    await pool.dispose();
    expect(pool.alive.get()).toBe(false);
    const before = runs;
    // Bound effect was disposed — no further runs even if signals change.
    await new Promise(r => setTimeout(r, 20));
    expect(runs).toBe(before);
  });
});
