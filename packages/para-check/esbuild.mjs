// Bundle the checker into one self-contained CJS file, same pattern as
// editors/lsp/esbuild-pui-transform.mjs: svelte2tsx + svelte (compiler) +
// @lyku/para-preprocess + @lyku/para-transpile + magic-string +
// trace-mapping inlined. TypeScript is the ONE external. The checker
// resolves the TARGET workspace's typescript at runtime so diagnostics
// match the version the project actually builds with (and so we never
// ship a second copy of tsc).
//
// The svelte2tsx ambient shims (.d.ts) are inlined as text and served to
// the program as virtual files, so the target workspace does not need
// svelte2tsx installed.
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

rmSync("dist", { recursive: true, force: true });

// The lsp sources this bundle pulls in (../../editors/lsp) sit OUTSIDE the bun
// workspace and carry their own node_modules with a COPIED para-transpile;
// nothing refreshes that copy, and a stale one (predating src/syntactic.ts)
// broke CI. Pin the para packages to workspace source so nested copies can
// never shadow them.
const ws = (p) => fileURLToPath(new URL(`../${p}/src`, import.meta.url));

await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: "dist/pui-check.cjs",
  banner: { js: "#!/usr/bin/env node" },
  external: ["typescript"],
  loader: { ".d.ts": "text" },
  // para-preprocess / para-transpile via their `bun` export (src TS) so no
  // prebuild of those packages is needed; esbuild compiles them inline.
  conditions: ["bun", "import", "default"],
  alias: {
    "@lyku/para-transpile/syntactic": ws("para-transpile") + "/syntactic.ts",
    "@lyku/para-transpile": ws("para-transpile") + "/index.ts",
    "@lyku/para-preprocess": ws("para-preprocess") + "/index.ts",
  },
  logLevel: "info",
});

// bin targets need the exec bit; bun only chmods at install time when the file already exists
import { chmodSync } from "node:fs";
chmodSync(new URL("./dist/pui-check.cjs", import.meta.url), 0o755);
