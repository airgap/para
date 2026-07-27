# Para Sync: Query Sync, Server Sources & Query-Derived Cells — Implementation Plan

**Status:** Approved design, 2026-07-26, after codebase reconnaissance (§0.5) — ready for implementation
**Scope:** scalar query sync (`sync NAME :: S from query(...)`), opaque server-source sync (`sync NAME :: S from server EXPR + refresh policy`), query-derived cells (`derived NAME :: S = EXPR`), the reactive re-subscription rule, server escape analysis, and the SvelteKit fullstack projection (P9).
**Spec anchors:** ch. 08 §13.7–§13.8 (added with this plan), ch. 07 §10.7 (added with this plan), ch. 11 projection table (P9 proposed here, chapter amendment deferred).
**Non-goals (v1):** cursor/offset pagination surface on `query()`, cross-route shared replica dedup, partial/field-level subscriptions, a generic RPC surface (`server` is a *source* form, not a function-call form), non-SvelteKit host targets for P9 (the artifact contract is host-agnostic, but only the SvelteKit emitter ships), reactive re-subscription for the shipped keyed form (`from KEY` stays evaluate-once in v1 — see §3.4).

---

## 0. Glossary & Core Model

- **Live query (L-query):** a `from query(SPEC)` source. The authority *understands* the query — it is a typed spec over the schema spine, compilable to SQL by lockstep-pg — and therefore knows its **read-set**: which rows/columns the result depends on. Writes flowing through the authority (mutate intents, P4 handles) touch known rows, so the authority re-runs affected queries and re-publishes envelopes. Liveness is automatic *because the read-set is known*. This is the Convex/Meteor insight, kept inside Para's Class-A reconcile discipline.
- **Snapshot source (L-server):** a `from server EXPR` source. `EXPR` is opaque hand-written server code (ORM call, raw SQL, third-party API). The server *cannot* know when its result changes, so the contract is **snapshot + declared refresh policy** — `every D`, `on KEY`, or `once`. The policy is syntactically mandatory: fake liveness is never implied. This is the same visible-contract principle as the single-`:` trusted opt-out (ch. 08 §2.2) and the anti-Meteor boundary (ch. 08 §7.2).
- **Query-derived cell:** `derived NAME :: SCHEMA = EXPR` — the **pull** mirror of sync's **push**. Client-initiated, tracked (re-runs when signals read inside `EXPR` change), latest-wins, parse-gated on settle. No sequence reconcile, no authority — it is "a source with a parse gate" (ch. 07), not a sync form.
- **Param crossing (the reverse gate):** any client-reactive value referenced inside a `query(SPEC)` or `server EXPR` becomes a **wire param** — a value crossing the trust boundary in the *opposite* direction. Params are parse-gated **server-side on the way in**, exactly as envelopes are parse-gated client-side on the way out. Both directions of the boundary are gated; neither end trusts the wire.
- **The taxonomy in one line:** `derived … :: S = EXPR` (pull, gate) · `sync … :: S from query(…)` (push, gate + reconcile, live) · `sync … :: S from server EXPR policy` (push, gate + reconcile, declared refresh) · `sync … :: S from KEY` (push, gate + reconcile, authority-driven — shipped today).

---

## 0.5 Codebase Reality Map (2026-07-26)

What exists today, and therefore what each section replaces vs. builds greenfield:

