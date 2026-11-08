/**
 * Regression.
 *
 * Speed work must not move the answer: with every approximation switched off,
 * these spots must give the EVs and exploitability recorded here, to one part
 * in a billion.
 *
 * Not to the last bit: V8 versions differ in the last bit of some maths (Node
 * 22 and 24 disagree at the 16th digit here), and CI runs a different Node
 * from development. One part in a billion is still far inside what a real
 * change does — regret matching is discontinuous at zero, so a change that
 * steers a solve elsewhere moves these numbers by a thousandth or more.
 *
 * If a change is MEANT to move these numbers, re-record them and say why in
 * the commit.
 */

import { describe, expect, it } from 'vitest';
import { createRun, defineSpot } from '../src/index.ts';
import { SPOTS } from './regression-spots.ts';

/**
 * [ev OOP, ev IP, exploitability % of pot]. Re-recorded when DCFR's schedule
 * changed (positive regret counted from the second iteration, γ 3): a
 * deliberate change of algorithm, not of arithmetic. Re-recorded again when
 * vectors moved to hand space: the same arithmetic summed in another order.
 * The 16-bit spots again when storage moved to hand order: their stochastic
 * rounding is seeded by storage address. The turn spots when a raise short
 * of a full one became all-in for less instead of being dropped: their tree
 * gained the 12 shoves it had been missing. All of them when strategy sums
 * stopped weighting each iteration by the hand's own reach (issue #8): a
 * deliberate change of algorithm. Exploitability at these short solves rose
 * by 3–17% (river 0.0454 → 0.0533, turn 1.407 → 1.535, flop 1.303 → 1.424,
 * two-tone flop 1.259 → 1.298); EVs moved by at most 0.026 chips.
 */
const GOLDEN: Record<string, [number, number, number]> = {
	'river f64': [1.6109510197153678, -1.6109510197153827, 0.053295044294287],
	'river i16': [1.610798446450356, -1.610798446450357, 0.05312512256457661],
	'turn f64': [2.3116184494512404, -2.311618449451233, 1.5351652227695145],
	'turn i16': [2.3149551076623056, -2.3149551076623096, 1.5454738879814245],
	'flop f64': [24.369126123475475, -24.369126123475464, 1.423527766274475],
	'flop i16': [24.369116773283107, -24.369116773283114, 1.4260328238790356],
	'two-tone flop f64': [-10.621338703103916, 10.62133870310392, 1.297830708517759],
};

describe('regression', () => {
	for (const [name, { config, iterations, precision, options }] of Object.entries(SPOTS)) {
		it(name, () => {
			const run = createRun(defineSpot(config), { workers: 1, precision, ...options });
			try {
				run.step(iterations);
				const solution = run.snapshot();
				const got = [solution.ev(0), solution.ev(1), run.exploitabilityPercent()];
				const want = GOLDEN[name];
				for (let i = 0; i < 3; i++) {
					const scale = Math.max(1, Math.abs(want[i]));
					expect(Math.abs(got[i] - want[i]) / scale, `${i}: ${got[i]} vs ${want[i]}`).toBeLessThan(1e-9);
				}
			} finally {
				run.close();
			}
		});
	}
});
