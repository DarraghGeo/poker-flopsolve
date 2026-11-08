/**
 * Depth-limited solving with multi-continuation leaves.
 *
 * Purpose: the leaf values of a tree cut at the deal of a later street, after
 * Brown, Sandholm & Amos, "Depth-Limited Solving for Imperfect-Information
 * Games" (NeurIPS 2018). Opt-in through `SpotConfig.depthLimit`; nothing else
 * reaches this file.
 *
 * At a `Continuation` leaf each player chooses, per hand, one of `k` fixed
 * strategies for the rest of the hand, without seeing the other's choice. The
 * choice is a decision CFR trains like any other — its regrets and sums sit in
 * the layout beside the leaf, a block per player and board — and its values
 * come from playing every pair of continuations out on every runout.
 *
 * A continuation checks through any street before the last and plays the last
 * as a small fixed river: the first player bets the leaf's one size or checks;
 * checked to, the second may bet; facing a bet, a hand calls or folds. Whether
 * a hand bets or calls depends only on its percentile within its own starting
 * range on that final board, so a continuation is a strategy fixed in advance,
 * and every leaf value is linear in the opponent's reach, as CFR needs.
 *
 * The cost is a handful of terminal passes per final board — one showdown
 * per sequence of the small river, two folds — whatever `k` is: the
 * opponent's mixture over their continuations goes into their reach for each
 * sequence, and the traverser's continuations only reweight the results.
 */

import { COMBOS, DECK } from './cards.ts';
import type { Context, RegretStore, SumStore } from './cfr.ts';
import { dcfrFactors, Mode, tieMirrors } from './cfr.ts';
import { foldValuesHands, showdownValuesHands } from './hands.ts';

/**
 * One fixed way to play the rest of the hand, by each hand's percentile `q`
 * within its player's starting range on the final board (0 weakest, 1
 * strongest). Bet size `B` into pot `P`; `α = B / (P + 2B)` is the bluff
 * share that makes a caller indifferent, `P / (P + B)` the minimum defence.
 */
export interface ContinuationRule {
	/** Bet for value with the top `value` of the range. */
	readonly value: number;
	/** Bluff with the bottom `value · bluff · α / (1 − α)`: 1 balanced, 0 none. */
	readonly bluff: number;
	/**
	 * Facing a bet, call with the top `call · P / (P + B)` of the range (1 is
	 * the minimum defence frequency), capped at everything.
	 */
	readonly call: number;
	/** Call with the top `callTop` of the range instead, ignoring `call`. */
	readonly callTop?: number;
}

/** The continuations offered by name. */
export const CONTINUATIONS = {
	/** Never bet; call a bet by the minimum defence frequency. */
	checkdown: { value: 0, bluff: 0, call: 1 },
	/** Value-bet the top 30%, bluff in balance, call by the minimum defence. */
	polar: { value: 0.3, bluff: 1, call: 1 },
	/** `polar` betting half as often again. */
	'polar-bias': { value: 0.45, bluff: 1, call: 1 },
	/** `polar`, but paying off: calls half as often again. */
	station: { value: 0.3, bluff: 1, call: 1.5 },
	/** Bet the top half, call with the top half. */
	halves: { value: 0.5, bluff: 0, call: 1, callTop: 0.5 },
} as const satisfies Record<string, ContinuationRule>;

export type ContinuationName = keyof typeof CONTINUATIONS;

/** Everything a leaf needs beyond the context's own structures. */
export interface LeafModel {
	readonly rules: readonly ContinuationRule[];
	/** Each final-board list entry's percentile in its player's range. */
	readonly percentile: Float64Array;
	/**
	 * Per leaf (node order of `tree.leafNodes`) and rule, three thresholds on
	 * the percentile: bet at or above, bluff below, call at or above.
	 */
	readonly thresholds: Float64Array;
	/** Node to its position in `tree.leafNodes`, else -1. */
	readonly leafIndex: Int32Array;
	/** Whether any rule ever bets; if none does, a leaf is a showdown. */
	readonly anyBet: boolean;
}

/** Resolve continuation names or rules to rules. */
export function resolveRules(list: readonly (ContinuationName | ContinuationRule)[]): ContinuationRule[] {
	if (list.length === 0) throw new Error('A depth limit needs at least one continuation');
	return list.map((entry) => {
		if (typeof entry !== 'string') return entry;
		const rule = (CONTINUATIONS as Record<string, ContinuationRule>)[entry];
		if (!rule) throw new Error(`Unknown continuation "${entry}"; pick from ${Object.keys(CONTINUATIONS).join(', ')}`);
		return rule;
	});
}

