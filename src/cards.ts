/**
 * Card encoding for a standard 52-card deck.
 *
 * Purpose: the one place a card's integer form is decided.
 *
 * A card is `rank * 4 + suit`, with rank 0 = deuce and 12 = ace, and suit
 * ordered `s h d c`. Rank-major means all four cards of a rank are adjacent.
 *
 * The evaluator wants a different shape — four 13-bit rank masks, one per suit
 * — so {@link suitLanes} converts. Keeping the two representations separate is
 * deliberate: the integer index is what ranges, blockers and array offsets use,
 * and the lanes exist only for the duration of an evaluation.
 */

/** Ranks, lowest first, so the character index equals the rank. */
const RANK_CHARS = '23456789TJQKA';

/** Suits in index order. */
const SUIT_CHARS = 'shdc';

export const RANKS = 13;
export const SUITS = 4;
export const DECK = 52;

/** Distinct two-card combinations, `C(52, 2)`. */
export const COMBOS = 1326;

/** Rank of a card, 0 = deuce, 12 = ace. */
export function rankOf(card: number): number {
	return card >> 2;
}

/** Suit of a card, 0..3 in `s h d c` order. */
export function suitOf(card: number): number {
	return card & 3;
}

/** Card index from rank and suit. */
export function cardOf(rank: number, suit: number): number {
	return (rank << 2) | suit;
}

/**
 * Name a card, e.g. "As".
 * @param card card index
 */
export function formatCard(card: number): string {
	return RANK_CHARS[rankOf(card)] + SUIT_CHARS[suitOf(card)];
}

/** Name a list of cards, space separated. */
export function formatCards(cards: Iterable<number>): string {
	return [...cards].map(formatCard).join(' ');
}

/**
 * Parse a card name such as "As" or "th".
 * @param name two characters, rank then suit
 * @throws if the name is not a card
 */
export function parseCard(name: string): number {
	if (name.length !== 2) throw new Error(`Invalid card "${name}": expected two characters`);
	const rank = RANK_CHARS.indexOf(name[0].toUpperCase());
	const suit = SUIT_CHARS.indexOf(name[1].toLowerCase());
	if (rank < 0) throw new Error(`Invalid rank "${name[0]}" in card "${name}"`);
	if (suit < 0) throw new Error(`Invalid suit "${name[1]}" in card "${name}"`);
	return cardOf(rank, suit);
}

/**
 * Parse a board or hand written as "AsKh7d", "As Kh 7d" or "as kh 7d".
 * @param text card names, optionally separated by spaces or commas
 * @throws if any card is malformed or repeated
 */
export function parseCards(text: string): number[] {
	const compact = text.replace(/[\s,]+/g, '');
	if (compact.length % 2 !== 0) throw new Error(`"${text}" is not a whole number of cards`);

	const cards: number[] = [];
	const seen = new Set<number>();
	for (let i = 0; i < compact.length; i += 2) {
		const card = parseCard(compact.slice(i, i + 2));
		if (seen.has(card)) throw new Error(`"${formatCard(card)}" appears twice in "${text}"`);
		seen.add(card);
		cards.push(card);
	}
	return cards;
}

/**
 * Pack cards into the four 13-bit rank masks the evaluator takes.
 *
 * @param cards card indices
 * @param lanes destination of length 4; zeroed by this call
 */
export function suitLanes(cards: Iterable<number>, lanes: Int32Array): void {
	lanes[0] = 0;
	lanes[1] = 0;
	lanes[2] = 0;
	lanes[3] = 0;
	for (const card of cards) lanes[card & 3] |= 1 << (card >> 2);
}

/**
 * Index of a two-card combination, in the same colex order the solver uses.
 *
 * For `a < b` this is `a + b(b-1)/2`, a dense bijection onto `0..1325`.
 *
 * @param a one card
 * @param b the other card
 */
export function comboIndex(a: number, b: number): number {
	const lo = a < b ? a : b;
	const hi = a < b ? b : a;
	return lo + ((hi * (hi - 1)) >> 1);
}

/** The two cards of every combination, flat, `COMBOS * 2` entries ascending. */
export const COMBO_CARDS: Uint8Array = (() => {
	const cards = new Uint8Array(COMBOS * 2);
	let index = 0;
	for (let b = 1; b < DECK; b++) {
		for (let a = 0; a < b; a++, index++) {
			cards[index * 2] = a;
			cards[index * 2 + 1] = b;
		}
	}
	return cards;
})();

/**
 * Per-suit rank masks for every combination, four entries each.
 *
 * The evaluator takes four masks, so combining a hand with a board is four ORs.
 * Precomputing the hand half once removes it from the inner loop entirely.
 */
export const COMBO_LANES: Int32Array = (() => {
	const lanes = new Int32Array(COMBOS * 4);
	for (let combo = 0; combo < COMBOS; combo++) {
		const a = COMBO_CARDS[combo * 2];
		const b = COMBO_CARDS[combo * 2 + 1];
		lanes[combo * 4 + (a & 3)] |= 1 << (a >> 2);
		lanes[combo * 4 + (b & 3)] |= 1 << (b >> 2);
	}
	return lanes;
})();

/** Name a combination, e.g. "AsKh". */
export function formatCombo(combo: number): string {
	return formatCard(COMBO_CARDS[combo * 2 + 1]) + formatCard(COMBO_CARDS[combo * 2]);
}
