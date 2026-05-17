// Browser shim for `parabun:gpu`. Two layers:
//
//   1. **Sync CPU path** for the upstream signatures (`matVec`,
//      `matmul`, `dot`, `simdMap`) — scalar loops via @para/simd. Keeps
//      existing .pts code compiling to the browser without an awkward
//      sync→async migration.
//
//   2. **WebGPU backend** for the async variants (`matVecAsync`,
//      `matmulAsync`, `dotAsync`) — real compute shaders with
//      workgroup reduction / tiled matmul. Opt-in via
//      `await gpu.initWebGPU()` at startup.
//
// Shader implementations (WGSL):
//   - matVec: 1 workgroup per output row, 64 threads strided across K,
//     parallel reduction via shared memory. ~5–10× faster than the
//     naive 1-thread-per-row version for typical shapes.
//   - matmul: 16×16 tiled kernel with shared-memory matrix tiles.
//     Each workgroup produces a 16×16 output tile; threads cooperate
//     to load/multiply/accumulate in blocks of 16 across K.
//   - dot: tree reduction. First pass reduces N→N/1024 partials per
//     workgroup; main-thread sums the workgroup outputs.
//
// The WGSL is intentionally portable (avoids subgroup ops, fp16 storage,
// etc.) so it runs on any WebGPU implementation — Chromium, Firefox
// Nightly, Safari 17.4+.

import simd from "@para/simd";
import { dequantizeQ4K, dequantizeQ6K, Q4_K_BLOCK_SIZE, Q6_K_BLOCK_SIZE, QK_K } from "./quant.js";

// ── Sync CPU path — always available ────────────────────────────────────

function dot(a, b) {
  return simd.dot(a, b);
}

function matVec(mat, vec, M, K) {
  const src = mat && mat.buf ? mat.buf : mat;
  return simd.matVec(src, vec, M, K);
}

function matmul(a, b, M, N, K) {
  const out = new a.constructor(M * N);
  for (let i = 0; i < M; i++) {
    for (let j = 0; j < N; j++) {
      let s = 0;
      for (let k = 0; k < K; k++) s += a[i * K + k] * b[k * N + j];
      out[i * N + j] = s;
    }
  }
  return out;
}

function simdMap(fn, a) {
  return simd.simdMap(fn, a);
}

function alloc(n, type) {
  return simd.alloc(n, type);
}

function isAligned(_buf) {
  return true;
}

// ── WebGPU shaders ──────────────────────────────────────────────────────

const MATVEC_WGSL = /* wgsl */ `
struct Dims { M: u32, K: u32, _p0: u32, _p1: u32 };
@group(0) @binding(0) var<storage, read> mat: array<f32>;
@group(0) @binding(1) var<storage, read> vec_in: array<f32>;
@group(0) @binding(2) var<storage, read_write> outv: array<f32>;
@group(0) @binding(3) var<uniform> d: Dims;

var<workgroup> partial: array<f32, 64>;

@compute @workgroup_size(64)
fn main(
  @builtin(workgroup_id) wg: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
) {
  let row = wg.x;
  if (row >= d.M) { return; }

  let tid = lid.x;
  var sum: f32 = 0.0;
  let rowOff = row * d.K;

  // Strided sum: each of 64 threads walks every 64th K-element and
  // accumulates locally. Memory access is coalesced within each stride
  // band as long as threads run in lockstep (they do on WebGPU).
  for (var j: u32 = tid; j < d.K; j = j + 64u) {
    sum = sum + mat[rowOff + j] * vec_in[j];
  }
  partial[tid] = sum;
  workgroupBarrier();

  // Tree reduction within the workgroup: 64 → 32 → 16 → 8 → 4 → 2 → 1.
  var stride: u32 = 32u;
  loop {
    if (stride == 0u) { break; }
    if (tid < stride) {
      partial[tid] = partial[tid] + partial[tid + stride];
    }
    workgroupBarrier();
    stride = stride >> 1u;
  }

  if (tid == 0u) { outv[row] = partial[0]; }
}`;

