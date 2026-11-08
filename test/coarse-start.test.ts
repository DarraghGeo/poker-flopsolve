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
		} finally {
			before.close();
		}
	});
});
