# Para Schema: Recursive & Cyclic Structures — Implementation Plan

**Status:** Approved design, revised 2026-07-04 after codebase reconnaissance (§0.5) — ready for implementation
**Scope:** Schema IR (symbol-ref → `$ref` lowering + registry), grammar, validator, MessagePack codec
**Non-goals (v1):** checker-driven TS extractor (re-scoped to its own plan, see §3), JSON/JSON5 schema file formats (`.jschema`/`.j5schema`), `toJSONSchema()` exporter, edge-level cyclic opt-in, hydrate-after-construct for class instances, const-expression modifier parameters.

---

## 0. Glossary & Core Model

- **Recursive schema:** a schema whose definition references itself (directly or mutually), e.g. `Comment { replies: Comment[] }`. Describes trees/DAGs of unbounded but finite shape.
- **Cyclic value:** a runtime object graph containing an actual reference loop. Only legal when licensed by a `cyclic` declaration.
- **Registry:** the schema IR is a graph of named nodes with stable IDs. Recursion is represented as a registry reference — lowered to a JSON Schema `$ref` carrying the target's stable ID (§2.1) — **never** inline expansion and **never** lazy thunks. (The thunk+Proxy mechanism in `runtime.bun.js` is what this replaces; see §0.5.)
- **Two kinds of "ref" — keep the terms apart:** schema-level **`$ref`** (a registry reference inside the schema IR; resolves to a schema node) vs. value-level **REF** (a MessagePack backreference inside an encoded value stream; resolves to a previously-encoded object, §5). They never mix.
- **Capability model:** each schema *declaration* carries capability/config bits: `cyclic` (with optional max cycle length), `depth` (max recursive nesting), and later `identity: preserve`. Capabilities do **not** propagate into or out of embedded declarations.
- **Value-domain profiles (context):** JSON ⊂ MessagePack ⊂ JS-runtime. A schema with any cyclic-capable node fails the JSON profile check. Profile machinery itself is out of scope here, but nothing in this plan may preclude it.

---

## 0.5 Codebase Reality Map (added 2026-07-04)

What exists today, and therefore what this plan replaces vs. builds greenfield:

- **The `schema` keyword is implemented only in the Rust parser** (`parabun/src/js_parser/parse/parse_stmt.rs:2486` → `parse/schema.rs`) plus the runtime (`parabun/src/runtime.bun.js`). The Para-repo JS transpiler (`para-transpile`) has no schema transform. Spec-first rule applies: grammar changes land in `para/src/language-surface.ts` (+ `bun scripts/codegen.ts` regen of grammars/LSP allowlist) before the Rust port.
- **Recursion today = lazy thunk + Proxy.** The parser wraps every schema body in `() => body` (`schema.rs:137`); `__paraFromSchemaLazy` defers evaluation past TDZ (`runtime.bun.js:264–311`). The resulting schema value is a *cyclic JS object graph*. This entire mechanism is replaced by symbol-ref → `$ref` lowering (§1.7, §2.1); after this plan, schema values are acyclic JSON values and the thunk/Proxy path is deleted.
- **Two validator paths exist.** The DSL form (`schema X { field: type }`) lowers to inline codegen'd parse functions where a capitalized field type becomes a direct `TypeName.parse(f)` call (`schema.rs:629`); the `from`/`=` forms go through the runtime-interpreted `__paraFromSchema` walk. Neither has any cycle machinery — a cyclic value today means unbounded recursion. Build-order step 0 decides unify-vs-bifurcate before anything else lands.
- **No TS extractor exists.** `para-schema` is the *reverse* direction (type-level brand parity so TS types mirror JSON Schema). Nothing resolves TS types through the checker into schema IR; no `ts<…>` syntax exists anywhere. §3 is re-scoped accordingly.
- **No schema-driven MessagePack codec exists.** `para-sync` injects third-party codecs (msgpackr/BON) and treats envelopes as opaque (`para-sync/src/synced.js`). §5 builds a Para-owned schema-driven codec greenfield; it does not extend msgpackr.

---

## 1. Grammar & Parser

### 1.1 Syntax

```
declaration   := [cyclicMod] "schema" [configList] ident "=" type
cyclicMod     := "cyclic" [ "(" intLiteral ")" ]
configList    := "(" configEntry { "," configEntry } [","] ")"
configEntry   := key ":" value
```

v1 config keys: `depth: <non-negative int literal | unbounded>`. That's the only key.