- **Shipped in `para-preprocess` + `@lyku/para-sync`:** the three `sync`/`synced` declaration forms (`syncedBinding`, `lowerSyncFromDecls`, `lowerSyncedDecls`); the array query form `sync N :: S[] from query(SPEC)` → `syncedQuery(S, SPEC)` (`feedBinding`, `feeds.js`); `mutate NAME of ENTITY { … }` → `createIntent` (`lowerMutateDecls`, `writer.js`); `presence NAME :: S in CHANNEL` → `presence()` (`lowerPresenceDecls`, `presence.js`). The full-control `synced` form already accepts a **`seed`** opt — the SSR-seed hook P9 needs (§6) exists.
- **Runtime-only (no surface sugar):** `queue.js` (`createQueuedIntent`, ch. 08 §13.5) and `transaction.js` (`createTransaction`, §13.6). Not touched by this plan, but they prove the pattern: runtime primitive first, sugar second.
- **`async signal` is deliberately fire-once-per-mount** (ch. 07 §3.3 edge case): constructed outside any effect, does not re-fire on dependency change, with re-keying explicitly deferred to "a derived/keyed pattern." §5 fills exactly that reserved slot. `promiseSignal` already threads an `AbortController` signal to thunks that accept it.
- **The sync key is evaluated once at bind.** `const __syn_NAME = synced(KEY, S)` captures the key's params at construction; nothing re-subscribes on param change. §3 defines re-subscription for the *new* forms; the shipped keyed form keeps its semantics (§3.4).
- **No server-artifact extraction exists anywhere.** lockstep generates boundary code *from schemas* (ch. 11 P1–P8), but nothing extracts *per-declaration expressions* into server modules. §4's escape analysis and §6's route emit are greenfield.
- **Catalog:** `sync-decl` / `synced-decl` / `mutate-decl` patterns exist in `language-surface.ts` (para `310ae9d`) — highlighting only. No `query`/`server`/policy grammar is cataloged; §7 lands catalog entries per-step as each surface ships (spec-first rule).
- **`para-transpile` (standalone) has none of the preprocess layer.** All forms in this plan are `.pui`-scoped (component-scoped runes bridge), lowered by `para-preprocess`. The playground cannot demo them; the site reel can (hand-curated pairs).

---

## 1. The liveness contract — the load-bearing decision

The `from` clause tiers by **what the server can know**, and the surface never blurs the tiers:

| Tier | Form | Liveness | Why |
|---|---|---|---|
| L-key | `from KEY` (shipped) | authority-driven push | the authority owns the key and publishes when *it* writes |
| L-query | `from query(SPEC)` | **automatic** | the spec's read-set is known → writes through the authority invalidate precisely |
| L-server | `from server EXPR` | **declared** (`every D` / `on KEY` / `once`) | `EXPR` is opaque; nobody can know its read-set |

A `from server EXPR` with **no policy is a compile error**, with the fix-it naming all three policies. `once` exists so that "SSR seed, never refreshes" is a *visible* choice rather than the silent default of a forgotten policy.

**Anti-goal (normative):** no implicit polling default, no "we'll diff it for you" magic on L-server. If a source needs precise liveness, the pressure is toward expressing it as an L-query — which is the direction the schema-spine thesis wants code to move anyway.

---

## 2. Scalar query sync — `sync NAME :: SCHEMA from query(SPEC)` (ch. 08 §13.7)

The array form (§13.3) is shipped; the scalar form is its `limit: 1` degeneration with membership semantics.

```
ScalarQueryDecl ::= "sync" Ident "::" Schema "from" "query" "(" QuerySpec ")" ";"
```

- **Type:** `Infer<S> | undefined`. `undefined` means "no row matches" — a *membership* fact delivered on the membership channel, distinct from "not yet loaded" (`status: 'stale'` pre-baseline). Row deletion transitions the cell to `undefined`; it never silently retains a deleted row.
- **Desugar:** `syncedOne(S, SPEC)` — a degenerate one-row `syncedQuery` sharing the per-row `createClientReplica` machinery and both envelope kinds (row value + membership). No new reconcile engine.
- **Liveness:** L-query. The authority compiles `SPEC` against the spine (lockstep-pg), registers the read-set, and re-evaluates on intersecting writes.

---

## 3. The reactive re-subscription rule (normative for §2, §4, and §13.3 feeds)

Today's binding is construct-once. Query/server forms instead evaluate their spec/params **in a tracked scope**:

