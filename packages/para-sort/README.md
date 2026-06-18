# @lyku/para-sort

Typed-array sort with automatic tier dispatch. Numeric specialization is the entire point — this is **not** a generic comparator sort (that's what `.sort()` is for, and why it's slow).

```ts
import sort from "@lyku/para-sort";

const out = sort.f32(arr); // new sorted Float32Array (input untouched)
const idx = sort.argF32(keys); // Uint32Array of indices — the version you actually use

// parallel tier (worker pools can't be synchronous — see below)
const big = await sort.u32Async(huge, { backend: "parallel" });
```

## Tiers

1. **serial** — LSD radix (this package). Synchronous, deterministic, beats `TypedArray.prototype.sort()` above a measured per-kind crossover. Always available, every runtime.
2. **parallel** — delegates to native `@lyku/para-parallel` `psort` (tuned SAB histogram+scatter radix across a worker pool). Resolvable only on the ParaBun runtime; the npm shim's `psort` is sequential, so this tier reports unavailable off-runtime. **Async only** (`*.f32Async`) — a worker pool fundamentally cannot be synchronous, and forcing the whole API async would make every tiny serial sort `await`. The sync surface covers serial/small/already-sorted; `*Async` adds parallel.
3. **gpu** — Phase 2. `backend:"gpu"` throws today.

## Surface

- `sort.f32 / u32 / i32` — sync value sort → a new sorted typed array.
- `sort.f32Async / u32Async / i32Async` — same, but the auto tier may use native parallel.
- `sort.argF32 / argU32 / argI32` — stable argsort → `Uint32Array` of indices. The real-world form: sort `{id, score}` by score = argsort the scores, then gather.
- `sort.describe()` / `sort.describe(arr)` — active tier + thresholds / per-input recommendation.

### Options

| Option | Meaning |
| --- | --- |
| `backend: "serial" \| "parallel" \| "gpu"` | Hard-pin. Errors if unavailable (essential for benchmarks/tests). `"parallel"` is async-only; `"gpu"` always throws in v0. |
| `prefer: …` | Try a tier, fall back silently. |
| `workers` | Worker count for the parallel tier. |
| `minParallel` | Override the serial→parallel size threshold while staying auto. |
| `stable` | argsort stability hint. LSD radix is always stable; accepted as a no-op. |

## Thresholds (measured, not guessed)

Below a per-kind floor, `TypedArray.prototype.sort()` (a fast C++ engine sort) beats radix — the histogram/scatter setup and ping-pong allocations don't amortize. Measured on random inputs:

| kind | radix floor | below floor | at/above |
| --- | --- | --- | --- |
| f32 | 8192 | engine `.sort()` (f32→sortable-key transform adds 2 passes, so its crossover is higher than ints) | ~1.3× at 10K → ~4× at 5M |
| u32 / i32 | 4096 | engine `.sort()` | ~2–2.8× |

Below the floor `sort.*` returns the engine sort (value path) / a stable comparator index sort (argsort, NaN ordered to the end to match radix). f32 NaN sorts to the end; `-0`/`+0` relative order is unspecified — don't depend on it. Non-mutating: the returned array is always a fresh copy.

## Status

`private:true / 0.0.0-dev` — pending the workspace split. See [parabun.script.dev](https://parabun.script.dev) for the runtime-bundled story today.
