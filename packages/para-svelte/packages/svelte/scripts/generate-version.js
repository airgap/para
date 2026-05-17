import fs from "node:fs";

// @lyku/para-ui is a Svelte fork. `svelte/compiler`'s exported VERSION is a
// toolchain ABI, not a vanity string: @sveltejs/kit, vite-plugin-svelte and
// svelte-check all parse it as a Svelte semver to gate behavior. Most
// consequentially, kit's isSvelte5Plus() does `Number(VERSION[0]) >= 5`; when
// that is false it emits a LEGACY root.svelte that imports `afterUpdate` —
// which is illegal in runes mode, so every SvelteKit-on-fork app fails to
// build. VERSION must therefore report the upstream Svelte version the fork
// tracks, NOT @lyku/para-ui's own 0.0.1-pre.N release (that identity lives in
// package.json and the npm dist-tag, and is intentionally separate).
//
// The upstream version is the top-most heading of CHANGELOG.md: we preserve
// upstream Svelte's changelog verbatim, so it is the canonical, self-
// maintaining source — it advances automatically as upstream releases are
// merged, with no separate constant to forget to bump.
const changelog = fs.readFileSync("CHANGELOG.md", "utf-8");
const match = changelog.match(/^##\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\s*$/m);
if (!match) {
  throw new Error(
    "generate-version: could not determine the upstream Svelte version from " +
      "CHANGELOG.md (expected a top-level `## X.Y.Z` heading as the first " +
      "release entry).",
  );
}
const SVELTE_VERSION = match[1];

fs.writeFileSync(
  "./src/version.js",
  `// generated during release, do not modify

/**
 * The upstream Svelte API version @lyku/para-ui tracks. This is a toolchain
 * ABI — @sveltejs/kit, vite-plugin-svelte and svelte-check parse it as a
 * Svelte semver — so it is the upstream version, NOT @lyku/para-ui's own
 * 0.0.1-pre.N release (that lives in package.json / the npm dist-tag).
 * @type {string}
 */
export const VERSION = '${SVELTE_VERSION}';

/**
 * Svelte-API major we're compatible with. Used by the Svelte browser
 * devtools extension to detect the runtime via window.__svelte.v.
 * @type {string}
 */
export const PUBLIC_VERSION = '5';
`,
);
