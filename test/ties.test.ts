/**
 * Exactly tied actions (issue #117).
 *
 * Where a hand's actions are worth the same, its regrets are analytically 0,
 * but the node value it is measured against is a strategy-weighted sum and
 * comes out an ulp off, by a sign that depends on summation order. Regret
 * matching jumps at zero, so before the snap those ulps put 1 and 2 threads,
 * and the two engines, percents apart on the root strategy after 12
 * iterations. With it they agree to float rounding there, as on a spot
 * without ties.
 */

import { describe, expect, it } from 'vitest';
import { snapTies, TIE_TOLERANCE } from '../src/cfr.ts';
import { engineAvailable } from '../src/engine.ts';
import { createRun, defineSpot } from '../src/index.ts';
import type { SolveOptions, SpotConfig } from '../src/index.ts';

/** The pair matrix's turn with the lite preset's betting: one river size, no all-in, and exact ties. */
const tied: SpotConfig = {
	board: 'Ah Kd Qc 8s', pot: 60, stack: 90,
	oop: 'AA,KK,55,44,AKs,KQs', ip: 'QQ,JJ,33,22,AQs,QJs',
	betSizes: [[0.5, 1], [1]], raiseSizes: [[1], [1]], maxRaises: [2, 1], allowAllIn: [false, false],
};

function root(options: SolveOptions): Float64Array {
	const run = createRun(defineSpot(tied), options);
	try {
		run.step(12);
		return Float64Array.from(run.snapshot().strategyAt(0, 0).probs);
	} finally {
		run.close();
	}
}

const maxDiff = (a: Float64Array, b: Float64Array): number => {
	expect(a.length).toBe(b.length);
	let worst = 0;
	for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
	return worst;
};

describe('snapTies', () => {
	it('sets an action value within the tolerance of the node value to it, exactly', () => {
		const value = 8.25;
		const ulp32 = 2 ** -20; // one float32 ulp at 8
		const actionValues = Float64Array.from([value + ulp32, value - 1.8e-15, value * (1 + 2 * TIE_TOLERANCE), 3, value]);
		const out = Float64Array.from([value]);
		snapTies(actionValues, out, 5, 1);
		expect(Array.from(actionValues)).toEqual([value, value, value * (1 + 2 * TIE_TOLERANCE), 3, value]);
	});

	it('compares each hand with its own value, rows laid out as actions', () => {
		// Two actions of two hands: hand 0 tied at 100, hand 1 not tied at 1e-3.
		const actionValues = Float64Array.from([100 + 1e-5, 1e-3, 100 - 1e-5, 2e-3]);
		const out = Float64Array.from([100, 1.5e-3]);
		snapTies(actionValues, out, 2, 2);
		expect(Array.from(actionValues)).toEqual([100, 1e-3, 100, 2e-3]);
	});

	it('leaves values near zero alone unless they are ties of each other', () => {
		const actionValues = Float64Array.from([1e-20, -1e-20, 0]);
		const out = Float64Array.from([0]);
		snapTies(actionValues, out, 3, 1);
		expect(Array.from(actionValues)).toEqual([1e-20, -1e-20, 0]);
	});
});

describe.runIf(engineAvailable())('exactly tied actions', () => {
	it('1 and 2 threads agree on the root to float rounding after 12 iterations', () => {
		expect(maxDiff(root({ workers: 1 }), root({ workers: 2 }))).toBeLessThan(1e-4);
	});

	it('the two engines agree on the root to float rounding after 12 iterations', () => {
		expect(maxDiff(root({ workers: 1 }), root({ workers: 1, engine: 'js' }))).toBeLessThan(1e-4);
	});
});
