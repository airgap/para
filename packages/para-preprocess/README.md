# @lyku/para-preprocess

A Svelte preprocessor that lets `.svelte` files use Parabun syntax (`pure`, `..!`, `..&`, `..=`, `|>`) inside `<script>` blocks, and lets them import `.pts` / `.pjs` modules.

Parabun's parser handles its extensions unconditionally, so this preprocessor is a thin wrapper around `Bun.Transpiler`: it hands the script body to the transpiler and returns plain JS/TS that the Svelte compiler (or `vitePreprocess`) can consume.

## Install

```sh
bun add -d @lyku/para-preprocess
```

Requires Parabun (`bun` in this fork) at runtime: it uses `Bun.Transpiler`.

## Usage

```js
// svelte.config.js
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { parabunPreprocess } from "@lyku/para-preprocess";

export default {
  preprocess: [parabunPreprocess(), vitePreprocess()],
};
```

Then in a component:

```svelte
<script lang="parabun">
  import { load } from "./data.pts";

  pure fun double(x: number) { return x * 2; }

  const rows = await load() ..! (err) => {
    console.error(err);
    return [];
  };
</script>

{#each rows as row}
  <p>{double(row.n)}</p>
{/each}
```

## Options

```ts
parabunPreprocess({
  langs: ["parabun", "pts", "pjs"], // lang attribute values to transform
  all: false, // also transform plain/ts scripts
  runtime: "@lyku/para-ui", // target runtime for injected imports
});
```

- **`langs`**: which `<script lang="...">` values trigger Parabun transpilation. Defaults to `["parabun", "pts", "pjs"]`.
- **`all`**: when `true`, every `<script>` block (including bare `<script>` and `<script lang="ts">`) is run through the Parabun transpiler. Handy if you want Parabun operators everywhere without annotating each block.
- **`runtime`**: which package the preprocess emits injected imports against (`setContext`/`getContext`/`onDestroy` from `provide`/`inject`/`using` lowering). Defaults to `"@lyku/para-ui"`: the Para UI fork of Svelte with `@lyku/para-signals` at the reactive core. Pass `"svelte"` to target unmodified Svelte from npm if your project hasn't wired the fork yet. `@lyku/para-ui` is currently workspace-only: see `packages/para-svelte/PARA-FORK.md` for how to link it.

## `.pui` files

Parabun's component filetype. The preprocessor auto-detects `.pui` filenames and engages on every `<script>` block regardless of `lang`: the file extension is the marker. Migrate from `.svelte` + `<script lang="pts">` to `.pui` (with any `lang`, or bare) to get exclusive parabun-LSP editor support and avoid svelte-LSP's hardcoded TS-lang list.

Wire it up by adding the extension to the **top-level** `extensions` list -
that's the compile list vite-plugin-svelte reads. (`kit.extensions` is
SvelteKit's *routing* list: only needed when `.pui` files are themselves route
files, and never sufficient on its own.)

```js
// svelte.config.js
const config = {
  extensions: [".svelte", ".pui"],
  preprocess: [parabunPreprocess(), vitePreprocess()],
  compilerOptions: { runes: true },
};
```

After this, `.pui` files build via the standard Svelte/Vite pipeline: plain
Vite + `@sveltejs/vite-plugin-svelte` works; SvelteKit is not required. Inside
a `.pui`, write whatever `<script>` flavor reads naturally: `lang="pts"` is
the canonical form. See the parabun docs for the full `.pui` story (umbrella
ticket LYK-829).

## `.pts` / `.pjs` module files under Vite

Standalone Para modules (`+page.server.pts`, `+server.pts`, plain `.pts`
libraries) are not script blocks, so the Svelte preprocessor never sees them.
The `./vite` export ships the plugin that owns those extensions: the same
transform lyku's webui used to carry as a copy-pasted config block:

```js
// vite.config.js
import { parabunModules } from "@lyku/para-preprocess/vite";

export default defineConfig({
  plugins: [parabunModules(), svelte() /* or sveltekit() */],
});
```

It runs `enforce: "pre"`, lowers the Para syntax with `lowerParaScript`, and
hands the result to Vite's own esbuild (`.pts` → `ts` loader, `.pjs` → `jsx`).

> svelte-LSP does NOT claim `.pui` files: parabun-LSP owns them exclusively. This avoids the hardcoded lang-list issue in svelte-language-server (`getScriptKindFromAttributes` only recognizes `ts|typescript|text/ts|text/typescript`). The trade-off: until the `.pui` roadmap completes its later phases, parabun-LSP doesn't yet provide all the template-level diagnostics svelte-LSP gives for `.svelte`.

## Caveats

- Sourcemaps are not currently forwarded. `Bun.Transpiler.transformSync` doesn't emit them, so this preprocessor returns only transformed code. Line numbers stay close enough to original for most debugging; precise mapping is a follow-up.
- Chain with `vitePreprocess()` (or your TS-aware preprocessor) _after_ this one. We emit plain TS, which Svelte then type-strips.
- Only the `script` hook is implemented. Parabun syntax is not meaningful in `style` or `markup`.
- When running under Node (`svelte-language-server`, `svelte-check`) rather than Parabun, the preprocessor passes script content through unchanged but still sets `lang="ts"` so downstream tools type-check correctly. Parabun-specific operators (`..!`, `|>`, `pure`) in that path won't transpile: but parabun-LSP handles them independently in `.pts` / `.pui` files.
