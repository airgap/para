// C4b — compile-equivalence gate. The real "is the migration safe?"
// check, far stronger than "the transform didn't throw":
//
//   baseline = compile(original .svelte) via the fork Svelte compiler
//   migrated = compile(svelteToPui(original) |> lowerPuiReactivity)
//
//   REGRESSION  := baseline compiles AND migrated does NOT
//   pre-existing := baseline already fails (NOT a migration fault)
//   safe        := both compile (or both fail identically)
//
// This proves the codemod output is valid, compilable Svelte across a
// real corpus — it does NOT prove identical runtime behaviour (that
// needs per-component fixtures / the app test-suite — C4c). It is the
// strongest *automatable corpus-wide* gate and catches the codemod
// producing broken/ill-formed output, the classic codemod failure.
import { svelteToPui } from "./index.ts";

type Compile = (src: string, opts: Record<string, unknown>) => unknown;
type Lower = (src: string, runtime?: string, lp?: boolean, hmr?: boolean) => string;

export type EquivVerdict = "safe" | "regression" | "pre-existing-fail" | "transform-error";

export interface EquivResult {
  verdict: EquivVerdict;
  baselineErr?: string;
  migratedErr?: string;
}

function tryCompile(compile: Compile, src: string): string | null {
  try {
    compile(src, { generate: "client", name: "C", runes: true });
    return null;
  } catch (e) {
    return (e as Error).message ?? String(e);
  }
}

/**
 * @param svelteSource raw `.svelte` file
 * @param compile      the fork's `compile` (svelte/compiler)
 * @param lower        `lowerPuiReactivity` from @lyku/para-preprocess
 */
export function checkEquivalence(svelteSource: string, compile: Compile, lower: Lower): EquivResult {
  const baselineErr = tryCompile(compile, svelteSource);

  let migratedSvelte: string;
  try {
    const { code } = svelteToPui(svelteSource);
    // The migrated .pui must lower (build path) then compile as Svelte.
    migratedSvelte = lower(code, "@lyku/para-ui", false, false);
  } catch (e) {
    return { verdict: "transform-error", migratedErr: (e as Error).message ?? String(e) };
  }
  const migratedErr = tryCompile(compile, migratedSvelte);

  if (baselineErr && migratedErr) return { verdict: "pre-existing-fail", baselineErr, migratedErr };
  if (!baselineErr && migratedErr) return { verdict: "regression", migratedErr };
  return { verdict: "safe", baselineErr: baselineErr ?? undefined };
}
