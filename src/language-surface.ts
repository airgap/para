// Para language surface — single source of truth for every keyword,
// operator, refinement type, and primitive type the language exposes.
//
// Auxiliary tools (TextMate grammars, LSP allowlist, ts-plugin
// recognizers, snippets, docs) are generated from THIS file via the
// scripts in scripts/codegen/. The Zig parser at src/ast/*.zig is the
// authoritative behavioral implementation; this catalog is the design
// surface that everything else consults so we stop hand-replicating
// the same keyword list in five different places and missing one
// every time a feature lands.
//
// When you add a new Para feature:
//   1. Implement parsing in src/ast/* and add behavior tests under
//      test/bundler/transpiler/parabun-*.test.js.
//   2. Add a catalog entry HERE describing how it should be
//      highlighted, recognized by the LSP, etc.
//   3. Run `bun run codegen` to regenerate the auxiliary tool files.
//   4. The CI gate at scripts/codegen/check-clean.ts will fail any
//      PR that adds catalog entries but forgets the regen step.

/** Each Para construct's classification — drives which auxiliary
 *  surfaces care about it. Keywords appear in the TextMate grammar
 *  and the LSP allowlist; operators appear in the grammar only;
 *  refinement / primitive types appear in the grammar as type-
 *  position-only patterns. */
export type EntryKind =
  | "keyword" // standalone keyword (pure, schema, match, signal, …)
  | "operator" // glyph sequence (|>, ..>, ::, ~>, …)
  | "refinement-type" // schema-body type with format constraint (Email, UUID, …)
  | "primitive-type" // schema-body primitive (int, str, bool, …)
  | "constructor" // tagged-union constructor (Ok, Err, Some, …)
  | "constant"; // bare value (None)

/** Which Para source extensions this entry highlights in. Most
 *  apply to all four; some (e.g. JSX-only patterns) restrict. */
export type Language = "pts" | "ptsx" | "pjs" | "pjsx";

/** Map from capture group index (1-indexed, as TextMate expects) to
 *  the TextMate scope name that group should receive. */
export type CaptureScopes = Record<string, string>;

export interface LanguageEntry {
  /** Stable identifier — used as the catalog key, never user-visible. */
  id: string;
  /** One-line description, used as the grammar pattern's `comment` and
   *  in any generated docs. Plain prose; not parsed. */
  doc: string;
  /** Classification. */
  kind: EntryKind;
  /** Source extensions this pattern fires in. Defaults to all four if
   *  not specified. */
  languages?: Language[];
  /** The match regex (raw — no JSON-escape wrapping needed since this
   *  is a TS file). Use String.raw`...` to avoid backslash duplication. */
  pattern: string;
  /** Scope assignments per capture group. If the regex has captures
   *  but `scopes` is empty, the whole match takes `name`. */
  scopes?: CaptureScopes;
  /** Optional single-scope fallback when the pattern has no captures —
   *  e.g. operator entries that just need one scope on the whole match. */
  name?: string;
  /** True when the LSP's fast-pass "Cannot find name" check should
   *  treat the keyword token as a known identifier. Applies to entries
   *  whose `kind` is `keyword` / `constructor` / `constant` and which
   *  appear at expression position — `_`, `Ok`, `Err`, etc. Operators
   *  and types are never "names" in the unknown-ident sense. */
  lspAllowlist?: boolean;
  /** Optional pointer to the canonical test file pinning runtime
   *  behavior — listed in generated docs so readers can jump to a
   *  concrete example. Multiple tests may anchor one entry. */
  tests?: string[];
  /** Optional snippet body. If present, codegen also emits a VS Code
   *  snippet entry. */
  snippet?: string;
  /** Whether this entry contributes to the inject grammar (`injectTo`
   *  source.pts/ptsx/pjs/pjsx) or only to the main per-extension
   *  grammars. Defaults true — most patterns inject. The few that
   *  don't (operator-rich main-grammar patterns like the decimal
   *  literal) opt out. */
  inject?: boolean;
}

/** The Para language surface, in the order patterns should appear in
 *  the inject grammar. ORDER MATTERS for TextMate: the engine tries
 *  patterns top-to-bottom and stops at first match. More-specific
 *  patterns (e.g. `pure async fun`) must precede less-specific ones
 *  (`pure` alone). Within each section, ordering is by specificity. */
