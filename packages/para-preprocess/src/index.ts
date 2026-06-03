import type { PreprocessorGroup, Processed } from "svelte/compiler";
import { lowerParaScript, lowerParaMarkup } from "./browser-lower/index.js";

// Canonical Para browser-lowering, exported so other tools (in-browser compilers,
// playgrounds) can reuse the exact same passes parabunPreprocess runs.
export { lowerParaScript, lowerParaMarkup } from "./browser-lower/index.js";

export type ParabunPreprocessOptions = {
  /**
   * Which `<script lang="...">` values should be treated as Parabun.
   * Defaults to ["parabun", "pts", "pjs"].
   */
  langs?: string[];
  /**
   * Also transform plain `<script>` blocks (no `lang`) and `<script lang="ts">`.
   * Useful if you want every script to go through the Parabun transpiler so
   * files can freely use Parabun operators without annotating each block.
   */
  all?: boolean;
  /**
   * Which runtime to emit injected imports against (`setContext`,
   * `getContext`, `onDestroy`, etc. — used by `provide`/`inject`/`using`
   * keyword lowering).
   *
   * - `"@lyku/para-ui"` (default): targets the Para UI fork
   *   (packages/para-svelte/packages/svelte). Para signals run at the
   *   reactive core; `signalOf()` is available. Consumers must have
   *   `@lyku/para-ui` resolvable (currently workspace-only — see
   *   PARA-FORK.md).
   * - `"svelte"`: targets unmodified Svelte from npm. The escape hatch
   *   for projects that haven't wired the fork yet. The lowering still
   *   uses `$state`/`$derived`/`$effect`; the only difference is the
   *   import specifier.
   */
  runtime?: "@lyku/para-ui" | "svelte";
  /**
   * Emit the dev/HMR `signal` bridge form: each `signal x = …` becomes
   * `import.meta.hot ? hmrSignal("<module>::x", () => signal(…)) :
   * signal(…)`. On a vite HMR module re-eval the registry returns the
   * SAME signal instance, so its current value + subscribers survive the
   * reload (component state doesn't reset on save). No-op in prod
   * (import.meta.hot is undefined → plain signal()). Off by default; the
   * editor/LSP path leaves it off so the type-relevant lowering stays
   * byte-identical (pui-transform parity).
   */
  hmr?: boolean;
};

const DEFAULT_LANGS = ["parabun", "pts", "pjs"];

function pickLoader(lang: string | undefined): "ts" | "tsx" | "jsx" {
  switch (lang) {
    case "pts":
    case "parabun":
    case "ts":
    case undefined:
      return "ts";
    case "ptsx":
    case "tsx":
      return "tsx";
    case "pjs":
    case "pjsx":
    case "jsx":
      return "jsx";
    default:
      return "ts";
  }
}

// The preprocessor runs in two very different environments:
//   - Build time: SvelteKit + Vite under `parabun`, where `Bun.Transpiler`
//     is available and we transpile parabun → standard TS.
//   - Editor time: `svelte-language-server` / `svelte-check` under Node,
//     where `Bun` is undefined. Calling `new Bun.Transpiler(...)` there
//     throws `ReferenceError: Bun is not defined`, which Svelte surfaces
//     as a diagnostic on the offending line, and the downstream TS service
//     then treats the script as JS (emitting TS8010 on every type
//     annotation).
//
// When Bun isn't available we relabel the block as `lang="ts"` and pass
// the original content through unchanged. The Svelte LSP type-checks it
// as TS, which works for any parabun script that's a syntactic TS subset;
// parabun-specific syntax (`..!`, `|>`, `pure`, etc.) is left to the
// parabun LSP, which runs in parallel via its own VSCode extension.
const HAS_BUN_TRANSPILER = typeof (globalThis as { Bun?: { Transpiler?: unknown } }).Bun?.Transpiler === "function";

