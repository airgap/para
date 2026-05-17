# @para/pipeline

Lazy streaming combinators for the `|>` operator. Works on any iterable or async iterable; nothing executes until a terminal pulls.

```js
import p from "@para/pipeline";

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
| `sum` | Running sum (uses `@para/simd` for typed-array sources). |
| `reduce(fn, init)` | Standard reduction. |
| `forEach(fn)` | Side effect per item; resolves when source completes. |
| `first(pred?)` / `last(pred?)` / `find(pred)` | Selector terminals. |
| `min(keyFn?)` / `max(keyFn?)` | Extreme by numeric key. |
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
| `empty()` | Yields nothing. |
| `concat(...sources)` | Sequence sources end-to-end. |
| `merge(...sources)` | Race-style interleave (async sources). |
| `zip(...sources)` | Lockstep tuples; stops at the shortest. |
| `repeat(source, n?)` | Replay a source `n` times (default infinite). |

**Conveniences**

| | |
| --- | --- |
| `pipe(source, ...stages)` | Plain function composition for callers without `|>`. |
| `pipeParallel(source, ...stages)` | Same surface; identifies parallelizable map / reduce segments and dispatches via `@para/parallel`. Falls back to serial below 256 items. |

## Fusion

When the source is a `Float32Array` or `Float64Array`, adjacent `map` calls extend a fused chain instead of wrapping each layer in another async generator. Fusion-aware terminals (`collect`, `sum`, `toFloat32Array`, `toFloat64Array`) walk the chain, compose affine kernels when possible, and dispatch to `@para/simd` as a single pass.

```js
const arr = new Float32Array([1, 2, 3, 4]);
await (arr |> p.map(x => x * 2) |> p.map(x => x + 1) |> p.sum); // single SIMD pass
```

## On the ParaBun runtime

Single-affine chains (`x*K + C` collapsed) on Float32Array sources opportunistically promote to `parabun:gpu` when it's available and `gpu.winsForSize(...)` says yes. The lookup is dynamic and silently falls back to `@para/simd` when `parabun:gpu` isn't resolvable (Node, browsers, anywhere outside ParaBun) — same code path either way.

## Status

`private:true / 0.0.0-dev` — pending the workspace split. See [parabun.script.dev](https://parabun.script.dev) for the runtime-bundled story today.
