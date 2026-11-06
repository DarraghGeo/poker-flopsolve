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
 * rounding is seeded by storage address.
 */
const GOLDEN: Record<string, [number, number, number]> = {
	'river f64': [1.6108255310577881, -1.610825531057795, 0.04537223276200597],
	'river i16': [1.6106738835010792, -1.6106738835010943, 0.04492205205962071],
	'turn f64': [2.2672970671217665, -2.267297067121758, 1.2254650434784637],
	'turn i16': [2.300121638226857, -2.3001216382268668, 1.1702456592313062],
	'flop f64': [24.35116758043512, -24.351167580435117, 1.30310737854814],
	'flop i16': [24.351099300264092, -24.351099300264103, 1.3051918847809054],
	'two-tone flop f64': [-10.602679146562574, 10.602679146562577, 1.2593765618876374],
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
