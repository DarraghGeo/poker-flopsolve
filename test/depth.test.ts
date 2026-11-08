/**
 * Depth-limited flop solving (src/depth.ts, issue #48): the cut tree, the
 * all-in showdown table, the leaf tables against the blueprint they came
 * from, and the solve itself.
 */

import { describe, expect, it } from 'vitest';
import { createRun, defineSpot, NodeKind, solve } from '../src/index.ts';
import type { SpotConfig } from '../src/index.ts';
import { COMBO_CARDS } from '../src/cards.ts';
import { createDepthLimitedRun, cutAtTurn, showdownTable, solveDepthLimited } from '../src/depth.ts';

const flop: SpotConfig = {
	board: 'Ts 9s 4h', pot: 60, stack: 120,
	oop: 'AA,KK,QQ,AKs,AQs,KQs,76s,65s', ip: 'JJ,TT,99,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.66]], maxRaises: 1,
};
const monotone: SpotConfig = { ...flop, board: 'Ks 9s 4s', oop: 'AA,KK,QQ,AK,AQ,KQ,76s', ip: 'JJ,TT,99,AJ,KJ,QJ,JT' };

describe('cutAtTurn', () => {
	it('keeps the flop betting and stops every line at the turn deal', () => {
		const spot = defineSpot({ ...flop, betSizes: [[0.33, 1]], raiseSizes: [[0.75]], allowAllIn: true, maxRaises: 3 });
		const { tree, leaves, allIns } = cutAtTurn(spot.tree);
		let flopDecisions = 0;
		for (let node = 0; node < spot.tree.nodeCount; node++) {
			if (spot.tree.kind[node] === NodeKind.Decision && spot.tree.round[node] === 0) flopDecisions++;
		}
		expect(tree.decisionNodes.length).toBe(flopDecisions);
		for (let node = 0; node < tree.nodeCount; node++) {
			expect(tree.round[node]).toBe(0);
			expect(tree.kind[node]).not.toBe(NodeKind.Chance);
		}
		expect(leaves.map((line) => line.path)).toContain('xx');
		expect(leaves.every((line) => tree.kind[line.node] === NodeKind.Continuation)).toBe(true);
		expect(allIns.length).toBeGreaterThan(0);
		expect(leaves.length + allIns.length).toBe(tree.kind.filter((kind) => kind === NodeKind.Continuation).length);
		// A full tree never holds a leaf.
		expect(spot.tree.kind.includes(NodeKind.Continuation)).toBe(false);
	});
});

describe('showdownTable', () => {
	for (const [name, config] of [['rainbow', flop], ['monotone', monotone]] as const) {
		it(`gives an all-in line's exact runout values (${name})`, () => {
			const spot = defineSpot({ ...config, betSizes: [[]], allowAllIn: true });
			const run = createRun(spot, { engine: 'js' });
			run.step(3);
			const { tree } = spot;
			const lists = run.solver.ctx.active;
			const { tables, payoff } = showdownTable(spot.source, lists);
			let checked = 0;
			for (let node = 0; node < tree.nodeCount; node++) {
				if (tree.kind[node] !== NodeKind.Chance || tree.round[node] !== 0) continue;
				if (tree.kind[tree.edgeChild[tree.firstEdge[node]]] === NodeKind.Decision) continue;
				let end = node;
				while (tree.kind[end] === NodeKind.Chance) end = tree.edgeChild[tree.firstEdge[end]];
				for (const p of [0, 1] as const) {
					const q = 1 - p;
					// Any reach the solve could hold: one value per list entry.
					const reach = new Float64Array(1326);
					for (let e = 0; e < lists.count[q]; e++) {
						for (let m = lists.memberStart[lists.start[q] + e]; m < lists.memberStart[lists.start[q] + e + 1]; m++) {
							reach[lists.memberCombo[m]] = 0.2 + (e % 5) / 7;
						}
					}
					const exact = run.solver.valuesAt(node, 0, p, spot.players[p].weights, reach, run.solver.rootLive, run.solver.rootCount);
					for (let i = 0; i < lists.count[p]; i++) {
						let sum = 0;
						for (let j = 0; j < lists.count[q]; j++) sum += tables[p][i * lists.count[q] + j] * reach[lists.list[lists.start[q] + j]];
						const want = exact[lists.list[lists.start[p] + i]];
						expect(Math.abs((sum * tree.payoff[end]) / payoff - want)).toBeLessThan(1e-6 * (1 + Math.abs(want)));
					}
					checked++;
				}
			}
			expect(checked).toBeGreaterThan(0);
			run.close();
		});
	}
});

