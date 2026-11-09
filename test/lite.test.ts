/**
 * Lite mode (issue #100): the blueprint `liteConfig` derives from a caller's
 * betting, the `settle` stopping rule, and `solveLite` with its re-solver.
 */

import { describe, expect, it } from 'vitest';
import {
	bettingFrom, createRun, defineSpot, liteConfig, NodeKind, rootPlay, rootPlayMovement, rootPlayNodes, solve, solveLite, trackSettle,
} from '../src/index.ts';
import type { SpotConfig } from '../src/index.ts';

const caller: SpotConfig = {
	board: 'As Kh 7d', pot: 55, stack: 975,
	oop: 'AA-TT,AKs,AQs,KQs,76s', ip: 'QQ-88,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.33, 0.75, 1.5]],
	raiseSizes: [[0.5, 1]],
	maxRaises: 3,
	allowAllIn: true,
};

// A flop for the tree's shape, and a turn small enough to solve in a test.
const flop: SpotConfig = {
	board: 'Ts 9h 4d', pot: 60, stack: 100,
	oop: 'AA,KK,QQ,AKs,AQs,KQs,76s,65s', ip: 'JJ,TT,99,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.33, 0.66], [0.5, 1], [0.5, 1]],
	maxRaises: 2,
};
const small: SpotConfig = { ...flop, board: 'Ts 9h 4d 2c', betSizes: [[0.33, 0.66], [0.5, 1]] };

describe('liteConfig', () => {
	it('keeps the flop and cuts the turn and river to the size nearest 0.75 and no raise', () => {
		const lite = liteConfig(caller, { flopMaxRaises: false, noDonk: false });
		expect(lite.noDonk).toBeUndefined();
		expect(lite.betSizes).toEqual([[0.33, 0.75, 1.5], [0.75], [0.75]]);
		expect(lite.raiseSizes).toEqual([[0.5, 1], [1], [1]]);
		expect(lite.maxRaises).toEqual([3, 1, 1]);
		expect(lite.allowAllIn).toEqual([true, false, false]);
		expect(lite.shareHistories).toBe(true);
		expect(lite.runoutBuckets).toBe(3);
		expect(lite.oop).toBe(caller.oop);
		expect(lite.pot).toBe(55);
	});

	it('keeps one raise with laterRaise, and applies the trims', () => {
		const lite = liteConfig({ ...caller, maxRaises: [3, 3, 1] }, { laterRaise: true, flopMaxRaises: 2, noDonk: true, laterSize: 0.4 });
		expect(lite.betSizes).toEqual([[0.33, 0.75, 1.5], [0.33], [0.33]]);
		expect(lite.raiseSizes).toEqual([[0.5, 1], [0.5], [0.5]]);
		expect(lite.maxRaises).toEqual([2, 2, 1]);
		expect(lite.noDonk).toBe(true);
	});

	it('caps the flop at two aggressions and forbids donk bets by default', () => {
		const lite = liteConfig({ ...caller, noDonk: [false, false, false] });
		expect(lite.maxRaises).toEqual([2, 1, 1]);
		expect(lite.noDonk).toBe(true);
		expect(liteConfig({ ...caller, maxRaises: 1 }).maxRaises).toEqual([1, 1, 1]);
		expect(liteConfig({ ...caller, noDonk: [false, true, false] }, { noDonk: false }).noDonk).toEqual([false, true, false]);
	});

	it('simplifies per-player betting side by side', () => {
		const lite = liteConfig({
			...caller,
			betSizes: { oop: [[0.5], [0.33, 1.2], [0.66]], ip: [[0.25, 0.75]] },
			raiseSizes: undefined,
			maxRaises: { oop: 2, ip: [2, 3, 3] },
		});
		expect(lite.betSizes).toEqual({ oop: [[0.5], [1.2], [0.66]], ip: [[0.25, 0.75], [0.75], [0.75]] });
		expect(lite.raiseSizes).toBeUndefined();
		expect(lite.maxRaises).toEqual({ oop: [2, 1, 1], ip: [2, 1, 1] });
		expect(liteConfig({ ...caller, maxRaises: { oop: 3, ip: 1 } }).maxRaises).toEqual({ oop: [2, 1, 1], ip: [1, 1, 1] });
	});

	it('builds a tree with one bet and no raise after the flop', () => {
		const spot = defineSpot(liteConfig(flop));
		const { tree } = spot;
		for (const node of tree.decisionNodes) {
			if (tree.round[node] === 0) continue;
			const labels = [];
			for (let e = 0; e < tree.numEdges[node]; e++) labels.push(tree.edgeAction[tree.firstEdge[node] + e]);
			// check/bet, or fold/call: never two bets, never a raise.
			expect(tree.numEdges[node]).toBeLessThanOrEqual(2);
		}
		expect(spot.historyAlias).toBeDefined();
	});

	it('refuses lineRunouts and bad settings', () => {
		expect(() => liteConfig({ ...flop, lineRunouts: { aggressions: 1 } })).toThrow(/lineRunouts/);
		expect(() => liteConfig(flop, { laterSize: 0 })).toThrow(/laterSize/);
		expect(() => liteConfig(flop, { flopMaxRaises: 0 })).toThrow(/flopMaxRaises/);
	});
});

