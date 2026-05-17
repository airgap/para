// CPU-path correctness for the browser-shim conv2D. The async / WebGPU
// path can only be exercised in a real browser; this file pins down the
// JS fallback so we don't accidentally break it when WebGPU code shifts.
import { describe, expect, it } from "bun:test";
import gpu from "../src/gpu.js";

describe("parabun-browser-shims gpu.conv2D (CPU path)", () => {
  it("identity 1×1 kernel returns input", () => {
    const input = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const out = gpu.conv2D(input, new Float32Array([1]), 3, 3, 1, 1);
    expect(Array.from(out)).toEqual(Array.from(input));
  });

  it("3×3 input × 2×2 [1, 0; 0, -1] kernel → all -4", () => {
    const out = gpu.conv2D(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), new Float32Array([1, 0, 0, -1]), 3, 3, 2, 2);
    expect(Array.from(out)).toEqual([-4, -4, -4, -4]);
  });

  it("3×3 box blur on 3×3 input → mean (5)", () => {
    const out = gpu.conv2D(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), new Float32Array(9).fill(1 / 9), 3, 3, 3, 3);
    expect(out.length).toBe(1);
    expect(Math.abs(out[0] - 5)).toBeLessThan(1e-6);
  });

  it("kernel fills input → 1×1 sum", () => {
    const out = gpu.conv2D(
      Float32Array.from({ length: 16 }, (_, i) => i + 1),
      new Float32Array(16).fill(1),
      4,
      4,
      4,
      4,
    );
    expect(Array.from(out)).toEqual([136]);
  });

  it("non-square dims (11×17 × 5×3 → 7×15)", () => {
    const iW = 11,
      iH = 17,
      kW = 5,
      kH = 3;
    const input = Float32Array.from({ length: iW * iH }, (_, i) => Math.sin(i * 0.1));
    const k = Float32Array.from({ length: kW * kH }, (_, i) => (i + 1) / 15);
    const out = gpu.conv2D(input, k, iW, iH, kW, kH);
    expect(out.length).toBe((iW - kW + 1) * (iH - kH + 1));
    // Spot-check first cell against a hand-computed value.
    let acc = 0;
    for (let ky = 0; ky < kH; ky++) {
      for (let kx = 0; kx < kW; kx++) {
        acc += input[ky * iW + kx] * k[ky * kW + kx];
      }
    }
    expect(Math.abs(out[0] - acc)).toBeLessThan(1e-5);
  });
});
