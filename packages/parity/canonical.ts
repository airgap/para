// Helper: read a .pts file, run it through Parabun's Bun.Transpiler (the
// canonical Zig parser), write the result to stdout. Invoked as a child
// process by the parity runner — must run under Parabun (debug build),
// not system Bun, since system Bun's parser doesn't recognize Para
// syntax.
//
//   bun-debug test/parity/canonical.ts FIXTURE.pts > canonical.js

const fname = process.argv[2];
if (!fname) {
  console.error("usage: canonical.ts FIXTURE.pts");
  process.exit(1);
}

const src = await Bun.file(fname).text();
// Newer parabun builds parse Para under the dedicated "pts" loader; the
// older pinned debug builds folded it into "ts". Prefer "pts", fall back.
let transpiler: Bun.Transpiler;
try {
  transpiler = new Bun.Transpiler({ loader: "pts" as never });
  transpiler.transformSync("let x = 1");
} catch {
  transpiler = new Bun.Transpiler({ loader: "ts" });
}
process.stdout.write(transpiler.transformSync(src));
