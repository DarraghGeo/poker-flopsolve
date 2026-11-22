/**
 * Kept sets: range compression street by street, inside one solve.
 *
 * Purpose: `compressRanges` thins the ranges once, for the board a spot
 * starts on, and the hands it keeps must stand for the rest on every board
 * that can follow. A hand is far easier to stand in for on one board than on
 * all of them, so here each later board has a kept set of its own: on a turn
 * card, the fewest hands whose equity distributions match what arrives
 * there; under it, on each river card, the fewest of those again. Most of a
 * solve's work is on the later streets, so that is where a shorter list pays.
 *
 * A board's hand list (`buildActiveLists`) then holds only its kept hands,
 * and so does every decision's storage there. At the deal that reaches the
 * board, each hand that could be held (a candidate) hands its reach to the
 * kept hand it plays most like, its stand-in, and takes that hand's value
 * back (`traverse`, the chance branch). A kept hand's gathered reach is
 * scaled so that the kept hands weigh what the compressor fitted them to
 * weigh when every candidate arrives in proportion to its weight.
 *
 * The compressor is poker-rangecompress's, as for `compressRanges`.
 */

import { COMBO_CARDS, COMBOS, DECK, comboIndex, parseCard } from './cards.ts';
import type { PlayerIndex } from './cfr.ts';
import type { Runouts } from './runouts.ts';
import RangeCompress from './vendor/range-compress.js';

/** The kept hands of every board of the rounds compressed. */
export interface KeptSets {
	/** The tolerance each round was compressed to; 0 for a round left whole. */
	readonly tolerance: readonly number[];
	/**
	 * Per round, 1 where its boards have kept sets: every round from the
	 * first with a tolerance on, since a board's candidates are the hands
	 * its parent kept.
	 */
	readonly rounds: Uint8Array;
	/**
	 * Candidates of list slot `(roundBase[r] + board) * 2 + p` run from
	 * `start[slot]` to `start[slot + 1]`: the hands the player can hold on
	 * that board, one per mirror orbit, whose parent board kept them.
	 */
	readonly start: Int32Array;
	readonly combo: Uint16Array;
	/** The kept hand each candidate plays as: itself when it is kept. */
	readonly stand: Uint16Array;
	/** How many hands a candidate stands for on its board: its mirror orbit. */
	readonly orbit: Uint8Array;
	/** For a kept candidate, what its gathered reach is multiplied by; else 0. */
	readonly scale: Float32Array;
	/** For a kept candidate, the weight it was fitted to carry, a hand; else 0. */
	readonly weight: Float32Array;
	/** Hands kept and candidates, over all boards of each round and both players. */
	readonly keptHands: readonly number[];
	readonly candidates: readonly number[];
	readonly bytes: number;
}

/**
 * Where every combination's play is kept on a board: its position in the
 * player's list there, or -1 for a hand the board blocks or the range does
 * not hold. A kept hand is at its own entry and a candidate at its
 * stand-in's; a hand an earlier board dropped follows the hand that board
 * plays it as. Without kept sets on the round, each list entry's own hands.
 *
 * @param out one per combination, overwritten
 */
export function playsAs(
	sets: KeptSets | null,
	runouts: Runouts,
	lists: { readonly start: Int32Array; readonly count: Uint16Array; readonly roundBase: Int32Array; readonly memberStart: Int32Array; readonly memberCombo: Uint16Array },
	round: number,
	board: number,
	player: number,
	out: Int32Array,
): void {
	out.fill(-1);
	const slot = (lists.roundBase[round] + board) * 2 + player;
	const from = lists.start[slot];
	const count = lists.count[slot];
	for (let i = 0; i < count; i++) {
		for (let m = lists.memberStart[from + i]; m < lists.memberStart[from + i + 1]; m++) out[lists.memberCombo[m]] = i;
	}
	if (sets === null || sets.rounds[round] !== 1) return;
	const comboMaps = runouts.maps.combo;
	const stabFrom = runouts.stabiliserStart[round][board] + 1;
	const stabTo = runouts.stabiliserStart[round][board + 1];
	const stabMap = runouts.stabiliserMap[round];
	for (let i = sets.start[slot]; i < sets.start[slot + 1]; i++) {
		const c = sets.combo[i];
		if (sets.stand[i] === c) continue;
		const at = out[sets.stand[i]];
		out[c] = at;
		for (let k = stabFrom; k < stabTo; k++) out[comboMaps[stabMap[k]][c]] = at;
	}
	if (sets.rounds[round - 1] !== 1) return;
	// Hands the parent board dropped: as a hand of the entry it plays them as, if this board holds one.
	const parent = runouts.parent[round][board];
	const above = new Int32Array(COMBOS);
	playsAs(sets, runouts, lists, round - 1, parent, player, above);
	const parentFrom = lists.start[(lists.roundBase[round - 1] + parent) * 2 + player];
	const width = runouts.width[round];
	const dealt = runouts.cards[round][board * width + width - 1];
	for (let h = 0; h < COMBOS; h++) {
		if (out[h] >= 0 || above[h] < 0 || COMBO_CARDS[h * 2] === dealt || COMBO_CARDS[h * 2 + 1] === dealt) continue;
		const entry = parentFrom + above[h];
		for (let m = lists.memberStart[entry]; m < lists.memberStart[entry + 1]; m++) {
			if (out[lists.memberCombo[m]] >= 0) {
				out[h] = out[lists.memberCombo[m]];
				break;
			}
		}
	}
}

