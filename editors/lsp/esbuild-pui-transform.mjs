// Bundle pui-transform into one self-contained CJS file the LSP requires.
// svelte2tsx + svelte (compiler) + @lyku/para-preprocess +
// @jridgewell/trace-mapping inlined; nothing external. copy-assets copies
// the single out file into server/: no recursive svelte node_modules ship.
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

rmSync("dist-pui-transform", { recursive: true, force: true });

// The para deps are file: installs (the ADR-0025 mirror keeps this package
// standalone, so workspace: can't be used), and bun COPIES file: deps into
// node_modules at install time; nothing refreshes the copy when the source
// package changes. Alias the bundle to sibling source so a stale copy can
// never shadow it (same relative shape holds in the public para mirror).
const ws = (p) => fileURLToPath(new URL(`../../packages/${p}/src`, import.meta.url));

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
  alias: {
    "@lyku/para-transpile/syntactic": ws("para-transpile") + "/syntactic.ts",
    "@lyku/para-transpile": ws("para-transpile") + "/index.ts",
    "@lyku/para-preprocess": ws("para-preprocess") + "/index.ts",
  },
  logLevel: "info",
});
