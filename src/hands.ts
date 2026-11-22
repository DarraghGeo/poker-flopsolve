/**
 * Hand-space index structures and terminal kernels.
 *
 * Purpose: let a traversal carry each player's reach and values as a dense
 * vector over the hands that player can hold on the current board — entry `i`
 * of their active list (`buildActiveLists` in cfr.ts) — instead of a sparse
 * 1326-wide array reached through a list of live combinations. Every loop
 * then runs `0..n` over contiguous memory.
 *
 * What a traversal needs to move between boards and to settle terminals:
 *
 *   - At a deal, which parent hand each child hand is, for the stored board
 *     and for every real deal it stands for (relabelled by the orbit's map).
 *     Reach is gathered and values scatter-added through these.
 *   - At a fold, which opposing hand is the very same combination as each of
 *     mine, for the inclusion–exclusion that removes it.
 *
 * A showdown needs nothing here: on a final board the active lists are
 * already sorted by strength, with each entry's strength and cards beside it.
 */

import { COMBOS, DECK } from './cards.ts';
import type { PlayerIndex } from './cfr.ts';
import type { KeptSets } from './nested.ts';
import type { Runouts } from './runouts.ts';

/** The active lists, as `buildActiveLists` lays them out. */
export interface HandLists {
	readonly start: Int32Array;
	readonly count: Uint16Array;
	readonly list: Uint16Array;
	readonly roundBase: Int32Array;
	readonly memberStart: Int32Array;
	readonly memberCombo: Uint16Array;
}

/** Everything a hand-space traversal looks up. */
export interface HandSpace {
	/**
	 * Deals: for round `r`, orbit member `m` (an index into
	 * `runouts.orbitMap[r]`) and player `p`, `up` from `upStart[r][m * 2 + p]`
	 * holds, for each of the player's hands on the stored child board, the
	 * index of the parent-board hand it is — through the member's relabelling.
	 */
	readonly upStart: readonly Int32Array[];
	readonly up: Uint16Array;
	/**
	 * Folds: for each list slot `(roundBase[r] + board) * 2 + p`, from
	 * `sameStart[slot]`, the index in the other player's list of each of this
	 * player's hands, or -1 where they cannot hold it.
	 */
	readonly sameStart: Int32Array;
	readonly same: Int32Array;
	/**
	 * Deals onto boards with kept sets (`chooseKeptSets`), else null. For a
	 * round dealt this way, `up` holds a parent hand for each of the board's
	 * candidates, in the kept sets' order, rather than for each hand of its
	 * list.
	 */
	readonly kept: KeptDeals | null;
}

/** What a deal onto a board with a kept set looks up, beside `up`. */
export interface KeptDeals {
	/** Per round, 1 where its boards have kept sets. */
	readonly rounds: Uint8Array;
	/** Candidates of each list slot, as `KeptSets.start`. */
	readonly start: Int32Array;
	/** Per candidate, where its stand-in sits in the board's list. */
	readonly kept: Uint16Array;
	/** Per candidate, the hands it stands for on its board. */
	readonly orbit: Float32Array;
	/** Per list entry, what the reach gathered on it is multiplied by. */
	readonly scale: Float32Array;
}

/**
 * Point every hand the entries of one list stand for at its entry's position
 * in that list, or back at -1 with `clear`.
 */
export function markMembers(
	lists: Pick<HandLists, 'memberStart' | 'memberCombo'>,
	from: number,
	count: number,
	indexOf: Int32Array,
	clear: boolean,
): void {
	for (let i = 0; i < count; i++) {
		for (let m = lists.memberStart[from + i]; m < lists.memberStart[from + i + 1]; m++) {
			indexOf[lists.memberCombo[m]] = clear ? -1 : i;
		}
	}
}

/** A list's offset and length for a round, board and player. */
function span(lists: HandLists, round: number, board: number, player: number): [number, number] {
	const slot = (lists.roundBase[round] + board) * 2 + player;
	return [lists.start[slot], lists.count[slot]];
}

