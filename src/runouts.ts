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
 * Boards at a round are stored densely and grouped by parent, so the children
 * of one board are a contiguous range and a worker can own a contiguous slice.
 *
 * Suit symmetry folds mirror-image deals together: on a two-tone flop a club
 * turn is a diamond turn with the suits swapped, so only one is stored, and it
 * stands for both. `orbitStart` and friends record which real deals each
 * stored board stands for and how to relabel hands onto it.
 */

import { CardMaps } from './abstraction.ts';
import { DECK, formatCards } from './cards.ts';

/** Boards visible at each betting round. */
export interface Runouts {
	/** Betting rounds: 3 from a flop, 2 from a turn, 1 from a river. */
	readonly rounds: number;
	/** Cards on the board at each round: 3, 4, 5. */
	readonly width: readonly number[];
	/** Distinct boards stored at each round; always 1 at round 0. */
	readonly counts: readonly number[];
	/** Flat board cards per round, `counts[r] * width[r]` entries. */
	readonly cards: readonly Uint8Array[];
	/**
	 * Children of each board, as a prefix: the boards at round `r` dealt from
	 * board `p` of round `r - 1` are `childStart[r][p]` to
	 * `childStart[r][p + 1]`. Empty at round 0.
	 */
	readonly childStart: readonly Int32Array[];
	/** Each board's parent at the round before; -1 at round 0. */
	readonly parent: readonly Int32Array[];
	/**
	 * The real deals each stored board stands for, as a prefix into
	 * `orbitMap`/`orbitCard`: board `b` of round `r` stands for members
	 * `orbitStart[r][b]` to `orbitStart[r][b + 1]`. Member 0 is the board
	 * itself under the identity. Another member is a card that could have been
	 * dealt instead, with the map that sends it — and every combination with
	 * it — onto this board; the map fixes the parent board. Without symmetry
	 * every board stands only for itself.
	 */
	readonly orbitStart: readonly Int32Array[];
	readonly orbitMap: readonly Int32Array[];
	readonly orbitCard: readonly Uint8Array[];
	/**
	 * The symmetries each stored board still has, as a prefix into
	 * `stabiliserMap`: map ids, identity first. A board with more than the
	 * identity holds hands that mirror each other on it, whose strategies the
	 * solver keeps tied together.
	 */
	readonly stabiliserStart: readonly Int32Array[];
	readonly stabiliserMap: readonly Int32Array[];
	/** The relabellings `orbitMap` refers to. */
	readonly maps: CardMaps;
	/** Whether any board stands for more than itself. */
	readonly symmetric: boolean;
	/** The board as given. */
	readonly initial: readonly number[];
}

/**
 * Enumerate every way the given board can complete, one board per orbit.
 *
 * With no symmetry beyond the identity every completion is stored, in
 * ascending order of the dealt card. With a symmetry group, a dealt card is
 * stored only if it is the lowest of the cards the board's own symmetries
 * send it to; the others become members of its orbit. A child's symmetries are
 * its parent's that also fix the card just dealt, so they shrink as cards
 * fall.
 *
 * @param board 3, 4 or 5 distinct cards
 * @param symmetries card maps that fix the board and both ranges, identity
 *   first; see `suitSymmetries`. Omitted, none.
 * @throws if the board is not a legal postflop board
 */
