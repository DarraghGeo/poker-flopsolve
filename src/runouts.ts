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
	 * identity holds hands that mirror each other on it, which the solver
	 * stores once per orbit.
	 */
	readonly stabiliserStart: readonly Int32Array[];
	readonly stabiliserMap: readonly Int32Array[];
	/** The relabellings `orbitMap` refers to. */
	readonly maps: CardMaps;
	/** Whether any board stands for more than itself. */
	readonly symmetric: boolean;
	/**
	 * Whether some board stands for deals that are not its exact mirror
	 * images — runout buckets — so the stored game approximates the real one.
	 */
	readonly approximate: boolean;
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
export function enumerateRunouts(
	board: readonly number[],
	symmetries?: readonly Uint8Array[],
	merge?: RunoutMerge,
): Runouts {
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
	let approximate = false;
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
			const base = p * previousWidth;
			const children = dealChildren(maps, previousCards, base, previousWidth, stabilisers[p], merge);
			for (const child of children) if (child.merged) approximate = true;

			for (const child of children) {
				if (child.merged) continue;
				for (let i = 0; i < previousWidth; i++) level.push(previousCards[base + i]);
				level.push(child.card);
				parents.push(p);
				memberMap.push(...child.maps);
				memberCard.push(...child.cards);
				memberStart.push(memberMap.length);
				nextStabilisers.push(child.fixing);
				if (child.maps.length > 1) symmetric = true;
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
		stabiliserStart, stabiliserMap, maps, symmetric, approximate,
		initial: [...board],
	};
}

/** One stored child of a board, and the real deals it stands for. */
export interface DealtChild {
	readonly card: number;
	/** Each member deal's map onto this board, and its card; see `Runouts.orbitMap`. */
	readonly maps: number[];
	readonly cards: number[];
	/** The parent's symmetries that also fix this card: the child's own. */
	readonly fixing: number[];
	/** Folded into an earlier child, so not stored. */
	merged: boolean;
}

const usedScratch = new Uint8Array(DECK);
const seenScratch = new Uint8Array(DECK);

/**
 * The children of one board: one per orbit of its symmetries, ascending by
 * card, with runout buckets folded into earlier children (`merged`).
 *
 * @param maps the relabellings in use, which merges add to
 * @param cards flat board cards, the parent at `base`, `width` of them
 * @param stabiliser the parent's symmetries, identity first
 */
export function dealChildren(
	maps: CardMaps,
	cards: ArrayLike<number>,
	base: number,
	width: number,
	stabiliser: readonly number[],
	merge?: RunoutMerge,
): DealtChild[] {
	const used = usedScratch;
	const seen = seenScratch;
	used.fill(0);
	seen.fill(0);
	for (let i = 0; i < width; i++) used[cards[base + i]] = 1;

	// One stored child per orbit of the board's symmetries.
	const children: DealtChild[] = [];
	for (let card = 0; card < DECK; card++) {
		if (used[card] || seen[card]) continue;
		// Ascending, so the first unseen card of an orbit is its lowest.
		const child: DealtChild = { card, maps: [], cards: [], fixing: [], merged: false };
		for (const sigma of stabiliser) {
			const image = maps.card[sigma][card];
			if (image === card) child.fixing.push(sigma);
			if (seen[image]) continue;
			seen[image] = 1;
			// `sigma` sends `card` to `image`, so its inverse sends the
			// deal of `image` back onto this board.
			child.maps.push(image === card ? 0 : maps.inverse(sigma));
			child.cards.push(image);
		}
		children.push(child);
	}

	// Runout buckets: a child that plays like an earlier one is folded
	// into it, relabelled by swapping the two cards' ranks.
	if (merge) {
		const boardRanks = new Set<number>();
		for (let i = 0; i < width; i++) boardRanks.add(cards[base + i] >> 2);
		for (let j = 0; j < children.length; j++) {
			const later = children[j];
			const rankJ = later.card >> 2;
			if (boardRanks.has(rankJ)) continue;
			for (let i = 0; i < j; i++) {
				const earlier = children[i];
				if (earlier.merged || (earlier.card & 3) !== (later.card & 3)) continue;
				const rankI = earlier.card >> 2;
				if (boardRanks.has(rankI) || rankJ - rankI > merge.maxGap || !merge.ranks(rankI, rankJ)) continue;
				if (connectivity(boardRanks, rankI) !== connectivity(boardRanks, rankJ)) continue;
				const swap = maps.add(rankSwap(rankI, rankJ));
				for (let m = 0; m < later.maps.length; m++) {
					earlier.maps.push(maps.then(later.maps[m], swap));
					earlier.cards.push(later.cards[m]);
				}
				later.merged = true;
				break;
			}
		}
	}
	return children;
}

/** Which runouts may be bucketed together; see `enumerateRunouts`. */
export interface RunoutMerge {
	/**
	 * Whether swapping these two ranks leaves the game close enough to itself:
	 * at the least, every hand in either range still maps to a hand in it.
	 */
	ranks(a: number, b: number): boolean;
	/** Largest distance between two ranks in one bucket, counted from the stored card. */
	readonly maxGap: number;
}

/** The card map swapping two ranks in every suit. */
export function rankSwap(a: number, b: number): Uint8Array {
	const out = new Uint8Array(DECK);
	for (let card = 0; card < DECK; card++) {
		const rank = card >> 2;
		out[card] = ((rank === a ? b : rank === b ? a : rank) << 2) | (card & 3);
	}
	return out;
}

/**
 * How far a rank goes toward a straight with the board: the most board ranks
 * sharing one five-rank window with it, the ace counting low as well.
 */
export function connectivity(boardRanks: ReadonlySet<number>, rank: number): number {
	let best = 0;
	// Windows by their lowest rank; -1 is the wheel, A-2-3-4-5.
	for (let low = -1; low <= 8; low++) {
		if (rank < low || rank > low + 4) {
			if (!(low === -1 && rank === 12)) continue;
		}
		let count = 0;
		for (let r = low; r <= low + 4; r++) {
			const actual = r === -1 ? 12 : r;
			if (actual !== rank && boardRanks.has(actual)) count++;
		}
		if (count > best) best = count;
	}
	return best;
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
		const children = runouts.childStart[round];
		const relabel = runouts.orbitMap[round];
		for (let child = children[index]; child < children[index + 1] && found < 0; child++) {
			for (let m = runouts.orbitStart[round][child]; m < runouts.orbitStart[round][child + 1]; m++) {
				if (runouts.orbitCard[round][m] !== dealt) continue;
				found = child;
				map = runouts.maps.then(map, relabel[m]);
				break;
			}
		}
		if (found < 0) throw new Error(`${formatCards(board)} deals a card already on the board`);
		index = found;
	}
	return { round: board.length - start, board: index, combos: runouts.maps.combo[map] };
}
