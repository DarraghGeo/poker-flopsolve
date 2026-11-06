/**
 * Bit-for-bit regression.
 *
 * Speed work must not move the answer: with every approximation switched off,
 * these spots must give exactly the EVs and exploitability recorded here, to
 * the last bit. Regret matching is discontinuous at zero, so a change that
 * only reorders some additions can still steer a solve somewhere else, and a
 * tolerance would hide exactly that.
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
 * deliberate change of algorithm, not of arithmetic.
 */
const GOLDEN: Record<string, [number, number, number]> = {
	'river f64': [1.6108255310577921, -1.6108255310578037, 0.04537223276194102],
	'river i16': [1.6106723949542066, -1.6106723949542106, 0.044907313215739784],
	'turn f64': [2.26386273279109, -2.263862732791071, 1.1640787843181428],
	'turn i16': [2.3001187658238424, -2.3001187658238447, 1.1701944415546086],
	'flop f64': [24.351167580435124, -24.351167580435135, 1.303107378548113],
	'flop i16': [24.351138388527353, -24.351138388527346, 1.3051824456953536],
	'two-tone flop f64': [-10.601921236755064, 10.601921236755066, 1.2577309683266218],
};

describe('bit-for-bit regression', () => {
	for (const [name, { config, iterations, precision, options }] of Object.entries(SPOTS)) {
		it(name, () => {
			const run = createRun(defineSpot(config), { workers: 1, precision, ...options });
			try {
				run.step(iterations);
				const solution = run.snapshot();
				const got = [solution.ev(0), solution.ev(1), run.exploitabilityPercent()];
				const want = GOLDEN[name];
				for (let i = 0; i < 3; i++) expect(Object.is(got[i], want[i]), `${i}: ${got[i]} vs ${want[i]}`).toBe(true);
			} finally {
				run.close();
			}
		});
	}
});