// Node-fallback TS stripper. The build runs the svelte preprocess under Node
// (vite plugins load under Node; under `--bun` sass breaks), so `Bun.Transpiler`
// is absent — and `vitePreprocess` does NOT process `.pui`, so without stripping
// here the svelte compiler receives raw TS and fails on `$state<A | B>()` etc.
// esbuild (present in any vite toolchain) does the TS→JS pass. This is ONLY the
// type-strip; the Para lowering (lowerParaScript / lowerPuiReactivity) above is
// untouched, so the LSP projection (editors/lsp pui-transform) stays byte-
// identical — parity preserved. Gated to vite contexts (NODE_ENV set by vite) so
// `svelte-check`/language-server still receive TS (full editor type-checking).
let _esbuildTransform: ((src: string, loader: "ts" | "tsx" | "jsx") => string) | null | undefined;
function nodeStripTypes(src: string, loader: "ts" | "tsx" | "jsx"): string | null {
  if (_esbuildTransform === undefined) {
    try {
      // Acquire `createRequire` via `process.getBuiltinModule("module")` rather
      // than a static `import … from "node:module"`. A static import would force
      // node:module into ANY browser bundle that imports this module — the
      // in-browser compiler (Parascape demos/live-compile.ts) imports
      // `parabunPreprocess` — and Vite externalises node:module to a stub with no
      // `createRequire` export, which fails to link the client build.
      // `getBuiltinModule` is a plain runtime call with no static specifier, so
      // bundlers leave it alone (Node 22+/Bun). In the browser `process` is absent
      // (or lacks getBuiltinModule) → this throws → caught below → `_esbuildTransform`
      // is nulled and the caller falls back to the un-stripped source. This whole
      // path is Node/build-time only; the browser never reaches a successful run.
      const nodeModule = (
        globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }
      ).process?.getBuiltinModule?.("module") as
        | { createRequire?: (url: string) => (id: string) => unknown }
        | undefined;
      const require = nodeModule?.createRequire?.(import.meta.url);
      if (!require) throw new Error("node:module is unavailable in this environment");
      const esbuild = require("esbuild") as {
        transformSync: (s: string, o: Record<string, unknown>) => { code: string };
      };
      _esbuildTransform = (s, l) =>
        esbuild.transformSync(s, {
          loader: l,
          format: "esm",
          target: "esnext",
          // CRITICAL: preserve value imports. Without this esbuild drops imports
          // it thinks are unused — but Svelte uses imports in the MARKUP (`<Foo/>`)
          // and via store auto-subscription (`$store`), which esbuild can't see in
          // the script alone, so dropping them breaks the component (`$store is an
          // illegal variable name`, missing components). `preserveValueImports`
          // keeps them (mirroring Bun.Transpiler) without `verbatimModuleSyntax`'s
          // hard error on un-annotated type imports.
          // This exact pair is what svelte's own `vitePreprocess` passes esbuild
          // for `.svelte` (see @sveltejs/vite-plugin-svelte preprocess.js) —
          // neither alone is right (preserveValueImports alone errors;
          // importsNotUsedAsValues alone collapses named imports to side-effect
          // imports). Together they keep imports intact while stripping types.
          tsconfigRaw: {
            compilerOptions: {
              importsNotUsedAsValues: "preserve",
              preserveValueImports: true,
            },
          },
        }).code;
    } catch {
      _esbuildTransform = null;
    }
  }
  if (!_esbuildTransform) return null;
  try {
    return _esbuildTransform(src, loader);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// `.pui`-specific lowerings for the para reactive keywords. These keywords
// have their own meaning in para's core language, but inside a `.pui`
// component they need to bridge to Svelte's reactivity so the template
// re-renders. Each lowering produces standard TS so the downstream Svelte
// compiler sees something it understands.
//
// `signal X = Y` →
//     const __sig_X = signal(Y);
//     let X = $state(__sig_X.peek());
//     $effect.pre(() => { X = __sig_X.get(); });
//
// `X = Z` (where X is a known signal) → `__sig_X.set(Z);`
//
// v1 is regex-based; handles simple single-line declarations and
// assignments. Multi-declarator forms (`signal a = 1, b = 2`) and
// destructured assignments are explicit follow-up.
// ---------------------------------------------------------------------------

// Brace-aware scan: given the offset of an opening `{`, return the offset
// just AFTER its matching `}`. Skips braces inside strings, templates, and
// line/block comments. Returns -1 if unmatched.
// True iff `body` contains an `await` keyword at bracket-depth 0 (i.e.
// the body's own top level, not inside a nested fn/arrow/call).
// Skips strings, template literals, and comments so an `await` inside
// one of those doesn't force an async arrow. Conservative-correct: a
// false negative just keeps a sync arrow (and a genuine top-level await
// would then be a compile error the author sees immediately); a false
// positive (async when sync would do) only matters if the body returns
// a cleanup — and a body with a real top-level await can't, by JS +
// Svelte semantics.
export function hasTopLevelAwait(body: string): boolean {
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "/" && body[i + 1] === "/") {
      i = body.indexOf("\n", i);
      if (i === -1) break;
      continue;
    }
    if (c === "/" && body[i + 1] === "*") {
      const e = body.indexOf("*/", i + 2);
      i = e === -1 ? body.length : e + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < body.length && body[i] !== c) {
        if (body[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (
      depth === 0 &&
      c === "a" &&
      body.slice(i, i + 5) === "await" &&
      !/[\w$]/.test(body[i - 1] ?? "") &&
      !/[\w$]/.test(body[i + 5] ?? "")
    ) {
      return true;
    }
  }
  return false;
}

// LYK-909 — depth-aware declarator-list utilities, shared with
// editors/lsp pui-transform.ts (imported, not re-implemented — same
// structural-parity discipline as buildEscapeChecker/hasTopLevelAwait).
//
// Tracks `()[]{}` + strings + line-comments, plus generic `<…>` (so a
// comma inside `Record<string, number>` isn't a declarator separator).
// `()[]{}` already protect fn-type params / object / array defaults, so
// `<>` is only needed for generic type args. `=>` and the compound ops
// (`<=`/`>=`/`<<`/`>>`) are guarded. Documented residual: a *bare,
// unparenthesized* comparison (`a<b`) in a multi-declarator default is
// unsupported — parenthesize it. Realistic declarator syntax is covered.
function declScan(s: string, isHit: (i: number, prev: string, next: string) => boolean): number[] {
  const hits: number[] = [];
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < s.length && s[i] !== c) {
        if (s[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "/" && s[i + 1] === "/") {
      const nl = s.indexOf("\n", i);
      i = nl === -1 ? s.length : nl;
      continue;
    }
    const prev = s[i - 1] ?? "";
    const next = s[i + 1] ?? "";
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      continue;
    }
    if (c === "<" && /[\w$>\]]/.test(prev) && next !== "=" && prev !== "<") {
      depth++;
      continue;
    }
    // Close a generic whenever one is open. We only ever entered `<>`
    // depth via the ident-prefixed `<` rule, so a `>` at depth>0 is a
    // generic close — including each `>` of `Array<Map<…>>`. Guard only
    // `=>` (prev `=`) and `>=` (next `=`). Right-shift at generic depth
    // is unreachable in real type annotations (operands sit in `()`).
    if (c === ">" && prev !== "=" && next !== "=" && depth > 0) {
      depth--;
      continue;
    }
    if (depth === 0 && isHit(i, prev, next)) hits.push(i);
  }
  return hits;
}

/** Split a `prop`/`signal` declarator list on top-level commas. */
export function splitDeclarators(list: string): string[] {
  const cuts = declScan(list, i => list[i] === ",");
  const parts: string[] = [];
  let last = 0;
  for (const i of cuts) {
    parts.push(list.slice(last, i));
    last = i + 1;
  }
  parts.push(list.slice(last));
  return parts.map(p => p.trim()).filter(Boolean);
}

/**
 * Parse one declarator `NAME (: TYPE)? (= DEFAULT)?`. The type/default
 * boundary is the first *top-level* `=` that is a real assignment (not
 * `=>`, `==`, `===`, `<=`, `>=`, `!=`, `!==`, `+=` …).
 */
export function parseDeclarator(decl: string): { name: string; type?: string; default?: string } | null {
  const nm = decl.match(/^([A-Za-z_$][\w$]*)/);
  if (!nm) return null;
  const name = nm[1]!;
  let rest = decl.slice(name.length).trim();
  let type: string | undefined;
  let def: string | undefined;
  const eqs = declScan(rest, (i, prev, next) => {
    if (rest[i] !== "=") return false;
    if ("=<>!+-*/%&|^~".includes(prev)) return false; // compound op / != / <= …
    if (next === "=" || next === ">") return false; // ==, =>
    return true;
  });
  const eq = eqs.length ? eqs[0]! : -1;
  if (rest.startsWith(":")) {
    const typeRaw = (eq === -1 ? rest.slice(1) : rest.slice(1, eq)).trim();
    type = typeRaw || undefined;
    if (eq !== -1) def = rest.slice(eq + 1).trim();
  } else if (rest.startsWith("=") || eq !== -1) {
    def = (eq === -1 ? rest.replace(/^=/, "") : rest.slice(eq + 1)).trim();
  }
  return { name, type, default: def };
}

function findMatchingBrace(source: string, openOffset: number): number {
  let depth = 1;
  let i = openOffset + 1;
  while (i < source.length && depth > 0) {
    const ch = source[i]!;
    // Line comment
    if (ch === "/" && source[i + 1] === "/") {
      const eol = source.indexOf("\n", i);
      i = eol === -1 ? source.length : eol;
      continue;
    }
    // Block comment
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    // Strings (basic — doesn't handle template-literal `${}` nesting)
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return depth === 0 ? i : -1;
}

// Same-length copy with string / line- & block-comment spans blanked
// (newlines kept). So a `match` inside a string/comment can't trigger a
// spurious stub, and brace scanning ignores quoted braces.
function maskStringsAndComments(source: string): string {
  let masked = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      masked += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      masked += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < source.length) {
        const c = source[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === quote) {
          j++;
          break;
        }
        j++;
      }
      let blanked = quote;
      for (let k = i + 1; k < j - 1; k++) blanked += source[k] === "\n" ? "\n" : " ";
      blanked += source[j - 1] === quote ? quote : " ";
      masked += blanked;
      i = j;
      continue;
    }
    masked += ch;
    i++;
  }
  return masked;
}

