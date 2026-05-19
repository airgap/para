import { describe, expect, test } from "bun:test";
import sort from "../src/index";

// Package tests run under system bun, so `require("@para/parallel")`
// resolves to the npm shim (no `psort`) — the parallel tier is reported
// unavailable here. These cover the serial radix core, argsort, the
// fast paths, the sync/async surface, and manual-override errors.
// The native parallel tier is exercised separately on the ParaBun
// runtime (`bun bd`), where psort is present.

function refF32(a: Float32Array): Float32Array {
  const c = Float32Array.from(a);
  c.sort();
  return c;
}
function refU32(a: Uint32Array): Uint32Array {
  const c = Uint32Array.from(a);
  c.sort();
  return c;
}
function refI32(a: Int32Array): Int32Array {
  const c = Int32Array.from(a);
  c.sort();
  return c;
}

function rngF32(n: number, seed = 1): Float32Array {
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s / 0xffffffff) * 2000 - 1000; // mix of +/-
  }
  return out;
}

describe("serial value sort — correctness vs TypedArray.sort()", () => {
  test.each([0, 1, 2, 5, 63, 64, 65, 1000, 100_000])("u32 n=%i", n => {
    const a = new Uint32Array(n);
    let s = 7;
    for (let i = 0; i < n; i++) {
      s = (s * 1103515245 + 12345) >>> 0;
      a[i] = s;
    }
    expect(Array.from(sort.u32(a))).toEqual(Array.from(refU32(a)));
  });

  test.each([0, 1, 64, 65, 100_000])("i32 (signed) n=%i", n => {
    const a = new Int32Array(n);
    let s = 99;
    for (let i = 0; i < n; i++) {
      s = (s * 1103515245 + 12345) >>> 0;
      a[i] = s | 0; // spans negative & positive
    }
    expect(Array.from(sort.i32(a))).toEqual(Array.from(refI32(a)));
  });

  test.each([0, 1, 64, 65, 50_000])("f32 (signed, ±Inf) n=%i", n => {
    const a = rngF32(n, 42);
    if (n > 4) {
      a[1] = Infinity;
      a[2] = -Infinity;
      a[3] = 0;
      a[4] = -123.5;
    }
    expect(Array.from(sort.f32(a))).toEqual(Array.from(refF32(a)));
  });

  test("does not mutate the input", () => {
    const a = new Uint32Array([5, 3, 9, 1, 7, 2, 8, 4, 6, 0]);
    const snap = Array.from(a);
    sort.u32(a);
    expect(Array.from(a)).toEqual(snap);
  });

  test("already-sorted and reverse fast paths", () => {
    const asc = new Uint32Array(2000);
    for (let i = 0; i < 2000; i++) asc[i] = i;
    const desc = new Uint32Array(2000);
    for (let i = 0; i < 2000; i++) desc[i] = 2000 - i;
    expect(Array.from(sort.u32(asc))).toEqual(Array.from(asc));
    expect(Array.from(sort.u32(desc))).toEqual(Array.from(refU32(desc)));
  });

  test("f32 NaNs land at the end (matches TypedArray.sort)", () => {
    const a = new Float32Array([3, NaN, 1, NaN, -2, 0]);
    const out = sort.f32(a);
    expect(Number.isNaN(out[4])).toBe(true);
    expect(Number.isNaN(out[5])).toBe(true);
    expect(Array.from(out.subarray(0, 4))).toEqual([-2, 0, 1, 3]);
  });
});

describe("argsort — correctness + stability", () => {
  test("argF32 yields a permutation that orders the keys", () => {
    const keys = rngF32(5000, 11);
    const idx = sort.argF32(keys);
    expect(idx.length).toBe(5000);
    const seen = new Uint8Array(5000);
    for (const i of idx) seen[i]++;
    expect(seen.every(c => c === 1)).toBe(true); // a true permutation
    for (let i = 1; i < idx.length; i++) {
      expect(keys[idx[i - 1]] <= keys[idx[i]]).toBe(true);
    }
  });

  test("stable: equal keys keep original index order", () => {
    // Many ties → stability is observable.
    const keys = new Uint32Array([5, 1, 5, 1, 5, 1, 9, 9, 0]);
    const idx = sort.argU32(keys);
    expect(Array.from(idx)).toEqual([8, 1, 3, 5, 0, 2, 4, 6, 7]);
  });
});

describe("manual override + dispatch surface", () => {
  test("backend 'gpu' hard-errors (Phase 2)", () => {
    expect(() => sort.f32(new Float32Array([1]), { backend: "gpu" })).toThrow(/gpu.*Phase 2/);
  });

  test("sync backend 'parallel' directs to the async API", () => {
    expect(() => sort.u32(new Uint32Array([1]), { backend: "parallel" })).toThrow(/async API/);
  });

  test("async backend 'parallel' errors off-runtime (no native psort)", async () => {
    await expect(sort.u32Async(new Uint32Array(1000), { backend: "parallel" })).rejects.toThrow(
      /parallel.*unavailable/,
    );
  });

  test("async serial path matches sync", async () => {
    const a = rngF32(20_000, 5);
    const s = sort.f32(a);
    const as = await sort.f32Async(a, { backend: "serial" });
    expect(Array.from(as)).toEqual(Array.from(s));
  });

  test("describe() reports tiers; off-runtime parallel absent", () => {
    const d = sort.describe() as any;
    expect(d.tiers).toContain("serial");
    expect(d.active).toBe("serial"); // no native psort under system bun
  });

  test("describe(arr) recommends by size/shape", () => {
    expect((sort.describe(new Uint32Array(10)) as any).recommended).toBe("serial");
    const asc = new Uint32Array(80_000);
    for (let i = 0; i < asc.length; i++) asc[i] = i;
    expect((sort.describe(asc) as any).reason).toMatch(/sorted/);
  });
});
