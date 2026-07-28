/**
 * Top-level driver. Scans `src` for call-arg-open `(`, splits args on
 * top-level commas, and lowers any arg whose first non-whitespace
 * character is a placeholder-dot. Recurses into the lowered arg so
 * nested calls work too.
 */
export declare function lowerLeadingDot(src: any, opts: any): any;
/**
 * Svelte preprocess wrapper. Runs the lowering on `.pui` script blocks
 * BEFORE parabunPreprocess sees the source, so Bun.Transpiler / Svelte
 * parse plain JS.
 */
export default function lowerLeadingDotPreprocess(): {
    name: string;
    script({ content, filename }: {
        content: any;
        filename: any;
    }): {
        code: any;
    } | undefined;
};
//# sourceMappingURL=lower-leading-dot.d.ts.map