export const LANGUAGE_SURFACE: LanguageEntry[] = [
  // ─── `fun` shorthand for `function` ────────────────────────────────
  {
    id: "fun-decl",
    doc: "fun NAME(...) — shorthand alias for function declarations / expressions",
    kind: "keyword",
    pattern: String.raw`\b(fun)\b(?=\s*[a-zA-Z_$*(<])`,
    scopes: { "1": "storage.type.function.parabun" },
  },

  // ─── `pure` modifier and its async-/fun-prefixed combos ────────────
  // Compound forms (pure async fun, pure fun, etc.) come BEFORE bare
  // `pure` so they capture both keywords together rather than letting
  // `pure` alone match and leaving `async fun` unannotated.
  {
    id: "export-pure-async-fun",
    doc: "export pure async fun/function declaration",
    kind: "keyword",
    pattern: String.raw`\b(export)\s+(pure)\s+(async)\s+(fun(?:ction)?)\b`,
    scopes: {
      "1": "keyword.control.export",
      "2": "keyword.other.pure.parabun",
      "3": "storage.modifier.async",
      "4": "storage.type.function.parabun",
    },
  },
  {
    id: "export-pure-fun",
    doc: "export pure fun/function declaration",
    kind: "keyword",
    pattern: String.raw`\b(export)\s+(pure)\s+(fun(?:ction)?)\b`,
    scopes: {
      "1": "keyword.control.export",
      "2": "keyword.other.pure.parabun",
      "3": "storage.type.function.parabun",
    },
  },
  {
    id: "pure-async-fun",
    doc: "pure async fun/function declaration or expression",
    kind: "keyword",
    pattern: String.raw`\b(pure)\s+(async)\s+(fun(?:ction)?)\b`,
    scopes: {
      "1": "keyword.other.pure.parabun",
      "2": "storage.modifier.async",
      "3": "storage.type.function.parabun",
    },
  },
  {
    id: "pure-fun",
    doc: "pure fun/function declaration or expression",
    kind: "keyword",
    pattern: String.raw`\b(pure)\s+(fun(?:ction)?)\b`,
    scopes: {
      "1": "keyword.other.pure.parabun",
      "2": "storage.type.function.parabun",
    },
  },
  {
    id: "pure-async-arrow",
    doc: "pure async arrow — pure async (x) => ... / pure async x => ...",
    kind: "keyword",
    pattern: String.raw`\b(pure)\s+(async)\b(?=\s*(?:\(|\w+\s*=>))`,
    scopes: {
      "1": "keyword.other.pure.parabun",
      "2": "storage.modifier.async",
    },
  },
  {
    id: "pure-arrow",
    doc: "pure arrow — pure (x) => ... / pure x => ...",
    kind: "keyword",
    pattern: String.raw`\b(pure)\b(?=\s*(?:\(|\w+\s*=>))`,
    scopes: { "1": "keyword.other.pure.parabun" },
  },

  // ─── Signals / reactivity ──────────────────────────────────────────
  {
    id: "signal-decl",
    doc: "signal NAME = ... — reactive cell declaration",
    kind: "keyword",
    pattern: String.raw`\b(signal)\b(?=\s+[A-Za-z_$][\w$]*\s*[=,;:!])`,
    scopes: { "1": "storage.type.signal.parabun" },
    lspAllowlist: true,
  },
  {
    id: "source-decl",
    doc: "source NAME = ... — native-handle reactive view, auto-disposed on unmount (.pui)",
    kind: "keyword",
    pattern: String.raw`\b(source)\b(?=\s+[A-Za-z_$][\w$]*\s*[=:])`,
    scopes: { "1": "storage.type.source.parabun" },
    lspAllowlist: true,
  },
  {
    id: "every-postfix",
    doc: "`every MS_EXPR` postfix on a signal declaration — drives the cell from an interval",
    kind: "keyword",
    // Approximate match: `every` preceded by a paren / digit / identifier
    // char (so the keyword reads as a postfix on an expression). Avoids
    // false-positives on identifiers happening to start with "every".
    pattern: String.raw`(?<=[\)\d\w$])\s+(every)\s+(?=\d|[A-Za-z_$\(])`,
    scopes: { "1": "keyword.control.every.parabun" },
    lspAllowlist: true,
  },
  {
    id: "derived-decl",
    doc: "derived NAME = EXPR or derived NAME { … } — read-only computed cell ($derived / $derived.by)",
    kind: "keyword",
    pattern: String.raw`\b(derived)\b(?=\s+[A-Za-z_$][\w$]*\s*[=,;:!{])`,
    scopes: { "1": "storage.type.derived.parabun" },
    lspAllowlist: true,
  },
  {
    id: "effect",
    doc: "effect { ... } block, or effect EXPR; single-statement — signals.effect() / $effect",
    kind: "keyword",
    // Block form (`effect {`) OR single-statement form (`effect <ident>…`).
    // Same disambiguation as the parser: `effect(` `effect.` `effect[`
    // `effect=` `effect:` `effect;` stay the plain identifier (the
    // lookahead requires `{` or whitespace+identifier-start).
    pattern: String.raw`\b(effect)\b(?=\s*\{|\s+[A-Za-z_$])`,
    scopes: { "1": "keyword.control.effect.parabun" },
    lspAllowlist: true,
  },

  // ─── `when` edge-triggered handlers ────────────────────────────────
  {
    id: "when-not",
    doc: "when not EXPR { ... } — fires on the negated edge",
    kind: "keyword",
    pattern: String.raw`\b(when)\s+(not)\b`,
    scopes: {
      "1": "keyword.control.when.parabun",
      "2": "keyword.control.when.not.parabun",
    },
    lspAllowlist: true,
  },
  {
    id: "when-expr",
    doc: "when EXPR { ... } — fires on the rising edge",
    kind: "keyword",
    pattern: String.raw`\b(when)\b(?=\s+[!A-Za-z_$])`,
    scopes: { "1": "keyword.control.when.parabun" },
  },
  {
    id: "when-start",
    doc: "trailing `start` modifier — initial-truthy + edge",
    kind: "keyword",
    pattern: String.raw`\b(start)\b(?=\s*\{)`,
    scopes: { "1": "keyword.control.when.start.parabun" },
  },
  {
    id: "when-stop",
    doc: "paired `when stop { }` arm — fires on falling edge of preceding when",
    kind: "keyword",
    pattern: String.raw`\b(when)\s+(stop)\b(?=\s*\{)`,
    scopes: {
      "1": "keyword.control.when.parabun",
      "2": "keyword.control.when.stop.parabun",
    },
  },

  // ─── `arena` / `memo` / `defer` ────────────────────────────────────
  {
    id: "arena-block",
    doc: "arena { ... } — DeferGC scope",
    kind: "keyword",
    pattern: String.raw`\b(arena)\b(?=\s*\{)`,
    scopes: { "1": "keyword.control.arena.parabun" },
    lspAllowlist: true,
  },
  {
    id: "memo-async-stmt",
    doc: "memo async NAME( — statement-form async memoized fn",
    kind: "keyword",
    pattern: String.raw`\b(memo)\s+(async)\s+(?=[A-Za-z_$][\w$]*\s*(?:<|\())`,
    scopes: {
      "1": "keyword.other.memo.parabun",
      "2": "storage.modifier.async",
    },
  },
  {
    id: "memo-stmt",
    doc: "memo NAME( — statement-form memoized fn (sync)",
    kind: "keyword",
    pattern: String.raw`\b(memo)\s+(?!async\b)(?=[A-Za-z_$][\w$]*\s*(?:<|\())`,
    scopes: { "1": "keyword.other.memo.parabun" },
  },
  {
    id: "memo-async-arrow",
    doc: "memo async (...) / memo async NAME => — async arrow form",
    kind: "keyword",
    pattern: String.raw`\b(memo)\s+(async)\s+(?=\(|[A-Za-z_$][\w$]*\s*=>)`,
    scopes: {
      "1": "keyword.other.memo.parabun",
      "2": "storage.modifier.async",
    },
  },
  {
    id: "memo-arrow",
    doc: "memo (...) / memo <T>(...) / memo NAME => — sync arrow form",
    kind: "keyword",
    pattern: String.raw`\b(memo)\s+(?=\(|<[\w\s,=]+>\s*\(|[A-Za-z_$][\w$]*\s*=>)`,
    scopes: { "1": "keyword.other.memo.parabun" },
  },
  {
    id: "defer-stmt",
    doc: "defer EXPR / defer await EXPR — block-exit hook (LIFO)",
    kind: "keyword",
    pattern: String.raw`\b(defer)\b(?=\s+[A-Za-z_$])`,
    scopes: { "1": "keyword.control.defer.parabun" },
    lspAllowlist: true,
  },

  // ─── Reactive-binding / call-binding arrows ────────────────────────
  {
    id: "rbind-op",
    doc: "~> reactive-binding operator — `src ~> dst` wraps in signals.effect(() => { dst = src })",
    kind: "operator",
    pattern: String.raw`~>`,
    name: "keyword.operator.rbind.parabun",
  },
  {
    id: "callbind-op",
    doc: "-> reactive call-binding operator (negative lookbehind guards against `-->` / `=>` / `<-`)",
    kind: "operator",
    pattern: String.raw`(?<![\-=<])->`,
    name: "keyword.operator.callbind.parabun",
  },

  // ─── `schema` (the single shape primitive — 6 declaration forms) ───
  {
    id: "export-schema-from",
    doc: "export schema NAME from <expr> — exported JSON Schema ingestion",
    kind: "keyword",
    pattern: String.raw`\b(export)\s+(schema)\s+([A-Za-z_$][\w$]*)\s+(from)\b`,
    scopes: {
      "1": "keyword.control.export.ts",
      "2": "storage.type.schema.parabun",
      "3": "entity.name.type.schema.parabun",
      "4": "keyword.control.from.parabun",
    },
  },
  {
    id: "schema-from",
    doc: "schema NAME from <expr> — ingest existing JSON Schema (file / fetch / inline literal)",
    kind: "keyword",
    pattern: String.raw`\b(schema)\s+([A-Za-z_$][\w$]*)\s+(from)\b`,
    scopes: {
      "1": "storage.type.schema.parabun",
      "2": "entity.name.type.schema.parabun",
      "3": "keyword.control.from.parabun",
    },
  },
  {
    id: "export-schema-decl",
    doc: "export schema NAME { ... } / NAME = ... — exported declaration",
    kind: "keyword",
    pattern: String.raw`\b(export)\s+(schema)\s+([A-Za-z_$][\w$]*)\b`,
    scopes: {
      "1": "keyword.control.export.ts",
      "2": "storage.type.schema.parabun",
      "3": "entity.name.type.schema.parabun",
    },
  },
  {
    id: "schema-decl",
    doc: "schema NAME { ... } / NAME = ... / NAME from ... — declaration",
    kind: "keyword",
    pattern: String.raw`\b(schema)\s+([A-Za-z_$][\w$]*)\b`,
    scopes: {
      "1": "storage.type.schema.parabun",
      "2": "entity.name.type.schema.parabun",
    },
  },
  {
    id: "schema-inline",
    doc: "schema { ... } — inline expression literal (no name binding)",
    kind: "keyword",
    pattern: String.raw`\b(schema)\b(?=\s*\{)`,
    scopes: { "1": "storage.type.schema.parabun" },
  },
  {
    id: "schema-bare",
    doc: "Bare `schema` keyword fallback — highlights as soon as typed; skipped when followed by =/(/. (used as identifier)",
    kind: "keyword",
    pattern: String.raw`\b(schema)\b(?![\s]*[=.(])`,
    scopes: { "1": "storage.type.schema.parabun" },
    lspAllowlist: true,
  },

  // ─── `match` ───────────────────────────────────────────────────────
  {
    id: "match-expr",
    doc: "match EXPR { ... } — pattern matching expression",
    kind: "keyword",
    pattern: String.raw`\b(match)\b(?=\s+[A-Za-z_$(])`,
    scopes: { "1": "keyword.control.match.parabun" },
    lspAllowlist: true,
  },

  // ─── `::` validation marker ────────────────────────────────────────
  {
    id: "validate-marker",
    doc: ":: per-arg runtime validation marker — `fn(req:: User) {...}` injects User.parse(req) at entry",
    kind: "operator",
    pattern: String.raw`::`,
    name: "keyword.operator.validate.parabun",
  },

  // ─── Result/Option constructors ────────────────────────────────────
  {
    id: "result-option-ctor",
    doc: "Ok / Err / Some — Result/Option tagged-union constructors (in call position)",
    kind: "constructor",
    pattern: String.raw`\b(Ok|Err|Some)\b(?=\s*\()`,
    scopes: { "1": "support.function.constructor.result.parabun" },
    lspAllowlist: true,
  },
  {
    id: "none-const",
    doc: "None — bare Option constant",
    kind: "constant",
    pattern: String.raw`\b(None)\b(?!\s*[\.\[\(])`,
    scopes: { "1": "constant.language.option.none.parabun" },
    lspAllowlist: true,
  },

  // ─── Refinement / primitive types in schema-body field positions ───
  {
    id: "refinement-types",
    doc: "Capitalized refinement / format types — Email / UUID / Url / Date / DateTime / IpV4 / IpV6 / Slug",
    kind: "refinement-type",
    pattern: String.raw`(:|::)(\s+)(Email|UUID|Url|Date|DateTime|IpV4|IpV6|Slug)\b`,
    scopes: {
      "1": "punctuation.separator.key-value.ts",
      "3": "support.type.ts",
    },
  },
  {
    id: "primitive-types",
    doc: "Lowercase primitive types — int / str / string / bool / boolean / float / num / number (in `: Type` position)",
    kind: "primitive-type",
    pattern: String.raw`(:)(\s+)(int|str|string|bool|boolean|float|num|number)\b`,
    scopes: {
      "1": "punctuation.separator.key-value.ts",
      "3": "support.type.primitive.ts",
    },
  },

  // ─── `is` / `is not` type-guard ─────────────────────────────────────
  {
    id: "is-not-guard",
    doc: '`expr is not Type` — runtime negated type-guard, lowers to Type.parse(expr).tag !== "Ok"',
    kind: "operator",
    pattern: String.raw`\b(is)\s+(not)\b(?=\s+[A-Z])`,
    scopes: {
      "1": "keyword.operator.is.parabun",
      "2": "keyword.operator.is.parabun",
    },
  },
  {
    id: "is-guard",
    doc: '`expr is Type` — runtime type-guard, lowers to Type.parse(expr).tag === "Ok"',
    kind: "operator",
    pattern: String.raw`\b(is)\b(?=\s+[A-Z])`,
    scopes: { "1": "keyword.operator.is.parabun" },
  },

  // ─── `parallel` / `para` fan-out blocks ────────────────────────────
  {
    id: "parallel-decl",
    doc: "parallel/para let|const NAME = ..., ... — fan-out promise composition (statement form)",
    kind: "keyword",
    pattern: String.raw`\b(parallel|para)\s+(let|const)\b`,
    scopes: {
      "1": "storage.modifier.parallel.parabun",
      "2": "storage.type.ts",
    },
    lspAllowlist: true,
  },
  {
    id: "parallel-block",
    doc: "parallel/para { ... } — fan-out promise composition (expression form)",
    kind: "keyword",
    pattern: String.raw`\b(parallel|para)\b(?=\s*\{)`,
    scopes: { "1": "storage.modifier.parallel.parabun" },
  },

  // ─── Range / chain / pipe operators ────────────────────────────────
  // Order: more-specific operator glyphs (..= ..! ..& ..>) must precede
  // the bare `..` range operator, otherwise the engine matches `..`
  // first and never sees the trailing `= ! & >`.
  {
    id: "range-inclusive-op",
    doc: "..= inclusive range — `a..=b` lowers to iterator over [a, b]",
    kind: "operator",
    pattern: String.raw`\.\.=`,
    name: "keyword.operator.range-inclusive.parabun",
  },
  {
    id: "catch-op",
    doc: "..! error-chain operator — `p ..! handler` lowers to `p.catch(handler)`",
    kind: "operator",
    pattern: String.raw`\.\.!`,
    name: "keyword.operator.catch.parabun",
  },
  {
    id: "finally-op",
    doc: "..& finally operator — `p ..& cleanup` lowers to `p.finally(cleanup)`",
    kind: "operator",
    pattern: String.raw`\.\.&`,
    name: "keyword.operator.finally.parabun",
  },
  {
    id: "then-op",
    doc: "..> then operator — `p ..> next` lowers to `p.then(next)`",
    kind: "operator",
    pattern: String.raw`\.\.>`,
    name: "keyword.operator.then.parabun",
  },
  {
    id: "range-op",
    doc: ".. exclusive range — `a..b` lowers to iterator over [a, b)",
    kind: "operator",
    pattern: String.raw`\.\.(?!\.)`,
    name: "keyword.operator.range.parabun",
  },
  {
    id: "pipeline-op",
    doc: "|> pipeline operator — threads LHS as first arg of RHS call",
    kind: "operator",
    pattern: String.raw`\|>`,
    name: "keyword.operator.pipeline.parabun",
  },

  // ─── Decimal literal (Nd suffix) ───────────────────────────────────
  {
    id: "decimal-literal",
    doc: "Nd decimal literal — `0.0825d` / `42d` route arithmetic through .add / .mul methods (exact, no FP drift)",
    kind: "operator",
    pattern: String.raw`(?<![\w$.])((?:\.\d+|\d+(?:\.\d*)?)(?:[eE][+-]?\d+)?)(d)(?![\w$])`,
    scopes: {
      "1": "constant.numeric.decimal.parabun",
      "2": "keyword.other.decimal-suffix.parabun",
    },
  },

  // ─── `_` expression-context lambda placeholder (LYK-827) ────────────
  // Not highlighted as a special token (looks like a normal identifier
  // in code), but the LSP allowlist needs to know `_` is acceptable so
  // expression-context uses don't trigger "Cannot find name". The Zig
  // parser wraps `arr.filter(_ > 0)` into `arr.filter((__pu) => __pu > 0)`
  // at parse time; this entry's `lspAllowlist: true` keeps the fast-pass
  // diagnostic from firing on the source-level `_` reference.
  {
    id: "underscore-lambda",
    doc: "`_` expression-context lambda placeholder — wraps the arg in (__pu => …) at parse time",
    kind: "keyword",
    pattern: String.raw`(?!)`, // matches nothing — no syntactic highlight, only LSP allowlist contribution
    lspAllowlist: true,
    inject: false,
  },
];

