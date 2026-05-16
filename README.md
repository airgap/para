# Para

The Para language ecosystem — packages, LSP, and UI tooling that consume
the **ParaBun** runtime.

## Why this repo exists

ParaBun (the Bun fork) provides *native* Para language support: the
in-place parser/lexer deltas (`fun`, `|>`, `..!`, `..&`, `..>`, `pure`,
`.pts`/`.pjs`) compiled into the `parabun` binary. That stays in the
fork — it *is* the fork — kept minimal and guarded so the fork remains
rebaseable against upstream Bun.

Everything else — the `@para/*` / `@lyku/para-*` packages, the LSP /
`pui-transform`, the Para-UI Svelte fork, the codemod — does **not**
need to live in the Bun fork; it merely accreted there. This repo is
that ecosystem, with its own nx workspace, release, and (private) design
docs, so the fork stays lean and this stays clean.

## The hard boundary

The JS-side mirrors (`@para/transpile`, `para-preprocess`, the LSP
lowering) must stay **parity-correct with the ParaBun parser's
desugaring**. Same-repo, that coupling was implicit. Here it is an
explicit, versioned, tested boundary: this repo's CI runs the parity
suite against a **pinned `parabun` binary release**. Designing that
boundary correctly is the central migration concern (see the design
docs in `/raid/para-design`, deliberately kept out of any repo).

## Layout

nx monorepo; packages under `packages/*`. `bun` / `nx run-many` driven
(same conventions as the Lyku monorepo).
