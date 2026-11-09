/**
 * The napkinpoker scorer (`bench/reference/score.ts`, issue #103): it values
 * a strategy at the stored per-action EVs, and picks the nodes worth scoring.
 */

import { describe, expect, it } from 'vitest';
import { napkinAvailable, napkinNodes } from '../bench/reference/napkinpoker.ts';
import type { NapkinNode } from '../bench/reference/napkinpoker.ts';
import { COMBO_CARDS, COMBOS, parseCards } from '../src/cards.ts';
import { lineReach, MIN_REACH, offCards, pairSubset, scoreNode, storedNodes } from '../bench/reference/score.ts';

/** Two hands, two actions, pot 10: hand 0 prefers action 0 by 1 chip, hand 1 action 1 by 2. */
const node: NapkinNode = {
	id: 'fxx', spot: 'fxx', board: 'AsKh7d', path: [], actor: 0, pot: 10, facing: 0, stack: 100,
	reach: [1, 1], actions: ['X', 'B300'],
	combos: Uint16Array.of(5, 9),
	weight: Float64Array.of(1, 3),
	strategy: [Float64Array.of(0.5, 0), Float64Array.of(0.5, 1)],
	ev: [Float64Array.of(4, 1), Float64Array.of(3, 3)],
};

describe('napkinpoker scorer', () => {
	it('values a mix at the stored EVs, reach-weighted, in % of the pot', () => {
		// Each hand's best action: no loss.
		const best = scoreNode(node, 'flop', (a, combo) => (combo === 5 ? (a === 0 ? 1 : 0) : a));
		expect(best.loss).toBeCloseTo(0, 12);
		// The stored strategy loses 0.5 chips on hand 0 (weight 1 of 4): 1.25% of a 10-chip pot.
		expect(best.refLoss).toBeCloseTo(1.25, 12);
		expect(best.handDiff).toBeCloseTo(1.25, 12);
		// Playing the stored strategy loses what it does, and differs from it by nothing.
		const same = scoreNode(node, 'flop', (a, combo) => node.strategy[a][combo === 5 ? 0 : 1]);
		expect(same.loss).toBeCloseTo(same.refLoss, 12);
		expect(same.handDiff).toBe(0);
		expect(same.strategyDiff).toBe(0);
		// Always the worse action: (1 * 1 + 3 * 2) / 4 chips = 17.5% of the pot.
		const worst = scoreNode(node, 'flop', (a, combo) => (combo === 5 ? a : 1 - a));
		expect(worst.loss).toBeCloseTo(17.5, 12);
		expect(worst.strategyDiff).toBeCloseTo((0.5 + 3) / 4, 12);
	});

	it('plays a hand it holds no strategy for uniformly over the actions its tree has', () => {
		// Our tree lacks action 1: such a hand checks, losing hand 1's 2 chips (weight 3 of 4).
		const scored = scoreNode(node, 'flop', () => 0, (a) => a === 0);
		expect(scored.loss).toBeCloseTo(15, 12);
	});

	it('drops hands a later card blocks from a reach', () => {
		const reach = new Float64Array(COMBOS).fill(1);
		const [turn] = parseCards('2s');
		const off = offCards(reach, [turn]);
		for (let h = 0; h < COMBOS; h++) {
			expect(off[h]).toBe(COMBO_CARDS[h * 2] === turn || COMBO_CARDS[h * 2 + 1] === turn ? 0 : 1);
		}
	});

	it('pairs a subset of the stored actions, but not an action the stored solver lacks', () => {
		expect(pairSubset(['X', 'B759'], ['X', 'B759', 'B1725', 'A8900'])).toEqual([0, 1, -1, -1]);
		expect(pairSubset(['X', 'B760', 'A8900'], ['X', 'B759', 'B1725', 'A8900'])).toEqual([0, 1, -1, 2]);
		expect(pairSubset(['X', 'B500'], ['X', 'B759'])).toBeNull();
	});

	// Needs the fixtures, which live in private napkinpoker (#119).
	it.skipIf(!napkinAvailable())('scores turn nodes by the reach of their flop line, which their own reach does not show', () => {
		const turns = napkinNodes('turn').filter((n) => n.spot === 'f03');
		expect(turns.every((n) => n.reach[0] === 1 && n.reach[1] === 1)).toBe(true);
		// After a check, IP bets 75% with 1.7% of its range: too rare for the
		// flop decision it leads to to be stored, so its turn is not scored.
		const rare = turns.find((n) => n.path.join(',') === 'X,B1725,C,d2s')!;
		expect(lineReach(rare)).toBeNull();
		// Check-check: OOP checks 24.7%, IP 56% of its range.
		const checked = turns.find((n) => n.path.join(',') === 'X,X,d2s')!;
		expect(lineReach(checked)![0]).toBeCloseTo(0.247, 3);
		expect(lineReach(checked)![1]).toBeCloseTo(0.56, 2);
		const kept = storedNodes('f03', 'turn').map((n) => n.path.join(','));
		expect(kept).not.toContain('X,B1725,C,d2s');
		expect(kept).toContain('X,X,d2s');
		for (const n of storedNodes('f03', 'turn')) expect(Math.min(...lineReach(n)!)).toBeGreaterThanOrEqual(MIN_REACH);
		for (const n of storedNodes('f03', 'flop')) expect(n.reach[1]).toBeGreaterThanOrEqual(MIN_REACH);
	});
});