describe('createDepthLimitedRun', () => {
	it("builds each leaf's table as the blueprint's own values there", () => {
		let leaves = 0;
		const run = createDepthLimitedRun(flop, {
			continuations: ['blueprint'],
			blueprint: { betSizes: [[0.66]] },
			blueprintTarget: 1,
			onLeafSpot({ table, source }, blueprint) {
				leaves++;
				const lists = blueprint.solver.ctx.active;
				const weight = blueprint.solver.ctx.runoutWeight[0];
				for (const p of [0, 1] as const) {
					const q = (1 - p) as 0 | 1;
					const me = blueprint.reachAt(source, 0, p);
					const opp = blueprint.reachAt(source, 0, q);
					const raw = blueprint.solver.valuesAt(source, 0, p, me, opp, blueprint.solver.rootLive, blueprint.solver.rootCount);
					const at = p === 0 ? 0 : lists.count[0];
					for (let e = 0; e < lists.count[p]; e++) {
						const combo = lists.list[lists.start[p] + e];
						const [a, b] = [COMBO_CARDS[combo * 2], COMBO_CARDS[combo * 2 + 1]];
						let mass = 0;
						for (let c = 0; c < 1326; c++) {
							const [x, y] = [COMBO_CARDS[c * 2], COMBO_CARDS[c * 2 + 1]];
							if (x !== a && x !== b && y !== a && y !== b) mass += opp[c];
						}
						if (mass < 1e-3) continue;
						expect(table[at + e]).toBeCloseTo(raw[combo] / (mass * weight), 3);
					}
				}
			},
		});
		expect(leaves).toBe(run.report.leaves);
		expect(run.report.lines.map((line) => line.leaf).sort()).toEqual(['bc', 'xbc', 'xx']);
		expect(run.report.lines.every((line) => line.leaf === line.source)).toBe(true);
		run.close();
	});

	it('is zero-sum and close to the exact solve when the blueprint is the game', () => {
		const exact = solve(defineSpot(flop), { targetPercent: 0.2, iterations: 500 });
		const limited = solveDepthLimited(flop, {
			continuations: ['blueprint'], blueprint: { betSizes: [[0.66]] }, blueprintTarget: 0.2, iterations: 300,
		});
		expect(limited.ev(0) + limited.ev(1)).toBeCloseTo(0, 6);
		expect(Math.abs(limited.ev(0) - exact.ev(0))).toBeLessThan(0.01 * flop.pot);
		expect(limited.exploitabilityPercent()).toBeLessThan(0.5);
	});

	it('trains a continuation choice per hand with biased continuations', () => {
		const limited = solveDepthLimited(
			{ ...flop, betSizes: [[0.33, 1]], allowAllIn: true },
			{ continuations: ['blueprint', 'fold', 'call', 'raise'], blueprintTarget: 1, iterations: 200 },
		);
		expect(limited.report.continuations).toBe(4);
		expect(limited.ev(0) + limited.ev(1)).toBeCloseTo(0, 6);
		expect(limited.exploitabilityPercent()).toBeLessThan(1);
	});

	it('refuses a spot that does not start on the flop', () => {
		expect(() => createDepthLimitedRun({ ...flop, board: 'Ts 9s 4h 2c' })).toThrow(/flop/);
		expect(() => createDepthLimitedRun({ ...flop, runoutBuckets: true })).toThrow(/runoutBuckets/);
	});
});
