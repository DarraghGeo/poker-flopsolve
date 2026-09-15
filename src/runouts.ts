/**
 * Board completions.
 *
 * Purpose: the one place the cards still to come are enumerated and indexed.
 *
 * The board is given, so unlike a from-scratch solver there is nothing to deal
 * before the first betting round. What remains is the turn, the river, or
 * neither. Completions are ORDERED — the turn is known when turn betting
 * happens, so `Kh` then `2c` is a different line from `2c` then `Kh`, even
 * though the final board is the same.
 *
 * Indexing mirrors the solver it is ported from: every board at one round has
 * the same number of children, so
 *     child = parent * childFactor[round] + local
 * which keeps indices dense and lets a worker own a contiguous slice.
 */

import { DECK, formatCards } from './cards.ts';

/** Boards visible at each betting round. */
export interface Runouts {
	/** Betting rounds: 3 from a flop, 2 from a turn, 1 from a river. */
	readonly rounds: number;
	/** Cards on the board at each round: 3, 4, 5. */
	readonly width: readonly number[];
	/** Distinct boards at each round; always 1 at round 0. */
	readonly counts: readonly number[];
	/** Flat board cards per round, `counts[r] * width[r]` entries. */
	readonly cards: readonly Uint8Array[];
	/** `counts[r] / counts[r-1]`; 1 at round 0. */
	readonly childFactor: readonly number[];
	/** The board as given. */
	readonly initial: readonly number[];
}

/**
 * Enumerate every way the given board can complete.
 *
 * @param board 3, 4 or 5 distinct cards
 * @throws if the board is not a legal postflop board
 */
export function enumerateRunouts(board: readonly number[]): Runouts {
	if (board.length < 3 || board.length > 5) {
		throw new Error(`A postflop board has 3, 4 or 5 cards; got ${board.length} (${formatCards(board)})`);
	}
	if (new Set(board).size !== board.length) {
		throw new Error(`Board repeats a card: ${formatCards(board)}`);
	}

	const rounds = 5 - board.length + 1;
	const width: number[] = [];
	const counts: number[] = [];
	const cards: Uint8Array[] = [];
	const childFactor: number[] = [1];

	// Round 0 is the board exactly as given.
	width.push(board.length);
	counts.push(1);
	cards.push(Uint8Array.from(board));

	const used = new Uint8Array(DECK);
	for (const card of board) used[card] = 1;

	for (let round = 1; round < rounds; round++) {
		const previousWidth = width[round - 1];
		const previousCount = counts[round - 1];
		const previousCards = cards[round - 1];
		const thisWidth = previousWidth + 1;

		// Every parent has the same number of children: one per card not yet
		// on that particular board.
		const factor = DECK - previousWidth;
		const count = previousCount * factor;
		const level = new Uint8Array(count * thisWidth);

		for (let parent = 0; parent < previousCount; parent++) {
			used.fill(0);
			const parentBase = parent * previousWidth;
			for (let i = 0; i < previousWidth; i++) used[previousCards[parentBase + i]] = 1;

			let local = 0;
			for (let card = 0; card < DECK; card++) {
				if (used[card]) continue;
				const target = (parent * factor + local) * thisWidth;
				for (let i = 0; i < previousWidth; i++) level[target + i] = previousCards[parentBase + i];
				level[target + previousWidth] = card;
				local++;
			}
		}

		width.push(thisWidth);
		counts.push(count);
		cards.push(level);
		childFactor.push(factor);
	}

	return { rounds, width, counts, cards, childFactor, initial: [...board] };
}

/**
 * Map a board index back to its ancestor at an earlier round.
 *
 * @param childFactor per-round factors
 * @param board board index at `round`
 * @param round that board's round
 * @param target the earlier round wanted
 */
export function boardAtRound(
	childFactor: readonly number[],
	board: number,
	round: number,
	target: number,
): number {
	let index = board;
	for (let r = round; r > target; r--) index = (index / childFactor[r]) | 0;
	return index;
}
