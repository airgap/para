# Para UI (`@lyku/para-ui`) — Surgical Map

Package name is `@lyku/para-ui`. Source tree lives at `packages/para-svelte/` —
descriptive of what it physically is (a Svelte fork). The two names are
intentional: the directory says how it's built, the package name says what
it's for (powering `.pui` files).

This fork swaps Svelte's reactive primitives for `@lyku/para-signals` while preserving
Svelte's compiler, template binding, and render scheduler. It is the F0 work
item ([LYK-872](https://linear.app/lyku/issue/LYK-872)) for the `.pui`
([LYK-829](https://linear.app/lyku/issue/LYK-829)) component format.

## Why fork instead of preprocess

A preprocess pass that lowers `.pui` keywords to Svelte 5 runes works today
(`@lyku/para-preprocess` ships in parabun), but it leaves a value-store
seam: state lives in Svelte's `Source` struct, not in para signals. Code outside
the component can't observe it without re-deriving. Forking lets us:

- Make `signalOf(svelteSource)` a first-class operation.
- Run `.pui` files through Svelte's compiler unchanged — every existing Svelte
  control-flow primitive (`{#each}`, `{#await}`, transitions, snippets) works
  on day one.
- Stage Phase 1+ keyword features (`signal`, `derived`, `effect`, `using`,
  `provide`/`inject`, `emit`) without inventing a render engine.

## Two-axis architecture

Svelte's runtime has two concerns that are intertwined but logically separable:

1. **Storage / observability** — `Source` holds a value and a `reactions: Reaction[]`
   list. Reads call `get(source)`; writes call `set(source, v)`. Reactivity
   bookkeeping (push current reaction into `source.reactions`, mark reactions
   dirty on write) lives here.
2. **Scheduling** — `Batch`, `schedule_effect`, `flush`, the eager-effect path.
   Decides _when_ effects run after sources change.

This fork swaps **axis 1** (storage / observability) and keeps **axis 2**
(scheduling). Long-term we may also swap axis 2 (full scheduler replacement) —
that's F3+, not F0.

## Surgical map (axis 1 swap)

### `internal/client/reactivity/sources.js` — primary target

The `Source` struct (lines 76–95) becomes:

```js
{
  f: 0,
  v,                   // KEEP — Svelte's hot read path reads source.v directly
  reactions: null,     // KEEP — Svelte's reaction list, ordering decisions live here
  equals,
  rv: 0,
  wv: 0,
  paraSignal,          // NEW — @lyku/para-signals signal mirroring .v
}
```

`source(v)` allocates the para signal alongside `.v`. `internal_set(source, v)`
writes `source.v = v` AND `source.paraSignal.set(v)` (the para signal write is
guarded by the same `!source.equals(value)` check that already gates the rest
of the write path). Reads stay on `.v`.

After this lands, two consumers can observe the same value:

- Svelte's scheduler (via `.v` + `.reactions`)
- External para code (via `signalOf(source).get()`)

The expensive part is not the field allocation — it's making sure every write
goes through `internal_set`. Audit:

- `set(source, value, should_proxy)` — already routes to `internal_set`.
- `mutate(source, value)` — routes to `set`, OK.
- `update(source, d)` / `update_pre(source, d)` — route to `set`, OK.
- `increment(source)` — routes to `set`, OK.

So one site: `internal_set`. No other write seam.

### `internal/client/reactivity/deriveds.js`

`Derived` extends `Source`. Same struct shape; the bridge from `sources.js`
covers it for free. The recompute path (`execute_derived` in this file) writes
through the same `internal_set`-equivalent, which already updates `.v`.

Risk: `Derived` recomputes _lazily_ (on read, when dirty). The para signal must
reflect post-recompute value, not stale-but-being-recomputed. Solution: bump
the para signal at the end of `execute_derived` after `.v` is committed, not
inside the `internal_set` path (deriveds don't go through that on recompute).

### `internal/client/reactivity/effects.js`

Effects don't store values — they hold side-effect closures and lifecycle flags.
**No bridge required here.** External code consumes effects-as-observed-state
indirectly: subscribe to the sources the effect reads via `signalOf`.

Exception: when we add `using`/`provide`/`inject` to the keyword layer, those
desugar to context-stored effects. The lowering target is unchanged.

### `internal/client/reactivity/batch.js` (1425 lines — heaviest file)

**Keep entirely.** Svelte's batch semantics are not what `@lyku/para-signals.batch`
does. Svelte batches all writes within a synchronous task; para batches a
single explicit `batch(() => ...)` call. Cross-coordination — para writes inside
a Svelte batch, or vice versa — is F2 work.

When the bridge writes both `.v` and `paraSignal`, the para signal's effect
listeners fire on each write (no batching from para's side). That's correct
for the consumer-of-svelte-state case (`signalOf(s).get()` in a para effect):
the para effect sees every write, in order. Order-of-firing relative to Svelte
effects scheduled by the same write is undefined — para listeners run
synchronously (microtask), Svelte effects run at the next batch flush. Document
this; do not "fix" it.

### `internal/client/reactivity/async.js`

Async deriveds (the Svelte 5 `await` rune machinery). These wrap a Source with
Promise lifecycle (pending / resolved / rejected). The bridge in sources.js
covers the underlying Source. The Promise lifecycle itself is reflected
through Svelte's own state machine — para consumers see the resolved value
when the underlying Source updates, which is the right semantics.

### `internal/client/reactivity/props.js`

Component props are backed by Sources (one per prop). The bridge applies:
`signalOf(propsSource)` lets a parent observe a child's prop state, and lets
the `prop`/`emit` keyword layer in `@lyku/para-preprocess` thread props as
real para signals.

Risk: legacy mode (`legacy_mode_flag`) does a lot of magic around prop
mutation. F0 covers _runes mode only_ (`.pui` files are always runes); the
legacy path stays untouched.

### `internal/client/proxy.js` (the `$state` deep proxy)

The proxy holds a `Map<key, Source>`. Each property's source already has a
para signal once the sources.js bridge lands. So `proxySignal(svelteProxy)` is
trivially derivable.

But there's a subtlety: para's `proxySignal()` (added to `@lyku/para-signals` in the
prior session) and Svelte's `proxy()` are TWO different proxy implementations.
For `.pui`, we use Svelte's because the compiler's `$state` lowering targets
it. The bridge in sources.js means a Svelte proxy's per-property signals are
para-observable — same outcome, different internal proxy.

Don't try to unify the two implementations in F0. They coexist. `.pui` writes
through Svelte's proxy (because the compiler emits `proxy(value)`), and any
direct para code can use `@lyku/para-signals.proxySignal`.

## Implementation order

1. **F0.1** ✅ Rename inner package to `@lyku/para-ui`, private+dev version.
2. **F0.2** ✅ This document.
3. **F0.3** ✅ Plant additive bridge — `Source.paraSignal` field +
   `signalOf()` export.
4. **F0.4** ✅ Wire `@lyku/para-signals` as the resolved dep + integration smoke
   test (`tests/para-bridge.test.ts`).
5. **F0.5** ✅ Derived recompute path — single `mirror_to_para()` chokepoint
   called from Batch.capture (covers `set()` + batched `update_derived`),
   the fork-commit loop, and `update_derived`'s no-batch fallback.
6. **F0.6** ✅ Props bridge audit — writable props go through `derived()`,
   stores through `mutable_source()`, both reach `source()` shape and inherit
   the bridge.
7. **F0.7** ✅ Parity + perf. **7301 Svelte tests pass** across _every_
   test suite in the fork (runtime-runes 2566, runtime-legacy 3299,
   runtime-production 14, signals 96, store 33, hydration 80,
   server-side-rendering 217, css 181, validator 326, compiler-errors
   145, parser-legacy 82, runtime-browser 89, runtime-xhtml 25,
   migrate 76, snapshot 32, print 40, sourcemaps 26, parser-modern 25,
   preprocess 19, css-parse 16, motion 8, para-bridge 6). 63 skipped
   upstream — same count as unmodified Svelte. Zero failures.
   **⚠ Point-in-time snapshot.** As of 2026-05-15 `runtime-browser >
   custom-elements` (~12 tests) fails on the current Playwright/Chromium
   + bundler toolchain — proven NOT a fork-source regression (no
   custom-element runtime code changed since this commit; see LYK-885).
   Environment/browser drift only. Don't gate fork work on
   `custom-elements` — it's a separate compiler target, not the
   `.pui`/runes product surface.
   Kairo bench 4657ms (with bridge) vs 4681ms (no bridge) — within
   noise, well under the 5% bar. Cost amortized via lazy `paraSignal`
   allocation: created on first `signalOf()` call, seeded from
   current `.v`. **(The lazy optimization is reverted in LYK-882 —
   see item 8; the "Surgical map" above always specified eager.)**
8. **LYK-882** — axis-1 totalization. Reverts F0.7's lazy `paraSignal`
   to **eager + authoritative** allocation (the shape the Surgical map
   above always specified): `source()` / `derived()` allocate the para
   signal at construction, seeded from the initial value (`UNINITIALIZED`
   for deriveds, mirrored to the real value post-recompute). `signalOf()`
   collapses to a pure identity accessor (no lazy materialization, no
   seed race). `.v` + `.reactions` are KEPT as Svelte's scheduler
   substrate — this is the axis-1 swap, **not** the axis-2 scheduler
   replacement (still out of scope). Rationale: F3 codegen optimization
   (LYK-883) needs a para signal that exists for every cell so generated
   code can read it directly; the lazy mirror left nothing to target.
   The eager-allocation perf delta vs F0.7's lazy parity is quantified
   by the LYK-884 spike, not assumed.

   **Gate (verified):** 7517 pass across the full fork suite with zero
   new failures. The only failures are the `runtime-browser >
   custom-elements` suite (12 tests), which is **pre-existing and
   independent** — it fails identically with LYK-882 *fully reverted*
   (baseline: same 12, 11 in common; the 1-test delta is flaky — e.g.
   `closed-shadow-dom` passes 3/3 in isolation). That breakage predates
   this change (F0.7's "runtime-browser 89 pass" is stale; suspect an
   interim env/playwright shift) and is tracked separately — **not**
   introduced or worsened by LYK-882. para-bridge (6) + signals (98)
   green under LYK-882.

**F0 is functionally complete.** The user-facing flip shipped same day —
`@lyku/para-preprocess` now emits imports against `@lyku/para-ui` by default.
SSR + hydration + signals + store all green out of the box (the bridge
only touches client reactivity; the server runtime + hydration logic
ride along untouched on Svelte's existing machinery).

F1+ (devtools integration, HMR via vite-plugin-svelte against the
forked package, scheduler replacement, multi-target backends) are real
follow-up work but unlocked — nothing structural blocks them.

## Internal `'svelte'` import specifier — kept

The inner `tsconfig.json` has path aliases mapping `'svelte'`, `'svelte/action'`,
etc. to local source. ~55 internal files self-reference via these aliases
(`import { LegacyComponentType } from 'svelte/legacy'`, etc.). We deliberately
leave these as `'svelte'` rather than rewriting to `'@lyku/para-ui'`:

- Less divergence from upstream Svelte → cheaper merges.
- The aliases are TS-time only. The rollup build inlines self-references; the
  published package is `@lyku/para-ui` regardless.
- Consumers of the published package see `@lyku/para-ui` / `@lyku/para-ui/action` /
  etc. — the inner `'svelte'` alias is invisible to them.

Touching the internal specifier is something we can do later if we ever stop
merging from upstream; until then, leave it.

## What this fork is NOT

- **Not a competitor to Svelte.** Upstream Svelte updates flow in via merge.
  The `paraSignal` field and `signalOf` export are the only invasive changes
  in F0. Everything else is upstream Svelte.
- **Not a scheduler replacement.** Batch.js stays. The render pipeline is
  Svelte's. Para code observes; Svelte renders.
- **Not a proxy replacement.** Svelte's `$state` proxy continues to be the
  proxy `.pui` files use for deep-reactive state. `@lyku/para-signals.proxySignal`
  is for non-component code.

## What we publish

Nothing from this tree publishes until parity is proven. Package stays
`"private": true`, version `0.0.0-dev`. `.pui` files using `@lyku/para-preprocess`
continue to lower to Svelte runes targeting unmodified `svelte` from npm. The
flip happens when:

1. All F0.3–F0.7 work lands.
2. Svelte's full test suite passes against the forked tree.
3. `signalOf` is documented at the `@lyku/para-ui` public boundary.
4. `@lyku/para-preprocess` is retargeted to emit imports against `@lyku/para-ui`.

That last step is the user-facing flip. Until then, the fork is invisible to
consumers.
