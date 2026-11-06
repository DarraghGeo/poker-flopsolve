/**
 * Warm starts: carrying a solve's regrets and averages into another.
 */

import { describe, expect, it } from 'vitest';
import { createRun, defineSpot } from '../src/index.ts';
import type { SolveOptions, SolveRun, SpotConfig } from '../src/index.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';
const river: SpotConfig = { board: 'AsKh7d2c9h', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.33, 0.75]], maxRaises: 2, allowAllIn: true };
const flop: SpotConfig = {
	board: 'Ts9s4h', pot: 60, stack: 100,
	oop: 'AA,KK,QQ,AKs,AQs,KQs,76s,65s', ip: 'JJ,TT,99,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.66]], maxRaises: 1,
};

/** Iterations until exploitability is at or under `target`, checked every few. */
function iterationsTo(run: SolveRun, target: number, cap = 400): number {
	while (run.completed < cap) {
		run.step(5);
		if (run.exploitabilityPercent() <= target) return run.completed;
	}
	return Infinity;
}

const ONE: SolveOptions = { workers: 1, precision: 'f64' };

describe('warm start', () => {
	it('continues a solve exactly where it stopped', () => {
		for (const config of [river, flop]) {
			const first = createRun(defineSpot(config), ONE);
			first.step(30);
			const resumed = createRun(defineSpot(config), { ...ONE, warmStart: first });
			resumed.step(20);
			const straight = createRun(defineSpot(config), ONE);
			straight.step(50);
			try {
				expect(resumed.warmStart).toEqual({ matchedNodes: resumed.spot.tree.decisionNodes.length, decisionNodes: resumed.spot.tree.decisionNodes.length, averages: true });
				expect(resumed.totalIterations).toBe(50);
				const a = resumed.snapshot();
				const b = straight.snapshot();
				expect(Object.is(a.ev(0), b.ev(0))).toBe(true);
				expect(Object.is(resumed.exploitabilityPercent(), straight.exploitabilityPercent())).toBe(true);
			} finally {
				first.close();
				resumed.close();
				straight.close();
			}
		}
	});

	it.each([
		['a bigger pot', { pot: 72 }],
		['a nudged bet size', { betSizes: [[0.33, 0.8]] }],
		['a reweighted range', { oop: `${OOP},AKo:0.5,KQs:0.25` }],
	] as const)('re-solves %s in fewer iterations than from scratch', (_, tweak) => {
		const before = createRun(defineSpot(river), ONE);
		before.step(300);
		const spot = { ...river, ...tweak } as SpotConfig;
		const cold = createRun(defineSpot(spot), ONE);
		const warm = createRun(defineSpot(spot), { ...ONE, warmStart: before.snapshot() });
		try {
			const coldIterations = iterationsTo(cold, 0.1);
			const warmIterations = iterationsTo(warm, 0.1);
			expect(warm.warmStart!.averages).toBe(false);
			expect(warmIterations).toBeLessThan(coldIterations);
		} finally {
			before.close();
			cold.close();
			warm.close();
		}
	});

	it('leaves unmatched actions cold and says how much matched', () => {
		const before = createRun(defineSpot(river), ONE);
		before.step(20);
		// A size the old tree never had: the nodes under it cannot match.
		const warm = createRun(defineSpot({ ...river, betSizes: [[0.33, 1.5]] }), { ...ONE, warmStart: before });
		try {
			const report = warm.warmStart!;
			expect(report.matchedNodes).toBeGreaterThan(0);
			expect(report.matchedNodes).toBeLessThan(report.decisionNodes);
			warm.step(5);
			expect(Number.isFinite(warm.exploitabilityPercent())).toBe(true);
		} finally {
			before.close();
			warm.close();
		}
	});

	it('carries over between a folded and an unfolded solve of the same flop', () => {
		const unfolded = createRun(defineSpot({ ...flop, isomorphism: false }), ONE);
		unfolded.step(30);
		const folded = createRun(defineSpot(flop), { ...ONE, warmStart: unfolded });
		try {
			expect(folded.spot.runouts.counts[2]).toBeLessThan(unfolded.spot.runouts.counts[2]);
			// Roughly where the unfolded solve left off, not back at the start.
			const from = unfolded.exploitabilityPercent();
			expect(folded.exploitabilityPercent()).toBeLessThan(from * 1.5);
		} finally {
			unfolded.close();
			folded.close();
		}
	});

	it('refuses a solve of another board', () => {
		const before = createRun(defineSpot(river), ONE);
		try {
			expect(() => createRun(defineSpot({ ...river, board: 'AsKh7d2c8h' }), { ...ONE, warmStart: before })).toThrow(/same board/);
		} finally {
			before.close();
		}
	});
});
