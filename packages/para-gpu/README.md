# @lyku/para-gpu

Cross-runtime GPU accelerator. One **async** surface, routed at first use to the best backend available:

1. **`parabun:gpu`** — native Metal / CUDA, when running on the ParaBun runtime.
2. **WebGPU** — `navigator.gpu` compute shaders (Chromium, Safari 18, Firefox).
3. **CPU** — `@para/simd` (WASM v128 / scalar), always available.

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
- **Native is not yet non-blocking.** `parabun:gpu` synchronizes on the JS thread; this package only Promise-wraps it. The async *contract* is honest (you must `await`); making native release the event loop during the GPU sync is a tracked native-side follow-up.

## Status

`private:true / 0.0.0-dev` — pending the workspace split this package is part of. See [parabun.script.dev](https://parabun.script.dev) for the runtime-bundled story today.
