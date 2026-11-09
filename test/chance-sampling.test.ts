/**
 * Chance sampling with baselines (`Approximations.chanceSampling`): off, the
 * solve is untouched; at p = 1 it is the exact solve; below, both engines
 * pick the same deals and it still converges.
 */

import { describe, expect, it } from 'vitest';
import { createRun, defineSpot } from '../src/index.ts';
import type { SolveOptions, SpotConfig } from '../src/index.ts';
import { SPOTS } from '../bench/compare/spots.ts';
import { wasmStorage } from '../src/wasm-storage.ts';

const flop: SpotConfig = {
	board: 'Ts 9s 4h', pot: 60, stack: 100,
	oop: 'AA,KK,QQ,AKs,AQs,KQs,76s,65s', ip: 'JJ,TT,99,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.66]], maxRaises: 1,
};

function solveWith(config: SpotConfig, iterations: number, options: SolveOptions) {
	const run = createRun(defineSpot(config), { workers: 1, ...options });
	try {
		run.step(iterations);
		return {
			engine: run.engine,
			workers: run.workers,
			baseline: Float64Array.from(run.solver.ctx.sampling?.baseline ?? []),
			lastWalk: Float64Array.from(run.solver.ctx.sampling?.lastWalk ?? []),
			lastUpdate: Float64Array.from(run.solver.ctx.sampling?.lastUpdate ?? []),
			regret: Float64Array.from(run.solver.ctx.regret),
			sums: Float64Array.from(run.solver.ctx.strategySum),
			exploitability: run.exploitabilityPercent(),
			ev: run.snapshot().ev(0),
			bytes: run.solver.ctx.sampling?.bytes ?? 0,
		};
	} finally {
		run.close();
	}
}

/** Index of the first entry that differs, or -1; vitest's deep equality is too slow on storage. */
function firstDifference(a: Float64Array, b: Float64Array): number {
	if (a.length !== b.length) return -2;
	for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return i;
	return -1;
}

const sampling = (chanceSampling: NonNullable<SolveOptions['approximations']>['chanceSampling']): SolveOptions => ({
	approximations: { chanceSampling },
});

