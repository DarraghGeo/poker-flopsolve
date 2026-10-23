import { describe, expect, it } from 'vitest';
import { createRun, defineSpot } from '../src/index.ts';
import { averageStrategy } from '../src/cfr.ts';
import { COMBOS } from '../src/cards.ts';

/**
 * A hand whose strategy sum at a node is zero never reached it on its own, so
 * the average says nothing about it: it plays the current strategy, from its
 * regrets, rather than every action at an equal share.
 */

// 16-bit sums round small values to zero, so a short solve leaves some.
const turn = () =>
	defineSpot({
		board: '2c7d9hJs', pot: 100, stack: 200, oop: 'JJ,TT,54s,AA,KQo', ip: 'TT,99,A5s,QQ,K7s',
		betSizes: [[0.66]], maxRaises: 1,
	});

describe('average strategy where a hand never reached the node', () => {
	const run = createRun(turn(), { precision: 'i16' });
	run.step(100);
	const { solver, spot } = run;
	const { ctx } = solver;
	const strategy = new Float64Array(8 * COMBOS);

	it('plays the regret-matching strategy there, and the plain average elsewhere', () => {
		let zero = 0;
		let reached = 0;
		let notUniform = 0;
		for (const node of spot.tree.decisionNodes) {
			const owner = spot.tree.player[node] as 0 | 1;
			const index = spot.players[owner];
			const actions = spot.tree.numEdges[node];
			const round = spot.tree.round[node];
			for (let board = 0; board < spot.runouts.counts[round]; board++) {
				const base = ctx.layout.offset[node] + board * actions * index.count;
				const lists = ctx.active;
				const listSlot = (lists.roundBase[round] + board) * 2 + owner;
				const from = lists.start[listSlot];
				const count = lists.count[listSlot];
				const { probs } = solver.averageStrategyAt(node, board);
				averageStrategy(ctx.strategySum, base, actions, index.count, lists.list, lists.slot, from, count, strategy, ctx.regret);
				for (let k = 0; k < count; k++) {
					const i = lists.slot[from + k];
					const combo = lists.list[from + k];
					let sum = 0;
					let positive = 0;
					for (let a = 0; a < actions; a++) {
						sum += ctx.strategySum[base + a * index.count + i];
						positive += Math.max(0, ctx.regret[base + a * index.count + i]);
					}
					for (let a = 0; a < actions; a++) {
						const s = ctx.strategySum[base + a * index.count + i];
						const r = Math.max(0, ctx.regret[base + a * index.count + i]);
						const expected = sum > 0 ? s / sum : positive > 0 ? r / positive : 1 / actions;
						expect(probs[i * actions + a]).toBeCloseTo(expected, 12);
						expect(strategy[a * COMBOS + combo]).toBeCloseTo(expected, 12);
					}
					if (sum > 0) reached++;
					else if (positive > 0) {
						zero++;
						if (Array.from(probs.subarray(i * actions, (i + 1) * actions)).some((p) => Math.abs(p - 1 / actions) > 0.01)) notUniform++;
					}
				}
			}
		}
		expect(zero).toBeGreaterThan(0);
		expect(notUniform).toBeGreaterThan(0);
		expect(reached).toBeGreaterThan(zero);
	});

	it('stays uniform where there are no regrets, as in an analysisOnly run', () => {
		const copy = createRun(spot, { analysisOnly: true });
		copy.solver.ctx.strategySum.set(new Float32Array(ctx.strategySum.length));
		const node = spot.tree.decisionNodes[0];
		const { actions, probs } = copy.solver.averageStrategyAt(node, 0);
		for (const p of probs) expect(p).toBe(1 / actions);
	});
});
