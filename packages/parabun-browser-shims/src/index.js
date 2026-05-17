// Aggregate entry point. The four cross-runtime Lib modules
// (signals/parallel/simd/arena) have moved to their own @para/* npm
// packages — import those directly. This file now only carries the
// outliers that haven't migrated yet:
//   - bun:wrap   — runtime helpers for the wrap macro
//   - parabun:gpu — WebGPU + CPU shim
//   - parabun:llm — throw-stub
//   - quant       — Q4_K/Q6_K dequantizers used by parabun:gpu
//
// The whole package is slated for removal in 0.4.x once those four
// either move to their own @para/* packages or get retired.

export * as wrap from "./wrap.js";
export * as gpu from "./gpu.js";
export * as llm from "./llm.js";
export * as quant from "./quant.js";

// Bundler-agnostic alias map for the specifiers that still resolve
// here. Cross-runtime Lib modules (@lyku/para-signals / @para/parallel /
// @para/simd / @para/arena / etc.) should be aliased to their @para/*
// packages instead — typically via a single regex rule:
//
//   { find: /^para:(.*)$/, replacement: "@para/$1" }
export const bunAliases = {
  "bun:wrap": new URL("./wrap.js", import.meta.url).pathname,
  "parabun:gpu": new URL("./gpu.js", import.meta.url).pathname,
  "parabun:llm": new URL("./llm.js", import.meta.url).pathname,
};
