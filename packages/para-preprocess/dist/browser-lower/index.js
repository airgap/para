// Para browser-lowering — the JS fallback for the lowerings the parabun runtime
// does natively. Run by parabunPreprocess so .pui compiles to standard
// Svelte-5 in ANY environment (browser preview, node/vite, standard bun) without
// each consumer (Parascape, E, …) vendoring its own copy.
//
// These were proven in Parascape's demos/*.js; this is now their canonical home.
// Fusion (an optimization that pulls in @lyku/fuse) is intentionally not here —
// chains compile + run correctly unfused.
import { lowerAsyncBlock } from "./lower-async-block.js";
import { lowerPipeline } from "./lower-pipeline.js";
import { lowerLeadingDot } from "./lower-leading-dot.js";
import { lowerMatch } from "./lower-match.js";
import { lowerInlineSnippets } from "./para-inline-snippets.js";
/**
 * Script-level Para lowerings, in dependency order (matches the chain Parascape
 * proved): async-block → pipeline → leading-dot → match. Pure string transforms;
 * each is a no-op when its syntax is absent.
 */
export function lowerParaScript(src) {
    let s = src;
    s = lowerAsyncBlock(s);
    s = lowerPipeline(s);
    s = lowerLeadingDot(s, {});
    s = lowerMatch(s);
    return s;
}
/** Markup-level lowering: inline `attr={<Tag/>}` markup → `{#snippet}` decls. */
export function lowerParaMarkup(src) {
    return lowerInlineSnippets(src);
}
