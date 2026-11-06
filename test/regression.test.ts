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
 * deliberate change of algorithm, not of arithmetic. Re-recorded again when
 * vectors moved to hand space: the same arithmetic summed in another order.
 */
const GOLDEN: Record<string, [number, number, number]> = {
	'river f64': [1.6108255310577881, -1.610825531057795, 0.04537223276200597],
	'river i16': [1.6106723949542092, -1.610672394954209, 0.04490731321574996],
	'turn f64': [2.2672970671217665, -2.267297067121758, 1.2254650434784637],
	'turn i16': [2.3001197676847958, -2.300119767684791, 1.170242552578521],
	'flop f64': [24.35116758043512, -24.351167580435117, 1.30310737854814],
	'flop i16': [24.35113838852795, -24.351138388527946, 1.305182445501319],
	'two-tone flop f64': [-10.602679146562574, 10.602679146562577, 1.2593765618876374],
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
