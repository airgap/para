// @lyku/para-sort — typed-array sort with automatic tier dispatch.
//
// Tiers:
//   1. serial   — LSD radix (this file). Synchronous, deterministic,
//                 beats TypedArray.prototype.sort() from a few thousand
//                 elements up. Always available, on every runtime.
//   2. parallel — native @para/parallel `psort`: tuned SAB-backed
//                 histogram+scatter radix across a worker pool. Only
//                 resolvable on the ParaBun runtime (the npm shim has no
//                 `psort`). Worker pools can't be synchronous, so the
//                 parallel tier is the **async** API (`*.f32Async`).
//   3. gpu      — Phase 2. `available()` is false; `backend:"gpu"` errors.
//
// Why the split sync/async surface: the brief's `const out = sort.f32(arr)`
// is synchronous, but a worker pool fundamentally cannot be. Rather than
// make the whole API async (and force every caller to await even the tiny
// serial case), the sync `sort.f32` covers serial/small/already-sorted —
// the common case — and `sort.f32Async` adds the native parallel tier.
// `describe()` reports parallel as an async-only tier honestly.
//
// Numeric correctness: radix needs an unsigned, order-preserving key.
//   u32 — value as-is.
//   i32 — flip the sign bit (x ^ 0x80000000): negatives < positives.
//   f32 — total-ordering bit trick: positives flip the sign bit, negatives
//         flip all bits. NaN ends up at the high end (matches
//         TypedArray.prototype.sort putting NaN last); -0 sorts just below
//         +0 (IEEE totalOrder) — don't assert their relative order.

// Native @para/parallel: runtime-shadowed specifier — native module on
// ParaBun, npm shim (no `psort`) elsewhere. Same access pattern as
// @para/pipeline.
let _np: any = null;
let _npLookedUp = false;
function nativeParallel(): any {
  if (_npLookedUp) return _np;
  _npLookedUp = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const m = require("@para/parallel");
    const mod = m?.default ?? m;
    // Real parallel only: the npm shim now also exports a `psort`, but it's
    // a sequential fallback and marks itself. Pin to the native engine so
    // `backend:"parallel"` stays an honest hard-pin (brief requirement).
    _np = mod && typeof mod.psort === "function" && !mod.__paraParallelShim ? mod : null;
  } catch {
    _np = null;
  }
  return _np;
}

export type Backend = "serial" | "parallel" | "gpu";
export interface SortOptions {
  /** Hard-pin a backend. Errors if unavailable. */
  backend?: Backend;
  /** Try a backend, fall back silently if unavailable. */
  prefer?: Backend;
  /** Worker count for the parallel tier (async only). */
  workers?: number;
  /** Stay auto, but override the serial→parallel size threshold. */
  minParallel?: number;
  /** Reserved for the Phase 2 GPU tier. */
  minGpu?: number;
  /** argsort stability hint. LSD radix is always stable; accepted as a no-op. */
  stable?: boolean;
}

// Below this, TypedArray.prototype.sort() (numeric, handles signs/floats)
// beats radix setup. Probed defaults; overridable via minParallel only for
// the parallel boundary.
type U32Like = Uint32Array | Int32Array | Float32Array;
type Kind = "u32" | "i32" | "f32";

// Below this many elements, TypedArray.prototype.sort() (a fast C++ engine
// sort) beats radix: the histogram/scatter setup + ping-pong allocations
// don't amortize. Measured on this machine (bench-radix), random inputs:
// the engine sort wins up to ~8K for f32 (the f32→sortable-key transform
// adds two O(n) passes, pushing its crossover above the int kinds) and
// ~3K for u32/i32. Floors set comfortably past the measured crossovers.
// These are the brief's "benchmark to refine" thresholds, now measured.
const RADIX_FLOOR: Record<Kind, number> = { f32: 8192, u32: 4096, i32: 4096 };
const SMALL = 64; // floor for describe()'s coarse "tiny" classification
const DEFAULT_MIN_PARALLEL = 50_000;

// ── Key transforms ────────────────────────────────────────────────────────

function toKeys(src: U32Like, kind: Kind, n: number): Uint32Array {
  const keys = new Uint32Array(n);
  if (kind === "u32") {
    keys.set(src.subarray(0, n) as unknown as ArrayLike<number>);
  } else if (kind === "i32") {
    for (let i = 0; i < n; i++) keys[i] = (src[i] ^ 0x80000000) >>> 0;
  } else {
    // Reinterpret the f32 bits without copying semantics changing.
    const bits = new Uint32Array((src as Float32Array).buffer, (src as Float32Array).byteOffset, n);
    for (let i = 0; i < n; i++) {
      const b = bits[i] >>> 0;
      keys[i] = (b ^ (b >>> 31 ? 0xffffffff : 0x80000000)) >>> 0;
    }
  }
  return keys;
}

