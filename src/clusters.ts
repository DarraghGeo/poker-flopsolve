/**
 * Runout clusters: potential-aware card abstraction of turn and river cards.
 *
 * Purpose: decide which dealt cards a stored card stands for when they are
 * merely alike — not mirror images, not clean rank swaps — and how each
 * player's hands map onto the stored card's.
 *
 * Each candidate card is described by what it does to both ranges: the
 * distribution of each range's river equity after it (over every river still
 * to come, from a flop; on the final board, from a turn), and whether it
 * changes the board's flush, straight or pair texture. Cards are grouped by
 * k-medoids under the earth mover's distance between those distributions
 * (Ganzfried & Sandholm, AAAI 2014), weighted by how many real deals each
 * stands for. The medoid is the stored card.
 *
 * A member whose rank swap with the medoid keeps both ranges closed is
 * relabelled by that swap, exactly as runout buckets are. Any other member is
 * relabelled by swapping the two cards alone, and its hands map onto the
 * medoid's by rank order of strength: each hand goes to the medoid hand at
 * the same quantile of its range's weight.
 *
 * Experimental, opt-in through `SpotConfig.runoutClusters`.
 */

import { COMBO_CARDS, COMBOS, comboIndex, DECK, formatCards } from './cards.ts';
import type { PlayerIndex } from './cfr.ts';
import { evaluateCards } from './eval7.ts';
import type { CardMaps } from './abstraction.ts';
import { rankSwap } from './runouts.ts';
import type { Runouts } from './runouts.ts';

/** No combination: the hand cannot be held on that deal. */
export const NO_COMBO = 0xffff;

/** How many stored cards to keep where clustering applies. */
export interface ClusterCounts {
	/** Stored turn cards per flop; unset keeps every turn. */
	readonly turn?: number;
	/** Stored river cards per stored turn; unset keeps every river. */
	readonly river?: number;
	/**
	 * How hands on a merged card map onto the stored card's where no rank
	 * swap fits: 'strength' (the default) by rank order of mean river
	 * equity; 'identity' as themselves, by rank order only for hands the
	 * stored card blocks.
	 */
	readonly hands?: 'strength' | 'identity';
}

/** A candidate dealt card, as `enumerateRunouts` has it. */
export interface ClusterChild {
	readonly card: number;
	/** Real deals it stands for: cards and their maps onto it. */
	readonly maps: number[];
	readonly cards: number[];
	/** Per-player hand maps of each of those deals, or null for the card map's own. */
	readonly combos: (readonly [Uint16Array, Uint16Array] | null)[];
	merged: boolean;
}

/** Counters for what clustering did, for measurement. */
export interface ClusterStats {
	/** Cards folded into another by an exact rank swap. */
	exact: number;
	/** Cards folded in by rank order of strength, no relabelling fitting. */
	approximate: number;
}

/** Bins of the equity histograms. */
const BINS = 20;
/** Distance added per texture feature that differs (flush, straight, pair). */
const TEXTURE_PENALTY = 0.5;

export class RunoutClusterer {
	readonly stats: ClusterStats = { exact: 0, approximate: 0 };
	private readonly allowed: Uint8Array;

	constructor(
		readonly players: readonly [PlayerIndex, PlayerIndex],
		readonly counts: ClusterCounts,
	) {
		this.allowed = rangeSwaps(players);
	}

	/** Whether children of a board with this many cards are clustered. */
	applies(parentWidth: number): boolean {
		const k = parentWidth === 3 ? this.counts.turn : parentWidth === 4 ? this.counts.river : undefined;
		return k !== undefined;
	}

