import { describe, expect, test } from "bun:test";
import gpu from "../src/index";

// This runs under system bun: parabun:gpu is unresolvable and there is no
// navigator.gpu, so the router must land on the CPU tier and the @lyku/para-simd
// fallback must produce correct results through the async surface.

describe("@lyku/para-gpu router", () => {
  test("falls back to the cpu tier off-runtime", async () => {
    expect(await gpu.tier()).toBe("cpu");
    expect(await gpu.init()).toBe("cpu");
    const d = await gpu.describe();
    expect(d.tier).toBe("cpu");
  });

  test("every op returns a Promise (unified async contract)", () => {
    const r = gpu.dot(new Float32Array([1, 2]), new Float32Array([3, 4]));
    expect(r).toBeInstanceOf(Promise);
    return r;
  });
});

describe("@lyku/para-gpu cpu-fallback math", () => {
  test("matmul: A(M×K)·B(K×N) → C(M×N)", async () => {
    // [[1,2],[3,4]] · [[5,6],[7,8]] = [[19,22],[43,50]]
    const a = new Float32Array([1, 2, 3, 4]);
    const b = new Float32Array([5, 6, 7, 8]);
    const c = await gpu.matmul(a, b, 2, 2, 2);
    expect(Array.from(c)).toEqual([19, 22, 43, 50]);
  });

  test("matVec: matrix(rows×cols)·vector", async () => {
    // [[1,2,3],[4,5,6]] · [1,1,1] = [6,15]
    const mat = new Float32Array([1, 2, 3, 4, 5, 6]);
    const vec = new Float32Array([1, 1, 1]);
    const out = await gpu.matVec(mat, vec, 2, 3);
    expect(Array.from(out)).toEqual([6, 15]);
  });

  test("dot: elementwise sum of products", async () => {
    const d = await gpu.dot(new Float32Array([1, 2, 3]), new Float32Array([4, 5, 6]));
    expect(d).toBe(32);
  });

  test("simdMap: elementwise transform", async () => {
    const y = await gpu.simdMap(x => x * x, new Float32Array([1, 2, 3, 4]));
    expect(Array.from(y)).toEqual([1, 4, 9, 16]);
  });

  test("winsForSize returns a boolean", async () => {
    expect(typeof (await gpu.winsForSize("matmul", 1 << 20))).toBe("boolean");
  });
});
