/**
 * Terminal-node value kernels.
 *
 * Purpose: the one place showdowns and folds become per-hand counterfactual
 * values, with exact card removal.
 *
 * Card removal is what makes this hard: two players cannot hold the same card,
 * so summing an opponent's range naively over-counts. Inclusion-exclusion over
 * the subsets of a hand's own cards fixes it exactly. With two hole cards there
 * are three subsets — each card alone, and the pair — so
 *
 *     blocked(hand) = S[a] + S[b] - S[{a,b}]
 *
 * where S[T] is the reach summed over hands containing every card of T. The
 * two-card term is indexed at `52 + combo`, because a combination IS its own
 * two-card subset.
 *
 * Showdown is two passes over strength-ordered hands: ascending accumulates
 * what each hand beats, descending what it loses to. Ties need no special case
 * — a hand's own tie group is committed only after the group is queried, so
 * equal-strength hands and the hand itself fall out of both sums.
 */

import { COMBO_CARDS, COMBO_LANES, COMBOS, DECK, suitLanes } from './cards.ts';
import { evaluate } from './eval7.ts';
import type { Runouts } from './runouts.ts';

/** Single-card sums occupy 0..51; the pair sum for combo c sits at 52 + c. */
const SUBSET_SPACE = DECK + COMBOS;

/**
 * Strength ordering, for each final board, of the combinations that matter.
 *
 * Runouts are ordered, but a showdown only sees the five cards: from a flop,
 * turn X then river Y and turn Y then river X are one board. Each distinct
 * board gets one row, and `row` maps every runout onto it, which halves the
 * table and the hand evaluations that build it.
 */
export interface ShowdownTable {
	/** Final-round runouts this covers. */
	readonly boards: number;
	/** Distinct final boards. */
	readonly rows: number;
	/** Row of each final-round runout. */
	readonly row: Int32Array;
	/** Entries reserved per row: the size of the two ranges' union. */
	readonly stride: number;
	/** `rows * stride`: live combinations, ascending by strength. */
	readonly order: Uint16Array;
	/**
	 * `rows * stride * 2`: the two cards of each entry of `order`, beside it,
	 * so the kernels read them in sequence rather than through the combination.
	 */
	readonly cards: Uint8Array;
	/** Live combinations per row. */
	readonly liveCount: Uint16Array;
	/** `rows * (stride + 1)`: tie-group boundaries into `order`. */
	readonly groupStart: Uint16Array;
	/** Tie groups per row. */
	readonly groupCount: Uint16Array;
	readonly bytes: number;
}

/** Reusable buffers, so the hot loop never allocates. */
export interface TerminalScratch {
	readonly weaker: Float64Array;
	readonly stronger: Float64Array;
	readonly all: Float64Array;
	readonly win: Float64Array;
}

/** Allocate terminal-kernel scratch. */
export function makeTerminalScratch(): TerminalScratch {
	return {
		weaker: new Float64Array(SUBSET_SPACE),
		stronger: new Float64Array(SUBSET_SPACE),
		all: new Float64Array(SUBSET_SPACE),
		win: new Float64Array(COMBOS),
	};
}

/**
 * Rank the combinations that matter, on every final board.
 *
 * Only hands in one of the two ranges are ranked. A board leaves about 1081 of
 * the 1326 combinations playable, but a real range holds a few hundred at most,
 * and the rest carry zero reach forever — ranking them is pure waste, and it
 * dominated the solve before this was restricted.
 *
 * @param runouts board completions
 * @param relevant combinations in either range; all of them if omitted
 */