/**
 * Build the leaf model for a prepared context.
 * @param rules one per continuation, `tree.leafChoices` of them
 */
export function buildLeafModel(ctx: Omit<Context, 'leaf'>, rules: readonly ContinuationRule[]): LeafModel {
	const { tree, runouts, active: lists, players } = ctx;
	const leaves = tree.leafNodes ?? new Int32Array(0);
	const bets = tree.leafBet ?? new Int32Array(tree.nodeCount);
	const k = rules.length;
	if (k !== tree.leafChoices) throw new Error('The leaf model and the tree disagree on the number of continuations');

	// Percentiles on final boards, where the lists are sorted by strength:
	// what the player's own range weight below this hand comes to, with half
	// of its own tie group, over the whole.
	const percentile = new Float64Array(lists.list.length);
	const last = runouts.rounds - 1;
	for (let board = 0; board < runouts.counts[last]; board++) {
		for (let player = 0; player < 2; player++) {
			const slot = (lists.roundBase[last] + board) * 2 + player;
			const from = lists.start[slot];
			const count = lists.count[slot];
			const weights = players[player].weights;
			let total = 0;
			for (let e = from; e < from + count; e++) total += weights[lists.list[e]];
			let below = 0;
			for (let e = from; e < from + count; ) {
				let end = e;
				let tied = 0;
				while (end < from + count && lists.strength[end] === lists.strength[e]) tied += weights[lists.list[end++]];
				const q = total > 0 ? (below + tied / 2) / total : 0.5;
				for (let i = e; i < end; i++) percentile[i] = q;
				below += tied;
				e = end;
			}
		}
	}

	const thresholds = new Float64Array(leaves.length * k * 3);
	const leafIndex = new Int32Array(tree.nodeCount).fill(-1);
	for (let l = 0; l < leaves.length; l++) {
		const node = leaves[l];
		leafIndex[node] = l;
		const pot = tree.pot[node];
		const bet = bets[node];
		const alpha = bet / (pot + 2 * bet);
		const defend = pot / (pot + bet);
		for (let i = 0; i < k; i++) {
			const rule = rules[i];
			const at = (l * k + i) * 3;
			const betting = bet > 0 && rule.value > 0;
			thresholds[at] = betting ? 1 - rule.value : 2;
			thresholds[at + 1] = betting ? (rule.value * rule.bluff * alpha) / (1 - alpha) : -1;
			const call = Math.min(1, rule.callTop ?? rule.call * defend);
			thresholds[at + 2] = 1 - call;
		}
	}
	const anyBet = rules.some((rule) => rule.value > 0);
	return { rules, percentile, thresholds, leafIndex, anyBet };
}

/** Where a player's continuation block on a board starts; see `buildLayout`. */
export function leafBase(ctx: Context, node: number, board: number, player: 0 | 1): number {
	const { layout, tree } = ctx;
	const round = tree.round[node];
	const k = tree.leafChoices!;
	const slot = (layout.roundBase[round] + board) * 2 + player;
	const before = player === 1 ? layout.totals[round * 2] : 0;
	return layout.offset[node] + k * (before + layout.rowStart[slot]);
}

/** Scratch for one context: k rows of COMBOS per expansion level, and the passes. */
interface LeafBuffers {
	readonly opp: Float64Array[];
	readonly values: Float64Array[];
	readonly mine: Float64Array;
	readonly theirs: Float64Array;
	readonly weights: Float64Array[];
	readonly passes: Float64Array[];
	readonly cardSums: Float64Array;
}

const scratch = new WeakMap<object, LeafBuffers>();

function buffersFor(ctx: Context): LeafBuffers {
	let buffers = scratch.get(ctx.layout);
	if (buffers) return buffers;
	const k = ctx.tree.leafChoices!;
	const levels = ctx.runouts.rounds + 1;
	const make = (n: number, width: number): Float64Array[] => Array.from({ length: n }, () => new Float64Array(width));
	buffers = {
		opp: make(levels, k * COMBOS),
		values: make(levels, k * COMBOS),
		mine: new Float64Array(k * COMBOS),
		theirs: new Float64Array(k * COMBOS),
		weights: make(5, COMBOS),
		passes: make(5, COMBOS),
		cardSums: new Float64Array(DECK),
	};
	scratch.set(ctx.layout, buffers);
	return buffers;
}

