// C4a — `.svelte` → `.pui` migration driver.
//
// SAFETY: dry-run is the DEFAULT. `--write` is required to touch disk.
// Even then, only files that `safeMigrate` *verifies compile* are
// rewritten; would-regress and no-op files are left exactly as-is. The
// driver core (`runMigration`) takes injected compile/lower so it stays
// dependency-free + unit-testable; `main()` wires the real fork
// compiler + lowerPuiReactivity.
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve as resolvePath } from "node:path";
import { safeMigrate } from "./index.ts";

export interface MigrationDeps {
  compile: (src: string, opts: Record<string, unknown>) => unknown;
  lower: (src: string, runtime?: string, lp?: boolean, hmr?: boolean) => string;
}
export interface MigrationOptions {
  write: boolean; // false = dry-run (default)
  /**
   * Dirs scanned for files that import the migrated components, so
   * extensioned `import './Foo.svelte'` specifiers can be rewritten to
   * `'./Foo.pui'`. WITHOUT this a rename wave breaks the build (real:
   * si-bits has 527 extensioned .svelte imports). Only specifiers that
   * resolve to a file migrated in THIS run are touched — conservative.
   */
  importRoots?: string[];
}
export interface MigrationSummary {
  migrated: string[]; // .svelte paths rewritten → .pui
  skipped: string[]; // would-regress; left as .svelte
  noop: string[]; // nothing transformable; left as .svelte
  importsRewritten: { file: string; specifiers: number }[];
}

/**
 * Migrate a list of `.svelte` files. Pure w.r.t. its `deps`; only
 * touches disk when `opts.write` is true (and only for verified-safe
 * migrations). A migrated file is written as a sibling `.pui` and the
 * original `.svelte` removed; skipped/no-op files are untouched.
 */
export function runMigration(files: string[], opts: MigrationOptions, deps: MigrationDeps): MigrationSummary {
  const sum: MigrationSummary = { migrated: [], skipped: [], noop: [], importsRewritten: [] };
  // 1) classify + (optionally) rename. Defer writes until the migrated
  // set is known so importer rewrites stay consistent in dry-run too.
  const toRename: { from: string; to: string; code: string }[] = [];
  for (const f of files) {
    if (!f.endsWith(".svelte")) continue;
    let src: string;
    try {
      src = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const r = safeMigrate(src, deps.compile, deps.lower);
    if (r.migrated) {
      sum.migrated.push(f);
      toRename.push({ from: f, to: f.replace(/\.svelte$/, ".pui"), code: r.code });
    } else if (r.skippedReason && /regress|threw/.test(r.skippedReason)) {
      sum.skipped.push(f);
    } else {
      sum.noop.push(f);
    }
  }

  // 2) rewrite extensioned importers BEFORE deleting originals (so
  // resolution still matches the pre-rename .svelte path).
  const migratedAbs = new Set(toRename.map(r => resolvePath(r.from)));
  if (migratedAbs.size && opts.importRoots?.length) {
    const importers = listSource(opts.importRoots);
    const specRe = /(from\s*['"]|import\s*['"])(\.\.?\/[^'"]+?)\.svelte(['"])/g;
    for (const imp of importers) {
      let txt: string;
      try {
        txt = readFileSync(imp, "utf8");
      } catch {
        continue;
      }
      let n = 0;
      const next = txt.replace(specRe, (full, pre, spec, post) => {
        const target = resolvePath(dirname(imp), spec + ".svelte");
        if (!migratedAbs.has(target)) return full; // unrelated .svelte import — leave
        n++;
        return `${pre}${spec}.pui${post}`;
      });
      if (n > 0) {
        sum.importsRewritten.push({ file: imp, specifiers: n });
        if (opts.write) writeFileSync(imp, next);
      }
    }
  }

  // 3) apply renames (write .pui, remove .svelte) — only with --write.
  if (opts.write) {
    for (const { from, to, code } of toRename) {
      writeFileSync(to, code);
      if (to !== from) rmSync(from);
    }
  }
  return sum;
}

function listSource(roots: string[]): string[] {
  const out: string[] = [];
  for (const p of roots) {
    try {
      out.push(
        ...execFileSync(
          "find",
          [
            p,
            "-type",
            "f",
            "(",
            "-name",
            "*.svelte",
            "-o",
            "-name",
            "*.pui",
            "-o",
            "-name",
            "*.ts",
            "-o",
            "-name",
            "*.js",
            ")",
            "-not",
            "-path",
            "*/node_modules/*",
          ],
          { encoding: "utf8" },
        )
          .trim()
          .split("\n")
          .filter(Boolean),
      );
    } catch {
      /* ignore */
    }
  }
  return out;
}

function listSvelte(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    try {
      const found = execFileSync("find", [p, "-name", "*.svelte", "-not", "-path", "*/node_modules/*"], {
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .filter(Boolean);
      out.push(...found);
    } catch {
      if (p.endsWith(".svelte")) out.push(p);
    }
  }
  return out;
}

export async function main(argv: string[]): Promise<number> {
  const write = argv.includes("--write");
  const flags = argv.filter(a => a.startsWith("--"));
  const paths = argv.filter(a => !a.startsWith("--"));
  if (paths.length === 0) {
    console.error(
      "usage: para-codemod <path…> [--write] [--import-roots=<dir,dir>]\n" +
        "  dry-run unless --write. --import-roots: dirs whose extensioned\n" +
        "  `import './X.svelte'` specifiers are rewritten to `.pui` for\n" +
        "  files migrated this run (REQUIRED for a real rename wave —\n" +
        "  otherwise the build breaks on stale .svelte imports).",
    );
    return 2;
  }
  const irFlag = flags.find(f => f.startsWith("--import-roots="));
  const importRoots = irFlag ? irFlag.slice("--import-roots=".length).split(",").filter(Boolean) : paths;
  // Resolve real deps lazily so the testable core stays dep-free.
  const { lowerPuiReactivity } = await import("@lyku/para-preprocess");
  const { compile } = await import("@lyku/para-ui/compiler");
  const files = listSvelte(paths);
  const sum = runMigration(files, { write, importRoots }, { compile, lower: lowerPuiReactivity });
  const tx = sum.migrated.length + sum.skipped.length;
  console.log(`${write ? "MIGRATED" : "DRY-RUN (no --write)"} — ${files.length} .svelte scanned`);
  console.log(`  ✓ ${write ? "migrated" : "would migrate"} (verified-compile): ${sum.migrated.length}`);
  console.log(`  ↷ skipped (would regress → left as .svelte): ${sum.skipped.length}`);
  console.log(`  · no-op (nothing to transform): ${sum.noop.length}`);
  if (tx)
    console.log(
      `  → ${Math.round((sum.migrated.length / tx) * 100)}% of transformable safely migrated; 0 regressions by construction`,
    );
  const totalSpecs = sum.importsRewritten.reduce((a, b) => a + b.specifiers, 0);
  console.log(
    `  ↪ importers ${write ? "rewritten" : "to rewrite"}: ${sum.importsRewritten.length} files, ${totalSpecs} .svelte→.pui specifiers`,
  );
  if (!write && sum.migrated.length) console.log(`\n  re-run with --write to apply.`);
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(c => process.exit(c));
}
