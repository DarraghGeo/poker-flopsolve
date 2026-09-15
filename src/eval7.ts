/**
 * Five-to-seven card hand evaluation.
 *
 * Purpose: turn a set of cards into a single integer whose order is hand
 * strength, with exact equality for chops.
 *
 * Ported from the author's `poker-bitvaljs` (MIT), where the same routine is
 * proven order-equivalent to a BigInt reference over all 2,598,960 five-card
 * and all 133,784,560 seven-card hands. The port is re-verified here against an
 * independent classifier rather than taken on trust — the original's evidence
 * says nothing about whether this transcription is faithful.
 *
 * Input is four 13-bit rank masks, one per suit, which makes combining hole
 * cards with a board four ORs. Output packs a category and five tiebreak
 * nibbles into one int32:
 *
 *     value = category * 16^5 + t1 * 16^4 + ... + t5
 *
 * Straight flushes of the same top rank in different suits compare EQUAL, which
 * is correct poker and what a solver needs to score chops.
 */

/** Population count of each 13-bit rank mask. */
const POPCOUNT = new Uint8Array(8192);

/** Top rank of the best straight in a mask: 4..12, 3 for the wheel, -1 for none. */
const STRAIGHT = new Int8Array(8192);

for (let mask = 0; mask < 8192; mask++) {
	let bits = 0;
	for (let x = mask; x; x &= x - 1) bits++;
	POPCOUNT[mask] = bits;

	let run = 0;
	let top = -1;
	for (let rank = 12; rank >= 0; rank--) {
		if (mask & (1 << rank)) {
			if (++run >= 5) {
				top = rank + 4;
				break;
			}
		} else {
			run = 0;
		}
	}
	// The wheel is the one straight the descending scan cannot see, because the
	// ace sits at the far end of the mask from the four it completes.
	if (top < 0 && mask & (1 << 12) && (mask & 0b1111) === 0b1111) top = 3;
	STRAIGHT[mask] = top;
}

/** Index of the highest set bit. Returns -1 for zero, which callers must avoid. */
function high(mask: number): number {
	return 31 - Math.clz32(mask);
}

/** Hand categories, weakest first, matching the packed value's high digit. */
export const CATEGORY = {
	highCard: 0,
	pair: 1,
	twoPair: 2,
	trips: 3,
	straight: 4,
	flush: 5,
	fullHouse: 6,
	quads: 7,
	straightFlush: 8,
} as const;

export const CATEGORY_NAMES = [
	'high card',
	'pair',
	'two pair',
	'three of a kind',
	'straight',
	'flush',
	'full house',
	'four of a kind',
	'straight flush',
] as const;

/** Category of a packed value. */
export function categoryOf(value: number): number {
	return (value / 1048576) | 0;
}

/**
 * Evaluate five to seven cards.
 *
 * Higher is stronger; equal values are exact chops. Behaviour is undefined for
 * fewer than five cards — `high(0)` would return -1 and the kicker loops would
 * read past the mask.
 *
 * @param s spade rank mask
 * @param h heart rank mask
 * @param d diamond rank mask
 * @param c club rank mask
 */
export function evaluate(s: number, h: number, d: number, c: number): number {
	const all = s | h | d | c;

	// One suit with five or more cards serves both the straight flush and the
	// plain flush; there can only ever be one such suit in seven cards.
	let flush = 0;
	if (POPCOUNT[s] >= 5) flush = s;
	else if (POPCOUNT[h] >= 5) flush = h;
	else if (POPCOUNT[d] >= 5) flush = d;
	else if (POPCOUNT[c] >= 5) flush = c;

	if (flush) {
		const top = STRAIGHT[flush];
		if (top >= 0) return 8 * 1048576 + top * 65536;
	}

	// Exact rank multiplicities, by intersecting suits rather than counting.
	const four = s & h & d & c;
	const threePlus = (s & h & d) | (s & h & c) | (s & d & c) | (h & d & c);
	const twoPlus = (s & h) | (s & d) | (s & c) | (h & d) | (h & c) | (d & c);
	const trips = threePlus & ~four;
	const pairs = twoPlus & ~threePlus;

	if (four) {
		const quad = high(four);
		const kicker = high(all & ~(1 << quad));
		return 7 * 1048576 + quad * 65536 + kicker * 4096;
	}

	if (trips) {
		const top = high(trips);
		const otherTrips = trips & ~(1 << top);
		const pair = otherTrips ? high(otherTrips) : pairs ? high(pairs) : -1;
		if (pair >= 0) return 6 * 1048576 + top * 65536 + pair * 4096;
	}

	if (flush) {
		let mask = flush;
		let value = 5 * 1048576;
		let shift = 65536;
		for (let i = 0; i < 5; i++) {
			const rank = high(mask);
			value += rank * shift;
			mask &= ~(1 << rank);
			shift >>= 4;
		}
		return value;
	}

	{
		const top = STRAIGHT[all];
		if (top >= 0) return 4 * 1048576 + top * 65536;
	}

	if (trips) {
		const top = high(trips);
		let rest = all & ~(1 << top);
		const k1 = high(rest);
		rest &= ~(1 << k1);
		const k2 = high(rest);
		return 3 * 1048576 + top * 65536 + k1 * 4096 + k2 * 256;
	}

	if (pairs && pairs & (pairs - 1)) {
		const p1 = high(pairs);
		const p2 = high(pairs & ~(1 << p1));
		const kicker = high(all & ~(1 << p1) & ~(1 << p2));
		return 2 * 1048576 + p1 * 65536 + p2 * 4096 + kicker * 256;
	}

	if (pairs) {
		const pair = high(pairs);
		let rest = all & ~(1 << pair);
		const k1 = high(rest);
		rest &= ~(1 << k1);
		const k2 = high(rest);
		rest &= ~(1 << k2);
		const k3 = high(rest);
		return 1 * 1048576 + pair * 65536 + k1 * 4096 + k2 * 256 + k3 * 16;
	}

	{
		let mask = all;
		let value = 0;
		let shift = 65536;
		for (let i = 0; i < 5; i++) {
			const rank = high(mask);
			value += rank * shift;
			mask &= ~(1 << rank);
			shift >>= 4;
		}
		return value;
	}
}

/**
 * Evaluate a list of cards, for tests and one-off calls.
 *
 * The solver never uses this — it keeps lanes around and ORs them — but it
 * makes the evaluator usable without knowing the lane encoding.
 *
 * @param cards five to seven card indices
 */
export function evaluateCards(cards: ArrayLike<number>): number {
	let s = 0;
	let h = 0;
	let d = 0;
	let c = 0;
	for (let i = 0; i < cards.length; i++) {
		const card = cards[i];
		const bit = 1 << (card >> 2);
		switch (card & 3) {
			case 0:
				s |= bit;
				break;
			case 1:
				h |= bit;
				break;
			case 2:
				d |= bit;
				break;
			default:
				c |= bit;
		}
	}
	return evaluate(s, h, d, c);
}