// 16×16 tiled matmul. One workgroup computes a 16×16 output tile. Each
// thread loads one element of A and one of B into shared memory per
// tile step, then multiply-adds all 16 K-slice products using the
// shared tiles. Loops over K in 16-wide strides.
const MATMUL_WGSL = /* wgsl */ `
struct Dims { M: u32, N: u32, K: u32, _p0: u32 };
@group(0) @binding(0) var<storage, read> ma: array<f32>;
@group(0) @binding(1) var<storage, read> mb: array<f32>;
@group(0) @binding(2) var<storage, read_write> mc: array<f32>;
@group(0) @binding(3) var<uniform> d: Dims;

const TILE: u32 = 16u;
var<workgroup> tileA: array<f32, 256>;  // 16×16
var<workgroup> tileB: array<f32, 256>;

@compute @workgroup_size(16, 16)
fn main(
  @builtin(workgroup_id) wg: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
) {
  let row = wg.y * TILE + lid.y;
  let col = wg.x * TILE + lid.x;

  var acc: f32 = 0.0;
  let steps = (d.K + TILE - 1u) / TILE;

  for (var s: u32 = 0u; s < steps; s = s + 1u) {
    let aCol = s * TILE + lid.x;
    let bRow = s * TILE + lid.y;

    // Load A[row, aCol] and B[bRow, col] into the tile caches. Bounds-
    // checked so we can still run on non-tile-multiple shapes.
    if (row < d.M && aCol < d.K) {
      tileA[lid.y * TILE + lid.x] = ma[row * d.K + aCol];
    } else {
      tileA[lid.y * TILE + lid.x] = 0.0;
    }
    if (bRow < d.K && col < d.N) {
      tileB[lid.y * TILE + lid.x] = mb[bRow * d.N + col];
    } else {
      tileB[lid.y * TILE + lid.x] = 0.0;
    }
    workgroupBarrier();

    for (var k: u32 = 0u; k < TILE; k = k + 1u) {
      acc = acc + tileA[lid.y * TILE + k] * tileB[k * TILE + lid.x];
    }
    workgroupBarrier();
  }

  if (row < d.M && col < d.N) {
    mc[row * d.N + col] = acc;
  }
}`;

// 2D valid-mode convolution. Output[y, x] = sum_{ky, kx} input[y+ky, x+kx]
// * kernel[ky, kx]. Output dims (iH-kH+1) × (iW-kW+1). One thread per
// output pixel, 16×16 workgroups; nested loops over the kernel. Direct
// global loads — no shared-memory tile for v1 (worth optimizing later
// for kernels >= 7×7 where input reuse pays for staging cost).
const CONV2D_WGSL = /* wgsl */ `
struct Dims { iW: u32, iH: u32, kW: u32, kH: u32 };
@group(0) @binding(0) var<storage, read> inp: array<f32>;
@group(0) @binding(1) var<storage, read> krn: array<f32>;
@group(0) @binding(2) var<storage, read_write> outp: array<f32>;
@group(0) @binding(3) var<uniform> d: Dims;

@compute @workgroup_size(16, 16)
fn main(
  @builtin(global_invocation_id) gid: vec3<u32>,
) {
  let x = gid.x;
  let y = gid.y;
  let oW = d.iW - d.kW + 1u;
  let oH = d.iH - d.kH + 1u;
  if (x >= oW || y >= oH) { return; }
  var acc: f32 = 0.0;
  for (var ky: u32 = 0u; ky < d.kH; ky = ky + 1u) {
    let inRow = (y + ky) * d.iW + x;
    let kRow = ky * d.kW;
    for (var kx: u32 = 0u; kx < d.kW; kx = kx + 1u) {
      acc = acc + inp[inRow + kx] * krn[kRow + kx];
    }
  }
  outp[y * oW + x] = acc;
}`;