Examples of legal declarations:

```
schema Comment = { body: string, replies: Comment[] }
schema(depth: 8) Comment = { ... }
cyclic schema Node = { next: Node | null }
cyclic(1) schema Node = { next: Node }
cyclic(2) schema(depth: 8) Tree = { parent: Tree | null, children: Tree[] }
```

### 1.2 Rules (all compile-time errors unless noted)

| Rule | Behavior |
|---|---|
| `cyclic(0)` | Error: "if you don't want cycles, omit cyclic" |
| Negative or non-integer-literal parameter | Error |
| Duplicate config keys | Error |
| Unknown config keys | Error (reserve the namespace; do not warn-and-ignore) |
| `cyclic` or `depth` on a schema whose graph is not recursive | **Lint warning** ("modifier has no effect"), not error |
| Trailing comma in config list | Legal |
| `schema(depth: n)` without `cyclic` | Legal — depth-capping plain trees is the primary DoS use case |

### 1.3 Formatter

- `cyclic` immediately precedes `schema`, no space before either paren group: `cyclic(2) schema(depth: 8)`.
- Canonical key order in config list once >1 key exists (alphabetical).
- Guarantee: `cyclic schema` and `cyclic(` remain stable grep strings.

### 1.4 Semantics summary

| Declaration | Meaning |
|---|---|
| (no cyclic) | Reference cycles closing through this declaration's nodes are **validation errors** with diagnostic "cycle detected in acyclic type `<Name>`" — never a stack overflow |
| `cyclic` | Cycles of any length permitted through these nodes |
| `cyclic(x)` | Cycles must close within ≤ x hops (x ≥ 1). `cyclic(1)` = self-references only |
| (no depth, recursive schema) | Implicit `depth: 128` enforced **at decode boundaries** |
| `depth: n` | Values nest ≤ n recursive-node levels of this declaration. `depth: 0` = recursive arm never taken (legal, degenerate) |
| `depth: unbounded` | Explicit opt-out of the default cap |

Depth counting: one counter per recursive declaration on the current path; increments on entering that declaration's recursive arm; **resets** when crossing into an embedded declaration; back-edges never consume depth (traversal returns at the memo hit before descending).