/**
 * Locate every `match SUBJECT { … }` expression and return the span plus
 * the (verbatim) subject text. This is the SINGLE source for the `.pui`
 * LSP projection (pui-transform) and the legacy `transformParabunToTS`
 * non-`.pui` path — both lower `match` to a parse-safe, subject-typed
 * `any` stub (`((__pm: any): any => null as any)(SUBJECT)`), which is
 * the proven shape shipped for `.svelte`/`.pts` today. (Full per-arm
 * result narrowing is a separate enhancement, tracked on LYK-916 — it
 * would need a Zig-faithful, sourcemap-threaded lowering and is beyond
 * what any current parabun tooling does.)
 *
 * `match` as an identifier (`const match = 42`, `match.foo`) is left
 * alone: the regex requires `match` + whitespace + a non-`{` subject +
 * `{`. `end` is the offset just past the closing `}`.
 */
export function matchTypeStubSpans(source: string): Array<{ start: number; end: number; subject: string }> {
  const masked = maskStringsAndComments(source);
  const spans: Array<{ start: number; end: number; subject: string }> = [];
  const re = /\bmatch\s+([^{]+?)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const subjStart = m.index + "match".length;
    const subjEnd = m.index + m[0].length - 1;
    // `match` is a variable binding/assignment, not the keyword (mirror of the
    // guard in lower-match.ts): a real match subject never starts with `=`, and
    // the keyword form never follows a binding keyword. Otherwise the `[^{]+?`
    // subject runs forward to an unrelated `{` (e.g. a later `$effect(() => {`)
    // and stubs the wrong span — corrupting `let match = $state<…>(…)`.
    const subjMasked = masked.slice(subjStart, subjEnd).replace(/^\s+/, "");
    if (
      subjMasked.startsWith("=") ||
      /\b(?:let|const|var)\s+$/.test(masked.slice(Math.max(0, m.index - 7), m.index))
    ) {
      re.lastIndex = subjStart;
      continue;
    }
    const openIdx = m.index + m[0].length - 1;
    const closeAfter = findMatchingBrace(masked, openIdx); // index past `}`
    if (closeAfter < 0) continue;
    spans.push({ start: m.index, end: closeAfter, subject: source.slice(subjStart, subjEnd).trim() });
    re.lastIndex = closeAfter;
  }
  return spans;
}

// `effect EXPR;` → `$effect(() => EXPR)` — an EXPRESSION-bodied arrow,
// NOT a block. Preserves the implicit return so an effect whose
// expression yields a teardown (`effect useKeybind(...)`) registers it
// as the effect's cleanup, exactly like `$effect(() => EXPR)`. Mirrors
// the `derived NAME = EXPR` → `$derived(EXPR)` precedent; the block form
// `effect { … }` stays statement-bodied (explicit `return cleanup`).
// Disambiguation matches the parser: `effect` is the keyword only at
// statement position, same line, followed by an identifier — `effect(`
// `effect.` `effect[` `effect=` `effect;` and labels stay plain
// identifiers. The scanner (derivedInitEnd) MUST stay byte-identical to
// the copy in @lyku/para-transpile (blocks.ts); only the emitted
// wrapper differs (require(...).effect there).
function expandEffectSingle(src: string): string {
  const re = /(^|[;\n{}])([ \t]*)effect[ \t]+(?=[A-Za-z_$])/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const kwStart = m.index + m[1]!.length;
    const bodyStart = re.lastIndex;
    // Clamp to the enclosing `</script>`: derivedInitEnd is a JS-expression
    // scanner and is blind to the .pui/.svelte script boundary, so an
    // unterminated trailing `effect EXPR` (no `;`, last statement) would
    // otherwise read `<` of `</script>` as a less-than operator and
    // swallow the markup into the effect body — a real build break. The
    // LSP magic-string port already clamps (Math.min(..., bodyEnd)); this
    // brings canonical into line. Parity-gated by
    // editors/lsp/test/pui-lower-parity.smoke.ts.
    const close = src.indexOf("</script", bodyStart);
    const end = Math.min(derivedInitEnd(src, bodyStart), close === -1 ? src.length : close);
    const body = src.slice(bodyStart, end).trim();
    out += src.slice(last, kwStart);
    out += `${m[2]}$effect(() => ${body})`;
    last = src[end] === ";" ? end + 1 : end;
    re.lastIndex = last;
  }
  out += src.slice(last);
  return out;
}

function lowerEffectBlocks(source: string): string {
  // `effect { body }` → `$effect(() => { body })`. Brace-aware so nested
  // braces inside the body don't terminate early. The single-statement
  // form `effect STMT;` is normalized to the block form first.
  source = expandEffectSingle(source);
  let out = "";
  let i = 0;
  const re = /(^|[^\w$.])effect\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const kwStart = m.index + (m[1] ? m[1].length : 0);
    const braceStart = re.lastIndex - 1; // position of `{`
    const braceEnd = findMatchingBrace(source, braceStart);
    if (braceEnd === -1) continue;
    out += source.slice(i, kwStart);
    const body = source.slice(braceStart + 1, braceEnd - 1);
    out += `$effect(() => {${body}})`;
    i = braceEnd;
    re.lastIndex = braceEnd;
  }
  out += source.slice(i);
  return out;
}

// `mount` was retired as a keyword (2026-05-17): a Para keyword must map
// to a language *primitive* (signal→$state, derived→$derived,
// effect→$effect — runes), NOT rename an ordinary framework call
// (`mount`→`onMount(…)`). Lifecycle/navigation are plain Svelte/SvelteKit
// functions; `.pui` keeps them as plain calls and only removes the import
// boilerplate. Write `onMount(() => …)` / `afterNavigate(…)` directly —
// para-preprocess auto-injects the import from the right module when the
// call is used and not already imported (dedup handled by the injection
// passes). This is the closed, framework-defined set; it does NOT grow.
// Exported so the LSP projection (editors/lsp/pui-transform) auto-imports
// the SAME set the build path does — one source of truth, no build-vs-
// editor drift (a .pui using plain `onMount`/`afterNavigate` must not
// show a false `Cannot find name` in the editor while building fine).
export const PUI_RUNTIME_LIFECYCLE = ["onMount", "onDestroy"] as const; // from the runtime (svelte / @lyku/para-ui)
export const PUI_KIT_NAV = ["beforeNavigate", "afterNavigate", "onNavigate"] as const; // from $app/navigation

// True iff `name` appears as a call in `src` and isn't a member access
// (`.onMount`) or `$`-prefixed — the same lead guard the lowerings use.
export function usesIdentCall(src: string, name: string): boolean {
  return new RegExp(`(^|[^\\w$.])${name}\\s*\\(`).test(src);
}

function lowerDerivedBlocks(source: string): string {
  // LYK-892 (Phase C): `derived NAME { … }` → `const NAME =
  // $derived.by(() => { … })`. The block form for multi-statement
  // derivations (the chained filter/sort/group pattern that previously
  // forced a raw `$derived.by` fallback — the #1 mixed-dialect culprit
  // in real .pui per the migration research). Brace-aware, same shape as
  // lowerEffectBlocks; runs before the single-line
  // `derived NAME = EXPR` pass so each form is consumed by exactly one.
  let out = "";
  let i = 0;
  const re = /(^|[^\w$.])derived\s+(\w+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const kwStart = m.index + (m[1] ? m[1].length : 0);
    const name = m[2]!;
    const braceStart = re.lastIndex - 1; // position of `{`
    const braceEnd = findMatchingBrace(source, braceStart);
    if (braceEnd === -1) continue;
    out += source.slice(i, kwStart);
    const body = source.slice(braceStart + 1, braceEnd - 1);
    out += `const ${name} = $derived.by(() => {${body}})`;
    i = braceEnd;
    re.lastIndex = braceEnd;
  }
  out += source.slice(i);
  return out;
}