	/**
	 * Fold children of one board into clusters, in place: merged children are
	 * marked, and their deals join the medoid's with maps composed.
	 */
	cluster(parent: readonly number[], children: ClusterChild[], maps: CardMaps): void {
		const k = parent.length === 3 ? this.counts.turn : this.counts.river;
		if (k === undefined || k >= children.length) return;
		const features = children.map((child) => this.features(parent, child.card));
		const n = children.length;
		const dist = new Float64Array(n * n);
		for (let i = 0; i < n; i++) {
			for (let j = i + 1; j < n; j++) {
				dist[i * n + j] = dist[j * n + i] = distance(features[i], features[j]);
			}
		}
		const weight = children.map((child) => child.maps.length);
		const medoids = kMedoids(dist, weight, n, Math.max(1, k));
		const isMedoid = new Uint8Array(n);
		for (const m of medoids) isMedoid[m] = 1;

		const boardRanks = new Set(parent.map((card) => card >> 2));
		for (let j = 0; j < n; j++) {
			if (isMedoid[j]) continue;
			let best = medoids[0];
			for (const m of medoids) if (dist[j * n + m] < dist[j * n + best]) best = m;
			const into = children[best];
			const from = children[j];
			const rankI = into.card >> 2;
			const rankJ = from.card >> 2;
			const exact =
				(into.card & 3) === (from.card & 3) &&
				!boardRanks.has(rankI) && !boardRanks.has(rankJ) &&
				this.allowed[rankI * 13 + rankJ] === 1;
			// Either way the card map sends this card onto the medoid and fixes
			// the board; only an exact swap carries hands with it.
			const swap = maps.add(exact ? rankSwap(rankI, rankJ) : transposition(from.card, into.card));
			const handMaps = exact ? null : this.handMaps(parent, from.card, into.card, features[j], features[best]);
			for (let m = 0; m < from.maps.length; m++) {
				into.maps.push(maps.then(from.maps[m], swap));
				into.cards.push(from.cards[m]);
				const own = from.combos[m];
				if (handMaps === null && own === null) {
					into.combos.push(null);
					continue;
				}
				// Real hand, through the deal's own map, then onto the medoid.
				const first = maps.combo[from.maps[m]];
				const second = maps.combo[swap];
				const out: [Uint16Array, Uint16Array] = [new Uint16Array(COMBOS), new Uint16Array(COMBOS)];
				for (let p = 0; p < 2; p++) {
					for (let h = 0; h < COMBOS; h++) {
						const mid = own === null ? first[h] : own[p][h];
						out[p][h] = mid === NO_COMBO ? NO_COMBO : handMaps === null ? second[mid] : handMaps[p][mid];
					}
				}
				into.combos.push(out);
			}
			from.merged = true;
			if (exact) this.stats.exact++;
			else this.stats.approximate++;
		}
	}

	/** Each player's hands on `from`, mapped by strength order onto `into`'s. */
	private handMaps(
		parent: readonly number[],
		from: number,
		into: number,
		fromFeatures: Features,
		intoFeatures: Features,
	): [Uint16Array, Uint16Array] {
		const out: [Uint16Array, Uint16Array] = [new Uint16Array(COMBOS).fill(NO_COMBO), new Uint16Array(COMBOS).fill(NO_COMBO)];
		for (let p = 0; p < 2; p++) {
			const source = sortedByStrength(this.players[p], [...parent, from], fromFeatures.strength[p]);
			const target = sortedByStrength(this.players[p], [...parent, into], intoFeatures.strength[p]);
			const sourceTotal = source.reduce((s, x) => s + x.weight, 0);
			const targetTotal = target.reduce((s, x) => s + x.weight, 0);
			let t = 0;
			let targetBelow = 0;
			let sourceBelow = 0;
			for (const hand of source) {
				const q = (sourceBelow + hand.weight / 2) / sourceTotal;
				sourceBelow += hand.weight;
				while (t < target.length - 1 && (targetBelow + target[t].weight) / targetTotal < q) {
					targetBelow += target[t].weight;
					t++;
				}
				out[p][hand.combo] = target[t].combo;
			}
			if (this.counts.hands === 'identity') {
				for (const hand of source) {
					const a = COMBO_CARDS[hand.combo * 2];
					const b = COMBO_CARDS[hand.combo * 2 + 1];
					if (a !== into && b !== into) out[p][hand.combo] = hand.combo;
				}
			}
		}
		return out;
	}