/** Codegen helpers consume this default. Splash highlighter / VS Code
 *  TextMate / Shiki on the site all accept the inject grammar via
 *  injectTo; the four base language scopes are listed here once. */
export const DEFAULT_LANGUAGES: Language[] = ["pts", "ptsx", "pjs", "pjsx"];

/** Para-specific keywords the splash demo's tiny inline highlighter
 *  (`/raid/para-site/public/transpile.js`) bolds on the .pts side.
 *  That highlighter is regex-based, not TextMate — it just does naive
 *  alternation, so it needs literal keyword names, not the lookahead-
 *  aware patterns the grammar generators consume. Constructors / type
 *  names / operators aren't here; the splash highlighter handles them
 *  via the `op` / `builtin` / `num` passes or not at all. */
export const SPLASH_PARA_KEYWORDS: string[] = [
  "pure",
  "fun",
  "signal",
  "derived",
  "effect",
  "source",
  "when",
  "arena",
  "memo",
  "defer",
  "match",
  "schema",
  "parallel",
  "para",
  "is",
  "every",
];

/** Plain-JS reserved words the splash highlights on BOTH sides of the
 *  demo (since they appear in both Para source and the desugared JS
 *  output). Kept here so the codegen can rebuild the JS-only regex
 *  too — otherwise the JS pane's keyword list drifts the same way
 *  the Para one used to. */
