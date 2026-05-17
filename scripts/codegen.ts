#!/usr/bin/env bun
// Top-level codegen runner: invokes every src/language-surface.ts
// consumer in one shot.
//
//   bun scripts/codegen.ts           # regenerate everything
//   bun scripts/codegen.ts --check   # exit non-zero if anything is dirty
//
// The CI flow is `bun scripts/codegen.ts --check` — passes when the
// committed grammars / LSP allowlist match what the catalog would
// produce. Local devs run `bun scripts/codegen.ts` (no flag) after
// editing the catalog to refresh the auxiliary files.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// Repo-root relative — works in any checkout location (dev box at
// /raid/parabun, CI docker workspace at /raid/jenkins-workspaces/…).
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

interface Generator {
  description: string;
  script: string;
  /** Files this generator writes. Used by --check mode to detect drift. */
  outputs: string[];
}

const GENERATORS: Generator[] = [
  {
    description: "TextMate grammars (inject + site main grammars)",
    script: "scripts/generate-grammars.ts",
    outputs: [
      // Inject grammars (editor + site) — applied via injectTo on top
      // of base TS/JS scopes.
      path.join(REPO_ROOT, "editors/vscode/parabun/syntaxes/parabun-inject.tmLanguage.json"),
      "/raid/para-site/src/grammars/parabun-inject.tmLanguage.json",
      // Per-extension main grammars for the site (Shiki reads these,
      // falls back to embedded TS/JS for non-Para tokens). Editor main
      // grammars stay hand-maintained because they bundle bigger
      // function-declaration / function-expression repository groups
      // that aren't catalog material.
      "/raid/para-site/src/grammars/parabun-ts.tmLanguage.json",
      "/raid/para-site/src/grammars/parabun-tsx.tmLanguage.json",
      "/raid/para-site/src/grammars/parabun-js.tmLanguage.json",
      "/raid/para-site/src/grammars/parabun-jsx.tmLanguage.json",
    ],
  },
  {
    description: "LSP allowlist (parabun-lsp.ts marker block)",
    script: "scripts/generate-lsp-allowlist.ts",
    outputs: [path.join(REPO_ROOT, "editors/lsp/parabun-lsp.ts")],
  },
  {
    description: "Splash demo highlighter kw regex (para-site transpile.js marker block)",
    script: "scripts/generate-splash-highlighter.ts",
    outputs: ["/raid/para-site/public/transpile.js"],
  },
];

const CHECK_MODE = process.argv.includes("--check");

function snapshot(paths: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of paths) {
    // Files outside the present checkout (e.g. /raid/para-site/* on a
    // CI agent that only has the parabun repo) are omitted from the
    // snapshot — they're handled by the individual generators which
    // skip absent directories. The diff in --check mode then only
    // compares files we actually have.
    if (fs.existsSync(p)) m.set(p, fs.readFileSync(p, "utf8"));
  }
  return m;
}

function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [p, post] of after) {
    const pre = before.get(p);
    if (pre !== post) changed.push(p);
  }
  return changed;
}

function runOne(gen: Generator): void {
  const result = spawnSync("bun", [gen.script], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`✗ ${gen.script} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

function main(): void {
  // Snapshot every file BEFORE running any generator. After all have
  // run, diff each output against its pre-run content; any change
  // means the committed file was stale.
  const allOutputs = GENERATORS.flatMap(g => g.outputs);
  const before = snapshot(allOutputs);

  for (const gen of GENERATORS) {
    console.log(`▸ ${gen.description}`);
    runOne(gen);
  }

  if (!CHECK_MODE) return;

  const after = snapshot(allOutputs);
  const dirty = diffSnapshots(before, after);
  if (dirty.length === 0) {
    console.log("\n✓ codegen check passed — all generated files in sync with src/language-surface.ts");
    return;
  }

  console.error("\n✗ codegen check failed — these files are out of sync with src/language-surface.ts:");
  for (const p of dirty) console.error(`  ${p}`);
  console.error("\nRun `bun scripts/codegen.ts` locally, commit the changes, and re-push.");
  process.exit(1);
}

main();
