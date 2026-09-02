// Parity test runner: feeds each fixture through both transpilers
// (canonical Parabun via subprocess + our standalone in-process), then
// compares the normalized output. Prints a diff for any mismatch.
//
// The canonical binary comes from @lyku/parabun-bin (the pinned-release
// resolver: the P2 boundary mechanism). Local runs: set PARABUN_BIN to
// an absolute path to a parabun binary (the documented escape hatch).
//
// Exit code 0 if every fixture matches after normalization, 1 otherwise.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pinnedVersion, resolveParabun } from "@lyku/parabun-bin";
import { transpile } from "@lyku/para-transpile";
import { normalize } from "./normalize";

// Mirror of the parity guard in para/jenkins/Jenkinsfile (~L106): the
// pinned-binary parity infra is not live yet (scaffold pin `0.0.0-pin.*`,
// P2-c carrier publish + bake-manifest pending), so parity cannot run
// without a real pin or a local PARABUN_BIN. Jenkins skips it loudly
// rather than hard-failing the rest of CI; this bare `nx test` target must
// agree, or `nx test parity` / `nx affected -t test` fails on an expected,
// already-handled condition. The escape hatch still runs: an explicit
// PARABUN_BIN means the caller has a binary and wants parity.
//
// Delete this guard the day P2-c lands: a real pin + baked manifest make
// parity runnable and this branch dead.
const pin = pinnedVersion();
if (!process.env.PARABUN_BIN && (pin === "" || pin.startsWith("0.0.0-pin."))) {
  console.warn(
    `parity: scaffold/placeholder pin (${pin}): parity skipped ` +
      `(pinned-binary infra not yet live). ` +
      `Set PARABUN_BIN=/abs/path/to/parabun to run against a local build.`,
  );
  process.exit(0);
}

let PARABUN: string;
try {
  PARABUN = resolveParabun().path;
} catch (e) {
  console.error(`parity: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
}
const FIXTURES_DIR = new URL("./fixtures", import.meta.url).pathname;
const CANONICAL_SCRIPT = new URL("./canonical.ts", import.meta.url).pathname;

function transpileViaParabun(fixturePath: string): string {
  const result = spawnSync(PARABUN, [CANONICAL_SCRIPT, fixturePath], {
    encoding: "utf8",
    env: { ...process.env, BUN_DEBUG_QUIET_LOGS: "1" },
  });
  if (result.status !== 0) {
    throw new Error(`parabun transpile failed for ${fixturePath}:\n${result.stderr}`);
  }
  // Strip any debug-build noise that leaked to stdout (the canonical script
  // itself only writes the transpiled source, but Parabun's debug build
  // sometimes prints a banner before user code runs).
  return result.stdout.replace(/^WARNING: ASAN[^\n]*\n/gm, "");
}

function transpileViaStandalone(src: string): string {
  return transpile(src);
}

function diffLines(a: string, b: string): string {
  // Tiny line-by-line diff for readability. Not a real LCS, just shows
  // first divergent line + a few lines of context.
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const max = Math.max(aLines.length, bLines.length);
  const out: string[] = [];
  for (let i = 0; i < max; i++) {
    const al = aLines[i] ?? "<<EOF>>";
    const bl = bLines[i] ?? "<<EOF>>";
    if (al !== bl) {
      out.push(`  L${i + 1}:`);
      out.push(`    canonical: ${JSON.stringify(al)}`);
      out.push(`    standalone:${JSON.stringify(bl)}`);
      if (out.length > 20) {
        out.push("    … (truncated)");
        break;
      }
    }
  }
  return out.join("\n");
}

// Known divergences: fixtures we can't byte-match because the canonical
// Zig parser does work the standalone deliberately delegates to the host.
// The behavior is equivalent at runtime; we just don't reproduce the
// canonical's lowering shape.
//
// Currently empty: every fixture parity-matches after normalization.
const KNOWN_DIVERGENCES: Record<string, string> = {};

const fixtures = readdirSync(FIXTURES_DIR)
  .filter(f => f.endsWith(".pts"))
  .sort();

if (fixtures.length === 0) {
  console.error(`parity: no .pts fixtures in ${FIXTURES_DIR}`);
  process.exit(1);
}

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: { fixture: string; canonical: string; standalone: string }[] = [];

for (const f of fixtures) {
  if (KNOWN_DIVERGENCES[f]) {
    console.log(`◇ ${f} (known divergence: see KNOWN_DIVERGENCES)`);
    skipped++;
    continue;
  }
  const path = join(FIXTURES_DIR, f);
  const src = readFileSync(path, "utf8");
  let canonical: string;
  let standalone: string;
  try {
    canonical = normalize(transpileViaParabun(path));
    standalone = normalize(transpileViaStandalone(src));
  } catch (e) {
    console.error(`✗ ${f}: ${e instanceof Error ? e.message : e}`);
    failed++;
    continue;
  }
  if (canonical === standalone) {
    console.log(`✓ ${f}`);
    passed++;
  } else {
    console.log(`✗ ${f}`);
    failed++;
    failures.push({ fixture: f, canonical, standalone });
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped (${fixtures.length} fixtures)`);

// Canary mode (nightly CI, PARABUN_BIN pointed at the LATEST parabun
// release, not the pinned one): report drift, never fail. Early warning
// for "stale-but-green": a parser change landed in parabun but the
// para pin has not been bumped yet. The blocking gate stays the
// default-mode run against the PINNED binary; this only informs.
const CANARY = process.argv.includes("--canary") || process.env.PARABUN_PARITY_CANARY === "1";

if (failures.length > 0) {
  for (const fail of failures) {
    console.log(`\n──── ${fail.fixture} ────`);
    console.log(diffLines(fail.canonical, fail.standalone));
  }
  if (CANARY) {
    console.log(
      `\n⚠ CANARY DRIFT (non-blocking): ${failures.length} fixture(s) diverge ` +
        `against the LATEST parabun. The mirror likely needs updating before ` +
        `the next pin bump: file/track it; do NOT fail CI on this.`,
    );
    process.exit(0);
  }
  process.exit(1);
}

if (CANARY) console.log(`\n✓ canary: mirror still matches the latest parabun. No pending drift.`);
