/**
 * Range compression (issue #156): replace each player's range by a smaller,
 * re-weighted subset of its combinations that keeps the range's distribution
 * of equity on the board and on every board that can follow it. A spot that
 * starts on the river has no board to follow, and there the subset also
 * keeps what each of the other player's hands faces: how much of the range
 * beats it, ties it and loses to it (issue #158).
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
 *
 * `rebuildRanges` puts the combinations left out back at a later street
 * (issue #173): each takes the play of the kept combination nearest to it
 * up to there, and a solve from the rebuilt ranges gives every one a
 * strategy of its own from there on.
 */

import { COMBO_CARDS, COMBOS, comboIndex, formatCard, formatCombo, parseCard, parseCards } from './cards.ts';
import type { Solution } from './index.ts';
import { parseRange } from './range.ts';
import RangeCompress from './vendor/range-compress.js';
import type { WeightedHand } from './vendor/range-compress.d.ts';

/** How far {@link compressRanges} may go. */
export interface CompressRangesOptions {
	/**
	 * The most mismatch allowed: each range keeps the fewest combinations
	 * whose equity distributions stay this close to the original's, as a
	 * fraction of it. Default 0.01 on a flop, which measured about one
	 * percentage point of difference in how often the range takes an
	 * action; 0.005 was indistinguishable from solving the full range
	 * again, 0.02 about two points. Default 0.005 on a spot that starts on
	 * the turn or the river: under Lite the root play was 0.5–2.6 points
	 * off there at 0.005 and up to 7.8 at 0.01 (`bench/range-compress`).
	 */
	readonly tolerance?: number;
	/** Keep this many combinations of each range (or `[oop, ip]`) instead of working to `tolerance`. */
	readonly size?: number | readonly [number, number];
	/**
	 * Also say which kept combinations each one plays most like
	 * (`CompressedRanges.standIns`), which `rebuildRanges` needs. About
	 * 15 ms more. Default off.
	 */
	readonly standIns?: boolean;
}

/** How many stand-ins `CompressedRanges.standIns` lists for each combination. */
export const STAND_INS = 4;

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
	/**
	 * With the `standIns` option, for each player: the kept combinations
	 * every combination of the range plays most like, nearest first, as
	 * `STAND_INS` combination indices from `combo * STAND_INS`; a kept
	 * combination comes first in its own list. -1 where there are fewer,
	 * and throughout for a combination the range does not hold. "Nearest"
	 * is by equity on the boards one card on (every turn of a flop).
	 */
	readonly standIns?: readonly [Int16Array, Int16Array];
}

/**
 * Compress both ranges of a spot, each against the other's full range. The
 * board is where the spot starts: a flop, a flop and turn, or all five cards.
 * Give the ranges the players hold there.
 *
 * Combinations on the board and those under `minWeight` are left out first,
 * as `defineSpot` would. Ranges that are the same in every suit the board
 * treats alike stay so, so the solver's suit symmetry still applies.
 *
 * @throws if the board is not 3, 4 or 5 cards, or a range is empty
 */
export function compressRanges(
	config: { readonly board: string; readonly oop: string | Float64Array; readonly ip: string | Float64Array; readonly minWeight?: number },
	options: CompressRangesOptions = {},
): CompressedRanges {
	const board = parseCards(config.board);
	if (board.length < 3 || board.length > 5) throw new Error(`A board has 3, 4 or 5 cards; got ${config.board}`);
	const tolerance = options.tolerance ?? (board.length === 3 ? 0.01 : 0.005);
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
			board: board.map(formatCard).join(''),
			...(sizes ? { sizeOop: Math.min(sizes[0], oop.length), sizeIp: Math.min(sizes[1], ip.length) } : { tolerance }),
			...(options.standIns ? { standIns: STAND_INS } : {}),
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
	const comboOf = (hand: string): number => comboIndex(parseCard(hand.slice(0, 2)), parseCard(hand.slice(2, 4)));
	const standInsOf = (lists: Readonly<Record<string, readonly string[]>> | null): Int16Array => {
		if (!lists) throw new Error('The compressor returned no stand-ins');
		const out = new Int16Array(COMBOS * STAND_INS).fill(-1);
		for (const [hand, list] of Object.entries(lists)) {
			const at = comboOf(hand) * STAND_INS;
			for (let k = 0; k < list.length && k < STAND_INS; k++) out[at + k] = comboOf(list[k]);
		}
		return out;
	};
	return {
		oop: weightsOf(result.oop.hands),
		ip: weightsOf(result.ip.hands),
		report: [
			{ from: oop.length, to: result.oop.size, mismatch: result.oop.mismatch },
			{ from: ip.length, to: result.ip.size, mismatch: result.ip.mismatch },
		],
		...(options.standIns ? { standIns: [standInsOf(result.oop.standIns), standInsOf(result.ip.standIns)] as const } : {}),
	};
}

