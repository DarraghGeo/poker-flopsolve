/**
 * Warm starts: carrying a solve's regrets and averages into another.
 */

import { describe, expect, it } from 'vitest';
import { createRun, defineSpot } from '../src/index.ts';
import { matchNodes } from '../src/warm.ts';
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
				expect(resumed.warmStart).toEqual({ matchedNodes: resumed.spot.tree.decisionNodes.length, decisionNodes: resumed.spot.tree.decisionNodes.length, averages: true, regrets: true });
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

	it('reads an old node with more actions than any of the new tree, on wide hand lists', () => {
		// A mirrored board, so entries are means over orbits and blocks go through the buffers.
		const every = new Float64Array(1326).fill(1);
		const rich: SpotConfig = { board: 'AsKs7d2d', pot: 60, stack: 400, oop: every, ip: every, betSizes: [[0.25, 0.5, 0.75, 1, 1.5]], maxRaises: 1 };
		for (const options of [{ workers: 1 }, { workers: 1, precision: 'i16' }, ONE] as SolveOptions[]) {
			const before = createRun(defineSpot(rich), options);
			before.step(4);
			const warm = createRun(defineSpot({ ...rich, betSizes: [[1.5]] }), { ...options, warmStart: before });
			try {
				expect(before.solver.ctx.layout.maxActions).toBeGreaterThan(warm.solver.ctx.layout.maxActions);
				const { regret } = warm.solver.ctx;
				expect(regret.some((value) => Number.isNaN(value))).toBe(false);
				// The 1.5 bet is the old tree's last action: its regrets came over.
				const root = warm.spot.tree.decisionNodes[0];
				const count = warm.solver.ctx.active.count[warm.solver.ctx.active.roundBase[0] * 2 + 0];
				const base = warm.solver.ctx.layout.offset[root];
				expect(regret.subarray(base + count, base + 2 * count).some((value) => value !== 0)).toBe(true);
				warm.step(3);
				expect(Number.isFinite(warm.exploitabilityPercent())).toBe(true);
			} finally {
				before.close();
				warm.close();
			}
		}
	});

	it('takes the same board with its cards in another order', () => {
		const before = createRun(defineSpot(river), ONE);
		const straight = createRun(defineSpot(river), ONE);
		before.step(30);
		const reordered = createRun(defineSpot({ ...river, board: 'KhAs7d2c9h' }), { ...ONE, warmStart: before });
		try {
			expect(reordered.warmStart).toMatchObject({ matchedNodes: reordered.spot.tree.decisionNodes.length, averages: true });
			reordered.step(20);
			straight.step(50);
			expect(reordered.exploitabilityPercent()).toBeCloseTo(straight.exploitabilityPercent(), 9);
		} finally {
			before.close();
			straight.close();
			reordered.close();
		}
	});

	it('matches a bet by the chips it adds over the pot, on every street alike', () => {
		const base = { board: 'AsKh7d', pot: 60, stack: 400, oop: 'AA,KK,AKs', ip: 'QQ,JJ,AQs', maxRaises: 1 };
		const sizes = (turn: number): SpotConfig => ({ ...base, betSizes: [[0.66], [turn], [0.5]] });
		const before = createRun(defineSpot(sizes(0.33)), ONE);
		before.step(2);
		// 0.33 against 0.5 of the pot is a ratio of 1.5, past the tolerance, whether or not the flop was bet.
		const far = createRun(defineSpot(sizes(0.5)), { ...ONE, warmStart: before });
		// 0.33 against 0.4 is within it.
		const near = createRun(defineSpot(sizes(0.4)), { ...ONE, warmStart: before });
		try {
			const path = (run: SolveRun, node: number): string => run.snapshot().path(node);
			const unmatched = (run: SolveRun): string[] => {
				const from = before.spot.tree;
				const match = matchNodes(run.spot.tree, from);
				return Array.from(run.spot.tree.decisionNodes).filter((node) => match[node] < 0).map((node) => path(run, node));
			};
			expect(unmatched(near)).toEqual([]);
			// Every decision below a turn bet starts cold, after a checked flop and after a bet one.
			const cold = unmatched(far);
			expect(cold.length).toBeGreaterThan(0);
			expect(cold.every((line) => line.split('/')[1].includes('bet'))).toBe(true);
			expect(cold.some((line) => line.startsWith('check check /'))).toBe(true);
			expect(cold.some((line) => line.startsWith('bet'))).toBe(true);
			expect(far.warmStart!.matchedNodes).toBe(far.spot.tree.decisionNodes.length - cold.length);
		} finally {
			before.close();
			far.close();
			near.close();
		}
	});

	it('says whether it carried regrets, and refuses a count that is none', () => {
		const loaded = createRun(defineSpot(river), { analysisOnly: true });
		loaded.solver.ctx.strategySum.fill(1);
		const before = createRun(defineSpot(river), ONE);
		before.step(5);
		const bigger = defineSpot({ ...river, pot: 72 });
		const seeded = createRun(bigger, { ...ONE, warmStart: before });
		const unseeded = createRun(bigger, { ...ONE, warmStart: loaded });
		try {
			expect(seeded.warmStart).toMatchObject({ regrets: true, averages: false });
			// An analysis-only run has no regrets, and another spot's average is not taken: nothing came.
			expect(unseeded.warmStart).toMatchObject({ regrets: false, averages: false });
			for (const warmIteration of [-1, 2.5, Number.NaN]) {
				expect(() => createRun(bigger, { ...ONE, warmStart: before, warmIteration })).toThrow(/warmIteration/);
			}
		} finally {
			loaded.close();
			before.close();
			seeded.close();
			unseeded.close();
		}
	});

	it('resumes the same spot after its range was changed in place, however the range is written', () => {
		const next = 'AA-55,AKs-A7s,KQs-KTs,QJs-QTs,JTs,T9s,AKo-AJo,KQo';
		const before = createRun(defineSpot(river), ONE);
		const straight = createRun(defineSpot(river), ONE);
		for (const run of [before, straight]) {
			run.step(20);
			run.setRange(0, next);
			run.step(10);
		}
		// The same game, its range given as a string where the run's own source now holds weights.
		const resumed = createRun(defineSpot({ ...river, oop: next, board: 'As Kh 7d 2c 9h' }), { ...ONE, warmStart: before });
		try {
			expect(resumed.warmStart!.averages).toBe(true);
			expect(resumed.totalIterations).toBe(before.totalIterations);
			resumed.step(10);
			straight.step(10);
			expect(resumed.exploitabilityPercent()).toBeCloseTo(straight.exploitabilityPercent(), 9);
		} finally {
			before.close();
			straight.close();
			resumed.close();
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
