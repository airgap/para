// Where a generator reads its inputs and writes its outputs.
//
// `--out=<dir>` redirects every write under <dir>/repo and <dir>/site, so
// `codegen.ts --check` can regenerate into a temp dir and compare without
// touching a tracked file. `--site=<dir>` is the only way a generator reaches
// the para-site checkout: it sits outside this workspace, so writing there has
// to be asked for by path, never assumed.

import * as fs from "node:fs";
import * as path from "node:path";

export interface CodegenRoots {
  repoIn: string;
  repoOut: string;
  siteIn: string | null;
  siteOut: string | null;
}

function flag(argv: string[], name: string): string | null {
  const arg = argv.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : null;
}

export function codegenRoots(argv: string[]): CodegenRoots {
  const repo = path.resolve(import.meta.dirname, "..");
  const out = flag(argv, "out");
  const site = flag(argv, "site");
  // A mistyped --site must not mkdir a fresh tree somewhere on disk.
  if (site && !fs.existsSync(path.join(site, "src/grammars"))) {
    throw new Error(`--site=${site} is not a para-site checkout (no src/grammars)`);
  }
  return {
    repoIn: repo,
    repoOut: out ? path.join(path.resolve(out), "repo") : repo,
    siteIn: site ? path.resolve(site) : null,
    siteOut: site ? (out ? path.join(path.resolve(out), "site") : path.resolve(site)) : null,
  };
}