function fromKeys(keys: Uint32Array, kind: Kind, n: number): U32Like {
  if (kind === "u32") return keys.length === n ? keys : keys.subarray(0, n);
  if (kind === "i32") {
    const out = new Int32Array(n);
    for (let i = 0; i < n; i++) out[i] = (keys[i] ^ 0x80000000) | 0;
    return out;
  }
  const out = new Float32Array(n);
  const obits = new Uint32Array(out.buffer);
  for (let i = 0; i < n; i++) {
    const k = keys[i] >>> 0;
    obits[i] = (k ^ (k >>> 31 ? 0x80000000 : 0xffffffff)) >>> 0;
  }
  return out;
}

// ── LSD radix core (4 × 8-bit passes, stable, ping-pong) ──────────────────
//
// When `idx` is supplied it rides along with the keys — that's the argsort
// path (scatter indices, not values). Returns the buffer pair that ended up
// holding the sorted data (always after an even pass count, so `keys`/`idx`).

function radix(keys: Uint32Array, idx: Uint32Array | null, n: number): { keys: Uint32Array; idx: Uint32Array | null } {
  let kA = keys;
  let kB = new Uint32Array(n);
  let iA = idx;
  let iB = idx ? new Uint32Array(n) : null;
  const count = new Uint32Array(257);

  for (let shift = 0; shift < 32; shift += 8) {
    count.fill(0);
    for (let i = 0; i < n; i++) count[((kA[i] >>> shift) & 0xff) + 1]++;
    for (let b = 0; b < 256; b++) count[b + 1] += count[b];
    for (let i = 0; i < n; i++) {
      const d = (kA[i] >>> shift) & 0xff;
      const p = count[d]++;
      kB[p] = kA[i];
      if (iA) iB![p] = iA[i];
    }
    let t = kA;
    kA = kB;
    kB = t;
    if (iA) {
      let ti = iA;
      iA = iB;
      iB = ti;
    }
  }
  // 4 passes → even → result is back in the original `keys`/`idx` buffers.
  return { keys: kA, idx: iA };
}

// ── Cheap O(n) presortedness fast paths ───────────────────────────────────

// NaN-safe: `!(x <= y)` is true when either side is NaN, so any NaN in an
// f32 input fails both checks and falls through to radix (which orders NaN
// at the end, matching TypedArray.prototype.sort).
function ascending(a: U32Like, n: number): boolean {
  for (let i = 1; i < n; i++) if (!(a[i - 1] <= a[i])) return false;
  return true;
}
function descending(a: U32Like, n: number): boolean {
  for (let i = 1; i < n; i++) if (!(a[i - 1] >= a[i])) return false;
  return true;
}

// ── Serial value sort ─────────────────────────────────────────────────────

function serialSort(src: U32Like, kind: Kind): U32Like {
  const n = src.length;
  const Ctor = src.constructor as { new (n: number): U32Like };
  if (n < 2) return new Ctor(n).map((_, i) => src[i]) as U32Like;
  if (n < RADIX_FLOOR[kind]) {
    const c = new Ctor(n);
    (c as any).set(src);
    (c as any).sort(); // engine sort wins below the measured radix crossover
    return c;
  }
  if (ascending(src, n)) {
    const c = new Ctor(n);
    (c as any).set(src);
    return c;
  }
  if (descending(src, n)) {
    const c = new Ctor(n);
    for (let i = 0; i < n; i++) c[i] = src[n - 1 - i];
    return c;
  }
  const { keys } = radix(toKeys(src, kind, n), null, n);
  return fromKeys(keys, kind, n);
}

// ── Serial argsort ────────────────────────────────────────────────────────

function serialArg(src: U32Like, kind: Kind): Uint32Array {
  const n = src.length;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  if (n < 2) return idx;
  if (n < RADIX_FLOOR[kind]) {
    // Below the radix crossover, a stable comparator sort of the indices
    // is cheaper than building keys+payload. Tie-break on original index
    // for stability; push NaN to the end so it matches the radix path.
    const order = Array.from(idx).sort((a, b) => {
      const ka = src[a];
      const kb = src[b];
      if (ka < kb) return -1;
      if (ka > kb) return 1;
      const na = ka !== ka;
      const nb = kb !== kb;
      if (na !== nb) return na ? 1 : -1;
      return a - b;
    });
    return Uint32Array.from(order);
  }
  const { idx: out } = radix(toKeys(src, kind, n), idx, n);
  return out!;
}

