// Para ↔ ParaBun differential benchmark orchestrator. Runs under plain
// bun in the para workspace; the canonical side runs in child parabun
// processes (batch.ts). Three scenarios:
//
//   mirror        @lyku/para-transpile in-process over the corpus
//   parabunBatch  one parabun process transpiling the whole corpus
//                 (in-process ns from batch.ts; wall from out here:
//                 the difference is spawn + startup overhead)
//   spawnPerFile  one parabun process PER FILE over the micro fixtures:
//                 the parabun-vite-plugin cost model
//
// Only the files BOTH sides can transpile are timed (the comparable
// set); each side's failures are reported as coverage, which for the
// macro corpus doubles as "how much of real-world Para the mirror
// handles today".
//
// Env:
//   PARABUN_BIN     path to the parabun binary (else @lyku/parabun-bin pin)
//   BENCH_CORPUS    root dir scanned for macro .pts corpus (optional,
//                   micro fixtures only when unset)
//   BENCH_REPS      timed repetitions (default 5 macro / 20 micro)
//   BENCH_OUT       result JSON path (default ./bench.json)
//
// Modes:
//   bun bench.ts                 run + write BENCH_OUT + table
//   bun bench.ts --check BASE    compare a fresh run against BASE json;
//                                exit 1 if a key metric regressed >25%
//                                (BENCH_THRESHOLD overrides, e.g. 0.25)

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveParabun } from "@lyku/parabun-bin";
import { transpile } from "@lyku/para-transpile";

const BATCH_SCRIPT = new URL("./batch.ts", import.meta.url).pathname;
const FIXTURES_DIR = new URL("../parity/fixtures", import.meta.url).pathname;

let PARABUN: string;
try {
	PARABUN = resolveParabun().path;
} catch (e) {
	console.error(`para-bench: ${e instanceof Error ? e.message : e}`);
	process.exit(2);
}

const checkIdx = process.argv.indexOf("--check");
const baselinePath = checkIdx >= 0 ? process.argv[checkIdx + 1] : undefined;
if (checkIdx >= 0 && !baselinePath) {
	console.error("para-bench: --check requires a baseline json path");
	process.exit(2);
}

// ---------------------------------------------------------------- corpus

function scanPts(root: string): string[] {
	const SKIP = new Set(["node_modules", "dist", "build", "target", ".git", ".svelte-kit", ".nx", "vendor"]);
	const out: string[] = [];
	const walk = (dir: string) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.isDirectory()) {
				if (!SKIP.has(e.name)) walk(join(dir, e.name));
			} else if (e.name.endsWith(".pts")) {
				out.push(join(dir, e.name));
			}
		}
	};
	walk(root);
	return out.sort();
}

const microFiles = readdirSync(FIXTURES_DIR)
	.filter(f => f.endsWith(".pts"))
	.sort()
	.map(f => join(FIXTURES_DIR, f));

const corpusRoot = process.env.BENCH_CORPUS;
const macroFiles = corpusRoot ? scanPts(corpusRoot) : [];
const macroBytes = macroFiles.reduce((n, f) => n + statSync(f).size, 0);

if (microFiles.length === 0) {
	console.error(`para-bench: no fixtures in ${FIXTURES_DIR}`);
	process.exit(2);
}

// ------------------------------------------------------------- utilities

const nowNs = () => process.hrtime.bigint();
const ms = (ns: number) => ns / 1e6;

