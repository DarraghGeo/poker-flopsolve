/**
 * `ShareHistories.keepLines`: chosen lines keep their own turn and river
 * storage while the rest share (issue #101).
 */

import { describe, expect, it } from 'vitest';
import { createRun, defineSpot, linesWithin, NodeKind, turnLineReach } from '../src/index.ts';
import type { Spot, SpotConfig } from '../src/index.ts';

const flop: SpotConfig = {
	board: 'Ts 9h 4d', pot: 60, stack: 100,
	oop: 'AA,KK,QQ,AKs,AQs,KQs,76s,65s', ip: 'JJ,TT,99,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.33, 0.66]], maxRaises: 1,
};

/** Every flop line that reaches the turn, as `Solution.path` names its first turn decision. */
function turnLines(spot: Spot): string[] {
	const run = createRun(spot, { workers: 1, analysisOnly: true });
	try {
		const sol = run.snapshot();
		const { tree } = spot;
		const lines: string[] = [];
		for (let node = 0; node < tree.nodeCount; node++) {
			if (tree.kind[node] !== NodeKind.Chance || tree.round[node] !== 0) continue;
			lines.push(sol.path(tree.edgeChild[tree.firstEdge[node]]));
		}
		return lines;
	} finally {
		run.close();
	}
}

/** Nodes at or below `line`'s first turn decision. */
function below(spot: Spot, line: string): number[] {
	const run = createRun(spot, { workers: 1, analysisOnly: true });
	try {
		const sol = run.snapshot();
		const { tree } = spot;
		const found = [...tree.decisionNodes].find((n) => sol.path(n) === line);
		if (found === undefined) throw new Error(`no ${line}`);
		const out: number[] = [];
		const stack = [found];
		while (stack.length) {
			const n = stack.pop()!;
			out.push(n);
			for (let e = 0; e < tree.numEdges[n]; e++) stack.push(tree.edgeChild[tree.firstEdge[n] + e]);
		}
		return out;
	} finally {
		run.close();
	}
}

describe('shareHistories.keepLines', () => {
	const shared = defineSpot({ ...flop, shareHistories: true });
	const lines = turnLines(shared);
	// A line whose river shares with another's.
	const sharing = lines.find((line) => below(shared, line).some((n) => shared.historyAlias![n] !== n))!;

	it('leaves the storage of everything below a kept line its own', () => {
		expect(sharing).toBeDefined();
		const kept = defineSpot({ ...flop, shareHistories: { keepLines: [sharing] } });
		for (const n of below(kept, sharing)) expect(kept.historyAlias![n]).toBe(n);
		// Nothing below a kept line is an owner the rest follow either.
		const mine = new Set(below(kept, sharing));
		for (let n = 0; n < kept.tree.nodeCount; n++) if (!mine.has(n)) expect(mine.has(kept.historyAlias![n]) && kept.historyAlias![n] !== n).toBe(false);
		expect(kept.estimate.bytes).toBeGreaterThan(shared.estimate.bytes);
		expect(kept.estimate.bytes).toBeLessThan(defineSpot(flop).estimate.bytes);
	});

	it('is the same as plain sharing when empty', () => {
		const empty = defineSpot({ ...flop, shareHistories: { keepLines: [] } });
		expect(Array.from(empty.historyAlias!)).toEqual(Array.from(shared.historyAlias!));
	});

	it('keeping every line solves as the unshared spot does', () => {
		const all = defineSpot({ ...flop, shareHistories: { keepLines: lines } });
		expect(all.estimate.bytes).toBe(defineSpot(flop).estimate.bytes);
		const solve = (spot: Spot): number => {
			const run = createRun(spot, { workers: 1 });
			try {
				run.step(20);
				return run.exploitabilityPercent();
			} finally {
				run.close();
			}
		};
		expect(solve(all)).toBe(solve(defineSpot(flop)));
	});

	it('refuses a line the tree does not have', () => {
		expect(() => defineSpot({ ...flop, shareHistories: { keepLines: ['bet 999 call /'] } })).toThrow(/keepLines/);
	});
});

