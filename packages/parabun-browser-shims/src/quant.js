// Q4_K / Q6_K / Q8_0 block dequantizers. Matches ggml's block layouts
// byte-for-byte so weights loaded from a GGUF file decode correctly
// without extra transforms.
//
// These are CPU dequantizers — they hydrate a packed block into a
// Float32Array the regular f32 matVec / matVecAsync kernels can
// consume. A WebGPU kernel that operates on the packed blocks directly
// (dequantize-on-the-fly inside the compute shader) is future work;
// see the README "Roadmap to in-browser LLM inference" section.
//
// All block formats below are from ggml-common.h — super-block size
// QK_K = 256.

export const QK_K = 256;

// ── fp16 → fp32 ─────────────────────────────────────────────────────────

// IEEE 754 binary16 → binary32, handling normals / subnormals / zero /
// inf / NaN. Matches `GGML_FP16_TO_FP32` for all valid inputs. If a
// runtime ever exposes a faster native path (e.g. DataView.getFloat16
// is not universally shipped yet), callers can override this.
export function fp16ToFp32(h) {
  const s = (h >> 15) & 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) {
    if (f === 0) return s ? -0 : 0;
    return (s ? -1 : 1) * f * 5.9604644775390625e-8; // 2^-24
  }
  if (e === 31) {
    if (f === 0) return s ? -Infinity : Infinity;
    return NaN;
  }
  return (s ? -1 : 1) * (1 + f / 1024) * Math.pow(2, e - 15);
}

// ── Q4_K ────────────────────────────────────────────────────────────────

// Block layout (144 bytes, 256 elements):
//   0..1     d     (fp16)
//   2..3     dmin  (fp16)
//   4..15    scales[12]   — 6-bit scales + 6-bit mins for 8 sub-blocks
//   16..143  qs[128]      — 4-bit quants, 2 per byte
//
// 8 sub-blocks × 32 elements each. Sub-blocks 0..3 use the low nibble
// of qs[0..31]/[32..63]/... and scales[0..3]/mins scales[4..7].
// Sub-blocks 4..7 use the high nibble and an awkwardly packed scale
// layout across scales[0..11]. See `getScaleMinK4` below.
export const Q4_K_BLOCK_SIZE = 144;

function getScaleMinK4(is, scales) {
  // Unpack the is'th (scale, min) pair out of the 12 bytes in `scales`.
  // The layout is ggml's; the decomposition below is copied verbatim
  // from ggml's `get_scale_min_k4` (ggml/src/ggml-quants.c).
  if (is < 4) {
    return [scales[is] & 63, scales[is + 4] & 63];
  }
  const d = (scales[is + 4] & 0xf) | ((scales[is - 4] >> 6) << 4);
  const m = (scales[is + 4] >> 4) | ((scales[is] >> 6) << 4);
  return [d, m];
}

export function dequantizeQ4KBlock(bytes, byteOffset, out, outOffset) {
  // `bytes` is a Uint8Array OR ArrayBuffer view covering at least
  // Q4_K_BLOCK_SIZE bytes starting at `byteOffset`. Writes 256 f32
  // values into `out` starting at `outOffset`.
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0);
  const base = byteOffset;

  const dRaw = u8[base] | (u8[base + 1] << 8);
  const dminRaw = u8[base + 2] | (u8[base + 3] << 8);
  const d = fp16ToFp32(dRaw);
  const dmin = fp16ToFp32(dminRaw);

  const scales = u8.subarray(base + 4, base + 16);
  const qs = u8.subarray(base + 16, base + 144);

  let outIdx = outOffset;
  for (let sb = 0; sb < 4; sb++) {
    const [sc1, m1] = getScaleMinK4(2 * sb, scales);
    const [sc2, m2] = getScaleMinK4(2 * sb + 1, scales);
    const d1 = d * sc1;
    const off1 = dmin * m1;
    const d2 = d * sc2;
    const off2 = dmin * m2;
    const qBase = sb * 32;
    for (let l = 0; l < 32; l++) {
      out[outIdx + l] = d1 * (qs[qBase + l] & 0xf) - off1;
    }
    for (let l = 0; l < 32; l++) {
      out[outIdx + 32 + l] = d2 * (qs[qBase + l] >> 4) - off2;
    }
    outIdx += 64;
  }
}

// ── Q6_K ────────────────────────────────────────────────────────────────

// Block layout (210 bytes, 256 elements):
//   0..127    ql[128]  — 4 lower bits of each 6-bit quant, 2 per byte
//   128..191  qh[64]   — 2 upper bits of each 6-bit quant, 4 per byte
//   192..207  scales[16] (int8 — signed scales for 16 sub-blocks of 16)
//   208..209  d (fp16)
export const Q6_K_BLOCK_SIZE = 210;

