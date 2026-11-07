/**
 * A player can always shove, even for less than a full raise.
 *
 * Facing a bet with less behind than a full raise needs, the only raise
 * left is all-in for less. It used to be dropped with the full raise that
 * would not fit, leaving a short stack only call or fold.
 */

import { describe, expect, it } from 'vitest';
import { defineSpot, solve } from '../src/index.ts';
import type { SpotConfig } from '../src/index.ts';
import { ActionKind } from '../src/tree.ts';
import type { Tree } from '../src/tree.ts';

// River, pot 100, 120 behind. OOP bets 75; a full raise would need 150.
const river: SpotConfig = {
	board: 'As Kh 7d 2c 9h', pot: 100, stack: 120,
	oop: 'AA,KK,AKs,76s', ip: 'QQ,JJ,AQs,KQs', betSizes: [[0.75]], maxRaises: 2,
};

/** IP's actions facing OOP's bet: fold, call, and any raise, with targets in chips. */
function facingBet(tree: Tree): [number, number][] {
	const bet = tree.firstEdge[0] + 1;
	const node = tree.edgeChild[bet];
	return Array.from({ length: tree.numEdges[node] }, (_, e) => [
		tree.edgeAction[tree.firstEdge[node] + e],
		tree.edgeTarget[tree.firstEdge[node] + e] / 100,
	]);
}

describe('all-in for less than a full raise', () => {
	it('is offered when a full raise does not fit', () => {
		for (const allowAllIn of [true, false]) {
			const actions = facingBet(defineSpot({ ...river, allowAllIn }).tree);
			expect(actions).toEqual([[ActionKind.Fold, 0], [ActionKind.Call, 75], [ActionKind.AllIn, 120]]);
		}
	});

	it('leaves a full raise alone when it fits', () => {
		// 200 behind: the minimum raise to 150 fits, so a small raise size is
		// bumped to it, and the shove stays a separate option.
		const actions = facingBet(defineSpot({ ...river, stack: 200, raiseSizes: [0.1], allowAllIn: true }).tree);
		expect(actions).toEqual([[ActionKind.Fold, 0], [ActionKind.Call, 75], [ActionKind.Raise, 150], [ActionKind.AllIn, 200]]);
	});

	it('is not offered with nothing beyond the call', () => {
		// Exactly the bet behind: calling is all there is.
		const actions = facingBet(defineSpot({ ...river, stack: 75 }).tree);
		expect(actions.map(([kind]) => kind)).toEqual([ActionKind.Fold, ActionKind.Call]);
	});

	it('is played: the short stack shoves its sets', () => {
		// IP holds sets and a bluff catcher against top pairs and air.
		const solution = solve(defineSpot({ ...river, oop: 'AQs,KQs,JTs,T8s', ip: '99,22,AJs' }), { iterations: 300, workers: 1 });
		const { tree } = solution.spot;
		const node = tree.edgeChild[tree.firstEdge[0] + 1];
		const view = solution.strategyAt(node, 0);
		const shove = view.actions.indexOf('allin 120');
		expect(shove).toBeGreaterThanOrEqual(0);
		let most = 0;
		for (let i = 0; i < view.combos.length; i++) most = Math.max(most, view.probs[i * view.actions.length + shove]);
		expect(most).toBeGreaterThan(0.5);
	});
});
