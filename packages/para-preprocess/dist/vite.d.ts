type TransformWithEsbuild = (code: string, filename: string, options?: Record<string, unknown>) => Promise<{
    code: string;
    map: unknown;
}>;
/**
 * Vite plugin: transpile `.pts` / `.pjs` module files (Para → esbuild).
 * Usage: `plugins: [parabunModules(), svelte()/sveltekit(), …]`.
 * `transformWithEsbuild` is injectable for tests; hosts never pass it.
 */
export declare function parabunModules(opts?: {
    transformWithEsbuild?: TransformWithEsbuild;
}): {
    name: string;
    enforce: "pre";
    transform(code: string, id: string): Promise<{
        code: string;
        map: unknown;
    } | null>;
};
export {};
//# sourceMappingURL=vite.d.ts.map