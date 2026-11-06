/**
 * Card relabellings, and the symmetries of a spot.
 *
 * Purpose: the one place a runout is identified with another.
 *
 * A map relabels cards — and with them every combination — so that a subgame
 * after one card can stand for the subgame after another. For a suit
 * permutation that fixes the board and both ranges this is exact: the two
 * subgames are mirror images, so solving one solves both. Later abstractions
 * (rank relabellings) reuse the same table and accept an approximation.
 *
 * Map 0 is always the identity.
 */

import { COMBO_CARDS, COMBOS, comboIndex, DECK } from './cards.ts';

/** Every relabelling in use, each as a card map and the combination map it induces. */
export class CardMaps {
	/** `card[m][x]`: what map `m` sends card `x` to. */
	readonly card: Uint8Array[] = [];
	/** `combo[m][h]`: what map `m` sends combination `h` to. */
	readonly combo: Uint16Array[] = [];
	private readonly known = new Map<string, number>();

	constructor() {
		const identity = new Uint8Array(DECK);
		for (let card = 0; card < DECK; card++) identity[card] = card;
		this.add(identity);
	}

	/** Register a card map, returning its id; the same map always gets the same id. */
	add(cardMap: Uint8Array): number {
		const key = cardMap.join(',');
		const existing = this.known.get(key);
		if (existing !== undefined) return existing;
		const combo = new Uint16Array(COMBOS);
		for (let h = 0; h < COMBOS; h++) {
			combo[h] = comboIndex(cardMap[COMBO_CARDS[h * 2]], cardMap[COMBO_CARDS[h * 2 + 1]]);
		}
		const id = this.card.length;
		this.card.push(Uint8Array.from(cardMap));
		this.combo.push(combo);
		this.known.set(key, id);
		return id;
	}

	/** The map that applies `first`, then `second`. */
	then(first: number, second: number): number {
		const a = this.card[first];
		const b = this.card[second];
		const out = new Uint8Array(DECK);
		for (let card = 0; card < DECK; card++) out[card] = b[a[card]];
		return this.add(out);
	}

	/** The inverse of a map, which must be a bijection. */
	inverse(id: number): number {
		const a = this.card[id];
		const out = new Uint8Array(DECK);
		for (let card = 0; card < DECK; card++) out[a[card]] = card;
		return this.add(out);
	}
}

/** All 24 orderings of the four suits, identity first. */
function suitPermutations(): number[][] {
	const out: number[][] = [];
	const walk = (prefix: number[]): void => {
		if (prefix.length === 4) {
			out.push(prefix);
			return;
		}
		for (let s = 0; s < 4; s++) if (!prefix.includes(s)) walk([...prefix, s]);
	};
	walk([]);
	return out;
}

/** The card map of a suit permutation; cards are `rank * 4 + suit`. */
function suitMap(perm: readonly number[]): Uint8Array {
	const out = new Uint8Array(DECK);
	for (let card = 0; card < DECK; card++) out[card] = (card & ~3) | perm[card & 3];
	return out;
}

/**
 * The suit permutations that leave a spot unchanged: they fix the board as a
 * set and map each range onto itself, weight for weight.
 *
 * Returned as card maps, identity first. Ranges are compared exactly, so a
 * range that differs between suits anywhere — an exact combination such as
 * `AsKh`, or a fractional weight on one suit — breaks that symmetry, and the
 * spot is solved as it would be without any.
 *
 * @param board the board as given
 * @param ranges each player's weights, board cards already removed
 */
export function suitSymmetries(board: readonly number[], ranges: readonly Float64Array[]): Uint8Array[] {
	const onBoard = new Uint8Array(DECK);
	for (const card of board) onBoard[card] = 1;
	const out: Uint8Array[] = [];
	for (const perm of suitPermutations()) {
		const map = suitMap(perm);
		let ok = true;
		for (const card of board) if (!onBoard[map[card]]) ok = false;
		for (let h = 0; ok && h < COMBOS; h++) {
			const image = comboIndex(map[COMBO_CARDS[h * 2]], map[COMBO_CARDS[h * 2 + 1]]);
			for (const weights of ranges) {
				if (weights[h] !== weights[image]) {
					ok = false;
					break;
				}
			}
		}
		if (ok) out.push(map);
	}
	return out;
}