export function enumerateRunouts(board: readonly number[], symmetries?: readonly Uint8Array[]): Runouts {
	if (board.length < 3 || board.length > 5) {
		throw new Error(`A postflop board has 3, 4 or 5 cards; got ${board.length} (${formatCards(board)})`);
	}
	if (new Set(board).size !== board.length) {
		throw new Error(`Board repeats a card: ${formatCards(board)}`);
	}

	const maps = new CardMaps();
	const group = (symmetries ?? []).map((map) => maps.add(map));
	if (group.length === 0 || group[0] !== 0) group.unshift(0);

	const rounds = 5 - board.length + 1;
	const width: number[] = [board.length];
	const counts: number[] = [1];
	const cards: Uint8Array[] = [Uint8Array.from(board)];
	const childStart: Int32Array[] = [new Int32Array(0)];
	const parent: Int32Array[] = [Int32Array.of(-1)];
	const orbitStart: Int32Array[] = [Int32Array.of(0, 1)];
	const orbitMap: Int32Array[] = [Int32Array.of(0)];
	const orbitCard: Uint8Array[] = [new Uint8Array(1)];
	let stabilisers: number[][] = [group];
	let symmetric = false;
	const stabiliserStart: Int32Array[] = [];
	const stabiliserMap: Int32Array[] = [];
	const recordStabilisers = (list: number[][]): void => {
		const starts = new Int32Array(list.length + 1);
		const flat: number[] = [];
		for (let b = 0; b < list.length; b++) {
			starts[b] = flat.length;
			flat.push(...list[b]);
		}
		starts[list.length] = flat.length;
		stabiliserStart.push(starts);
		stabiliserMap.push(Int32Array.from(flat));
	};
	recordStabilisers(stabilisers);

	const used = new Uint8Array(DECK);
	const seen = new Uint8Array(DECK);
	for (let round = 1; round < rounds; round++) {
		const previousWidth = width[round - 1];
		const previousCount = counts[round - 1];
		const previousCards = cards[round - 1];
		const thisWidth = previousWidth + 1;

		const level: number[] = [];
		const parents: number[] = [];
		const starts = new Int32Array(previousCount + 1);
		const memberStart: number[] = [0];
		const memberMap: number[] = [];
		const memberCard: number[] = [];
		const nextStabilisers: number[][] = [];

		for (let p = 0; p < previousCount; p++) {
			starts[p] = parents.length;
			used.fill(0);
			seen.fill(0);
			const base = p * previousWidth;
			for (let i = 0; i < previousWidth; i++) used[previousCards[base + i]] = 1;
			const stabiliser = stabilisers[p];

			for (let card = 0; card < DECK; card++) {
				if (used[card] || seen[card]) continue;
				// Ascending, so the first unseen card of an orbit is its lowest.
				const fixing: number[] = [];
				for (const sigma of stabiliser) {
					const image = maps.card[sigma][card];
					if (image === card) fixing.push(sigma);
					if (seen[image]) continue;
					seen[image] = 1;
					// `sigma` sends `card` to `image`, so its inverse sends the
					// deal of `image` back onto this board.
					memberMap.push(image === card ? 0 : maps.inverse(sigma));
					memberCard.push(image);
				}
				for (let i = 0; i < previousWidth; i++) level.push(previousCards[base + i]);
				level.push(card);
				parents.push(p);
				memberStart.push(memberMap.length);
				nextStabilisers.push(fixing);
				if (memberMap.length - memberStart[memberStart.length - 2] > 1) symmetric = true;
			}
		}
		starts[previousCount] = parents.length;

		width.push(thisWidth);
		counts.push(parents.length);
		cards.push(Uint8Array.from(level));
		childStart.push(starts);
		parent.push(Int32Array.from(parents));
		orbitStart.push(Int32Array.from(memberStart));
		orbitMap.push(Int32Array.from(memberMap));
		orbitCard.push(Uint8Array.from(memberCard));
		stabilisers = nextStabilisers;
		recordStabilisers(stabilisers);
	}

	return {
		rounds, width, counts, cards, childStart, parent, orbitStart, orbitMap, orbitCard,
		stabiliserStart, stabiliserMap, maps, symmetric,
		initial: [...board],
	};
}

/**
 * Map a board index back to its ancestor at an earlier round.
 *
 * @param runouts the enumeration
 * @param board board index at `round`
 * @param round that board's round
 * @param target the earlier round wanted
 */
export function boardAtRound(runouts: Runouts, board: number, round: number, target: number): number {
	let index = board;
	for (let r = round; r > target; r--) index = runouts.parent[r][index];
	return index;
}

/** A real board, as the solver stores it. */
export interface ResolvedBoard {
	readonly round: number;
	/** The stored board standing for it. */
	readonly board: number;
	/**
	 * Real combination to stored combination: a hand `h` on the real board
	 * plays as `combos[h]` on the stored one. The identity without symmetry.
	 */
	readonly combos: Uint16Array;
}

/**
 * Find the stored board that stands for a real one.
 *
 * @param runouts the enumeration
 * @param board every card, the given board first and then the cards dealt in order
 * @throws if the cards do not extend the given board legally
 */
export function resolveBoard(runouts: Runouts, board: readonly number[]): ResolvedBoard {
	const start = runouts.initial.length;
	for (let i = 0; i < start; i++) {
		if (board[i] !== runouts.initial[i]) {
			throw new Error(`${formatCards(board)} does not start with the spot's board ${formatCards(runouts.initial)}`);
		}
	}
	if (board.length > 5) throw new Error(`A board has at most 5 cards; got ${board.length}`);
	let index = 0;
	let map = 0;
	for (let i = start; i < board.length; i++) {
		const round = i - start + 1;
		const dealt = runouts.maps.card[map][board[i]];
		let found = -1;
		for (let child = runouts.childStart[round][index]; child < runouts.childStart[round][index + 1] && found < 0; child++) {
			for (let m = runouts.orbitStart[round][child]; m < runouts.orbitStart[round][child + 1]; m++) {
				if (runouts.orbitCard[round][m] !== dealt) continue;
				found = child;
				map = runouts.maps.then(map, runouts.orbitMap[round][m]);
				break;
			}
		}
		if (found < 0) throw new Error(`${formatCards(board)} deals a card already on the board`);
		index = found;
	}
	return { round: board.length - start, board: index, combos: runouts.maps.combo[map] };
}