	/** What a dealt card does to both ranges. */
	private features(parent: readonly number[], card: number): Features {
		const board = [...parent, card];
		const used = new Uint8Array(DECK);
		for (const c of board) used[c] = 1;
		const strength: [Float64Array, Float64Array] = [new Float64Array(COMBOS), new Float64Array(COMBOS)];
		const histogram: [Float64Array, Float64Array] = [new Float64Array(BINS), new Float64Array(BINS)];
		const rivers: number[][] = [];
		if (board.length === 5) rivers.push(board);
		else for (let river = 0; river < DECK; river++) if (!used[river]) rivers.push([...board, river]);
		const counted: [Float64Array, Float64Array] = [new Float64Array(COMBOS), new Float64Array(COMBOS)];
		for (const final of rivers) {
			const equity = finalEquities(this.players, final);
			for (let p = 0; p < 2; p++) {
				for (const [combo, value, weight] of equity[p]) {
					if (COMBO_CARDS[combo * 2] === card || COMBO_CARDS[combo * 2 + 1] === card) continue;
					strength[p][combo] += value;
					counted[p][combo] += 1;
					histogram[p][Math.min(BINS - 1, Math.floor(value * BINS))] += weight;
				}
			}
		}
		for (let p = 0; p < 2; p++) {
			for (let h = 0; h < COMBOS; h++) if (counted[p][h] > 0) strength[p][h] /= counted[p][h];
			let total = 0;
			for (const x of histogram[p]) total += x;
			if (total > 0) for (let b = 0; b < BINS; b++) histogram[p][b] /= total;
		}
		return { strength, histogram, texture: texture(parent, card) };
	}
}

interface Features {
	/** Each live hand's mean river equity, per player. */
	readonly strength: readonly [Float64Array, Float64Array];
	/** Each player's distribution of river equity, normalised. */
	readonly histogram: readonly [Float64Array, Float64Array];
	readonly texture: readonly number[];
}

/** Earth mover's distance between the players' histograms, plus texture changes. */
function distance(a: Features, b: Features): number {
	let total = 0;
	for (let p = 0; p < 2; p++) {
		let carry = 0;
		for (let bin = 0; bin < BINS; bin++) {
			carry += a.histogram[p][bin] - b.histogram[p][bin];
			total += Math.abs(carry) / BINS;
		}
	}
	for (let i = 0; i < a.texture.length; i++) if (a.texture[i] !== b.texture[i]) total += TEXTURE_PENALTY;
	return total;
}

/**
 * Whether the dealt card makes a flush draw or flush possible, a straight
 * possible, or pairs the board — compared, not added, between candidates.
 */
function texture(parent: readonly number[], card: number): number[] {
	const suited = parent.filter((c) => (c & 3) === (card & 3)).length + 1;
	const pairs = parent.some((c) => c >> 2 === card >> 2) ? 1 : 0;
	const ranks = new Set([...parent, card].map((c) => c >> 2));
	const before = new Set(parent.map((c) => c >> 2));
	const window = (set: Set<number>): number => {
		let best = 0;
		for (let low = -1; low <= 8; low++) {
			let count = 0;
			for (let r = low; r <= low + 4; r++) if (set.has(r === -1 ? 12 : r)) count++;
			best = Math.max(best, count);
		}
		return best;
	};
	return [Math.min(suited, 3), pairs, Math.min(window(ranks), 3) - Math.min(window(before), 3)];
}

/** Each player's equity against the other's range on a final board, ignoring card removal. */
function finalEquities(
	players: readonly [PlayerIndex, PlayerIndex],
	board: readonly number[],
): [Array<[number, number, number]>, Array<[number, number, number]>] {
	const onBoard = new Uint8Array(DECK);
	for (const c of board) onBoard[c] = 1;
	const scored = players.map((player) => {
		const out: Array<[number, number, number]> = [];
		for (let i = 0; i < player.count; i++) {
			const combo = player.combos[i];
			const a = COMBO_CARDS[combo * 2];
			const b = COMBO_CARDS[combo * 2 + 1];
			if (onBoard[a] || onBoard[b]) continue;
			out.push([combo, evaluateCards([...board, a, b]), player.weights[combo]]);
		}
		out.sort((x, y) => x[1] - y[1]);
		return out;
	});
	const result: [Array<[number, number, number]>, Array<[number, number, number]>] = [[], []];
	for (let p = 0; p < 2; p++) {
		const opp = scored[1 - p];
		let total = 0;
		for (const x of opp) total += x[2];
		let o = 0;
		let below = 0;
		for (const [combo, value, weight] of scored[p]) {
			while (o < opp.length && opp[o][1] < value) below += opp[o++][2];
			let equal = 0;
			for (let e = o; e < opp.length && opp[e][1] === value; e++) equal += opp[e][2];
			result[p].push([combo, total > 0 ? (below + equal / 2) / total : 0.5, weight]);
		}
	}
	return result;
}