// ── Dispatch ──────────────────────────────────────────────────────────────

function rejectGpu(o?: SortOptions): void {
  if (o?.backend === "gpu") {
    throw new Error("@lyku/para-sort: backend 'gpu' is unavailable (GPU tier is Phase 2).");
  }
}

function syncSort(src: U32Like, kind: Kind, o?: SortOptions): U32Like {
  rejectGpu(o);
  if (o?.backend === "parallel") {
    throw new Error(
      "@lyku/para-sort: backend 'parallel' requires the async API — use sort." +
        kind +
        "Async(arr, { backend: 'parallel' }). Worker pools cannot run synchronously.",
    );
  }
  return serialSort(src, kind);
}

async function asyncSort(src: U32Like, kind: Kind, o?: SortOptions): Promise<U32Like> {
  rejectGpu(o);
  const n = src.length;
  const np = nativeParallel();

  if (o?.backend === "parallel") {
    if (!np) {
      throw new Error(
        "@lyku/para-sort: backend 'parallel' unavailable — native @para/parallel `psort` is not present (running off the ParaBun runtime).",
      );
    }
    const Ctor = src.constructor as { new (n: number): U32Like };
    const c = new Ctor(n);
    (c as any).set(src);
    return np.psort(c, undefined, { concurrency: o?.workers, serial: false });
  }
  if (o?.backend === "serial") return serialSort(src, kind);

  // Auto / prefer. Presortedness + small-n short-circuit before any worker.
  if (n <= SMALL || ascending(src, n) || descending(src, n)) return serialSort(src, kind);
  const minP = o?.minParallel ?? DEFAULT_MIN_PARALLEL;
  const wantParallel = o?.prefer !== "serial" && o?.backend !== "serial" && n >= minP;
  if (wantParallel && np) {
    const Ctor = src.constructor as { new (n: number): U32Like };
    const c = new Ctor(n);
    (c as any).set(src);
    return np.psort(c, undefined, { concurrency: o?.workers, serial: false });
  }
  return serialSort(src, kind);
}

function describe(arr?: U32Like): Record<string, unknown> {
  const np = nativeParallel();
  const tiers = ["serial", ...(np ? ["parallel"] : [])];
  if (arr === undefined) {
    return {
      active: np ? "parallel" : "serial",
      tiers,
      thresholds: { small: SMALL, minParallel: DEFAULT_MIN_PARALLEL },
    };
  }
  const n = arr.length;
  let recommended: string;
  let reason: string;
  if (n <= SMALL) {
    recommended = "serial";
    reason = `n=${n}, below small-n threshold (TypedArray.sort)`;
  } else if (ascending(arr, n) || descending(arr, n)) {
    recommended = "serial";
    reason = `n=${n}, already sorted/reverse — O(n) fast path`;
  } else if (n >= DEFAULT_MIN_PARALLEL && np) {
    recommended = "parallel";
    reason = `n=${n}, ≥ minParallel and native psort available`;
  } else {
    recommended = "serial";
    reason = np ? `n=${n}, below minParallel` : `n=${n}, native parallel unavailable off-runtime`;
  }
  return { recommended, reason, n };
}

const sort = {
  f32: (a: Float32Array, o?: SortOptions) => syncSort(a, "f32", o) as Float32Array,
  u32: (a: Uint32Array, o?: SortOptions) => syncSort(a, "u32", o) as Uint32Array,
  i32: (a: Int32Array, o?: SortOptions) => syncSort(a, "i32", o) as Int32Array,
  f32Async: (a: Float32Array, o?: SortOptions) => asyncSort(a, "f32", o) as Promise<Float32Array>,
  u32Async: (a: Uint32Array, o?: SortOptions) => asyncSort(a, "u32", o) as Promise<Uint32Array>,
  i32Async: (a: Int32Array, o?: SortOptions) => asyncSort(a, "i32", o) as Promise<Int32Array>,
  argF32: (a: Float32Array, o?: SortOptions) => (rejectGpu(o), serialArg(a, "f32")),
  argU32: (a: Uint32Array, o?: SortOptions) => (rejectGpu(o), serialArg(a, "u32")),
  argI32: (a: Int32Array, o?: SortOptions) => (rejectGpu(o), serialArg(a, "i32")),
  describe,
};

export { syncSort, asyncSort, serialArg, describe };
export default sort;
