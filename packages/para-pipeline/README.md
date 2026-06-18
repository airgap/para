# @lyku/para-pipeline

Lazy streaming combinators for the `|>` operator. Works on any iterable or async iterable; nothing executes until a terminal pulls.

```js
import p from "@lyku/para-pipeline";

const out = await (
  source
  |> p.map(double)
  |> p.filter(even)
  |> p.take(10)
  |> p.collect
);
```

Without the `.pts` `|>` syntax, the same chain is plain function composition:

```js
const out = await p.collect(p.take(10)(p.filter(even)(p.map(double)(source))));
```

## Operator surface

**Combinators** (transforms — return a stream)

| | |
| --- | --- |
| `map(fn)` / `filter(pred)` | Per-item transform / predicate. |
| `take(n)` / `drop(n)` | Front cap / front skip by count. |
| `takeWhile(pred)` / `dropWhile(pred)` | Front cap / skip by predicate. |
| `flat()` / `flatMap(fn)` | Flatten one level / map-then-flatten. |
| `chunk(size)` | Non-overlapping arrays of `size`. |
| `windowed(size, step?)` | Sliding window of `size`, advancing by `step` (default 1). |
| `pairwise()` | Yields `[prev, curr]` tuples. |
| `enumerate()` | Yields `[index, value]`. |
| `scan(fn, init)` | Like `reduce`, but yields each intermediate accumulator. |
| `distinct(keyFn?)` | Drop repeats anywhere in the stream. |
| `distinctUntilChanged(eqFn?)` | Drop adjacent repeats only. |
| `tap(fn)` | Side effect per item; passes the item through. |
| `delay(ms)` | Sleep `ms` between yields. |
| `throttle(ms)` | Emit at most once per `ms` window. |
| `debounce(ms)` | Emit only after `ms` of upstream silence. |
| `catchError(handler)` | Recover from upstream errors with a value or substitute stream. |
| `retry(times)` | Restart the source on error up to `times` times. |

**Terminals** (consume a stream — return a `Promise`)

| | |
| --- | --- |
| `collect` | Materialize into `T[]`. |
| `count` | Number of items. |
| `sum` | Running sum (uses `@lyku/para-simd` for typed-array sources). |
| `reduce(fn, init)` | Standard reduction. |
| `forEach(fn)` | Side effect per item; resolves when source completes. |
| `first(pred?)` / `last(pred?)` / `find(pred)` | Selector terminals. |
| `min(keyFn?)` / `max(keyFn?)` | Extreme by numeric key. |
| `topK(k, keyFn?, {by})` | The `k` best, ordered best→worst. Streaming bounded heap: O(n log k) time, **O(k) memory** — never sorts or buffers the dataset. `by:"max"` (default) / `"min"`. Stable on ties (earliest k). |
| `argTopK(k, keyFn?, {by})` | Same, returns a `Uint32Array` of source indices — the "top *rows*" form (keep keys, gather columns yourself). |
| `every(pred)` / `some(pred)` | Universal / existential. |
| `toMap(keyFn, valueFn?)` / `toSet` | Collect into `Map` / `Set`. |
| `groupBy(keyFn)` | `Map<K, T[]>`. |
| `partition(pred)` | `[matched[], unmatched[]]`. |
| `toFloat32Array` / `toFloat64Array` | Typed-array terminals. |

**Sources / multi-source combinators**

| | |
| --- | --- |
| `range(stop)` / `range(start, stop, step?)` | Lazy integer source. |
| `of(...values)` | Wrap args as iterable. |
| `from(source)` | Identity wrapper for any source. |
| `fromColumn(batches, name)` | Project one column of a batch stream → per-row scalars, no row objects. |
| `fromColumns(batches, names)` | Project several columns → a per-row object of just those fields. |
| `empty()` | Yields nothing. |
| `concat(...sources)` | Sequence sources end-to-end. |
| `merge(...sources)` | Race-style interleave (async sources). |
| `zip(...sources)` | Lockstep tuples; stops at the shortest. |
| `repeat(source, n?)` | Replay a source `n` times (default infinite). |

**Conveniences**

| | |
| --- | --- |
| `pipe(source, ...stages)` | Plain function composition for callers without `|>`. |
| `pipeParallel(source, ...stages)` | Same surface; identifies parallelizable map / reduce segments and dispatches via `@lyku/para-parallel`. Falls back to serial below 256 items. |

## Fusion

When the source is a `Float32Array` or `Float64Array`, adjacent `map` calls extend a fused chain instead of wrapping each layer in another async generator. Fusion-aware terminals (`collect`, `sum`, `toFloat32Array`, `toFloat64Array`) walk the chain, compose affine kernels when possible, and dispatch to `@lyku/para-simd` as a single pass.

```js
const arr = new Float32Array([1, 2, 3, 4]);
await (arr |> p.map(x => x * 2) |> p.map(x => x + 1) |> p.sum); // single SIMD pass
```

## On the ParaBun runtime

Single-affine chains (`x*K + C` collapsed) on Float32Array sources opportunistically promote to `parabun:gpu` when it's available and `gpu.winsForSize(...)` says yes. The lookup is dynamic and silently falls back to `@lyku/para-simd` when `parabun:gpu` isn't resolvable (Node, browsers, anywhere outside ParaBun) — same code path either way.

## Top-K over large / sharded data

`source |> sort() |> take(k)` is **not** a sort — it's selection. `topK` does it in one streaming pass with an O(k) heap; the dataset is never sorted or materialized. Paired with the columnar projection sources, you get "top rows by score over an arbitrarily large CSV" at **O(batchSize + k) memory** — the parser holds one batch, the heap holds k:

```js
import csv from "@lyku/para-csv";
import p from "@lyku/para-pipeline";

const top5 = await p.topK(5, r => r.score)(
  p.fromColumns(csv.parseBatches(file, { schema: { id: "string", score: "f32" }, batchSize: 8192 }), ["id", "score"]),
);
```

`fromColumn` / `fromColumns` are structural — they accept both the `@lyku/para-csv` `parseBatches` shape (`{ name: ArrayLike }`) and `@lyku/para-arrow` `RecordBatch` (`.column(name).get(i)` + `.numRows`); this package takes no dependency on either.

`topK` is a **monoid**: `mergeTopK([topK(A), topK(B)], k) ≡ topK(A ∪ B)`. So multi-file / multi-shard top-k is local-top-k-per-shard then merge, at O(shards·k) memory regardless of total rows:

```js
const locals = await Promise.all(files.map(f => p.topK(5, keyFn)(streamOf(f))));
const global = p.mergeTopK(locals, 5, keyFn); // synchronous combine
```

## Status

`private:true / 0.0.0-dev` — pending the workspace split. See [parabun.script.dev](https://parabun.script.dev) for the runtime-bundled story today.
