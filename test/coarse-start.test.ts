/**
 * Coarse start: solve a bucketed copy of the spot first, then the real one
 * from its regrets (`approximations.coarseStart`, issue #24).
 */

import { describe, expect, it } from 'vitest';
import { createRun, defineSpot, solve } from '../src/index.ts';
import type { SolveOptions, SpotConfig } from '../src/index.ts';

const flop: SpotConfig = {
	board: 'Ah Kd Qc', pot: 60, stack: 100,
	oop: 'AA-22,AKs-ATs,KQs-KTs,QJs,AKo-AJo', ip: 'KK-22,AQs-ATs,KJs+,QJs,AQo-AJo',
	betSizes: [[0.66]], maxRaises: 1,
};
const river: SpotConfig = { ...flop, board: 'Ah Kd Qc 7s 2h' };

const ONE: SolveOptions = { workers: 1 };

describe('coarse start', () => {
	it('solves the bucketed spot first and seeds every decision of the real one', () => {
		const run = createRun(defineSpot(flop), { ...ONE, approximations: { coarseStart: { iterations: 12 } } });
		try {
			// The run itself is the exact spot.
			expect(run.spot.runouts.approximate).toBe(false);
			expect(run.completed).toBe(0);
			expect(run.totalIterations).toBe(12);
			expect(run.warmStart).toEqual({
				matchedNodes: run.spot.tree.decisionNodes.length,
				decisionNodes: run.spot.tree.decisionNodes.length,
				averages: false,
			});
			run.step(3);
			expect(run.completed).toBe(3);
			expect(run.totalIterations).toBe(15);
		} finally {
			run.close();
		}
	});

	it('is closer to equilibrium than a cold solve after the same fine iterations', () => {
		const cold = createRun(defineSpot(flop), ONE);
		const coarse = createRun(defineSpot(flop), { ...ONE, approximations: { coarseStart: { iterations: 30 } } });
		try {
			cold.step(10);
			coarse.step(10);
			expect(coarse.exploitabilityPercent()).toBeLessThan(cold.exploitabilityPercent() / 2);
		} finally {
			cold.close();
			coarse.close();
		}
	});

	it('is deterministic, and a wider bucket gap is a different coarse game', () => {
		const answer = (gap: number): number => {
			const run = createRun(defineSpot(flop), { ...ONE, approximations: { coarseStart: { iterations: 8, runoutBuckets: gap } } });
			try {
				run.step(2);
				return run.snapshot().ev(0);
			} finally {
				run.close();
			}
		};
		expect(Object.is(answer(3), answer(3))).toBe(true);
		expect(answer(1)).not.toBe(answer(3));
	});

	it('runs through solve() and stops on the target', () => {
		const solution = solve(defineSpot(flop), {
			...ONE,
			targetPercent: 1,
			iterations: 200,
			approximations: { coarseStart: { iterations: 20 } },
		});
		expect(solution.stoppedAt).toBe('target');
		expect(solution.totalIterations).toBe(solution.iterations + 20);
		expect(solution.exploitabilityPercent()).toBeLessThanOrEqual(1);
	});

	it('does nothing where no runouts bucket together', () => {
		const plain = createRun(defineSpot(river), ONE);
		const run = createRun(defineSpot(river), { ...ONE, approximations: { coarseStart: { iterations: 10 } } });
		try {
			expect(run.warmStart).toBeNull();
			expect(run.totalIterations).toBe(0);
			plain.step(5);
			run.step(5);
			expect(Object.is(run.snapshot().ev(0), plain.snapshot().ev(0))).toBe(true);
		} finally {
			plain.close();
			run.close();
		}
	});

	it('refuses to combine with a warm start, and a bad iteration count', () => {
		const before = createRun(defineSpot(flop), ONE);
		try {
			expect(() =>
				createRun(defineSpot(flop), { ...ONE, warmStart: before, approximations: { coarseStart: { iterations: 5 } } }),
			).toThrow(/coarseStart/);
			expect(() => createRun(defineSpot(flop), { ...ONE, approximations: { coarseStart: { iterations: -1 } } })).toThrow(
				/coarseStart/,
			);
			expect(() =>
				createRun(defineSpot(flop), { ...ONE, approximations: { coarseStart: { iterations: 5, runoutBuckets: Number.NaN } } }),
			).toThrow(/coarseStart/);
			expect(() =>
				createRun(defineSpot(flop), { ...ONE, approximations: { coarseStart: { iterations: 5, runoutBuckets: 0 } } }),
			).toThrow(/coarseStart/);
		} finally {
			before.close();
		}
	});

	it('refuses a coarse spot that does not fit beside the real one under maxBytes', () => {
		const spot = defineSpot(flop);
		const tight = defineSpot({ ...flop, maxBytes: spot.estimate.bytes + 1024 });
		expect(() => createRun(tight, { ...ONE, precision: 'f32', approximations: { coarseStart: { iterations: 5 } } })).toThrow(/maxBytes/);
		// Room for both at 16 bits: the coarse spot drops to it rather than refuse.
		const coarse = defineSpot({ ...flop, runoutBuckets: 3 });
		const roomy = defineSpot({ ...flop, maxBytes: spot.estimate.bytes + coarse.estimate.compressedBytes + 1024 });
		const run = createRun(roomy, { ...ONE, approximations: { coarseStart: { iterations: 2 } } });
		try {
			expect(run.totalIterations).toBe(2);
		} finally {
			run.close();
		}
	});

	it('counts both runs\' sampling baselines in the coarse budget (issue #141)', () => {
		const chanceSampling = { p: 0.5 };
		const baselines = (config: SpotConfig): number => {
			const probe = createRun(defineSpot(config), { ...ONE, precision: 'f32', approximations: { chanceSampling } });
			const bytes = probe.solver.ctx.sampling!.bytes;
			probe.close();
			return bytes;
		};
		const spot = defineSpot(flop);
		const coarse = defineSpot({ ...flop, runoutBuckets: 3 });
		const main = baselines(flop);
		const own = baselines({ ...flop, runoutBuckets: 3 });
		expect(main).toBeGreaterThan(0);
		expect(own).toBeGreaterThan(0);
		const start = (maxBytes: number, precision?: 'f32' | 'i16') => () => {
			const run = createRun(defineSpot({ ...flop, maxBytes }), {
				...ONE, precision, approximations: { chanceSampling, coarseStart: { iterations: 2 } },
			});
			run.close();
		};
		// The coarse storage fits beside the real storage, but not beside its baselines too.
		expect(start(spot.estimate.compressedBytes + main + coarse.estimate.compressedBytes + 16, 'i16')).toThrow(/coarseStart/);
		expect(start(spot.estimate.compressedBytes + main + coarse.estimate.compressedBytes + own + 16, 'i16')).not.toThrow();
		expect(start(spot.estimate.bytes + coarse.estimate.bytes + own + 16, 'f32')).toThrow(/coarseStart/);
		expect(start(spot.estimate.bytes + main + coarse.estimate.bytes + 16, 'f32')).toThrow(/coarseStart/);
		// Room for everything at 32 bits.
		expect(start(spot.estimate.bytes + main + coarse.estimate.bytes + own + 16, 'f32')).not.toThrow();
		// Room for the coarse run only at 16 bits: the default drops to it.
		expect(start(spot.estimate.bytes + main + coarse.estimate.compressedBytes + own + 16)).not.toThrow();
		// Room for both only with the real run at 16 bits too (issue #148), baselines counted on each side.
		expect(start(spot.estimate.compressedBytes + main + coarse.estimate.compressedBytes + own + 16)).not.toThrow();
		expect(start(spot.estimate.compressedBytes + main + coarse.estimate.compressedBytes + 16)).toThrow(/coarseStart/);
	});

	it('drops a default real run to 16 bits where only that leaves room for the coarse run (issue #148)', () => {
		const spot = defineSpot(flop);
		const coarse = defineSpot({ ...flop, runoutBuckets: 3 });
		// 32 bits fits the real run alone, but not with the coarse run beside it;
		// the real run at 16 bits beside the coarse one at 16 bits does fit.
		const maxBytes = spot.estimate.bytes + 1024;
		expect(spot.estimate.compressedBytes + coarse.estimate.compressedBytes).toBeLessThanOrEqual(maxBytes);
		expect(spot.estimate.bytes + coarse.estimate.compressedBytes).toBeGreaterThan(maxBytes);
		const tight = defineSpot({ ...flop, maxBytes });
		const coarseStart = { iterations: 2 };
		const run = createRun(tight, { ...ONE, approximations: { coarseStart } });
		try {
			expect(run.solver.ctx.regretScale).not.toBeNull();
			expect(run.totalIterations).toBe(2);
		} finally {
			run.close();
		}
		// An explicit 32 bits is kept, and refused.
		expect(() => createRun(tight, { ...ONE, precision: 'f32', approximations: { coarseStart } })).toThrow(/coarseStart/);
		// Where the real run fits at 32 bits beside its baselines but the coarse
		// run does not fit even with both at 16 bits, the default is still refused.
		const chanceSampling = { p: 0.5 };
		const baselines = (config: SpotConfig): number => {
			const probe = createRun(defineSpot(config), { ...ONE, precision: 'f32', approximations: { chanceSampling } });
			const bytes = probe.solver.ctx.sampling!.bytes;
			probe.close();
			return bytes;
		};
		const near = defineSpot({ ...flop, runoutBuckets: 1 });
		const main = baselines(flop);
		const own = baselines({ ...flop, runoutBuckets: 1 });
		const limit = spot.estimate.bytes + main + 16;
		expect(spot.estimate.compressedBytes + main + near.estimate.compressedBytes + own).toBeGreaterThan(limit);
		expect(() => createRun(defineSpot({ ...flop, maxBytes: limit }), {
			...ONE, approximations: { chanceSampling, coarseStart: { iterations: 2, runoutBuckets: 1 } },
		})).toThrow(/coarseStart/);
	});

	it('counts the coarse solve in solve()\'s elapsed time', () => {
		const solution = solve(defineSpot(flop), { ...ONE, iterations: 1, exploitEvery: 1, approximations: { coarseStart: { iterations: 30 } } });
		const cold = solve(defineSpot(flop), { ...ONE, iterations: 1, exploitEvery: 1 });
		// Thirty coarse iterations dwarf one real iteration and its check.
		expect(solution.history[0].elapsedMs).toBeGreaterThan(cold.history[0].elapsedMs * 3);
	});
});
