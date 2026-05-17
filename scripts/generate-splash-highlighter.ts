#!/usr/bin/env bun
// Regenerates the splash demo highlighter's kw-regex pair from the
// catalog (src/language-surface.ts).
//
// The target file is /raid/para-site/public/transpile.js — the
// inline regex-based highlighter used by the splash demo on
// para.script.dev. It's NOT TextMate / NOT Shiki — just a small
// alternation regex. Catalog drives the keyword list inside a marker
// block.
//
//   // ─── codegen:splash-keywords:begin ──
//   ... two const kw = ... assignments ...
//   // ─── codegen:splash-keywords:end ────
//
// The .pts-side regex unions SPLASH_PARA_KEYWORDS with
// SPLASH_JS_KEYWORDS. The .js-side regex uses SPLASH_JS_KEYWORDS only
// — the desugared output never contains Para keywords.

import { SPLASH_JS_KEYWORDS, SPLASH_PARA_KEYWORDS } from "../src/language-surface";
import * as fs from "node:fs";

const TARGET = "/raid/para-site/public/transpile.js";
const BEGIN_MARKER = "// ─── codegen:splash-keywords:begin ──────────────────────────────";
const END_MARKER = "// ─── codegen:splash-keywords:end ────────────────────────────────";

function regenerate(content: string, paraKws: string[], jsKws: string[]): string {
  const beginIdx = content.indexOf(BEGIN_MARKER);
  const endIdx = content.indexOf(END_MARKER);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    console.error(`Marker block not found (or out of order) in ${TARGET}.`);
    console.error(`Begin: ${BEGIN_MARKER}`);
    console.error(`End:   ${END_MARKER}`);
    process.exit(1);
  }
  // Para side: union of Para + JS keywords. Order doesn't matter
  // for the alternation but emit Para tokens first so the block
  // reads "Para keywords | JS reserved" rather than mingled.
  const paraSide = [...paraKws, ...jsKws].join("|");
  const jsSide = jsKws.join("|");
  const indent = "    "; // matches the surrounding `let h = esc(text);` indent
  const lines = [
    BEGIN_MARKER,
    "// AUTO-GENERATED from /raid/parabun/src/language-surface.ts via",
    "// scripts/generate-splash-highlighter.ts. Edit the catalog's",
    "// SPLASH_PARA_KEYWORDS / SPLASH_JS_KEYWORDS arrays, then run",
    "// `bun run codegen` in the parabun repo. The Jenkins `Codegen",
    "// check` stage fails if this block drifts from the catalog.",
    `const kw = isPara`,
    `  ? /\\b(${paraSide})\\b/g`,
    `  : /\\b(${jsSide})\\b/g;`,
    END_MARKER,
  ];
  const replacement = lines.map((l, i) => (i === 0 ? l : indent + l)).join("\n");
  return content.slice(0, beginIdx) + replacement + content.slice(endIdx + END_MARKER.length);
}

function main(): void {
  if (!fs.existsSync(TARGET)) {
    console.log(`⊘ skipping ${TARGET} (file absent — para-site not checked out)`);
    return;
  }
  const original = fs.readFileSync(TARGET, "utf8");
  const updated = regenerate(original, SPLASH_PARA_KEYWORDS, SPLASH_JS_KEYWORDS);
  if (updated === original) {
    console.log(
      `✓ ${TARGET} already up to date (${SPLASH_PARA_KEYWORDS.length} Para + ${SPLASH_JS_KEYWORDS.length} JS keywords)`,
    );
    return;
  }
  fs.writeFileSync(TARGET, updated);
  console.log(
    `✓ regenerated ${TARGET} (${SPLASH_PARA_KEYWORDS.length} Para + ${SPLASH_JS_KEYWORDS.length} JS keywords)`,
  );
}

main();