/** A player's hands live on a board, weakest first by mean equity. */
function sortedByStrength(
	player: PlayerIndex,
	board: readonly number[],
	strength: Float64Array,
): { combo: number; weight: number }[] {
	const onBoard = new Uint8Array(DECK);
	for (const c of board) onBoard[c] = 1;
	const out: { combo: number; weight: number; s: number }[] = [];
	for (let i = 0; i < player.count; i++) {
		const combo = player.combos[i];
		if (onBoard[COMBO_CARDS[combo * 2]] || onBoard[COMBO_CARDS[combo * 2 + 1]]) continue;
		out.push({ combo, weight: player.weights[combo], s: strength[combo] });
	}
	out.sort((a, b) => a.s - b.s || a.combo - b.combo);
	return out;
}

/** The card map swapping two cards and fixing every other. */
function transposition(a: number, b: number): Uint8Array {
	const out = new Uint8Array(DECK);
	for (let card = 0; card < DECK; card++) out[card] = card === a ? b : card === b ? a : card;
	return out;
}

/** Which rank swaps keep both ranges closed, as a 13×13 table. */
function rangeSwaps(players: readonly [PlayerIndex, PlayerIndex]): Uint8Array {
	const allowed = new Uint8Array(13 * 13);
	for (let a = 0; a < 13; a++) {
		for (let b = a; b < 13; b++) {
			const map = rankSwap(a, b);
			let ok = true;
			for (const player of players) {
				for (let i = 0; ok && i < player.count; i++) {
					const combo = player.combos[i];
					if (player.slot[comboIndex(map[COMBO_CARDS[combo * 2]], map[COMBO_CARDS[combo * 2 + 1]])] < 0) ok = false;
				}
			}
			allowed[a * 13 + b] = allowed[b * 13 + a] = ok ? 1 : 0;
		}
	}
	return allowed;
}

/**
 * Weighted k-medoids: greedy build, then swaps while any lowers the cost.
 * Deterministic, ties to the lower index.
 */
export function kMedoids(dist: Float64Array, weight: readonly number[], n: number, k: number): number[] {
	const cost = (medoids: number[]): number => {
		let total = 0;
		for (let j = 0; j < n; j++) {
			let best = Infinity;
			for (const m of medoids) best = Math.min(best, dist[j * n + m]);
			total += weight[j] * best;
		}
		return total;
	};
	const medoids: number[] = [];
	while (medoids.length < k) {
		let bestCost = Infinity;
		let bestCandidate = -1;
		for (let c = 0; c < n; c++) {
			if (medoids.includes(c)) continue;
			const value = cost([...medoids, c]);
			if (value < bestCost) {
				bestCost = value;
				bestCandidate = c;
			}
		}
		medoids.push(bestCandidate);
	}
	let current = cost(medoids);
	for (let improved = true; improved; ) {
		improved = false;
		for (let i = 0; i < k; i++) {
			for (let c = 0; c < n; c++) {
				if (medoids.includes(c)) continue;
				const trial = medoids.slice();
				trial[i] = c;
				const value = cost(trial);
				if (value < current - 1e-12) {
					medoids[i] = c;
					current = value;
					improved = true;
				}
			}
		}
	}
	return medoids.sort((a, b) => a - b);
}

/** A real board, as a clustered solve stores it: one hand map per player. */
export interface ClusteredBoard {
	readonly round: number;
	readonly board: number;
	/**
	 * Real combination to the stored one each player's hand plays as, or
	 * `NO_COMBO` where the player cannot hold it on the real board.
	 */
	readonly combos: readonly [Uint16Array, Uint16Array];
}

/**
 * Find the stored board standing for a real one, with clusters.
 *
 * Like `resolveBoard`, through every deal's map in turn; hand maps compose
 * with card maps. A hand map fixed at the turn can send a hand onto one a
 * later stored card blocks; such a hand, and any left without a target, plays
 * as the stored hand at its quantile of strength on the board.
 */