// Dot product as a two-pass reduction: first pass computes one partial
// per workgroup (1024-thread block sums), main thread sums the partials.
const DOT_WGSL = /* wgsl */ `
struct Dims { N: u32, _p0: u32, _p1: u32, _p2: u32 };
@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> b: array<f32>;
@group(0) @binding(2) var<storage, read_write> partials: array<f32>;
@group(0) @binding(3) var<uniform> d: Dims;

var<workgroup> shared_sums: array<f32, 256>;

@compute @workgroup_size(256)
fn main(
  @builtin(workgroup_id) wg: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
) {
  let tid = lid.x;
  let gid = wg.x * 256u + tid;
  let stride = 256u * 65536u;  // global stride per iteration

  var sum: f32 = 0.0;
  var i: u32 = gid;
  loop {
    if (i >= d.N) { break; }
    sum = sum + a[i] * b[i];
    i = i + stride;
  }
  shared_sums[tid] = sum;
  workgroupBarrier();

  var s: u32 = 128u;
  loop {
    if (s == 0u) { break; }
    if (tid < s) { shared_sums[tid] = shared_sums[tid] + shared_sums[tid + s]; }
    workgroupBarrier();
    s = s >> 1u;
  }

  if (tid == 0u) { partials[wg.x] = shared_sums[0]; }
}`;

// ── Device/pipeline state ───────────────────────────────────────────────

const _wgState = {
  available: false,
  initPromise: null,
  device: null,
  queue: null,
  matVecPipeline: null,
  matVecLayout: null,
  matmulPipeline: null,
  matmulLayout: null,
  dotPipeline: null,
  dotLayout: null,
  conv2DPipeline: null,
  conv2DLayout: null,
  error: null,
};

function _makeBindLayout(device, buffers) {
  return device.createBindGroupLayout({
    entries: buffers.map((kind, i) => ({
      binding: i,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: kind },
    })),
  });
}

function _makePipeline(device, wgsl, layout) {
  return device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module: device.createShaderModule({ code: wgsl }), entryPoint: "main" },
  });
}

async function _initWebGPUInternal() {
  if (typeof navigator === "undefined" || !navigator.gpu) {
    _wgState.error = "navigator.gpu unavailable (WebGPU not supported in this browser)";
    return false;
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    _wgState.error = "navigator.gpu.requestAdapter() returned null";
    return false;
  }
  const device = await adapter.requestDevice();

  const threeRW = ["read-only-storage", "read-only-storage", "storage", "uniform"];
  const matVecLayout = _makeBindLayout(device, threeRW);
  const matmulLayout = _makeBindLayout(device, threeRW);
  const dotLayout = _makeBindLayout(device, threeRW);

  _wgState.device = device;
  _wgState.queue = device.queue;
  _wgState.matVecLayout = matVecLayout;
  _wgState.matVecPipeline = _makePipeline(device, MATVEC_WGSL, matVecLayout);
  _wgState.matmulLayout = matmulLayout;
  _wgState.matmulPipeline = _makePipeline(device, MATMUL_WGSL, matmulLayout);
  _wgState.dotLayout = dotLayout;
  _wgState.dotPipeline = _makePipeline(device, DOT_WGSL, dotLayout);
  const conv2DLayout = _makeBindLayout(device, threeRW);
  _wgState.conv2DLayout = conv2DLayout;
  _wgState.conv2DPipeline = _makePipeline(device, CONV2D_WGSL, conv2DLayout);
  _wgState.available = true;
  return true;
}

export function initWebGPU() {
  if (!_wgState.initPromise) _wgState.initPromise = _initWebGPUInternal();
  return _wgState.initPromise;
}

// ── Buffer helpers ──────────────────────────────────────────────────────

function _uploadStorage(data) {
  const { device, queue } = _wgState;
  const buf = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  queue.writeBuffer(buf, 0, data.buffer, data.byteOffset, data.byteLength);
  return buf;
}

