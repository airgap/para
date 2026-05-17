#!/usr/bin/env bun
// Generates TextMate inject grammars from src/language-surface.ts.
//
// Two targets:
//   --target=editor   → editors/vscode/parabun/syntaxes/parabun-inject.tmLanguage.json
//   --target=site     → /raid/para-site/src/grammars/parabun-inject.tmLanguage.json
//   (no flag)         → emits both
//
// Editor and site targets share identical pattern arrays — the only
// differences are wrapper fields (name vs displayName, injectTo, and
// the injectionSelector ordering) that platforms care about.
//
// CI gate scripts/codegen/check-clean.ts (TODO) re-runs this and
// fails if the committed files differ from the regenerated output —
// catching the "added a keyword to the parser, forgot to update the
// grammar" class of bug.

import { LANGUAGE_SURFACE, type LanguageEntry } from "../src/language-surface";
import * as fs from "node:fs";
import * as path from "node:path";

// Repo-root relative for the editor target (works on dev box AND CI
// docker workspace). Site target stays absolute — it's a sibling repo
// that may or may not be present; the existsSync guards below handle
// the "not present" case.
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

type Target = "editor" | "site";

/** Per-extension main grammar metadata. Shape mirrors what Shiki and
 *  VSCode TextMate consumers expect — site target embeds the base TS
 *  grammar via `embeddedLangs` (Shiki feature), editor target lets
 *  VSCode's TextMate engine load the base TS grammar by scope name. */
interface PerExtension {
  display: string;
  /** Grammar `name` field (Shiki uses this as the language id). */
  name: string;
  scopeName: string;
  /** Shiki `embeddedLangs` — declares grammar dependencies, not a
   *  fall-through. To actually pick up unmatched tokens (string
   *  literals, base TS/JS keywords, comments) the patterns array
   *  also needs `{ "include": <baseScope> }` as its last entry. */
  embeddedLangs: string[];
  /** Base-grammar scope to include as the final pattern so any
   *  unmatched tokens get handled by the embedded grammar. Without
   *  this, things like `import` / `const` / strings / comments get
   *  no highlight color in the rendered docs. */
  baseScope: string;
  /** Output file path under the site grammars dir. */
  basename: string;
}

const PER_EXTENSION: PerExtension[] = [
  {
    display: "ParaBun TypeScript",
    name: "parabun-ts",
    scopeName: "source.pts",
    embeddedLangs: ["typescript"],
    baseScope: "source.ts",
    basename: "parabun-ts.tmLanguage.json",
  },
  {
    display: "ParaBun TSX",
    name: "parabun-tsx",
    scopeName: "source.ptsx",
    embeddedLangs: ["tsx"],
    baseScope: "source.tsx",
    basename: "parabun-tsx.tmLanguage.json",
  },
  {
    display: "ParaBun JavaScript",
    name: "parabun-js",
    scopeName: "source.pjs",
    embeddedLangs: ["javascript"],
    baseScope: "source.js",
    basename: "parabun-js.tmLanguage.json",
  },
  {
    display: "ParaBun JSX",
    name: "parabun-jsx",
    scopeName: "source.pjsx",
    embeddedLangs: ["jsx"],
    baseScope: "source.js.jsx",
    basename: "parabun-jsx.tmLanguage.json",
  },
];

const TARGETS: Record<Target, { injectPath: string; injectWrapper: (patterns: any[]) => any; mainDir?: string }> = {
  editor: {
    injectPath: path.join(REPO_ROOT, "editors/vscode/parabun/syntaxes/parabun-inject.tmLanguage.json"),
    injectWrapper: patterns => ({
      $schema: "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
      name: "Parabun Keyword Injection",
      scopeName: "inject.parabun-keywords",
      // `.pts/.ptsx/.pjs/.pjsx` files: the whole file is script, scope
      // is `source.p*`. `.pui` files: the file is `source.pui` and the
      // `<script>` body is embedded `source.ts`/`source.js` (set by
      // parabun-ui.tmLanguage's contentName) regardless of `lang`, so we
      // target that embedded scope *within* source.pui — keyword
      // highlighting then works for bare `<script>` / `lang="ts"` /
      // `lang="pts"` alike, without bleeding into the .pui markup.
      injectionSelector:
        "L:source.pts -string -comment, L:source.ptsx -string -comment, L:source.pjs -string -comment, L:source.pjsx -string -comment, L:source.pui source.ts -string -comment, L:source.pui source.js -string -comment",
      patterns,
    }),
    // Editor main grammars (parabun-ts.tmLanguage.json et al.) are
    // hand-maintained because their `repository` carries weighty
    // function-declaration / function-expression groups with embedded
    // TS-grammar patterns that aren't catalog material. The inject
    // grammar covers every Para-specific token; the editor main
    // grammars dedupe-with-it but won't drift since both pick up the
    // same regex from the same source.
  },
  site: {
    injectPath: "/raid/para-site/src/grammars/parabun-inject.tmLanguage.json",
    injectWrapper: patterns => ({
      $schema: "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
      displayName: "ParaBun Keyword Injection",
      name: "parabun-inject",
      scopeName: "inject.parabun-keywords",
      injectTo: ["source.pts", "source.ptsx", "source.pjs", "source.pjsx"],
      injectionSelector:
        "L:source.pts -comment -string, L:source.ptsx -comment -string, L:source.pjs -comment -string, L:source.pjsx -comment -string",
      patterns,
    }),
    // Site main grammars (parabun-ts/tsx/js/jsx) are catalog-driven.
    // Shiki uses `embeddedLangs` to fall back to the base TS/JS grammar
    // for everything we don't claim, so the per-extension files only
    // need: top-level metadata + the same Para-specific patterns the
    // inject grammar emits.
    mainDir: "/raid/para-site/src/grammars",
  },
};

