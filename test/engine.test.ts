/**
 * The WebAssembly traversal engine against the JavaScript one.
 *
 * The engine runs the same algorithm in 32-bit floats, so after one
 * iteration — before regret matching's jump at zero can amplify rounding —
 * the two agree to float precision; after many they reach the same accuracy
 * by slightly different paths.
 */

import { describe, expect, it } from 'vitest';
import { createRun, defineSpot } from '../src/index.ts';
import type { SolveOptions, SpotConfig } from '../src/index.ts';
import { engineAvailable } from '../src/engine.ts';
import { SPOTS } from '../bench/compare/spots.ts';

const twotone: SpotConfig = {
	board: 'Ts 9s 4h', pot: 60, stack: 100,
	oop: 'AA,KK,QQ,AKs,AQs,KQs,76s,65s', ip: 'JJ,TT,99,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.66]], maxRaises: 1,
};

function solveWith(config: SpotConfig, iterations: number, options: SolveOptions) {
	const run = createRun(defineSpot(config), { workers: 1, precision: 'f32', ...options });
	try {
		run.step(iterations);
		const solution = run.snapshot();
		const root = solution.strategyAt(solution.spot.tree.decisionNodes[0], 0);
		return { ev: solution.ev(0), exploitability: run.exploitabilityPercent(), root: Array.from(root.probs) };
	} finally {
		run.close();
	}
}

describe('WebAssembly engine', () => {
	it('is available here', () => {
		expect(engineAvailable()).toBe(true);
	});

	for (const [name, config] of [['river', SPOTS.river], ['turn', SPOTS.turn], ['two-tone flop', twotone]] as const) {
		it(`agrees with JavaScript after one iteration on the ${name}`, () => {
			const wasm = solveWith(config, 1, {});
			const js = solveWith(config, 1, { engine: 'js' });
			expect(wasm.ev).toBeCloseTo(js.ev, 4);
			expect(wasm.exploitability).toBeCloseTo(js.exploitability, 3);
			for (let i = 0; i < js.root.length; i++) expect(wasm.root[i]).toBeCloseTo(js.root[i], 5);
		});
	}

	it('converges as JavaScript does, under DCFR and CFR+', () => {
		for (const algorithm of ['dcfr', 'cfr+'] as const) {
			const wasm = solveWith(SPOTS.turn, 60, { algorithm });
			const js = solveWith(SPOTS.turn, 60, { algorithm, engine: 'js' });
			expect(Math.abs(wasm.exploitability - js.exploitability)).toBeLessThan(0.25 * js.exploitability);
			expect(Math.abs(wasm.ev - js.ev)).toBeLessThan(0.05);
		}
	});

	it('runs by default at 32 bits, on any number of threads, and steps aside elsewhere', () => {
		const engineOf = (options: SolveOptions): string => {
			const run = createRun(defineSpot(SPOTS.turn), { workers: 1, precision: 'f32', ...options });
			try {
				return run.engine;
			} finally {
				run.close();
			}
		};
		expect(engineOf({})).toBe('wasm');
		expect(engineOf({ precision: 'f64' })).toBe('js');
		expect(engineOf({ precision: 'i16' })).toBe('js');
		expect(engineOf({ workers: 4 })).toBe('wasm');
		expect(engineOf({ engine: 'js' })).toBe('js');
	});

	it('splits a solve across threads as it runs on one', () => {
		// After one iteration, before rounding can compound: the same numbers
		// to float precision. Then the pooled storage measured by one thread.
		for (const config of [SPOTS.turn, twotone]) {
			const one = solveWith(config, 1, {});
			const four = solveWith(config, 1, { workers: 4 });
			expect(four.ev).toBeCloseTo(one.ev, 4);
			expect(four.exploitability).toBeCloseTo(one.exploitability, 3);
		}
		const run = createRun(defineSpot(twotone), { workers: 4, precision: 'f32' });
		try {
			expect(run.engine).toBe('wasm');
			expect(run.workers).toBe(4);
			run.step(10);
			const pooled = run.exploitabilityPercent();
			run.solver.useRoot(null);
			expect(run.exploitabilityPercent()).toBeCloseTo(pooled, 3);
		} finally {
			run.close();
		}
	});

	it('serves strategy queries and warm starts from its own storage', () => {
		const run = createRun(defineSpot(SPOTS.river), { workers: 1, precision: 'f32' });
		try {
			run.step(30);
			const solution = run.snapshot();
			const view = solution.strategyAt(solution.spot.tree.decisionNodes[0], 0);
			for (let i = 0; i < view.combos.length; i++) {
				let total = 0;
				for (let a = 0; a < view.actions.length; a++) total += view.probs[i * view.actions.length + a];
				expect(total).toBeCloseTo(1, 5);
			}
			const resumed = createRun(defineSpot(SPOTS.river), { workers: 1, precision: 'f32', warmStart: run });
			try {
				expect(resumed.engine).toBe('wasm');
				expect(resumed.exploitabilityPercent()).toBeCloseTo(run.exploitabilityPercent(), 3);
			} finally {
				resumed.close();
			}
		} finally {
			run.close();
		}
	});
});