// End (exclusive) of a `derived NAME =` initializer expression. Mirrors
// the canonical Zig parser: a full JS expression that may span newlines
// (ternary / binary / member-chain wrap). Terminates at the depth-0 `;`,
// an ASI newline (expression complete AND next line not a continuation),
// a depth-0 `}` (enclosing block close), or EOF. Skips string / template
// / comment / regex spans so a `;` or newline inside one doesn't end it.
// MUST stay byte-identical to the copy in @lyku/para-transpile
// (blocks.ts) — the two are parity mirrors of the same parser. Exported
// so the LSP projection (editors/lsp/pui-transform) reuses this one
// extent scanner instead of re-deriving it (no build-vs-editor drift on
// multi-line `derived = …`).
export function derivedInitEnd(src: string, start: number): number {
  const contPrev = (c: string) => c !== "" && "+-*/%&|^<>=!~?:.,([{".includes(c);
  const contNext = (c: string) => c !== "" && "?:.,)]}+-*/%&|^<>=!([".includes(c);
  let i = start;
  let depth = 0;
  let lastSig = "";
  while (i < src.length) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length) {
        const d = src[i]!;
        if (d === "\\") {
          i += 2;
          continue;
        }
        if (q === "`" && d === "$" && src[i + 1] === "{") {
          let td = 1;
          i += 2;
          while (i < src.length && td > 0) {
            const e = src[i]!;
            if (e === "{") td++;
            else if (e === "}") td--;
            i++;
          }
          continue;
        }
        if (d === q) {
          i++;
          break;
        }
        i++;
      }
      lastSig = q;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "/" && (lastSig === "" || contPrev(lastSig))) {
      i++;
      while (i < src.length) {
        const d = src[i]!;
        if (d === "\\") {
          i += 2;
          continue;
        }
        if (d === "[") {
          i++;
          while (i < src.length && src[i] !== "]") {
            if (src[i] === "\\") i++;
            i++;
          }
          continue;
        }
        if (d === "/" || d === "\n") {
          if (d === "/") i++;
          break;
        }
        i++;
      }
      lastSig = "/";
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      lastSig = c;
      i++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
      lastSig = c;
      i++;
      continue;
    }
    if (depth === 0 && c === ";") break;
    if (depth === 0 && c === "\n") {
      let j = i + 1;
      while (j < src.length) {
        const e = src[j]!;
        if (e === " " || e === "\t" || e === "\r" || e === "\n") {
          j++;
          continue;
        }
        if (e === "/" && src[j + 1] === "/") {
          while (j < src.length && src[j] !== "\n") j++;
          continue;
        }
        if (e === "/" && src[j + 1] === "*") {
          j += 2;
          while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j++;
          j += 2;
          continue;
        }
        break;
      }
      if (contPrev(lastSig) || contNext(src[j] ?? "")) {
        i++;
        continue;
      }
      break;
    }
    if (c !== " " && c !== "\t" && c !== "\r" && c !== "\n") lastSig = c;
    i++;
  }
  return i;
}

function lowerDerivedDecls(source: string): string {
  // `derived NAME = EXPR` → `const NAME = $derived(EXPR)`. The
  // expression may span multiple lines (ternary / binary / member-chain
  // wrap) — its extent is found by derivedInitEnd, NOT a per-line regex
  // (that truncated multi-line initializers at the first newline). The
  // multi-statement block form `derived NAME { … }` is consumed first
  // by lowerDerivedBlocks. Prefix regex kept byte-identical to
  // @lyku/para-transpile's transformDerivedDecls (parity mirrors).
  const re = /(^|[;\n{}])(\s*)derived\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+?)?\s*=\s*/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const kwStart = m.index + m[1]!.length;
    const matchEnd = re.lastIndex;
    const name = m[3]!;
    const end = derivedInitEnd(source, matchEnd);
    const expr = source.slice(matchEnd, end).trim();
    // Consume a trailing `;` if present so it isn't duplicated (we emit
    // our own); a bare ASI newline leaves none and our `;` supplies it.
    const consumeEnd = source[end] === ";" ? end + 1 : end;
    out += source.slice(last, kwStart);
    out += `${m[2]}const ${name} = $derived(${expr});`;
    last = consumeEnd;
    re.lastIndex = consumeEnd;
  }
  out += source.slice(last);
  return out;
}

function lowerPropDecls(source: string): string {
  // `prop NAME: TYPE` / `prop NAME: TYPE = DEFAULT` declarations merge
  // into a single `let { ... }: { ... } = $props()` destructure, emitted
  // at the position of the first prop. Svelte 5 expects exactly one
  // $props() call per component, so collecting + merging is the only
  // shape the compiler accepts. Subsequent prop lines become blank to
  // preserve overall line numbering.
  // One `prop` statement may declare several comma-separated declarators
  // (`prop foo: string = '', bar = 3;`). The whole list still folds into
  // the single merged `$props()` destructure.
  const lines = source.split("\n");
  const declRe = /^(\s*)prop\s+(.+?)\s*;?\s*$/;
  const props: Array<{ lineIdx: number; indent: string; name: string; type: string; default?: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(declRe);
    if (!m) continue;
    const [, indent, list] = m;
    for (const decl of splitDeclarators(list!)) {
      const d = parseDeclarator(decl);
      if (!d) continue;
      props.push({
        lineIdx: i,
        indent: indent ?? "",
        name: d.name,
        type: (d.type ?? "any").trim(),
        default: d.default,
      });
    }
  }
  if (props.length === 0) return source;

  const destructParts = props.map(p => (p.default !== undefined ? `${p.name} = ${p.default}` : p.name));
  const typeParts = props.map(p => (p.default !== undefined ? `${p.name}?: ${p.type}` : `${p.name}: ${p.type}`));
  const merged = `let { ${destructParts.join(", ")} }: { ${typeParts.join("; ")} } = $props();`;

  const declLines = [...new Set(props.map(p => p.lineIdx))].sort((a, b) => a - b);
  const first = declLines[0]!;
  lines[first] = `${props[0]!.indent}${merged}`;
  for (const li of declLines) if (li !== first) lines[li] = "";
  return lines.join("\n");
}

function lowerProvideInject(source: string): { code: string; imports: Set<string> } {
  // `provide NAME = EXPR` → `setContext("NAME", EXPR)`
  // `inject NAME: TYPE` → `const NAME: TYPE = getContext("NAME")`
  // String-keyed for v1; workspace-scoped typed-key registry is a follow-up
  // (see LYK-848 description).
  const imports = new Set<string>();
  const provideRe = /^(\s*)provide\s+(\w+)(?:\s*:\s*[^=]+)?\s*=\s*(.+?)\s*;?\s*$/gm;
  let code = source.replace(provideRe, (_full, indent, name, expr) => {
    imports.add("setContext");
    return `${indent}setContext(${JSON.stringify(name)}, ${expr});`;
  });
  const injectRe = /^(\s*)inject\s+(\w+)\s*:\s*(.+?)\s*;?\s*$/gm;
  code = code.replace(injectRe, (_full, indent, name, type) => {
    imports.add("getContext");
    return `${indent}const ${name}: ${type.trim()} = getContext(${JSON.stringify(name)});`;
  });
  return { code, imports };
}

