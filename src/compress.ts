/**
 * Range compression (issue #156): replace each player's range by a smaller,
 * re-weighted subset of its combinations that keeps the range's distribution
 * of equity on the flop, on every turn and on the river boards.
 *
 * Purpose: a solve's time and memory grow with the combinations in play, and
 * a range can lose a third to a half of them before the range as a whole
 * plays differently. The method is poker-rangecompress's, vendored in
 * `vendor/range-compress.js` (`scripts/vendor-range-compress.ts` copies it
 * in); what it costs under Lite is in `bench/range-compress`.
 *
 * What it keeps is how the range plays: how often it takes each action, and
 * how its strong, middling and weak parts act. What it does not keep is what
 * one combination does: a combination that is left out has no strategy, and
 * the ones kept carry the weight of those that were dropped.
 */

import { COMBO_CARDS, COMBOS, comboIndex, formatCard, formatCombo, parseCard, parseCards } from './cards.ts';
import { parseRange } from './range.ts';
import RangeCompress from './vendor/range-compress.js';
import type { WeightedHand } from './vendor/range-compress.d.ts';

/** How far {@link compressRanges} may go. */
export interface CompressRangesOptions {
	/**
	 * The most mismatch allowed: each range keeps the fewest combinations
	 * whose equity distributions stay this close to the original's, as a
	 * fraction of it. Default 0.01, which measured about one percentage
	 * point of difference in how often the range takes an action; 0.005 was
	 * indistinguishable from solving the full range again, 0.02 about two
	 * points.
	 */
	readonly tolerance?: number;
	/** Keep this many combinations of each range (or `[oop, ip]`) instead of working to `tolerance`. */
	readonly size?: number | readonly [number, number];
}

/** What {@link compressRanges} did to one range. */
export interface RangeCompression {
	/** Combinations with weight before, off the board and at or over `minWeight`. */
	readonly from: number;
	/** Combinations kept. */
	readonly to: number;
	/** The mismatch reached: 0 is identical. */
	readonly mismatch: number;
}

/** The compressed ranges of a spot, and what changed. */
export interface CompressedRanges {
	/** A weight per combination, the largest 1, indexed like `COMBO_CARDS`. */
	readonly oop: Float64Array;
	readonly ip: Float64Array;
	/** Out of position's range, then in position's. */
	readonly report: readonly [RangeCompression, RangeCompression];
}

/**
 * Compress both ranges of a flop spot, each against the other's full range.
 *
 * Combinations on the board and those under `minWeight` are left out first,
 * as `defineSpot` would. Ranges that are the same in every suit the flop
 * treats alike stay so, so the solver's suit symmetry still applies.
 *
 * @throws if the board is not a flop, or a range is empty
 */
export function compressRanges(
	config: { readonly board: string; readonly oop: string | Float64Array; readonly ip: string | Float64Array; readonly minWeight?: number },
	options: CompressRangesOptions = {},
): CompressedRanges {
	const board = parseCards(config.board);
	if (board.length !== 3) throw new Error(`Ranges are compressed for a flop; the board ${config.board} has ${board.length} cards`);
	const tolerance = options.tolerance ?? 0.01;
	if (!(tolerance > 0 && tolerance < 1)) throw new Error(`tolerance must be above 0 and under 1; got ${tolerance}`);
	const sizes = options.size === undefined ? undefined : typeof options.size === 'number' ? ([options.size, options.size] as const) : options.size;
	if (sizes && !sizes.every((n) => Number.isInteger(n) && n >= 2)) throw new Error(`size must be whole numbers of at least 2; got ${String(options.size)}`);

	const onBoard = new Set(board);
	const floor = config.minWeight ?? 0;
	const live = (range: string | Float64Array, who: string): WeightedHand[] => {
		const weights = typeof range === 'string' ? parseRange(range) : range;
		if (weights.length !== COMBOS) throw new Error(`The ${who} range has ${weights.length} weights; one per combination is ${COMBOS}`);
		const kept: number[] = [];
		let largest = 0;
		for (let combo = 0; combo < COMBOS; combo++) {
			const weight = weights[combo];
			if (!(weight > 0) || weight < floor) continue;
			if (onBoard.has(COMBO_CARDS[combo * 2]) || onBoard.has(COMBO_CARDS[combo * 2 + 1])) continue;
			kept.push(combo);
			if (weight > largest) largest = weight;
		}
		if (kept.length === 0) throw new Error(`The ${who} range is empty once the board's cards${floor > 0 ? ' and the combinations under minWeight' : ''} are removed`);
		// Only the weights' ratios matter; the largest at 1 keeps the
		// compressor's absolute tolerances meaningful for a range given on
		// any scale.
		return kept.map((combo) => ({ hand: formatCombo(combo), weight: weights[combo] / largest }));
	};
	const oop = live(config.oop, 'out-of-position');
	const ip = live(config.ip, 'in-position');
	let result: ReturnType<typeof RangeCompress.compressBoth>;
	try {
		result = RangeCompress.compressBoth({
			oop,
			ip,
			flop: board.map(formatCard).join(''),
			...(sizes ? { sizeOop: Math.min(sizes[0], oop.length), sizeIp: Math.min(sizes[1], ip.length) } : { tolerance }),
		});
	} finally {
		// Its WebAssembly memory, tens of MiB for wide ranges, would
		// otherwise stay resident beside the solve that follows.
		RangeCompress.releaseMemory();
	}
	const weightsOf = (hands: readonly WeightedHand[]): Float64Array => {
		const weights = new Float64Array(COMBOS);
		for (const { hand, weight } of hands) weights[comboIndex(parseCard(hand.slice(0, 2)), parseCard(hand.slice(2, 4)))] = weight;
		return weights;
	};
	return {
		oop: weightsOf(result.oop.hands),
		ip: weightsOf(result.ip.hands),
		report: [
			{ from: oop.length, to: result.oop.size, mismatch: result.oop.mismatch },
			{ from: ip.length, to: result.ip.size, mismatch: result.ip.mismatch },
		],
	};
}
