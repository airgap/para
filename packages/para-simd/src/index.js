// Browser shim for `@para/simd`. Default path is WASM v128 kernels from
// src/simd.wasm; falls back to scalar JS loops when
// WebAssembly SIMD isn't available or the module can't be instantiated
// (older browsers, restrictive CSP). The API surface matches upstream
// `@para/simd` — callers don't need to know which path is live.
//
// Performance notes:
//   - Small inputs (N < SCALAR_THRESHOLD) use scalar loops unconditionally
//     — the WASM call + copy-in/out overhead dominates below ~256 elements.
//   - Medium/large inputs copy into the WASM linear memory, run the
//     v128 kernel, copy out. Typical speedup vs. scalar JS is ~3–6×
//     for N = 10k, ~5–20× for N = 1M.
//   - `alloc(n, "f32")` returns a Float32Array view backed directly by
//     the WASM linear memory. Calls on such arrays skip the copy-in
//     step — this is the zero-copy path the upstream native surface
//     also advertises.

const SCALAR_THRESHOLD = 256;

// ── WASM module loading ─────────────────────────────────────────────────

let _wasmState = null; // { memory, kernels: { mulScalar, ... }, heapF32, heapU8, top }
let _wasmInitPromise = null;

async function _loadWasm() {
  try {
    const url = new URL("./simd.wasm", import.meta.url);
    let bytes;
    if (typeof fetch !== "undefined" && (url.protocol === "http:" || url.protocol === "https:")) {
      const res = await fetch(url);
      if (!res.ok) return null;
      bytes = new Uint8Array(await res.arrayBuffer());
    } else {
      // Node/Bun or file:// URL — read from disk.
      const { readFile } = await import("node:fs/promises");
      bytes = await readFile(url);
    }
    // If the browser lacks WASM SIMD support, `instantiate` throws on
    // the v128 opcodes — that's our feature detection.
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const mem = instance.exports.mem;
    return {
      memory: mem,
      kernels: instance.exports,
      heapF32: new Float32Array(mem.buffer),
      heapU8: new Uint8Array(mem.buffer),
      // Bump allocator inside the wasm memory. JS allocates slots at
      // `top`, refreshes `heapF32` views when memory grows. `alloc()`
      // increments `top` permanently; call-scoped scratch buffers use
      // `withScratch()` which restores `top` on return.
      top: 0,
    };
  } catch {
    return null;
  }
}

export async function _initWasm() {
  if (!_wasmInitPromise) _wasmInitPromise = _loadWasm().then(s => (_wasmState = s));
  return _wasmInitPromise;
}

// Try to instantiate on module load — non-blocking; sync calls that
// land before this settles use the scalar path.
_initWasm();

function _grow(elements) {
  const { memory } = _wasmState;
  const neededBytes = _wasmState.top + elements * 4;
  if (neededBytes > memory.buffer.byteLength) {
    const extra = Math.ceil((neededBytes - memory.buffer.byteLength) / 65536);
    memory.grow(extra);
    _wasmState.heapF32 = new Float32Array(memory.buffer);
    _wasmState.heapU8 = new Uint8Array(memory.buffer);
  }
}

function _withScratch(elementsNeeded, fn) {
  const savedTop = _wasmState.top;
  _grow(elementsNeeded);
  const ptr = _wasmState.top;
  _wasmState.top = savedTop + elementsNeeded * 4;
  try {
    return fn(ptr);
  } finally {
    _wasmState.top = savedTop;
  }
}

function _isWasmBacked(a) {
  return _wasmState !== null && a instanceof Float32Array && a.buffer === _wasmState.memory.buffer;
}

function _copyIn(a) {
  // Copies the source into scratch, returns the byte pointer.
  const ptr = _wasmState.top;
  _wasmState.heapF32.set(a, ptr >> 2);
  _wasmState.top += a.length * 4;
  return ptr;
}

// ── Scalar fallbacks ────────────────────────────────────────────────────

