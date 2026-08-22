// pui-check end-to-end: a real fixture project run through the BUILT bundle
// (dist/pui-check.cjs), under both bun and node: lyku.co CI invokes it via
// parabun/bun, editors and plain Node users via node.
//
// Every negative is paired with a positive, in that order: the clean fixture
// must pass BEFORE the planted-error fixtures are shown to fail, and each
// planted error asserts its EXACT source line: a checker that merely exits 1
// without accurate positions would fail these, as would one that silently
// skips .pui files (the planted errors are all inside .pui components).
import { describe, test, expect, beforeAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const pkgDir = path.resolve(import.meta.dir, "..");
const bundle = path.join(pkgDir, "dist", "pui-check.cjs");

// Real svelte types for the fixture's node_modules (projections import from
// 'svelte'; resolution is workspace-relative, exactly like a user project).
const svelteDir = path.dirname(require.resolve("svelte/package.json"));

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    module: "esnext",
    target: "esnext",
    moduleResolution: "bundler",
    lib: ["esnext", "dom", "dom.iterable"],
    types: [],
    skipLibCheck: true,
    noEmit: true,
  },
  include: ["src/**/*.ts"],
});

// Clean components: Svelte-5 runes AND Para keyword syntax (signal/derived),
// plus a cross-component import. All three must type cleanly.
const OK_PUI = `<script lang="ts">
	let { count, label = "n" }: { count: number; label?: string } = $props();
	const doubled = $derived(count * 2);
</script>

<p>{label}: {doubled}</p>
`;

const SIG_PUI = `<script lang="ts">
	signal n = 1;
	derived big = n * 100;
</script>

<button onclick={() => (n = n + 1)}>{big}</button>
`;

const USES_OK_PUI = `<script lang="ts">
	import Ok from "./Ok.pui";
</script>

<Ok count={3} />
`;

function mkFixture(name: string, files: Record<string, string>): string {
  const dir = path.join(pkgDir, "test", ".fixtures", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  fs.symlinkSync(svelteDir, path.join(dir, "node_modules", "svelte"), "dir");
  fs.writeFileSync(path.join(dir, "tsconfig.json"), TSCONFIG);
  for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, "src", rel), content);
  return dir;
}