/** Build the TextMate `patterns` array for the inject grammar. Each
 *  catalog entry becomes one pattern; entries flagged `inject: false`
 *  (the underscore placeholder, for example — LSP-allowlist only) are
 *  skipped. Captures get emitted only when the entry has a `scopes`
 *  map; entries with a `name` get a flat scope on the whole match. */
function buildInjectPatterns(entries: LanguageEntry[]): any[] {
  return entries
    .filter(e => e.inject !== false)
    .map(e => {
      const pattern: any = {};
      if (e.doc) pattern.comment = e.doc;
      pattern.match = e.pattern;
      if (e.scopes) {
        // TextMate wants each capture as { "1": { "name": "scope" } }.
        const captures: Record<string, { name: string }> = {};
        for (const [k, v] of Object.entries(e.scopes)) {
          captures[k] = { name: v };
        }
        pattern.captures = captures;
      } else if (e.name) {
        pattern.name = e.name;
      }
      return pattern;
    });
}

/** Sanity check the catalog before emit. Each entry needs either
 *  `scopes` or `name`; `inject: false` entries are exempt because they
 *  contribute only to non-grammar surfaces (LSP, ts-plugin). */
function validateCatalog(entries: LanguageEntry[]): void {
  const ids = new Set<string>();
  const errors: string[] = [];
  for (const e of entries) {
    if (ids.has(e.id)) errors.push(`duplicate id: ${e.id}`);
    ids.add(e.id);
    if (e.inject === false) continue;
    if (!e.scopes && !e.name) {
      errors.push(`${e.id}: needs either \`scopes\` or \`name\` for the inject grammar`);
    }
    if (e.scopes && e.name) {
      errors.push(`${e.id}: can't set both \`scopes\` and \`name\``);
    }
  }
  if (errors.length > 0) {
    console.error("Catalog validation failed:");
    for (const err of errors) console.error("  " + err);
    process.exit(1);
  }
}

/** Write the inject grammar for a target (editor or site). */
function writeInject(target: Target): void {
  const patterns = buildInjectPatterns(LANGUAGE_SURFACE);
  const grammar = TARGETS[target].injectWrapper(patterns);
  const out = JSON.stringify(grammar, null, 2) + "\n";
  const outPath = TARGETS[target].injectPath;
  // Skip with a warning when the target file's directory doesn't
  // exist. Common on CI agents where /raid/para-site isn't checked
  // out, or in fresh clones that haven't pulled the sibling repo.
  // The catalog-driven --check still catches drift on whatever
  // targets ARE present.
  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) {
    console.log(`⊘ skipping ${outPath} (directory absent; target=${target})`);
    return;
  }
  fs.writeFileSync(outPath, out);
  console.log(`✓ wrote ${outPath} (${patterns.length} patterns)`);
}

/** Write the four site main grammars (parabun-ts/tsx/js/jsx). All four
 *  carry the same catalog-driven patterns; they differ only in
 *  top-level metadata (name, scopeName, embeddedLangs). Shiki's
 *  `embeddedLangs` lets us fall back to the base TS/JS grammar for
 *  anything the catalog doesn't claim. */
function writeSiteMainGrammars(): void {
  const mainDir = TARGETS.site.mainDir;
  if (!mainDir) return;
  if (!fs.existsSync(mainDir)) {
    console.log(`⊘ skipping site main grammars (${mainDir} absent)`);
    return;
  }
  const catalogPatterns = buildInjectPatterns(LANGUAGE_SURFACE);
  for (const ext of PER_EXTENSION) {
    // Top-level patterns: a single `include` to a repository group
    // that holds all catalog patterns, then the base-grammar include.
    // The repository-group form is how the editor's parabun-{ts,js,…}
    // grammars are organized; replicating it here avoids a quirk
    // where Shiki's onig wrapper treated flat sibling patterns
    // (catalog patterns AND a `source.X` include in the same top-
    // level array) as "switch to source.X immediately and ignore
    // siblings." That made the pjs/jsx grammars never run their
    // Para-specific patterns even though pts did (subtle base-
    // grammar precedence difference).
    const grammar = {
      $schema: "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
      displayName: ext.display,
      name: ext.name,
      scopeName: ext.scopeName,
      embeddedLangs: ext.embeddedLangs,
      patterns: [{ include: "#parabun-keywords" }, { include: ext.baseScope }],
      repository: {
        "parabun-keywords": {
          patterns: catalogPatterns,
        },
      },
    };
    const outPath = path.join(mainDir, ext.basename);
    fs.writeFileSync(outPath, JSON.stringify(grammar, null, 2) + "\n");
    console.log(`✓ wrote ${outPath} (${catalogPatterns.length} catalog in repository, scope=${ext.scopeName})`);
  }
}

function main(): void {
  validateCatalog(LANGUAGE_SURFACE);

  const arg = process.argv.find(a => a.startsWith("--target="));
  const target = arg ? (arg.split("=")[1] as Target) : null;

  if (target) {
    if (!(target in TARGETS)) {
      console.error(`Unknown --target=${target}. Expected one of: ${Object.keys(TARGETS).join(", ")}`);
      process.exit(1);
    }
    writeInject(target);
    if (target === "site") writeSiteMainGrammars();
  } else {
    for (const t of Object.keys(TARGETS) as Target[]) writeInject(t);
    writeSiteMainGrammars();
  }
}

main();
