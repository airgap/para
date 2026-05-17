const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");

// Refuse to build a .vsix if the local parabun on PATH is a debug
// build. The extension's activate() now guards against running with a
// debug build (the ASAN + tracing overhead makes the LSP unusable —
// 38 s cold start vs 4 s release), but catching it earlier at build
// time keeps a developer from packaging + installing a .vsix that
// will then refuse to start.
//
// CI escape hatch: PARABUN_VSIX_SKIP_BINARY_CHECK=1. The Jenkins VSIX
// stage runs in a docker container that doesn't ship a parabun binary
// (it's published as a separate artifact by the build stages, paired
// by SHA in the release notes). Skipping the check there is safe —
// the local-dev footgun the check is guarding against doesn't apply
// to CI.
if (process.env.PARABUN_VSIX_SKIP_BINARY_CHECK === "1") {
  console.log("parabun binary check skipped (PARABUN_VSIX_SKIP_BINARY_CHECK=1)");
} else {
  try {
    const revision = execFileSync("parabun", ["--revision"], { encoding: "utf8", timeout: 5000 }).trim();
    if (revision.includes("-debug")) {
      console.error(
        `\nERROR: the \`parabun\` binary on PATH is a debug build (${revision}).\n` +
          `Debug builds are 10-100x slower than release and make the installed\n` +
          `extension unusable — and its activate() now refuses to start.\n\n` +
          `Fix one of:\n` +
          `  1. Build & symlink release:\n` +
          `       cd /raid/parabun && bun run build:release\n` +
          `       sudo ln -sf /raid/parabun/build/release/bun /usr/local/bin/parabun\n` +
          `  2. Adjust your PATH so a release-build parabun comes first.\n`,
      );
      process.exit(1);
    }
    console.log("parabun binary check ok:", revision);
  } catch (e) {
    console.error(
      "\nERROR: failed to invoke `parabun --revision` to verify the binary is a release build.\n" +
        "Make sure `parabun` is on PATH and points to a release build.\n" +
        "(Set PARABUN_VSIX_SKIP_BINARY_CHECK=1 to bypass — only do this in CI.)\n" +
        `Underlying error: ${e.message ?? e}\n`,
    );
    process.exit(1);
  }
}

// Copy LSP server
fs.mkdirSync(path.join(root, "server"), { recursive: true });
fs.copyFileSync(path.resolve(root, "../../lsp/parabun-lsp.ts"), path.join(root, "server/parabun-lsp.ts"));

// Bundle `typescript` next to the LSP script so its
// `require.resolve("typescript", { paths: [lspDir] })` fallback finds it
// even when the user's workspace doesn't have a typescript dep. Without
// this, validation silently produced zero diagnostics ("type features
// disabled") in any workspace that lacks tsc.
const tsSrc = path.resolve(root, "node_modules/typescript");
const tsDest = path.join(root, "server/node_modules/typescript");
fs.rmSync(tsDest, { recursive: true, force: true });
fs.mkdirSync(path.dirname(tsDest), { recursive: true });
fs.cpSync(tsSrc, tsDest, { recursive: true, dereference: true });

// Bundle vscode-css-languageservice + dart-sass + their transitive deps so
// parabun-LSP can validate `<style lang="...">` blocks in `.pui` files.
// vscode-css-languageservice handles css/scss/less; dart-sass handles
// indented sass (which the css service can't parse).
const styleDeps = [
  "vscode-css-languageservice",
  "vscode-languageserver-textdocument",
  "vscode-languageserver-types",
  "vscode-uri",
  "sass",
  "immutable",
  "source-map-js",
];
for (const dep of styleDeps) {
  const src = path.resolve(root, "node_modules", dep);
  const dest = path.join(root, "server/node_modules", dep);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true });
}

// LYK-880 Slice B: bundle + ship parabun-pui-transform so the LSP can
// `require("parabun-pui-transform")` for in-.pui type intelligence. One
// self-contained file (svelte2tsx + svelte + @lyku/para-preprocess +
// trace-mapping inlined) — no recursive svelte node_modules ship.
const lspDir = path.resolve(root, "../../lsp");
require("node:child_process").execFileSync(process.execPath, ["esbuild-pui-transform.mjs"], {
  cwd: lspDir,
  stdio: "inherit",
});
const puiTxDest = path.join(root, "server/node_modules/parabun-pui-transform");
fs.rmSync(puiTxDest, { recursive: true, force: true });
fs.mkdirSync(puiTxDest, { recursive: true });
fs.copyFileSync(path.join(lspDir, "dist-pui-transform/pui-transform.js"), path.join(puiTxDest, "index.js"));
fs.writeFileSync(
  path.join(puiTxDest, "package.json"),
  JSON.stringify({ name: "parabun-pui-transform", version: "0.1.0", main: "index.js" }, null, 2),
);

// Copy TS plugin (built output only — no symlink, no npm dep)
const pluginSrc = path.resolve(root, "../../ts-plugin");
const pluginDest = path.join(root, "node_modules/parabun-ts-plugin");

// Remove stale symlink or directory
try {
  const stat = fs.lstatSync(pluginDest);
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(pluginDest);
  } else if (stat.isDirectory()) {
    fs.rmSync(pluginDest, { recursive: true });
  }
} catch {}

fs.mkdirSync(path.join(pluginDest, "out"), { recursive: true });
fs.copyFileSync(path.join(pluginSrc, "package.json"), path.join(pluginDest, "package.json"));
for (const f of fs.readdirSync(path.join(pluginSrc, "out"))) {
  fs.copyFileSync(path.join(pluginSrc, "out", f), path.join(pluginDest, "out", f));
}

// (typescript is inlined into the plugin's esbuild bundle — no nested
// node_modules copy needed; see editors/ts-plugin/esbuild.mjs)

console.log("copied: server/parabun-lsp.ts, node_modules/parabun-ts-plugin/");