1. Serialize the subscription identity: `subKey = stableSerialize(declId, paramValues)`. Param values are the client-reactive values referenced in `SPEC`/`EXPR` (the §0 param crossing).
2. On any tracked change, recompute `subKey`. **Unchanged ⇒ no-op** (no churn from irrelevant re-renders).
3. Changed ⇒ construct the new handle, keep the **old value in the cell as a stale seed** (`status: 'refetching'`), dispose the old handle immediately (one in-flight replica per declaration), and swap the cell to the new baseline when it lands.

```
# Lowering shape (replaces the construct-once bridge for these forms)
let user = $state(undefined);
let __syn_user;                                  // current handle, swapped on re-key
$effect.pre(() => {
  const h = syncedOne(User, { where: u => u.id == id });   // reads of `id` are tracked here
  __syn_user = h;
  const seed = h.peek?.(); if (seed !== undefined) user = seed;
  const un = h.subscribe?.(v => { user = v; });
  return () => { un?.(); h.dispose?.(); };       // cleanup runs before re-key and on unmount
});
```

**3.4 Back-compat boundary.** The shipped `from KEY` form keeps evaluate-once semantics in v1 — changing it silently would alter live behavior of existing components. Extending re-subscription to L-key is a v2 item gated on an explicit audit of existing `.pui` usage.

---

## 4. Opaque server-source — `sync NAME :: SCHEMA from server EXPR POLICY` (ch. 08 §13.8)

```
ServerSyncDecl ::= "sync" Ident "::" Schema "from" "server" Expr Policy ";"
Policy         ::= "every" DurationExpr | "on" Expr | "once"
```

`server` is a contextual keyword valid only after `from` — the *visible runtime-boundary marker*, deliberately a keyword and never inferred from where an import happens to resolve. Implicit splitting is how server code leaks into client bundles; the boundary is written in source, the same way `::` writes the trust boundary.

### 4.1 Both-ends gating

- **Outbound (server):** the artifact's return value is parse-gated against `SCHEMA` *before* publish. A server bug surfaces once at the boundary as a server-side error — not N times on N clients as reconcile chaos.
- **Inbound (client):** envelopes parse-gate exactly as shipped Tier-1 (`createClientReplica`).
- **Params (reverse direction):** each wire param is parse-gated server-side on arrival (§4.2 rule 2).

### 4.2 Escape analysis (normative)

The free identifiers of `EXPR` partition as:

1. **Module imports** → hoisted into the generated server artifact. An import used *only* by server expressions is stripped from the client emit. An import used by both server expressions and client code in the same file is a **compile error** (`module X crosses the server boundary; split the file or mark a shared module`) — no silent double-bundling.
2. **Client-reactive bindings** (props, signals, synced cells) → become **typed wire params**. Each must be JSON-profile serializable, and each must have a derivable validator: from the spine where it feeds a typed query column, from a schema-branded type, or from a primitive. A param whose validator cannot be derived is a compile error (I3 — no silent `unknown` crossing the boundary). Changes to params re-key the subscription (§3).
3. **Locals declared inside `EXPR`** → fine, they travel with the artifact.
4. **Forbidden captures:** functions/closures as param values, DOM/component refs, `this`, mutable module state. Each has a targeted diagnostic.

### 4.3 Generated artifacts (glass floor, INV-mpb-1)

Per source file with server expressions: one readable, ejectable sibling artifact (`<file>.server.pts`) exporting one named `async (params, ctx) => value` per declaration, plus the param parse gates and the outbound schema gate — plain code a developer could have written, zero reflection. `ctx` is the P8 `SecureContext` (ch. 11 §6); v1 requires the route/host to supply it, and an `EXPR` that needs auth reads it explicitly (`server db.ordersFor(ctx.userId)` — visible, typed).

### 4.4 Policies

- `every D` — the host re-runs the artifact per subscription key on the cadence; **one shared timer per `subKey`**, fan-out to all subscribers of that key (never per-connection timers).
- `on KEY` — the host subscribes to `KEY` on the existing transport; a server-side `invalidate(KEY)` helper (one-line publish) triggers re-run + re-publish. This is the manual read-set: the author declares "this query changes when this event fires."
- `once` — seed only (SSR or first bind); never refreshes; visible in source.

