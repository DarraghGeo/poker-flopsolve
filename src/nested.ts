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
 * back (`traverse`, the chance branch). A kept hand so carries the reach of
 * every hand it stands for, whatever the ranges' weights are.
 *
 * The compressor is poker-rangecompress's, as for `compressRanges`.
 */

import { COMBO_CARDS, COMBOS, DECK, comboIndex, parseCard } from './cards.ts';
import type { PlayerIndex } from './cfr.ts';
import { evaluate } from './eval7.ts';
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
	/** For a kept candidate, the weight it carried when the sets were chosen, a hand; else 0. */
	readonly weight: Float32Array;
	/** Per player, 1 for each combination the sets were chosen for, the range's and its reserve's: the hands they cover. */
	readonly held: readonly [Uint8Array, Uint8Array];
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
 * plays it as, and on a river that deals that hand's card, the kept hand
 * nearest it in strength. Without kept sets on the round, each list entry's
 * own hands.
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
	// A final board's kept hands' strengths, worked out only if some hand needs them.
	let strengths: Int32Array | null = null;
	const suits = [0, 0, 0, 0];
	const strengthOn = (c: number): number => {
		const a = COMBO_CARDS[c * 2];
		const b = COMBO_CARDS[c * 2 + 1];
		const mine = [suits[0], suits[1], suits[2], suits[3]];
		mine[a & 3] |= 1 << (a >> 2);
		mine[b & 3] |= 1 << (b >> 2);
		return evaluate(mine[0], mine[1], mine[2], mine[3]);
	};
	for (let h = 0; h < COMBOS; h++) {
		if (out[h] >= 0 || above[h] < 0 || COMBO_CARDS[h * 2] === dealt || COMBO_CARDS[h * 2 + 1] === dealt) continue;
		const entry = parentFrom + above[h];
		for (let m = lists.memberStart[entry]; m < lists.memberStart[entry + 1]; m++) {
			if (out[lists.memberCombo[m]] >= 0) {
				out[h] = out[lists.memberCombo[m]];
				break;
			}
		}
		if (out[h] >= 0 || width !== 5 || count === 0) continue;
		// The card dealt holds every hand its parent plays it as: in the solve
		// its reach stops here, and to read it takes the kept hand nearest it
		// in strength, the best this board can say of it.
		if (strengths === null) {
			for (let i = 0; i < width; i++) suits[runouts.cards[round][board * width + i] & 3] |= 1 << (runouts.cards[round][board * width + i] >> 2);
			strengths = new Int32Array(count);
			for (let i = 0; i < count; i++) strengths[i] = strengthOn(lists.memberCombo[lists.memberStart[from + i]]);
		}
		const mine = strengthOn(h);
		let nearest = 0;
		for (let i = 1; i < count; i++) if (Math.abs(strengths[i] - mine) < Math.abs(strengths[nearest] - mine)) nearest = i;
		out[h] = nearest;
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


const strengthOf = new Int32Array(COMBOS);
const keyed = [new Float64Array(COMBOS), new Float64Array(COMBOS)];
const equityOf = new Float64Array(COMBOS);
const runCard = new Float64Array(DECK);
const tieCard = new Float64Array(DECK);
const allCard = new Float64Array(DECK);

/**
 * Kept sets for one river board, by clustering. With no card to come a hand
 * is its strength and its blockers. Each player's candidates are walked in
 * order of strength and gathered while two things stay within `width` of
 * each other: their equities against the other's arriving range, exact
 * under card removal, and what they block of each of `BANDS` bands of that
 * range, as a share of it. A cluster keeps the hand nearest its mean equity,
 * which then weighs what the whole cluster did. So the kept hands carry
 * exactly the weight that arrives, and a hand of the other player sees the
 * range it faces move only inside a cluster.
 */
function clusterRiver(
	board: Uint8Array,
	spans: readonly (readonly [number, number])[],
	arriving: readonly Float64Array[],
	width: number,
	combo: Uint16Array,
	stand: Uint16Array,
	orbit: Uint8Array,
	scale: Float32Array,
	weight: Float32Array,
): void {
	const suits = [0, 0, 0, 0];
	for (const card of board) suits[card & 3] |= 1 << (card >> 2);
	const strength = (c: number): number => {
		const a = COMBO_CARDS[c * 2];
		const b = COMBO_CARDS[c * 2 + 1];
		const mine = [suits[0], suits[1], suits[2], suits[3]];
		mine[a & 3] |= 1 << (a >> 2);
		mine[b & 3] |= 1 << (b >> 2);
		return evaluate(mine[0], mine[1], mine[2], mine[3]);
	};
	const onBoard = new Uint8Array(DECK);
	for (const card of board) onBoard[card] = 1;
	// Every real hand of each player that arrives, keyed by strength then combination.
	const counts = [0, 0];
	for (let player = 0; player < 2; player++) {
		const from = arriving[player];
		const keys = keyed[player];
		let n = 0;
		for (let c = 0; c < COMBOS; c++) {
			if (!(from[c] > 0) || onBoard[COMBO_CARDS[c * 2]] || onBoard[COMBO_CARDS[c * 2 + 1]]) continue;
			strengthOf[c] = strength(c);
			keys[n++] = strengthOf[c] * 2048 + c;
		}
		keys.subarray(0, n).sort();
		counts[player] = n;
	}
	for (let player = 0; player < 2; player++) {
		const [from, to] = spans[player];
		if (to - from < 2) continue;
		const mine = keyed[player];
		const theirs = keyed[1 - player];
		const theirWeight = arriving[1 - player];
		const nTheirs = counts[1 - player];
		// Their mass in all and through each card.
		let all = 0;
		allCard.fill(0);
		for (let j = 0; j < nTheirs; j++) {
			const c = theirs[j] % 2048;
			const w = theirWeight[c];
			all += w;
			allCard[COMBO_CARDS[c * 2]] += w;
			allCard[COMBO_CARDS[c * 2 + 1]] += w;
		}
		// Their range in bands of equal weight by strength, and each band's mass through each card: what a hand of mine blocks of each.
		bandCard.fill(0);
		let before = 0;
		for (let j = 0; j < nTheirs; j++) {
			const c = theirs[j] % 2048;
			const w = theirWeight[c];
			const band = Math.min(BANDS - 1, Math.floor((BANDS * (before + w / 2)) / all));
			before += w;
			bandOf[c] = band;
			bandCard[band * DECK + COMBO_CARDS[c * 2]] += w;
			bandCard[band * DECK + COMBO_CARDS[c * 2 + 1]] += w;
		}
		// Each of my hands' equity, exact under card removal, in one sweep by strength.
		runCard.fill(0);
		let run = 0;
		let below = 0;
		let tieFrom = 0;
		let tieTo = 0;
		let tie = 0;
		let tieStrength = -1;
		for (let i = 0; i < counts[player]; i++) {
			const c = mine[i] % 2048;
			const s = strengthOf[c];
			if (s !== tieStrength) {
				// Theirs below this strength join the running sums; theirs at it are the ties.
				for (let j = tieFrom; j < tieTo; j++) tieCard[COMBO_CARDS[(theirs[j] % 2048) * 2]] = tieCard[COMBO_CARDS[(theirs[j] % 2048) * 2 + 1]] = 0;
				while (below < nTheirs && strengthOf[theirs[below] % 2048] < s) {
					const o = theirs[below++] % 2048;
					const w = theirWeight[o];
					run += w;
					runCard[COMBO_CARDS[o * 2]] += w;
					runCard[COMBO_CARDS[o * 2 + 1]] += w;
				}
				tieFrom = below;
				tieTo = below;
				tie = 0;
				while (tieTo < nTheirs && strengthOf[theirs[tieTo] % 2048] === s) {
					const o = theirs[tieTo++] % 2048;
					const w = theirWeight[o];
					tie += w;
					tieCard[COMBO_CARDS[o * 2]] += w;
					tieCard[COMBO_CARDS[o * 2 + 1]] += w;
				}
				tieStrength = s;
			}
			const a = COMBO_CARDS[c * 2];
			const b = COMBO_CARDS[c * 2 + 1];
			// The very same combination, if they hold it, went out through both cards.
			const same = theirWeight[c] > 0 ? theirWeight[c] : 0;
			const live = all - allCard[a] - allCard[b] + same;
			const lower = run - runCard[a] - runCard[b];
			const level = tie - tieCard[a] - tieCard[b] + same;
			equityOf[c] = live > 0 ? (lower + level / 2) / live : 0.5;
		}
		for (let j = tieFrom; j < tieTo; j++) tieCard[COMBO_CARDS[(theirs[j] % 2048) * 2]] = tieCard[COMBO_CARDS[(theirs[j] % 2048) * 2 + 1]] = 0;
		// Where each candidate sits, to walk them in order of strength.
		for (let i = from; i < to; i++) slotOf[combo[i]] = i;
		let low = 0;
		let high = 0;
		const members: number[] = [];
		const close = (): void => {
			if (members.length === 0) return;
			let massSum = 0;
			let mean = 0;
			for (const i of members) {
				const m = weight[i] * orbit[i];
				massSum += m;
				mean += m * equityOf[combo[i]];
			}
			mean /= massSum;
			let keep = members[0];
			for (const i of members) if (Math.abs(equityOf[combo[i]] - mean) < Math.abs(equityOf[combo[keep]] - mean)) keep = i;
			for (const i of members) {
				stand[i] = combo[keep];
				if (i !== keep) scale[i] = weight[i] = 0;
			}
			scale[keep] = 1 / orbit[keep];
			weight[keep] = massSum / orbit[keep];
			members.length = 0;
		};
		for (let k = 0; k < counts[player]; k++) {
			const c = mine[k] % 2048;
			const i = slotOf[c];
			if (i < from || i >= to || combo[i] !== c) continue;
			const e = equityOf[c];
			// What it blocks of each band, as a share of their range.
			const a = COMBO_CARDS[c * 2];
			const b = COMBO_CARDS[c * 2 + 1];
			let apart = members.length > 0 && Math.max(high, e) - Math.min(low, e) > width;
			for (let band = 0; band < BANDS; band++) {
				const blocks = (bandCard[band * DECK + a] + bandCard[band * DECK + b] - (theirWeight[c] > 0 && bandOf[c] === band ? theirWeight[c] : 0)) / all;
				blockOf[band] = blocks;
				if (members.length > 0 && Math.max(bandHigh[band], blocks) - Math.min(bandLow[band], blocks) > width) apart = true;
			}
			if (apart) close();
			if (members.length === 0) {
				low = high = e;
				for (let band = 0; band < BANDS; band++) bandLow[band] = bandHigh[band] = blockOf[band];
			} else {
				if (e < low) low = e;
				if (e > high) high = e;
				for (let band = 0; band < BANDS; band++) {
					if (blockOf[band] < bandLow[band]) bandLow[band] = blockOf[band];
					if (blockOf[band] > bandHigh[band]) bandHigh[band] = blockOf[band];
				}
			}
			members.push(i);
		}
		close();
	}
}
const slotOf = new Int32Array(COMBOS).fill(-1);
/**
 * Bands the other range is cut in for what a hand blocks. Two hands of one
 * equity can block different parts of it, and so bluff and call differently:
 * clustered on equity alone, a turn spot was 2.5% of pot exploitable in the
 * full game with 43% of its river hands kept, and with eight bands 1.8% with
 * 44% (bench/street-compression).
 */
const BANDS = 8;
const bandCard = new Float64Array(BANDS * DECK);
const bandOf = new Int8Array(COMBOS);
const blockOf = new Float64Array(BANDS);
const bandLow = new Float64Array(BANDS);
const bandHigh = new Float64Array(BANDS);

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
 * @param chosenFor per player, the weights the sets are chosen for: the
 *   range's own by default. A hand held in reserve (`SpotConfig.oopReserve`)
 *   is given its reserve weight here, so that it has a stand-in on every
 *   board before the range holds it, and can be given weight in place.
 * @returns null when no round has a tolerance
 */
export function chooseKeptSets(
	runouts: Runouts,
	players: readonly [PlayerIndex, PlayerIndex],
	tolerance: readonly number[],
	chosenFor: readonly [Float64Array, Float64Array] = [players[0].weights, players[1].weights],
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
		// A river board has no cards to come: its hands are ordered by strength, and are clustered by equity.
		const clustered = width === 5;
		let lastParent = -1;
		for (let board = 0; board < runouts.counts[round]; board++) {
			const parent = runouts.parent[round][board];
			if (parent !== lastParent) {
				// Boards of one parent are stored together: its hands' weights once.
				lastParent = parent;
				for (let player = 0; player < 2; player++) {
					const into = arriving[player];
					if (!rounds[round - 1]) {
						into.set(chosenFor[player]);
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
					if (tol > 0 && !clustered) {
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
			if (tol > 0 && clustered) {
				clusterRiver(cards.subarray(board * width, (board + 1) * width), spans, arriving, tol, combo, stand, orbit, scale, weight);
			} else if (tol > 0 && hands[0].length >= 3 && hands[1].length >= 3) {
				const out = RangeCompress.compressBoth({
					oop: hands[0], ip: hands[1], board: Array.from(cards.subarray(board * width, (board + 1) * width), (card) => TO_VENDOR[card]),
					tolerance: tol, standIns: 1,
				} as unknown as Parameters<typeof RangeCompress.compressBoth>[0]);
				for (let player = 0; player < 2; player++) {
					const result = (player === 0 ? out.oop : out.ip) as unknown as {
						hands: readonly { hand: string; weight: number }[];
						standIns: Readonly<Record<string, readonly string[]>>;
					};
					const [from, to] = spans[player];
					// Which candidates the compressor kept, by leader.
					for (let i = from; i < to; i++) fitted[combo[i]] = mass[combo[i]] = 0;
					for (const { hand } of result.hands) fitted[leaderOf[comboOf(hand)]] = 1;
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
						// A kept hand weighs what the hands it stands for did: the
						// compressor's own fitted weights measured 0.3 to 0.5% of pot
						// more exploitable in the full game, and this way the scale
						// does not depend on the ranges' weights.
						scale[i] = 1 / orbit[i];
						weight[i] = mass[c] / orbit[i];
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
		held: [Uint8Array.from(chosenFor[0], (w) => (w > 0 ? 1 : 0)), Uint8Array.from(chosenFor[1], (w) => (w > 0 ? 1 : 0))],
		bytes: start.byteLength + at * (2 + 2 + 1 + 4 + 4),
	};
}
