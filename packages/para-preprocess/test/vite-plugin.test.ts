// The extracted `.pts`/`.pjs` Vite plugin (formerly a copy-pasted config
// block in lyku's webui). Esbuild is stubbed so the test pins OUR half:
// extension gating, Para lowering, and the loader choice per extension.
import { test, expect } from "bun:test";
import { parabunModules } from "../src/vite.ts";

function stubbed() {
  const calls: Array<{ filename: string; loader: unknown }> = [];
  const plugin = parabunModules({
    transformWithEsbuild: async (code, filename, options) => {
      calls.push({ filename, loader: (options as { loader?: unknown })?.loader });
      return { code, map: null };
    },
  });
  return { plugin, calls };
}

test("only .pts/.pjs files transform; everything else passes through", async () => {
  const { plugin, calls } = stubbed();
  expect(await plugin.transform("let x = 1;", "/a/b.ts")).toBeNull();
  expect(await plugin.transform("let x = 1;", "/a/b.svelte")).toBeNull();
  expect(await plugin.transform("let x = 1;", "/a/b.pts")).not.toBeNull();
  expect(calls.map((c) => c.filename)).toEqual(["/a/b.pts"]);
});

test("Para syntax is lowered before esbuild sees it", async () => {
  const { plugin } = stubbed();
  const out = await plugin.transform("const y = x |> double(..);", "/m.pts");
  expect(out!.code).not.toContain("|>");
  expect(out!.code).toContain("double");
});

test("loader follows the extension (.pts → ts, .pjs → jsx); query strings ignored", async () => {
  const { plugin, calls } = stubbed();
  await plugin.transform("let a = 1;", "/m.pts?import");
  await plugin.transform("let a = 1;", "/m.pjs");
  expect(calls.map((c) => c.loader)).toEqual(["ts", "jsx"]);
});

test("plugin runs pre so it owns the extensions before Vite's esbuild", () => {
  expect(parabunModules().enforce).toBe("pre");
});