function _uniform(u32s) {
  const { device, queue } = _wgState;
  const bytes = Math.max(16, u32s.length * 4);
  const buf = device.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const arr = new Uint32Array(bytes / 4);
  arr.set(u32s);
  queue.writeBuffer(buf, 0, arr);
  return buf;
}

async function _readback(gpuBuf, bytes) {
  const { device, queue } = _wgState;
  const dst = device.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(gpuBuf, 0, dst, 0, bytes);
  queue.submit([enc.finish()]);
  await dst.mapAsync(GPUMapMode.READ);
  const out = new Float32Array(dst.getMappedRange().slice(0));
  dst.unmap();
  dst.destroy();
  return out;
}

// ── matVecAsync ─────────────────────────────────────────────────────────

export async function matVecAsync(mat, vec, M, K) {
  if (!_wgState.available) return matVec(mat, vec, M, K);
  const { device, queue, matVecPipeline, matVecLayout } = _wgState;

  const matSrc = mat && mat._gpuBuffer ? mat._gpuBuffer : _uploadStorage(mat && mat.buf ? mat.buf : mat);
  const ownMat = !(mat && mat._gpuBuffer);
  const vecBuf = _uploadStorage(vec);
  const outBuf = device.createBuffer({
    size: M * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const dimsBuf = _uniform([M, K, 0, 0]);

  const bg = device.createBindGroup({
    layout: matVecLayout,
    entries: [
      { binding: 0, resource: { buffer: matSrc } },
      { binding: 1, resource: { buffer: vecBuf } },
      { binding: 2, resource: { buffer: outBuf } },
      { binding: 3, resource: { buffer: dimsBuf } },
    ],
  });

  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(matVecPipeline);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(M);
  pass.end();
  queue.submit([enc.finish()]);

  const out = await _readback(outBuf, M * 4);
  vecBuf.destroy();
  outBuf.destroy();
  dimsBuf.destroy();
  if (ownMat) matSrc.destroy();
  return out;
}

// ── matmulAsync ─────────────────────────────────────────────────────────

export async function matmulAsync(a, b, M, N, K) {
  if (!_wgState.available) return matmul(a, b, M, N, K);
  const { device, queue, matmulPipeline, matmulLayout } = _wgState;

  const aBuf = _uploadStorage(a);
  const bBuf = _uploadStorage(b);
  const cBuf = device.createBuffer({
    size: M * N * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const dimsBuf = _uniform([M, N, K, 0]);

  const bg = device.createBindGroup({
    layout: matmulLayout,
    entries: [
      { binding: 0, resource: { buffer: aBuf } },
      { binding: 1, resource: { buffer: bBuf } },
      { binding: 2, resource: { buffer: cBuf } },
      { binding: 3, resource: { buffer: dimsBuf } },
    ],
  });

  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(matmulPipeline);
  pass.setBindGroup(0, bg);
  const tilesX = Math.ceil(N / 16);
  const tilesY = Math.ceil(M / 16);
  pass.dispatchWorkgroups(tilesX, tilesY);
  pass.end();
  queue.submit([enc.finish()]);

  const out = await _readback(cBuf, M * N * 4);
  aBuf.destroy();
  bBuf.destroy();
  cBuf.destroy();
  dimsBuf.destroy();
  return out;
}

// ── dotAsync ────────────────────────────────────────────────────────────

export async function dotAsync(a, b) {
  if (!_wgState.available) return dot(a, b);
  const { device, queue, dotPipeline, dotLayout } = _wgState;
  const N = a.length;
  const wgCount = Math.min(65536, Math.max(1, Math.ceil(N / 256)));

  const aBuf = _uploadStorage(a);
  const bBuf = _uploadStorage(b);
  const partials = device.createBuffer({
    size: wgCount * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const dimsBuf = _uniform([N, 0, 0, 0]);

  const bg = device.createBindGroup({
    layout: dotLayout,
    entries: [
      { binding: 0, resource: { buffer: aBuf } },
      { binding: 1, resource: { buffer: bBuf } },
      { binding: 2, resource: { buffer: partials } },
      { binding: 3, resource: { buffer: dimsBuf } },
    ],
  });

  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(dotPipeline);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(wgCount);
  pass.end();
  queue.submit([enc.finish()]);

  const partArr = await _readback(partials, wgCount * 4);
  let acc = 0;
  for (let i = 0; i < partArr.length; i++) acc += partArr[i];

  aBuf.destroy();
  bBuf.destroy();
  partials.destroy();
  dimsBuf.destroy();
  return acc;
}

// ── conv2D / conv2DAsync ────────────────────────────────────────────────
// Valid-mode 2D convolution. Output dims (iH-kH+1) × (iW-kW+1). The sync
// path is a naive loop — fine for small kernels and small images. Use
// conv2DAsync when WebGPU is live for any meaningful workload.

function conv2D(input, kernel, iW, iH, kW, kH) {
  const oW = iW - kW + 1;
  const oH = iH - kH + 1;
  const out = new Float32Array(oW * oH);
  for (let y = 0; y < oH; y++) {
    for (let x = 0; x < oW; x++) {
      let acc = 0;
      for (let ky = 0; ky < kH; ky++) {
        const inRow = (y + ky) * iW + x;
        const kRow = ky * kW;
        for (let kx = 0; kx < kW; kx++) acc += input[inRow + kx] * kernel[kRow + kx];
      }
      out[y * oW + x] = acc;
    }
  }
  return out;
}

export async function conv2DAsync(input, kernel, iW, iH, kW, kH) {
  if (!_wgState.available) return conv2D(input, kernel, iW, iH, kW, kH);
  const { device, queue, conv2DPipeline, conv2DLayout } = _wgState;

  const oW = iW - kW + 1;
  const oH = iH - kH + 1;
  const inBuf = _uploadStorage(input);
  const kBuf = _uploadStorage(kernel);
  const outBuf = device.createBuffer({
    size: oW * oH * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const dimsBuf = _uniform([iW, iH, kW, kH]);

  const bg = device.createBindGroup({
    layout: conv2DLayout,
    entries: [
      { binding: 0, resource: { buffer: inBuf } },
      { binding: 1, resource: { buffer: kBuf } },
      { binding: 2, resource: { buffer: outBuf } },
      { binding: 3, resource: { buffer: dimsBuf } },
    ],
  });

  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(conv2DPipeline);
  pass.setBindGroup(0, bg);
  // 16×16 threads per workgroup; cover oW×oH output pixels.
  pass.dispatchWorkgroups(Math.ceil(oW / 16), Math.ceil(oH / 16));
  pass.end();
  queue.submit([enc.finish()]);

  const out = await _readback(outBuf, oW * oH * 4);
  inBuf.destroy();
  kBuf.destroy();
  outBuf.destroy();
  dimsBuf.destroy();
  return out;
}

// ── hold() / release() ──────────────────────────────────────────────────

function hold(buf) {
  if (_wgState.available) {
    const gpuBuf = _uploadStorage(buf);
    return { kind: "gpu", buf, _gpuBuffer: gpuBuf };
  }
  return { kind: "cpu", buf };
}
// Q4_K / Q6_K holds: dequantize the packed blocks into an f32 tensor
// once at hold-time, then feed that f32 buffer into the regular
// matVec / matVecAsync paths. Upload to GPU if WebGPU is live.
//
// A future upgrade runs the dequantization inside the compute shader
// — saves memory (no intermediate f32 copy) and halves bandwidth on
// GPU. The format-specific WGSL ports are tracked in the README
// roadmap; this hold/dequant path is what makes quantized weights
// usable end-to-end today.
function holdQ4K(buf, totalElements) {
  const nBlocks = buf.byteLength / Q4_K_BLOCK_SIZE;
  if (nBlocks !== (nBlocks | 0)) {
    throw new Error(`holdQ4K: buffer length ${buf.byteLength} not a multiple of ${Q4_K_BLOCK_SIZE}`);
  }
  const n = totalElements ?? nBlocks * QK_K;
  const f32 = new Float32Array(n);
  dequantizeQ4K(buf, f32, n);
  const handle = { kind: "q4k", buf: f32 };
  if (_wgState.available) handle._gpuBuffer = _uploadStorage(f32);
  return handle;
}
function holdQ6K(buf, totalElements) {
  const nBlocks = buf.byteLength / Q6_K_BLOCK_SIZE;
  if (nBlocks !== (nBlocks | 0)) {
    throw new Error(`holdQ6K: buffer length ${buf.byteLength} not a multiple of ${Q6_K_BLOCK_SIZE}`);
  }
  const n = totalElements ?? nBlocks * QK_K;
  const f32 = new Float32Array(n);
  dequantizeQ6K(buf, f32, n);
  const handle = { kind: "q6k", buf: f32 };
  if (_wgState.available) handle._gpuBuffer = _uploadStorage(f32);
  return handle;
}
function release(held) {
  if (held && held._gpuBuffer) held._gpuBuffer.destroy();
}
function releasePinned(_buf) {}

class GpuFloat32Array extends Float32Array {}
class GpuHandleArray {
  constructor(items = []) {
    this.items = items;
  }
  push(x) {
    this.items.push(x);
  }
  get length() {
    return this.items.length;
  }
}

function activeBackend() {
  return _wgState.available ? "webgpu" : "cpu";
}
function hasBackend(name) {
  if (name === "webgpu") return _wgState.available;
  if (name === "cpu") return true;
  return false;
}
function setBackend(_name) {}
function winsForSize(op, n) {
  if (!_wgState.available) return false;
  if (op === "matVec") return n >= 65536;
  if (op === "matmul") return n >= 4096;
  if (op === "dot") return n >= 262144;
  return false;
}
function calibrate() {}
function dispose() {
  if (_wgState.device) _wgState.device.destroy?.();
  _wgState.available = false;
  _wgState.device = null;
  _wgState.queue = null;
  _wgState.matVecPipeline = null;
  _wgState.matmulPipeline = null;
  _wgState.dotPipeline = null;
  _wgState.matVecLayout = null;
  _wgState.matmulLayout = null;
  _wgState.dotLayout = null;
  _wgState.initPromise = null;
}
function describe() {
  return {
    backend: activeBackend(),
    webgpu: _wgState.available,
    error: _wgState.error,
    kernels: _wgState.available ? ["matVecAsync", "matmulAsync", "dotAsync", "conv2DAsync"] : [],
    note: _wgState.available
      ? "WebGPU backend active. Async kernels dispatch to GPU; sync surface stays CPU."
      : "CPU only. Call `await gpu.initWebGPU()` to enable WebGPU async kernels.",
  };
}
function getDevOps() {
  return { matVec, matVecAsync, matmul, matmulAsync, dot, dotAsync, conv2D, conv2DAsync };
}

export {
  dot,
  matVec,
  matmul,
  conv2D,
  simdMap,
  alloc,
  isAligned,
  hold,
  holdQ4K,
  holdQ6K,
  release,
  releasePinned,
  GpuFloat32Array,
  GpuHandleArray,
  activeBackend,
  hasBackend,
  setBackend,
  winsForSize,
  calibrate,
  dispose,
  describe,
  getDevOps,
};

export default {
  dot,
  dotAsync,
  matVec,
  matVecAsync,
  matmul,
  matmulAsync,
  conv2D,
  conv2DAsync,
  simdMap,
  alloc,
  isAligned,
  hold,
  holdQ4K,
  holdQ6K,
  release,
  releasePinned,
  GpuFloat32Array,
  GpuHandleArray,
  activeBackend,
  hasBackend,
  setBackend,
  winsForSize,
  calibrate,
  dispose,
  describe,
  getDevOps,
  initWebGPU,
};