describe('bettingFrom', () => {
	it('drops the rounds before the subgame', () => {
		expect(bettingFrom(caller, 1)).toEqual({
			betSizes: [[0.33, 0.75, 1.5], [0.33, 0.75, 1.5]], raiseSizes: [[0.5, 1], [0.5, 1]], maxRaises: 3, allowAllIn: true, allInThreshold: undefined, noDonk: false,
		});
		const perRoundBetting = bettingFrom(flop, 2);
		expect(perRoundBetting.betSizes).toEqual([[0.5, 1]]);
		expect(bettingFrom({ ...flop, maxRaises: [3, 2, 1] }, 1).maxRaises).toEqual([2, 1]);
	});
});

describe('root play and settle', () => {
	it('measures no movement between equal strategies and some early on', () => {
		const run = createRun(defineSpot(small), { workers: 1 });
		try {
			const nodes = rootPlayNodes(run.snapshot());
			expect(nodes[0]).toBe(0);
			expect(nodes).toHaveLength(2);
			run.step(5);
			const a = rootPlay(run.snapshot());
			expect(rootPlayMovement(a, rootPlay(run.snapshot()))).toBe(0);
			run.step(5);
			const b = rootPlay(run.snapshot());
			const early = rootPlayMovement(a, b);
			expect(early).toBeGreaterThan(0);
			expect(early).toBeLessThanOrEqual(1);
			run.step(300);
			const c = rootPlay(run.snapshot());
			run.step(5);
			expect(rootPlayMovement(c, rootPlay(run.snapshot()))).toBeLessThan(early);
		} finally {
			run.close();
		}
	});

	it('trackSettle waits for patience still checks', () => {
		const run = createRun(defineSpot(small), { workers: 1 });
		try {
			const tracker = trackSettle({ tolerance: 1, patience: 2 });
			run.step(1);
			expect(tracker.check(run.snapshot(), 1)).toBe(false);
			expect(tracker.movement).toBeNaN();
			run.step(1);
			expect(tracker.check(run.snapshot(), 2)).toBe(false);
			run.step(1);
			expect(tracker.check(run.snapshot(), 3)).toBe(true);
			expect(tracker.settled).toBe(true);
		} finally {
			run.close();
		}
	});

	it('stops a solve once the root play settles', () => {
		const spot = defineSpot(small);
		const progress: number[] = [];
		const sol = solve(spot, { iterations: 2000, workers: 1, settle: { every: 10 }, onProgress: (p) => progress.push(p.movement!) });
		expect(sol.stoppedAt).toBe('settled');
		expect(sol.iterations).toBeLessThan(2000);
		expect(sol.iterations % 10).toBe(0);
		expect(sol.history.at(-1)!.exploitability).toBeNaN();
		expect(progress.slice(-2).every((m) => m <= 0.01)).toBe(true);
		// The same iterations without the rule give the same strategy, bit for bit.
		const plain = solve(spot, { iterations: sol.iterations, workers: 1 });
		expect(plain.strategyAt(0, 0).probs).toEqual(sol.strategyAt(0, 0).probs);
	});

	it('stops on the target when that comes first', () => {
		const sol = solve(defineSpot(small), { iterations: 2000, workers: 1, targetPercent: 5, settle: { every: 10, tolerance: 0 } });
		expect(sol.stoppedAt).toBe('target');
		expect(sol.exploitabilityPercent()).toBeLessThanOrEqual(5);
	});

	it('refuses bad settings', () => {
		expect(() => solve(defineSpot(small), { settle: { every: 0 } })).toThrow(/every/);
		expect(() => solve(defineSpot(small), { settle: { patience: 1.5 } })).toThrow(/patience/);
	});
});

describe('solveLite', () => {
	it('solves the blueprint and re-solves a later street at the full betting', () => {
		const lite = solveLite(small, { workers: 1, settle: { every: 10 } });
		expect(lite.solution.stoppedAt).toBe('settled');
		expect(lite.blueprint).toEqual(liteConfig(small));
		const { tree } = lite.solution.spot;
		// The river after check, check.
		const chance = tree.edgeChild[tree.firstEdge[tree.edgeChild[tree.firstEdge[0]]]];
		expect(tree.kind[chance]).toBe(NodeKind.Chance);
		const turn = tree.edgeChild[tree.firstEdge[chance]];
		const resolved = lite.resolve(turn, 0, { player: 0, iterations: 50 });
		const sub = resolved.solution.spot;
		// The caller's two river sizes are back: check, bet 0.5, bet 1.
		expect(sub.tree.numEdges[0]).toBe(3);
		expect(sub.historyAlias).toBeUndefined();
		expect(sub.source.betSizes).toEqual([[0.5, 1]]);
		expect(resolved.solution.exploitabilityPercent()).toBeLessThan(5);
	});

	it('runs unsampled and to a cap when asked', () => {
		const lite = solveLite(small, { workers: 1, sampling: false, settle: false, iterations: 30 });
		expect(lite.solution.stoppedAt).toBe('iterations');
		expect(lite.solution.iterations).toBe(30);
	});
});