/**
 * Each hand's share of positive values in a `k`-row block, uniform where
 * there are none; with `fallback`, a hand with no positive value there reads
 * the fallback's positive values before falling to uniform, as
 * `averageStrategy` does.
 */
function match(
	source: RegretStore | SumStore,
	base: number,
	k: number,
	count: number,
	into: Float64Array,
	fallback: RegretStore | null,
): void {
	for (let i = 0; i < count; i++) {
		let total = 0;
		for (let a = 0; a < k; a++) {
			const value = source[base + a * count + i];
			const positive = value > 0 ? value : 0;
			into[a * COMBOS + i] = positive;
			total += positive;
		}
		if (total <= 0 && fallback !== null && fallback.length > 0) {
			for (let a = 0; a < k; a++) {
				const value = fallback[base + a * count + i];
				const positive = value > 0 ? value : 0;
				into[a * COMBOS + i] = positive;
				total += positive;
			}
		}
		for (let a = 0; a < k; a++) into[a * COMBOS + i] = total > 0 ? into[a * COMBOS + i] / total : 1 / k;
	}
}

/**
 * Counterfactual values of a `Continuation` leaf for the traverser, as
 * `traverse` returns them, with the choice's regrets and sums updated in
 * training.
 */
export function continuationValues(
	ctx: Context,
	mode: Mode,
	traverser: 0 | 1,
	iterWeight: number,
	node: number,
	board: number,
	reachMe: Float64Array,
	reachOpp: Float64Array,
	out: Float64Array,
): Float64Array {
	const { tree } = ctx;
	const model = ctx.leaf!;
	const buffers = buffersFor(ctx);
	const k = model.rules.length;
	const round = tree.round[node];
	const lists = ctx.active;
	const opponent = (1 - traverser) as 0 | 1;
	const mySlot = (lists.roundBase[round] + board) * 2 + traverser;
	const oppSlot = (lists.roundBase[round] + board) * 2 + opponent;
	const myCount = lists.count[mySlot];
	const oppCount = lists.count[oppSlot];
	const myBase = leafBase(ctx, node, board, traverser);
	const oppBase = leafBase(ctx, node, board, opponent);

	// The opponent's choice, folded into their reach: one reach row per
	// continuation of theirs.
	const theirs = buffers.theirs;
	if (mode === Mode.Train) match(ctx.regret, oppBase, k, oppCount, theirs, null);
	else match(ctx.strategySum, oppBase, k, oppCount, theirs, ctx.regret);
	const opp = buffers.opp[0];
	for (let a = 0; a < k; a++) {
		const row = a * COMBOS;
		for (let j = 0; j < oppCount; j++) opp[row + j] = reachOpp[j] * theirs[row + j];
	}

	const values = expand(ctx, buffers, model, traverser, node, round, board, 0);

	if (mode === Mode.BestResponse) {
		for (let i = 0; i < myCount; i++) {
			let best = values[i];
			for (let a = 1; a < k; a++) if (values[a * COMBOS + i] > best) best = values[a * COMBOS + i];
			out[i] = best;
		}
		return out;
	}

	const mine = buffers.mine;
	if (mode === Mode.Train) match(ctx.regret, myBase, k, myCount, mine, null);
	else match(ctx.strategySum, myBase, k, myCount, mine, ctx.regret);
	for (let i = 0; i < myCount; i++) {
		let sum = 0;
		for (let a = 0; a < k; a++) sum += mine[a * COMBOS + i] * values[a * COMBOS + i];
		out[i] = sum;
	}
	if (mode !== Mode.Train || !ctx.applyUpdates) return out;

	const regret = ctx.regret;
	const strategySum = ctx.strategySum;
	if (ctx.dcfr) {
		const { keepPositive, keepNegative, keepSum } = dcfrFactors(iterWeight);
		for (let a = 0; a < k; a++) {
			for (let i = 0; i < myCount; i++) {
				const at = myBase + a * myCount + i;
				const accumulated = regret[at];
				regret[at] = accumulated * (accumulated > 0 ? keepPositive : keepNegative) + values[a * COMBOS + i] - out[i];
				strategySum[at] = strategySum[at] * keepSum + reachMe[i] * mine[a * COMBOS + i];
			}
		}
	} else {
		for (let a = 0; a < k; a++) {
			for (let i = 0; i < myCount; i++) {
				const at = myBase + a * myCount + i;
				const updated = regret[at] + values[a * COMBOS + i] - out[i];
				regret[at] = updated > 0 ? updated : 0;
				strategySum[at] += iterWeight * reachMe[i] * mine[a * COMBOS + i];
			}
		}
	}
	const tieFrom = lists.tieStart[mySlot];
	const tieTo = lists.tieStart[mySlot + 1];
	if (tieFrom < tieTo) {
		tieMirrors(regret, myBase, k, myCount, lists.ties, tieFrom, tieTo, false);
		tieMirrors(strategySum, myBase, k, myCount, lists.ties, tieFrom, tieTo, false);
	}
	return out;
}

