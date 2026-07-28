// Batch transpile timer — runs UNDER PARABUN (the canonical Zig parser),
// never under system bun. Reads a manifest of .pts paths, feeds each
// through Bun.Transpiler, and records per-file in-process nanoseconds so
// the orchestrator can split "compile time" from "spawn + startup
// overhead" (outside wall − inside total).
//
// Results go to a FILE (argv[3]), not stdout: parabun debug builds leak
// ASAN banners to stdout (see parity/canonical.ts) and we want clean JSON.
//
//   parabun batch.ts MANIFEST.json OUT.json
//
// Manifest: { "files": ["/abs/path/a.pts", ...] }
// Out:      { perFileNs: { path: ns | null }, inProcessTotalNs, failures,
//             rssBytes }  — null = that file failed to transpile.

const [manifestPath, outPath] = process.argv.slice(2);
if (!manifestPath || !outPath) {
	console.error("usage: parabun batch.ts MANIFEST.json OUT.json");
	process.exit(1);
}

const manifest: { files: string[] } = await Bun.file(manifestPath).json();

// Newer parabun builds parse Para under the dedicated "pts" loader; older
// pinned (debug) builds folded it into "ts" (see parity/canonical.ts).
// Prefer "pts", fall back for old binaries that don't know the loader.
let transpiler: Bun.Transpiler;
try {
	transpiler = new Bun.Transpiler({ loader: "pts" as never });
	transpiler.transformSync("let x = 1");
} catch {
	transpiler = new Bun.Transpiler({ loader: "ts" });
}

// Read sources up front so timing covers transpilation, not disk.
const sources = new Map<string, string>();
for (const f of manifest.files) {
	sources.set(f, await Bun.file(f).text());
}

const perFileNs: Record<string, number | null> = {};
let inProcessTotalNs = 0;
let failures = 0;

for (const f of manifest.files) {
	const src = sources.get(f)!;
	const t0 = Bun.nanoseconds();
	try {
		transpiler.transformSync(src);
		const dt = Bun.nanoseconds() - t0;
		perFileNs[f] = dt;
		inProcessTotalNs += dt;
	} catch {
		perFileNs[f] = null;
		failures++;
	}
}

await Bun.write(
	outPath,
	JSON.stringify({
		perFileNs,
		inProcessTotalNs,
		failures,
		rssBytes: process.memoryUsage().rss,
	}),
);
