/**
 * `raiseOver`: raises (other than a shove) solved only facing some opening
 * bet sizes, the tree side of action translation (issue #54).
 */

import { describe, expect, it } from 'vitest';
import { defineSpot, solve } from '../src/index.ts';
import type { SpotConfig } from '../src/index.ts';
import { ActionKind, NodeKind } from '../src/tree.ts';
import type { Tree } from '../src/tree.ts';

const base: SpotConfig = {
	board: 'As Kh 7d', pot: 60, stack: 1000,
	oop: 'AA,KK,77,AKs,AQs,KQs,65s', ip: 'QQ,JJ,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.33, 0.75, 1.5]], raiseSizes: [[0.75]], allowAllIn: true, maxRaises: 3,
};

const edges = (tree: Tree, node: number): number[] =>
	Array.from({ length: tree.numEdges[node] }, (_, e) => tree.firstEdge[node] + e);
const actionsAt = (tree: Tree, node: number): number[] => edges(tree, node).map((e) => tree.edgeAction[e]);
const skipChance = (tree: Tree, node: number): number => {
	while (tree.kind[node] === NodeKind.Chance) node = tree.edgeChild[tree.firstEdge[node]];
	return node;
};

/** The node after out of position checks and in position bets its `k`-th size on the flop. */
function facingBet(tree: Tree, k: number): number {
	const check = tree.edgeChild[edges(tree, 0).find((e) => tree.edgeAction[e] === ActionKind.Check)!];
	const bets = edges(tree, check).filter((e) => tree.edgeAction[e] === ActionKind.Bet);
	return tree.edgeChild[bets[k]];
}

describe('raiseOver', () => {
	it('builds the same tree when unset', () => {
		const a = defineSpot(base).tree;
		const b = defineSpot({ ...base, raiseOver: undefined }).tree;
		expect(b.nodeCount).toBe(a.nodeCount);
		expect(Array.from(b.edgeTarget)).toEqual(Array.from(a.edgeTarget));
	});

	it('offers a sized raise only over the listed bets, and the shove over every bet', () => {
		const tree = defineSpot({ ...base, raiseOver: [0.75] }).tree;
		const full = ActionKind;
		expect(actionsAt(tree, facingBet(tree, 0))).toEqual([full.Fold, full.Call, full.AllIn]);
		expect(actionsAt(tree, facingBet(tree, 1))).toEqual([full.Fold, full.Call, full.Raise, full.AllIn]);
		expect(actionsAt(tree, facingBet(tree, 2))).toEqual([full.Fold, full.Call, full.AllIn]);
	});

	it('keeps re-raises in the anchor line', () => {
		const tree = defineSpot({ ...base, raiseOver: [0.75] }).tree;
		const facing = facingBet(tree, 1);
		const raise = edges(tree, facing).find((e) => tree.edgeAction[e] === ActionKind.Raise)!;
		expect(actionsAt(tree, tree.edgeChild[raise])).toContain(ActionKind.Raise);
	});

	it('applies on every street and shrinks the tree', () => {
		const full = defineSpot(base);
		const cut = defineSpot({ ...base, raiseOver: [0.75] });
		expect(cut.estimate.bytes).toBeLessThan(full.estimate.bytes);
		// A turn node reached by check-check on the flop, facing a 0.33 bet.
		const tree = cut.tree;
		const check = tree.edgeChild[edges(tree, 0).find((e) => tree.edgeAction[e] === ActionKind.Check)!];
		const checkCheck = skipChance(tree, tree.edgeChild[edges(tree, check).find((e) => tree.edgeAction[e] === ActionKind.Check)!]);
		expect(tree.round[checkCheck]).toBe(1);
		const bet = tree.edgeChild[edges(tree, checkCheck).find((e) => tree.edgeAction[e] === ActionKind.Bet)!];
		expect(actionsAt(tree, bet)).toEqual([ActionKind.Fold, ActionKind.Call, ActionKind.AllIn]);
	});

	it('with no sizes listed leaves only the shove as a raise', () => {
		const tree = defineSpot({ ...base, raiseOver: [] }).tree;
		for (const k of [0, 1, 2]) {
			expect(actionsAt(tree, facingBet(tree, k))).toEqual([ActionKind.Fold, ActionKind.Call, ActionKind.AllIn]);
		}
	});

	it('solves', () => {
		const s = solve(defineSpot({ ...base, board: 'As Kh 7d 2c 9h', raiseOver: [0.75] }), { iterations: 50 });
		expect(s.exploitabilityPercent()).toBeLessThan(2);
	});
});
