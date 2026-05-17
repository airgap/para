// Resolver for the pinned `parabun` release binary.
//
// This package's installed VERSION is the pin: bumping it (and the
// lockfile) is the deliberate, reviewed act of moving the boundary —
// see /raid/para-design/para-parabun-boundary.md (B2). The actual
// platform binaries ship as optional deps `@lyku/parabun-bin-<os>-<arch>`,
// generated + published by parabun's Jenkins on release (P2-c). Each is
// sha256-verified against the manifest baked here at publish time (B1
// integrity: a tampered/mismatched binary fails loud, not silently).
//
// Resolution order:
//   1. PARABUN_BIN env override — an explicit absolute path. Trusted,
//      NOT hash-verified (it is the deliberate escape hatch: local dev,
//      a freshly-built binary, or the stand-in before Jenkins publishes
//      the real per-platform packages). Surfaces via `.verified=false`.
//   2. The matching per-platform optional dependency, sha256-verified
//      against manifest.json.
//   3. Throw — clear, actionable, names the platform and both fixes.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

/** @typedef {{ sha256: string, pkg: string }} PlatformEntry */
/** @typedef {{ version: string, platforms: Record<string, PlatformEntry> }} Manifest */

/** @returns {Manifest} */
function readManifest() {
  const p = join(here, "..", "manifest.json");
  return JSON.parse(readFileSync(p, "utf8"));
}

/** Node platform/arch → our manifest key (e.g. "linux-x64"). */
export function platformKey(platform = process.platform, arch = process.arch) {
  const os = { linux: "linux", darwin: "darwin", win32: "win32" }[platform];
  const cpu = { x64: "x64", arm64: "arm64" }[arch];
  if (!os || !cpu) return `${platform}-${arch}`; // unsupported — surfaced in error
  return `${os}-${cpu}`;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Resolve the pinned parabun binary.
 * @returns {{ path: string, version: string, verified: boolean, source: "env" | "package" }}
 */
export function resolveParabun() {
  const manifest = readManifest();

  const override = process.env.PARABUN_BIN;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`@lyku/parabun-bin: PARABUN_BIN is set to "${override}" but no file exists there.`);
    }
    return {
      path: override,
      version: manifest.version,
      verified: false,
      source: "env",
    };
  }

  const key = platformKey();
  const entry = manifest.platforms[key];
  if (!entry) {
    throw new Error(
      `@lyku/parabun-bin: no pinned binary for platform "${key}". ` +
        `Supported: ${Object.keys(manifest.platforms).join(", ") || "(none — manifest not yet baked by Jenkins)"}. ` +
        `Set PARABUN_BIN=/abs/path/to/parabun to use a local build.`,
    );
  }

  let binPath;
  try {
    // The per-platform package declares its binary's relative path in a
    // `parabunBin` field (win32 ships `bin/parabun.exe`; posix
    // `bin/parabun`) so the resolver stays platform-agnostic.
    const pkgJson = require.resolve(`${entry.pkg}/package.json`);
    const rel = JSON.parse(readFileSync(pkgJson, "utf8")).parabunBin ?? "bin/parabun";
    binPath = join(dirname(pkgJson), rel);
    if (!existsSync(binPath)) throw new Error("declared parabunBin missing");
  } catch {
    throw new Error(
      `@lyku/parabun-bin: platform package "${entry.pkg}" is not installed ` +
        `(it is an optionalDependency — install may have skipped it, or it ` +
        `is not yet published). Set PARABUN_BIN=/abs/path/to/parabun to use a ` +
        `local build, or run \`bun install\` with the platform package available.`,
    );
  }

  const actual = sha256File(binPath);
  if (actual !== entry.sha256) {
    throw new Error(
      `@lyku/parabun-bin: sha256 mismatch for ${entry.pkg} (${key}).\n` +
        `  expected: ${entry.sha256}\n` +
        `  actual:   ${actual}\n` +
        `The pinned binary does not match the baked manifest — refusing to ` +
        `run a binary the boundary contract did not vouch for.`,
    );
  }

  return {
    path: binPath,
    version: manifest.version,
    verified: true,
    source: "package",
  };
}

/** Convenience: just the absolute path (throws if unresolved). */
export function parabunPath() {
  return resolveParabun().path;
}

/** The pinned parabun release version (from the baked manifest). */
export function pinnedVersion() {
  return readManifest().version;
}
