// End-to-end: a .pui-flavored component goes through @lyku/para-preprocess's
// keyword lowering, then through the fork's compiler, mounts in jsdom, and
// the para signal that backs `signal count = 0` is observable from outside
// the component while the DOM updates in lockstep.
//
// This is the strongest test of the F0 stack as a system: preprocess ↔
// compile ↔ runtime ↔ bridge all wired up the way a real .pui app would
// hit them.

// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { compile } from 'svelte/compiler';
import { mount, unmount, flushSync } from 'svelte';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
// @ts-expect-error — workspace link, JSDoc-only types
import { effect } from '@lyku/para-signals';
import { parabunPreprocess } from '../../../../para-preprocess/src/index';

/**
 * Run the preprocess against a script source the way @lyku/para-preprocess
 * would for a real .pui file. Returns the lowered script body.
 */
async function lowerPuiScript(scriptBody: string): Promise<string> {
	// hmr: false pins the emission. With hmr on (the default off production),
	// the bridge is `import.meta.hot ? hmrSignal(...) : signal(0)`, and the
	// `signal(0)` this test rewrites below is then the one inside the hmrSignal
	// thunk rather than the allocation.
	const pp = parabunPreprocess({ hmr: false });
	const script = (pp as { script?: (a: unknown) => unknown }).script!;
	const out = (await script({
		content: scriptBody,
		attributes: {},
		filename: '/tmp/test.pui',
		markup: ''
	})) as { code?: string } | undefined;
	return out?.code ?? scriptBody;
}

describe('para .pui end-to-end', () => {
	it('preprocess → compile → mount → signalOf observes reactive state', async () => {
		// ── 1. Source (what a user would write in a .pui file) ──────────────
		// `signalOf(count)` is load-bearing, not decoration. LYK-886 added escape
		// analysis: a signal that provably cannot leave the component lowers to a
		// plain `$state` with no para bridge and no import, which is the right
		// output and exactly what this test does NOT want to exercise. signalOf is
		// the documented "keep this para-observable" intent, so it is what a real
		// component bridging to para would carry.
		//
		// Without it this test asserted a lowering the compiler had stopped
		// producing, and had been failing since LYK-886.
		const puiScript = `signal count = 0;\nsignalOf(count);`;
		const lowered = await lowerPuiScript(puiScript);

		// The lowering emits:
		//   import { signal } from "@lyku/para-signals";
		//   const __sig_count = signal(0);
		//   let count = $state(__sig_count.peek());
		//   $effect.pre(() => __sig_count.subscribe((v) => { count = v; }));
		expect(lowered).toMatch(/from\s+["']@lyku\/para-signals["']/);
		expect(lowered).toContain('__sig_count');

		// Wrap into a full component. Export the para signal so the test can
		// mutate it from outside (mirrors how a real consumer would expose it).
		const componentSource = `
<script module>
  import { signal } from "@lyku/para-signals";
  export const externalCount = signal(0);
</script>

<!-- lang=ts because the bridge annotates its $effect.pre callback param
     (__v: typeof count), so the instance script is TypeScript. The old
     local-only lowering emitted no annotation, which is why a plain script
     tag was enough before. -->
<script lang="ts">
${lowered
	.replace(/import { signal } from "@lyku\/para-signals";\n?/, '')
	// The escape marker did its job at lowering time; it is not component code,
	// and signalOf is not imported here.
	.replace(/^\s*signalOf\(count\);\s*$/m, '')
	.replace(
		'signal(0)',
		'externalCount' // alias the in-component signal to the module-level one
	)}
</script>

<p>{count}</p>
`;

		// ── 2. Compile via the fork's compiler ──────────────────────────────
		const compiled = compile(componentSource, {
			generate: 'client',
			filename: 'Counter.svelte',
			dev: false
		});

		expect(compiled.warnings.filter((w) => w.code !== 'non_reactive_update')).toEqual([]);

		// ── 3. Write to disk so dynamic import resolves bare specifiers ─────
		// Vite-under-vitest only resolves modules inside the project tree,
		// so the tmp dir lives next to the test file rather than in /tmp.
		const tmpDir = fs.mkdtempSync(
			path.join(path.dirname(fileURLToPath(import.meta.url)), '.para-e2e-')
		);
		const modPath = path.join(tmpDir, 'Counter.js');
		fs.writeFileSync(modPath, compiled.js.code);

		// ── 4. Mount into jsdom ─────────────────────────────────────────────
		const Counter = (await import(pathToFileURL(modPath).href)).default;
		const target = document.createElement('div');
		document.body.appendChild(target);
		const instance = mount(Counter, { target });

		expect(target.innerHTML).toContain('<p>0</p>');

		// ── 5. Mutate via the module-exported para signal — DOM should react ─
		const mod = await import(pathToFileURL(modPath).href);
		// The module file is the same import as Counter; externalCount was on
		// the module-script-block which the compiler hoists to module-level.
		// It's exposed via the .svelte's module exports.
		const external = mod.externalCount;
		expect(external).toBeDefined();
		expect(external.peek()).toBe(0);

		external.set(5);
		flushSync();
		expect(target.innerHTML).toContain('<p>5</p>');

		external.set(42);
		flushSync();
		expect(target.innerHTML).toContain('<p>42</p>');

		// ── 6. Cleanup ──────────────────────────────────────────────────────
		unmount(instance);
		target.remove();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
});