/**
 * The least share of its weight a combination keeps in `rebuildRanges`, so
 * that one whose stand-in never takes the line is still there to be given a
 * strategy. It kept 0.4% of the true weight that would otherwise have gone,
 * and moved the rebuilt ranges by 0.1%.
 */
const REBUILD_FLOOR = 0.005;

/**
 * The ranges of `source` as they stand at a node of a solve of its
 * compressed ranges, every combination of `source` back in.
 *
 * A compressed solve reaches a later street holding only the combinations
 * it kept. Here each combination of the original range gets its own weight
 * times the share of its stand-in that came this way: the stand-in's reach at
 * the node over its starting weight. A stand-in that holds a card dealt
 * before the node's street has no play of its own on the way, so the next
 * nearest that does not is used. Solve the subgame from the result
 * (`resolveSubgame`'s `ranges`) and every combination has a strategy of its
 * own from there on; up to the node its play is still its stand-in's.
 *
 * Measured on four flops and 36 turn spots against the turn solved from a
 * full solve's ranges (another solver, one bet size, tolerance 0.01): a
 * rebuilt hand's play differed by 5.1 points where two solves of the same
 * ranges differ by 3.2, and played with the true ranges it gave up 0.07% of
 * the pot against the true opponent (0.05%) and was 1.15% exploitable
 * (0.26%). A fifth of the range arrives with a weight more than a quarter
 * off. That is the node's street and after. Over the whole hand, on the one
 * flop scored, the strategy gave up 0.06% of the pot against a reference
 * opponent and was 6.3% exploitable: play borrowed up to the node is sound
 * but not balanced hand by hand.
 *
 * @param source the spot whose ranges were compressed
 * @param compressed `compressRanges(source, { standIns: true })`
 * @param solution a solve of the compressed ranges, on any betting
 * @param node a decision that opens a betting round after the first
 * @param board the board index at that node's round
 * @returns out of position's weights, then in position's, the largest 1; combinations on the node's board are still in
 * @throws if `compressed` has no stand-ins, or `solution` is not of those ranges
 */
export function rebuildRanges(
	source: { readonly board: string; readonly oop: string | Float64Array; readonly ip: string | Float64Array; readonly minWeight?: number },
	compressed: CompressedRanges,
	solution: Solution,
	node: number,
	board: number,
): [Float64Array, Float64Array] {
	const { standIns } = compressed;
	if (!standIns) throw new Error('rebuildRanges needs the stand-ins: compressRanges(source, { standIns: true })');
	const { spot } = solution;
	const round = spot.tree.round[node];
	const width = spot.runouts.width[round];
	// Cards dealt before the node's street: a kept combination holding one
	// has no strategy at the decisions in between.
	const dealt = spot.runouts.cards[round].subarray(board * width + spot.runouts.width[0], board * width + width - 1);
	const dead = (combo: number): boolean => dealt.includes(COMBO_CARDS[combo * 2]) || dealt.includes(COMBO_CARDS[combo * 2 + 1]);
	const one = (player: 0 | 1): Float64Array => {
		const given = player === 0 ? source.oop : source.ip;
		const weights = typeof given === 'string' ? parseRange(given) : given;
		const start = spot.players[player].weights;
		const kept = player === 0 ? compressed.oop : compressed.ip;
		for (let combo = 0; combo < COMBOS; combo++) {
			if (kept[combo] > 0 !== start[combo] > 0) throw new Error('rebuildRanges: the solution is not a solve of these compressed ranges');
		}
		const reach = solution.reachAt(node, board, player);
		const map = standIns[player];
		const out = new Float64Array(COMBOS);
		let largest = 0;
		for (let combo = 0; combo < COMBOS; combo++) {
			if (map[combo * STAND_INS] < 0) continue;
			let share = 0;
			for (let k = 0; k < STAND_INS; k++) {
				const standIn = map[combo * STAND_INS + k];
				if (standIn < 0) break;
				if (dead(standIn)) continue;
				share = Math.min(1, reach[standIn] / start[standIn]);
				break;
			}
			out[combo] = weights[combo] * Math.max(REBUILD_FLOOR, share);
			if (out[combo] > largest) largest = out[combo];
		}
		if (!(largest > 0)) throw new Error('rebuildRanges: the range has no weight left at this node');
		for (let combo = 0; combo < COMBOS; combo++) out[combo] /= largest;
		return out;
	};
	return [one(0), one(1)];
}