function lowerUsingDecls(source: string): { code: string; needsOnDestroy: boolean } {
  // `using NAME = EXPR` → `const NAME = EXPR; onDestroy(() => NAME.dispose?.())`
  // Auto-disposes the resource on component unmount. para resources
  // expose `.dispose()` and Symbol.dispose; we call `.dispose()` (the
  // friendlier name) with optional chaining so values that don't have
  // it (handled non-disposable resources) don't crash unmount.
  let needs = false;
  const re = /^(\s*)using\s+(\w+)(?:\s*:\s*[^=]+)?\s*=\s*(.+?)\s*;?\s*$/gm;
  const code = source.replace(re, (_full, indent, name, expr) => {
    needs = true;
    return `${indent}const ${name} = ${expr}; onDestroy(() => ${name}.dispose?.());`;
  });
  return { code, needsOnDestroy: needs };
}

function lowerSourceDecls(source: string): { code: string; needsOnDestroy: boolean } {
  // LYK-895 (Phase A): `source NAME = EXPR` binds a native handle's
  // reactive surface into a component-reactive, read-only cell that
  // auto-disposes on unmount. Composes two already-proven patterns —
  // the escaping-`signal` para→Svelte bridge and the `using` disposal —
  // so it's preprocess-only (no para-signals/Svelte-fork change).
  //
  // The handle satisfies an all-optional, optional-chained convention
  // (conservative — a plain value works too): `.peek()` current
  // snapshot (fallback: the handle itself), `.subscribe(cb)` fire on
  // change returning an unsubscribe (its return is the $effect.pre
  // teardown), `.dispose()`/Symbol.dispose unmount cleanup.
  //
  // A bare para `Signal<T>` already satisfies this (it has `.peek`/
  // `.subscribe`; `.dispose?.()` no-ops), so `source busy = m.busy`
  // binds a native module's status signal (llm `.busy`, camera `.fps`,
  // audio `.active`, gpio `.value`, …) into component reactivity with
  // no extra keyword — `source` is the single primitive for "bind any
  // native reactive thing, handle OR bare signal" (LYK-897/A3).
  //
  // `NAME` is a read-only reactive VIEW of a native source, so unlike
  // `signal` there is deliberately no assignment-rewrite. Independent of
  // buildEscapeChecker (not a `signal` cell).
  let needs = false;
  const re = /^(\s*)source\s+(\w+)(?:\s*:\s*[^=]+)?\s*=\s*(.+?)\s*;?\s*$/gm;
  const code = source.replace(re, (_full, indent, name, expr) => {
    needs = true;
    return (
      `${indent}const __src_${name} = ${expr}; ` +
      `let ${name} = $state(__src_${name}.peek?.() ?? __src_${name}); ` +
      `$effect.pre(() => __src_${name}.subscribe?.((__v: typeof ${name}) => { ${name} = __v; })); ` +
      `onDestroy(() => __src_${name}.dispose?.());`
    );
  });
  return { code, needsOnDestroy: needs };
}

// Shared emission for the synced keyword forms: bind a `synced(...)` replica
// (`call`) into a read-only, component-reactive cell that auto-disposes on
// unmount — the peek/subscribe/dispose convention (same shape as `source`).
// `type`, when given, annotates the $state cell (the type-only `:` form, where
// no schema means the type can't be inferred from synced<T>).
function syncedBinding(
  indent: string,
  name: string,
  call: string,
  type?: string,
): string {
  const ann = type ? `: ${type}` : "";
  return (
    `${indent}const __syn_${name} = ${call}; ` +
    `let ${name}${ann} = $state(__syn_${name}.peek?.() ?? __syn_${name}); ` +
    `$effect.pre(() => __syn_${name}.subscribe?.((__v: typeof ${name}) => { ${name} = __v; })); ` +
    `onDestroy(() => __syn_${name}.dispose?.());`
  );
}

function lowerSyncFromDecls(source: string): {
  code: string;
  needsOnDestroy: boolean;
  needsSynced: boolean;
} {
  // `sync NAME :: SCHEMA from KEY`  → `synced(KEY, SCHEMA)`  — VALIDATED (default)
  // `sync NAME :  TYPE   from KEY`  → `synced(KEY)`          — type-only, no gate
  //
  // The readable declarative form: the annotation is `::` (a runtime parse gate,
  // rhyming with Para's `value :: Schema` operator) or `:` (a TS type only — the
  // trusted/opt-out mode, since synced replicates over an untrusted wire). The
  // key is the `from` source; delivery is inferred from configureSynced. KEY may
  // span lines (extent via derivedInitEnd); the annotation is single-line up to
  // ` from `. For full control (opts/stream/cell) use `synced NAME = ARGS`.
  //
  // One regex captures the colon count; `(::?)` is greedy so `::` wins over `:`.
  const re =
    /(^|[;\n{}])(\s*)sync\s+([A-Za-z_$][\w$]*)\s*(::?)\s*([^\n;]+?)\s+from\s+/g;
  let out = "";
  let last = 0;
  let needs = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const kwStart = m.index + m[1]!.length;
    const matchEnd = re.lastIndex;
    const name = m[3]!;
    const validate = m[4] === "::";
    const annotation = m[5]!.trim();
    const end = derivedInitEnd(source, matchEnd);
    const key = source.slice(matchEnd, end).trim();
    const consumeEnd = source[end] === ";" ? end + 1 : end;
    out += source.slice(last, kwStart);
    out += validate
      ? // `::` — annotation is the runtime schema (2nd arg); type is inferred.
        syncedBinding(m[2]!, name, `synced(${key}, ${annotation})`)
      : // `:` — annotation is a TS type only; no schema ⇒ passthrough gate.
        syncedBinding(m[2]!, name, `synced(${key})`, annotation);
    needs = true;
    last = consumeEnd;
    re.lastIndex = consumeEnd;
  }
  out += source.slice(last);
  return { code: out, needsOnDestroy: needs, needsSynced: needs };
}

