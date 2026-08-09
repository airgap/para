# Para TS Extractor: Implementation Plan

**Status:** COMPLETE (all 6 steps, 2026-07-05), implemented in `packages/para-extract` + parabun main.
- Steps 1–4: program/checker skeleton; structural lowering (objects/optionals/arrays/literal-union→enum/structural-union→anyOf/template-literal→regex/Date→timestamptz/function marker/null-undefined optionality); recursion → `$ref` with `siblings` linkage + no-Para-declaration diagnostic; determinism; brand round-trip (`StringOf`/`NumberOf`/`BigIntOf`/`BooleanOf`/`ArrayOf` → validator-dialect keywords, via the `parabun` custom condition, the standard variant erases brands). Lockstep validator arms (`anyOf`, `function`) in parabun (2281dcc1bf).
- Step 5: `FromDecl<T, Name>` marker in para-schema (extended keeps the phantom, standard collapses); extractor links marked types to their registry node, never re-derives. Downstream codegen (lyku gen-dts-rewrite Phase-1) emits the marker when it adopts the convention.
- Step 6: `ts<import('./x').T>` directive: spec pattern in `language-surface.ts` (c9ae36e), parabun parser lowering to `__paraTsSchema(spec, name)` with an actionable unsubstituted-site error (5fd85c6491), and the build-step side: `substituteSource` + `para-extract` CLI (`--check`) rewriting sites to `/* ts<…> */ <body>`. The marker survives as a comment so re-runs refresh committed bodies (codegen.ts philosophy); all sites in a file are automatic `siblings`. Verified end-to-end: substituted output runs under parabun with cyclic validation and codec aliasing intact.
Split out of para-schema-recursion-plan.md §3/§9 (its §3 constraints and §7.4 tests were this plan's requirements, all satisfied).
Split out of para-schema-recursion-plan.md §3/§9 (which deferred the checker-driven extractor to its own plan; its §3 constraints and §7.4 tests are this plan's requirements).
**Prerequisite state:** the `$ref` registry lowering, cyclic/depth capability bits, validator machinery, and REF codec are all live (parabun `feat/schema-ref-registry`). The extractor emits into that IR unchanged.

---

## 0. What it is

A checker-driven tool that turns TypeScript types into Para schema registry bodies:

```
schema Comment = ts<import('./types').Comment>
cyclic(1) schema(depth: 32) LinkedComment = ts<import('./types').LinkedComment>
```

The `ts<…>` position resolves the named TS type through the TypeScript checker at extraction time and lowers it to a plain JSON Schema body, recursion becoming registry `$ref`s exactly like Para-native recursion. **TS-derived schemas are pure structure and always acyclic-capable-none**: capability modifiers live only on the Para declaration wrapping the extraction, never inferred from TS source (no JSDoc tags, no branded `Cyclic<T>`).

## 1. Architecture

- **Extraction site:** build-time, not runtime. The parser lowers `ts<TypeRef>` to a placeholder call; a build step (parabun bundler plugin or standalone `para-extract` tool holding a `ts.LanguageService`) replaces it with the extracted JSON body before/independent of execution. Runtime never loads tsc.
- **Node identity (§2.2 determinism):** the extracted declaration's stable ID is the Para declaration's own `import.meta.url + "#Name"` (unchanged). Determinism requirement is internal: two extractions of the same TS type must produce byte-identical bodies, same property order (source order), same `$ref` targets, so content hashes agree.
- **Registry linkage:** if a TS type structurally contains a Para-declared schema (via codegen'd types carrying a brand marker), emit a `$ref` to the existing registry node rather than re-deriving. The embedded declaration keeps its own capabilities (non-propagation).

## 2. Type-lowering rules (from recursion-plan §3)

| TS construct | Lowering |
|---|---|
| interface / object type | `{ type: "object", properties, required }` (optional `?` fields excluded from `required`, escape nodes fall out naturally) |
| self/mutual type recursion | registry `$ref` to the wrapping declaration(s); mutual recursion requires all participating types to have Para declarations, error otherwise, naming the missing one |
| conditional / mapped types | resolved through the checker at extraction time (`checker.getTypeOfSymbol` on the instantiated type) |
| generics | instantiation sites only; bare generic declarations are an error |
| template literal types | compiled to `pattern` regex checks |
| branded types (`para-schema` brands) | base type; the brand's constraint payload (e.g. `StringOf<{minLength: 3}>`) re-emitted as the matching JSON Schema keywords, round-trips the existing brand parity |
| function-typed fields | degrade to `typeof === "function"` marker (non-JSON profile) |
| unions | `enum` for literal unions; `anyOf` for structural ones (validator grows an `anyOf` arm in lockstep) |
| `Date`, `Map`, `Set`, typed arrays | explicit table, error on anything unmapped (no silent `{}`) |

## 3. Build order

1. `para-extract` skeleton: LanguageService host, `ts<…>` site discovery, snapshot tests of emitted bodies (fixtures = §7.4 of the recursion plan).
2. Object/primitive/optional/array lowering + determinism test (same type twice ⇒ identical bytes).
3. Recursion → `$ref` emission; mutual recursion across two declarations; missing-declaration diagnostics.
4. Checker-heavy features: conditional/mapped resolution, template literals → regex, brand round-trip.
5. Registry-linkage for embedded Para declarations (brand marker in codegen'd types).
6. Parser/bundler integration: `ts<…>` placeholder lowering + build-step substitution; stale-extraction detection (hash of the source type text embedded next to the body).

## 4. Acceptance criteria (= recursion plan §7.4)

- Same TS type extracted twice ⇒ identical node IDs / bodies.
- Mutually recursive TS interfaces ⇒ correct registry linkage.
- TS type embedding a Para cyclic declaration ⇒ links, does not re-derive; capabilities respected.
- Template-literal-typed field ⇒ regex check present in validator output.

## 5. Non-goals

- Inferring `cyclic`/`depth`/`identity` from TS source.
- Runtime extraction (tsc in the runtime).
- Emitting anything the validator/codec can't consume: every lowering lands with a validator test.
