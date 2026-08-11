#!/usr/bin/env bun
// para-kit CLI: the fs shell around the pure emitter (emit.js).
//
//   para-kit emit <srcDir> [--manifest <path>] [--endpoint <path>] [--check]
//
// Walks <srcDir> for .pui files, extracts §13.8 server sources, writes the
// <name>.server-sources.pts sibling artifacts + the app-wide manifest, and
// (once, if absent) the conventional sync endpoint route. --check verifies
// everything on disk matches what would be emitted (the CI drift gate)
// without writing.

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { emitServerArtifacts, endpointTemplate } from "./emit.js";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".pui")) out.push(p);
  }
  return out;
}

const args = process.argv.slice(2);
const cmd = args[0];
if (cmd !== "emit" || !args[1]) {
  console.error("usage: para-kit emit <srcDir> [--manifest <path>] [--endpoint <path>] [--check]");
  process.exit(1);
}
const root = args[1];
const flag = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const check = args.includes("--check");
const manifestPath = flag("--manifest") ?? join(root, "lib/para-sync-manifest.js");
const endpointPath = flag("--endpoint") ?? join(root, "routes/para-sync/+server.ts");

const files = walk(root).map((p) => ({
  // moduleId = root-relative path: MUST match what the preprocess sees as
  // `filename` (client subKey ≡ host subKey). SvelteKit hands the
  // preprocessor absolute paths; para-preprocess uses them verbatim, so we
  // emit with the same absolute path when the tree is walked absolutely.
  path: p,
  source: readFileSync(p, "utf8"),
}));

const result = emitServerArtifacts(files, { manifestPath });
if (result.diagnostics.length > 0) {
  console.error("para-kit emit: server-source diagnostics:\n  " + result.diagnostics.join("\n  "));
  process.exit(1);
}

let drift = 0;
const emitOne = (path, code, label) => {
  const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (current === code) return;
  if (check) {
    console.error(`✗ ${label} out of date: ${path}`);
    drift++;
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, code);
  console.log(`✓ wrote ${relative(process.cwd(), path)}`);
};

for (const a of result.artifacts) emitOne(a.path, a.code, "artifact");
emitOne(result.manifest.path, result.manifest.code, "manifest");
// The endpoint is written ONCE (ejected by construction): never overwritten.
if (!existsSync(endpointPath) && !check && result.artifacts.length > 0) {
  mkdirSync(dirname(endpointPath), { recursive: true });
  writeFileSync(endpointPath, endpointTemplate());
  console.log(`✓ wrote ${relative(process.cwd(), endpointPath)} (once: yours to edit)`);
}

if (check && drift > 0) process.exit(1);
console.log(
  `para-kit emit: ${result.artifacts.length} artifact(s), ${files.length} .pui scanned${check ? " (check ok)" : ""}`
);
