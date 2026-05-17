// Bundle pui-transform into one self-contained CJS file the LSP requires.
// svelte2tsx + svelte (compiler) + @lyku/para-preprocess +
// @jridgewell/trace-mapping inlined; nothing external. copy-assets copies
// the single out file into server/ — no recursive svelte node_modules ship.
import { build } from "esbuild";
import { rmSync } from "node:fs";

rmSync("dist-pui-transform", { recursive: true, force: true });

await build({
  entryPoints: ["pui-transform.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: "dist-pui-transform/pui-transform.js",
  // @lyku/para-preprocess via its `bun` export (src/index.ts) so no
  // preprocess dist/ prebuild needed; esbuild compiles the TS inline.
  conditions: ["bun", "import", "default"],
  logLevel: "info",
});
