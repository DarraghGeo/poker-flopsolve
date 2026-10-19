import { describe, expect, it } from 'vitest';
import { COMBO_CARDS, COMBOS, createRun, defineSpot, NodeKind, solve } from '../src/index.ts';
import { matchupMass } from '../src/cfr.ts';

/**
 * Re-solving from a node.
 *
 * A subgame built from a well-solved spot, and solved again with the same
 * betting, must reach the value the original solution has there: the game value
 * for a given pair of ranges is unique. Only lines the original actually plays
 * are compared — on a line nobody takes, the original strategy is never pushed
 * towards equilibrium, which is exactly what re-solving is for.
 */
describe('subgames', () => {
	const config = {
		board: 'Qs Jh 4d 2c',
		pot: 40,
		stack: 60,
		oop: 'JJ, TT, AQs, KQs, QTs, J9s, 87s, AJo',
		ip: 'AA, KK, AJs, QJs, JTs, T9s, 65s, KQo',
		betSizes: [[0.75]],
		maxRaises: 1,
	};
	const run = createRun(defineSpot(config), { workers: 1 });
	run.step(2000);
	const sol = run.snapshot();
	const { tree, runouts } = sol.spot;

	/** The river decision reached by checking the turn through. */
	const checkedThrough = (() => {
		for (let node = 0; node < tree.nodeCount; node++) {
			if (tree.kind[node] !== NodeKind.Chance) continue;
			const child = tree.edgeChild[tree.firstEdge[node]];
			if (sol.path(child) === 'check check /') return child;
		}
		throw new Error('no checked-through river');
	})();

	it('starts each range from its reach at the root', () => {
		const reach = sol.reachAt(0, 0, 1);
		for (let combo = 0; combo < COMBOS; combo++) expect(reach[combo]).toBe(sol.spot.players[1].weights[combo]);
	});

	it.each([0, 17, 40])('reaches the original value on river %i', (board) => {
		const sub = defineSpot(sol.subgameAt(checkedThrough, board));
		expect(sub.board).toHaveLength(5);
		expect(sub.potUnits).toBe(tree.pot[checkedThrough]);
		expect(sub.stackUnits).toBe(sol.spot.stackUnits);

		// The original's value there, per matchup, from its own counterfactual
		// values and the ranges that arrive.
		const r0 = sol.reachAt(checkedThrough, board, 0);
		const r1 = sol.reachAt(checkedThrough, board, 1);
		const cards = runouts.cards[1].subarray(board * 5, board * 5 + 5);
		const live: number[] = [];
		for (let combo = 0; combo < COMBOS; combo++) {
			if (cards.includes(COMBO_CARDS[combo * 2]) || cards.includes(COMBO_CARDS[combo * 2 + 1])) {
				r0[combo] = 0;
				r1[combo] = 0;
			} else if (r0[combo] > 0 || r1[combo] > 0) {
				live.push(combo);
			}
		}
		const list = Uint16Array.from(live);
		const values = run.solver.valuesAt(checkedThrough, board, 0, r0, r1, list, list.length);
		let total = 0;
		for (const combo of live) total += r0[combo] * values[combo];
		const original = total / matchupMass(r0, r1);

		const resolved = solve(sub, { iterations: 3000, workers: 1 });
		expect(resolved.exploitabilityPercent()).toBeLessThan(0.01);
		expect(resolved.ev(0)).toBeCloseTo(original, 2);
	});

	it('re-solves with a richer tree than the original could afford', () => {
		const richer = defineSpot(sol.subgameAt(checkedThrough, 0, { betSizes: [[0.33, 0.75, 1.5]], maxRaises: 2, allowAllIn: true }));
		expect(richer.estimate.decisionNodes).toBeGreaterThan(5);
		const resolved = solve(richer, { iterations: 2000, targetPercent: 0.1, workers: 1 });
		expect(resolved.stoppedAt).toBe('target');
	});

	it('refuses a node that does not open a betting round', () => {
		const midRound = tree.edgeChild[tree.firstEdge[checkedThrough]];
		expect(() => sol.subgameAt(midRound, 0)).toThrow(/does not open a betting round/);
	});
});
