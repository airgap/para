/**
 * pui-check — batch type-checker for `.pui` Para UI components.
 *
 * svelte-check cannot do this job: it hardcodes the `.svelte` extension
 * for its svelte2tsx projection and its bundled language service is inert
 * against the `@lyku/para-ui` fork (verified: planted errors in both .pui
 * and shadow .svelte files go uncaught). This CLI reuses the pipeline the
 * parabun LSP already trusts for in-editor `.pui` intelligence —
 * editors/lsp/pui-transform.ts: Para lowering (magic-string, mapped) →
 * svelte2tsx → typed TSX with a chained bidirectional sourcemap — and
 * packages it as a one-shot program check:
 *
 *   1. Resolve the workspace tsconfig (nearest to --workspace, or
 *      --tsconfig). Parsing it with `configFileName` set makes `extends`
 *      resolve, which is where SvelteKit's $app/$lib paths and ambient
 *      .d.ts roots live.
 *   2. Project every `.pui`/`.svelte` under the workspace to `<file>.tsx`
 *      (virtual — never written to disk).
 *   3. Build ONE ts.Program over: the tsconfig's own ambient roots (so
 *      app.d.ts, $types, generated paraglide types all participate), the
 *      svelte2tsx shims (inlined in this bundle as text, served virtually
 *      — the target workspace does not need svelte2tsx installed), and
 *      the projections. An import of `./X.pui` resolves to the virtual
 *      `X.pui.tsx` through normal extension-appending resolution, so
 *      cross-component prop types are real.
 *   4. Collect syntactic + semantic diagnostics for the PROJECTIONS ONLY
 *      (plain .ts files are tsc's job, and double-reporting them here
 *      would drown the component signal), map positions back through the
 *      chained sourcemap, print tsc-style lines, exit non-zero on errors.
 *
 * TypeScript itself is resolved from the TARGET workspace at runtime, so
 * diagnostics come from the compiler version the project actually builds
 * with; this bundle never ships its own tsc.
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

import { puiTransform, type PuiTransform } from "../../../editors/lsp/pui-transform";
// Inlined by esbuild (`loader: { ".d.ts": "text" }`): the ambient globals
// svelte2tsx's generated TSX references (__sveltets_*, svelteHTML, …).
// Served as virtual .d.ts roots — same move svelte-language-server makes.
// @ts-expect-error — text import, typed by the bundler not tsc
import shimsV4 from "svelte2tsx/svelte-shims-v4.d.ts";
// @ts-expect-error — text import
import jsxV4 from "svelte2tsx/svelte-jsx-v4.d.ts";

type Ts = typeof import("typescript");

interface Args {
  workspace: string;
  tsconfig?: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { workspace: process.cwd(), verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--workspace" || v === "-w") a.workspace = path.resolve(argv[++i] ?? ".");
    else if (v === "--tsconfig") a.tsconfig = path.resolve(argv[++i] ?? "");
    else if (v === "--verbose") a.verbose = true;
    else if (v === "--help" || v === "-h") {
      console.log("pui-check [--workspace <dir>] [--tsconfig <file>] [--verbose]");
      process.exit(0);
    } else {
      console.error(`pui-check: unknown argument ${v}`);
      process.exit(2);
    }
  }
  return a;
}

/** The workspace's own typescript decides the diagnostics. Fall back to
 *  whatever this process can reach (dev runs inside the para repo). */
function loadTypescript(workspace: string): Ts {
  const req = createRequire(path.join(workspace, "noop.js"));
  try {
    return req("typescript");
  } catch {
    /* fall through */
  }
  try {
    return require("typescript");
  } catch {
    console.error("pui-check: typescript not found — install it in the target workspace.");
    process.exit(2);
  }
}

const SKIP_DIRS = new Set(["node_modules", ".svelte-kit", ".git", "dist", "build", "coverage", "static"]);

