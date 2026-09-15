import { describe, expect, it } from 'vitest';
import { cardOf, DECK, formatCards, parseCards, rankOf, suitOf } from '../src/cards.ts';
import { categoryOf, CATEGORY, evaluateCards } from '../src/eval7.ts';

/**
 * Independent classifier, written from the rules of poker rather than from the
 * evaluator. Shares no code with it, so agreement is evidence.
 */
function classify(cards: number[]): number {
	const rankCount = new Array(13).fill(0);
	const suitCount = new Array(4).fill(0);
	let mask = 0;
	for (const card of cards) {
		rankCount[rankOf(card)]++;
		suitCount[suitOf(card)]++;
		mask |= 1 << rankOf(card);
	}
	const shape = rankCount.filter((n) => n > 0).sort((a, b) => b - a);
	const isFlush = suitCount.some((n) => n === 5);

	let isStraight = false;
	for (let low = 0; low + 5 <= 13; low++) {
		if ((mask & (0b11111 << low)) === 0b11111 << low) isStraight = true;
	}
	// Ace plays low: A2345.
	if ((mask & (1 << 12)) !== 0 && (mask & 0b1111) === 0b1111) isStraight = true;

	if (isStraight && isFlush) return CATEGORY.straightFlush;
	if (shape[0] === 4) return CATEGORY.quads;
	if (shape[0] === 3 && shape[1] === 2) return CATEGORY.fullHouse;
	if (isFlush) return CATEGORY.flush;
	if (isStraight) return CATEGORY.straight;
	if (shape[0] === 3) return CATEGORY.trips;
	if (shape[0] === 2 && shape[1] === 2) return CATEGORY.twoPair;
	if (shape[0] === 2) return CATEGORY.pair;
	return CATEGORY.highCard;
}

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe('five-card evaluation, exhaustively', () => {
	it('agrees with an independent classifier on all 2,598,960 hands', () => {
		const counts = new Array(9).fill(0);
		const hand = [0, 0, 0, 0, 0];
		let total = 0;
		let disagreements = 0;
		let firstDisagreement = '';

		for (let a = 0; a < DECK; a++) {
			hand[0] = a;
			for (let b = a + 1; b < DECK; b++) {
				hand[1] = b;
				for (let c = b + 1; c < DECK; c++) {
					hand[2] = c;
					for (let d = c + 1; d < DECK; d++) {
						hand[3] = d;
						for (let e = d + 1; e < DECK; e++) {
							hand[4] = e;
							total++;
							const mine = categoryOf(evaluateCards(hand));
							const reference = classify(hand);
							if (mine !== reference) {
								if (!disagreements) firstDisagreement = `${formatCards(hand)}: got ${mine}, expected ${reference}`;
								disagreements++;
							}
							counts[reference]++;
						}
					}
				}
			}
		}

		expect(total).toBe(2_598_960);
		expect(disagreements, firstDisagreement).toBe(0);

		// The textbook frequencies. Any transcription error in the straight or
		// flush detection moves these.
		expect(counts[CATEGORY.straightFlush]).toBe(40);
		expect(counts[CATEGORY.quads]).toBe(624);
		expect(counts[CATEGORY.fullHouse]).toBe(3_744);
		expect(counts[CATEGORY.flush]).toBe(5_108);
		expect(counts[CATEGORY.straight]).toBe(10_200);
		expect(counts[CATEGORY.trips]).toBe(54_912);
		expect(counts[CATEGORY.twoPair]).toBe(123_552);
		expect(counts[CATEGORY.pair]).toBe(1_098_240);
		expect(counts[CATEGORY.highCard]).toBe(1_302_540);
	});
});

describe('seven-card evaluation', () => {
	it('equals the best of its twenty-one five-card subsets', () => {
		// An independent check of the seven-card path against the five-card one,
		// which the exhaustive test above has already pinned down.
		const random = mulberry32(0xc0ffee);
		const deck = Array.from({ length: DECK }, (_, i) => i);
		const subsets: number[][] = [];
		for (let a = 0; a < 7; a++)
			for (let b = a + 1; b < 7; b++)
				for (let c = b + 1; c < 7; c++)
					for (let d = c + 1; d < 7; d++)
						for (let e = d + 1; e < 7; e++) subsets.push([a, b, c, d, e]);
		expect(subsets.length).toBe(21);

		const five = [0, 0, 0, 0, 0];
		for (let trial = 0; trial < 200_000; trial++) {
			for (let i = 0; i < 7; i++) {
				const j = i + Math.floor(random() * (DECK - i));
				[deck[i], deck[j]] = [deck[j], deck[i]];
			}
			const seven = deck.slice(0, 7);

			let best = -1;
			for (const subset of subsets) {
				for (let i = 0; i < 5; i++) five[i] = seven[subset[i]];
				const value = evaluateCards(five);
				if (value > best) best = value;
			}
			expect(evaluateCards(seven), formatCards(seven)).toBe(best);
		}
	});

	it('is unchanged by relabelling suits', () => {
		const random = mulberry32(7);
		const deck = Array.from({ length: DECK }, (_, i) => i);
		const perms: number[][] = [];
		const build = (cur: number[], used: boolean[]): void => {
			if (cur.length === 4) { perms.push([...cur]); return; }
			for (let i = 0; i < 4; i++) {
				if (used[i]) continue;
				used[i] = true;
				build([...cur, i], used);
				used[i] = false;
			}
		};
		build([], new Array(4).fill(false));

		for (let trial = 0; trial < 20_000; trial++) {
			for (let i = 0; i < 7; i++) {
				const j = i + Math.floor(random() * (DECK - i));
				[deck[i], deck[j]] = [deck[j], deck[i]];
			}
			const seven = deck.slice(0, 7);
			const base = evaluateCards(seven);
			for (const perm of perms) {
				const mapped = seven.map((card) => cardOf(rankOf(card), perm[suitOf(card)]));
				expect(evaluateCards(mapped)).toBe(base);
			}
		}
	});

	it('orders known hands correctly', () => {
		const value = (text: string) => evaluateCards(parseCards(text));
		// Straight flush beats quads beats a boat, and so on down.
		const ladder = [
			'2c 7d 9h Jc Qs',       // high card
			'2c 2d 9h Jc Qs',       // pair
			'2c 2d 9h 9c Qs',       // two pair
			'2c 2d 2h 9c Qs',       // trips
			'5c 6d 7h 8c 9s',       // straight
			'2c 7c 9c Jc Qc',       // flush
			'2c 2d 2h 9c 9s',       // full house
			'2c 2d 2h 2s 9s',       // quads
			'5c 6c 7c 8c 9c',       // straight flush
		];
		for (let i = 1; i < ladder.length; i++) {
			expect(value(ladder[i]), `${ladder[i]} should beat ${ladder[i - 1]}`).toBeGreaterThan(value(ladder[i - 1]));
		}

		// The wheel is the lowest straight, and loses to a six-high straight.
		expect(value('As 2d 3h 4c 5s')).toBeGreaterThan(value('Ks Qd Jh 9c 8s'));
		expect(value('2d 3h 4c 5s 6d')).toBeGreaterThan(value('As 2d 3h 4c 5s'));

		// Straight flushes of the same rank in different suits are a chop.
		expect(value('5c 6c 7c 8c 9c')).toBe(value('5h 6h 7h 8h 9h'));

		// Kickers matter, and only the best five of seven count.
		expect(value('As Ad Kh Qc 2s')).toBeGreaterThan(value('As Ad Qh Jc 2s'));
		expect(value('As Ad Kh Qc Js 2h 3d')).toBe(value('As Ad Kh Qc Js'));
	});
});
