/**
 * `shareHistories` alongside the settings issue #47's phone blueprint uses
 * (issue #85): runout buckets, chance sampling, coarse start, and turn
 * subgames cut and re-solved from a blueprint whose river is shared. Browser
 * threads are in `browser-threads.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRun, defineSpot, NodeKind } from '../src/index.ts';
import type { Solution, SolveRun, SpotConfig } from '../src/index.ts';
import { resolveSubgame } from '../src/resolve.ts';
import { copySubtree, matchSubtree } from '../src/subtree.ts';

// Rainbow, so a board is never a mirror image of another and boards compare one to one.
const flop: SpotConfig = {
	board: 'Ts 9h 4d', pot: 60, stack: 100,
	oop: 'AA,KK,QQ,AKs,AQs,KQs,76s,65s', ip: 'JJ,TT,99,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.66]], maxRaises: 1,
};

function solved(config: SpotConfig, iterations: number, options: Parameters<typeof createRun>[1] = {}) {
	const run = createRun(defineSpot(config), { workers: 1, ...options });
	try {
		run.step(iterations);
		return { engine: run.engine, exploitability: run.exploitabilityPercent(), ev: run.snapshot().ev(0) };
	} finally {
		run.close();
	}
}

describe('shareHistories with runout buckets', () => {
	it('saves storage on top of the buckets', () => {
		const buckets = defineSpot({ ...flop, runoutBuckets: 3 });
		const both = defineSpot({ ...flop, runoutBuckets: 3, shareHistories: true });
		const share = defineSpot({ ...flop, shareHistories: true });
		expect(both.estimate.runouts).toBe(buckets.estimate.runouts);
		expect(both.estimate.bytes).toBeLessThan(buckets.estimate.bytes);
		expect(both.estimate.bytes).toBeLessThan(share.estimate.bytes);
	});

	it('solves on the WebAssembly engine and measures in the real game', () => {
		const run = createRun(defineSpot({ ...flop, runoutBuckets: 3, shareHistories: true }), { workers: 1 });
		try {
			run.step(5);
			const early = run.exploitabilityPercent();
			run.step(195);
			expect(run.engine).toBe('wasm');
			const late = run.exploitabilityPercent();
			expect(late).toBeLessThan(early / 3);
			// The strategy copied onto every real runout, sharing kept.
			const real = run.trueExploitabilityPercent();
			expect(real).toBeGreaterThan(0);
			expect(real).toBeLessThan(2 * late + 1);
		} finally {
			run.close();
		}
	});
});

describe('shareHistories with chance sampling and coarse start', () => {
	it('runs both on shared storage, on the WebAssembly engine', () => {
		const shared = { ...flop, shareHistories: true };
		const cold = solved(shared, 5);
		for (const approximations of [
			{ chanceSampling: {} },
			{ coarseStart: { iterations: 20 } },
			{ chanceSampling: {}, coarseStart: { iterations: 20 } },
		]) {
			const warm = solved(shared, 300, { approximations });
			expect(warm.engine).toBe('wasm');
			expect(Number.isFinite(warm.ev)).toBe(true);
			// Sharing's own floor is near 1.5% of pot on this spot; sampling adds noise.
			expect(warm.exploitability).toBeLessThan(cold.exploitability / 3);
			expect(warm.exploitability).toBeLessThan(4);
		}
	});
});

describe('turn subgames of a blueprint whose river is shared', () => {
	const shared: SpotConfig = { ...flop, shareHistories: true };
	let run: SolveRun;
	let blueprint: Solution;
	/** The turn node after a flop line. */
	const turnAfter = (sol: Solution, line: string): number => {
		const t = sol.spot.tree;
		for (let node = 0; node < t.nodeCount; node++) {
			if (t.kind[node] !== NodeKind.Chance || t.round[node] !== 0) continue;
			const child = t.edgeChild[t.firstEdge[node]];
			if (sol.path(child) === line) return child;
		}
		throw new Error(`no turn after ${line}`);
	};
	beforeAll(() => {
		run = createRun(defineSpot(shared), { workers: 1 });
		run.step(150);
		blueprint = run.snapshot();
	});
	afterAll(() => run.close());

	it('gives each player the range the flop strategy brings', () => {
		const { tree } = blueprint.spot;
		const node = turnAfter(blueprint, 'bet 39.6 call /');
		const board = 3;
		const sub = blueprint.subgameAt(node, board);
		// OOP bet, IP called: each range is its weight times that one action's probability.
		const bet = blueprint.strategyAt(0, 0);
		const call = blueprint.strategyAt(tree.edgeChild[tree.firstEdge[0] + bet.actions.indexOf('bet 39.6')], 0);
		for (const [view, range, action] of [[bet, sub.oop, 'bet 39.6'], [call, sub.ip, 'call']] as const) {
			const weights = blueprint.spot.players[view.player].weights;
			const a = view.actions.indexOf(action);
			const reach = range as Float64Array;
			for (let i = 0; i < view.combos.length; i++) {
				const combo = view.combos[i];
				expect(reach[combo]).toBeCloseTo(weights[combo] * view.probs[i * view.actions.length + a], 12);
			}
		}
	});

	it('cuts a subgame that plays the shared river as the blueprint does', () => {
		const { tree, historyAlias } = blueprint.spot;
		// This line's river shares storage with "check bet call": the two meet at the same pot.
		const node = turnAfter(blueprint, 'bet 39.6 call /');
		const board = 3;
		const sub = createRun(defineSpot(blueprint.subgameAt(node, board)), { analysisOnly: true });
		try {
			const report = copySubtree(sub.solver.ctx, run.solver.ctx, true, node);
			expect(report.matchedNodes).toBe(report.decisionNodes);
			const copy = sub.snapshot();
			const subTree = copy.spot.tree;
			const match = matchSubtree(subTree, tree, node);
			let sharedRiver = 0;
			for (const at of subTree.decisionNodes) {
				const original = match[at];
				expect(original).toBeGreaterThanOrEqual(0);
				if (subTree.round[at] === 1 && historyAlias![original] !== original) sharedRiver++;
				// Every board of the subgame against the blueprint's board with the same cards.
				const round = subTree.round[at];
				const width = copy.spot.runouts.width[round];
				for (let b = 0; b < copy.spot.runouts.counts[round]; b += 7) {
					const cards = Array.from(copy.spot.runouts.cards[round].subarray(b * width, b * width + width));
					const there = blueprint.spot.resolveBoard(cards);
					const x = copy.strategyAt(at, b);
					const y = blueprint.strategyAt(original, there.board);
					const slot = new Map(Array.from(y.combos, (combo, i) => [combo, i]));
					for (let i = 0; i < x.combos.length; i++) {
						const j = slot.get(there.combos[x.combos[i]])!;
						for (let k = 0; k < x.actions.length; k++) {
							expect(x.probs[i * x.actions.length + k]).toBeCloseTo(y.probs[j * y.actions.length + k], 6);
						}
					}
				}
			}
			expect(sharedRiver).toBeGreaterThan(0);
		} finally {
			sub.close();
		}
	});

	it('re-solves a turn from it with a gadget', () => {
		const node = turnAfter(blueprint, 'bet 39.6 call /');
		const resolved = resolveSubgame(blueprint, node, 3, {
			player: 0, gadget: 'resolve', iterations: 60, betting: { betSizes: [[0.33, 0.75]] },
		});
		expect(resolved.solution.spot.historyAlias).toBeUndefined();
		const alternative = resolved.alternative!;
		const entered = resolved.entered!;
		let hands = 0;
		for (let combo = 0; combo < alternative.length; combo++) {
			if (Number.isNaN(entered[combo])) continue;
			expect(Number.isFinite(alternative[combo])).toBe(true);
			hands++;
		}
		expect(hands).toBeGreaterThan(0);
	});
});