function collectComponents(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(path.join(dir, e.name));
      } else if (e.name.endsWith(".pui") || e.name.endsWith(".svelte")) {
        out.push(path.join(dir, e.name));
      }
    }
  };
  walk(root);
  return out.sort();
}

interface Projection {
  srcPath: string;
  code: string;
  tr: PuiTransform | null; // null = projection failed; error already recorded
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const ws = args.workspace;
  const ts = loadTypescript(ws);

  const cfgPath = args.tsconfig ?? ts.findConfigFile(ws, ts.sys.fileExists);
  if (!cfgPath) {
    console.error(`pui-check: no tsconfig found from ${ws}`);
    process.exit(2);
  }
  const cfgFile = ts.readConfigFile(cfgPath, ts.sys.readFile);
  if (cfgFile.error) {
    console.error(`pui-check: failed to read ${cfgPath}: ${ts.flattenDiagnosticMessageText(cfgFile.error.messageText, "\n")}`);
    process.exit(2);
  }
  // 5th arg (configFileName) is REQUIRED so `extends` resolves — a
  // SvelteKit tsconfig extends ./.svelte-kit/tsconfig.json, which is
  // where the $app/$lib/$types paths and ambient roots live.
  const parsed = ts.parseJsonConfigFileContent(cfgFile.config, ts.sys, path.dirname(cfgPath), undefined, cfgPath);

  const components = collectComponents(ws);
  if (components.length === 0) {
    console.log("pui-check: no .pui/.svelte components found — nothing to do.");
    process.exit(0);
  }

  let errorCount = 0;
  const filesWithErrors = new Set<string>();
  const report = (file: string, line1: number, col1: number, code: number | string, message: string) => {
    console.log(`${path.relative(ws, file)}(${line1},${col1}): error TS${code}: ${message}`);
    errorCount++;
    filesWithErrors.add(file);
  };

  // --- project every component (virtual <file>.tsx) --------------------------
  const projections = new Map<string, Projection>();
  for (const src of components) {
    const raw = fs.readFileSync(src, "utf8");
    try {
      const tr = puiTransform(raw, src);
      projections.set(src + ".tsx", { srcPath: src, code: tr.code, tr });
    } catch (e) {
      // A component svelte2tsx cannot parse is a real defect in the file
      // (or a lowering bug) — either way the check must FAIL, not crash.
      report(src, 1, 1, 0, `failed to project component: ${(e as Error)?.message ?? e}`);
      projections.set(src + ".tsx", { srcPath: src, code: "export {};\n", tr: null });
    }
  }
  if (args.verbose) for (const p of projections.values()) console.error(`projected ${path.relative(ws, p.srcPath)}`);

  // The svelte2tsx ambient shims, virtual under the workspace so their
  // `import('svelte')` references resolve against the WORKSPACE's svelte
  // (the @lyku/para-ui alias there — its .d.ts surface is stock).
  const shimDir = path.join(ws, ".para-check-virtual");
  const shimFiles = new Map<string, string>([
    [path.join(shimDir, "svelte-shims-v4.d.ts"), shimsV4 as unknown as string],
    [path.join(shimDir, "svelte-jsx-v4.d.ts"), jsxV4 as unknown as string],
  ]);

