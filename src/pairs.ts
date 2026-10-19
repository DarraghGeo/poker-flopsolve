/**
 * Values against single opposing hands, many at once.
 *
 * Purpose: answer "what is each of my hands worth against that one hand of
 * theirs, from here on" for a whole list of their hands in one walk of the
 * tree. `valuesAt` with a one-hot opponent reach gives the same numbers, one
 * opposing hand per walk; this shares everything that does not depend on the
 * opposing hand:
 *
 *   - the tree walk itself, and every average-strategy lookup on the way;
 *   - the traverser's reach, which never depends on the opposing hand;
 *   - terminals, where a single opposing hand needs no card-removal kernel:
 *     at a fold every hand not sharing a card wins or loses the same amount,
 *     and at a showdown it is a comparison of two strengths.
 *
 * An opposing hand drops out of the walk as soon as its own strategy stops
 * reaching a line, or a dealt card hits it, so lines a hand never takes cost
 * nothing for it.
 *
 * Reads the average strategy only. Results match `valuesAt` with a one-hot
 * reach to floating-point accuracy.
 */

import { COMBO_CARDS, COMBOS } from './cards.ts';
import type { Context } from './cfr.ts';
import { averageStrategy } from './cfr.ts';
import { NodeKind } from './tree.ts';

/** Opposing hands per walk; more share the walk better but need more memory. */
const CHUNK = 64;

interface PairBuffers {
	readonly value: Float64Array[];
	readonly cols: Int32Array[];
	readonly colReach: Float64Array[];
	readonly live: Uint16Array[];
	readonly strategy: Float64Array[];
	readonly sum: Float64Array[];
	readonly rank: Int32Array;
}

function treeDepth(ctx: Context): number {
	const { tree } = ctx;
	const depth = new Int32Array(tree.nodeCount).fill(-1);
	depth[0] = 1;
	let max = 1;
	for (let node = 0; node < tree.nodeCount; node++) {
		const here = depth[node];
		if (here < 0) continue;
		if (here > max) max = here;
		for (let e = 0; e < tree.numEdges[node]; e++) {
			const child = tree.edgeChild[tree.firstEdge[node] + e];
			if (depth[child] < here + 1) depth[child] = here + 1;
		}
	}
	return max + 2;
}

function makeBuffers(ctx: Context, width: number): PairBuffers {
	const depth = treeDepth(ctx);
	const make = <T>(factory: () => T): T[] => Array.from({ length: depth }, factory);
	const actions = ctx.layout.maxActions;
	return {
		value: make(() => new Float64Array(width * COMBOS)),
		cols: make(() => new Int32Array(width)),
		colReach: make(() => new Float64Array(width)),
		live: make(() => new Uint16Array(COMBOS)),
		strategy: make(() => new Float64Array(actions * COMBOS)),
		sum: make(() => new Float64Array(COMBOS)),
		rank: new Int32Array(COMBOS),
	};
}

/**
 * Counterfactual values for `traverser` from `node` on `board`, against each
 * opposing hand alone.
 *
 * @param hands the opposing hands, one per result row
 * @param handReach each opposing hand's reach at `node`
 * @returns `hands.length * COMBOS` values; row `k` is what `valuesAt` returns
 *   for an opponent reach holding only `hands[k]` at `handReach[k]`
 */
export function pairValues(
	ctx: Context,
	node: number,
	board: number,
	traverser: 0 | 1,
	hands: Uint16Array,
	handReach: Float64Array,
	live: Uint16Array,
	liveCount: number,
): Float64Array {
	const result = new Float64Array(hands.length * COMBOS);
	if (hands.length === 0) return result;
	const width = Math.min(CHUNK, hands.length);
	const buffers = makeBuffers(ctx, width);
	// Only the traverser's own hands get a value, so only they are carried.
	const mine = new Uint16Array(liveCount);
	let mineCount = 0;
	for (let i = 0; i < liveCount; i++) if (ctx.players[traverser].slot[live[i]] >= 0) mine[mineCount++] = live[i];
	for (let start = 0; start < hands.length; start += width) {
		const chunk = hands.subarray(start, Math.min(hands.length, start + width));
		const colReach = buffers.colReach[0];
		const cols = buffers.cols[0];
		let count = 0;
		for (let k = 0; k < chunk.length; k++) {
			colReach[k] = handReach[start + k];
			if (colReach[k] !== 0) cols[count++] = k;
		}
		const value = walk(ctx, buffers, traverser, chunk, node, board, colReach, cols, count, mine, mineCount, 0);
		for (let c = 0; c < count; c++) {
			const k = cols[c];
			const row = value.subarray(k * COMBOS, (k + 1) * COMBOS);
			for (let i = 0; i < mineCount; i++) result[(start + k) * COMBOS + mine[i]] = row[mine[i]];
		}
	}
	return result;
}