export function buildShowdownTable(runouts: Runouts, relevant?: Uint8Array): ShowdownTable {
	const round = runouts.rounds - 1;
	const boards = runouts.counts[round];
	const width = runouts.width[round];
	const boardCards = runouts.cards[round];

	const wanted: number[] = [];
	for (let combo = 0; combo < COMBOS; combo++) {
		if (!relevant || relevant[combo]) wanted.push(combo);
	}
	const stride = Math.max(1, wanted.length);

	// One row per distinct set of five cards, in order of first appearance.
	const row = new Int32Array(boards);
	const firstOf = new Map<number, number>();
	const firsts: number[] = [];
	for (let board = 0; board < boards; board++) {
		let mask = 0;
		// Two 26-bit halves keep the key an exact double.
		let high = 0;
		for (let i = 0; i < width; i++) {
			const card = boardCards[board * width + i];
			if (card < 26) mask += 2 ** card;
			else high += 2 ** (card - 26);
		}
		const key = high * 2 ** 26 + mask;
		const seen = firstOf.get(key);
		if (seen === undefined) {
			firstOf.set(key, firsts.length);
			row[board] = firsts.length;
			firsts.push(board);
		} else {
			row[board] = seen;
		}
	}
	const rows = firsts.length;

	const order = new Uint16Array(rows * stride);
	const cards = new Uint8Array(rows * stride * 2);
	const liveCount = new Uint16Array(rows);
	const groupStart = new Uint16Array(rows * (stride + 1));
	const groupCount = new Uint16Array(rows);

	const lanes = new Int32Array(4);
	const onBoard = new Uint8Array(DECK);
	const strength = new Int32Array(COMBOS);
	const live = new Uint16Array(COMBOS);

	for (let r = 0; r < rows; r++) {
		const base = firsts[r] * width;
		onBoard.fill(0);
		for (let i = 0; i < width; i++) onBoard[boardCards[base + i]] = 1;
		suitLanes(boardCards.subarray(base, base + width), lanes);
		const b0 = lanes[0];
		const b1 = lanes[1];
		const b2 = lanes[2];
		const b3 = lanes[3];

		let count = 0;
		for (const combo of wanted) {
			if (onBoard[COMBO_CARDS[combo * 2]] || onBoard[COMBO_CARDS[combo * 2 + 1]]) continue;
			const lane = combo * 4;
			strength[combo] = evaluate(
				COMBO_LANES[lane] | b0,
				COMBO_LANES[lane + 1] | b1,
				COMBO_LANES[lane + 2] | b2,
				COMBO_LANES[lane + 3] | b3,
			);
			live[count++] = combo;
		}

		const slice = live.subarray(0, count);
		slice.sort((x, y) => strength[x] - strength[y]);
		order.set(slice, r * stride);
		for (let i = 0; i < count; i++) {
			cards[(r * stride + i) * 2] = COMBO_CARDS[slice[i] * 2];
			cards[(r * stride + i) * 2 + 1] = COMBO_CARDS[slice[i] * 2 + 1];
		}
		liveCount[r] = count;

		const groupBase = r * (stride + 1);
		let groups = 0;
		let i = 0;
		while (i < count) {
			groupStart[groupBase + groups] = i;
			const value = strength[slice[i]];
			while (i < count && strength[slice[i]] === value) i++;
			groups++;
		}
		groupStart[groupBase + groups] = count;
		groupCount[r] = groups;
	}

	return {
		boards,
		rows,
		row,
		stride,
		order,
		cards,
		liveCount,
		groupStart,
		groupCount,
		bytes:
			row.byteLength + order.byteLength + cards.byteLength + liveCount.byteLength +
			groupStart.byteLength + groupCount.byteLength,
	};
}

/**
 * Counterfactual values at a showdown, exact under card removal.
 *
 * @param reach opponent reach per combination
 * @param table strength ordering
 * @param board final-round board index
 * @param payoff chips the winner gains, i.e. each player's contribution
 * @param scratch reusable buffers
 * @param out destination of length COMBOS; fully overwritten
 */