export function resolveClustered(
	runouts: Runouts,
	players: readonly [PlayerIndex, PlayerIndex],
	board: readonly number[],
): ClusteredBoard {
	const start = runouts.initial.length;
	let index = 0;
	let map = 0;
	const combos: [Uint16Array, Uint16Array] = [new Uint16Array(COMBOS), new Uint16Array(COMBOS)];
	for (let h = 0; h < COMBOS; h++) combos[0][h] = combos[1][h] = h;
	for (let i = start; i < board.length; i++) {
		const round = i - start + 1;
		const dealt = runouts.maps.card[map][board[i]];
		let found = -1;
		for (let child = runouts.childStart[round][index]; child < runouts.childStart[round][index + 1] && found < 0; child++) {
			for (let m = runouts.orbitStart[round][child]; m < runouts.orbitStart[round][child + 1]; m++) {
				if (runouts.orbitCard[round][m] !== dealt) continue;
				found = child;
				const own = runouts.orbitCombos?.[round]?.[m] ?? null;
				const cardCombos = runouts.maps.combo[runouts.orbitMap[round][m]];
				for (let p = 0; p < 2; p++) {
					const step = own ? own[p] : cardCombos;
					for (let h = 0; h < COMBOS; h++) {
						const at = combos[p][h];
						combos[p][h] = at === NO_COMBO ? NO_COMBO : step[at];
					}
				}
				map = runouts.maps.then(map, runouts.orbitMap[round][m]);
				break;
			}
		}
		if (found < 0) throw new Error(`${formatCards(board)} deals a card already on the board`);
		index = found;
	}
	const round = board.length - start;
	const stored = Array.from(runouts.cards[round].subarray(index * runouts.width[round], (index + 1) * runouts.width[round]));
	for (let p = 0; p < 2; p++) repair(players[p], board, stored, combos[p]);
	return { round, board: index, combos };
}

/** Send every hand live on the real board to one live on the stored board. */
function repair(player: PlayerIndex, real: readonly number[], stored: readonly number[], map: Uint16Array): void {
	const blockedBy = (cards: readonly number[]): Uint8Array => {
		const out = new Uint8Array(DECK);
		for (const c of cards) out[c] = 1;
		return out;
	};
	const realBoard = blockedBy(real);
	const storedBoard = blockedBy(stored);
	const live = (combo: number, onBoard: Uint8Array): boolean =>
		player.slot[combo] >= 0 && !onBoard[COMBO_CARDS[combo * 2]] && !onBoard[COMBO_CARDS[combo * 2 + 1]];
	const broken: number[] = [];
	for (let i = 0; i < player.count; i++) {
		const h = player.combos[i];
		if (!live(h, realBoard)) {
			map[h] = NO_COMBO;
			continue;
		}
		if (map[h] === NO_COMBO || !live(map[h], storedBoard)) broken.push(h);
	}
	if (broken.length === 0) return;
	const strength = (combo: number, cards: readonly number[]): number =>
		cards.length >= 3 ? evaluateCards([...cards, COMBO_CARDS[combo * 2], COMBO_CARDS[combo * 2 + 1]]) : 0;
	const order = (onBoard: Uint8Array, cards: readonly number[]): { combo: number; s: number; w: number }[] => {
		const out: { combo: number; s: number; w: number }[] = [];
		for (let i = 0; i < player.count; i++) {
			const h = player.combos[i];
			if (live(h, onBoard)) out.push({ combo: h, s: strength(h, cards), w: player.weights[h] });
		}
		return out.sort((a, b) => a.s - b.s || a.combo - b.combo);
	};
	const source = order(realBoard, real);
	const target = order(storedBoard, stored);
	const quantile = new Map<number, number>();
	const sourceTotal = source.reduce((s, x) => s + x.w, 0);
	let below = 0;
	for (const x of source) {
		quantile.set(x.combo, (below + x.w / 2) / sourceTotal);
		below += x.w;
	}
	const targetTotal = target.reduce((s, x) => s + x.w, 0);
	for (const h of broken) {
		const q = quantile.get(h) ?? 0.5;
		let t = 0;
		let acc = 0;
		while (t < target.length - 1 && (acc + target[t].w) / targetTotal < q) acc += target[t++].w;
		map[h] = target[t].combo;
	}
}
