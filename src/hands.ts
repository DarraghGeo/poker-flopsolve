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
import type { Runouts } from './runouts.ts';

/** The active lists, as `buildActiveLists` lays them out. */
export interface HandLists {
	readonly start: Int32Array;
	readonly count: Uint16Array;
	readonly list: Uint16Array;
	readonly roundBase: Int32Array;
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
): HandSpace {
	void players;
	const indexOf = new Int32Array(COMBOS).fill(-1);

	// Deals.
	const upStart: Int32Array[] = [new Int32Array(0)];
	const up: number[] = [];
	for (let round = 1; round < runouts.rounds; round++) {
		const orbitStart = runouts.orbitStart[round];
		const starts = new Int32Array(runouts.orbitMap[round].length * 2);
		for (let child = 0; child < runouts.counts[round]; child++) {
			const parent = runouts.parent[round][child];
			for (let player = 0; player < 2; player++) {
				const [parentFrom, parentCount] = span(lists, round - 1, parent, player);
				for (let i = 0; i < parentCount; i++) indexOf[lists.list[parentFrom + i]] = i;
				const [childFrom, childCount] = span(lists, round, child, player);
				for (let m = orbitStart[child]; m < orbitStart[child + 1]; m++) {
					// The member's map sends a real hand onto the stored board;
					// its inverse sends a stored hand back to the real one.
					const back = runouts.maps.combo[runouts.maps.inverse(runouts.orbitMap[round][m])];
					starts[m * 2 + player] = up.length;
					for (let k = 0; k < childCount; k++) {
						const real = back[lists.list[childFrom + k]];
						const at = indexOf[real];
						if (at < 0) throw new Error('A relabelled hand is not in its range; the relabelling must preserve both ranges');
						up.push(at);
					}
				}
				for (let i = 0; i < parentCount; i++) indexOf[lists.list[parentFrom + i]] = -1;
			}
		}
		upStart.push(starts);
	}

	// Folds.
	const slots = lists.roundBase[runouts.rounds] * 2;
	const sameStart = new Int32Array(slots + 1);
	const same: number[] = [];
	for (let round = 0; round < runouts.rounds; round++) {
		for (let board = 0; board < runouts.counts[round]; board++) {
			for (let player = 0; player < 2; player++) {
				const slot = (lists.roundBase[round] + board) * 2 + player;
				const [otherFrom, otherCount] = span(lists, round, board, 1 - player);
				for (let j = 0; j < otherCount; j++) indexOf[lists.list[otherFrom + j]] = j;
				const [from, count] = span(lists, round, board, player);
				sameStart[slot] = same.length;
				for (let i = 0; i < count; i++) same.push(indexOf[lists.list[from + i]]);
				for (let j = 0; j < otherCount; j++) indexOf[lists.list[otherFrom + j]] = -1;
			}
		}
	}
	sameStart[slots] = same.length;

	return { upStart, up: Uint16Array.from(up), sameStart, same: Int32Array.from(same) };
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
