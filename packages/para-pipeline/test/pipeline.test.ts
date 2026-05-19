import { describe, expect, test } from "bun:test";
import p from "../src/index";

const collect = p.collect;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function* asyncOf<T>(...xs: T[]): AsyncIterable<T> {
  for (const x of xs) yield x;
}

describe("scan", () => {
  test("yields each accumulator step", async () => {
    const out = await collect(p.scan<number, number>((acc, x) => acc + x, 0)([1, 2, 3, 4]));
    expect(out).toEqual([1, 3, 6, 10]);
  });

  test("works on async sources", async () => {
    const out = await collect(p.scan<number, number[]>((acc, x) => [...acc, x], [])(asyncOf(1, 2, 3)));
    expect(out).toEqual([[1], [1, 2], [1, 2, 3]]);
  });
});

describe("distinct / distinctUntilChanged", () => {
  test("distinct dedups by identity", async () => {
    expect(await collect(p.distinct()([1, 2, 1, 3, 2, 4]))).toEqual([1, 2, 3, 4]);
  });

  test("distinct dedups by key fn", async () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 1 }, { id: 3 }];
    const out = await collect(p.distinct((o: any) => o.id)(items));
    expect(out).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  test("distinctUntilChanged drops adjacent dupes only", async () => {
    expect(await collect(p.distinctUntilChanged()([1, 1, 2, 2, 1, 3, 3]))).toEqual([1, 2, 1, 3]);
  });
});