function lowerSyncedDecls(source: string): {
  code: string;
  needsOnDestroy: boolean;
  needsSynced: boolean;
} {
  // `synced NAME = ARGS` → construct a para-sync replica `synced(ARGS)` and bind
  // it into a read-only, component-reactive cell that auto-disposes on unmount.
  // ARGS is the argument list to `synced()` — `key, opts` — so the call site
  // reads `synced user = \`user:${id}\`, { schema, stream }` with NO redundant
  // inner `synced(`, mirroring how `signal x = V` wraps `signal(V)` and
  // `async signal x = E` wraps `promiseSignal(() => (E))`. ARGS MAY span multiple
  // lines (the opts object); its extent is found by derivedInitEnd (a top-level
  // comma between key and opts is a continuation, not a terminator), not a
  // per-line regex. This is the full-control form; `sync NAME :: SCHEMA from KEY`
  // is the readable common-case sugar.
  //
  // The emitted binding is the peek/subscribe/dispose convention (same as
  // `source`); `synced` is auto-imported from @lyku/para-sync (needsSynced). To
  // bind a PRE-BUILT handle instead, use `source x = handle`.
  //
  // The prefix regex requires `synced <identifier> =`, so the emitted
  // `synced(...)` CALL is never re-matched as the keyword.
  const re = /(^|[;\n{}])(\s*)synced\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+?)?\s*=\s*/g;
  let out = "";
  let last = 0;
  let needs = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const kwStart = m.index + m[1]!.length;
    const matchEnd = re.lastIndex;
    const name = m[3]!;
    const end = derivedInitEnd(source, matchEnd);
    const args = source.slice(matchEnd, end).trim();
    const consumeEnd = source[end] === ";" ? end + 1 : end;
    out += source.slice(last, kwStart);
    out += syncedBinding(m[2]!, name, `synced(${args})`);
    needs = true;
    last = consumeEnd;
    re.lastIndex = consumeEnd;
  }
  out += source.slice(last);
  return { code: out, needsOnDestroy: needs, needsSynced: needs };
}

function lowerAsyncSignalDecls(source: string): {
  code: string;
  needsOnDestroy: boolean;
  needsPromiseSignal: boolean;
} {
  // LYK-891 (Phase B): `async signal NAME = EXPR` → a reactive
  // `{ data, error, pending }` cell, the in-flight request dropped on
  // unmount (no stale state / setState-after-unmount). Fixes a real
  // Svelte 5 pain (its await-in-markup + async $derived story is rough)
  // and is cheap: `promiseSignal(() => (EXPR))` returns a value that
  // satisfies the `source` convention, so this reuses the exact source
  // bridge — no new lowering machinery, no Svelte-fork change.
  //
  // `NAME` is a read-only reactive view (like `source`): no
  // assignment-rewrite, independent of buildEscapeChecker. The thunk is
  // `() => (EXPR)` (component-side cancel covers the common case); call
  // promiseSignal directly with `(abort) => fetch(u,{signal:abort})` for
  // true network abort.
  let needs = false;
  const re = /^(\s*)async\s+signal\s+(\w+)(?:\s*:\s*[^=]+)?\s*=\s*(.+?)\s*;?\s*$/gm;
  const code = source.replace(re, (_full, indent, name, expr) => {
    needs = true;
    return (
      `${indent}const __as_${name} = promiseSignal(() => (${expr})); ` +
      `let ${name} = $state(__as_${name}.peek?.() ?? __as_${name}); ` +
      `$effect.pre(() => __as_${name}.subscribe?.((__v: typeof ${name}) => { ${name} = __v; })); ` +
      `onDestroy(() => __as_${name}.dispose?.());`
    );
  });
  return { code, needsOnDestroy: needs, needsPromiseSignal: needs };
}

/**
 * LYK-886 escape analysis (hardened: per-name `signalOf` precision).
 *
 * Builds the "does this signal name escape the component?" predicate for a
 * `.pui` `<script>` body. A `signal x` only needs the para bridge (extra
 * para signal + cross-system subscribe effect) when external para code can
 * observe it via `signalOf`, or it leaves via component context / `export`.
 * Otherwise it lowers to a plain `$state` cell (~1.84× faster, ~2.3× less
 * heap at whole-component scale — it deletes a whole signal + effect per
 * local cell; survives render cost where LYK-884's backend-swap washed out).
 *
 * Single shared implementation: imported by both this build path and the
 * editor's pui-transform.ts, so editor↔build parity is structural (one
 * function), not byte-mirrored copies. The build path passes `source` after
 * provide/inject have desugared to setContext/getContext; the editor passes
 * the raw `<script>` body where they're still keywords — the context regex
 * matches BOTH forms so the verdict is identical regardless of caller.
 *
 * CONSERVATIVE BY DESIGN: the fallback is the proven-correct bridge, so an
 * over-eager inline is a correctness bug (external para observers silently
 * go stale). Precise for the traceable forms; falls back to the coarse
 * "all names escape" gate only when `signalOf` is called with an argument
 * we cannot statically resolve to a name.
 */