  // --- one program over ambients + shims + projections -----------------------
  // Ambient roots only: the tsconfig's resolved .ts/.d.ts files carry the
  // globals (app.d.ts, $types, generated runtime types). Components come
  // in exclusively via projection.
  const ambients = parsed.fileNames.filter(fn => /\.(ts|tsx|d\.ts|js|jsx)$/.test(fn) && !fn.endsWith(".svelte") && !fn.endsWith(".pui"));
  // The Para lowering auto-imports lifecycle/context helpers from
  // "@lyku/para-ui". Consumer workspaces usually install the fork AS
  // svelte (`"svelte": "npm:@lyku/para-ui"`), so the bare specifier has
  // nothing to resolve to. Mirror that alias in reverse — only when
  // @lyku/para-ui is genuinely absent and svelte is present.
  const paraUiPaths: Record<string, string[]> = {};
  if (!fs.existsSync(path.join(ws, "node_modules", "@lyku", "para-ui", "package.json")) && fs.existsSync(path.join(ws, "node_modules", "svelte", "package.json"))) {
    paraUiPaths["@lyku/para-ui"] = [path.join(ws, "node_modules", "svelte", "index.d.ts").replace(/\\/g, "/")];
    paraUiPaths["@lyku/para-ui/*"] = [path.join(ws, "node_modules", "svelte", "*").replace(/\\/g, "/")];
  }

  const options: import("typescript").CompilerOptions = {
    ...parsed.options,
    paths: { ...parsed.options.paths, ...paraUiPaths },
    // Projections are TSX; a Svelte project's tsconfig has no `jsx`, and
    // without it a cross-module `./X.pui` (→ X.pui.tsx) import dies with
    // TS6142. Same forcing the LSP applies.
    jsx: ts.JsxEmit.Preserve,
    noEmit: true,
    skipLibCheck: true,
    // Never let a build-oriented config drag emit machinery in.
    incremental: false,
    composite: false,
    tsBuildInfoFile: undefined,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
  };

  const virtual = new Map<string, string>();
  for (const [p, code] of shimFiles) virtual.set(p, code);
  for (const [p, proj] of projections) virtual.set(p, proj.code);

  const host = ts.createCompilerHost(options, true);
  const baseFileExists = host.fileExists.bind(host);
  const baseReadFile = host.readFile.bind(host);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = f => virtual.has(f) || baseFileExists(f);
  host.readFile = f => virtual.get(f) ?? baseReadFile(f);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    const v = virtual.get(fileName);
    if (v !== undefined) return ts.createSourceFile(fileName, v, languageVersionOrOptions, true, ts.ScriptKind.TSX);
    return baseGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
  };

  const rootNames = [...ambients, ...shimFiles.keys(), ...projections.keys()];
  const program = ts.createProgram(rootNames, options, host);

  // --- diagnostics for the projections only ----------------------------------
  for (const [tsxPath, proj] of projections) {
    if (!proj.tr) continue; // projection failed; already reported
    const sf = program.getSourceFile(tsxPath);
    if (!sf) {
      report(proj.srcPath, 1, 1, 0, "projection missing from program (internal error)");
      continue;
    }
    const diags = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)];
    for (const d of diags) {
      if (d.category !== ts.DiagnosticCategory.Error) continue;
      const message = ts.flattenDiagnosticMessageText(d.messageText, "\n  ");
      if (d.start === undefined) {
        report(proj.srcPath, 1, 1, d.code, message);
        continue;
      }
      const pos = sf.getLineAndCharacterOfPosition(d.start);
      // Chained map: generated TSX → lowered svelte → raw .pui. A hit at
      // the exact start is the common case; if the start sits on generated
      // glue, try the end of the span before giving up to (1,1).
      let orig = proj.tr.toOriginal(pos.line, pos.character);
      if (!orig && d.length) {
        const end = sf.getLineAndCharacterOfPosition(d.start + d.length - 1);
        orig = proj.tr.toOriginal(end.line, end.character);
      }
      if (orig) report(proj.srcPath, orig.line + 1, orig.character + 1, d.code, message);
      else report(proj.srcPath, 1, 1, d.code, `[in generated projection] ${message}`);
    }
  }

  const n = projections.size;
  if (errorCount === 0) {
    console.log(`pui-check: 0 errors in ${n} component${n === 1 ? "" : "s"}`);
    process.exit(0);
  }
  console.log(`\npui-check: ${errorCount} error${errorCount === 1 ? "" : "s"} in ${filesWithErrors.size} of ${n} components`);
  process.exit(1);
}

main();