/** A card as the compressor numbers it: the same ranks, suits in `c d h s` order where they are `s h d c` here. */
const TO_VENDOR = Uint8Array.from({ length: DECK }, (_, card) => (card & ~3) | (3 - (card & 3)));

/** The combination a hand name such as "AsKs" is. */
const NAMED = new Map<string, number>();
function comboOf(hand: string): number {
	let combo = NAMED.get(hand);
	if (combo === undefined) {
		combo = comboIndex(parseCard(hand.slice(0, 2)), parseCard(hand.slice(2, 4)));
		NAMED.set(hand, combo);
	}
	return combo;
}

/** Tolerances up to this keep every candidate. */
const WHOLE = 1e-9;

interface VendorHand {
	a: number;
	b: number;
	w: number;
}

/**
 * Choose the kept hands of every board of the rounds with a tolerance.
 *
 * @param tolerance per round of the spot, the most mismatch its kept sets
 *   may have (as `compressRanges`); 0 leaves the round whole. The spot's own
 *   round, 0, is never compressed here: thin the ranges for that.
 * @returns null when no round has a tolerance
 */
export function chooseKeptSets(
	runouts: Runouts,
	players: readonly [PlayerIndex, PlayerIndex],
	tolerance: readonly number[],
): KeptSets | null {
	const rounds = new Uint8Array(runouts.rounds);
	for (let round = 1; round < runouts.rounds; round++) rounds[round] = rounds[round - 1] === 1 || tolerance[round] > 0 ? 1 : 0;
	if (!rounds.includes(1)) return null;

	const roundBase = new Int32Array(runouts.rounds + 1);
	for (let round = 0; round < runouts.rounds; round++) roundBase[round + 1] = roundBase[round] + runouts.counts[round];
	const slots = roundBase[runouts.rounds] * 2;
	const start = new Int32Array(slots + 1);
	let capacity = 1 << 16;
	let combo = new Uint16Array(capacity);
	let stand = new Uint16Array(capacity);
	let orbit = new Uint8Array(capacity);
	let scale = new Float32Array(capacity);
	let weight = new Float32Array(capacity);
	const grow = (need: number): void => {
		if (need <= capacity) return;
		while (capacity < need) capacity *= 2;
		const wider = <T extends Uint16Array | Uint8Array | Float32Array>(old: T): T => {
			const next = new (old.constructor as new (n: number) => T)(capacity);
			next.set(old);
			return next;
		};
		combo = wider(combo);
		stand = wider(stand);
		orbit = wider(orbit);
		scale = wider(scale);
		weight = wider(weight);
	};

	const comboMaps = runouts.maps.combo;
	const onBoard = new Uint8Array(DECK);
	// What each real hand weighs where its parent board left it: the range
	// weight under a whole parent, its kept leader's fitted weight under a
	// compressed one, 0 for a hand the parent did not keep.
	const arriving = [new Float64Array(COMBOS), new Float64Array(COMBOS)];
	const leaderOf = new Int32Array(COMBOS);
	const fitted = new Float64Array(COMBOS);
	const mass = new Float64Array(COMBOS);
	const standOf = new Int32Array(COMBOS);
	const keptHands = new Array<number>(runouts.rounds).fill(0);
	const candidates = new Array<number>(runouts.rounds).fill(0);
	let at = 0;

	for (let round = 0; round < runouts.rounds; round++) {
		if (!rounds[round]) {
			for (let board = 0; board < runouts.counts[round]; board++) start[(roundBase[round] + board) * 2] = start[(roundBase[round] + board) * 2 + 1] = at;
			continue;
		}
		const width = runouts.width[round];
		const cards = runouts.cards[round];
		const stabStart = runouts.stabiliserStart[round];
		const stabMap = runouts.stabiliserMap[round];
		const parentStabStart = runouts.stabiliserStart[round - 1];
		const parentStabMap = runouts.stabiliserMap[round - 1];
		// A tolerance too small to drop anything keeps every candidate, without asking the compressor.
		const tol = tolerance[round] > WHOLE ? tolerance[round] : 0;
		let lastParent = -1;
		for (let board = 0; board < runouts.counts[round]; board++) {
			const parent = runouts.parent[round][board];
			if (parent !== lastParent) {
				// Boards of one parent are stored together: its hands' weights once.
				lastParent = parent;
				for (let player = 0; player < 2; player++) {
					const into = arriving[player];
					if (!rounds[round - 1]) {
						into.set(players[player].weights);
						continue;
					}
					into.fill(0);
					const slot = (roundBase[round - 1] + parent) * 2 + player;
					for (let i = start[slot]; i < start[slot + 1]; i++) {
						if (stand[i] !== combo[i]) continue;
						into[combo[i]] = weight[i];
						for (let k = parentStabStart[parent] + 1; k < parentStabStart[parent + 1]; k++) into[comboMaps[parentStabMap[k]][combo[i]]] = weight[i];
					}
				}
			}
			onBoard.fill(0);
			for (let i = 0; i < width; i++) onBoard[cards[board * width + i]] = 1;
			const stabFrom = stabStart[board] + 1;
			const stabTo = stabStart[board + 1];
			const spans: [number, number][] = [];
			const hands: VendorHand[][] = [[], []];
			for (let player = 0; player < 2; player++) {
				const from = at;
				const into = arriving[player];
				grow(at + players[player].count);
				let largest = 0;
				for (let c = 0; c < COMBOS; c++) if (into[c] > largest) largest = into[c];
				for (let c = 0; c < COMBOS; c++) {
					if (!(into[c] > 0) || onBoard[COMBO_CARDS[c * 2]] || onBoard[COMBO_CARDS[c * 2 + 1]]) continue;
					let leader = c;
					for (let k = stabFrom; k < stabTo; k++) {
						const image = comboMaps[stabMap[k]][c];
						if (image < leader) leader = image;
					}
					leaderOf[c] = leader;
					if (tol > 0) {
						// The compressor wants a hand's lower card first, by its own numbering.
						const x = TO_VENDOR[COMBO_CARDS[c * 2]];
						const y = TO_VENDOR[COMBO_CARDS[c * 2 + 1]];
						hands[player].push({ a: x < y ? x : y, b: x < y ? y : x, w: into[c] / largest });
					}
					if (leader !== c) continue;
					combo[at] = c;
					stand[at] = c;
					weight[at] = into[c];
					at++;
				}
				// A leader's orbit: its distinct images.
				for (let i = from; i < at; i++) {
					let size = 1;
					const c = combo[i];
					for (let k = stabFrom; k < stabTo; k++) {
						const image = comboMaps[stabMap[k]][c];
						if (image === c) continue;
						let seen = false;
						for (let j = stabFrom; j < k; j++) if (comboMaps[stabMap[j]][c] === image) seen = true;
						if (!seen) size++;
					}
					orbit[i] = size;
					scale[i] = 1 / size;
				}
				spans.push([from, at]);
				start[(roundBase[round] + board) * 2 + player] = from;
				candidates[round] += at - from;
			}
			start[(roundBase[round] + board) * 2 + 2] = at;
			if (tol > 0 && hands[0].length >= 3 && hands[1].length >= 3) {
				const out = RangeCompress.compressBoth({
					oop: hands[0], ip: hands[1], board: Array.from(cards.subarray(board * width, (board + 1) * width), (card) => TO_VENDOR[card]),
					tolerance: tol, standIns: 1,
				} as unknown as Parameters<typeof RangeCompress.compressBoth>[0]);
				for (let player = 0; player < 2; player++) {
					const result = (player === 0 ? out.oop : out.ip) as unknown as {
						hands: readonly { hand: string; weight: number }[];
						standIns: Readonly<Record<string, readonly string[]>>;
						weightScale: number;
					};
					const [from, to] = spans[player];
					let largest = 0;
					for (let c = 0; c < COMBOS; c++) if (arriving[player][c] > largest) largest = arriving[player][c];
					// A kept leader's fitted weight, a hand: its orbit's fitted weight over its size.
					for (let i = from; i < to; i++) fitted[combo[i]] = mass[combo[i]] = 0;
					for (const { hand, weight: w } of result.hands) fitted[leaderOf[comboOf(hand)]] += (w / result.weightScale) * largest;
					for (let i = from; i < to; i++) standOf[combo[i]] = combo[i];
					for (const hand in result.standIns) standOf[comboOf(hand)] = leaderOf[comboOf(result.standIns[hand][0])];
					for (let i = from; i < to; i++) {
						const c = combo[i];
						stand[i] = fitted[standOf[c]] > 0 ? standOf[c] : c;
						mass[stand[i]] += weight[i] * orbit[i];
					}
					for (let i = from; i < to; i++) {
						const c = combo[i];
						if (stand[i] !== c) {
							scale[i] = weight[i] = 0;
							continue;
						}
						// A candidate that had to stand for itself was fitted no weight: it keeps its own.
						const fit = fitted[c] > 0 ? fitted[c] / orbit[i] : weight[i];
						scale[i] = fit / mass[c];
						weight[i] = fit;
					}
				}
			}
			for (const [from, to] of spans) for (let i = from; i < to; i++) if (stand[i] === combo[i]) keptHands[round]++;
		}
	}
	start[slots] = at;
	try {
		RangeCompress.releaseMemory();
	} catch {
		// Nothing to let go of.
	}
	const trimmed = {
		combo: combo.slice(0, at), stand: stand.slice(0, at), orbit: orbit.slice(0, at), scale: scale.slice(0, at), weight: weight.slice(0, at),
	};
	return {
		tolerance: tolerance.slice(), rounds, start, ...trimmed, keptHands, candidates,
		bytes: start.byteLength + at * (2 + 2 + 1 + 4 + 4),
	};
}
