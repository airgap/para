# @lyku/para-gpu

Cross-runtime GPU accelerator. One **async** surface, routed at first use to the best backend available:

1. **`parabun:gpu`** — native Metal / CUDA, when running on the ParaBun runtime.
2. **WebGPU** — `navigator.gpu` compute shaders (Chromium, Safari 18, Firefox).
3. **CPU** — `@lyku/para-simd` (WASM v128 / scalar), always available.

```ts
import gpu from "@lyku/para-gpu";

const c = await gpu.matmul(a, b, M, K, N); // A is M×K, B is K×N → C is M×N
const y = await gpu.matVec(mat, vec, rows, cols);
const d = await gpu.dot(u, v);

await gpu.tier(); // "native" | "webgpu" | "cpu"
```

The surface is async on **every** backend so callers write one code path. WebGPU is physically async; native is wrapped to match. Arg order follows native `parabun:gpu` and the conventional GEMM layout.

## Notes

- **No WebGL.** WebGPU coverage is broad enough in 2026; a WebGL2 GPGPU path is high-complexity / low-precision for these kernels and is deliberately not a backend.
- **`simdMap` is GPU-accelerated only on the native tier.** WebGPU has no `simdMap` kernel, so under the `webgpu` tier it runs on CPU.
- **Native is non-blocking.** On `parabun:gpu`, `matmul`/`matVec`/`dot` dispatch through `matmulAsync`/`matVecAsync`/`dotAsync`: a private CUDA stream polled with `cuStreamQuery` (not `cuCtxSynchronize`), plus pooled pinned host staging + async H2D/D2H, so the whole transfer→compute→readback chain yields the JS event loop — not just the kernel. Honest residue: `dot` with ≤~4 MB of transfer yields ~0 (too little PCIe to span an event-loop tick — scales with size); concurrent async GPU calls are *serialized* through a gate (pooled-buffer safety, not multi-stream overlap); the WebGPU/CPU tiers are unaffected by this (WebGPU is inherently async, CPU is sync-wrapped).

## Status

`private:true / 0.0.0-dev` — pending the workspace split this package is part of. See [parabun.script.dev](https://parabun.script.dev) for the runtime-bundled story today.
