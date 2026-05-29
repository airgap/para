// Regression: derived D depends on A and B. A batch updates BOTH.
// Invariant under test: a para observer of signalOf(D) must NOT see D mirrored
// against an intermediate (newA, oldB) that the batch coalesces away.
//
// This is a STORAGE/laziness property, not a scheduler-coordination one:
//   1. Deriveds are lazy — set(A)/set(B) only mark D dirty, never recompute it.
//   2. A derived's para mirror fires only from inside recompute
//      (update_derived → Batch.capture → mirror_to_para; sources.js / batch.js).
//   3. The read that triggers recompute happens after both writes settle, so the
//      single recompute sees (newA, newB).
// deriveds.js:422 (the no-batch mirror) is NOT a tearing surface: during a batch
// current_batch !== null, so recompute takes the capture path, not line 422.
//
// We instrument BOTH sides:
//   computedWith[] — every (a,b) pair the derived's compute fn actually ran on
//   seen[]         — every value the para observer received via signalOf(D)
// A (newA, oldB) entry in either array == tearing == regression.

import { describe, expect, it } from 'vitest';
import { state, set, signalOf, derived, get, flush } from 'svelte/internal/client';
// @ts-expect-error — link: dep, types are .js JSDoc-only
import { effect } from '@lyku/para-signals';

describe('derived para-mirror tearing across a two-dep batch', () => {
	it('NO intermediate: batch updating A and B mirrors D once, against (newA,newB)', () => {
		const a = state(1);
		const b = state(1);
		const computedWith: string[] = [];
		const d = derived(() => {
			const av = get(a),
				bv = get(b);
			computedWith.push(`${av},${bv}`);
			return av + bv;
		});

		// seed
		expect(get(d)).toBe(2);
		const seen: number[] = [];
		const stop = effect(() => seen.push(signalOf(d)!.get()));
		expect(seen).toEqual([2]);
		expect(computedWith).toEqual(['1,1']);

		// One batch updates BOTH deps. Synchronous sets auto-batch (current_batch
		// stays live until flush). Deriveds are lazy → neither set recomputes D.
		set(a, 10);
		set(b, 100);

		// Before anything reads D: no recompute, no mirror, observer untouched.
		expect(seen).toEqual([2]);
		expect(computedWith).toEqual(['1,1']);

		// Now the framework reads D (a render effect would do this at flush).
		expect(get(d)).toBe(110);

		// D recomputed exactly once, against (10,100). The observer saw 2 → 110.
		expect(computedWith).toEqual(['1,1', '10,100']); // no '10,1'
		expect(seen).toEqual([2, 110]); // no 11
		stop();
	});

	it('same result when the batch is wrapped in flush()', () => {
		const a = state(1);
		const b = state(1);
		const computedWith: string[] = [];
		const d = derived(() => {
			const r = `${get(a)},${get(b)}`;
			computedWith.push(r);
			return get(a) + get(b);
		});
		expect(get(d)).toBe(2);
		const seen: number[] = [];
		const stop = effect(() => seen.push(signalOf(d)!.get()));

		flush(() => {
			set(a, 10);
			set(b, 100);
		});
		get(d);

		expect(computedWith).toEqual(['1,1', '10,100']);
		expect(seen).toEqual([2, 110]);
		stop();
	});

	it('CONTRAST: an explicit read BETWEEN the two sets does expose (newA,oldB) — but that is a chosen read, not a coalescing failure', () => {
		const a = state(1);
		const b = state(1);
		const computedWith: string[] = [];
		const d = derived(() => {
			computedWith.push(`${get(a)},${get(b)}`);
			return get(a) + get(b);
		});
		expect(get(d)).toBe(2);
		const seen: number[] = [];
		const stop = effect(() => seen.push(signalOf(d)!.get()));

		set(a, 10);
		get(d); // <-- caller explicitly reads at the intermediate point
		set(b, 100);
		get(d);

		// The intermediate (10,1)=11 appears ONLY because something read D there.
		// Stock Svelte recomputes identically on such a read; the bridge faithfully
		// mirrors Svelte's view. This is not tearing — it's a read the code asked for.
		expect(computedWith).toEqual(['1,1', '10,1', '10,100']);
		expect(seen).toEqual([2, 11, 110]);
		stop();
	});
});