/**
 * Deal the next street from `board` of `round` and sum the traverser's value
 * of each of their continuations over every deal, against the opponent reach
 * rows in `buffers.opp[level]`. Returns `k` rows of COMBOS, valid for the
 * traverser's hands on this board.
 */
function expand(
	ctx: Context,
	buffers: LeafBuffers,
	model: LeafModel,
	traverser: 0 | 1,
	node: number,
	round: number,
	board: number,
	level: number,
): Float64Array {
	const { runouts } = ctx;
	const lists = ctx.active;
	const k = model.rules.length;
	const opponent = (1 - traverser) as 0 | 1;
	const myCount = lists.count[(lists.roundBase[round] + board) * 2 + traverser];
	const out = buffers.values[level];
	for (let a = 0; a < k; a++) out.fill(0, a * COMBOS, a * COMBOS + myCount);
	const opp = buffers.opp[level];
	const childOpp = buffers.opp[level + 1];

	const next = round + 1;
	const final = next === runouts.rounds - 1;
	const orbitStart = runouts.orbitStart[next];
	const upStart = ctx.hands.upStart[next];
	const up = ctx.hands.up;
	for (let child = runouts.childStart[next][board]; child < runouts.childStart[next][board + 1]; child++) {
		const childSlot = (lists.roundBase[next] + child) * 2;
		const nMe = lists.count[childSlot + traverser];
		const nOpp = lists.count[childSlot + opponent];
		let value: Float64Array | null = null;
		for (let m = orbitStart[child]; m < orbitStart[child + 1]; m++) {
			const upMe = upStart[m * 2 + traverser];
			if (value === null || ctx.expandOrbits) {
				const upOpp = upStart[m * 2 + opponent];
				for (let a = 0; a < k; a++) {
					const row = a * COMBOS;
					for (let j = 0; j < nOpp; j++) childOpp[row + j] = opp[row + up[upOpp + j]];
				}
				value = final
					? settle(ctx, buffers, model, traverser, node, child, childOpp, buffers.values[level + 1])
					: expand(ctx, buffers, model, traverser, node, next, child, level + 1);
			}
			for (let a = 0; a < k; a++) {
				const row = a * COMBOS;
				for (let i = 0; i < nMe; i++) out[row + up[upMe + i]] += value[row + i];
			}
		}
	}
	return out;
}

/**
 * Play every pair of continuations out on one final board: the traverser's
 * value for each of their continuations against the opponent's rows `opp`.
 */