/** Build the hand-space structures for a prepared spot. */
export function buildHandSpace(
	runouts: Runouts,
	players: readonly [PlayerIndex, PlayerIndex],
	lists: HandLists,
	sets: KeptSets | null = null,
): HandSpace {
	void players;
	const indexOf = new Int32Array(COMBOS).fill(-1);
	const thinned = (round: number): boolean => sets !== null && sets.rounds[round] === 1;
	// How many hands a deal maps: the board's candidates under kept sets, else its list.
	const mapped = (round: number, board: number, player: number): number => {
		if (!thinned(round)) return span(lists, round, board, player)[1];
		const slot = (lists.roundBase[round] + board) * 2 + player;
		return sets!.start[slot + 1] - sets!.start[slot];
	};
	const keptAt = sets ? new Uint16Array(sets.combo.length) : null;
	const scale = sets ? new Float32Array(lists.list.length).fill(1) : null;
	const childIndex = new Int32Array(COMBOS).fill(-1);

	// Deals.
	const upStart: Int32Array[] = [new Int32Array(0)];
	// Sized first: this is filled at the start of every solve, one entry per
	// hand per deal, and growing a plain array that far is most of its cost.
	let upLength = 0;
	for (let round = 1; round < runouts.rounds; round++) {
		const orbitStart = runouts.orbitStart[round];
		for (let child = 0; child < runouts.counts[round]; child++) {
			const deals = orbitStart[child + 1] - orbitStart[child];
			upLength += deals * (mapped(round, child, 0) + mapped(round, child, 1));
		}
	}
	const up = new Uint16Array(upLength);
	let upAt = 0;
	for (let round = 1; round < runouts.rounds; round++) {
		const orbitStart = runouts.orbitStart[round];
		const starts = new Int32Array(runouts.orbitMap[round].length * 2);
		for (let child = 0; child < runouts.counts[round]; child++) {
			const parent = runouts.parent[round][child];
			for (let player = 0; player < 2; player++) {
				const [parentFrom, parentCount] = span(lists, round - 1, parent, player);
				markMembers(lists, parentFrom, parentCount, indexOf, false);
				const [childFrom, childCount] = span(lists, round, child, player);
				if (thinned(round)) {
					// Each candidate's parent hand, per deal; and, once for the
					// board, where its stand-in sits in the board's list.
					const slot = (lists.roundBase[round] + child) * 2 + player;
					const from = sets!.start[slot];
					const to = sets!.start[slot + 1];
					markMembers(lists, childFrom, childCount, childIndex, false);
					for (let i = from; i < to; i++) {
						const at = childIndex[sets!.stand[i]];
						if (at < 0) throw new Error('A stand-in is not in its board\'s list');
						keptAt![i] = at;
						if (sets!.stand[i] === sets!.combo[i]) scale![childFrom + at] = sets!.scale[i];
					}
					markMembers(lists, childFrom, childCount, childIndex, true);
					for (let m = orbitStart[child]; m < orbitStart[child + 1]; m++) {
						const back = runouts.maps.combo[runouts.maps.inverse(runouts.orbitMap[round][m])];
						starts[m * 2 + player] = upAt;
						for (let i = from; i < to; i++) {
							const at = indexOf[back[sets!.combo[i]]];
							if (at < 0) throw new Error('A candidate\'s parent hand is not in its parent\'s list');
							up[upAt++] = at;
						}
					}
					markMembers(lists, parentFrom, parentCount, indexOf, true);
					continue;
				}
				for (let m = orbitStart[child]; m < orbitStart[child + 1]; m++) {
					// The member's map sends a real hand onto the stored board;
					// its inverse sends a stored hand back to the real one.
					const back = runouts.maps.combo[runouts.maps.inverse(runouts.orbitMap[round][m])];
					starts[m * 2 + player] = upAt;
					for (let k = 0; k < childCount; k++) {
						const real = back[lists.list[childFrom + k]];
						const at = indexOf[real];
						if (at < 0) throw new Error('A relabelled hand is not in its range; the relabelling must preserve both ranges');
						up[upAt++] = at;
					}
				}
				markMembers(lists, parentFrom, parentCount, indexOf, true);
			}
		}
		upStart.push(starts);
	}

	// Folds.
	const slots = lists.roundBase[runouts.rounds] * 2;
	const sameStart = new Int32Array(slots + 1);
	const same = new Int32Array(lists.list.length);
	let sameAt = 0;
	for (let round = 0; round < runouts.rounds; round++) {
		for (let board = 0; board < runouts.counts[round]; board++) {
			for (let player = 0; player < 2; player++) {
				const slot = (lists.roundBase[round] + board) * 2 + player;
				const [otherFrom, otherCount] = span(lists, round, board, 1 - player);
				markMembers(lists, otherFrom, otherCount, indexOf, false);
				const [from, count] = span(lists, round, board, player);
				sameStart[slot] = sameAt;
				for (let i = 0; i < count; i++) same[sameAt++] = indexOf[lists.list[from + i]];
				markMembers(lists, otherFrom, otherCount, indexOf, true);
			}
		}
	}
	sameStart[slots] = sameAt;

	const kept: KeptDeals | null = sets
		? { rounds: sets.rounds, start: sets.start, kept: keptAt!, orbit: Float32Array.from(sets.orbit), scale: scale! }
		: null;
	return { upStart, up, sameStart, same, kept };
}

