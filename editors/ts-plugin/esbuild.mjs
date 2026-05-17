// Bundle the TS language-service plugin into one self-contained CJS file.
//
// svelte2tsx + svelte (compiler) + @lyku/para-preprocess + typescript are
// ALL inlined so the plugin is one self-contained file (~10mb; the existing
// .vscodeignore already allows node_modules/parabun-ts-plugin/out/**, no
// packaging fiddle, no runtime require-resolution ambiguity).
//
// Bundling typescript is safe: the plugin's tsserver-proxy logic uses the
// INJECTED `modules.typescript` (from init(modules)), never a runtime
// require — so the proxied `ts` identity is unaffected. The only consumer
// of the bundled copy is svelte2tsx's parser, which has no identity
// requirement. `typescript/lib/tsserverlibrary` is a type-only import
// (erased by esbuild); kept external as a belt-and-braces no-op.
import { build } from "esbuild";
import { rmSync, mkdirSync } from "node:fs";

// Fresh out/ — only the single bundled index.js should ship in the vsix.
rmSync("out", { recursive: true, force: true });
mkdirSync("out");

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: "out/index.js",
  external: ["typescript/lib/tsserverlibrary"],
  // Resolve @lyku/para-preprocess via its `bun` export condition, which
  // points at src/index.ts — so this bundle doesn't require the preprocess
  // package's dist/ to be prebuilt (CI's VSIX stage only builds this
  // plugin). esbuild compiles the referenced TS source inline.
  conditions: ["bun", "import", "default"],
  logLevel: "info",
});
