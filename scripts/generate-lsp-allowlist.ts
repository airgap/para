#!/usr/bin/env bun
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
// and writes the file back. Everything OUTSIDE the marker block — the
// hand-curated JS/Web/Bun globals (window, fetch, Bun, …) — is
// preserved exactly.
//
// CI gate scripts/codegen/check-clean.ts (TODO) re-runs this and
// fails if the regenerated diff is non-empty.

import { LSP_ALLOWLIST_TOKENS } from "../src/language-surface";
import * as fs from "node:fs";
import * as path from "node:path";

const TARGET = path.resolve(import.meta.dirname, "../editors/lsp/parabun-lsp.ts");
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
  // marker constants don't carry the indent — that's added when
  // composing the replacement so the marker strings themselves can be
  // searched for at arbitrary indentation levels in future variants.
  const lines = [
    BEGIN_MARKER,
    "// AUTO-GENERATED from src/language-surface.ts. Run `bun scripts/generate-lsp-allowlist.ts`",
    "// to regenerate. The CI gate at scripts/codegen/check-clean.ts fails",
    "// if the committed contents drift from the catalog. Do not hand-edit",
    "// — add new Para tokens to LSP_ALLOWLIST_TOKENS in language-surface.ts",
    "// instead.",
    ...tokens.map(t => `${JSON.stringify(t)},`),
    END_MARKER,
  ];
  // 2-space indent matches the Set-member indentation in the source
  // file. Lines that already happen to start with whitespace (none of
  // ours do) would compound — keep the body strings flush-left.
  const replacement = lines
    .map(l => "  " + l)
    .join("\n")
    .trimStart();

  return content.slice(0, beginIdx) + replacement + content.slice(endIdx + END_MARKER.length);
}

function main(): void {
  const original = fs.readFileSync(TARGET, "utf8");
  const updated = regenerate(original, LSP_ALLOWLIST_TOKENS);
  if (updated === original) {
    console.log(`✓ ${TARGET} already up to date (${LSP_ALLOWLIST_TOKENS.length} Para tokens)`);
    return;
  }
  fs.writeFileSync(TARGET, updated);
  console.log(`✓ regenerated ${TARGET} (${LSP_ALLOWLIST_TOKENS.length} Para tokens)`);
}

main();
