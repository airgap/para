#!/usr/bin/env parabun
// Regenerates the Para-token section of the LSP's
// KNOWN_GLOBAL_IDENTIFIERS Set from src/language-surface.ts.
//
// The target file (editors/lsp/parabun-lsp.ts) contains a marker
// region:
//
//   // ─── codegen:lsp-allowlist:begin ─
//   ... auto-generated tokens ...
//   // ─── codegen:lsp-allowlist:end ─
//
// This script reads LSP_ALLOWLIST_TOKENS from the catalog, formats
// them as TypeScript string-literal entries inside the marker block,
// and writes the file back. Everything OUTSIDE the marker block, the
// hand-curated JS/Web/Bun globals (window, fetch, Bun, …), is
// preserved exactly.
//
// `scripts/codegen.ts --check` regenerates this into a temp dir and fails
// if the result differs from the committed file.

import { LSP_ALLOWLIST_TOKENS } from "../src/language-surface";
import { codegenRoots } from "./codegen-roots";
import * as fs from "node:fs";
import * as path from "node:path";

const REL = "editors/lsp/parabun-lsp.ts";
const roots = codegenRoots(process.argv);
const TARGET = path.join(roots.repoIn, REL);
const OUT = path.join(roots.repoOut, REL);
const BEGIN_MARKER = "// ─── codegen:lsp-allowlist:begin ──────────────────────────────────";
const END_MARKER = "// ─── codegen:lsp-allowlist:end ────────────────────────────────────";

function regenerate(content: string, tokens: string[]): string {
  const beginIdx = content.indexOf(BEGIN_MARKER);
  const endIdx = content.indexOf(END_MARKER);
  if (beginIdx === -1) {
    console.error(`Begin marker not found in ${TARGET}.`);
    console.error(`Expected: ${BEGIN_MARKER}`);
    process.exit(1);
  }
  if (endIdx === -1 || endIdx < beginIdx) {
    console.error(`End marker not found (or out of order) in ${TARGET}.`);
    console.error(`Expected: ${END_MARKER}`);
    process.exit(1);
  }
  // Compose the replacement block. Every line inside the Set body is
  // 2-space indented to match the surrounding member indentation. The
  // marker constants don't carry the indent. That's added when
  // composing the replacement so the marker strings themselves can be
  // searched for at arbitrary indentation levels in future variants.
  const lines = [
    BEGIN_MARKER,
    "// AUTO-GENERATED from src/language-surface.ts. Run `parabun run codegen`",
    "// in para/ to regenerate. `parabun run codegen:check` fails if the",
    "// committed contents drift from the catalog. Do not hand-edit; add new",
    "// Para tokens to LSP_ALLOWLIST_TOKENS in language-surface.ts instead.",
    ...tokens.map(t => `${JSON.stringify(t)},`),
    END_MARKER,
  ];
  // 2-space indent matches the Set-member indentation in the source
  // file. Lines that already happen to start with whitespace (none of
  // ours do) would compound. Keep the body strings flush-left.
  const replacement = lines
    .map(l => "  " + l)
    .join("\n")
    .trimStart();

  return content.slice(0, beginIdx) + replacement + content.slice(endIdx + END_MARKER.length);
}

function main(): void {
  const original = fs.readFileSync(TARGET, "utf8");
  const updated = regenerate(original, LSP_ALLOWLIST_TOKENS);
  // With --out the copy is written even when unchanged: --check compares
  // whatever lands there, and a missing file would read as drift.
  if (updated === original && OUT === TARGET) {
    console.log(`✓ ${TARGET} already up to date (${LSP_ALLOWLIST_TOKENS.length} Para tokens)`);
    return;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, updated);
  console.log(`✓ wrote ${OUT} (${LSP_ALLOWLIST_TOKENS.length} Para tokens)`);
}

main();
