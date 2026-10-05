#!/usr/bin/env parabun
// Top-level codegen runner: invokes every src/language-surface.ts
// consumer in one shot.
//
//   parabun scripts/codegen.ts                         # regenerate the in-repo files
//   parabun scripts/codegen.ts --check                 # exit non-zero if any is stale
//   parabun scripts/codegen.ts --site=/raid/para-site  # also regenerate para-site
//   parabun scripts/codegen.ts --check --site=<dir>    # also compare para-site
//
// --check is read-only: it regenerates into a temp dir and diffs that
// against the committed files, so a stale file fails the check and is
// left exactly as it was. Without --site nothing outside this workspace
// is read or written; para-site (site grammars and the splash
// highlighter) is a separate checkout and is only touched when named.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

interface Generator {
  description: string;
  script: string;
  /** Outputs relative to the repo root. */
  repoOutputs: string[];
  /** Outputs relative to the para-site checkout. */
  siteOutputs: string[];
}

const GENERATORS: Generator[] = [
  {
    description: "TextMate grammars (editor inject, plus site inject + main grammars with --site)",
    script: "scripts/generate-grammars.ts",
    repoOutputs: ["editors/vscode/parabun/syntaxes/parabun-inject.tmLanguage.json"],
    siteOutputs: [
      "src/grammars/parabun-inject.tmLanguage.json",
      "src/grammars/parabun-ts.tmLanguage.json",
      "src/grammars/parabun-tsx.tmLanguage.json",
      "src/grammars/parabun-js.tmLanguage.json",
      "src/grammars/parabun-jsx.tmLanguage.json",
    ],
  },
  {
    description: "LSP allowlist (parabun-lsp.ts marker block)",
    script: "scripts/generate-lsp-allowlist.ts",
    repoOutputs: ["editors/lsp/parabun-lsp.ts"],
    siteOutputs: [],
  },
  {
    description: "Splash demo highlighter kw regex (para-site transpile.js marker block)",
    script: "scripts/generate-splash-highlighter.ts",
    repoOutputs: [],
    siteOutputs: ["public/transpile.js"],
  },
];

const CHECK_MODE = process.argv.includes("--check");
const siteArg = process.argv.find(a => a.startsWith("--site="));
const SITE_ROOT = siteArg ? path.resolve(siteArg.slice("--site=".length)) : null;

function runOne(gen: Generator, outDir: string | null): void {
  const args = [gen.script];
  if (SITE_ROOT) args.push(`--site=${SITE_ROOT}`);
  if (outDir) args.push(`--out=${outDir}`);
  const result = spawnSync("parabun", args, { cwd: REPO_ROOT, stdio: "inherit" });
  // Thrown, not process.exit, so check()'s finally still removes its temp dir.
  if (result.status !== 0) throw new Error(`${gen.script} failed with exit code ${result.status}`);
}

function selected(): Generator[] {
  return GENERATORS.filter(g => g.repoOutputs.length > 0 || SITE_ROOT);
}

/** Pairs of [committed, regenerated] for every output this run covers. */
function comparisons(outDir: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (const gen of selected()) {
    for (const rel of gen.repoOutputs) pairs.push([path.join(REPO_ROOT, rel), path.join(outDir, "repo", rel)]);
    if (!SITE_ROOT) continue;
    for (const rel of gen.siteOutputs) pairs.push([path.join(SITE_ROOT, rel), path.join(outDir, "site", rel)]);
  }
  return pairs;
}

function check(): void {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "para-codegen-check-"));
  const dirty: string[] = [];
  try {
    for (const gen of selected()) {
      console.log(`▸ ${gen.description}`);
      runOne(gen, outDir);
    }
    for (const [committed, regenerated] of comparisons(outDir)) {
      const diff = spawnSync("diff", ["-u", committed, regenerated], { encoding: "utf8" });
      if (diff.status === 0) continue;
      if (diff.status !== 1) throw new Error(`diff ${committed} failed: ${diff.stderr}`);
      process.stderr.write(diff.stdout);
      dirty.push(committed);
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }

  if (dirty.length === 0) {
    console.log("\n✓ codegen check passed: all generated files in sync with src/language-surface.ts");
    return;
  }
  console.error("\n✗ codegen check failed: these files are out of sync with src/language-surface.ts:");
  for (const p of dirty) console.error(`  ${p}`);
  const regen = SITE_ROOT ? `parabun run codegen --site=${SITE_ROOT}` : "parabun run codegen";
  console.error(`\nRun \`${regen}\` in para/, commit the changes, and re-push.`);
  process.exit(1);
}

if (CHECK_MODE) {
  check();
} else {
  for (const gen of selected()) {
    console.log(`▸ ${gen.description}`);
    runOne(gen, null);
  }
}