function settle(
	ctx: Context,
	buffers: LeafBuffers,
	model: LeafModel,
	traverser: 0 | 1,
	node: number,
	board: number,
	opp: Float64Array,
	out: Float64Array,
): Float64Array {
	const { tree, runouts } = ctx;
	const lists = ctx.active;
	const k = model.rules.length;
	const last = runouts.rounds - 1;
	const opponent = (1 - traverser) as 0 | 1;
	const mySlot = (lists.roundBase[last] + board) * 2 + traverser;
	const oppSlot = (lists.roundBase[last] + board) * 2 + opponent;
	const myFrom = lists.start[mySlot];
	const myCount = lists.count[mySlot];
	const oppFrom = lists.start[oppSlot];
	const oppCount = lists.count[oppSlot];
	const scale = ctx.runoutWeight[last] / ctx.chipScale;
	const showdown = tree.payoff[node] * scale;
	const called = (tree.payoff[node] + tree.leafBet![node]) * scale;
	const cardSums = buffers.cardSums;
	const pct = model.percentile;
	const th = model.thresholds;
	const leaf = model.leafIndex[node] * k * 3;

	if (!model.anyBet) {
		// Nobody ever bets: a showdown at the leaf's pot against the whole reach.
		const total = buffers.weights[0];
		for (let j = 0; j < oppCount; j++) {
			let sum = 0;
			for (let a = 0; a < k; a++) sum += opp[a * COMBOS + j];
			total[j] = sum;
		}
		const pass = buffers.passes[0];
		showdownValuesHands(total, lists.cardA, lists.cardB, lists.strength, oppFrom, oppCount, myFrom, myCount, showdown, cardSums, pass);
		for (let a = 0; a < k; a++) out.set(pass.subarray(0, myCount), a * COMBOS);
		return out;
	}

	// The opponent's reach into each sequence of the small river, their
	// continuation mixture summed in. Player 0 opens; `b` bets, `c` calls.
	const [w0, w1, w2, w3] = buffers.weights;
	for (let j = 0; j < oppCount; j++) {
		const q = pct[oppFrom + j];
		let s0 = 0;
		let s1 = 0;
		let s2 = 0;
		let s3 = 0;
		for (let a = 0; a < k; a++) {
			const r = opp[a * COMBOS + j];
			if (r === 0) continue;
			const at = leaf + a * 3;
			const b = q >= th[at] || q < th[at + 1] ? 1 : 0;
			const c = q >= th[at + 2] ? 1 : 0;
			if (opponent === 1) {
				// After a check: check back, or bet. After a bet: call, or fold.
				s0 += r * (1 - b);
				s1 += r * b;
				s2 += r * c;
				s3 += r * (1 - c);
			} else {
				// Checks then calls a bet, checks then folds to one, or bets.
				s0 += r * (1 - b);
				s1 += r * (1 - b) * c;
				s2 += r * (1 - b) * (1 - c);
				s3 += r * b;
			}
		}
		w0[j] = s0;
		w1[j] = s1;
		w2[j] = s2;
		w3[j] = s3;
	}

	const [p0, p1, p2, p3, p4] = buffers.passes;
	const { cardA, cardB, strength } = lists;
	const { same, sameStart } = ctx.hands;
	const sd = (w: Float64Array, payoff: number, into: Float64Array): void =>
		showdownValuesHands(w, cardA, cardB, strength, oppFrom, oppCount, myFrom, myCount, payoff, cardSums, into);
	const fold = (w: Float64Array, payoff: number, into: Float64Array): void =>
		foldValuesHands(w, cardA, cardB, oppFrom, oppCount, myFrom, myCount, same, sameStart[mySlot], payoff, cardSums, into);

	if (traverser === 0) {
		sd(w0, showdown, p0); // check, check
		sd(w1, called, p1); // check, bet, call
		fold(w1, -showdown, p2); // check, bet, fold
		sd(w2, called, p3); // bet, call
		fold(w3, showdown, p4); // bet, fold
		for (let a = 0; a < k; a++) {
			const at = leaf + a * 3;
			const row = a * COMBOS;
			for (let i = 0; i < myCount; i++) {
				const q = pct[myFrom + i];
				const b = q >= th[at] || q < th[at + 1] ? 1 : 0;
				const c = q >= th[at + 2] ? 1 : 0;
				out[row + i] = b ? p3[i] + p4[i] : p0[i] + (c ? p1[i] : p2[i]);
			}
		}
	} else {
		sd(w0, showdown, p0); // check, check
		sd(w1, called, p1); // check, bet, call
		fold(w2, showdown, p2); // check, bet, fold: player 0 gives up
		sd(w3, called, p3); // bet, call
		fold(w3, -showdown, p4); // bet, fold
		for (let a = 0; a < k; a++) {
			const at = leaf + a * 3;
			const row = a * COMBOS;
			for (let i = 0; i < myCount; i++) {
				const q = pct[myFrom + i];
				const b = q >= th[at] || q < th[at + 1] ? 1 : 0;
				const c = q >= th[at + 2] ? 1 : 0;
				out[row + i] = (b ? p1[i] + p2[i] : p0[i]) + (c ? p3[i] : p4[i]);
			}
		}
	}
	return out;
}
