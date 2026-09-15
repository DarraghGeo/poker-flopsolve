/**
 * Weighted range parsing.
 *
 * Purpose: the one place range notation becomes solver input.
 *
 * A range is a dense `Float64Array` of 1326 weights, one per two-card
 * combination, in the same colex order the solver indexes by. Weights rather
 * than membership: a solver range is routinely partial ("call 40% of these"),
 * and every downstream reach vector is a weight anyway.
 *
 * The notation follows common usage:
 *
 *   AA  KK-99  22+            pairs, ranges and "and better"
 *   AKs  A2s+  A5s-A2s        suited
 *   AKo  KTo+                 offsuit
 *   AK                        both suited and offsuit
 *   AsKh                      one exact combination
 *   Ax  AXs  AXo              any second card, optionally constrained
 *   random                    everything
 *   AKo:0.5                   any of the above at a partial weight
 *
 * `Xo` forms include the pair, because a pair is not suited; `Xs` forms do not.
 */

import { cardOf, comboIndex, COMBOS, parseCard, SUITS } from './cards.ts';

/** Rank characters, highest first, as written in notation. */
const RANK_CHARS = 'AKQJT98765432';

/** Rank index from its character, 12 = ace down to 0 = deuce. */
function rankOfChar(char: string): number {
	const index = RANK_CHARS.indexOf(char.toUpperCase());
	if (index < 0) throw new Error(`Invalid rank "${char}"`);
	return 12 - index;
}

/** Every combination of a pocket pair: `C(4,2)` = 6. */
function pairCombos(rank: number, out: number[]): void {
	for (let a = 0; a < SUITS; a++) {
		for (let b = a + 1; b < SUITS; b++) out.push(comboIndex(cardOf(rank, a), cardOf(rank, b)));
	}
}

/** Every suited combination of two ranks: 4. */
function suitedCombos(high: number, low: number, out: number[]): void {
	for (let suit = 0; suit < SUITS; suit++) out.push(comboIndex(cardOf(high, suit), cardOf(low, suit)));
}

/** Every offsuit combination of two ranks: 12. */
function offsuitCombos(high: number, low: number, out: number[]): void {
	for (let a = 0; a < SUITS; a++) {
		for (let b = 0; b < SUITS; b++) {
			if (a !== b) out.push(comboIndex(cardOf(high, a), cardOf(low, b)));
		}
	}
}

/** Inclusive rank span, in either written order. */
function ranksBetween(a: number, b: number): number[] {
	const lo = Math.min(a, b);
	const hi = Math.max(a, b);
	const ranks: number[] = [];
	for (let r = lo; r <= hi; r++) ranks.push(r);
	return ranks;
}