function _mulScalarJS(a, k) {
  const n = a.length,
    out = new a.constructor(n);
  for (let i = 0; i < n; i++) out[i] = a[i] * k;
  return out;
}
function _addScalarJS(a, k) {
  const n = a.length,
    out = new a.constructor(n);
  for (let i = 0; i < n; i++) out[i] = a[i] + k;
  return out;
}
function _addJS(a, b) {
  const n = a.length,
    out = new a.constructor(n);
  for (let i = 0; i < n; i++) out[i] = a[i] + b[i];
  return out;
}
function _mulJS(a, b) {
  const n = a.length,
    out = new a.constructor(n);
  for (let i = 0; i < n; i++) out[i] = a[i] * b[i];
  return out;
}
function _sumJS(a) {
  let s = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) s += a[i];
  return s;
}
function _dotJS(a, b) {
  let s = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

// ── Public kernels ──────────────────────────────────────────────────────

// `@para/simd` is f32-first. Float64Array inputs go straight to the
// scalar path — the WASM module is f32-only, Float64 falls back.
function _isF32(a) {
  return a instanceof Float32Array;
}

function mulScalar(a, k) {
  if (_wasmState && _isF32(a) && a.length >= SCALAR_THRESHOLD) {
    const n = a.length;
    const out = new Float32Array(n);
    const savedTop = _wasmState.top;
    try {
      _grow(n + n);
      const aPtr = _isWasmBacked(a) ? a.byteOffset : _copyIn(a);
      const outPtr = _wasmState.top;
      _wasmState.top += n * 4;
      _wasmState.kernels.mulScalar(aPtr, n, k, outPtr);
      out.set(_wasmState.heapF32.subarray(outPtr >> 2, (outPtr >> 2) + n));
      return out;
    } finally {
      _wasmState.top = savedTop;
    }
  }
  return _mulScalarJS(a, k);
}

function addScalar(a, k) {
  if (_wasmState && _isF32(a) && a.length >= SCALAR_THRESHOLD) {
    const n = a.length;
    const out = new Float32Array(n);
    const savedTop = _wasmState.top;
    try {
      _grow(n + n);
      const aPtr = _isWasmBacked(a) ? a.byteOffset : _copyIn(a);
      const outPtr = _wasmState.top;
      _wasmState.top += n * 4;
      _wasmState.kernels.addScalar(aPtr, n, k, outPtr);
      out.set(_wasmState.heapF32.subarray(outPtr >> 2, (outPtr >> 2) + n));
      return out;
    } finally {
      _wasmState.top = savedTop;
    }
  }
  return _addScalarJS(a, k);
}

function add(a, b) {
  if (_wasmState && _isF32(a) && _isF32(b) && a.length >= SCALAR_THRESHOLD) {
    const n = a.length;
    const out = new Float32Array(n);
    const savedTop = _wasmState.top;
    try {
      _grow(n * 3);
      const aPtr = _isWasmBacked(a) ? a.byteOffset : _copyIn(a);
      const bPtr = _isWasmBacked(b) ? b.byteOffset : _copyIn(b);
      const outPtr = _wasmState.top;
      _wasmState.top += n * 4;
      _wasmState.kernels.add(aPtr, bPtr, n, outPtr);
      out.set(_wasmState.heapF32.subarray(outPtr >> 2, (outPtr >> 2) + n));
      return out;
    } finally {
      _wasmState.top = savedTop;
    }
  }
  return _addJS(a, b);
}

function mul(a, b) {
  if (_wasmState && _isF32(a) && _isF32(b) && a.length >= SCALAR_THRESHOLD) {
    const n = a.length;
    const out = new Float32Array(n);
    const savedTop = _wasmState.top;
    try {
      _grow(n * 3);
      const aPtr = _isWasmBacked(a) ? a.byteOffset : _copyIn(a);
      const bPtr = _isWasmBacked(b) ? b.byteOffset : _copyIn(b);
      const outPtr = _wasmState.top;
      _wasmState.top += n * 4;
      _wasmState.kernels.mul(aPtr, bPtr, n, outPtr);
      out.set(_wasmState.heapF32.subarray(outPtr >> 2, (outPtr >> 2) + n));
      return out;
    } finally {
      _wasmState.top = savedTop;
    }
  }
  return _mulJS(a, b);
}

function sum(a) {
  if (_wasmState && _isF32(a) && a.length >= SCALAR_THRESHOLD) {
    const n = a.length;
    const savedTop = _wasmState.top;
    try {
      _grow(n);
      const aPtr = _isWasmBacked(a) ? a.byteOffset : _copyIn(a);
      return _wasmState.kernels.sum(aPtr, n);
    } finally {
      _wasmState.top = savedTop;
    }
  }
  return _sumJS(a);
}

function dot(a, b) {
  if (_wasmState && _isF32(a) && _isF32(b) && a.length >= SCALAR_THRESHOLD) {
    const n = a.length;
    const savedTop = _wasmState.top;
    try {
      _grow(n * 2);
      const aPtr = _isWasmBacked(a) ? a.byteOffset : _copyIn(a);
      const bPtr = _isWasmBacked(b) ? b.byteOffset : _copyIn(b);
      return _wasmState.kernels.dot(aPtr, bPtr, n);
    } finally {
      _wasmState.top = savedTop;
    }
  }
  return _dotJS(a, b);
}

// ── Kernels without WASM backing yet ────────────────────────────────────

function matVec(mat, vec, M, K) {
  // Straight scalar for now — a v128 matVec with workgroup-style
  // per-row reduction is a future upgrade. WebGPU path in parabun:gpu
  // covers the large-matrix case.
  const out = new vec.constructor(M);
  for (let i = 0; i < M; i++) {
    let s = 0;
    const row = i * K;
    for (let j = 0; j < K; j++) s += mat[row + j] * vec[j];
    out[i] = s;
  }
  return out;
}

function simdMap(fn, a) {
  const n = a.length;
  const out = new a.constructor(n);
  for (let i = 0; i < n; i++) out[i] = fn(a[i]);
  return out;
}

function topK(a, k) {
  const n = a.length;
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((x, y) => a[y] - a[x]);
  const values = a.constructor.from(idx.slice(0, k), i => a[i]);
  return { indices: idx.slice(0, k), values };
}

function alloc(n, type) {
  if (type === "f32" || type === "float32") {
    if (_wasmState) {
      const bytes = n * 4;
      _grow(n);
      const ptr = _wasmState.top;
      _wasmState.top += bytes;
      return new Float32Array(_wasmState.memory.buffer, ptr, n);
    }
    return new Float32Array(n);
  }
  if (type === "f64" || type === "float64") return new Float64Array(n);
  throw new Error(`@para/simd alloc: unsupported dtype "${type}" (browser shim supports f32 / f64)`);
}

// ── Probes ──────────────────────────────────────────────────────────────

const isWasmAvailable = () => _wasmState !== null;
const isWasmBacked = _isWasmBacked;
function wasmWinsForSize(_op, n) {
  return _wasmState !== null && n >= SCALAR_THRESHOLD;
}
const hasUnifiedMemoryGPU = () => false;
const hasDiscreteGPU = () => false;

export {
  mulScalar,
  addScalar,
  add,
  mul,
  sum,
  dot,
  matVec,
  topK,
  simdMap,
  alloc,
  isWasmAvailable,
  isWasmBacked,
  wasmWinsForSize,
  hasUnifiedMemoryGPU,
  hasDiscreteGPU,
};
export default {
  mulScalar,
  addScalar,
  add,
  mul,
  sum,
  dot,
  matVec,
  topK,
  simdMap,
  alloc,
  isWasmAvailable,
  isWasmBacked,
  wasmWinsForSize,
  hasUnifiedMemoryGPU,
  hasDiscreteGPU,
};