Sequence numbers: the host assigns a monotonic `sequence` per `subKey` on each re-run whose value differs (deep-equal short-circuit), so the shipped reconciler applies unchanged.

---

## 5. Query-derived cells — `derived NAME :: SCHEMA = EXPR` (ch. 07 §10.7)

The pull mirror, filling ch. 07 §3.3's explicitly reserved "derived/keyed pattern" slot.

```
QueryDerivedDecl ::= "derived" Ident "::" Schema "=" Expr ";"
```

- **Discriminator:** `::` after the name is currently unused on `derived` — its presence means: async initializer, tracked re-run, parse-gated settle. Plain `derived x = expr` is untouched.
- **Cell shape:** `{ data, error, pending }` (the `async signal` shape) with **stale-while-revalidate**: on re-run, `data` retains the previous value and `pending` flips true; the new settle replaces both. (Contrast `async signal`: fire-once, `data` starts `undefined`.)
- **Latest-wins:** each run gets a run-id + `AbortController`; a superseded run is aborted (the thunk receives the signal, `promiseSignal` convention) and its settle discarded. No out-of-order clobber.
- **Gate:** the resolved value crosses `SCHEMA.parse`; an `Err` lands in `error` (branch-never-throw at the boundary — a malformed response is a *state*, not a crash).
- **Lowering:** `querySignal(s => (EXPR), SCHEMA)` constructed inside the §3 tracked bridge (construct in `$effect.pre`, cleanup + rebind on dep change). `querySignal` lives in `@lyku/para-signals` beside `promiseSignal` — it is client-pull with no reconcile, so it does **not** belong to para-sync.
- **Position note:** the gate is annotation-position (on the cell) rather than expression-position (`EXPR :: S`, the ch. 07 §10.1 spelling) because the initializer re-runs — the gate is part of the *cell's contract*, not of one evaluation. Both spellings rhyme with `value :: Schema` and gate identically.

---

## 6. SvelteKit projection — P9 (fullstack compile target)

The `.pui` build already terminates at the Svelte compiler (ch. 11 §3–§4); P9 extends the projection table, not the philosophy. Per route, the emitter generates:

1. **`+page.server.ts`** — a load that runs, for every sync declaration reachable from the route's components: the L-query spec or the L-server artifact, producing **SSR seeds**. The client binding consumes them via the *existing* `seed` opt → zero-flash first paint, no double fetch.
2. **`+server.ts` (SSE)** — one endpoint bridging the transport: subscribes server-side (NATS/in-process), writes `SyncEnvelope`s down SSE per `subKey`. The client transport for P9 is an `SseTransport` implementing the shipped dumb-pipe contract (ch. 08 §4.1) — the reconciler does not change.
3. **`+server.ts` (POST)** — mutate intents (`createIntent.send`) land here; confirm/reject flow back over the SSE channel. `mutate` (shipped) composes without modification.
4. The escape-analyzed `<file>.server.pts` artifacts (§4.3), imported *only* by the generated endpoints.

Host contract is deliberately minimal — SSE + POST — so P9's artifact shapes are host-agnostic even though only the SvelteKit emitter ships in v1. The `.para` manifest gains `project { sveltekit: { routesDir } }` (ch. 11 §12 consumes it). All emitted files are readable/ejectable (INV-mpb-1).

---

## 7. Grammar & catalog (spec-first discipline)

Each step below lands its surface in `para/src/language-surface.ts` (+ `bun run codegen`: TextMate, LSP allowlist, splash keywords) **in the same change as the preprocess lowering ships** — the catalog never trails a shipped form again (the sync/synced/mutate gap closed 2026-07-26 was exactly this debt). Planned entries: extend `sync-decl` doc for the query/server forms; a `server` contextual pattern (`(?<=from\s)(server)\b` — never the bare identifier); `once` policy token; `on` stays uncatalogued (too common; the policy position is enough for the preprocessor, and highlighting `on` everywhere would be noise). `every` already exists.

---

## 8. Build order

