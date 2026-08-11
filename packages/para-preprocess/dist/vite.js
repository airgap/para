// The bundler story for standalone Para module files (`.pts` / `.pjs`)
// under Vite. `parabunPreprocess` handles script blocks inside `.pui`
// components; these are plain modules, so this plugin lowers the Para
// syntax (match / |> / leading-dot / signals / …) and hands the result to
// esbuild for the TS→JS pass. Runs `pre` so it owns the extensions before
// Vite's built-in esbuild (which only matches `.ts` / `.js`).
//
// Extracted from lyku org/apps/webui's hand-rolled `parabunModules()` config
// block so every Vite app gets the same behavior from the package instead of
// a copy-pasted plugin (the drift class that rotted parascape's vendored
// lowering passes). Vite is an implicit peer: it is imported lazily inside
// the transform hook, so this module adds no dependency for non-Vite
// consumers of the package.
import { lowerParaScript } from "./index.js";
/**
 * Vite plugin: transpile `.pts` / `.pjs` module files (Para → esbuild).
 * Usage: `plugins: [parabunModules(), svelte()/sveltekit(), …]`.
 * `transformWithEsbuild` is injectable for tests; hosts never pass it.
 */
export function parabunModules(opts = {}) {
    let transformWithEsbuild = opts.transformWithEsbuild;
    return {
        name: "parabun-modules",
        enforce: "pre",
        async transform(code, id) {
            const file = id.split("?", 1)[0];
            if (!file.endsWith(".pts") && !file.endsWith(".pjs"))
                return null;
            if (!transformWithEsbuild) {
                // Lazy: resolves against the consuming app's own Vite.
                // @ts-ignore: vite is an implicit peer, present wherever
                // a Vite plugin actually runs; never a dependency of this package.
                const vite = (await import("vite"));
                transformWithEsbuild = vite.transformWithEsbuild;
            }
            const lowered = lowerParaScript(code);
            const result = await transformWithEsbuild(lowered, id, {
                loader: file.endsWith(".pts") ? "ts" : "jsx",
                sourcemap: true,
            });
            return { code: result.code, map: result.map };
        },
    };
}