**Step-3 implementation decision (2026-07-04):** the reset rule is NOT implemented. Counters are per-declaration-id, path-scoped (decremented on return, so siblings don't accumulate), incremented on every `$ref`-mediated entry of that declaration, and never reset while on the path. Rationale: a literal reset-on-embedded-crossing lets mutually recursive declarations refresh each other's budget on every crossing (`Feed → CommentDag → Feed → …` never trips either cap), defeating the DoS bound the depth cap exists for. Attribution is preserved — each error names the declaration whose own counter tripped. `depth: n` concretely means: at most n `$ref`-mediated re-entries of that declaration on any single path (a linked chain of k nodes costs k−1). If a real case needs the reset semantics, revisit with a worked example.

Non-propagation: if `schema Feed = { threads: CommentDag[] }` embeds a `cyclic` CommentDag, Feed remains acyclic; cycles are legal only within the CommentDag subgraph. Every bound/error is attributable to exactly one declaration.

### 1.5 Escape-node check (compile-time)

For **plain (non-cyclic) recursive** schemas: every recursion loop in the schema graph must pass through an escape node (optional field, union with a non-recursive arm, or possibly-empty array). `schema T = { next: T }` without `cyclic` is a compile error — it has no finite inhabitants. `cyclic` schemas are exempt: `cyclic schema Node = { next: Node }` is legal and its values are necessarily cyclic.

**Timing caveat (revision):** compile-time applies to literal/DSL bodies. `schema X from <expr>` bodies are runtime values — the same check runs at **ingestion time** with the same diagnostics (as do shell-constructibility and unknown-config-key checks). "Compile-time error" throughout this plan means "as early as the form allows": parse time for literals, ingestion time for `from`.

### 1.6 Disambiguation: `schema(` (revision)

Today the parser enters schema-declaration parsing only when an identifier immediately follows `schema` (`parse_stmt.rs:2486–2494`), and the language surface encodes `schema(` as always-a-plain-call (the `schema-bare` skip pattern in `language-surface.ts`). The config-list form breaks that invariant.

- Parser rule: on contextual `schema` followed by `(`, snapshot, scan past the balanced paren group; if the next token is an identifier on the same line ⇒ declaration (rewind and parse config list + name); otherwise restore the snapshot and let `schema(...)` parse as an ordinary call. Mirrors the existing `schema NAME` newline guard.
- Same shape for the `cyclic` modifier: `cyclic schema …` / `cyclic(INT) schema …` are new contextual-keyword sequences (both are syntax errors today, so claiming them is backward-safe); `cyclic(1)` *not* followed by `schema` stays a plain call.
- `language-surface.ts` needs: `cyclic` added to the keyword lists, new pattern entries for the modifier and config-list forms, and the `schema-bare` skip pattern amended so `schema(` no longer unconditionally reads as identifier-use. Regen via `bun scripts/codegen.ts`.

### 1.7 Recursive references are symbol references (revision, adopted)

Inside a schema body, a capitalized type reference (`Comment` — self-references, mutual references, and references to schemas from other modules alike) resolves as an **actual symbol** under normal scope rules at compile time: imports, renames, and goto-definition work; an unresolvable name is a compile error. The compiler lowers the resolved reference to a schema-level `$ref` carrying the target declaration's stable node ID (§2.1). It never emits a direct object reference to the const binding and never a thunk.

---

## 2. Schema IR / Registry

### 2.1 Symbol-ref → `$ref` lowering (revision, adopted)

Recursion = registry reference by stable node ID, represented in the lowered JSON Schema as `{"$ref": "<stable-id>"}` — reusing JSON Schema 2020-12's own reference vocabulary rather than inventing one. Each `schema` declaration registers its body in the runtime registry under its stable ID at declaration time; `$ref` resolution is **lazy** (first validate/encode), so mutual recursion and module load order need no TDZ dance.

- **Stable ID:** fully-qualified name (module path + declared name). Content hash becomes a collision check / cache key, not part of identity — and it is no longer self-referential: recursive arms are `$ref` strings, so a schema body is a plain acyclic JSON value and hashing it is ordinary structural hashing. (Resolves the circular-hash problem in the original draft.)
- **Implemented mechanics (step 1, landed):** the module path is materialized at *runtime*, not parse time — declarations lower to `__paraSchemaDecl(import.meta.url, "Name", body)` (`__paraSchemaIngest` for `from`), and same-file references lower to the module-relative form `{"$ref": "#Name"}`, resolved against the declaring module's URL. This sidesteps transpile-time placeholder-path collisions (e.g. `Bun.Transpiler.transformSync` with no path) and matches JSON Schema's base-URI + fragment convention. Cross-module composition currently embeds the imported declaration by value (the registered object carries its own `$id` and base); full-URL `$ref`s are reserved for when the extractor needs them.
- **What this representation buys:**
  - Schema values are acyclic, `JSON.stringify`-able, content-hashable — `.jschema` export and `toJSONSchema()` get their structural part for free.
  - The thunk/Proxy machinery in `runtime.bun.js` is deleted, not extended. *(Step-1 deviation: the parser no longer emits thunks, but the runtime keeps thunk acceptance + the Proxy fallback until para-preprocess — which still emits `__paraFromSchema(() => body)` — migrates to registry refs. Delete it then.)*
  - The `$ref` boundary *is* the declaration boundary — non-propagation (§1.4), depth-counter reset, and per-declaration error attribution fall out of the representation instead of needing bookkeeping.
  - The future TS extractor emits the same `$ref`s for TS-level recursion, so "two extractions of the same type yield the same node ID" reduces to deterministic FQ-naming.
- **Resolution failure** at validate/encode time ⇒ runtime error `unresolved schema reference '<id>'` (§8).
- **Ingested schemas** (`schema X from <expr>`) may carry standard intra-document refs (`#`, `#/$defs/…`). The resolver handles both forms: JSON-pointer refs resolve within the ingested document, para stable IDs resolve via the registry. Normalize at ingestion.
- Plain `$ref` only — no `$dynamicRef`; Para semantics need no dynamic scoping.

### 2.2 Per-declaration compiled metadata

- Node IDs must be deterministic across compilation units (see §2.1). **Two lowerings of the same declaration must yield the same node ID** or memo/DAG behavior becomes flaky.
- Per-declaration compiled metadata:
  - `isRecursive: boolean` (does this declaration's graph reach itself)
  - `cyclic: false | { maxCycleLen: number | Infinity }`
  - `depth: number | Infinity` (with the 128 default materialized here for recursive schemas)
  - `refTracking: boolean` — computed as `cyclic || identity === 'preserve'` (identity key reserved, not implemented in v1)
  - `containsRecursiveNodes: boolean` — precomputed flag so validation/codec allocate zero cycle machinery for the ~95% non-recursive case
- Shell-constructibility check (compile-time): any node that is refTracking must be shell-constructible — plain object, array, Map, Set. A class-instance-typed refTracking node is a **compile error** in v1 (message should mention hydrate-after-construct is planned).

---

## 3. TS Extractor

> **Re-scoped (2026-07-04):** no TS extractor exists in either repo (§0.5) — the original build order called its node-identity rule "smallest, unblocks everything," but a checker-driven extractor is a large standalone project (§3's conditional/mapped/template-literal handling is the hard part of any such tool). The extractor is **deferred to its own plan** (§9). What v1 keeps from this section: the node-identity rule applied to the *existing* declaration and `schema X from <expr>` ingestion paths (§2.1), and the constraints below as requirements the future extractor must meet.

Rule: **TS-derived schemas are pure structure and always acyclic-capable-none.**

- Extractor emits plain nodes; recursion in TS types (`interface Comment { replies: Comment[] }`) becomes registry references, exactly like Para-native recursion.
- Extractor never infers `cyclic`. No JSDoc tags, no branded `Cyclic<T>` wrapper in v1. Cyclicity is granted only at a Para declaration site wrapping the extraction, e.g.:

  ```
  cyclic(1) schema(depth: 32) Comment = ts<import('./types').Comment>
  ```

  (Adapt to whatever the existing extraction syntax in the repo is — the point is: modifiers live on the Para declaration, not in the TS source.)
- If a TS type structurally contains a Para-declared schema (via codegen'd types), the extractor links to the existing registry node — it does not re-derive it — so the embedded declaration keeps its own capabilities per the non-propagation rule.
- TS type evaluation: conditional/mapped types resolved through the checker at extraction time; generics only at instantiation sites; function-typed fields degrade to `typeof === 'function'`; template literal types compile to regex checks; branded types check the base type (brand stays static-only).

---

## 4. Validator

> **Where this lands (revision):** two validator paths exist today (§0.5) — inline codegen'd parse functions (DSL form) and the runtime-interpreted walk (`__paraFromSchema`). The machinery below must exist on every path a recursive schema can reach. Recommended resolution (build-order step 0): the inline path delegates to the interpreted walker at `$ref`/recursive nodes, so cycle machinery exists exactly once; non-recursive DSL schemas keep their fast inline validators unchanged.

### 4.1 Data structures (allocated only when `containsRecursiveNodes`)

**In-flight path map** — `WeakMap<object, Map<nodeId, pathDepth>>`
- Entry added when descending into an object at a recursive node; removed on return.
- Hit on a still-in-flight entry ⇒ a cycle just closed:
  - Node not cyclic ⇒ error, include the cycle path in the diagnostic.
  - Node `cyclic(x)` ⇒ check `currentPathDepth − storedPathDepth ≤ x`; pass ⇒ accept **without descending** (coinductive accept); fail ⇒ "cycle exceeds declared length x".
- Storing pathDepth in the entry makes cycle-length checking O(1), no path scan.

**Completed-results memo** — `WeakMap<object, Set<nodeId>>`
- (value, node) pairs already validated successfully; consulted before descent.
- Purpose: prevents exponential re-validation on DAGs (diamond sharing), **not** cycle handling.
- Keyed on the *pair* — the same object flowing into two different schema positions must be checked against both. Memoizing on object alone is a soundness hole.
- Torn down after the root validation call. Never persisted across calls (mutation between calls would poison it).

### 4.2 Depth enforcement

Per-declaration counters on the current path per §1.4. Depth violations report: "nesting exceeds declared depth(n) on `<Name>`".

### 4.3 Soundness note

A value cycle can only be well-typed if the schema is recursive (finite non-recursive schema bounds depth), so cycle bookkeeping at recursive nodes only is sound. Non-recursive validation pays zero overhead.

---

## 5. MessagePack REF Ext Type

> **Greenfield (revision):** no schema-driven MessagePack codec exists today — para-sync injects msgpackr/BON and treats envelopes as opaque (§0.5). Steps 4–5 of the build order *build this codec*; they do not extend msgpackr. §5.2's critical invariant (decoder replays the encoder's registration decisions) only holds for a schema-driven codec, so msgpackr cannot host it. Wherever both codecs share a pipe, the collision surface includes msgpackr's own reserved ext IDs — document those in the central ext-ID registry too.

`REF` here is a **value-level** backreference in the encoded stream — distinct from the schema-level `$ref` of §2.1 (see §0 glossary).

### 5.1 Wire format

- Reserve **one** application ext type ID (0–127 range) for `REF`. Pick it, document it in a central Para ext-ID registry file alongside any existing reserved IDs (e.g. the `0xc1` sentinel usage) — collisions are forever.
- Payload: msgpack-encoded unsigned int = backreference index (encounter order).

### 5.2 Encoder

- Identity table (`Map<object, index>`), but **only objects encoded at refTracking nodes are registered**. Plain DTO encoding pays zero overhead.
- Index assigned in **preorder at first encounter, before children are encoded** — cycles therefore always resolve to already-assigned indexes; only backreferences ever occur, never forward.
- On revisiting a registered object: emit `REF(index)` instead of re-encoding.
- Since encoding is DFS in schema-walk order, and the codec is schema-driven, the decoder replays identical registration decisions ⇒ counters agree. **This is the critical invariant.**

### 5.3 Decoder

- **Shell-first** at refTracking nodes: allocate the empty object/array/Map/Set, register it in the decode-side index table, *then* fill fields. Required because a backref may point at an ancestor still mid-construction.
- Bounds enforced **during** decode, not post-hoc:
  - Depth cap checked before allocating each recursive descent (this is the actual DoS guard — validating after materializing a 10⁶-deep payload defeats the purpose).
  - Cycle length: when resolving a `REF` that lands on an in-flight ancestor, check distance against the decoder's own construction stack; enforce `cyclic(x)`.
  - `REF` landing on an in-flight ancestor at a non-cyclic node ⇒ decode error (same diagnostic family as the validator's).
- Malformed input handling: `REF(n)` where n ≥ objects seen so far ⇒ decode error "forward/invalid backreference". `REF` appearing at a non-refTracking schema position ⇒ decode error.

### 5.4 Identity preservation (design constraint only, v1 stub)

`identity: preserve` reuses refTracking machinery with one difference: backrefs may land on *completed* objects (DAG sharing) but **not** in-flight ancestors (no cycles without `cyclic`). Without the flag and without `cyclic`, revisited objects fork into copies (JSON-like semantics). v1 implements the `cyclic` path; structure the encoder/decoder so `identity` is a flag flip, not a rewrite.

---

## 6. Build Order

0. **Validator-path decision** (§0.5, §4 note): unify or explicitly bifurcate the inline-codegen and runtime-interpreted validator paths. Everything in §4 must land on whichever paths survive; deciding this late means landing it twice.
1. **Symbol-ref → `$ref` lowering + registry + node-ID determinism** (§1.7, §2.1) on the *existing* declaration and ingestion paths — replaces the thunk/Proxy mechanism outright; test fixtures become expressible as plain declarations. (Supersedes the original "extractor node-identity rule" step — no extractor exists; §3.)
2. **Parser/formatter for the grammar** (§1, incl. the `schema(` disambiguation of §1.6) + IR capability bits (§2) + compile-/ingestion-time checks (escape-node, shell-constructibility, cyclic(0), unknown keys). Spec-first: `language-surface.ts` + codegen before the Rust port (§0.5).
3. **Validator** (§4): both memos, depth counters, diagnostics.
4. **Schema-driven MessagePack encoder with REF** (§5.2) — greenfield codec, not an msgpackr extension.
5. **Schema-driven MessagePack decoder** (§5.3) with in-decode bounds.
6. **Fuzz harness** (§7.3).

Each step lands with its own tests; do not start the codec before validator tests are green (the validator is the oracle for codec round-trip assertions).

---

## 7. Test Plan

### 7.1 Grammar/compile-time

- `cyclic(1) schema Node = { next: Node }` — legal; values necessarily self-looping.
- `schema T = { next: T }` (no cyclic) — compile error (escape-node check).
- `schema(depth: 0)` on recursive type — legal, recursive arm never taken.
- `cyclic(0)` — compile error. Negative/non-literal params — compile error.
- Unknown config key — compile error. Duplicate keys — compile error.
- Modifiers on non-recursive schema — lint warning, compiles.
- Class-instance node with `cyclic` — compile error (shell-constructibility).

### 7.2 Validator

- Off-by-one suites for both `depth(n)` (values at n−1, n, n+1 levels) and `cyclic(x)` (cycles of length x−1, x, x+1; special-case x=1 self-loop).
- Cycle through acyclic recursive schema ⇒ "cycle detected in acyclic type" error, never stack overflow (test with deep and short cycles).
- `cyclic schema(depth: 8)`: value with a legal cycle AND excessive tree depth elsewhere ⇒ depth error still fires.
- Back-edge does not consume depth: `cyclic(1)` self-loop at max depth passes.
- DAG diamond: shared subtree validated once (assert via probe/counter on the memo), and same object at two different schema positions validated against **both** (soundness).
- Same object legal at node A, illegal at node B ⇒ B errors despite A's memo entry.
- Embedded-declaration boundary: depth counter resets; outer declaration's cycles can't launder through inner's `cyclic`.

### 7.3 Codec

- Round-trip isomorphism: encode→decode→validate on trees, DAGs, self-loops, mutual (length-2) cycles, mixed graphs.
- Aliasing semantics: with refTracking, aliasing preserved; without, shared objects fork into copies.
- Decode-side DoS: 10⁶-deep malicious payload rejected at the depth cap **before** full materialization (assert allocation/step count bounded).
- Malformed REF: forward reference, out-of-range index, REF at non-refTracking position — all decode errors.
- Encoder/decoder counter agreement under optional fields, unions, Maps/Sets — the fuzz target: random object graphs (with controlled cycle/DAG injection), round-tripped, asserting isomorphism including aliasing. Any index divergence must be caught here.
- Ext ID does not collide with existing Para ext usage.

### 7.4 Extractor (deferred with §3 — acceptance criteria for the future extractor plan)

- Same TS type extracted twice ⇒ identical node IDs.
- Mutually recursive TS interfaces ⇒ correct registry linkage.
- TS type embedding a Para cyclic declaration ⇒ links, does not re-derive; capabilities respected.
- Template-literal-typed field ⇒ regex check present in validator output.

### 7.5 `$ref` lowering & registry (v1)

- Self-reference, mutual (length-2) reference, and cross-module reference all lower to `$ref` with the target declaration's stable ID; the resulting schema value is acyclic (`JSON.stringify` succeeds).
- Unresolvable symbol in a schema body ⇒ compile error. Registered-then-missing at validate/encode time ⇒ `unresolved schema reference` runtime error.
- Two modules each declaring `Comment` ⇒ distinct stable IDs; a body referencing its local `Comment` resolves to the right one (shadowing respected).
- Ingested document carrying intra-document `#/$defs` refs round-trips through the resolver alongside registry IDs.
- Thunk/Proxy removal: a recursive declaration evaluates eagerly with no ReferenceError/TDZ fallback (the lazy path is gone); `schema` result objects are plain, not Proxies.
- Same declaration lowered twice ⇒ identical node ID (determinism, §2.2).

---

## 8. Diagnostics Copy (keep consistent)

- `cycle detected in acyclic type '<Name>' (path: <a → b → a>)`
- `cycle exceeds declared length cyclic(<x>) on '<Name>' (actual: <k>)`
- `nesting exceeds declared depth(<n>) on '<Name>'`
- `invalid backreference in msgpack stream (index <n>, <m> objects seen)`
- `unresolved schema reference '<id>'` (lazy `$ref` resolution failure at validate/encode time)
- `type '<Name>' requires cyclic capability but is not shell-constructible (class instances unsupported; see hydrate-after-construct, planned)`

---

## 9. Open Items Deliberately Deferred

- **Checker-driven TS extractor** (§3) — own plan; §3's constraints and §7.4's tests are its acceptance criteria. The `$ref` representation (§2.1) is designed so it slots in without IR changes.
- `.jschema` / `.j5schema` file syntaxes; `toJSONSchema()` lossy exporter (both made cheaper by §2.1 — schema values are already acyclic JSON).
- `identity: preserve` full implementation (machinery must be flag-ready per §5.4).
- Per-edge `cyclic` opt-in (backward-compatible narrowing; add only when a real 99%-tree-one-back-edge case demands it).
- Hydrate-after-construct protocol for class instances at refTracking nodes.
- Const-expression modifier parameters.
- msgpack/JSON profile checker (this plan only guarantees the capability bits it will need exist).
