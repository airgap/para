// @lyku/para-gpu — cross-runtime GPU normalizer.
//
// One **async** surface. The backend is picked once, lazily, on first use,
// in this order:
//
//   1. parabun:gpu  — native Metal / CUDA. Only resolvable on the ParaBun
//                      runtime; absent everywhere else.
//   2. WebGPU       — navigator.gpu compute shaders (Chromium, Safari 18,
//                      Firefox). WGSL kernels vendored in ./webgpu.js.
//   3. CPU          — @para/simd (WASM v128 / scalar). Always available.
//
// WebGL is intentionally **not** a backend: WebGPU coverage in 2026 is broad
// enough, and a WebGL2 GPGPU path is high-complexity / low-precision for
// these kernels. The router has no WebGL slot by design.
//
// ── Why async everywhere ──────────────────────────────────────────────────
//
// Native parabun:gpu is synchronous; WebGPU physically cannot be (upload /
// dispatch / readback are await-only). A single portable surface therefore
// has to be async, so callers write one code path on every platform:
//
//   import gpu from "@lyku/para-gpu";
//   const c = await gpu.matmul(a, b, M, K, N);   // native, WebGPU, or CPU
//
// NATIVE NON-BLOCKING STATUS: native `matmul` now yields the JS event loop
// during the GPU compute wait — parabun:gpu's matmulAsync enqueues on a
// CUDA stream and polls cuStreamQuery with setTimeout(0) turns instead of
// blocking on cuCtxSynchronize. The host<->device memcpys around the launch
// inputs are staged through pooled pinned host memory and DMA'd on the
// stream, so the H2D/D2H transfer is yielded too — not just the compute.
// `matVec` and `dot` now have the same non-blocking native path.
//
// Per-call await overhead is a microtask tick — sub-microsecond, immeasurable
// against a GPU kernel + PCIe copy. Going async costs nothing for GPU-sized
// work; the win (unblocking the loop on native) is gated on that follow-up.

// Public arg order follows native parabun:gpu (the primary backend) and the
// conventional GEMM convention: A is M×K, B is K×N, C is M×N.
type FArray = Float32Array | Float64Array;

export type Tier = "native" | "webgpu" | "cpu";

let _tier: Tier | null = null;
let _native: any = null;
let _shim: any = null;
let _initPromise: Promise<void> | null = null;

// parabun:gpu is a hardcoded ParaBun-runtime module. Split the specifier so
// bundlers (Vite, esbuild, webpack) don't try to resolve it at build time —
// same trick @para/pipeline uses for its opportunistic GPU promotion.
function loadNative(): any {
  try {
    const spec = "parabun" + ":gpu";
    // @ts-ignore — `require` is provided by the runtime (ParaBun/Bun ESM).
    const mod = require(spec);
    return mod?.default ?? mod ?? null;
  } catch {
    return null;
  }
}

async function ensureInit(): Promise<void> {
  if (_tier) return;
  if (!_initPromise) {
    _initPromise = (async () => {
      const native = loadNative();
      if (native) {
        _native = native;
        _tier = "native";
        return;
      }
      const shimMod: any = await import("./webgpu.js");
      _shim = shimMod.default ?? shimMod;
      try {
        const ok = await _shim.initWebGPU();
        _tier = ok ? "webgpu" : "cpu";
      } catch {
        _tier = "cpu";
      }
    })();
  }
  await _initPromise;
}

// ── Compute surface (unified async) ───────────────────────────────────────

/** A·B where A is M×K and B is K×N. Returns C (M×N). */
export async function matmul(a: FArray, b: FArray, M: number, K: number, N: number, out?: FArray): Promise<FArray> {
  await ensureInit();
  if (_tier === "native") {
    // Prefer the native non-blocking path (CUDA stream + event-loop-yield)
    // when the runtime exposes it; older parabun:gpu builds only have the
    // synchronous matmul.
    if (typeof _native.matmulAsync === "function") {
      return _native.matmulAsync(a, b, M, K, N, out);
    }
    return _native.matmul(a, b, M, K, N, out);
  }
  // Shim signature is matmulAsync(a, b, M, N, K) — reorder. It falls back to
  // its own CPU matmul internally when WebGPU isn't live.
  return _shim.matmulAsync(a, b, M, N, K);
}

/** matrix·vector where matrix is nRows×nCols. Returns a length-nRows vector. */
export async function matVec(matrix: FArray, vector: FArray, nRows: number, nCols: number): Promise<FArray> {
  await ensureInit();
  if (_tier === "native") {
    if (typeof _native.matVecAsync === "function") {
      return _native.matVecAsync(matrix, vector, nRows, nCols);
    }
    return _native.matVec(matrix, vector, nRows, nCols);
  }
  return _shim.matVecAsync(matrix, vector, nRows, nCols);
}

/** Dot product of two equal-length vectors. */
export async function dot(a: FArray, b: FArray): Promise<number> {
  await ensureInit();
  if (_tier === "native") {
    if (typeof _native.dotAsync === "function") {
      return _native.dotAsync(a, b);
    }
    return _native.dot(a, b);
  }
  return _shim.dotAsync(a, b);
}

/**
 * Elementwise map. NOTE: WebGPU has no simdMap kernel — under the `webgpu`
 * tier this still runs on CPU (@para/simd). Native runs it on the GPU when
 * the function is affine. simdMap stays cross-platform but is only
 * GPU-accelerated on the native tier.
 */
export async function simdMap(fn: (x: number, i: number) => number, a: FArray): Promise<FArray> {
  await ensureInit();
  if (_tier === "native") return _native.simdMap(fn, a);
  return _shim.simdMap(fn, a);
}

// ── Introspection ─────────────────────────────────────────────────────────

/**
 * True when the active backend is expected to beat CPU for this op at this
 * size. Use it to gate promotion — same role as parabun:gpu.winsForSize.
 */
export async function winsForSize(
  op: "dot" | "matVec" | "matmul" | "simdMap",
  n: number,
  elemBytes = 4,
): Promise<boolean> {
  await ensureInit();
  if (_tier === "native") return _native.winsForSize(op, n, elemBytes);
  return _shim.winsForSize(op, n);
}

/** Resolve the router and return which tier won. */
export async function init(): Promise<Tier> {
  await ensureInit();
  return _tier!;
}

/** The selected tier: "native" | "webgpu" | "cpu". */
export async function tier(): Promise<Tier> {
  await ensureInit();
  return _tier!;
}

/** Human-facing description of the live backend, for diagnostics/logging. */
export async function describe(): Promise<Record<string, unknown>> {
  await ensureInit();
  if (_tier === "native") {
    const inner = typeof _native.describe === "function" ? _native.describe() : {};
    const backend = typeof _native.activeBackend === "function" ? _native.activeBackend() : "native";
    return { tier: "native", backend, ...inner };
  }
  return { tier: _tier, ...(_shim.describe?.() ?? {}) };
}

/** Tear down WebGPU device + reset the router so the next call re-probes. */
export function dispose(): void {
  try {
    _shim?.dispose?.();
  } catch {}
  _tier = null;
  _native = null;
  _shim = null;
  _initPromise = null;
}

export default {
  matmul,
  matVec,
  dot,
  simdMap,
  winsForSize,
  init,
  tier,
  describe,
  dispose,
};
