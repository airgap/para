import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8"));

// Para Svelte: VERSION tracks the published @lyku/para-ui version.
// PUBLIC_VERSION is the Svelte-API major we're compatible with — hardcoded
// to '5' so the Svelte browser devtools extension (which inspects
// window.__svelte.v) recognizes Para-rendered apps. Honest about which API
// surface we expose, not a misrepresentation of @lyku/para-ui's own
// 0.0.1-pre.N version.
fs.writeFileSync(
  "./src/version.js",
  `// generated during release, do not modify

/**
 * The current version of @lyku/para-ui, as set in package.json.
 * @type {string}
 */
export const VERSION = '${pkg.version}';

/**
 * Svelte-API major we're compatible with. Used by Svelte browser devtools
 * to detect the runtime via window.__svelte.v. NOT @lyku/para-ui's own
 * version (see VERSION) — this is the API surface we expose.
 * @type {string}
 */
export const PUBLIC_VERSION = '5';
`,
);
