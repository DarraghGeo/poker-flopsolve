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

/** [ev OOP, ev IP, exploitability % of pot], recorded before the speed work. */
const GOLDEN: Record<string, [number, number, number]> = {
	'river f64': [1.6092067960637912, -1.6092067960637977, 0.0466847563221238],
	'river i16': [1.6087809692278394, -1.6087809692278339, 0.05154530635164652],
	'turn f64': [2.2332033377766654, -2.2332033377766765, 1.4056505652600086],
	'turn i16': [2.21568594406334, -2.2156859440633383, 1.4379470943927124],
	'flop f64': [23.98900827747199, -23.989008277471985, 1.257594310809654],
	'flop i16': [23.987200829631334, -23.987200829631345, 1.25583921103081],
	'two-tone flop f64': [-10.625033897828304, 10.625033897828311, 1.4224754019112746],
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
