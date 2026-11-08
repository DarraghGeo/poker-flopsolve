/**
 * Warm starts across boards: `warmCards` relabels a solve of one flop onto
 * another.
 */

import { describe, expect, it } from 'vitest';
import { createRun, defineSpot } from '../src/index.ts';
import type { SolveOptions, SpotConfig } from '../src/index.ts';
import { DECK, parseCard } from '../src/cards.ts';
import { rankSwap } from '../src/runouts.ts';
import { warmStart } from '../src/warm.ts';

const flop: SpotConfig = {
	board: 'Ts9s4h', pot: 60, stack: 100,
	oop: 'AA,KK,QQ,AKs,AQs,KQs,76s,65s', ip: 'JJ,TT,99,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.66]], maxRaises: 1,
};

const ONE: SolveOptions = { workers: 1, precision: 'f32', engine: 'js' };
const rank = (r: string): number => '23456789TJQKA'.indexOf(r);

/** The card map swapping two suits in every rank. */
function suitSwap(a: string, b: string): Uint8Array {
	const cards = new Uint8Array(DECK);
	for (let card = 0; card < DECK; card++) cards[card] = card;
	for (const r of '23456789TJQKA') {
		cards[parseCard(r + a)] = parseCard(r + b);
		cards[parseCard(r + b)] = parseCard(r + a);
	}
	return cards;
}

describe('warm start across boards', () => {
	it('relabelling by a symmetry of the game changes nothing', () => {
		// The ranges treat every suit alike, so swapping spades and hearts maps
		// a solve of Th9h4s onto Ts9s4h exactly: the same game, relabelled.
		const source = createRun(defineSpot({ ...flop, board: 'Th9h4s' }), ONE);
		source.step(20);
		const relabelled = createRun(defineSpot(flop), { analysisOnly: true });
		try {
			warmStart(relabelled.solver.ctx, source.solver.ctx, true, suitSwap('s', 'h'));
			const a = source.snapshot();
			const b = relabelled.snapshot();
			expect(b.ev(0)).toBeCloseTo(a.ev(0), 4);
			expect(b.ev(1)).toBeCloseTo(a.ev(1), 4);
			expect(relabelled.exploitabilityPercent()).toBeCloseTo(source.exploitabilityPercent(), 4);
		} finally {
			source.close();
			relabelled.close();
		}
	});

	it('starts a neighbouring flop far closer to equilibrium than from nothing', () => {
		// Ts9s5h onto Ts9s4h: 4 and 5 swap, so 65s there plays as 64s here.
		const source = createRun(defineSpot({ ...flop, board: 'Ts9s5h' }), ONE);
		source.step(60);
		const warm = createRun(defineSpot(flop), { ...ONE, warmStart: source, warmCards: rankSwap(rank('4'), rank('5')) });
		const cold = createRun(defineSpot(flop), ONE);
		try {
			expect(warm.warmStart).toEqual({ matchedNodes: warm.spot.tree.decisionNodes.length, decisionNodes: warm.spot.tree.decisionNodes.length, averages: false });
			expect(warm.totalIterations).toBe(60);
			cold.step(1);
			warm.step(1);
			expect(warm.exploitabilityPercent()).toBeLessThan(cold.exploitabilityPercent() / 2);
		} finally {
			source.close();
			warm.close();
			cold.close();
		}
	});

	it('refuses a relabelling that does not carry one board onto the other', () => {
		const source = createRun(defineSpot({ ...flop, board: 'Ts9s5h' }), ONE);
		try {
			const make = (cards: Uint8Array) => () => createRun(defineSpot(flop), { ...ONE, warmStart: source, warmCards: cards });
			expect(make(rankSwap(rank('2'), rank('3')))).toThrow(/onto the warm start's board/);
			const notPermutation = rankSwap(rank('4'), rank('5'));
			notPermutation[0] = notPermutation[1];
			expect(make(notPermutation)).toThrow(/permutation/);
			expect(make(new Uint8Array(DECK - 1))).toThrow(/all 52 cards/);
		} finally {
			source.close();
		}
	});
});
