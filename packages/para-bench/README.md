# @lyku/para-bench

Differential **performance** benchmark across the Para ↔ ParaBun boundary —
the timing counterpart to `@lyku/para-parity` (which owns correctness).
Same corpus, both implementations, three cost models:

| scenario | what it measures | informs |
| --- | --- | --- |
| `mirror` | `@lyku/para-transpile` in-process | how fast the JS mirror is / could the vite seam go in-process |
| `parabunBatch` | one parabun process, whole corpus; in-process ns from inside, wall from outside | the native compiler's real speed + startup overhead |
| `spawnPerFile` | fresh parabun process per file (micro fixtures) | the `parabun-vite-plugin` shell-out cost model |

Timing runs only on the **comparable set** (files both sides transpile);
each side's failures are reported as coverage. Macro mirror coverage is a
headline metric by itself: how much real-world Para the mirror handles.

## Running

```sh
PARABUN_BIN=/usr/local/bin/parabun bun bench.ts                      # micro only
PARABUN_BIN=… BENCH_CORPUS=/raid/lyku bun bench.ts                   # + macro corpus
PARABUN_BIN=… BENCH_CORPUS=… bun bench.ts --check bench-baseline.json
```

Env: `BENCH_CORPUS` (macro root scanned for `.pts`), `BENCH_REPS`,
`BENCH_OUT` (default `bench.json`), `BENCH_THRESHOLD` (default `0.25` for
`--check`).

## CI

The nightly `Bench (trend)` stage in `jenkins/Jenkinsfile` benches the
LATEST parabun release against a shallow sparse checkout of the lyku
monorepo (the largest Para corpus in existence), archives `bench.json`,
and compares against the previous run's baseline kept in the persistent
workspace. Regressions mark the stage UNSTABLE — trend signal, not a
merge gate; the blocking gate belongs on parabun's side (the
lyku-integration required check).

Noise discipline: medians over warmed reps, generous 25% thresholds —
this runs on a shared agent; single-digit-percent deltas are weather, not
signal.
