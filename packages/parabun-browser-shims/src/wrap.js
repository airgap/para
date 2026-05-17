// Browser shim for `bun:wrap` — the module parse-time desugarings import
// for memoization, defer, and range literals. Mirrors
// src/runtime.bun.js so behavior matches Parabun's native output.

const TERMINAL = Symbol("parabun.memo.terminal");

export function __parabunMemo(fn, arity) {
  if (arity === 0) {
    let has = false;
    let cached;
    const wrap = function () {
      if (has) return cached;
      cached = fn.apply(this, arguments);
      has = true;
      if (cached && typeof cached.then === "function") {
        cached.then(undefined, () => {
          has = false;
          cached = undefined;
        });
      }
      return cached;
    };
    wrap.forget = wrap.clear = () => {
      const had = has;
      has = false;
      cached = undefined;
      return had;
    };
    wrap.bypass = function () {
      return fn.apply(this, arguments);
    };
    return wrap;
  }
  if (arity === 1) {
    const cache = new Map();
    const wrap = function (a) {
      if (cache.has(a)) return cache.get(a);
      const v = fn.apply(this, arguments);
      cache.set(a, v);
      if (v && typeof v.then === "function") {
        v.then(undefined, () => cache.delete(a));
      }
      return v;
    };
    wrap.forget = a => cache.delete(a);
    wrap.clear = () => cache.clear();
    wrap.bypass = function () {
      return fn.apply(this, arguments);
    };
    return wrap;
  }
  const root = new Map();
  const wrap = function () {
    const args = arguments;
    let m = root;
    for (let i = 0; i < args.length; i++) {
      let next = m.get(args[i]);
      if (!(next instanceof Map)) {
        next = new Map();
        m.set(args[i], next);
      }
      m = next;
    }
    if (m.has(TERMINAL)) return m.get(TERMINAL);
    const v = fn.apply(this, args);
    m.set(TERMINAL, v);
    if (v && typeof v.then === "function") {
      v.then(undefined, () => m.delete(TERMINAL));
    }
    return v;
  };
  wrap.forget = function () {
    const args = arguments;
    let m = root;
    for (let i = 0; i < args.length; i++) {
      const next = m.get(args[i]);
      if (!(next instanceof Map)) return false;
      m = next;
    }
    return m.delete(TERMINAL);
  };
  wrap.clear = () => root.clear();
  wrap.bypass = function () {
    return fn.apply(this, arguments);
  };
  return wrap;
}

export const __parabunDefer0 = thunk => ({ [Symbol.dispose]: thunk });
export const __parabunAsyncDefer0 = thunk => ({ [Symbol.asyncDispose]: thunk });

export const __parabunRange = (s, e) => {
  const n = e > s ? (e - s) | 0 : 0;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = s + i;
  return out;
};
export const __parabunRangeInclusive = (s, e) => {
  const n = e >= s ? ((e - s) | 0) + 1 : 0;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = s + i;
  return out;
};

// Parabun: `Nd` decimal literals desugar to `__paraDec("N")`. Re-exported
// from @para/decimal — the runtime shim resolves to the same Decimal
// class shipped natively, so behavior is identical between Parabun and
// browsers/Node hosts.
export { Decimal, __paraDec } from "@para/decimal";

export default {
  __parabunMemo,
  __parabunDefer0,
  __parabunAsyncDefer0,
  __parabunRange,
  __parabunRangeInclusive,
};
