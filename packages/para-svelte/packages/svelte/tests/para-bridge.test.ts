// F0.3 smoke test — verifies the additive @lyku/para-signals bridge planted in
// internal/client/reactivity/sources.js works end-to-end.
//
// Note: the public export is `state`, the internal function is `source`.
// `state(v)` is `source(v)` plus push_reaction_value bookkeeping.
//
// What this proves:
//   1. state(v) allocates a Source with a backing para signal.
//   2. signalOf(source).peek() returns the initial value.
//   3. set(source, v2) mirrors the write to the para signal.
//   4. A para effect() reading signalOf(source).get() fires on the write.
//
// What this does NOT prove (yet — F0.5+):
//   - Derived recompute → para signal sync.
//   - Props bridge.
//   - Proxy per-property bridge.
//   - Cross-batch coordination semantics.

import { describe, expect, it } from 'vitest';
import { state, set, signalOf, derived, get, mutable_source } from 'svelte/internal/client';
// @ts-expect-error — link: dep, types are .js JSDoc-only
import { effect } from '@lyku/para-signals';

describe('para bridge — sources.js', () => {
	it('state(v) attaches a para signal mirroring .v', () => {
		const s = state(42);
		const para = signalOf(s);
		expect(para).toBeDefined();
		expect(para!.peek()).toBe(42);
	});

	it('set(state, v) writes to .v AND the para signal', () => {
		const s = state(1);
		set(s, 2);
		expect(s.v).toBe(2);
		expect(signalOf(s)!.peek()).toBe(2);
	});

	it('a para effect observes Svelte state writes via signalOf', () => {
		const s = state('initial');
		const seen: string[] = [];
		const stop = effect(() => seen.push(signalOf(s)!.get()));
		expect(seen).toEqual(['initial']);
		set(s, 'second');
		set(s, 'third');
		expect(seen).toEqual(['initial', 'second', 'third']);
		stop();
		set(s, 'after-stop');
		expect(seen).toEqual(['initial', 'second', 'third']);
	});

	it('derived recompute mirrors to its para signal (F0.5)', () => {
		const a = state(2);
		const d = derived(() => get(a) * 10);
		// Force compute first — signalOf is lazy and would otherwise seed from
		// Svelte's UNINITIALIZED sentinel. After a real read, paraSignal seeds
		// from the computed value.
		expect(get(d)).toBe(20);
		expect(signalOf(d)!.peek()).toBe(20);

		const seen: number[] = [];
		const stop = effect(() => seen.push(signalOf(d)!.get()));
		expect(seen[0]).toBe(20);

		// Recompute only happens when something reads the derived. A para
		// observer of signalOf(d) doesn't trigger Svelte's get(d) on its own —
		// that's by design (the bridge mirrors Svelte's view, doesn't drive it).
		// In a real .pui component, Svelte's render effects do the reads.
		set(a, 5);
		expect(get(d)).toBe(50);
		set(a, 7);
		expect(get(d)).toBe(70);
		expect(seen).toEqual([20, 50, 70]);
		stop();
	});

	it('mutable_source (legacy store/prop backing) gets the bridge (F0.6)', () => {
		// Props.js routes writable props through derived(); legacy stores route
		// through mutable_source(). Both ultimately call source() — confirm
		// mutable_source allocates paraSignal too.
		const m = mutable_source(42);
		expect(signalOf(m)!.peek()).toBe(42);
		set(m, 100);
		expect(signalOf(m)!.peek()).toBe(100);
	});

	it('equality short-circuit applies to both axes (no spurious notify)', () => {
		const s = state(7);
		const seen: number[] = [];
		const stop = effect(() => seen.push(signalOf(s)!.get()));
		expect(seen).toEqual([7]);
		set(s, 7); // same value — Svelte's source.equals returns true; bridge MUST skip
		expect(seen).toEqual([7]);
		set(s, 8);
		expect(seen).toEqual([7, 8]);
		stop();
	});
});