/** Expand one notation segment, without its weight, to combination indices. */
function expand(segment: string): number[] {
	const out: number[] = [];
	const text = segment.trim();
	if (!text) return out;

	if (/^(random|any|100%)$/i.test(text)) {
		for (let combo = 0; combo < COMBOS; combo++) out.push(combo);
		return out;
	}

	// An exact combination, e.g. AsKh.
	if (/^([AKQJT2-9][shdc]){2}$/i.test(text)) {
		const a = parseCard(text.slice(0, 2));
		const b = parseCard(text.slice(2, 4));
		if (a === b) throw new Error(`"${text}" uses the same card twice`);
		out.push(comboIndex(a, b));
		return out;
	}

	// Any second card: Ax, AXs, AXo.
	const wildcard = /^([AKQJT2-9])[xX]([so])?$/.exec(text);
	if (wildcard) {
		const rank = rankOfChar(wildcard[1]);
		const kind = wildcard[2]?.toLowerCase();
		for (let other = 0; other < 13; other++) {
			if (other === rank) {
				// A pair is not suited, so it belongs to the offsuit and
				// unqualified forms only.
				if (kind !== 's') pairCombos(rank, out);
				continue;
			}
			const high = Math.max(rank, other);
			const low = Math.min(rank, other);
			if (kind !== 'o') suitedCombos(high, low, out);
			if (kind !== 's') offsuitCombos(high, low, out);
		}
		return out;
	}

	const emit = (high: number, low: number, kind: string | undefined): void => {
		if (high === low) {
			pairCombos(high, out);
			return;
		}
		if (kind !== 'o') suitedCombos(high, low, out);
		if (kind !== 's') offsuitCombos(high, low, out);
	};

	// A span, e.g. KK-99 or A5s-A2s.
	const span = /^([AKQJT2-9])([AKQJT2-9])([so])?-([AKQJT2-9])([AKQJT2-9])([so])?$/.exec(text);
	if (span) {
		const [, a1, a2, k1, b1, b2, k2] = span;
		const kind = k1 ?? k2;
		if (k1 && k2 && k1 !== k2) throw new Error(`"${text}" mixes suited and offsuit`);

		const from1 = rankOfChar(a1);
		const from2 = rankOfChar(a2);
		const to1 = rankOfChar(b1);
		const to2 = rankOfChar(b2);

		if (from1 === from2 && to1 === to2) {
			for (const rank of ranksBetween(from1, to1)) pairCombos(rank, out);
			return out;
		}
		if (from1 !== to1) throw new Error(`"${text}" must hold its higher rank fixed, e.g. A5s-A2s`);
		for (const low of ranksBetween(from2, to2)) {
			if (low === from1) continue;
			emit(Math.max(from1, low), Math.min(from1, low), kind);
		}
		return out;
	}

	// "And better", e.g. 22+, A2s+, KTo+.
	const plus = /^([AKQJT2-9])([AKQJT2-9])([so])?\+$/.exec(text);
	if (plus) {
		const first = rankOfChar(plus[1]);
		const second = rankOfChar(plus[2]);
		const kind = plus[3]?.toLowerCase();

		if (first === second) {
			// Pairs climb to aces.
			for (let rank = first; rank <= 12; rank++) pairCombos(rank, out);
			return out;
		}
		// Non-pairs climb the lower card to just under the higher one.
		const high = Math.max(first, second);
		const from = Math.min(first, second);
		for (let low = from; low < high; low++) emit(high, low, kind);
		return out;
	}

	// A single class, e.g. AA, AKs, AKo, AK.
	const single = /^([AKQJT2-9])([AKQJT2-9])([so])?$/.exec(text);
	if (single) {
		const first = rankOfChar(single[1]);
		const second = rankOfChar(single[2]);
		const kind = single[3]?.toLowerCase();
		if (first === second && kind === 's') throw new Error(`"${text}" is impossible: a pair cannot be suited`);
		emit(Math.max(first, second), Math.min(first, second), kind);
		return out;
	}

	throw new Error(`Unrecognised range notation: "${segment.trim()}"`);
}

/**
 * Parse range notation into per-combination weights.
 *
 * Repeating a combination keeps the LAST weight given, so a narrowing segment
 * can follow a broad one: `random:0.1, AA:1` is a light range with pure aces.
 *
 * @param notation comma-separated segments, each optionally `:weight`
 * @returns weights indexed by combination, length 1326
 */
export function parseRange(notation: string): Float64Array {
	const weights = new Float64Array(COMBOS);
	if (!notation || !notation.trim()) return weights;

	for (const segment of notation.split(',')) {
		if (!segment.trim()) continue;
		const [body, weightText] = segment.split(':');
		let weight = 1;
		if (weightText !== undefined) {
			weight = Number(weightText.trim().replace('%', '')) / (weightText.includes('%') ? 100 : 1);
			if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
				throw new Error(`Weight in "${segment.trim()}" must be between 0 and 1`);
			}
		}
		for (const combo of expand(body)) weights[combo] = weight;
	}
	return weights;
}

/** Combinations carrying any weight. */
export function activeCombos(weights: Float64Array): number[] {
	const combos: number[] = [];
	for (let combo = 0; combo < COMBOS; combo++) if (weights[combo] > 0) combos.push(combo);
	return combos;
}

/** Total weight, i.e. combinations counted with their weight. */
export function rangeWeight(weights: Float64Array): number {
	let total = 0;
	for (let combo = 0; combo < COMBOS; combo++) total += weights[combo];
	return total;
}