describe("pairwise / windowed / enumerate", () => {
  test("pairwise yields [prev, curr]", async () => {
    expect(await collect(p.pairwise<number>()([1, 2, 3, 4]))).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
  });

  test("windowed default step 1", async () => {
    expect(await collect(p.windowed<number>(3)([1, 2, 3, 4, 5]))).toEqual([
      [1, 2, 3],
      [2, 3, 4],
      [3, 4, 5],
    ]);
  });

  test("windowed with step >= size is non-overlapping", async () => {
    expect(await collect(p.windowed<number>(2, 3)([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual([
      [1, 2],
      [4, 5],
      [7, 8],
    ]);
  });

  test("enumerate pairs each value with index", async () => {
    expect(await collect(p.enumerate<string>()(["a", "b", "c"]))).toEqual([
      [0, "a"],
      [1, "b"],
      [2, "c"],
    ]);
  });
});

describe("catchError / retry", () => {
  test("catchError swallows and substitutes a stream", async () => {
    async function* failing(): AsyncIterable<number> {
      yield 1;
      yield 2;
      throw new Error("boom");
    }
    const out = await collect(p.catchError<number>(() => [99, 100])(failing()));
    expect(out).toEqual([1, 2, 99, 100]);
  });

  test("catchError can return a single value", async () => {
    async function* failing(): AsyncIterable<number> {
      yield 1;
      throw new Error("boom");
    }
    const out = await collect(p.catchError<number>(() => -1)(failing()));
    expect(out).toEqual([1, -1]);
  });

  test("retry replays a sync source on failure", async () => {
    let attempts = 0;
    function* src() {
      attempts++;
      yield 1;
      yield 2;
      if (attempts < 3) throw new Error("again");
      yield 3;
    }
    // Wrap in a closure source that re-runs the generator each retry.
    // Easiest: pass the generator-returning function output as fresh
    // iterable each attempt by realizing it as an array per call.
    let runs = 0;
    const source = {
      [Symbol.asyncIterator]() {
        runs++;
        return (async function* () {
          for (const x of src()) yield x;
        })();
      },
    } as AsyncIterable<number>;
    const out = await collect(p.retry<number>(2)(source));
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(runs).toBe(3);
  });
});

describe("delay / throttle / debounce", () => {
  test("delay defers each yield", async () => {
    const t0 = Date.now();
    const out = await collect(p.delay(20)([1, 2, 3]));
    const elapsed = Date.now() - t0;
    expect(out).toEqual([1, 2, 3]);
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });

  test("throttle drops items inside the window", async () => {
    async function* src() {
      yield 1;
      await sleep(5);
      yield 2;
      await sleep(5);
      yield 3;
      await sleep(40);
      yield 4;
    }
    const out = await collect(p.throttle<number>(30)(src()));
    expect(out).toEqual([1, 4]);
  });

  test("debounce only emits after silence", async () => {
    async function* src() {
      yield 1;
      await sleep(5);
      yield 2;
      await sleep(5);
      yield 3;
      await sleep(40);
      yield 4;
    }
    const out = await collect(p.debounce<number>(20)(src()));
    expect(out).toEqual([3, 4]);
  });
});

describe("first / last / find / min / max / every / some", () => {
  test("first returns first item, no pred", async () => {
    expect(await p.first<number>()([1, 2, 3])).toBe(1);
  });

  test("first with pred", async () => {
    expect(await p.first<number>(x => x > 5)([1, 6, 7])).toBe(6);
  });

  test("first returns undefined on empty / no match", async () => {
    expect(await p.first<number>(x => x > 100)([1, 2, 3])).toBeUndefined();
  });

  test("last returns last matching", async () => {
    expect(await p.last<number>(x => x % 2 === 0)([1, 2, 3, 4, 5])).toBe(4);
  });

  test("find is alias for first(pred)", async () => {
    expect(await p.find<number>(x => x === 3)([1, 2, 3, 4])).toBe(3);
  });

  test("min / max with key fn", async () => {
    const items = [{ s: 5 }, { s: 1 }, { s: 9 }];
    expect(await p.min<{ s: number }>(o => o.s)(items)).toEqual({ s: 1 });
    expect(await p.max<{ s: number }>(o => o.s)(items)).toEqual({ s: 9 });
  });

  test("every / some", async () => {
    expect(await p.every<number>(x => x > 0)([1, 2, 3])).toBe(true);
    expect(await p.every<number>(x => x > 1)([1, 2, 3])).toBe(false);
    expect(await p.some<number>(x => x === 2)([1, 2, 3])).toBe(true);
    expect(await p.some<number>(x => x === 99)([1, 2, 3])).toBe(false);
  });
});

describe("toMap / toSet / groupBy / partition", () => {
  test("toMap with keyFn only", async () => {
    const m = await p.toMap<{ id: number; v: string }, number>(o => o.id)([
      { id: 1, v: "a" },
      { id: 2, v: "b" },
    ]);
    expect(m.get(1)).toEqual({ id: 1, v: "a" });
  });

  test("toMap with keyFn + valueFn", async () => {
    const m = await p.toMap<{ id: number; v: string }, number, string>(
      o => o.id,
      o => o.v,
    )([
      { id: 1, v: "a" },
      { id: 2, v: "b" },
    ]);
    expect([...m.entries()]).toEqual([
      [1, "a"],
      [2, "b"],
    ]);
  });

  test("toSet dedups", async () => {
    expect([...(await p.toSet([1, 2, 2, 3, 1]))]).toEqual([1, 2, 3]);
  });

  test("groupBy buckets values by key", async () => {
    const m = await p.groupBy<number, string>(x => (x % 2 === 0 ? "even" : "odd"))([1, 2, 3, 4, 5]);
    expect(m.get("odd")).toEqual([1, 3, 5]);
    expect(m.get("even")).toEqual([2, 4]);
  });

  test("partition splits by predicate", async () => {
    const [yes, no] = await p.partition<number>(x => x > 2)([1, 2, 3, 4, 5]);
    expect(yes).toEqual([3, 4, 5]);
    expect(no).toEqual([1, 2]);
  });
});

describe("of / from / empty / concat / merge / zip / repeat", () => {
  test("of wraps args as iterable", async () => {
    expect(await collect(p.of(1, 2, 3))).toEqual([1, 2, 3]);
  });

  test("empty yields nothing", async () => {
    expect(await collect(p.empty<number>())).toEqual([]);
  });

  test("from passes through", async () => {
    expect(await collect(p.from([1, 2, 3]))).toEqual([1, 2, 3]);
  });

  test("concat appends sources", async () => {
    expect(await collect(p.concat([1, 2], asyncOf(3, 4), [5]))).toEqual([1, 2, 3, 4, 5]);
  });

  test("merge interleaves async sources", async () => {
    async function* fast() {
      yield "f1";
      await sleep(10);
      yield "f2";
    }
    async function* slow() {
      await sleep(5);
      yield "s1";
      await sleep(10);
      yield "s2";
    }
    const out = await collect(p.merge(fast(), slow()));
    // First emission must be fast's f1 (no initial sleep).
    expect(out[0]).toBe("f1");
    expect(out.length).toBe(4);
    expect(new Set(out)).toEqual(new Set(["f1", "f2", "s1", "s2"]));
  });

  test("zip stops at shortest", async () => {
    expect(await collect(p.zip([1, 2, 3], ["a", "b"], [true, false, true, false]))).toEqual([
      [1, "a", true],
      [2, "b", false],
    ]);
  });

  test("repeat replays a source N times", async () => {
    expect(await collect(p.repeat([1, 2], 3))).toEqual([1, 2, 1, 2, 1, 2]);
  });

  test("repeat 0 yields nothing", async () => {
    expect(await collect(p.repeat([1, 2], 0))).toEqual([]);
  });
});

describe("existing surface still works", () => {
  test("map + filter + take + collect", async () => {
    // Map x→x*5, then keep evens, then take 3.
    // 1→5, 2→10, 3→15, 4→20, 5→25, 6→30 → evens [10,20,30] → take(3) → [10,20,30]
    const out = await collect(
      p.take<number>(3)(p.filter<number>(x => x % 2 === 0)(p.map<number, number>(x => x * 5)([1, 2, 3, 4, 5, 6, 7]))),
    );
    expect(out).toEqual([10, 20, 30]);
  });

  test("range + sum", async () => {
    expect(await p.sum(p.range(1, 11))).toBe(55);
  });

  test("chunk yields arrays of size", async () => {
    expect(await collect(p.chunk<number>(2)([1, 2, 3, 4, 5]))).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("topK / argTopK / mergeTopK", () => {
  async function* asyncOf(...xs) {
    for (const x of xs) yield x;
  }
  function refTopK(arr, k, by = "max", keyFn = x => x) {
    const idx = arr.map((_, i) => i);
    idx.sort((a, b) => {
      const ka = keyFn(arr[a]);
      const kb = keyFn(arr[b]);
      if (ka !== kb) return by === "max" ? kb - ka : ka - kb;
      return a - b; // stable: earlier arrival first
    });
    return idx.slice(0, Math.max(0, k)).map(i => arr[i]);
  }

  test("k largest, ordered best→worst", async () => {
    const a = [5, 1, 9, 3, 7, 2, 8, 4, 6, 0];
    expect(await p.topK<number>(3)(a)).toEqual([9, 8, 7]);
    expect(await p.topK<number>(3, undefined, { by: "min" })(a)).toEqual([0, 1, 2]);
  });

  test("keyFn — top rows by score (the real case)", async () => {
    const rows = [
      { id: "a", score: 12 },
      { id: "b", score: 99 },
      { id: "c", score: 7 },
      { id: "d", score: 99 },
      { id: "e", score: 50 },
    ];
    const out = await p.topK<any>(2, r => r.score)(rows);
    expect(out.map(r => r.id)).toEqual(["b", "d"]); // tie at 99 → earliest first (stable)
  });

  test("argTopK returns source indices", async () => {
    const a = [5, 1, 9, 3, 7];
    const idx = await p.argTopK<number>(2)(a);
    expect(idx).toBeInstanceOf(Uint32Array);
    expect(Array.from(idx)).toEqual([2, 4]); // 9@2, 7@4
  });

  test("edge cases: k<=0, k>=n", async () => {
    expect(await p.topK<number>(0)([3, 1, 2])).toEqual([]);
    expect(await p.topK<number>(99)([3, 1, 2])).toEqual([3, 2, 1]); // full sort fallback
  });

  test("async source, large stream — matches reference, O(k) selection", async () => {
    const n = 100_000;
    const a = new Array(n);
    let s = 12345;
    for (let i = 0; i < n; i++) {
      s = (s * 1103515245 + 12345) >>> 0;
      a[i] = s % 1000; // lots of ties → exercises stability at scale
    }
    const out = await p.topK<number>(5)(asyncOf(...a));
    expect(out).toEqual(refTopK(a, 5));
  });

  test("mergeTopK is the monoid combine: per-shard then merge == global", async () => {
    const n = 5000;
    // Distinct values (i*7919 mod 5000 is a bijection — 7919 prime, coprime
    // to 5000) so the monoid equality is unambiguous: with ties, per-shard
    // top-k then merge may legitimately keep different equal elements.
    const a = Array.from({ length: n }, (_, i) => (i * 7919) % n);
    const shards = [a.slice(0, 1500), a.slice(1500, 3200), a.slice(3200)];
    // Local top-k per shard (with a global index via keyFn-less identity is
    // fine here since values are distinct enough; use value as key).
    const locals = [];
    for (const sh of shards) locals.push(await p.topK<number>(5)(sh));
    const merged = p.mergeTopK<number>(locals, 5);
    expect(merged).toEqual(refTopK(a, 5));
  });

  test("mergeTopK with keyFn on objects", () => {
    const l1 = [{ s: 10 }, { s: 4 }];
    const l2 = [{ s: 99 }, { s: 7 }];
    const l3 = [{ s: 55 }];
    expect(p.mergeTopK<any>([l1, l2, l3], 2, o => o.s).map(o => o.s)).toEqual([99, 55]);
  });
});

describe("fromColumn / fromColumns (columnar projection sources)", () => {
  // Plain columnar batches — exactly the shape @para/csv parseBatches
  // yields: { name: ArrayLike }, row count = any column's .length, final
  // batch tight-fit (shorter than the others).
  const plainBatches = [
    { id: ["a", "b", "c"], score: Float32Array.from([12, 99, 7]) },
    { id: ["d", "e", "f"], score: Float32Array.from([55, 99, 3]) },
    { id: ["g"], score: Float32Array.from([100]) }, // tight-fit final batch
  ];
  // Arrow-RecordBatch-shaped duck: .numRows + .column(name).get(i).
  function arrowBatch(ids, scores) {
    return {
      numRows: ids.length,
      column(name) {
        const a = name === "id" ? ids : name === "score" ? scores : null;
        if (!a) throw new RangeError(`no column ${name}`);
        return { get: i => a[i] };
      },
    };
  }
  const arrowBatches = [arrowBatch(["a", "b", "c"], [12, 99, 7]), arrowBatch(["d", "e"], [55, 100])];

  test("fromColumn streams one column's scalars, no row objects (plain)", async () => {
    expect(await collect(p.fromColumn(plainBatches, "score"))).toEqual([12, 99, 7, 55, 99, 3, 100]);
    expect(await collect(p.fromColumn(plainBatches, "id"))).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  test("fromColumn works on Arrow-shaped batches (.column().get())", async () => {
    expect(await collect(p.fromColumn(arrowBatches, "score"))).toEqual([12, 99, 7, 55, 100]);
  });

  test("fromColumns projects only requested fields per row", async () => {
    const rows = await collect(p.fromColumns(plainBatches, ["id", "score"]));
    expect(rows.slice(0, 2)).toEqual([
      { id: "a", score: 12 },
      { id: "b", score: 99 },
    ]);
    expect(rows.length).toBe(7);
  });

  test("the headline: top-3 rows by score over batched columnar input", async () => {
    // parseBatches → project (id,score) → streaming top-3. Never
    // materializes/sorts the dataset; only k rows retained.
    const top = await p.topK<any>(3, r => r.score)(p.fromColumns(plainBatches, ["id", "score"]));
    expect(top.map(r => `${r.id}:${r.score}`)).toEqual(["g:100", "b:99", "e:99"]);
    // argTopK over a single projected column → indices into row order.
    const idx = await p.argTopK<number>(3)(p.fromColumn<number>(plainBatches, "score"));
    expect(Array.from(idx)).toEqual([6, 1, 4]); // 100@6, 99@1, 99@4 (stable)
  });

  test("missing column throws a clear error", async () => {
    await expect(collect(p.fromColumn(plainBatches, "nope"))).rejects.toThrow(/no column "nope"/);
    await expect(collect(p.fromColumns(arrowBatches, ["id", "ghost"]))).rejects.toThrow();
  });
});
