import fs from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createBundle } from 'dts-buddy';

const dir = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(`${dir}/package.json`, 'utf-8'));

// For people not using moduleResolution: 'bundler', we need to generate these files. Think about removing this in Svelte 6 or 7
// It may look weird, but the imports MUST be ending with index.js to be properly resolved in all TS modes
for (const name of ['action', 'animate', 'easing', 'motion', 'store', 'transition', 'legacy']) {
	fs.writeFileSync(`${dir}/${name}.d.ts`, "import './types/index.js';\n");
}

fs.writeFileSync(`${dir}/index.d.ts`, "import './types/index.js';\n");
fs.writeFileSync(`${dir}/compiler.d.ts`, "import './types/index.js';\n");

// TODO: Remove these in Svelte 6. They are here so that tooling (which historically made use of these) can support Svelte 4-6 in one minor version
fs.mkdirSync(`${dir}/types/compiler`, { recursive: true });
fs.writeFileSync(`${dir}/types/compiler/preprocess.d.ts`, "import '../index.js';\n");
fs.writeFileSync(`${dir}/types/compiler/interfaces.d.ts`, "import '../index.js';\n");

await createBundle({
	output: `${dir}/types/index.d.ts`,
	compilerOptions: {
		// so that types/properties with `@internal` (and its dependencies) are removed from the output
		stripInternal: true,
		paths: Object.fromEntries(
			Object.entries(pkg.imports).map(
				/** @param {[string,any]} import */ ([key, value]) => {
					return [key, [value.types ?? value.default ?? value]];
				}
			)
		)
	},
	// para-ui is consumed as a drop-in `svelte` via an npm alias
	// (`"svelte": "npm:@lyku/para-ui"`), so the generated ambient module
	// declarations MUST use the `svelte` specifier — not the package's own
	// name. Declaring `@lyku/para-ui` here meant consumers importing `svelte`
	// (every Svelte/SvelteKit app) got no types under moduleResolution:node,
	// breaking type-checking. Mirror upstream Svelte's module names.
	modules: {
		['svelte']: `${dir}/src/index.d.ts`,
		[`svelte/action`]: `${dir}/src/action/public.d.ts`,
		[`svelte/animate`]: `${dir}/src/animate/public.d.ts`,
		[`svelte/attachments`]: `${dir}/src/attachments/public.d.ts`,
		[`svelte/compiler`]: `${dir}/src/compiler/public.d.ts`,
		[`svelte/easing`]: `${dir}/src/easing/index.js`,
		[`svelte/legacy`]: `${dir}/src/legacy/legacy-client.js`,
		[`svelte/motion`]: `${dir}/src/motion/public.d.ts`,
		[`svelte/reactivity`]: `${dir}/src/reactivity/index-client.js`,
		[`svelte/reactivity/window`]: `${dir}/src/reactivity/window/index.js`,
		[`svelte/server`]: `${dir}/src/server/index.d.ts`,
		[`svelte/store`]: `${dir}/src/store/public.d.ts`,
		[`svelte/transition`]: `${dir}/src/transition/public.d.ts`,
		[`svelte/events`]: `${dir}/src/events/public.d.ts`,
		// TODO remove in Svelte 6
		[`svelte/types/compiler/preprocess`]: `${dir}/src/compiler/preprocess/legacy-public.d.ts`,
		[`svelte/types/compiler/interfaces`]: `${dir}/src/compiler/types/legacy-interfaces.d.ts`
	}
});

fs.appendFileSync(`${dir}/types/index.d.ts`, '\n');

const types = fs.readFileSync(`${dir}/types/index.d.ts`, 'utf-8');

const bad_links = [...types.matchAll(/\]\((\/[^)]+)\)/g)];
if (bad_links.length > 0) {
	// eslint-disable-next-line no-console
	console.error(
		`The following links in JSDoc annotations should be prefixed with https://svelte.dev:`
	);

	for (const [, link] of bad_links) {
		// eslint-disable-next-line no-console
		console.error(`- ${link}`);
	}

	process.exit(1);
}

if (types.includes('\texport { ')) {
	// eslint-disable-next-line no-console
	console.error(
		`The generated types file should not contain 'export { ... }' statements. ` +
			`TypeScript is bad at following these: when creating d.ts files through @sveltejs/package, and one of these types is used, ` +
			`TypeScript will likely fail at generating a d.ts file. ` +
			`To prevent this, do 'export interface Foo {}' instead of 'interface Foo {}' and then 'export { Foo }'`
	);
	process.exit(1);
}