describe('turnLineReach and linesWithin', () => {
	const config: SpotConfig = { ...flop, shareHistories: true };

	it('ranks the flop lines by reach, summing to the pairs that see a turn', () => {
		const run = createRun(defineSpot(config), { workers: 1 });
		try {
			run.step(30);
			const ranked = turnLineReach(run.snapshot());
			expect(ranked.map((l) => l.line).sort()).toEqual(turnLines(run.spot).sort());
			for (let i = 1; i < ranked.length; i++) expect(ranked[i].share).toBeLessThanOrEqual(ranked[i - 1].share);
			const total = ranked.reduce((s, l) => s + l.share, 0);
			expect(total).toBeGreaterThan(0.2);
			expect(total).toBeLessThanOrEqual(1 + 1e-9);
		} finally {
			run.close();
		}
	});

	it('a warm start between spots differing only in keepLines carries the average', () => {
		const run = createRun(defineSpot(config), { workers: 1 });
		try {
			run.step(40);
			const { line, node } = turnLineReach(run.snapshot())[0];
			const before = run.snapshot().reachAt(node, 0, 0);
			const kept = createRun(defineSpot({ ...flop, shareHistories: { keepLines: [line] } }), { workers: 1, warmStart: run });
			try {
				expect(kept.warmStart?.averages).toBe(true);
				// The same strategy, so the same ranges at the line and the same exploitability.
				const after = kept.snapshot().reachAt(node, 0, 0);
				for (let h = 0; h < before.length; h++) expect(after[h]).toBeCloseTo(before[h], 6);
				expect(kept.exploitabilityPercent()).toBeCloseTo(run.exploitabilityPercent(), 4);
			} finally {
				kept.close();
			}
		} finally {
			run.close();
		}
	});

	it('keeps the most-reached lines that fit a byte budget', () => {
		const run = createRun(defineSpot(config), { workers: 1 });
		try {
			run.step(30);
			const sol = run.snapshot();
			const ranked = turnLineReach(sol).map((l) => l.line);
			const bytes = (lines: readonly string[]): number =>
				defineSpot({ ...flop, shareHistories: lines.length ? { keepLines: lines } : true }).estimate.bytes;
			const budget = (bytes(ranked.slice(0, 2)) + bytes(ranked.slice(0, 3))) / 2;
			expect(bytes(ranked.slice(0, 3))).toBeGreaterThan(bytes(ranked.slice(0, 2)));
			expect(linesWithin(sol, budget)).toEqual(ranked.slice(0, 2));
			expect(linesWithin(sol, bytes(ranked.slice(0, 2)))).toEqual(ranked.slice(0, 2));
			expect(linesWithin(sol, defineSpot(flop).estimate.bytes)).toEqual(ranked);
		} finally {
			run.close();
		}
	});

	it('ranks lines from a cheaper spot with the same flop for the real one', () => {
		const proxy: SpotConfig = { ...config, betSizes: [[0.33, 0.66], [0.33, 0.66], []] };
		expect(defineSpot(proxy).estimate.bytes).toBeLessThan(defineSpot(config).estimate.bytes);
		const run = createRun(defineSpot(proxy), { workers: 1 });
		try {
			run.step(30);
			const sol = run.snapshot();
			const all = linesWithin(sol, defineSpot(flop).estimate.bytes, { config });
			expect(all).toEqual(turnLineReach(sol).map((l) => l.line));
			// Every line the proxy names is a line of the real spot.
			const kept = defineSpot({ ...config, shareHistories: { keepLines: all } });
			expect(kept.estimate.bytes).toBe(defineSpot(flop).estimate.bytes);
			expect(linesWithin(sol, defineSpot(config).estimate.bytes, { config })).toEqual([]);
		} finally {
			run.close();
		}
	});

	it('carries the average only into a spot keeping at least the same lines', () => {
		const lines = turnLines(defineSpot(config));
		const run = createRun(defineSpot({ ...flop, shareHistories: { keepLines: lines.slice(0, 1) } }), { workers: 1 });
		try {
			run.step(10);
			const into = (share: SpotConfig['shareHistories']): boolean | undefined => {
				const warm = createRun(defineSpot({ ...flop, shareHistories: share }), { workers: 1, warmStart: run });
				try {
					return warm.warmStart?.averages;
				} finally {
					warm.close();
				}
			};
			// Fewer kept lines: several histories would land in one block.
			expect(into(true)).toBe(false);
			expect(into({ keepLines: lines.slice(1, 2) })).toBe(false);
			expect(into({ keepLines: lines.slice(0, 2) })).toBe(true);
		} finally {
			run.close();
		}
		const plain = createRun(defineSpot({ ...flop, shareHistories: {} }), { workers: 1 });
		try {
			plain.step(5);
			const warm = createRun(defineSpot({ ...flop, shareHistories: { keepLines: lines.slice(0, 1) } }), { workers: 1, warmStart: plain });
			expect(warm.warmStart?.averages).toBe(true);
			warm.close();
		} finally {
			plain.close();
		}
	});

	it('returns every line the budget was checked with, and refuses a budget sharing alone misses', () => {
		const run = createRun(defineSpot(config), { workers: 1 });
		try {
			run.step(30);
			const sol = run.snapshot();
			const ranked = turnLineReach(sol).map((l) => l.line);
			const last = ranked[ranked.length - 1];
			const keeping: SpotConfig = { ...flop, shareHistories: { keepLines: [last] } };
			const picked = linesWithin(sol, defineSpot(keeping).estimate.bytes, { config: keeping });
			expect(picked).toEqual([last]);
			expect(() => linesWithin(sol, 1)).toThrow(/budget/);
			// Compact storage is what the budget counts when the spot has it.
			const compact: SpotConfig = { ...config, compactStorage: {} };
			const all = linesWithin(sol, defineSpot({ ...flop, compactStorage: {} }).estimate.compactBytes!, { config: compact });
			expect(all).toEqual(ranked);
		} finally {
			run.close();
		}
	});
});