describe('chance sampling', () => {
	it('is off by default', () => {
		const run = createRun(defineSpot(flop), { workers: 1 });
		expect(run.solver.ctx.sampling ?? null).toBeNull();
		run.close();
	});

	for (const engine of [undefined, 'js'] as const) {
		for (const algorithm of ['dcfr', 'cfr+'] as const) {
			it(`at p = 1 is the exact solve, bit for bit (${engine ?? 'wasm'}, ${algorithm})`, () => {
				const exact = solveWith(flop, 12, { engine, algorithm });
				const sampled = solveWith(flop, 12, { engine, algorithm, ...sampling({ p: 1, rounds: [1, 2] }) });
				expect(sampled.engine).toBe(exact.engine);
				expect(firstDifference(sampled.regret, exact.regret)).toBe(-1);
				expect(firstDifference(sampled.sums, exact.sums)).toBe(-1);
			});
		}
	}

	it('walks fewer deals per iteration and still converges', () => {
		const exact = solveWith(flop, 100, {});
		const sampled = solveWith(flop, 100, sampling({ p: 0.5, rounds: [2] }));
		expect(sampled.bytes).toBeGreaterThan(0);
		expect(sampled.exploitability).toBeLessThan(1);
		expect(sampled.exploitability).toBeLessThan(5 * exact.exploitability);
		expect(Math.abs(sampled.ev - exact.ev)).toBeLessThan(0.5);
	});

	it('picks the same deals in both engines', () => {
		// After one iteration the engines agree to float precision, so the same
		// deals were walked; a different choice would move values by whole
		// subtrees. Then, over many, they converge alike.
		for (const options of [sampling({ p: 0.4, rounds: [1, 2] }), sampling({ every: 3 })]) {
			const wasm = solveWith(flop, 3, options);
			const js = solveWith(flop, 3, { ...options, engine: 'js' });
			expect(wasm.engine).toBe('wasm');
			expect(wasm.exploitability).toBeCloseTo(js.exploitability, 2);
			expect(wasm.ev).toBeCloseTo(js.ev, 3);
		}
		const wasm = solveWith(flop, 60, sampling({ p: 0.4 }));
		const js = solveWith(flop, 60, { ...sampling({ p: 0.4 }), engine: 'js' });
		expect(Math.abs(wasm.exploitability - js.exploitability)).toBeLessThan(0.3 * js.exploitability + 0.05);
	});

	it('samples turn deals too, with the fresh-value estimator and without catch-up', () => {
		for (const options of [
			sampling({ p: 0.5, rounds: [1, 2] }),
			sampling({ p: 0.5, catchUp: false }),
			sampling({ p: 0.5, estimator: 'latest' }),
		]) {
			expect(solveWith(flop, 60, options).exploitability).toBeLessThan(10);
		}
	});

	it('resumes a warm start without wiping the inherited regrets', () => {
		const options = sampling({ p: 0.5 });
		const first = createRun(defineSpot(flop), { workers: 1, ...options });
		first.step(40);
		const before = first.exploitabilityPercent();
		const second = createRun(defineSpot(flop), { workers: 1, ...options, warmStart: first });
		second.step(5);
		expect(second.exploitabilityPercent()).toBeLessThan(1.5 * before + 0.05);
		first.close();
		second.close();
	});

	it('refuses a p outside (0, 1]', () => {
		expect(() => createRun(defineSpot(SPOTS.turn), sampling({ p: 0 }))).toThrow(/p must/);
		expect(() => createRun(defineSpot(SPOTS.turn), sampling({ p: 1.5 }))).toThrow(/p must/);
		// The baselines count against maxBytes beside the storage.
		const tight = defineSpot({ ...flop, maxBytes: defineSpot(flop).estimate.bytes + 16 });
		expect(() => createRun(tight, { precision: 'f32', ...sampling({ p: 0.5 }) })).toThrow(/maxBytes/);
		createRun(tight, { precision: 'f32' }).close();
	});

	describe('with 16-bit storage (issue #102)', () => {
		const engines: [string, SolveOptions][] = [['js', { engine: 'js' }], ['wasm', { wasmStorage }]];
		for (const [name, engine] of engines) {
			for (const algorithm of ['dcfr', 'cfr+'] as const) {
				it(`at p = 1 is the exact 16-bit solve, bit for bit (${name}, ${algorithm})`, () => {
					const options: SolveOptions = { ...engine, precision: 'i16', algorithm };
					const exact = solveWith(flop, 12, options);
					const sampled = solveWith(flop, 12, { ...options, ...sampling({ p: 1, rounds: [1, 2] }) });
					expect(sampled.engine).toBe(name);
					expect(firstDifference(sampled.regret, exact.regret)).toBe(-1);
					expect(firstDifference(sampled.sums, exact.sums)).toBe(-1);
				});
			}
			it(`catches up the discounts a skipped subtree missed, as 32-bit storage does (${name})`, () => {
				// Without the catch-up a 16-bit block keeps regrets DCFR would
				// have halved while it was skipped, and drifts from the 32-bit solve.
				const options = sampling({ p: 0.3, rounds: [1, 2] });
				const wide = solveWith(flop, 80, { ...options, ...(name === 'js' ? { engine: 'js' as const } : {}) });
				const narrow = solveWith(flop, 80, { ...options, ...engine, precision: 'i16' });
				expect(narrow.engine).toBe(name);
				expect(narrow.lastUpdate.some((t) => t > 0)).toBe(true);
				expect(Math.abs(narrow.exploitability - wide.exploitability)).toBeLessThan(0.05 * wide.exploitability + 0.01);
			});
		}
		it('picks the same deals on the JavaScript engine as on the WebAssembly one', () => {
			const options: SolveOptions = { precision: 'i16', ...sampling({ p: 0.4, rounds: [1, 2] }) };
			const js = solveWith(flop, 3, { ...options, engine: 'js' });
			const wasm = solveWith(flop, 3, { ...options, wasmStorage });
			expect(wasm.engine).toBe('wasm');
			expect(firstDifference(wasm.lastWalk, js.lastWalk)).toBe(-1);
			expect(wasm.exploitability).toBeCloseTo(js.exploitability, 2);
		});
		it('is bitwise repeatable on threads', () => {
			const options: SolveOptions = { precision: 'i16', wasmStorage, workers: 3, ...sampling({ p: 0.4 }) };
			const a = solveWith(flop, 30, options);
			const b = solveWith(flop, 30, options);
			expect(a.workers).toBe(3);
			expect(firstDifference(a.regret, b.regret)).toBe(-1);
			expect(firstDifference(a.sums, b.sums)).toBe(-1);
			// And it converges as the 32-bit sampled solve on as many threads does.
			const wide = solveWith(flop, 30, { workers: 3, ...sampling({ p: 0.4 }) });
			expect(Math.abs(a.exploitability - wide.exploitability)).toBeLessThan(0.05 * wide.exploitability + 0.01);
		});
	});

	describe('on threads (issue #99)', () => {
		// Whether a deal is walked is a hash of its chance node, the deal and
		// the iteration, so every thread count walks the same deals; threads
		// differ from one thread only in how they associate the sums, as
		// unsampled threaded solves do.
		const options = sampling({ p: 0.4 });
		for (const engine of [undefined, 'js'] as const) {
			const name = engine ?? 'wasm';
			it(`uses the threads asked for and follows the one-thread solve (${name})`, () => {
				const one = solveWith(flop, 40, { ...options, engine });
				const three = solveWith(flop, 40, { ...options, engine, workers: 3 });
				expect(three.engine).toBe(one.engine);
				expect(three.workers).toBe(3);
				// The same deals were walked on the same iterations.
				expect(firstDifference(three.lastWalk, one.lastWalk)).toBe(-1);
				expect(firstDifference(three.lastUpdate, one.lastUpdate)).toBe(-1);
				expect(Math.abs(three.exploitability - one.exploitability)).toBeLessThan(0.01 * one.exploitability);
				expect(three.ev).toBeCloseTo(one.ev, 3);
			});

			it(`is bitwise repeatable at a fixed thread count (${name})`, () => {
				const a = solveWith(flop, 20, { ...options, engine, workers: 3 });
				const b = solveWith(flop, 20, { ...options, engine, workers: 3 });
				expect(firstDifference(a.regret, b.regret)).toBe(-1);
				expect(firstDifference(a.sums, b.sums)).toBe(-1);
				expect(firstDifference(a.baseline, b.baseline)).toBe(-1);
				expect(firstDifference(a.lastWalk, b.lastWalk)).toBe(-1);
			});
		}

		it('threads a turn spot, split at the sampled river', () => {
			for (const engine of [undefined, 'js'] as const) {
				const one = solveWith(SPOTS.turn, 10, { ...sampling({ p: 0.5, rounds: [1] }), engine });
				const four = solveWith(SPOTS.turn, 10, { ...sampling({ p: 0.5, rounds: [1] }), engine, workers: 4 });
				expect(four.workers).toBe(4);
				expect(firstDifference(four.lastWalk, one.lastWalk)).toBe(-1);
				expect(Math.abs(four.exploitability - one.exploitability)).toBeLessThan(0.01 * one.exploitability);
			}
		});

		it('picks the same deals on the JavaScript pool as on the engine threads', () => {
			const wasm = solveWith(flop, 3, { ...options, workers: 3 });
			const js = solveWith(flop, 3, { ...options, engine: 'js', workers: 3 });
			expect(wasm.engine).toBe('wasm');
			expect(js.engine).toBe('js');
			expect(firstDifference(wasm.lastWalk, js.lastWalk)).toBe(-1);
			expect(wasm.exploitability).toBeCloseTo(js.exploitability, 2);
			expect(wasm.ev).toBeCloseTo(js.ev, 3);
		});

		it('at p = 1 on threads is the exact threaded solve, bit for bit', () => {
			for (const engine of [undefined, 'js'] as const) {
				const exact = solveWith(flop, 8, { engine, workers: 3 });
				const sampled = solveWith(flop, 8, { engine, workers: 3, ...sampling({ p: 1, rounds: [1, 2] }) });
				expect(sampled.workers).toBe(3);
				expect(firstDifference(sampled.regret, exact.regret)).toBe(-1);
				expect(firstDifference(sampled.sums, exact.sums)).toBe(-1);
			}
		});

		const combos: [string, SpotConfig, SolveOptions][] = [
			['shareHistories', { ...flop, shareHistories: true }, {}],
			['runoutBuckets', { ...flop, runoutBuckets: 3 }, {}],
			['compactStorage', { ...flop, compactStorage: {} }, { engine: 'js' }],
			['shareHistories and compactStorage', { ...flop, shareHistories: true, compactStorage: {} }, { engine: 'js' }],
		];
		for (const [label, config, extra] of combos) {
			it(`works with ${label}`, () => {
				const one = solveWith(config, 40, { ...options, ...extra });
				const three = solveWith(config, 40, { ...options, ...extra, workers: 3 });
				const again = solveWith(config, 40, { ...options, ...extra, workers: 3 });
				expect(three.workers).toBe(3);
				expect(firstDifference(three.lastWalk, one.lastWalk)).toBe(-1);
				expect(firstDifference(three.regret, again.regret)).toBe(-1);
				expect(firstDifference(three.sums, again.sums)).toBe(-1);
				// Compact storage rounds at random by slot and iteration, so a
				// float-level difference can flip a rounding: looser there.
				const allowed = config.compactStorage ? 0.05 : 0.01;
				expect(Math.abs(three.exploitability - one.exploitability)).toBeLessThan(allowed * one.exploitability);
				expect(three.exploitability).toBeLessThan(10);
			});
		}

		it('converges alike on one thread and on several, iteration by iteration', () => {
			// The exploitability trajectory: checked every 10 iterations.
			const trajectory = (workers: number, engine?: 'js'): number[] => {
				const run = createRun(defineSpot(flop), { workers, engine, ...options });
				try {
					const out: number[] = [];
					for (let k = 0; k < 6; k++) {
						run.step(10);
						out.push(run.exploitabilityPercent());
					}
					return out;
				} finally {
					run.close();
				}
			};
			for (const engine of [undefined, 'js'] as const) {
				const one = trajectory(1, engine);
				const four = trajectory(4, engine);
				// Rounding grows over iterations as in unsampled threaded solves,
				// which drift up to about 0.5% of their exploitability here by 60
				// (the float32 baselines pass a last-bit change on as a small one).
				for (let k = 0; k < one.length; k++) expect(Math.abs(four[k] - one[k])).toBeLessThan(0.01 * one[k]);
				expect(one[one.length - 1]).toBeLessThan(one[0]);
			}
		});
	});
});
