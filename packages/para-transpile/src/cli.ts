#!/usr/bin/env node
// Tiny CLI: `para transpile FILE` or `para transpile < stdin`.
// Output goes to stdout. Exit code 1 on error.

import { readFileSync } from "node:fs";
import { transpile } from "./index";

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => (buf += chunk));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

function usage(): never {
  console.error("usage: para transpile [FILE]    (reads stdin if FILE omitted)");
  process.exit(1);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (cmd !== "transpile") usage();

  let src: string;
  let filename = "<stdin>";
  if (rest.length === 0) {
    src = await readStdin();
  } else if (rest.length === 1) {
    filename = rest[0]!;
    src = readFileSync(filename, "utf8");
  } else {
    usage();
  }

  try {
    process.stdout.write(transpile(src, { filename }));
  } catch (err) {
    console.error(`para: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

main();
