// Bakes @lyku/parabun-bin's manifest.json + version from the published
// per-platform carrier packages. This is the para-owned half of the P2
// pin mechanism (boundary doc decision 1 / invariant B2): parabun's
// Jenkins publishes `@lyku/parabun-bin-<os>-<arch>@<pin>` carriers; this
// script — run in a deliberate, reviewed para "bump the pin" PR — reads
// each carrier's self-declared `parabunSha256` via `npm view`, writes
// the manifest, and sets the umbrella + its optionalDependencies to the
// pin version. After this, the lockfile IS the pin.
//
// Usage:  bun scripts/bake-manifest.ts --version 0.0.0-pin-<sha>
//
// Fails loud if any expected carrier is missing or lacks the field —
// never bakes a half manifest (a missing platform must be a conscious
// choice, made by editing PLATFORMS, not a silent gap).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PLATFORMS = [
  { key: "linux-x64", pkg: "@lyku/parabun-bin-linux-x64" },
  { key: "linux-arm64", pkg: "@lyku/parabun-bin-linux-arm64" },
  { key: "darwin-arm64", pkg: "@lyku/parabun-bin-darwin-arm64" },
  { key: "win32-x64", pkg: "@lyku/parabun-bin-win32-x64" },
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const version = arg("version");
if (!version) {
  console.error("bake-manifest: --version <pin> is required");
  process.exit(2);
}

const pkgRoot = join(import.meta.dir, "..");

function npmView(spec: string, field: string): string {
  try {
    return execFileSync("npm", ["view", spec, field], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const platforms: Record<string, { sha256: string; pkg: string }> = {};
const missing: string[] = [];
for (const p of PLATFORMS) {
  const spec = `${p.pkg}@${version}`;
  const sha256 = npmView(spec, "parabunSha256");
  if (!sha256) {
    missing.push(spec);
    continue;
  }
  platforms[p.key] = { sha256, pkg: p.pkg };
  console.error(`baked ${p.key} ← ${spec} (sha256=${sha256.slice(0, 12)}…)`);
}

if (missing.length > 0) {
  console.error(
    `bake-manifest: missing published carrier(s):\n  ${missing.join("\n  ")}\n` +
      `Refusing to bake a partial manifest. Either parabun's Jenkins has ` +
      `not published these yet, or this platform was intentionally dropped ` +
      `(then remove it from PLATFORMS here AND the umbrella's ` +
      `optionalDependencies + resolver, deliberately).`,
  );
  process.exit(1);
}

writeFileSync(
  join(pkgRoot, "manifest.json"),
  JSON.stringify(
    {
      $comment: `Baked by scripts/bake-manifest.ts from published @lyku/parabun-bin-* carriers at the pin bump. version = the pinned parabun release. Do NOT hand-edit sha256 — re-run the bake.`,
      version,
      platforms,
    },
    null,
    "\t",
  ) + "\n",
);

// Lockfile = pin: set umbrella + its optionalDeps to the pin version so
// `bun add @lyku/parabun-bin@<pin>` pulls exactly the matching carriers.
const pjPath = join(pkgRoot, "package.json");
const pj = JSON.parse(readFileSync(pjPath, "utf8"));
pj.version = version;
for (const p of PLATFORMS) {
  if (pj.optionalDependencies?.[p.pkg] !== undefined) pj.optionalDependencies[p.pkg] = version;
}
writeFileSync(pjPath, JSON.stringify(pj, null, 2) + "\n");

console.error(
  `\n@lyku/parabun-bin pinned to ${version} (${Object.keys(platforms).length} platforms). Commit manifest.json + package.json + lockfile.`,
);