export const SPLASH_JS_KEYWORDS: string[] = [
  "const",
  "let",
  "var",
  "function",
  "return",
  "await",
  "async",
  "new",
  "class",
  "if",
  "else",
  "true",
  "false",
  "null",
  // Module / import keywords — appear in Runtime tab demos (every
  // parabun:* snippet starts with `import X from "parabun:..."`) and
  // in the .js output pane for pipeline-style Lang demos that emit
  // `import { ... } from "@para/pipeline"`.
  "import",
  "from",
  "export",
  "default",
  "as",
  // Flow keywords visible in the .js output panes (match lowers to
  // switch/case, throw appears in match-fallback hand-waves).
  "switch",
  "case",
  "throw",
  "for",
  "of",
];

/** Entries marked `lspAllowlist: true` — convenience accessor for the
 *  LSP codegen. Returns the literal token text from the pattern's
 *  most-specific capture group, OR the entry's id when the pattern is
 *  a meta-entry (like the underscore placeholder) with no surface
 *  token. The LSP codegen reads its tokens from a hand-maintained
 *  array in catalog format — falling back to id-as-name keeps the
 *  meta-entry case sane. */
export const LSP_ALLOWLIST_TOKENS: string[] = [
  // Tokens are listed explicitly (rather than parsed from the regex)
  // because the regex captures can include alternations like
  // `Ok|Err|Some`, ranges, etc. — easier to maintain a literal list
  // here than parse alternation groups out of the patterns.
  "_",
  "signal",
  "derived",
  "effect",
  "source",
  "when",
  "arena",
  "memo",
  "defer",
  "schema",
  "match",
  "pure",
  "Ok",
  "Err",
  "Some",
  "None",
  "para",
  "parallel",
];
