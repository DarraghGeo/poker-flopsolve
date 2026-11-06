/**
 * The WebAssembly SIMD kernels change nothing but speed.
 */

import { describe, expect, it } from 'vitest';
import { createRun, defineSpot, simdAvailable } from '../src/index.ts';
import type { Precision, SolveOptions, SpotConfig } from '../src/index.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';
const turn: SpotConfig = { board: 'AsKh7d2c', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.33, 0.75]], maxRaises: 2 };
const flop: SpotConfig = {
	board: 'Ts9s4h', pot: 60, stack: 100,
	oop: 'AA,KK,QQ,AKs,AQs,KQs,76s,65s', ip: 'JJ,TT,99,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.66]], maxRaises: 1,
};

function outcome(config: SpotConfig, iterations: number, options: SolveOptions): number[] {
	const run = createRun(defineSpot(config), options);
	try {
		run.step(iterations);
		const solution = run.snapshot();
		return [solution.ev(0), solution.ev(1), run.exploitabilityPercent()];
	} finally {
		run.close();
	}
}

describe('SIMD kernels', () => {
	it('load on this platform', () => {
		expect(simdAvailable()).toBe(true);
	});

	for (const precision of ['f64', 'f32', 'i16'] as Precision[]) {
		it(`match JavaScript to the last bit at ${precision}`, () => {
			const js = outcome(turn, 15, { workers: 1, precision, simd: false });
			const wasm = outcome(turn, 15, { workers: 1, precision, simd: true });
			for (let i = 0; i < 3; i++) expect(Object.is(js[i], wasm[i]), `${js[i]} vs ${wasm[i]}`).toBe(true);
		});
	}

	it('match JavaScript across workers and folded runouts', () => {
		const js = outcome(flop, 10, { workers: 4, simd: false });
		const wasm = outcome(flop, 10, { workers: 4, simd: true });
		for (let i = 0; i < 3; i++) expect(Object.is(js[i], wasm[i]), `${js[i]} vs ${wasm[i]}`).toBe(true);
	});
});