function walk(
	ctx: Context,
	buffers: PairBuffers,
	traverser: 0 | 1,
	hands: Uint16Array,
	node: number,
	board: number,
	colReach: Float64Array,
	cols: Int32Array,
	colCount: number,
	live: Uint16Array,
	liveCount: number,
	depth: number,
): Float64Array {
	const { tree, runouts } = ctx;
	const out = buffers.value[depth];
	const kind = tree.kind[node];
	const cards = COMBO_CARDS;

	for (let c = 0; c < colCount; c++) {
		const row = cols[c] * COMBOS;
		for (let i = 0; i < liveCount; i++) out[row + live[i]] = 0;
	}
	if (colCount === 0) return out;

	if (kind === NodeKind.TerminalFold) {
		const signed = traverser === 0 ? tree.payoff[node] : -tree.payoff[node];
		const weight = (signed * ctx.runoutWeight[tree.round[node]]) / ctx.chipScale;
		for (let c = 0; c < colCount; c++) {
			const k = cols[c];
			const a = cards[hands[k] * 2];
			const b = cards[hands[k] * 2 + 1];
			const v = weight * colReach[k];
			const row = k * COMBOS;
			for (let i = 0; i < liveCount; i++) {
				const combo = live[i];
				const x = cards[combo * 2];
				const y = cards[combo * 2 + 1];
				if (x !== a && x !== b && y !== a && y !== b) out[row + combo] = v;
			}
		}
		return out;
	}

	if (kind === NodeKind.TerminalShowdown) {
		const weight = (tree.payoff[node] * ctx.runoutWeight[tree.round[node]]) / ctx.chipScale;
		// Strength on this final board as a tie-group index.
		const table = ctx.showdown;
		const rank = buffers.rank;
		const orderBase = board * table.stride;
		const groupBase = board * (table.stride + 1);
		for (let g = 0; g < table.groupCount[board]; g++) {
			for (let i = table.groupStart[groupBase + g]; i < table.groupStart[groupBase + g + 1]; i++) {
				rank[table.order[orderBase + i]] = g;
			}
		}
		for (let c = 0; c < colCount; c++) {
			const k = cols[c];
			const theirs = hands[k];
			const a = cards[theirs * 2];
			const b = cards[theirs * 2 + 1];
			const strength = rank[theirs];
			const v = weight * colReach[k];
			const row = k * COMBOS;
			for (let i = 0; i < liveCount; i++) {
				const combo = live[i];
				const x = cards[combo * 2];
				const y = cards[combo * 2 + 1];
				if (x === a || x === b || y === a || y === b) continue;
				const mine = rank[combo];
				if (mine > strength) out[row + combo] = v;
				else if (mine < strength) out[row + combo] = -v;
			}
		}
		return out;
	}

	if (kind === NodeKind.Chance) {
		const nextRound = tree.round[node] + 1;
		const factor = runouts.childFactor[nextRound];
		const child = tree.edgeChild[tree.firstEdge[node]];
		const width = runouts.width[nextRound];
		const dealtCards = runouts.cards[nextRound];
		const childLive = buffers.live[depth];
		const childCols = buffers.cols[depth + 1];

		for (let local = 0; local < factor; local++) {
			const childBoard = board * factor + local;
			const dealt = dealtCards[childBoard * width + width - 1];

			let childCount = 0;
			for (let i = 0; i < liveCount; i++) {
				const combo = live[i];
				if (cards[combo * 2] === dealt || cards[combo * 2 + 1] === dealt) continue;
				childLive[childCount++] = combo;
			}
			let childColCount = 0;
			for (let c = 0; c < colCount; c++) {
				const k = cols[c];
				if (cards[hands[k] * 2] !== dealt && cards[hands[k] * 2 + 1] !== dealt) childCols[childColCount++] = k;
			}
			if (childColCount === 0) continue;

			const value = walk(
				ctx, buffers, traverser, hands, child, childBoard, colReach,
				childCols, childColCount, childLive, childCount, depth + 1,
			);
			for (let c = 0; c < childColCount; c++) {
				const row = childCols[c] * COMBOS;
				for (let i = 0; i < childCount; i++) out[row + childLive[i]] += value[row + childLive[i]];
			}
		}
		return out;
	}

	// --- decision ---
	const actions = tree.numEdges[node];
	const edgeBase = tree.firstEdge[node];
	const owner = tree.player[node] as 0 | 1;
	const index = ctx.players[owner];
	const stride = index.count;
	const slotBase = ctx.layout.offset[node] + board * actions * stride;
	const lists = ctx.active;
	const listSlot = (lists.roundBase[tree.round[node]] + board) * 2 + owner;
	const active = lists.list;
	const activeFrom = lists.start[listSlot];
	const activeCount = lists.count[listSlot];
	const strategy = buffers.strategy[depth];
	averageStrategy(ctx.strategySum, slotBase, actions, stride, active, activeFrom, activeCount, index.slot, strategy, buffers.sum[depth]);

	// The traverser's values are counterfactual: its own reach never enters.
	if (owner === traverser) {
		for (let a = 0; a < actions; a++) {
			const offset = a * COMBOS;
			const value = walk(
				ctx, buffers, traverser, hands, tree.edgeChild[edgeBase + a], board, colReach,
				cols, colCount, live, liveCount, depth + 1,
			);
			for (let c = 0; c < colCount; c++) {
				const row = cols[c] * COMBOS;
				for (let i = 0; i < activeCount; i++) {
					const combo = active[activeFrom + i];
					out[row + combo] += strategy[offset + combo] * value[row + combo];
				}
			}
		}
		return out;
	}

	// The opposing hands act: each column follows its own hand's strategy.
	const childReach = buffers.colReach[depth + 1];
	const childCols = buffers.cols[depth + 1];
	for (let a = 0; a < actions; a++) {
		const offset = a * COMBOS;
		let childCount = 0;
		for (let c = 0; c < colCount; c++) {
			const k = cols[c];
			const r = colReach[k] * strategy[offset + hands[k]];
			childReach[k] = r;
			if (r !== 0) childCols[childCount++] = k;
		}
		if (childCount === 0) continue;
		const value = walk(
			ctx, buffers, traverser, hands, tree.edgeChild[edgeBase + a], board, childReach,
			childCols, childCount, live, liveCount, depth + 1,
		);
		for (let c = 0; c < childCount; c++) {
			const row = childCols[c] * COMBOS;
			for (let i = 0; i < liveCount; i++) out[row + live[i]] += value[row + live[i]];
		}
	}
	return out;
}
