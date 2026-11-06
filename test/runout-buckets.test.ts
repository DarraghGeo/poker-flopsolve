/**
 * Runout buckets: one turn or river card solved for several that play alike.
 */

import { describe, expect, it } from 'vitest';
import { COMBO_CARDS, comboIndex, parseCard, parseCards } from '../src/cards.ts';
import { createRun, defineSpot } from '../src/index.ts';
import type { SpotConfig } from '../src/index.ts';
import { connectivity } from '../src/runouts.ts';

const ranks = (text: string): Set<number> => new Set(parseCards(text).map((card) => card >> 2));
const R = (rank: string): number => '23456789TJQKA'.indexOf(rank);

const pairsAndBroadway: SpotConfig = {
	board: 'Ah Kd Qc', pot: 60, stack: 100,
	oop: 'AA-22,AKs-ATs,KQs-KTs,QJs,AKo-AJo', ip: 'KK-22,AQs-ATs,KJs+,QJs,AQo-AJo',
	betSizes: [[0.66]], maxRaises: 1,
};

describe('connectivity', () => {
	it('counts board ranks sharing a straight window, the ace low too', () => {
		const akq = ranks('Ah Kd Qc');
		expect(connectivity(akq, R('9'))).toBe(2); // 9TJQK
		expect(connectivity(akq, R('8'))).toBe(1); // 89TJQ
		expect(connectivity(akq, R('7'))).toBe(0);
		expect(connectivity(akq, R('2'))).toBe(1); // A2345
		expect(connectivity(akq, R('T'))).toBe(3); // TJQKA
	});
});

describe('runout buckets', () => {
	it('store fewer runouts, more with a wider gap', () => {
		const exact = defineSpot(pairsAndBroadway).runouts.counts;
		const one = defineSpot({ ...pairsAndBroadway, runoutBuckets: true }).runouts;
		const three = defineSpot({ ...pairsAndBroadway, runoutBuckets: 3 }).runouts;
		expect(one.approximate).toBe(true);
		expect(one.counts[1]).toBeLessThan(exact[1]);
		expect(three.counts[2]).toBeLessThan(one.counts[2]);
		expect(defineSpot(pairsAndBroadway).runouts.approximate).toBe(false);
	});

	it('never bucket a card that pairs the board, or two of different suits', () => {
		const spot = defineSpot({ ...pairsAndBroadway, runoutBuckets: 3 });
		// Every turn card stands only for cards of its own suit.
		const { orbitStart, orbitCard, cards } = spot.runouts;
		for (let b = 0; b < spot.runouts.counts[1]; b++) {
			const stored = cards[1][b * 4 + 3];
			for (let m = orbitStart[1][b]; m < orbitStart[1][b + 1]; m++) {
				const real = orbitCard[1][m];
				if ((real >> 2) !== (stored >> 2)) expect(real & 3).toBe(stored & 3);
			}
		}
		// An ace pairs the board, so it is stored as itself.
		expect(spot.resolveBoard('Ah Kd Qc As').board).not.toBe(spot.resolveBoard('Ah Kd Qc Ks').board);
	});

	it('keep ranks apart when a range tells them apart', () => {
		// 98s is in the range and 87s is not, so an 8 and a 9 cannot swap.
		const spot = defineSpot({ ...pairsAndBroadway, oop: `${pairsAndBroadway.oop},98s`, runoutBuckets: 3 });
		const eight = spot.resolveBoard('Ah Kd Qc 8s');
		const nine = spot.resolveBoard('Ah Kd Qc 9s');
		expect(eight.board).not.toBe(nine.board);
	});

	it('relabel hands by the rank swap', () => {
		const spot = defineSpot({ ...pairsAndBroadway, runoutBuckets: true });
		const three = spot.resolveBoard('Ah Kd Qc 3s');
		const two = spot.resolveBoard('Ah Kd Qc 2s');
		expect(three.board).toBe(two.board);
		// On the 3, 33 plays as 22 on the stored 2, and the other way round.
		const threes = comboIndex(parseCard('3h'), parseCard('3d'));
		const image = three.combos[threes];
		expect(COMBO_CARDS[image * 2] >> 2).toBe(R('2'));
		expect(COMBO_CARDS[image * 2 + 1] >> 2).toBe(R('2'));
	});

	it('report the true exploitability, which the bucketed one understates', () => {
		const run = createRun(defineSpot({ ...pairsAndBroadway, runoutBuckets: true }), { workers: 4 });
		const exact = createRun(defineSpot(pairsAndBroadway), { workers: 4 });
		try {
			run.step(30);
			exact.step(30);
			const abstract = run.exploitabilityPercent();
			const real = run.trueExploitabilityPercent();
			expect(real).toBeGreaterThan(abstract);
			// Close to the exact solve, though not as good.
			expect(real).toBeLessThan(exact.exploitabilityPercent() * 3);
			expect(exact.trueExploitabilityPercent()).toBe(exact.exploitabilityPercent());
		} finally {
			run.close();
			exact.close();
		}
	});
});
