/**
 * pui2tsx — transform a `.pui` (Para UI) component into typed TSX.
 *
 * Pipeline:
 *   1. Find every <script> block (instance + module).
 *   2. Run the Para keyword lowering (signal/derived/effect/prop/
 *      provide/inject/using → Svelte 5 runes) on each block's body.
 *      This is the type-relevant transform; operator desugars (..!, |>,
 *      pure) don't change the component's type surface so we skip them.
 *   3. Splice the lowered bodies back, producing standard Svelte 5 source.
 *   4. Hand that to @sveltejs/svelte2tsx, which emits a .tsx whose default
 *      export carries the real component type (props, events, slots).
 *
 * Used by parabun-ts-plugin (import-site types) and, later, parabun-lsp
 * (in-file type intelligence). svelte2tsx only inspects component syntax
 * to derive the type surface, so plain npm `svelte` is sufficient for the
 * parse — the @lyku/para-ui runtime fork doesn't alter type shapes.
 */

import { svelte2tsx } from "svelte2tsx";
import { lowerPuiReactivity } from "@lyku/para-preprocess";

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

/**
 * Lower Para keywords inside every <script> block of a `.pui` source,
 * leaving markup/style untouched. Returns standard Svelte 5 source.
 */
export function lowerPuiToSvelte(source: string): string {
  return source.replace(SCRIPT_RE, (_full, attrs: string, body: string) => {
    const lowered = lowerPuiReactivity(body);
    return `<script${attrs}>${lowered}</script>`;
  });
}

export interface Pui2TsxResult {
  code: string;
  /** svelte2tsx source map (v3), maps tsx positions back to the lowered svelte */
  map: unknown;
}

/**
 * Full `.pui` → typed `.tsx`. `filename` should be the `.pui` path; the
 * returned module's default export is the component constructor with its
 * real prop/event/slot types.
 */
export function pui2tsx(source: string, filename: string): Pui2TsxResult {
  const svelteSource = lowerPuiToSvelte(source);
  const out = svelte2tsx(svelteSource, {
    filename,
    isTsFile: true,
    mode: "ts",
  });
  return { code: out.code, map: out.map };
}