export function dequantizeQ6KBlock(bytes, byteOffset, out, outOffset) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0);
  const base = byteOffset;

  const ql = u8.subarray(base, base + 128);
  const qh = u8.subarray(base + 128, base + 192);
  // scales[] is signed int8.
  const scalesRaw = u8.subarray(base + 192, base + 208);
  const scales = new Int8Array(scalesRaw.buffer, scalesRaw.byteOffset, 16);

  const dRaw = u8[base + 208] | (u8[base + 209] << 8);
  const d = fp16ToFp32(dRaw);

  // 2 passes of 128 elements each; each pass reconstructs the 6-bit
  // quant by OR-ing the 4-bit low half with the 2-bit high half
  // shifted into place, then zero-centers (-32) and scales.
  for (let n = 0; n < 2; n++) {
    const qlOff = n * 64;
    const qhOff = n * 32;
    const scaleOff = n * 8;
    const outOff = outOffset + n * 128;

    for (let l = 0; l < 32; l++) {
      const is = (l / 16) | 0;
      const q1 = ((ql[qlOff + l + 0] & 0xf) | (((qh[qhOff + l] >> 0) & 3) << 4)) - 32;
      const q2 = ((ql[qlOff + l + 32] & 0xf) | (((qh[qhOff + l] >> 2) & 3) << 4)) - 32;
      const q3 = ((ql[qlOff + l + 0] >> 4) | (((qh[qhOff + l] >> 4) & 3) << 4)) - 32;
      const q4 = ((ql[qlOff + l + 32] >> 4) | (((qh[qhOff + l] >> 6) & 3) << 4)) - 32;

      out[outOff + l + 0] = d * scales[scaleOff + is + 0] * q1;
      out[outOff + l + 32] = d * scales[scaleOff + is + 2] * q2;
      out[outOff + l + 64] = d * scales[scaleOff + is + 4] * q3;
      out[outOff + l + 96] = d * scales[scaleOff + is + 6] * q4;
    }
  }
}

// ── Q8_0 ────────────────────────────────────────────────────────────────

// Block layout (34 bytes, 32 elements):
//   0..1    d  (fp16)
//   2..33   qs[32] (int8)
export const Q8_0_BLOCK_SIZE = 34;
export const Q8_0_ELEMENTS = 32;

export function dequantizeQ80Block(bytes, byteOffset, out, outOffset) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0);
  const dRaw = u8[byteOffset] | (u8[byteOffset + 1] << 8);
  const d = fp16ToFp32(dRaw);
  const qs = new Int8Array(u8.buffer, u8.byteOffset + byteOffset + 2, 32);
  for (let i = 0; i < 32; i++) out[outOffset + i] = d * qs[i];
}

// ── Bulk dequantizers ───────────────────────────────────────────────────

export function dequantizeQ4K(bytes, out, totalElements) {
  const nBlocks = totalElements / QK_K;
  if (nBlocks !== (nBlocks | 0)) {
    throw new Error(`dequantizeQ4K: totalElements (${totalElements}) not a multiple of ${QK_K}`);
  }
  const expectedBytes = nBlocks * Q4_K_BLOCK_SIZE;
  if (bytes.byteLength < expectedBytes) {
    throw new Error(
      `dequantizeQ4K: buffer too small (${bytes.byteLength} < ${expectedBytes} for ${totalElements} elements)`,
    );
  }
  for (let i = 0; i < nBlocks; i++) {
    dequantizeQ4KBlock(bytes, i * Q4_K_BLOCK_SIZE, out, i * QK_K);
  }
}

export function dequantizeQ6K(bytes, out, totalElements) {
  const nBlocks = totalElements / QK_K;
  if (nBlocks !== (nBlocks | 0)) {
    throw new Error(`dequantizeQ6K: totalElements (${totalElements}) not a multiple of ${QK_K}`);
  }
  for (let i = 0; i < nBlocks; i++) {
    dequantizeQ6KBlock(bytes, i * Q6_K_BLOCK_SIZE, out, i * QK_K);
  }
}

export function dequantizeQ80(bytes, out, totalElements) {
  const nBlocks = totalElements / Q8_0_ELEMENTS;
  if (nBlocks !== (nBlocks | 0)) {
    throw new Error(`dequantizeQ80: totalElements (${totalElements}) not a multiple of 32`);
  }
  for (let i = 0; i < nBlocks; i++) {
    dequantizeQ80Block(bytes, i * Q8_0_BLOCK_SIZE, out, i * Q8_0_ELEMENTS);
  }
}

// ── Convenience: build a Float32Array from a packed tensor ──────────────

export function decodeQuantTensor(kind, bytes, totalElements) {
  const out = new Float32Array(totalElements);
  switch (kind) {
    case "q4_k":
    case "q4k":
    case "Q4_K":
      dequantizeQ4K(bytes, out, totalElements);
      return out;
    case "q6_k":
    case "q6k":
    case "Q6_K":
      dequantizeQ6K(bytes, out, totalElements);
      return out;
    case "q8_0":
    case "q80":
    case "Q8_0":
      dequantizeQ80(bytes, out, totalElements);
      return out;
    default:
      throw new Error(`decodeQuantTensor: unsupported kind "${kind}"`);
  }
}

export default {
  QK_K,
  Q4_K_BLOCK_SIZE,
  Q6_K_BLOCK_SIZE,
  Q8_0_BLOCK_SIZE,
  Q8_0_ELEMENTS,
  fp16ToFp32,
  dequantizeQ4KBlock,
  dequantizeQ6KBlock,
  dequantizeQ80Block,
  dequantizeQ4K,
  dequantizeQ6K,
  dequantizeQ80,
  decodeQuantTensor,
};
