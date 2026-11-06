/**
 * Betting-tree switches: all-in threshold, no donk bets, merged sizes.
 */

import { describe, expect, it } from 'vitest';
import { defineSpot, solve } from '../src/index.ts';
import type { SpotConfig } from '../src/index.ts';
import { ActionKind, mergeBetSizes, NodeKind } from '../src/tree.ts';
import type { Tree } from '../src/tree.ts';

const base: SpotConfig = {
	board: 'As Kh 7d', pot: 60, stack: 100,
	oop: 'AA,KK,77,AKs,AQs,KQs,65s', ip: 'QQ,JJ,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.33, 0.75]], maxRaises: 1,
};

/** The node reached by following actions from the root, chance nodes passed through. */
function follow(tree: Tree, actions: readonly number[]): number {
	let node = 0;
	for (const action of actions) {
		while (tree.kind[node] === NodeKind.Chance) node = tree.edgeChild[tree.firstEdge[node]];
		let next = -1;
		for (let e = 0; e < tree.numEdges[node]; e++) {
			if (tree.edgeAction[tree.firstEdge[node] + e] === action) {
				next = tree.edgeChild[tree.firstEdge[node] + e];
				break;
			}
		}
		if (next < 0) throw new Error(`no ${action} at node ${node}`);
		node = next;
	}
	while (tree.kind[node] === NodeKind.Chance) node = tree.edgeChild[tree.firstEdge[node]];
	return node;
}

const actionsAt = (tree: Tree, node: number): number[] =>
	Array.from({ length: tree.numEdges[node] }, (_, e) => tree.edgeAction[tree.firstEdge[node] + e]);

describe('mergeSizes', () => {
	it('averages sizes closer than the distance and keeps the rest', () => {
		expect(mergeBetSizes([0.33, 0.4, 0.75, 'allin'], 0.1)).toEqual([0.365, 0.75, 'allin']);
		expect(mergeBetSizes([0.25, 0.33, 0.4], 0.2)).toEqual([0.327]);
		expect(mergeBetSizes([0.5, 1], 0)).toEqual([0.5, 1]);
	});

	it('shrinks the tree', () => {
		const full = defineSpot({ ...base, betSizes: [[0.33, 0.4, 0.75]] });
		const merged = defineSpot({ ...base, betSizes: [[0.33, 0.4, 0.75]], mergeSizes: 0.1 });
		expect(merged.tree.decisionNodes.length).toBeLessThan(full.tree.decisionNodes.length);
		expect(actionsAt(merged.tree, 0).filter((a) => a === ActionKind.Bet)).toHaveLength(2);
	});
});

describe('allInThreshold', () => {
	it('turns a bet committing most of the stack into a shove', () => {
		// 0.75 pot is 45 of the 50 behind: over two thirds of it.
		const spot = defineSpot({ ...base, stack: 50, allInThreshold: 0.67 });
		const root = actionsAt(spot.tree, 0);
		expect(root).toEqual([ActionKind.Check, ActionKind.Bet, ActionKind.AllIn]);
		const without = defineSpot({ ...base, stack: 50 });
		expect(actionsAt(without.tree, 0)).toEqual([ActionKind.Check, ActionKind.Bet, ActionKind.Bet]);
		expect(spot.tree.decisionNodes.length).toBeLessThan(without.tree.decisionNodes.length);
	});

	it('applies per round', () => {
		const spot = defineSpot({ ...base, stack: 50, allInThreshold: [0, 0.67, 0.67] });
		expect(actionsAt(spot.tree, 0)).toEqual([ActionKind.Check, ActionKind.Bet, ActionKind.Bet]);
	});
});

describe('noDonk', () => {
	const spot = defineSpot({ ...base, noDonk: true });
	const { tree } = spot;

	it('leaves out of position only a check into the previous aggressor', () => {
		// Flop: OOP checks, IP bets, OOP calls; the turn opens with OOP.
		const turn = follow(tree, [ActionKind.Check, ActionKind.Bet, ActionKind.Call]);
		expect(tree.round[turn]).toBe(1);
		expect(tree.player[turn]).toBe(0);
		expect(actionsAt(tree, turn)).toEqual([ActionKind.Check]);
	});

	it('still lets out of position lead after checking through or betting itself', () => {
		const checked = follow(tree, [ActionKind.Check, ActionKind.Check]);
		expect(actionsAt(tree, checked)).toContain(ActionKind.Bet);
		const led = follow(tree, [ActionKind.Bet, ActionKind.Call]);
		expect(actionsAt(tree, led)).toContain(ActionKind.Bet);
	});

	it('solves', () => {
		const solution = solve(defineSpot({ ...base, noDonk: true, board: 'As Kh 7d 2c' }), { iterations: 30 });
		expect(Number.isFinite(solution.exploitabilityPercent())).toBe(true);
		expect(solution.spot.tree.decisionNodes.length).toBeLessThan(
			defineSpot({ ...base, board: 'As Kh 7d 2c' }).tree.decisionNodes.length,
		);
	});
});
