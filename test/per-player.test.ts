/**
 * Betting settings given apart for each player.
 */

import { describe, expect, it } from 'vitest';
import { createRun, defineSpot, solve } from '../src/index.ts';
import type { SpotConfig } from '../src/index.ts';
import { ActionKind, NodeKind } from '../src/tree.ts';
import type { Tree } from '../src/tree.ts';

const base: SpotConfig = {
	board: 'As Kh 7d 2c', pot: 100, stack: 200,
	oop: 'AA,KK,77,AKs,AQs,KQs,65s', ip: 'QQ,JJ,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.5]], maxRaises: 1,
};

/** The node after following actions from the root, passing chance nodes. */
function follow(tree: Tree, path: readonly number[]): number {
	let node = 0;
	for (const action of path) {
		while (tree.kind[node] === NodeKind.Chance) node = tree.edgeChild[tree.firstEdge[node]];
		const edges = Array.from({ length: tree.numEdges[node] }, (_, e) => tree.firstEdge[node] + e);
		const edge = edges.find((e) => tree.edgeAction[e] === action);
		if (edge === undefined) throw new Error(`no action ${action} at node ${node}`);
		node = tree.edgeChild[edge];
	}
	while (tree.kind[node] === NodeKind.Chance) node = tree.edgeChild[tree.firstEdge[node]];
	return node;
}

/** Bet or raise sizes at a node, as fractions of its pot. */
const sizesAt = (tree: Tree, node: number): number[] =>
	Array.from({ length: tree.numEdges[node] }, (_, e) => tree.firstEdge[node] + e)
		.filter((e) => tree.edgeAction[e] === ActionKind.Bet)
		.map((e) => Math.round((tree.edgeTarget[e] / tree.pot[node]) * 100) / 100);

const actionsAt = (tree: Tree, node: number): number[] =>
	Array.from({ length: tree.numEdges[node] }, (_, e) => tree.edgeAction[tree.firstEdge[node] + e]);

describe('per-player betting', () => {
	it('is the same game as a plain setting when both sides match', () => {
		const plain = defineSpot({ ...base, betSizes: [[0.33, 0.75]], maxRaises: 2, allowAllIn: true });
		const apart = defineSpot({
			...base,
			betSizes: { oop: [[0.33, 0.75]], ip: [[0.33, 0.75]] },
			maxRaises: { oop: 2, ip: 2 },
			allowAllIn: { oop: true, ip: true },
		});
		expect(apart.tree.nodeCount).toBe(plain.tree.nodeCount);
		expect(Array.from(apart.tree.edgeTarget)).toEqual(Array.from(plain.tree.edgeTarget));
		const a = solve(plain, { iterations: 20, workers: 1 });
		const b = solve(apart, { iterations: 20, workers: 1 });
		expect(b.exploitability()).toBe(a.exploitability());
		expect(b.ev(0)).toBe(a.ev(0));
	});

	it('offers each player their own sizes', () => {
		const spot = defineSpot({ ...base, betSizes: { oop: [[0.33]], ip: [[0.5, 1]] } });
		const { tree } = spot;
		// The root is out of position; after a check, in position bets.
		expect(sizesAt(tree, 0)).toEqual([0.33]);
		expect(sizesAt(tree, follow(tree, [ActionKind.Check]))).toEqual([0.5, 1]);
	});

	it('lets one player raise where the other may not', () => {
		const spot = defineSpot({ ...base, maxRaises: { oop: 2, ip: 1 } });
		const { tree } = spot;
		// IP bets, OOP may raise (second aggression, under OOP's 2)...
		const facingBet = follow(tree, [ActionKind.Check, ActionKind.Bet]);
		expect(actionsAt(tree, facingBet)).toContain(ActionKind.Raise);
		// ...but OOP bets and IP, at its limit of 1, may only call or fold.
		const facingOopBet = follow(tree, [ActionKind.Bet]);
		expect(actionsAt(tree, facingOopBet)).toEqual([ActionKind.Fold, ActionKind.Call]);
	});

	it('gives one player a shove and not the other', () => {
		const { tree } = defineSpot({ ...base, allowAllIn: { oop: true, ip: false } });
		expect(actionsAt(tree, 0)).toContain(ActionKind.AllIn);
		expect(actionsAt(tree, follow(tree, [ActionKind.Check]))).not.toContain(ActionKind.AllIn);
	});

	it('takes raise sizes and per-round rows apart too', () => {
		const spot = defineSpot({
			...base, board: 'As Kh 7d',
			betSizes: { oop: [[0.33], [0.5], [0.75]], ip: [[0.66]] },
			raiseSizes: { oop: [{ times: 3 }], ip: [{ times: 2.5 }] },
			maxRaises: 2,
		});
		expect(sizesAt(spot.tree, 0)).toEqual([0.33]);
		expect(() => defineSpot({ ...base, betSizes: { oop: [[0.33], [0.5], [0.75]], ip: [[0.5]] } })).toThrow(/oop betSizes/);
	});

	it('carries each side into a subgame', () => {
		const config: SpotConfig = { ...base, board: 'As Kh 7d', betSizes: { oop: [[0.33], [0.5], [0.75]], ip: [[0.66]] } };
		const run = createRun(defineSpot(config), { workers: 1 });
		try {
			run.step(2);
			const { tree } = run.spot;
			const turnOpen = follow(tree, [ActionKind.Check, ActionKind.Check]);
			const sub = run.snapshot().subgameAt(turnOpen, 0);
			expect(sub.betSizes).toEqual({ oop: [[0.5], [0.75]], ip: [[0.66]] });
			expect(() => defineSpot(sub)).not.toThrow();
		} finally {
			run.close();
		}
	});
});
