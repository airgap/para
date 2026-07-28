/**
 * Script-level Para lowerings, in dependency order (matches the chain Parascape
 * proved): async-block → pipeline → leading-dot → match. Pure string transforms;
 * each is a no-op when its syntax is absent.
 */
export declare function lowerParaScript(src: string): string;
/** Markup-level lowering: inline `attr={<Tag/>}` markup → `{#snippet}` decls. */
export declare function lowerParaMarkup(src: string): string;
//# sourceMappingURL=index.d.ts.map