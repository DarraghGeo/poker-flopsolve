/**
 * Lite mode (issue #100): the blueprint `liteConfig` derives from a caller's
 * betting, the `settle` stopping rule, and `solveLite` with its re-solver.
 */

import { describe, expect, it } from 'vitest';
import {
	ActionKind, bettingFrom, checkedDown, createRun, defineSpot, keepWithin, liteConfig, litePreset, NodeKind, rootPlay, rootPlayMovement, rootPlayNodes, solve, solveLite,
	storageCost, trackSettle, turnLineReach,
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
		const lite = liteConfig(caller);
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

	it('keeps the caller\'s flop aggressions and donk bets unless asked', () => {
		expect(liteConfig({ ...caller, noDonk: [false, true, false] }).noDonk).toEqual([false, true, false]);
		expect(liteConfig({ ...caller, noDonk: true }, { noDonk: false }).noDonk).toBe(false);
		expect(liteConfig({ ...caller, maxRaises: 1 }, { flopMaxRaises: 2 }).maxRaises).toEqual([1, 1, 1]);
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
		expect(liteConfig({ ...caller, maxRaises: { oop: 3, ip: 1 } }, { flopMaxRaises: 2 }).maxRaises).toEqual({ oop: [2, 1, 1], ip: [1, 1, 1] });
	});

	it('builds a tree with one bet and no raise after the flop', () => {
		const spot = defineSpot(liteConfig(flop));
		const { tree } = spot;
		for (const node of tree.decisionNodes) {
			if (tree.round[node] === 0) continue;
			const kinds = [];
			for (let e = 0; e < tree.numEdges[node]; e++) kinds.push(tree.edgeAction[tree.firstEdge[node] + e]);
			// check/bet, or fold/call: never two bets, never a raise. A bet
			// bigger than the stack is a shove.
			expect(tree.numEdges[node]).toBeLessThanOrEqual(2);
			expect(kinds).not.toContain(ActionKind.Raise);
		}
		expect(spot.historyAlias).toBeDefined();
	});

	it('keeps the caller\'s own shareHistories unless the options give one', () => {
		expect(liteConfig({ ...flop, shareHistories: { keepLines: [] } }).shareHistories).toEqual({ keepLines: [] });
		expect(liteConfig({ ...flop, shareHistories: { keepLines: [] } }, { shareHistories: true }).shareHistories).toBe(true);
	});

	it('drops cut lines the flop cap leaves out of the tree', () => {
		const run = createRun(defineSpot(liteConfig(flop)), { workers: 1 });
		const sol = run.snapshot();
		run.close();
		const { tree } = sol.spot;
		// A flop raise, the second aggression, which a cap of one removes.
		const raised = tree.decisionNodes.find((node) => {
			if (tree.round[node] !== 0 || node === 0) return false;
			const parentEdge = Array.from({ length: tree.edgeChild.length }, (_, e) => e).find((e) => tree.edgeChild[e] === node)!;
			return tree.edgeAction[parentEdge] === ActionKind.Raise;
		})!;
		const cut = sol.path(raised);
		const capped = liteConfig({ ...flop, removeActions: [cut, 'bet 19.8'] }, { flopMaxRaises: 1 });
		expect(capped.removeActions).toEqual(['bet 19.8']);
		expect(() => defineSpot(capped)).not.toThrow();
	});

	it('refuses bad settings', () => {
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

	it('counts no still check before minIterations', () => {
		const run = createRun(defineSpot(small), { workers: 1 });
		try {
			const tracker = trackSettle({ tolerance: 1, patience: 2, minIterations: 3 });
			for (let i = 1; i <= 3; i++) {
				run.step(1);
				expect(tracker.check(run.snapshot(), i)).toBe(false);
			}
			run.step(1);
			expect(tracker.check(run.snapshot(), 4)).toBe(true);
		} finally {
			run.close();
		}
	});

	it('does not call a short last step settled', () => {
		// Every check is still, but the cap's last step is 5 iterations, not 10.
		const sol = solve(defineSpot(small), { iterations: 25, workers: 1, settle: { every: 10, tolerance: 1, patience: 2 } });
		expect(sol.stoppedAt).toBe('iterations');
		expect(sol.iterations).toBe(25);
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

	it('re-solves with the caller\'s cuts below the node, rebased', () => {
		const lite = solveLite({ ...small, removeActions: ['check check / bet 30', 'bet 19.8 call / bet 69.6'] }, {
			workers: 1, settle: false, iterations: 20,
		});
		expect(lite.blueprint.removeActions).toEqual([]);
		const sol = lite.solution;
		const { tree } = sol.spot;
		const river = (line: string): number => tree.decisionNodes.find((n) => sol.path(n) === line)!;
		const checked = lite.resolve(river('check check /'), 0, { player: 0, iterations: 1 });
		expect(checked.solution.spot.source.removeActions).toEqual(['bet 30']);
		// Check and the pot-sized bet; the half-pot bet is cut.
		expect(checked.solution.spot.tree.numEdges[0]).toBe(2);
		const called = lite.resolve(river('bet 19.8 call /'), 0, { player: 0, iterations: 1 });
		expect(called.solution.spot.source.removeActions).toEqual(['bet 49.8']);
	});

	it('runs unsampled and to a cap when asked', () => {
		const lite = solveLite(small, { workers: 1, sampling: false, settle: false, iterations: 30 });
		expect(lite.solution.stoppedAt).toBe('iterations');
		expect(lite.solution.iterations).toBe(30);
	});
});

describe('solveLite keepBudget', () => {
	const shared = defineSpot(liteConfig(small));
	const sharedBytes = storageCost(shared, 'f32');
	const unsharedBytes = storageCost(defineSpot(liteConfig(small, { shareHistories: false })), 'f32');
	const options = { workers: 1, settle: false, iterations: 20, pickIterations: 10 } as const;

	it('keeps nothing and says so without a budget', () => {
		const lite = solveLite(small, options);
		expect(lite.kept).toEqual([]);
		expect(lite.blueprint).toEqual(liteConfig(small));
	});

	it('keeps every line when the budget holds the unshared tree, and only free ones when it holds the shared one', () => {
		const all = solveLite(small, { ...options, keepBudget: unsharedBytes });
		const lines = turnLineReach(all.solution).map((l) => l.line);
		expect(lines.length).toBeGreaterThan(1);
		expect([...all.kept].sort()).toEqual([...lines].sort());
		expect(all.blueprint.shareHistories).toEqual({ keepLines: all.kept });
		expect(all.solution.spot.source.shareHistories).toEqual({ keepLines: all.kept });
		expect(all.solution.iterations).toBe(20);
		expect(storageCost(all.solution.spot, 'f32')).toBeLessThanOrEqual(unsharedBytes);

		// Only lines that cost nothing: a line owning its shared block keeps it free.
		const none = solveLite(small, { ...options, keepBudget: sharedBytes });
		expect(none.kept.length).toBeLessThan(lines.length);
		expect(storageCost(none.solution.spot, 'f32')).toBe(sharedBytes);
	});

	it('keeps the most-reached lines a budget between the two allows', () => {
		const lite = solveLite(small, { ...options, keepBudget: (sharedBytes + unsharedBytes) / 2 });
		const free = solveLite(small, { ...options, keepBudget: sharedBytes }).kept;
		expect(lite.kept.length).toBeGreaterThan(free.length);
		expect(storageCost(lite.solution.spot, 'f32')).toBeGreaterThan(sharedBytes);
		expect(storageCost(lite.solution.spot, 'f32')).toBeLessThanOrEqual((sharedBytes + unsharedBytes) / 2);
		// The hybrid still re-solves.
		const { tree } = lite.solution.spot;
		const turn = tree.edgeChild[tree.firstEdge[tree.edgeChild[tree.firstEdge[tree.edgeChild[tree.firstEdge[0]]]]]];
		expect(lite.resolve(turn, 0, { player: 0, iterations: 5 }).solution.iterations).toBe(5);
	});

	it('keeps the caller\'s own kept lines too', () => {
		const share = liteConfig(small).shareHistories;
		expect(share).toBe(true);
		const own = solveLite(small, { ...options, keepBudget: unsharedBytes, shareHistories: { keepLines: ['check check /'] } });
		expect(own.kept).toContain('check check /');
	});

	it('budgets at the solve\'s precision', () => {
		const i16Shared = storageCost(shared, 'i16');
		expect(i16Shared).toBeLessThan(sharedBytes);
		// Over the shared tree at 16 bits, under it at 32.
		expect(solveLite(small, { ...options, precision: 'i16', keepBudget: sharedBytes }).kept.length).toBeGreaterThan(0);
	});

	it('solves what keepWithin gives, and keepWithin without a budget changes nothing', () => {
		const blueprint = liteConfig(small);
		expect(keepWithin(blueprint, options)).toBe(blueprint);
		const budget = { ...options, keepBudget: (sharedBytes + unsharedBytes) / 2 };
		expect(solveLite(small, budget).blueprint).toEqual(keepWithin(blueprint, budget));
		expect(keepWithin(blueprint, { ...budget, sampling: false })).toEqual(keepWithin(blueprint, budget));
	});

	it('litePreset picks the same lines and reports them', () => {
		const budget = { ...options, keepBudget: (sharedBytes + unsharedBytes) / 2 };
		const preset = litePreset(small, budget);
		const lite = solveLite(small, budget);
		expect(preset.config).toEqual(lite.blueprint);
		expect(lite.changes.notes.some((n) => n.includes(`but for ${lite.kept.length} line`))).toBe(true);
	});

	it('settles later when a budget keeps lines, unless the caller sets the tolerance (#123)', () => {
		const budget = { workers: 1, pickIterations: 1, keepBudget: unsharedBytes } as const;
		expect(litePreset(small, { workers: 1 }).options.settle).toEqual({});
		const preset = litePreset(small, budget);
		expect(preset.options.settle).toEqual({ tolerance: 0.005 });
		expect(preset.changes.notes.some((n) => n.startsWith('settle:') && n.includes('0.5%') && n.includes('later'))).toBe(true);
		expect(litePreset(small, { ...budget, settle: { every: 10 } }).options.settle).toEqual({ every: 10, tolerance: 0.005 });
		expect(litePreset(small, { ...budget, settle: { tolerance: 0.02 } }).options.settle).toEqual({ tolerance: 0.02 });
		expect(litePreset(small, { ...budget, settle: false }).options.settle).toBeUndefined();
		expect(() => litePreset(small, { ...budget, settle: { tolerance: -1 } })).toThrow(/tolerance/);
	});

	it('keeps the default stop when a budget keeps no line (#123)', () => {
		// A river spot has no line into a later round to keep.
		const river: SpotConfig = { ...flop, board: 'Ts 9h 4d 2c 3s', betSizes: [[0.5, 1]] };
		const preset = litePreset(river, { workers: 1, pickIterations: 1, keepBudget: 2 ** 30 });
		expect(preset.config.shareHistories).toEqual({ keepLines: [] });
		expect(preset.options.settle).toEqual({});
	});

	it('refuses a budget the shared tree does not fit, a spot that shares nothing, and bad settings', () => {
		expect(() => solveLite(small, { ...options, keepBudget: sharedBytes / 2 })).toThrow(/over the budget/);
		expect(() => solveLite(small, { ...options, keepBudget: unsharedBytes, shareHistories: false })).toThrow(/shareHistories/);
		expect(() => solveLite(small, { ...options, keepBudget: 0 })).toThrow(/keepBudget/);
		expect(() => solveLite(small, { ...options, keepBudget: unsharedBytes, pickIterations: 0 })).toThrow(/pickIterations/);
	});
});

describe('checkedDown', () => {
	it('takes the bets out of the last round and keeps the rest', () => {
		const lite = liteConfig(caller);
		const cheap = checkedDown(lite);
		expect(cheap.betSizes).toEqual([[0.33, 0.75, 1.5], [0.75], []]);
		expect(cheap.allowAllIn).toEqual([true, false, false]);
		expect(cheap.raiseSizes).toEqual(lite.raiseSizes);
		expect(cheap.shareHistories).toBe(true);
	});

	it('drops the caller\'s kept lines, which may lie below the last round', () => {
		const cheap = checkedDown({ ...liteConfig(caller), shareHistories: { keepLines: ['check check / check check /'] } });
		expect(cheap.shareHistories).toEqual({});
	});

	it('handles per-player betting and a one-round spot', () => {
		const perPlayer = checkedDown({ ...small, betSizes: { oop: [[0.33], [0.5]], ip: [[0.66], [1]] }, allowAllIn: true });
		expect(perPlayer.betSizes).toEqual({ oop: [[0.33], []], ip: [[0.66], []] });
		expect(perPlayer.allowAllIn).toEqual([true, false]);
		const river = checkedDown({ ...small, board: 'Ts 9h 4d 2c 3s', betSizes: [[0.5]] });
		expect(river.betSizes).toEqual([[]]);
	});
});
