# @para/simd

Vector primitives over typed arrays — `mulScalar`, `addScalar`, `add`, `mul`, `sum`, `dot`, `matVec`, `simdMap`. Default path is hand-assembled WebAssembly v128 kernels (`simd.wasm`); falls back to scalar JS loops when WebAssembly SIMD isn't available or the module can't be instantiated (older browsers, restrictive CSP).

```js
import { add, mulScalar, sum, dot, simdMap } from "@para/simd";

const a = new Float32Array([1, 2, 3, 4]);
const b = new Float32Array([5, 6, 7, 8]);

add(a, b);          // Float32Array([6, 8, 10, 12])
mulScalar(a, 3);    // Float32Array([3, 6, 9, 12])
sum(a);             // 10
dot(a, b);          // 70
simdMap(x => x * x, a); // Float32Array([1, 4, 9, 16])
```

## Performance notes

- Small inputs (`N < SCALAR_THRESHOLD`) use scalar loops — the WASM call + copy-in/out overhead dominates below ~256 elements.
- Medium/large inputs copy into the WASM linear memory, run the v128 kernel, copy out. Typical speedup vs. scalar JS is ~3-6× at N=10k, ~5-20× at N=1M.
- `alloc(n, "f32")` returns a Float32Array view backed directly by the WASM linear memory. Calls on such arrays skip the copy-in step.

## Status

`private:true / 0.0.0-dev` — pending the workspace split that this package is part of. See [parabun.script.dev](https://parabun.script.dev) for the runtime-bundled story today.
