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
process.stdout.write(new Bun.Transpiler({ loader: "ts" }).transformSync(src));
