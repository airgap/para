import { test, expect } from "bun:test";
import { characterize, type CharDeps } from "../src/characterize.ts";

// ── Deterministic verdict-logic tests (injected fakes) ──
const baseDeps = (over: Partial<CharDeps> = {}): CharDeps => ({
  safeMigrate: s => ({ code: s + "/*MIG*/", migrated: true }),
  lower: c => c,
  renderSSR: src => (src.includes("/*MIG*/") ? "<p>x</p>" : "<p>x</p>"),
  ...over,
});

test("parity: original & migrated render identically", () => {
  expect(characterize("<p>x</p>", {}, baseDeps()).verdict).toBe("parity");
});

test("mismatch: rendered DOM differs after migration", () => {
  const r = characterize(
    "<p>x</p>",
    {},
    baseDeps({
      renderSSR: src => (src.includes("/*MIG*/") ? "<p>DIFFERENT</p>" : "<p>x</p>"),
    }),
  );
  expect(r.verdict).toBe("mismatch");
  expect(r.original).toBe("<p>x</p>");
  expect(r.migrated).toBe("<p>DIFFERENT</p>");
});

test("skipped: safeMigrate left the file unchanged", () => {
  const r = characterize("<p>x</p>", {}, baseDeps({ safeMigrate: s => ({ code: s, migrated: false }) }));
  expect(r.verdict).toBe("skipped");
});

test("uncharacterizable: original won't render → NO parity claim (honest)", () => {
  const r = characterize(
    "<p>x</p>",
    {},
    baseDeps({
      renderSSR: src => {
        if (!src.includes("/*MIG*/")) throw new Error("ctx required");
        return "<p>x</p>";
      },
    }),
  );
  expect(r.verdict).toBe("uncharacterizable");
});

test("mismatch: migrated fails to render where original succeeded (regression)", () => {
  const r = characterize(
    "<p>x</p>",
    {},
    baseDeps({
      renderSSR: src => {
        if (src.includes("/*MIG*/")) throw new Error("boom");
        return "<p>x</p>";
      },
    }),
  );
  expect(r.verdict).toBe("mismatch");
  expect(r.detail).toMatch(/migrated failed to render/);
});

test("normalization: hydration markers / whitespace are NOT behavioral", () => {
  const r = characterize(
    "<p>x</p>",
    {},
    baseDeps({
      renderSSR: src =>
        src.includes("/*MIG*/") ? "<p>x</p>" : `<!--[--> <p   data-svelte-h="svelte-1a">x</p> <!--]-->`,
    }),
  );
  expect(r.verdict).toBe("parity");
});

// ── Real end-to-end smoke: fork compile+render + real safeMigrate ──
test("REAL: a deterministic component round-trips with render parity", async () => {
  const { compile } = await import("../../para-svelte/packages/svelte/src/compiler/index.js");
  const { render } = await import("../../para-svelte/packages/svelte/src/internal/server/index.js");
  const { lowerPuiReactivity } = await import("../../para-preprocess/src/index.ts");
  const { safeMigrate } = await import("../src/index.ts");

  // Resolve the para-svelte fork relative to this test file — never a
  // hardcoded absolute (it broke when the tree was extracted from the
  // parabun monorepo to airgap/para).
  const cwd = new URL("../../para-svelte", import.meta.url).pathname;
  // characterize()'s renderSSR dep is sync by contract; module eval is
  // async, so this smoke proves the real pipeline end-to-end directly
  // (compile→eval→render, original vs migrated) rather than through
  // characterize() itself. The injected-fake tests above already prove
  // characterize()'s verdict logic.
  const src = `<script lang="ts">\nlet n = $state(3);\nconst d = $derived(n + 1);\n</script>\n<p>n {n} d {d}</p>`;
  const mig = safeMigrate(src, compile as never, lowerPuiReactivity);
  expect(mig.migrated).toBe(true);
  expect(mig.code).toContain("signal n = 3;");

  const realRender = async (svelteSource: string) => {
    const framed = svelteSource.replace(/^(import [^\n]*?;)\s*(<script[^>]*>)/, (_m, i, t) => `${t}\n${i}`);
    const js = (compile(framed, { generate: "server", name: "C", runes: true }) as { js: { code: string } }).js.code
      .replace(/from ['"]svelte\/internal\/server['"]/g, `from '${cwd}/packages/svelte/src/internal/server/index.js'`)
      .replace(/from ['"]@lyku\/para-signals['"]/g, `from '${cwd}/../para-signals/src/index.js'`);
    const m = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
    return (render as (c: unknown, o: unknown) => { body: string })(m.default, { props: {} }).body;
  };
  const a = (await realRender(src)).replace(/<!--[\][!]?-->/g, "").trim();
  const b = (await realRender(lowerPuiReactivity(mig.code, "@lyku/para-ui", false, false)))
    .replace(/<!--[\][!]?-->/g, "")
    .trim();
  expect(a).toContain("n 3 d 4");
  expect(b).toBe(a); // render parity: migration preserved output
});
