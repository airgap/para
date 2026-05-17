import { test, expect } from "bun:test";
import { runMigration } from "../src/cli.ts";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Injected fake deps: compile throws iff source contains __BAD__.
const deps = {
  compile: (s: string) => {
    if (s.includes("__BAD__")) throw new Error("synthetic compile error");
    return {};
  },
  lower: (code: string) => code, // passthrough
};
// A regressing variant: lower injects __BAD__ so the migrated "fails".
const regressDeps = { compile: deps.compile, lower: (c: string) => "__BAD__" + c };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "para-codemod-cli-"));
  writeFileSync(join(dir, "Good.svelte"), `<script lang="ts">\nlet n = $state(0);\n</script>\n<b>{n}</b>`);
  writeFileSync(join(dir, "Plain.svelte"), `<script lang="ts">\nconst K = 1;\n</script>\n<i>{K}</i>`);
  return dir;
}

test("dry-run (default): classifies, touches NOTHING on disk", () => {
  const dir = fixture();
  const files = [join(dir, "Good.svelte"), join(dir, "Plain.svelte")];
  const sum = runMigration(files, { write: false }, deps);
  expect(sum.migrated).toEqual([join(dir, "Good.svelte")]);
  expect(sum.noop).toEqual([join(dir, "Plain.svelte")]);
  // disk untouched
  expect(existsSync(join(dir, "Good.svelte"))).toBe(true);
  expect(existsSync(join(dir, "Good.pui"))).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("--write: migrated → .pui (original removed); no-op left as .svelte", () => {
  const dir = fixture();
  const files = [join(dir, "Good.svelte"), join(dir, "Plain.svelte")];
  runMigration(files, { write: true }, deps);
  expect(existsSync(join(dir, "Good.svelte"))).toBe(false);
  expect(existsSync(join(dir, "Good.pui"))).toBe(true);
  expect(readFileSync(join(dir, "Good.pui"), "utf8")).toContain("signal n = 0;");
  // no-op file untouched, still .svelte
  expect(existsSync(join(dir, "Plain.svelte"))).toBe(true);
  expect(existsSync(join(dir, "Plain.pui"))).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("--write: would-regress file is SKIPPED and left as .svelte (unchanged)", () => {
  const dir = fixture();
  const f = join(dir, "Good.svelte");
  const before = readFileSync(f, "utf8");
  const sum = runMigration([f], { write: true }, regressDeps);
  expect(sum.skipped).toEqual([f]);
  expect(sum.migrated).toEqual([]);
  expect(existsSync(f)).toBe(true); // not renamed
  expect(existsSync(join(dir, "Good.pui"))).toBe(false); // not written
  expect(readFileSync(f, "utf8")).toBe(before); // byte-identical
  rmSync(dir, { recursive: true, force: true });
});

test("importer-rewrite: extensioned .svelte imports of migrated files → .pui (conservative)", () => {
  const dir = mkdtempSync(join(tmpdir(), "para-codemod-imp-"));
  writeFileSync(join(dir, "Comp.svelte"), `<script lang="ts">\nlet n = $state(0);\n</script>\n<b>{n}</b>`);
  writeFileSync(join(dir, "Plain.svelte"), `<script lang="ts">\nconst K = 1;\n</script>\n<i>{K}</i>`); // no-op, NOT migrated
  writeFileSync(
    join(dir, "Consumer.ts"),
    `import Comp from './Comp.svelte';\nimport Plain from './Plain.svelte';\nexport { Comp, Plain };`,
  );
  const files = [join(dir, "Comp.svelte"), join(dir, "Plain.svelte")];

  // dry-run: reports the rewrite, touches nothing
  const dry = runMigration(files, { write: false, importRoots: [dir] }, deps);
  expect(dry.importsRewritten).toEqual([{ file: join(dir, "Consumer.ts"), specifiers: 1 }]);
  expect(readFileSync(join(dir, "Consumer.ts"), "utf8")).toContain("./Comp.svelte"); // untouched in dry-run

  // --write: Comp import rewritten to .pui; Plain (not migrated) untouched
  runMigration(files, { write: true, importRoots: [dir] }, deps);
  const consumer = readFileSync(join(dir, "Consumer.ts"), "utf8");
  expect(consumer).toContain(`import Comp from './Comp.pui';`);
  expect(consumer).toContain(`import Plain from './Plain.svelte';`); // conservative: unrelated import left
  expect(existsSync(join(dir, "Comp.pui"))).toBe(true);
  expect(existsSync(join(dir, "Comp.svelte"))).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});
