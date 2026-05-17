# @para/transpile

Standalone transpiler for [Para](https://para.script.dev) — turns `.pts` source into standard JavaScript that imports from the matching `@para/*` npm packages. No Parabun runtime required at build time.

The canonical Para transpiler lives inside the [Parabun](https://parabun.script.dev) fork of Bun (Zig). This package is a TypeScript reimplementation, intended for projects that don't (or can't) install Parabun on their build host: browsers, Lambda, Cloudflare Workers, Deno, Node, the [Para playground](https://para.script.dev/play).

## Status — IN DEVELOPMENT, not yet released

`package.json` is `private: true` and version `0.0.0-dev`. We don't ship a partial transpiler — the npm publish gate stays closed until every Para desugaring listed below works end-to-end and matches the canonical Zig parser's output.

| Feature | Status |
| --- | --- |
| `..!` / `..&` (catch / finally chain operators) | ✅ |
| `\|>` pipeline operator | ✅ |
| `..` / `..=` ranges | ✅ |
| `pure` keyword strip | ✅ |
| `signal NAME = EXPR;` declaration | ✅ |
| `effect { … }` block | ✅ |
| `when EXPR { … }` / paired form | ✅ |
| `~>` / `->` reactive bindings | ✅ |
| `defer` / `defer await` | ✅ |
| `memo` declarator | ✅ |
| `arena { … }` block | ✅ |
| **bare-read sugar** (`x` → `x.get()`) | ✅ |
| `signal x = expr-with-signals` auto-promotes to derived | ✅ |
| Parity test against canonical Zig parser output | ✅ (12/12 fixtures byte-equivalent after normalization) |
| `bun:wrap` import injection for runtime helpers | ✅ |
| `using` / `await using` polyfill (ES2022 target) | ✅ |

### `using` polyfill

`defer EXPR;` and `defer await EXPR;` lower to ES2024 `using` /
`await using` declarations, then a final pass rewrites those into a
TS-style try/catch/finally block with `__addDisposableResource` and
`__disposeResources` calls. The helper definitions are inlined at the
top of any file that needs them, keeping the output self-contained
without requiring a runtime import. Final output runs on Node 18 / 20
and every modern browser without requiring an additional downlevel
pass from the host bundler.

## Install

```bash
npm install @para/transpile
# Plus the @para/* runtime packages your code uses, e.g.:
npm install @lyku/para-signals @para/parallel @para/pipeline
```

## Use

```ts
import { transpile } from "@para/transpile";

const js = transpile(`
  const handler = err => console.error(err);
  const result = fetch("/api").then(r => r.json()) ..! handler;
`);

// js is standard ES2022:
//   const handler = err => console.error(err);
//   const result = fetch("/api").then(r => r.json()).catch(handler);
```

## CLI

```bash
para transpile src/main.pts > dist/main.js
para transpile < src/main.pts > dist/main.js
```

## License

MIT
