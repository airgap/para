# @lyku/para-check

Batch type-checker for `.pui` Para UI components — `svelte-check` for the Para
substrate. One command, tsc-style output, non-zero exit on errors:

```sh
pui-check --workspace apps/webui
# src/routes/+page.pui(8543,97): error TS2339: Property 'revokeApiToken' does not exist …
# pui-check: 296 errors in 8 of 30 components
```

## Why svelte-check can't do this

`svelte-check` hardcodes the `.svelte` extension for its svelte2tsx projection,
so it silently skips every `.pui` — and its bundled language service is inert
against the `@lyku/para-ui` fork (verified: planted errors in both `.pui` and
shadow `.svelte` files go uncaught while it reports `0 errors`). A green
svelte-check run over a Para codebase is vacuous.

## How it works

Reuses the exact pipeline the parabun LSP trusts for in-editor `.pui`
intelligence (`editors/lsp/pui-transform.ts`, bundled in):

1. Para lowering (`signal` / `derived` / `effect` / `prop` → Svelte 5 runes)
   over a MagicString, producing a real sourcemap.
2. `svelte2tsx` over the lowered source, producing typed TSX and a second map.
3. One `ts.Program` over the workspace tsconfig's own ambient roots (`extends`
   resolved, so SvelteKit's `$app`/`$lib` paths, `app.d.ts`, generated `$types`
   all participate), the svelte2tsx shims (inlined — the target workspace does
   not need svelte2tsx installed), and every projection. `import X from
   "./X.pui"` resolves to the virtual `X.pui.tsx`, so component prop types are
   real across files.
4. Diagnostics for the projections only (plain `.ts` is `tsc`'s job), mapped
   back through the chained sourcemaps to original `.pui` positions.

TypeScript itself is resolved from the **target workspace** at runtime — the
diagnostics come from the compiler the project actually builds with.

## Flags

| Flag | Meaning |
| --- | --- |
| `--workspace <dir>` / `-w` | project root to check (default: cwd) |
| `--tsconfig <file>` | explicit tsconfig (default: nearest to workspace) |
| `--verbose` | list projected components on stderr |

Template expressions are checked, not just scripts; a component the projector
cannot parse fails the check (reported on that file) instead of crashing it.

Pre-release: API may change before 0.1.0.
