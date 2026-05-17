// Regression tests for the Q4_K / Q6_K / Q8_0 block dequantizers.
//
// Each test constructs a block with hand-chosen scales / mins / quants
// so the expected decoded values are computable by inspection. These
// are NOT random-equivalent round-trip tests — those would require a
// reference encoder (llama.cpp's quantize_q4_K etc.) to stamp a block
// and verify our decode matches. A future commit can wire that up by
// shipping a few pre-encoded bytes captured from a real GGUF file.

import { test, expect } from "bun:test";
import gpu from "../src/gpu.js";
import {
  dequantizeQ4KBlock,
  dequantizeQ80Block,
  dequantizeQ6KBlock,
  fp16ToFp32,
  Q4_K_BLOCK_SIZE,
  Q8_0_BLOCK_SIZE,
  Q6_K_BLOCK_SIZE,
} from "../src/quant.js";

test("fp16ToFp32 round-trips standard half-float bit patterns", () => {
  expect(fp16ToFp32(0x3c00)).toBe(1);
  expect(fp16ToFp32(0x4000)).toBe(2);
  expect(fp16ToFp32(0xc000)).toBe(-2);
  expect(fp16ToFp32(0x0000)).toBe(0);
  expect(Object.is(fp16ToFp32(0x8000), -0)).toBe(true);
  expect(fp16ToFp32(0x7c00)).toBe(Infinity);
  expect(fp16ToFp32(0xfc00)).toBe(-Infinity);
  expect(Number.isNaN(fp16ToFp32(0x7e00))).toBe(true);
});

test("Q4_K block decoder: d=1, sub-blocks 0..3 scale=63/min=0, sub-blocks 4..7 scale=0", () => {
  const blk = new Uint8Array(Q4_K_BLOCK_SIZE);
  blk[0] = 0x00;
  blk[1] = 0x3c; // d = 1.0
  blk[2] = 0x00;
  blk[3] = 0x00; // dmin = 0.0
  for (let i = 0; i < 4; i++) blk[4 + i] = 0x3f; // is=0..3: scale=63
  for (let i = 4; i < 12; i++) blk[4 + i] = 0x00; // is=0..3: min=0; is=4..7: both=0
  for (let i = 0; i < 128; i++) blk[16 + i] = 0x77; // all quants = 7/7

  const out = new Float32Array(256);
  dequantizeQ4KBlock(blk, 0, out, 0);

  // is=0..3 (first 128): d * 63 * 7 - 0 = 441
  for (let i = 0; i < 128; i++) expect(out[i]).toBe(441);
  // is=4..7 (last 128): d * 0 * 7 - 0 = 0
  for (let i = 128; i < 256; i++) expect(out[i]).toBe(0);
});

test("Q4_K block decoder: non-zero dmin produces correct offsets", () => {
  // d=1, dmin=2, scales all 0x3f (sc=63 for is=0..3), mins all 0x01
  // (m=1 for is=0..3, m=0 for is=4..7), quants all 0 → output = -2 for
  // is=0..3, 0 for is=4..7.
  const blk = new Uint8Array(Q4_K_BLOCK_SIZE);
  blk[0] = 0x00;
  blk[1] = 0x3c; // d = 1.0
  blk[2] = 0x00;
  blk[3] = 0x40; // dmin = 2.0
  for (let i = 0; i < 4; i++) blk[4 + i] = 0x3f; // is=0..3 scale=63
  for (let i = 0; i < 4; i++) blk[4 + 4 + i] = 0x01; // is=0..3 min=1
  for (let i = 0; i < 4; i++) blk[4 + 8 + i] = 0x00; // is=4..7 both=0
  // All quants = 0 (q & 0xf = 0, q >> 4 = 0)
  for (let i = 0; i < 128; i++) blk[16 + i] = 0x00;

  const out = new Float32Array(256);
  dequantizeQ4KBlock(blk, 0, out, 0);

  for (let i = 0; i < 128; i++) expect(out[i]).toBe(-2); // 0 - 2*1 = -2
  for (let i = 128; i < 256; i++) expect(out[i]).toBe(0);
});

