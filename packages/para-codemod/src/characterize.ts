// C4b-runtime — characterization-snapshot harness.
//
// Behavioral-parity oracle for a migration: SSR-render the ORIGINAL
// `.svelte` and the MIGRATED `.pui`(→lowered) with the same props,
// normalize Svelte's render-mode hydration markers, and diff. Identical
// DOM ⇒ the migration preserved the rendered output for that render.
//
// Honest scope (stated as real verdicts, never hidden):
//  - SSR captures the INITIAL render only — not post-mount client
//    reactivity / interaction / async. Strong signal for "did lowering
//    change output?"; not a universal behavioral oracle.
//  - If the ORIGINAL won't SSR-render in this harness (heavy TS types
//    that don't eval as bare JS, context/store-only components that
//    render empty/throw with default props), the verdict is
//    `uncharacterizable` — we explicitly DO NOT claim parity. Both
//    sides go through the identical pipeline so a limitation never
//    produces a false mismatch.
//
// Dependency-free core; the runner injects fork compile/render +
// lowerPuiReactivity + safeMigrate.

export type CharVerdict =
  | "parity" // original & migrated render byte-identically (normalized)
  | "mismatch" // RENDER DIFFERS — migration changed observable output
  | "uncharacterizable" // original won't render here → no parity claim
  | "skipped"; // safeMigrate left the file unchanged → nothing to verify

export interface CharResult {
  verdict: CharVerdict;
  detail?: string;
  original?: string; // normalized HTML (on mismatch, for diffing)
  migrated?: string;
}

export interface CharDeps {
  /** transform+verify; returns {code, migrated}. (safeMigrate) */
  safeMigrate: (s: string) => { code: string; migrated: boolean };
  /** lowerPuiReactivity — .pui → .svelte source */
  lower: (s: string, runtime?: string, lp?: boolean, hmr?: boolean) => string;
  /** SSR-render a .svelte source with props → html, or throw. */
  renderSSR: (svelteSource: string, props: Record<string, unknown>) => string;
}

// Strip Svelte 5 SSR hydration markers — render-mode artifacts, not
// behaviour: <!--[-->, <!--]-->, <!---->, <!--[!-->, and the
// data-svelte-h hydration hashes. Collapse insignificant whitespace.
function normalize(html: string): string {
  return html
    .replace(/<!--[\][!]?-->/g, "")
    .replace(/\s+data-svelte-h="[^"]*"/g, "")
    .replace(/>\s+</g, "><")
    .trim();
}

export function characterize(svelteSource: string, props: Record<string, unknown>, deps: CharDeps): CharResult {
  let migrate: { code: string; migrated: boolean };
  try {
    migrate = deps.safeMigrate(svelteSource);
  } catch (e) {
    return { verdict: "uncharacterizable", detail: `safeMigrate threw: ${(e as Error).message}` };
  }
  if (!migrate.migrated) {
    return { verdict: "skipped", detail: "safeMigrate left the file unchanged — no migration to verify" };
  }

  // Baseline: render the original .svelte.
  let originalHtml: string;
  try {
    originalHtml = normalize(deps.renderSSR(svelteSource, props));
  } catch (e) {
    return {
      verdict: "uncharacterizable",
      detail: `original would not SSR-render here (${(e as Error).message?.split("\n")[0]}) — no parity claim`,
    };
  }

  // Migrated: lower the .pui back to .svelte, render identically.
  let migratedHtml: string;
  try {
    const lowered = deps.lower(migrate.code, "@lyku/para-ui", false, false);
    migratedHtml = normalize(deps.renderSSR(lowered, props));
  } catch (e) {
    return {
      verdict: "mismatch",
      detail: `migrated failed to render where original succeeded: ${(e as Error).message?.split("\n")[0]}`,
      original: originalHtml,
    };
  }

  if (originalHtml === migratedHtml) return { verdict: "parity" };
  return {
    verdict: "mismatch",
    detail: "rendered DOM differs after migration",
    original: originalHtml,
    migrated: migratedHtml,
  };
}
