/**
 * Hand classes tied on every street (issue #40), as a measurement.
 *
 * A class is a set of hands one strategy would serve: same rank pair, same
 * suitedness, and the same count of reference-board cards sharing each hole
 * card's suit. Two references are measured:
 *
 * - `flop`: the flop's three cards on every street, as #28 counted and #31
 *   proposed. Classes are fixed at the flop, so on a heart turn a hearts
 *   draw and an off-suit hand of the same ranks share one strategy.
 * - `board`: the cards of the board the decision is on. Finer, because it
 *   keeps flush draws and made flushes apart from the rest.
 *
 * `tie` overwrites every member's regrets and strategy sums with its class's
 * mean, weighted by how many hands each packed entry stands for. Called
 * after each iteration, it leaves every decision playing one strategy per
 * class, while payoffs and card removal stay exact. That is the best case
 * for a class engine, which would also have to average each class's blocked
 * mass, so the accuracy measured here is a floor such an engine can only
 * match or miss.
 *
 * Tying after the iteration rather than inside each update is not quite CFR
 * on the class game: DCFR discounts a member's positive and negative regrets
 * differently, and members drift apart in sign within one iteration. Every
 * decision still plays one strategy per class, which is what is measured.
 */

import { COMBO_CARDS, rankOf, suitOf } from '../../src/cards.ts';
import type { Context } from '../../src/cfr.ts';

export type Reference = 'flop' | 'board';

export interface Classes {
	/** Each active-list entry's class within its list, beside `active.list`. */
	readonly classOf: Int32Array;
	/** Each list's first class in `weight`, indexed by list slot; one past the end last. */
	readonly classStart: Int32Array;
	/** Hands each class stands for, summed over its members' multiplicities. */
	readonly weight: Float64Array;
	/** Entries (packed) and classes on the final round's boards, both players. */
	readonly riverEntries: number;
	readonly riverClasses: number;
}

/** The class key of hole cards `a`, `b` against `suitCount` (cards per suit). */
export function classKey(a: number, b: number, suitCount: ArrayLike<number>): number {
	let ra = rankOf(a);
	let rb = rankOf(b);
	let na = suitCount[suitOf(a)];
	let nb = suitCount[suitOf(b)];
	const suited = suitOf(a) === suitOf(b) ? 1 : 0;
	// Higher rank first; a pair puts the larger count first.
	if (rb > ra || (ra === rb && nb > na)) {
		[ra, rb] = [rb, ra];
		[na, nb] = [nb, na];
	}
	return ((((ra * 13 + rb) * 2 + suited) * 6 + na) * 6) + nb;
}

export function buildClasses(ctx: Context, reference: Reference): Classes {
	const { runouts, active } = ctx;
	const slots = active.roundBase[runouts.rounds] * 2;
	const classOf = new Int32Array(active.list.length);
	const classStart = new Int32Array(slots + 1);
	const weights: number[] = [];
	const suitCount = new Int32Array(4);
	let riverEntries = 0;
	let riverClasses = 0;
	for (let round = 0; round < runouts.rounds; round++) {
		const width = runouts.width[round];
		const cards = runouts.cards[round];
		const counted = reference === 'flop' ? runouts.width[0] : width;
		for (let board = 0; board < runouts.counts[round]; board++) {
			suitCount.fill(0);
			for (let i = 0; i < counted; i++) suitCount[suitOf(cards[board * width + i])]++;
			for (let player = 0; player < 2; player++) {
				const slot = (active.roundBase[round] + board) * 2 + player;
				classStart[slot] = weights.length;
				const index = new Map<number, number>();
				for (let e = active.start[slot]; e < active.start[slot] + active.count[slot]; e++) {
					const combo = active.list[e];
					const key = classKey(COMBO_CARDS[combo * 2], COMBO_CARDS[combo * 2 + 1], suitCount);
					let c = index.get(key);
					if (c === undefined) {
						c = index.size;
						index.set(key, c);
						weights.push(0);
					}
					classOf[e] = c;
					weights[classStart[slot] + c] += active.multiplicity[e];
				}
				if (round === runouts.rounds - 1) {
					riverEntries += active.count[slot];
					riverClasses += index.size;
				}
			}
		}
	}
	classStart[slots] = weights.length;
	return { classOf, classStart, weight: Float64Array.from(weights), riverEntries, riverClasses };
}

/**
 * Set every hand's regrets and strategy sums to its class's weighted mean,
 * at every decision node on every stored board.
 */
export function tie(ctx: Context, classes: Classes): void {
	const { tree, layout, active, runouts } = ctx;
	const regret = ctx.regret as Float32Array | Float64Array;
	const sum = ctx.strategySum as Float32Array | Float64Array;
	if (ctx.regretScale) throw new Error('tie needs float storage');
	const acc = new Float64Array(1326);
	for (const node of tree.decisionNodes) {
		const round = tree.round[node];
		const player = tree.player[node];
		const actions = tree.numEdges[node];
		for (let board = 0; board < runouts.counts[round]; board++) {
			const slot = (layout.roundBase[round] + board) * 2 + player;
			const n = active.count[slot];
			const first = active.start[slot];
			const cBase = classes.classStart[slot];
			const nClasses = classes.classStart[slot + 1] - cBase;
			if (nClasses === n) continue;
			const base = layout.offset[node] + actions * layout.rowStart[slot];
			for (const store of [regret, sum]) {
				for (let a = 0; a < actions; a++) {
					const row = base + a * n;
					acc.fill(0, 0, nClasses);
					for (let i = 0; i < n; i++) acc[classes.classOf[first + i]] += store[row + i] * active.multiplicity[first + i];
					for (let c = 0; c < nClasses; c++) acc[c] /= classes.weight[cBase + c];
					for (let i = 0; i < n; i++) store[row + i] = acc[classes.classOf[first + i]];
				}
			}
		}
	}
}
