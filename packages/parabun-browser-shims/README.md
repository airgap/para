# parabun-browser-shims

> **Deprecated.** The cross-runtime Lib modules (`signals`, `parallel`, `simd`, `arena`, `arrow`, `csv`, `mcp`, `pipeline`, `rtp`) now ship as individual `@para/*` npm packages — install those directly. This package now only carries the few specifiers that don't have a Lib equivalent yet. Slated for removal in 0.4.x once those migrate or get retired.

What's still in here:

| Specifier | Why it's here |
|---|---|
| `bun:wrap` | Runtime helpers for the wrap macro that `.pts` desugarings emit (`__parabunMemo` / `__parabunDefer0` / `__parabunRange`). Will move into `@para/transpile`'s runtime when the standalone compiler ships. |
| `parabun:gpu` | CPU + WebGPU backend. Until `@para/gpu` (the WebGPU/CPU normalizer) ships, this is the cross-runtime path for code that imports `parabun:gpu`. |
| `parabun:llm` | Throw-stub with a clear "no browser backend wired yet" message. Will move into `@para/llm` (the WebGPU/Wasm normalizer) when ready. |
| `parabun-browser-shims/quant` | Pure-JS dequantizers for Q4_K / Q6_K / Q8_0. Used by the `parabun:gpu` shim's `holdQ4K` / `holdQ6K`; also exported standalone. |

For everything else, use the per-module packages:

```sh
npm install @lyku/para-signals @para/parallel @para/simd @para/arena @para/arrow @para/csv @para/mcp @para/pipeline @para/rtp
```

And alias the `para:*` specifiers in your bundler to those packages directly:

```ts
// vite.config.ts
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: [{ find: /^para:(.*)$/, replacement: "@para/$1" }],
  },
});
```

For the `parabun:*` and `bun:wrap` specifiers that still need this shim:

```ts
import { bunAliases } from "parabun-browser-shims";
// expands to: { "bun:wrap": ..., "parabun:gpu": ..., "parabun:llm": ... }
```