export function buildEscapeChecker(source: string): (name: string) => boolean {
  // Identifiers passed directly to signalOf(...). signalOf is THE
  // para-handle API — calling it on a cell is the explicit "keep this
  // para-observable" intent that forces the bridge.
  const signalOfd = new Set<string>();
  let untraceable = false; // signalOf(<non-identifier>) → can't trace
  for (const m of source.matchAll(/\bsignalOf\s*\(\s*([^)]*?)\s*\)/g)) {
    const arg = (m[1] ?? "").trim();
    if (/^[A-Za-z_$][\w$]*$/.test(arg)) signalOfd.add(arg);
    else untraceable = true;
  }
  // Simple identifier aliases `const|let|var L = R;`. Fixpoint so a name
  // aliased into a signalOf'd binding (including chains) also escapes —
  // closes the `const y = x; signalOf(y)` hole without full AST analysis.
  const aliases: Array<[string, string]> = [];
  for (const m of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;?/g)) {
    aliases.push([m[1]!, m[2]!]);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const [l, r] of aliases) {
      if (signalOfd.has(l) && !signalOfd.has(r)) {
        signalOfd.add(r);
        grew = true;
      }
    }
  }
  return (name: string): boolean => {
    if (untraceable) return true; // unresolvable signalOf arg → keep bridge for all (safe)
    if (signalOfd.has(name)) return true;
    const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b(?:setContext|getContext|provide|inject)\\b[^\\n]*\\b${n}\\b`).test(source)) return true;
    if (new RegExp(`\\bexport\\b[^\\n]*\\b${n}\\b`).test(source)) return true;
    return false;
  };
}

/**
 * Lower a `.pui` `<script>` body's Para reactive keywords (signal / derived /
 * effect / prop / provide / inject / using / source / async signal / sync /
 * synced) to standard Svelte 5 runes.
 * Synchronous and side-effect-free — safe to call from a TS language-service
 * plugin or any tooling that needs the type-relevant transform without the
 * full async PreprocessorGroup. The operator desugars (`..!`, `|>`, `pure`)
 * are NOT applied here (they're Bun.Transpiler's job and don't change the
 * component's type surface). Exported for `pui2tsx` / editor tooling.
 *
 * `linePreserving` (editor/LSP use): inject the @lyku/para-signals +
 * runtime imports WITHOUT a trailing newline, so the lowered output has
 * the exact same line count as the input. The build path leaves it off
 * (own-line imports read cleaner in generated code; the Svelte compiler
 * doesn't care about line parity). With it on, the only residual
 * input→output divergence is intra-line column shift on rewritten lines,
 * which keeps svelte2tsx-sourcemap composition line-accurate.
 */
export function lowerPuiReactivity(
  source: string,
  runtime: "@lyku/para-ui" | "svelte" = "@lyku/para-ui",
  linePreserving = false,
  hmr = false,
): string {
  // Effect blocks first (brace-aware) so subsequent regex passes don't
  // accidentally chew the rewritten `$effect(() => {...})` body.
  source = lowerEffectBlocks(source);
  source = lowerDerivedBlocks(source);
  source = lowerDerivedDecls(source);
  source = lowerPropDecls(source);

  const provideInject = lowerProvideInject(source);
  source = provideInject.code;

  const usingResult = lowerUsingDecls(source);
  source = usingResult.code;

  const sourceResult = lowerSourceDecls(source);
  source = sourceResult.code;

  const asyncSignalResult = lowerAsyncSignalDecls(source);
  source = asyncSignalResult.code;

  // `sync NAME :: SCHEMA from KEY` (readable form) before `synced NAME = ARGS`
  // (full-control form) — distinct keywords (`sync` vs `synced`), but order keeps
  // the readable form's emitted `synced(...)` out of the other's scan path.
  const syncFromResult = lowerSyncFromDecls(source);
  source = syncFromResult.code;

  const syncedResult = lowerSyncedDecls(source);
  source = syncedResult.code;

  const needsSynced = syncFromResult.needsSynced || syncedResult.needsSynced;

  // Aggregate Svelte imports needed by the lowerings above. provide/inject
  // contributes setContext/getContext; using + source + async signal + sync(ed)
  // contribute onDestroy.
  const svelteImports = new Set<string>(provideInject.imports);
  if (
    usingResult.needsOnDestroy ||
    sourceResult.needsOnDestroy ||
    asyncSignalResult.needsOnDestroy ||
    syncFromResult.needsOnDestroy ||
    syncedResult.needsOnDestroy
  )
    svelteImports.add("onDestroy");
  // Auto-import the closed lifecycle/nav set when used as a plain call
  // (mount-keyword retired — these are framework functions, not Para
  // primitives; we only strip the import boilerplate). Runtime lifecycle
  // (onMount/onDestroy) rides the existing `${runtime}` injection + its
  // svelte|@lyku/para-ui dedup; SvelteKit nav goes to $app/navigation.
  for (const name of PUI_RUNTIME_LIFECYCLE) if (usesIdentCall(source, name)) svelteImports.add(name);
  const kitNavImports = new Set<string>();
  for (const name of PUI_KIT_NAV) if (usesIdentCall(source, name)) kitNavImports.add(name);

  // LYK-886 escape analysis. A `signal x` only needs the para bridge
  // (extra para signal + cross-system subscribe effect) if external para
  // code can observe it via `signalOf`. When `x` provably never escapes
  // the component we lower it to a plain `$state` cell instead — measured
  // ~1.84× faster + ~2.3× less heap at whole-component scale because it
  // deletes a whole signal + a whole effect per local cell (it removes
  // work, unlike the rejected LYK-884 backend-swap which washed out).
  //
  // CONSERVATIVE BY DESIGN: the fallback is the proven-correct bridge, so
  // an over-eager inline would be a correctness bug (external para
  // observers would silently stop seeing updates). We only inline when
  // certain. v1 escape vectors (keep the bridge if ANY hold):
  //   - `signalOf` appears anywhere in the script. Coarse file-level gate
  //     — signalOf in a .pui is the rare escape hatch; when present the
  //     whole file keeps today's behavior (zero regression). Per-name
  //     precision is a documented later refinement.
  //   - the name flows into component context (`setContext(`/`getContext(`
  //     — provide/inject already desugared to these by this point).
  //   - the name appears in an `export` (belt-and-suspenders: exporting a
  //     value isn't a para-observe, but cheap to be extra safe).
  // NB: this predicate is mirrored byte-for-byte in editors/lsp
  // pui-transform.ts (puiEscapes). It must reach an IDENTICAL verdict in
  // both paths or the editor's type-lowering diverges from the runtime
  // lowering and the byte-parity test fails. It therefore matches BOTH
  // the keyword forms (`provide`/`inject`, which the editor path still
  // sees raw) AND their desugared forms (`setContext`/`getContext`, which
  // this build path has already lowered by now) — whichever a given path
  // observes, the verdict is the same. The checker is the single shared
  // implementation imported by pui-transform.ts too, so editor↔build
  // parity is structural (one function), not hand-maintained copies.
  const escapes = buildEscapeChecker(source);

  const signalNames = new Set<string>();
  const lines = source.split("\n");
  // Match: optional indent, "signal", whitespace, identifier, optional
  // type annotation, "=", expression, optional trailing semicolon. The
  // expression is non-greedy up to end-of-line so we don't accidentally
  // pull in subsequent statements separated by `;` on the same line.
  // One `signal` statement may declare several comma-separated
  // declarators (`signal a = 1, b = 2;`). Each is lowered independently
  // (escape-analysis is per name); the fragments are re-joined on the
  // one source line so line numbering is preserved exactly as the
  // single-declarator path did.
  const declRe = /^(\s*)signal\s+(.+?)\s*;?\s*$/;

  // Lower a single `name = expr` signal declarator to its emitted
  // fragment. Returns null for the "leave line untouched" case (no
  // initializer — not a valid signal decl, matched old non-match).
  const lowerSig = (name: string, expr: string | undefined): string | null => {
    if (expr === undefined || expr === "") return null;
    // LYK-886: provably component-local → plain `$state`, no para bridge.
    // Assignments stay as-is (`$state` is natively reactive), so this
    // name is deliberately NOT added to signalNames (which drives the
    // `__sig_NAME.set()` rewrite + the @lyku/para-signals import).
    if (!escapes(name)) return `let ${name} = $state(${expr});`;
    signalNames.add(name);
    // Bridge form: a para signal lives alongside a $state cell. The
    // $effect.pre subscribes ACROSS the systems — para's .subscribe()
    // creates a para effect that synchronously runs the callback on
    // every set(), and the callback writes into Svelte's $state
    // (which then drives DOM updates the normal way). The cleanup
    // returned by .subscribe() runs on effect teardown (component
    // unmount) so the subscription doesn't leak.
    // In `hmr` mode the signal is allocated through the globalThis
    // registry keyed by module-url + name, so a vite HMR re-eval of
    // this module returns the SAME instance — current value + existing
    // subscribers survive the reload instead of resetting to `expr`.
    // Gated on `import.meta.hot` so a prod build (no hot) takes the
    // plain `signal(expr)` arm and never touches the registry.
    const make = hmr
      ? `(import.meta.hot ? hmrSignal(import.meta.url + "::${name}", () => signal(${expr})) : signal(${expr}))`
      : `signal(${expr})`;
    return (
      `const __sig_${name} = ${make}; ` +
      `let ${name} = $state(__sig_${name}.peek()); ` +
      `$effect.pre(() => __sig_${name}.subscribe((__v: typeof ${name}) => { ${name} = __v; }));`
    );
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(declRe);
    if (!m) continue;
    const [, indent, list] = m;
    const decls = splitDeclarators(list!).map(parseDeclarator);
    if (decls.length === 0 || decls.some(d => d === null)) continue;
    const frags = decls.map(d => lowerSig(d!.name, d!.default));
    // Any declarator without an initializer ⇒ not a valid signal
    // statement; leave the whole line untouched (old non-match behavior).
    if (frags.some(f => f === null)) continue;
    lines[i] = `${indent}${frags.join(" ")}`;
  }

  // Rewrite simple `NAME = EXPR;` assignment lines into `__sig_NAME.set(EXPR);`
  // for each declared signal. Skip the declaration line (it now starts with
  // `const __sig_NAME =`) and only match standalone-assignment lines.
  for (const name of signalNames) {
    const assignRe = new RegExp(`^(\\s*)${name}\\s*=\\s*(.+?)\\s*;?\\s*$`);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.includes(`const __sig_${name}`)) continue;
      const m = line.match(assignRe);
      if (!m) continue;
      const [, indent, expr] = m;
      if (expr === undefined) continue;
      lines[i] = `${indent}__sig_${name}.set(${expr});`;
    }
  }

  let result = lines.join("\n");

  // Inject @lyku/para-signals import if any signals declared and not already
  // imported. Prepended as its own line — adds 1 to all subsequent line
  // numbers from the user's view, which is acceptable for v1; downstream
  // Svelte compiler diagnostics will be offset by 1.
  const importSep = linePreserving ? " " : "\n";
  const paraImports: string[] = [];
  if (signalNames.size > 0) {
    paraImports.push("signal");
    if (hmr) paraImports.push("hmrSignal");
  }
  if (asyncSignalResult.needsPromiseSignal) paraImports.push("promiseSignal");
  if (paraImports.length > 0 && !/from\s+['"]@para\/signals['"]/.test(result)) {
    result = `import { ${paraImports.join(", ")} } from "@lyku/para-signals";${importSep}` + result;
  }

  // `synced` keyword auto-imports the synced() constructor from @lyku/para-sync
  // (dedup against a hand-authored import), the way signal/derived auto-import
  // from para-signals — so the call site never needs the import line.
  if (needsSynced && !/from\s+['"]@lyku\/para-sync['"]/.test(result)) {
    result = `import { synced } from "@lyku/para-sync";${importSep}` + result;
  }

  // Inject extra runtime imports (setContext/getContext from provide/inject,
  // onDestroy from `using`). Dedup against either runtime spelling so a hand-
  // authored `import {...} from "@lyku/para-ui"` already in the script doesn't get
  // shadowed by an emitted `from "svelte"` and vice versa.
  if (svelteImports.size > 0) {
    const existing = new Set<string>();
    const importRe = /import\s*\{([^}]+)\}\s*from\s+['"](?:svelte|@lyku\/para-ui)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(result)) !== null) {
      for (const name of m[1]!.split(",")) existing.add(name.trim().split(/\s+as\s+/)[0]!);
    }
    const toAdd = [...svelteImports].filter(n => !existing.has(n));
    if (toAdd.length > 0) {
      result = `import { ${toAdd.join(", ")} } from "${runtime}";${importSep}` + result;
    }
  }

  // SvelteKit navigation hooks come from $app/navigation (not the Svelte
  // runtime). Same auto-import-with-dedup, separate source module.
  if (kitNavImports.size > 0) {
    const existing = new Set<string>();
    const navRe = /import\s*\{([^}]+)\}\s*from\s+['"]\$app\/navigation['"]/g;
    let m: RegExpExecArray | null;
    while ((m = navRe.exec(result)) !== null) {
      for (const name of m[1]!.split(",")) existing.add(name.trim().split(/\s+as\s+/)[0]!);
    }
    const toAdd = [...kitNavImports].filter(n => !existing.has(n));
    if (toAdd.length > 0) {
      result = `import { ${toAdd.join(", ")} } from "$app/navigation";${importSep}` + result;
    }
  }

  return result;
}

export function parabunPreprocess(opts: ParabunPreprocessOptions = {}): PreprocessorGroup {
  const langs = new Set(opts.langs ?? DEFAULT_LANGS);
  const runtime: "@lyku/para-ui" | "svelte" = opts.runtime ?? "@lyku/para-ui";
  // Default the HMR bridge form on in dev, off in prod. vite sets
  // NODE_ENV=development for the dev server and production for `build`,
  // so signal identity survives save-reload in dev without bloating the
  // prod bundle. Still double-guarded at runtime by `import.meta.hot`.
  const hmr = opts.hmr ?? process.env.NODE_ENV !== "production";
  const transpilerCache = new Map<string, Bun.Transpiler>();

  const getTranspiler = (loader: "ts" | "tsx" | "jsx") => {
    let t = transpilerCache.get(loader);
    if (!t) {
      t = new Bun.Transpiler({ loader });
      transpilerCache.set(loader, t);
    }
    return t;
  };

  return {
    name: "parabun",
    // `.pui` markup may use inline `attr={<Tag/>}` sugar → lift to {#snippet}.
    markup({ content, filename }): Processed | undefined {
      if (!(filename?.endsWith(".pui") ?? false)) return;
      const code = lowerParaMarkup(content);
      return code === content ? undefined : { code };
    },
    script({ content, attributes, filename }): Processed | undefined {
      const lang = typeof attributes.lang === "string" ? attributes.lang : undefined;
      // `.pui` files are parabun-flavored by extension: every script
      // block runs through the parabun pipeline regardless of `lang`, since
      // the filename itself is the marker. For plain `.svelte`, the
      // `langs`/`opts.all` filter governs as before.
      const isPui = filename?.endsWith(".pui") ?? false;
      const shouldRun = isPui
        ? true
        : opts.all
          ? lang === undefined || lang === "ts" || lang === "tsx" || langs.has(lang)
          : lang !== undefined && langs.has(lang);
      if (!shouldRun) return;

      // For `.pui` files: first lower Para script syntax (match, |>, leading-dot,
      // async {}) to standard JS — the JS fallback for what the parabun runtime
      // does natively, so this works under node/browser/standard-bun too — then
      // bridge reactivity (`signal`/`derived`/`effect` → $state/$effect). After
      // both passes the content is standard TS, so parabun's own transpile (when
      // running under Bun) sees nothing parabun-specific left to transform.
      const preprocessed = isPui ? lowerPuiReactivity(lowerParaScript(content), runtime, false, hmr) : content;
      // Svelte's preprocess loop short-circuits with no_change() when
      // `processed.code === content && !processed.map` (see
      // svelte/compiler/preprocess/index.js process_single_tag) — which
      // would silently drop our `lang: "ts"` rewrite. Append a trailing
      // newline in the Node-fallback path so the code differs by one
      // semantically-inert character and the attribute change is honored.
      // Under Bun, parabun's own transpiler strips TS. Under Node (how vite runs
      // the svelte preprocess — `vitePreprocess` does NOT process `.pui`, so it
      // can't strip for us), fall back to esbuild. Without stripping, raw TS like
      // `$state<A | B>()` reaches the svelte parser and breaks.
      const code = HAS_BUN_TRANSPILER
        ? getTranspiler(pickLoader(lang)).transformSync(preprocessed)
        : (nodeStripTypes(preprocessed, pickLoader(lang)) ??
          (preprocessed === content ? preprocessed + "\n" : preprocessed));
      // NOTE: deliberately NOT returning `dependencies: [filename]` — declaring a
      // file as a dependency of itself makes svelte warn ("dependency of itself").
      return {
        code,
        attributes: { ...attributes, lang: "ts" },
      };
    },
  };
}

export default parabunPreprocess;