0. **Spec first (this change):** ch. 08 §13.7/§13.8, ch. 07 §10.7, this plan. No implementation.
1. **`querySignal` + `derived NAME :: SCHEMA = EXPR`** — smallest, fully client-side, standalone: runtime in para-signals (latest-wins, abort, gate), preprocess lowering (tracked bridge), tests (re-run on dep change, stale-while-revalidate, out-of-order discard, parse-Err → error, unmount abort). Catalog entry with it. **DONE 2026-07-26** — `querySignal` (13 tests), `lowerQueryDerivedDecls` ordered before the plain derived pass (8 tests; also fixed the stale `@para/signals` import-dedup regex), `derived-decl` catalog doc, spec §10.7 flipped to Shipped. Implementation note: the SWR `prev` is threaded via an untracked `__qdv_` shadow variable — reading the `$state` cell inside the effect would make every settle re-trigger the rebind (infinite refetch loop).
2. **`syncedOne` + scalar query lowering + §3 re-subscription bridge** — feeds.js sibling, preprocess `sync N :: S from query(SPEC)` (no `[]`), the tracked-scope binding for query forms, tests (undefined-on-no-match, delete → undefined, re-key keeps stale value). **DONE 2026-07-26** — `syncedOne` composes over `syncedQuery` (limit-1, per-row replica reuse; 10 tests) with a **ready gate**: pre-membership, `peek()` is undefined and `subscribe` is silent, so a re-keyed binding keeps its stale cell value with no undefined flash, and post-ready `undefined` is a real "no row" fact. Membership applies *before* ready flips, both in one `batch()` — para-signals drains effects synchronously, so the reverse order emitted a spurious undefined. `lowerSyncOneDecls` sits between the feed pass and the single-object pass (whose KEY grammar would swallow `query({...})` as a key expression); 7 tests. **Correction:** the original parenthetical "(array form migrates to it too)" is withdrawn — `feedBinding` is *shipped* construct-once surface, and silently re-keying it is exactly the §3.4 back-compat violation; the array form joins the §3.4 v2 audit instead. subKey-level no-op is approximated by runes fine-grained tracking (the effect re-runs only when a read value actually changes); exact serialized-key memoization is deferred to the same audit.
3. **Authority-side read-set invalidation** — the server story for L-query: the authority API that compiles `SPEC` against the spine, registers read-sets, re-evaluates on intersecting mutate/handle writes. Depends on lockstep-pg; the seam where "schema is the application" earns the liveness. **DONE (host) 2026-07-26** — `createQueryAuthority` (`query-authority.js`, 11 tests incl. E2E authority⇄`syncedOne`/`syncedQuery`): per-row `+1` sequences (matching the reconciler's exact-successor steady-state rule), deep-equal short-circuit (an identical re-eval publishes nothing), outbound parse gate (malformed rows are skipped + `onError`, never published), membership diffing (value changes ride the transport, membership changes ride the delta channel), per-subscription evaluation serialization (a slow initial eval can't clobber a later one), and intersection semantics where the default read-set is "everything" — precision is an *optimization contract* supplied by the deployment (`readSetOf`), never a correctness dependency. **Deliberately evaluator-agnostic:** `evaluate`/`readSetOf` are host-supplied; the lockstep-pg adapter (typed spec → SQL + precise read-set derivation) is the lyku-side integration and stays open here.
4. **`server EXPR` extraction** — escape analysis in para-preprocess (§4.2 diagnostics are the bulk of the work), `<file>.server.pts` emit, the three policies, `invalidate()` helper, both-ends gating, tests per forbidden-capture class. **DONE 2026-07-26** in two halves. (4a) `createServerSource` host (`server-source.js`, 7 tests): policy exclusivity enforced at the host too, per-key `+1` sequences with deep-equal skip, mid-run triggers coalescing into ONE trailing re-run, both-ends gating (run/parse failures → `onError`, clients keep last good), `invalidate(transport, key)` + `subKey(declId, params)`; E2E: the client side is stock Tier-1 `synced(key, S)` — zero new client machinery. (4b) `extractServerSources` (para-preprocess, 9 tests): policy scanner (depth/string-aware, so `"run every day"` inside the expression never terminates it), escape analysis partition (imports → hoisted, component names → positional wire params, ambient globals travel), compile-error diagnostics (missing policy, both-sides import — with the schema-root exemption since schemas are isomorphic —, `this`), the tracked client binding with `subKey(declId, [params])` re-keying, and the readable server module (`__paraServerSources`). Runs inside `lowerPuiReactivity` (filename threaded as `moduleId` so client subKey ≡ host subKey) AND standalone for the P9 emitter, which owns file-writing. Catalog: contextual `sync-server-source` pattern (`(?<=\bfrom)\s+(server)\b`) — deliberately no splash keyword / no LSP allowlist (bare `server` is a ubiquitous identifier). Open here: param validators (the §9 params-clause question) and the host glue instantiating one `createServerSource` per live param-set (P9).
5. **P9 SvelteKit emitter** — route scan, seed loads, SSE/POST endpoints, `SseTransport`. E2E: SSR seed → live envelope → mutate round-trip in a scratch SvelteKit app. **DONE (v1) 2026-07-26** — new package `@lyku/para-kit` (7 tests): pure emitter core (`emitServerArtifacts` — per-.pui `*.server-sources.pts` artifacts + one flat app manifest with manifest-relative imports) with the `para-kit emit` CLI as the fs shell (`--check` = CI drift gate); `createServerSourceHost` (lazy: one `createServerSource` per LIVE subKey, so §4.4's shared-timer rule falls out; `seedFor` is the SSR-seed hook; unknown keys pass through for other channel kinds); `createSyncEndpoint` (SvelteKit-shaped GET/POST on pure web standards — subscribe-before-seed so no publish is lost in the gap; POST delegates intents, 501 without a handler); `createSseTransport` (client dumb-pipe subscribe over an injected EventSource; key-set changes coalesce per microtask into one reconnect; **late-joiner replay**: last envelope per key replays on subscribe — a real gap the E2E exposed, idempotent because envelopes carry sequences; `publish` throws — the read path is one-directional). E2E: fixture .pui → emitted artifact **imported and executed** → host → real `Response` stream → SseTransport → `synced()` cell, including a server-side `invalidate()` flowing all the way down and subKey sharing across two clients. **Scope notes:** the endpoint route is written ONCE (ejected by construction, INV-mpb-4); per-route *generated* `+page.server.ts` seed loads stay Proposed (`seedFor` is the manual hook); the scratch-SvelteKit-app smoke stays open (the harness E2E covers the same seams in-process).
6. **Ch. 11 amendment** — add P9 to the projection table and the manifest key, once step 5 proves the artifact shapes. **DONE 2026-07-26** — P9 row + the one-paragraph spec note in ch. 11 §2 (nine projections, one spine); `.para` manifest `project { sveltekit }` key stays with §12's manifest work.

Steps 1 and 2 are independent and can land in either order; 3 blocks nothing before it (L-query ships snapshot-correct with refetch-on-rekey even before read-set liveness lands, but is not *advertised* as live until 3); 4 and 5 are sequential (5 consumes 4's artifacts).

## 9. Open questions (tracked, non-blocking)

- **Param validator derivation** breadth: is "spine column ∨ schema-branded ∨ primitive" enough, or does v1 need an explicit `params { x :: S }` clause escape hatch?
- **Shared-import strictness** (§4.2 rule 1): the both-sides compile error may prove too blunt for utility modules; a `shared` marker is the likely relaxation.
- **`every` under fan-out** at scale: shared-timer-per-subKey is the rule, but param-cardinality explosion (per-user keys) may want jittered scheduling.
- **Auth surface for `ctx`:** v1 reads `SecureContext` explicitly; whether P9 auto-threads session → `ctx` is a ch. 11 P8 question, not decided here.
- **Re-subscription for L-key** (§3.4): v2, after auditing shipped `.pui` usage.