function median(xs: number[]): number {
	if (xs.length === 0) return NaN;
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function p95(xs: number[]): number {
	if (xs.length === 0) return NaN;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

interface BatchResult {
	perFileNs: Record<string, number | null>;
	inProcessTotalNs: number;
	failures: number;
	rssBytes: number;
}

const tmp = mkdtempSync(join(tmpdir(), "para-bench-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

function runBatch(files: string[], tag: string): { wallNs: number; result: BatchResult } {
	const manifest = join(tmp, `${tag}-manifest.json`);
	const out = join(tmp, `${tag}-out.json`);
	writeFileSync(manifest, JSON.stringify({ files }));
	const t0 = nowNs();
	const r = spawnSync(PARABUN, [BATCH_SCRIPT, manifest, out], {
		encoding: "utf8",
		env: { ...process.env, BUN_DEBUG_QUIET_LOGS: "1" },
	});
	const wallNs = Number(nowNs() - t0);
	if (r.status !== 0) {
		throw new Error(`parabun batch (${tag}) failed:\n${r.stderr}`);
	}
	return { wallNs, result: JSON.parse(readFileSync(out, "utf8")) as BatchResult };
}

// -------------------------------------------------- comparable-set probe

// One untimed probe pass per side establishes which files each can
// transpile; timing then runs on the intersection so the comparison is
// apples-to-apples. Macro mirror coverage is a headline metric on its own.

function probeMirror(files: string[]): { ok: string[]; failed: string[] } {
	const ok: string[] = [];
	const failed: string[] = [];
	for (const f of files) {
		try {
			transpile(readFileSync(f, "utf8"));
			ok.push(f);
		} catch {
			failed.push(f);
		}
	}
	return { ok, failed };
}

function probeParabun(files: string[]): { ok: string[]; failed: string[] } {
	const { result } = runBatch(files, "probe");
	const ok: string[] = [];
	const failed: string[] = [];
	for (const f of files) (result.perFileNs[f] === null ? failed : ok).push(f);
	return { ok, failed };
}

// ------------------------------------------------------------ scenarios

function benchMirror(files: string[], reps: number) {
	const sources = files.map(f => readFileSync(f, "utf8"));
	// Warmup pass: JIT, not measured.
	for (const src of sources) transpile(src);
	const totals: number[] = [];
	const perFile: number[] = [];
	for (let r = 0; r < reps; r++) {
		const t0 = nowNs();
		for (const src of sources) {
			const f0 = nowNs();
			transpile(src);
			perFile.push(Number(nowNs() - f0));
		}
		totals.push(Number(nowNs() - t0));
	}
	return {
		medianTotalMs: ms(median(totals)),
		p95FileMs: ms(p95(perFile)),
		medianFileMs: ms(median(perFile)),
	};
}

function benchParabunBatch(files: string[], reps: number) {
	const walls: number[] = [];
	const inProc: number[] = [];
	const perFile: number[] = [];
	let rss = 0;
	for (let r = 0; r < reps; r++) {
		const { wallNs, result } = runBatch(files, `batch-${r}`);
		walls.push(wallNs);
		inProc.push(result.inProcessTotalNs);
		rss = Math.max(rss, result.rssBytes);
		for (const f of files) {
			const v = result.perFileNs[f];
			if (v !== null && v !== undefined) perFile.push(v);
		}
	}
	return {
		medianWallMs: ms(median(walls)),
		medianInProcessMs: ms(median(inProc)),
		medianStartupOverheadMs: ms(median(walls)) - ms(median(inProc)),
		p95FileMs: ms(p95(perFile)),
		medianFileMs: ms(median(perFile)),
		maxRssBytes: rss,
	};
}

function benchSpawnPerFile(files: string[], reps: number) {
	// The vite-plugin cost model: a fresh parabun process per file.
	const walls: number[] = [];
	for (let r = 0; r < reps; r++) {
		for (const f of files) {
			const { wallNs } = runBatch([f], `spawn-${r}`);
			walls.push(wallNs);
		}
	}
	return { medianSpawnMs: ms(median(walls)), p95SpawnMs: ms(p95(walls)) };
}

// ------------------------------------------------------------------ run

const parabunVersion = spawnSync(PARABUN, ["--version"], { encoding: "utf8" }).stdout.trim();

console.log(`para-bench: parabun ${parabunVersion} (${PARABUN})`);
console.log(`  micro corpus: ${microFiles.length} parity fixtures`);
if (corpusRoot) {
	console.log(`  macro corpus: ${macroFiles.length} .pts files, ${(macroBytes / 1024).toFixed(0)} KB (${corpusRoot})`);
}

const microReps = Number(process.env.BENCH_REPS ?? 20);
const macroReps = Number(process.env.BENCH_REPS ?? 5);

const result: Record<string, unknown> = {
	parabunVersion,
	corpus: {
		micro: microFiles.length,
		macro: corpusRoot ? { root: corpusRoot, files: macroFiles.length, bytes: macroBytes } : null,
	},
};

// -- micro ---------------------------------------------------------------
{
	const mp = probeMirror(microFiles);
	const pp = probeParabun(microFiles);
	const comparable = microFiles.filter(f => mp.ok.includes(f) && pp.ok.includes(f));
	const mirror = benchMirror(comparable, microReps);
	const batch = benchParabunBatch(comparable, microReps);
	const spawn = benchSpawnPerFile(comparable, Math.max(1, Math.floor(microReps / 4)));
	result.micro = { comparable: comparable.length, mirror, parabunBatch: batch, spawnPerFile: spawn };

	console.log(`\n── micro (${comparable.length} comparable fixtures, ${microReps} reps) ──`);
	console.log(`  mirror in-process:  total ${mirror.medianTotalMs.toFixed(2)}ms  per-file med ${mirror.medianFileMs.toFixed(3)}ms  p95 ${mirror.p95FileMs.toFixed(3)}ms`);
	console.log(`  parabun batch:      wall ${batch.medianWallMs.toFixed(2)}ms  in-proc ${batch.medianInProcessMs.toFixed(2)}ms  startup ${batch.medianStartupOverheadMs.toFixed(2)}ms`);
	console.log(`  parabun per-spawn:  med ${spawn.medianSpawnMs.toFixed(2)}ms  p95 ${spawn.p95SpawnMs.toFixed(2)}ms   ← vite-plugin cost model`);
}

// -- macro ---------------------------------------------------------------
if (corpusRoot && macroFiles.length > 0) {
	const mp = probeMirror(macroFiles);
	const pp = probeParabun(macroFiles);
	const ppOk = new Set(pp.ok);
	const comparable = mp.ok.filter(f => ppOk.has(f));
	const comparableBytes = comparable.reduce((n, f) => n + statSync(f).size, 0);
	const mirror = benchMirror(comparable, macroReps);
	const batch = benchParabunBatch(comparable, macroReps);
	const mirrorMBs = comparableBytes / 1024 / 1024 / (mirror.medianTotalMs / 1000);
	const parabunMBs = comparableBytes / 1024 / 1024 / (batch.medianInProcessMs / 1000);

	result.macro = {
		comparable: comparable.length,
		comparableBytes,
		mirrorCoverage: mp.ok.length / macroFiles.length,
		parabunCoverage: pp.ok.length / macroFiles.length,
		mirrorFailedSample: mp.failed.slice(0, 10),
		parabunFailedSample: pp.failed.slice(0, 10),
		mirror: { ...mirror, throughputMBs: mirrorMBs },
		parabunBatch: { ...batch, throughputMBs: parabunMBs },
		nativeMultiplier: mirror.medianTotalMs / batch.medianInProcessMs,
	};

	console.log(`\n── macro (${comparable.length}/${macroFiles.length} comparable, ${macroReps} reps) ──`);
	console.log(`  coverage: mirror ${(100 * mp.ok.length / macroFiles.length).toFixed(1)}%  parabun ${(100 * pp.ok.length / macroFiles.length).toFixed(1)}%`);
	console.log(`  mirror in-process:  ${mirror.medianTotalMs.toFixed(1)}ms  (${mirrorMBs.toFixed(1)} MB/s)`);
	console.log(`  parabun in-process: ${batch.medianInProcessMs.toFixed(1)}ms  (${parabunMBs.toFixed(1)} MB/s)  wall ${batch.medianWallMs.toFixed(1)}ms  rss ${(batch.maxRssBytes / 1024 / 1024).toFixed(0)}MB`);
	console.log(`  native multiplier:  ${(mirror.medianTotalMs / batch.medianInProcessMs).toFixed(1)}× (mirror time ÷ parabun compile time)`);
	if (mp.failed.length > 0) {
		console.log(`  mirror can't yet transpile ${mp.failed.length} real-world file(s); first few:`);
		for (const f of mp.failed.slice(0, 5)) console.log(`    ${f}`);
	}
}

const outPath = process.env.BENCH_OUT ?? "bench.json";
writeFileSync(outPath, JSON.stringify(result, null, "\t") + "\n");
console.log(`\nwrote ${outPath}`);

// ---------------------------------------------------------------- check

if (baselinePath) {
	let base: Record<string, any>;
	try {
		base = JSON.parse(readFileSync(baselinePath, "utf8"));
	} catch {
		console.log(`check: no readable baseline at ${baselinePath}, skipping (first run)`);
		process.exit(0);
	}
	const threshold = Number(process.env.BENCH_THRESHOLD ?? 0.25);
	const cur = result as Record<string, any>;
	// Key metrics where a HIGHER value is a regression.
	const probes: [string, number | undefined, number | undefined][] = [
		["micro.spawnPerFile.medianSpawnMs", base.micro?.spawnPerFile?.medianSpawnMs, cur.micro?.spawnPerFile?.medianSpawnMs],
		["micro.parabunBatch.medianInProcessMs", base.micro?.parabunBatch?.medianInProcessMs, cur.micro?.parabunBatch?.medianInProcessMs],
		["macro.parabunBatch.medianInProcessMs", base.macro?.parabunBatch?.medianInProcessMs, cur.macro?.parabunBatch?.medianInProcessMs],
		["macro.mirror.medianTotalMs", base.macro?.mirror?.medianTotalMs, cur.macro?.mirror?.medianTotalMs],
	];
	let regressed = false;
	for (const [name, b, c] of probes) {
		if (b === undefined || c === undefined || !isFinite(b) || !isFinite(c)) continue;
		const delta = (c - b) / b;
		const flag = delta > threshold ? "  ← REGRESSION" : "";
		if (delta > threshold) regressed = true;
		console.log(`check: ${name}: ${b.toFixed(2)} → ${c.toFixed(2)}  (${(delta * 100).toFixed(1)}%)${flag}`);
	}
	if (regressed) {
		console.log(`check: at least one metric regressed >${(threshold * 100).toFixed(0)}%`);
		process.exit(1);
	}
	console.log("check: within thresholds");
}