test("Q8_0 block decoder: d=2, quants all 5", () => {
  const q80 = new Uint8Array(Q8_0_BLOCK_SIZE);
  q80[0] = 0x00;
  q80[1] = 0x40; // d = 2.0
  for (let i = 0; i < 32; i++) q80[2 + i] = 5;

  const out = new Float32Array(32);
  dequantizeQ80Block(q80, 0, out, 0);

  for (let i = 0; i < 32; i++) expect(out[i]).toBe(10);
});

test("Q8_0 block decoder: signed quants cross zero", () => {
  const q80 = new Uint8Array(Q8_0_BLOCK_SIZE);
  q80[0] = 0x00;
  q80[1] = 0x3c; // d = 1.0
  // int8 quants: 0, 1, -1, 127, -128, ...
  q80[2 + 0] = 0;
  q80[2 + 1] = 1;
  q80[2 + 2] = 0xff; // -1 as signed
  q80[2 + 3] = 127;
  q80[2 + 4] = 0x80; // -128

  const out = new Float32Array(32);
  dequantizeQ80Block(q80, 0, out, 0);

  expect(out[0]).toBe(0);
  expect(out[1]).toBe(1);
  expect(out[2]).toBe(-1);
  expect(out[3]).toBe(127);
  expect(out[4]).toBe(-128);
});

test("Q6_K block decoder: d=1, scales all 0, all zeros", () => {
  // With all scales 0, output is always 0 regardless of quants — the
  // simplest Q6_K test that validates end-to-end decode doesn't crash
  // and returns the mathematically correct zero vector.
  const blk = new Uint8Array(Q6_K_BLOCK_SIZE);
  blk[208] = 0x00;
  blk[209] = 0x3c; // d = 1.0
  // scales[0..15] = 0 (already zero-initialized)
  // ql and qh arbitrary — scale=0 multiplies them out.
  for (let i = 0; i < 128; i++) blk[i] = 0xff;

  const out = new Float32Array(256);
  dequantizeQ6KBlock(blk, 0, out, 0);

  // Zero scale × non-zero centered quant → `-0` for negative quants,
  // `0` otherwise. Both are mathematically zero; assert magnitude.
  for (let i = 0; i < 256; i++) expect(Math.abs(out[i])).toBe(0);
});

test("gpu.holdQ4K stashes dequantized f32 and matVec sums it correctly", () => {
  // Build 2 identical Q4_K blocks. Row 0 should have 128 outputs of
  // 441 and 128 of 0; ·ones = 56448. Same for row 1.
  const blk = new Uint8Array(Q4_K_BLOCK_SIZE);
  blk[0] = 0x00;
  blk[1] = 0x3c;
  for (let i = 0; i < 4; i++) blk[4 + i] = 0x3f;
  for (let i = 0; i < 128; i++) blk[16 + i] = 0x77;

  const weights = new Uint8Array(Q4_K_BLOCK_SIZE * 2);
  weights.set(blk, 0);
  weights.set(blk, Q4_K_BLOCK_SIZE);

  const held = gpu.holdQ4K(weights);
  expect(held.kind).toBe("q4k");
  expect(held.buf).toBeInstanceOf(Float32Array);
  expect(held.buf.length).toBe(512);

  const vec = new Float32Array(256).fill(1);
  const out = gpu.matVec(held, vec, 2, 256);
  expect([...out]).toEqual([56448, 56448]);
});

test("gpu.holdQ4K rejects misaligned buffer sizes", () => {
  // 143 bytes isn't a multiple of the 144-byte block stride.
  expect(() => gpu.holdQ4K(new Uint8Array(143))).toThrow(/multiple of 144/);
});