function runCheck(runtime: "bun" | "node", workspace: string) {
  const r = Bun.spawnSync([runtime, bundle, "--workspace", workspace], { cwd: workspace, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

beforeAll(() => {
  if (!fs.existsSync(bundle)) {
    const b = Bun.spawnSync(["node", "esbuild.mjs"], { cwd: pkgDir });
    if (b.exitCode !== 0) throw new Error(`bundle build failed: ${b.stderr.toString()}`);
  }
});

for (const runtime of ["bun", "node"] as const) {
  describe(`pui-check under ${runtime}`, () => {
    test("POSITIVE FIRST: a clean project (runes + para syntax + cross-import) passes", () => {
      const ws = mkFixture(`clean-${runtime}`, { "Ok.pui": OK_PUI, "Sig.pui": SIG_PUI, "UsesOk.pui": USES_OK_PUI });
      const { code, out } = runCheck(runtime, ws);
      expect(out).toContain("0 errors in 3 components");
      expect(code).toBe(0);
    });

    test("a script type error is caught at its exact line", () => {
      // line 3 of the file, planted inside an otherwise-clean component
      const bad = OK_PUI.replace("</script>", '\tconst oops: string = 123;\n</script>');
      const ws = mkFixture(`badscript-${runtime}`, { "Ok.pui": OK_PUI, "Bad.pui": bad });
      const { code, out } = runCheck(runtime, ws);
      expect(code).toBe(1);
      expect(out).toMatch(/Bad\.pui\(4,\d+\): error TS2322/); // planted on line 4
      // the untouched sibling stays clean: errors are attributed, not smeared
      expect(out).not.toMatch(/(^|\n)src[\\/]Ok\.pui/);
    });

    test("a TEMPLATE error is caught (markup expressions are checked, not just scripts)", () => {
      const bad = OK_PUI.replace("<p>{label}: {doubled}</p>", "<p>{labell}: {doubled}</p>");
      const ws = mkFixture(`badtemplate-${runtime}`, { "Bad.pui": bad });
      const { code, out } = runCheck(runtime, ws);
      expect(code).toBe(1);
      expect(out).toMatch(/Bad\.pui\(6,\d+\): error TS2552/); // template line 6: Cannot find name 'labell'
    });

    test("a cross-component prop type violation is caught (real component types flow across .pui imports)", () => {
      const bad = USES_OK_PUI.replace("<Ok count={3} />", '<Ok count={"three"} />');
      const ws = mkFixture(`crossprop-${runtime}`, { "Ok.pui": OK_PUI, "UsesOk.pui": bad });
      const { code, out } = runCheck(runtime, ws);
      expect(code).toBe(1);
      expect(out).toMatch(/UsesOk\.pui\(5,\d+\): error TS2322/); // usage line 5: string not assignable to number
    });

    test("an error under PARA syntax maps through the lowering to the right line", () => {
      const bad = SIG_PUI.replace("</script>", '\tconst s: string = n;\n</script>');
      const ws = mkFixture(`badsig-${runtime}`, { "Bad.pui": bad });
      const { code, out } = runCheck(runtime, ws);
      expect(code).toBe(1);
      expect(out).toMatch(/Bad\.pui\(4,\d+\): error TS2322/); // signal n is number; planted line 4
    });

    test('a `lang="pts"` component with TYPESCRIPT IN ITS MARKUP still projects', () => {
      // svelte2tsx parses markup expressions with svelte's own parser, which
      // decides the file is TypeScript from the script tag's `lang` - and
      // accepts only exactly `ts`, not `pts`. So a typed snippet parameter, or
      // any other TS syntax outside the script, failed the whole component with
      // an unpositioned js_parse_error.
      //
      // The script alone was fine either way (`isTsFile: true` covers that
      // path), which is what made this hard to see: it needs TS in the MARKUP.
      // Lyku's three largest .pui components were unchecked because each has a
      // `{#snippet name(x: T)}`.
      //
      // Both halves matter. The clean one must PASS, or the fix could be "treat
      // anything unparseable as fine"; the planted error must be found at its
      // real line, which only happens if the component actually projected.
      const clean = [
        '<script lang="pts">',
        '\tlet n: number = 0;',
        '</script>',
        '',
        '{#snippet row(r: number)}<b>{r + n}</b>{/snippet}',
        '{@render row(1)}',
        '',
      ].join('\n');
      const bad = clean.replace('let n: number = 0;', 'let n: number = "nope";');

      const okWs = mkFixture(`ptsmarkup-ok-${runtime}`, { "Ok.pui": clean });
      const okOut = runCheck(runtime, okWs);
      expect(okOut.out).toContain("0 errors in 1 component");
      expect(okOut.code).toBe(0);

      const badWs = mkFixture(`ptsmarkup-bad-${runtime}`, { "Bad.pui": bad });
      const { code, out } = runCheck(runtime, badWs);
      expect(code).toBe(1);
      expect(out).toMatch(/Bad\.pui\(2,\d+\): error TS2322/);
      expect(out).not.toContain("failed to project");
    });

    test("an unparseable component FAILS the check rather than crashing it", () => {
      const ws = mkFixture(`broken-${runtime}`, { "Ok.pui": OK_PUI, "Broken.pui": "<script lang=\"ts\">\nconst x = 1;\n</script>\n{#if}\n" });
      const { code, out } = runCheck(runtime, ws);
      expect(code).toBe(1);
      expect(out).toMatch(/Broken\.pui/);
      expect(out).not.toMatch(/(^|\n)src[\\/]Ok\.pui/); // sibling unharmed
    });
  });
}