/**
 * Values at a fold, in hand space, exact under card removal: each of my hands
 * wins or loses `payoff` against every opposing hand it does not collide with.
 *
 * @param oppReach the opponent's reach, over their list
 * @param oppCombos their list's combinations, from `oppFrom`
 * @param myCombos mine, from `myFrom`
 * @param same for each of my hands, its index in their list or -1
 * @param sums 52 doubles of scratch, all zero; left zero
 * @param out my values, `myCount` of them
 */
export function foldValuesHands(
	oppReach: Float64Array,
	cardA: Uint8Array,
	cardB: Uint8Array,
	oppFrom: number,
	oppCount: number,
	myFrom: number,
	myCount: number,
	same: Int32Array,
	sameFrom: number,
	payoff: number,
	sums: Float64Array,
	out: Float64Array,
): void {
	let total = 0;
	for (let j = 0; j < oppCount; j++) {
		const value = oppReach[j];
		total += value;
		sums[cardA[oppFrom + j]] += value;
		sums[cardB[oppFrom + j]] += value;
	}
	for (let i = 0; i < myCount; i++) {
		const twin = same[sameFrom + i];
		// The pair term: the one opposing hand holding both my cards.
		const both = twin >= 0 ? oppReach[twin] : 0;
		out[i] = payoff * (total - (sums[cardA[myFrom + i]] + sums[cardB[myFrom + i]] - both));
	}
	sums.fill(0, 0, DECK);
}

/**
 * Values at a showdown, in hand space, exact under card removal.
 *
 * On a final board both lists are sorted by strength, so this is two
 * contiguous sweeps. Ascending, the opponent's hands strictly weaker than
 * each of mine are added to running totals before mine is read, so its own
 * tie group and its own cards fall out; descending, the same for hands
 * strictly stronger. A hand's value is what it beats minus what beats it,
 * times `payoff`.
 *
 * @param sums 52 doubles of scratch, all zero; left zero
 */
