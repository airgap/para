# @lyku/para-parallel

Persistent Worker pool — `pmap` / `preduce` for data-parallel work, `run` for one-off off-thread tasks. Pure JS, runs on browsers, Node, Bun, Deno. Falls back to sequential execution in CSP-restricted contexts where `Worker` + `new Function` aren't available.

**Native-delegating normalizer.** On the ParaBun runtime, `@lyku/para-parallel` resolves to the native builtin — SAB-backed zero-copy `pmap`/`preduce`, parallel SAB-radix `psort`, atomic `Mutex`/`Semaphore`. Off-runtime (and for by-path/bundled imports, which reach native via the recursion-safe `para:parallel` alias) this package provides faithful in-process fallbacks at the same API. `psort` off-runtime is a correct **sequential** sort (not Worker-parallel); `Mutex`/`Semaphore` are correct in-process (cross-thread SAB semantics need the runtime). `__paraParallelShim` is exported as `true` **only** when the sequential fallback is active — pin on `!mod.__paraParallelShim` if you must require a real parallel path.

```js
import { pmap, preduce, run, createPool } from "@lyku/para-parallel";

const rows = Array.from({ length: 1_000_000 }, (_, i) => `record-${i}`);
const scores = await pmap(
  row => {
    let h = 0;
    for (let i = 0; i < row.length; i++) h = (h * 31 + row.charCodeAt(i)) | 0;
    return h * h;
  },
  rows,
);
const sum = await preduce((acc, x) => acc + x, scores, 0);
```

## API

### Functional surface (uses a process-wide singleton pool)

- **`pmap(fn, items, opts?)`** — parallel map. `fn` is `(value, index) => result` (sync or async).
- **`preduce(fn, items, init, opts?)`** — parallel reduce. `fn` must be associative for chunked correctness. Optional `mapFn` fuses a per-element map before the reduce in a single worker pass.
- **`run(fn, args?, opts?)`** — single-task dispatch: ship `fn` and the `args` array to a worker, await its result. The everyday "do this CPU-bound thing off-thread" call.
- **`disposeWorkers()`** — terminate the singleton pool (mostly useful in tests / hot-reload).

### Pool surface

- **`createPool(config?)`** — explicit pool with its own config:
  - `concurrency` — worker count. Defaults to `navigator.hardwareConcurrency` / `os.availableParallelism()`.
  - `maxTasksPerWorker` — recycle a worker (terminate + respawn) once it has completed this many tasks. Defaults to `Infinity`. Set to a finite value to defend against memory growth in long-lived pools.
- **`pool.pmap` / `pool.preduce` / `pool.run`** — same shapes as the functional surface.
- **`pool.stats()`** → `{ workers, busy, idle, queued, waiting, completed, sequential }`.
- **`pool.dispose()`** — terminate all workers; reject any queued or in-flight tasks.

### Sort + concurrency primitives

- **`psort(array, comparator?, options?)`** → `Promise`. TypedArray → value sort by the native parallel SAB-radix (no `comparator` accepted — wrap in a plain Array for comparator sort). Array → stable sort by `comparator`. `options`: `{ serial?, concurrency? }`. Off-runtime: a correct sequential sort.
- **`new Mutex(sab?)`** — `lock()` / `tryLock()` / `unlock()` / `with(fn)`, `.sab`. Native = SAB + Atomics (shareable across workers); shim = in-process.
- **`new Semaphore(initialPermits, sab?)`** — `tryAcquire()` / `acquire()` / `release()` / `with(fn)`, `.sab`.
- **`pool({ size?, module })`** — native module-worker pool; the shim honors `size` (worker count) and builds workers from `fn.toString()` (`module` is N/A off-runtime).

## Per-call options

Every `pmap` / `preduce` / `run` call accepts:

| Option | Description |
| --- | --- |
| `signal` | An `AbortSignal`. Aborting before the call: rejects immediately with `AbortError`. Aborting mid-flight: terminates the worker holding the task, replaces it, and rejects the call. Future tasks reuse the replacement worker — the pool stays usable. |
| `timeout` | Milliseconds. Same forceful termination as `signal` if the worker exceeds it; rejects with `TimeoutError`. |
| `concurrency` | (`pmap` / `preduce` only) Maximum slots used for this call. Capped to the pool's configured concurrency. |
| `transfer` | (`run` only) `Transferable[]` to send zero-copy alongside `args`. Use this when `args` includes an `ArrayBuffer` you don't need on the calling side anymore. |

`pmap` / `preduce` already auto-transfer the chunk-slice buffer for `TypedArray` inputs — a 100 MB `Float32Array` splits into N transferred chunks rather than N copies.

## Constraints

- **Functions must be pure.** They're shipped to workers via `fn.toString()` and rehydrated with `new Function(…)`. Closures over outer scope, references to outer `this`, and impure globals don't survive the transfer.
- `preduce`'s reducer must be associative (operate correctly on partial results), since chunks reduce in parallel and the final fold combines partials. The reducer is invoked for the final fold as `fn(acc, partial)` — no index argument — so don't depend on `i`.

## Status

`private:true / 0.0.0-dev` — pending the workspace split. See [parabun.script.dev](https://parabun.script.dev) for the runtime-bundled story today.
