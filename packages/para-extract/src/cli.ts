#!/usr/bin/env bun
// para-extract CLI: substitute `ts<import('./x').T>` directives in .pts
// files with extracted schema bodies (committed-artifact flow, mirroring
// scripts/codegen.ts):
//
//   bun para-extract <files...>          # rewrite in place
//   bun para-extract --check <files...>  # exit 1 if any file is stale
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { substituteSource } from "./substitute.ts";

const args = process.argv.slice(2);
const check = args.includes("--check");
const files = args.filter(a => a !== "--check");

if (files.length === 0) {
  console.error("usage: para-extract [--check] <files...>");
  process.exit(1);
}

let stale = 0;
for (const file of files) {
  const path = resolve(file);
  const source = readFileSync(path, "utf8");
  const { code, changed, sites } = substituteSource(source, path);
  if (!changed) {
    if (sites.length > 0) console.log(`✓ ${file} up to date (${sites.length} site${sites.length === 1 ? "" : "s"})`);
    continue;
  }
  if (check) {
    console.error(`✗ ${file} is stale: run \`bun para-extract ${file}\``);
    stale++;
  } else {
    writeFileSync(path, code);
    console.log(`✓ ${file} substituted (${sites.length} site${sites.length === 1 ? "" : "s"})`);
  }
}
process.exit(stale > 0 ? 1 : 0);