export function showdownValuesHands(
	oppReach: Float64Array,
	cardA: Uint8Array,
	cardB: Uint8Array,
	strength: Int32Array,
	oppFrom: number,
	oppCount: number,
	myFrom: number,
	myCount: number,
	payoff: number,
	sums: Float64Array,
	out: Float64Array,
): void {
	let running = 0;
	let j = 0;
	for (let i = 0; i < myCount; i++) {
		const level = strength[myFrom + i];
		while (j < oppCount && strength[oppFrom + j] < level) {
			const value = oppReach[j];
			running += value;
			sums[cardA[oppFrom + j]] += value;
			sums[cardB[oppFrom + j]] += value;
			j++;
		}
		out[i] = running - (sums[cardA[myFrom + i]] + sums[cardB[myFrom + i]]);
	}
	sums.fill(0, 0, DECK);

	running = 0;
	j = oppCount - 1;
	for (let i = myCount - 1; i >= 0; i--) {
		const level = strength[myFrom + i];
		while (j >= 0 && strength[oppFrom + j] > level) {
			const value = oppReach[j];
			running += value;
			sums[cardA[oppFrom + j]] += value;
			sums[cardB[oppFrom + j]] += value;
			j--;
		}
		out[i] = payoff * (out[i] - (running - (sums[cardA[myFrom + i]] + sums[cardB[myFrom + i]])));
	}
	sums.fill(0, 0, DECK);
}

/**
 * Packed lists' card-removal sums: each entry's reach counted once per hand it
 * stands for, on that hand's own cards. Returns the reach-weighted total.
 */
function addMembers(
	reach: number,
	entry: number,
	memberStart: Int32Array,
	memberA: Uint8Array,
	memberB: Uint8Array,
	sums: Float64Array,
): number {
	const to = memberStart[entry + 1];
	for (let m = memberStart[entry]; m < to; m++) {
		sums[memberA[m]] += reach;
		sums[memberB[m]] += reach;
	}
	return reach * (to - memberStart[entry]);
}

/** `foldValuesHands` over packed lists: every hand an opposing entry stands for counts. */
export function foldValuesPacked(
	oppReach: Float64Array,
	cardA: Uint8Array,
	cardB: Uint8Array,
	memberStart: Int32Array,
	memberA: Uint8Array,
	memberB: Uint8Array,
	oppFrom: number,
	oppCount: number,
	myFrom: number,
	myCount: number,
	same: Int32Array,
	sameFrom: number,
	payoff: number,
	sums: Float64Array,
	out: Float64Array,
): void {
	let total = 0;
	for (let j = 0; j < oppCount; j++) total += addMembers(oppReach[j], oppFrom + j, memberStart, memberA, memberB, sums);
	for (let i = 0; i < myCount; i++) {
		const twin = same[sameFrom + i];
		const both = twin >= 0 ? oppReach[twin] : 0;
		out[i] = payoff * (total - (sums[cardA[myFrom + i]] + sums[cardB[myFrom + i]] - both));
	}
	sums.fill(0, 0, DECK);
}

/** `showdownValuesHands` over packed lists: every hand an opposing entry stands for counts. */
export function showdownValuesPacked(
	oppReach: Float64Array,
	cardA: Uint8Array,
	cardB: Uint8Array,
	memberStart: Int32Array,
	memberA: Uint8Array,
	memberB: Uint8Array,
	strength: Int32Array,
	oppFrom: number,
	oppCount: number,
	myFrom: number,
	myCount: number,
	payoff: number,
	sums: Float64Array,
	out: Float64Array,
): void {
	let running = 0;
	let j = 0;
	for (let i = 0; i < myCount; i++) {
		const level = strength[myFrom + i];
		while (j < oppCount && strength[oppFrom + j] < level) {
			running += addMembers(oppReach[j], oppFrom + j, memberStart, memberA, memberB, sums);
			j++;
		}
		out[i] = running - (sums[cardA[myFrom + i]] + sums[cardB[myFrom + i]]);
	}
	sums.fill(0, 0, DECK);

	running = 0;
	j = oppCount - 1;
	for (let i = myCount - 1; i >= 0; i--) {
		const level = strength[myFrom + i];
		while (j >= 0 && strength[oppFrom + j] > level) {
			running += addMembers(oppReach[j], oppFrom + j, memberStart, memberA, memberB, sums);
			j--;
		}
		out[i] = payoff * (out[i] - (running - (sums[cardA[myFrom + i]] + sums[cardB[myFrom + i]])));
	}
	sums.fill(0, 0, DECK);
}