export function showdownValues(
	reach: Float64Array,
	table: ShowdownTable,
	board: number,
	payoff: number,
	scratch: TerminalScratch,
	out: Float64Array,
): void {
	const { weaker, stronger, win } = scratch;
	// Reading an imported const crosses a module binding on every access, which
	// in a loop this tight costs more than the arithmetic. Hoist them.
	const deck = DECK;
	const order = table.order;
	const cards = table.cards;
	const starts = table.groupStart;
	const row = table.row[board];
	const orderBase = row * table.stride;
	const groupBase = row * (table.stride + 1);
	const groups = table.groupCount[row];
	const live = table.liveCount[row];

	// Only the live entries are ever read, so clearing all 1326 would be waste
	// proportional to how narrow the ranges are.
	for (let i = 0; i < live; i++) out[order[orderBase + i]] = 0;
	if (live === 0) return;

	let running = 0;
	for (let g = 0; g < groups; g++) {
		const from = orderBase + starts[groupBase + g];
		const to = orderBase + starts[groupBase + g + 1];
		for (let i = from; i < to; i++) {
			const combo = order[i];
			win[combo] = running - (weaker[cards[i * 2]] + weaker[cards[i * 2 + 1]] - weaker[deck + combo]);
		}
		for (let i = from; i < to; i++) {
			const combo = order[i];
			const value = reach[combo];
			if (value === 0) continue;
			running += value;
			weaker[cards[i * 2]] += value;
			weaker[cards[i * 2 + 1]] += value;
			weaker[deck + combo] += value;
		}
	}

	running = 0;
	for (let g = groups - 1; g >= 0; g--) {
		const from = orderBase + starts[groupBase + g];
		const to = orderBase + starts[groupBase + g + 1];
		for (let i = from; i < to; i++) {
			const combo = order[i];
			const lose = running - (stronger[cards[i * 2]] + stronger[cards[i * 2 + 1]] - stronger[deck + combo]);
			out[combo] = payoff * (win[combo] - lose);
		}
		for (let i = from; i < to; i++) {
			const combo = order[i];
			const value = reach[combo];
			if (value === 0) continue;
			running += value;
			stronger[cards[i * 2]] += value;
			stronger[cards[i * 2 + 1]] += value;
			stronger[deck + combo] += value;
		}
	}

	// Leave the accumulators as they were found, so the next call needs no
	// clearing pass of its own. Only hands with reach ever touched them, and
	// late in a solve most have none.
	for (let i = orderBase; i < orderBase + live; i++) {
		const combo = order[i];
		if (reach[combo] === 0) continue;
		weaker[cards[i * 2]] = 0;
		weaker[cards[i * 2 + 1]] = 0;
		weaker[deck + combo] = 0;
		stronger[cards[i * 2]] = 0;
		stronger[cards[i * 2 + 1]] = 0;
		stronger[deck + combo] = 0;
	}
}

/**
 * Counterfactual values at a fold, exact under card removal.
 *
 * @param reach opponent reach per combination
 * @param live combinations not blocked by the board
 * @param liveCount entries in `live`
 * @param payoff signed chips the traverser gains
 * @param scratch reusable buffers
 * @param out destination of length COMBOS; fully overwritten
 */
export function foldValues(
	reach: Float64Array,
	live: Uint16Array,
	liveCount: number,
	payoff: number,
	scratch: TerminalScratch,
	out: Float64Array,
): void {
	const sums = scratch.all;
	const cards = COMBO_CARDS;
	const deck = DECK;

	for (let i = 0; i < liveCount; i++) out[live[i]] = 0;
	if (liveCount === 0) return;

	let total = 0;
	for (let i = 0; i < liveCount; i++) {
		const combo = live[i];
		const value = reach[combo];
		if (value === 0) continue;
		total += value;
		sums[cards[combo * 2]] += value;
		sums[cards[combo * 2 + 1]] += value;
		sums[deck + combo] += value;
	}
	for (let i = 0; i < liveCount; i++) {
		const combo = live[i];
		const a = cards[combo * 2];
		const b = cards[combo * 2 + 1];
		out[combo] = payoff * (total - (sums[a] + sums[b] - sums[deck + combo]));
	}
	for (let i = 0; i < liveCount; i++) {
		const combo = live[i];
		if (reach[combo] === 0) continue;
		sums[cards[combo * 2]] = 0;
		sums[cards[combo * 2 + 1]] = 0;
		sums[deck + combo] = 0;
	}
}
