import type { PreprocessorGroup } from "svelte/compiler";
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
     * `getContext`, `onDestroy`, etc.: used by `provide`/`inject`/`using`
     * keyword lowering).
     *
     * - `"@lyku/para-ui"` (default): targets the Para UI fork
     *   (packages/para-svelte/packages/svelte). Para signals run at the
     *   reactive core; `signalOf()` is available. Consumers must have
     *   `@lyku/para-ui` resolvable (currently workspace-only: see
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
export declare function hasTopLevelAwait(body: string): boolean;
/** Split a `prop`/`signal` declarator list on top-level commas. */
export declare function splitDeclarators(list: string): string[];
/**
 * Strip a trailing `// comment` (and the `;` it may have hidden) from a
 * line-based declaration TAIL: the `(.+?)` capture of the single-line decl
 * regexes (`signal`/`prop`/`provide`/`inject`/`using`/`source`/`async
 * signal`/assignment-rewrite). Those regexes end `\s*;?\s*$`, so a trailing
 * comment leaves the `;` mid-capture and the comment rides into the emitted
 * wrapper (`$state([]; // note)`): commenting out the close paren. Cut at
 * the first `//` outside a string literal, then drop the now-trailing `;`.
 * Shared by the build path and the editor's pui-transform (same verdict on
 * both sides, structurally). Scope rule matches the decl forms themselves:
 * single-line initializers; regex literals containing `//` are not tracked.
 */
export declare function stripDeclTail(tail: string): string;
/**
 * Parse one declarator `NAME (: TYPE)? (= DEFAULT)?`. The type/default
 * boundary is the first *top-level* `=` that is a real assignment (not
 * `=>`, `==`, `===`, `<=`, `>=`, `!=`, `!==`, `+=` …).
 */
export declare function parseDeclarator(decl: string): {
    name: string;
    type?: string;
    default?: string;
} | null;
/**
 * Locate every `match SUBJECT { … }` expression and return the span plus
 * the (verbatim) subject text. This is the SINGLE source for the `.pui`
 * LSP projection (pui-transform) and the legacy `transformParabunToTS`
 * non-`.pui` path: both lower `match` to a parse-safe, subject-typed
 * `any` stub (`((__pm: any): any => null as any)(SUBJECT)`), which is
 * the proven shape shipped for `.svelte`/`.pts` today. (Full per-arm
 * result narrowing is a separate enhancement, tracked on LYK-916: it
 * would need a Zig-faithful, sourcemap-threaded lowering and is beyond
 * what any current parabun tooling does.)
 *
 * `match` as an identifier (`const match = 42`, `match.foo`) is left
 * alone: the regex requires `match` + whitespace + a non-`{` subject +
 * `{`. `end` is the offset just past the closing `}`.
 */
export declare function matchTypeStubSpans(source: string): Array<{
    start: number;
    end: number;
    subject: string;
}>;
export declare const PUI_RUNTIME_LIFECYCLE: readonly ["onMount", "onDestroy"];
export declare const PUI_KIT_NAV: readonly ["beforeNavigate", "afterNavigate", "onNavigate"];
export declare function usesIdentCall(src: string, name: string): boolean;
export declare function derivedInitEnd(src: string, start: number): number;
export interface ServerSourceMeta {
    name: string;
    declId: string;
    schema: string;
    params: string[];
    policy: string;
    expr: string;
}
/**
 * §13.8 extraction: find every `sync NAME :: SCHEMA from server EXPR POLICY`
 * declaration, escape-analyze the server expression, rewrite the client side
 * to a tracked `synced(subKey(declId, [params]), SCHEMA)` binding, and emit a
 * readable, ejectable server module (INV-mpb-1) exporting one entry per
 * declaration for `createServerSource` hosting.
 *
 * Escape analysis (v1, same regex/extent fidelity as the rest of this file):
 * free identifiers of EXPR partition into (1) file imports → hoisted into the
 * server module: used ANYWHERE else client-side in the file is a compile
 * error, EXCEPT the schema annotation's root identifier (schemas are
 * isomorphic values, deliberately legal on both sides); (2) component-scope
 * declarations (prop/signal/let/const/…) → positional wire params, re-keying
 * the subscription when they change; (3) ambient globals → travel with the
 * artifact. `this` in a server expression is a compile error.
 *
 * This runs INSIDE lowerPuiReactivity (so a .pui compiles standalone) and is
 * exported for the P9 emitter, which calls it on the original source to
 * obtain `serverModule` and write the sibling artifact.
 */
export declare function extractServerSources(source: string, opts?: {
    moduleId?: string;
}): {
    code: string;
    serverModule?: string;
    sources: ServerSourceMeta[];
    diagnostics: string[];
};
/**
 * LYK-886 escape analysis (hardened: per-name `signalOf` precision).
 *
 * Builds the "does this signal name escape the component?" predicate for a
 * `.pui` `<script>` body. A `signal x` only needs the para bridge (extra
 * para signal + cross-system subscribe effect) when external para code can
 * observe it via `signalOf`, or it leaves via component context / `export`.
 * Otherwise it lowers to a plain `$state` cell (~1.84× faster, ~2.3× less
 * heap at whole-component scale: it deletes a whole signal + effect per
 * local cell; survives render cost where LYK-884's backend-swap washed out).
 *
 * Single shared implementation: imported by both this build path and the
 * editor's pui-transform.ts, so editor↔build parity is structural (one
 * function), not byte-mirrored copies. The build path passes `source` after
 * provide/inject have desugared to setContext/getContext; the editor passes
 * the raw `<script>` body where they're still keywords: the context regex
 * matches BOTH forms so the verdict is identical regardless of caller.
 *
 * CONSERVATIVE BY DESIGN: the fallback is the proven-correct bridge, so an
 * over-eager inline is a correctness bug (external para observers silently
 * go stale). Precise for the traceable forms; falls back to the coarse
 * "all names escape" gate only when `signalOf` is called with an argument
 * we cannot statically resolve to a name.
 */
export declare function buildEscapeChecker(source: string): (name: string) => boolean;
/**
 * Lower a `.pui` `<script>` body's Para reactive keywords (signal / derived /
 * effect / prop / provide / inject / using / source / async signal / sync /
 * synced) to standard Svelte 5 runes.
 * Synchronous and side-effect-free: safe to call from a TS language-service
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
export declare function lowerPuiReactivity(source: string, runtime?: "@lyku/para-ui" | "svelte", linePreserving?: boolean, hmr?: boolean, moduleId?: string): string;
export declare function parabunPreprocess(opts?: ParabunPreprocessOptions): PreprocessorGroup;
export default parabunPreprocess;
//# sourceMappingURL=index.d.ts.map