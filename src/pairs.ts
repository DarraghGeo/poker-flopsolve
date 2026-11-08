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
import { markMembers } from './hands.ts';
import { NodeKind } from './tree.ts';

/** Opposing hands per walk; more share the walk better but need more memory. */
const CHUNK = 64;

interface PairBuffers {
	readonly value: Float64Array[];
	readonly cols: Int32Array[];
	readonly colReach: Float64Array[];
	readonly live: Uint16Array[];
	/** Opposing hands relabelled onto a stored board, per depth. */
	readonly hands: Uint16Array[];
	readonly strategy: Float64Array[];
	readonly rank: Int32Array;
	/** A combination's position in the current decision's hand list; -1 between uses. */
	readonly position: Int32Array;
	/** Each opposing hand's position in the acting list, or -1, per depth: deeper walks reuse `position`. */
	readonly at: Int32Array[];
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
		hands: make(() => new Uint16Array(width)),
		strategy: make(() => new Float64Array(actions * COMBOS)),
		rank: new Int32Array(COMBOS),
		position: new Int32Array(COMBOS).fill(-1),
		at: make(() => new Int32Array(width)),
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
		if (ctx.lineStarts !== undefined) throw new Error('Per-hand pair values are not available with lineRunouts');
		const nextRound = tree.round[node] + 1;
		const child = tree.edgeChild[tree.firstEdge[node]];
		const width = runouts.width[nextRound];
		const dealtCards = runouts.cards[nextRound];
		const orbitStart = runouts.orbitStart[nextRound];
		const childLive = buffers.live[depth];
		const childCols = buffers.cols[depth + 1];
		const mappedHands = buffers.hands[depth];

		for (let childBoard = runouts.childStart[nextRound][board]; childBoard < runouts.childStart[nextRound][board + 1]; childBoard++) {
			// Every deal this board stands for, the stored one first. The
			// opposing hands are an arbitrary list, not a symmetric range, so a
			// mirrored deal is walked with every hand relabelled onto the
			// stored board rather than assumed equal to it.
			for (let m = orbitStart[childBoard]; m < orbitStart[childBoard + 1]; m++) {
				const dealt = m === orbitStart[childBoard] ? dealtCards[childBoard * width + width - 1] : runouts.orbitCard[nextRound][m];
				const map = runouts.maps.combo[runouts.orbitMap[nextRound][m]];

				let childCount = 0;
				for (let i = 0; i < liveCount; i++) {
					const combo = live[i];
					if (cards[combo * 2] === dealt || cards[combo * 2 + 1] === dealt) continue;
					childLive[childCount++] = map[combo];
				}
				let childColCount = 0;
				for (let c = 0; c < colCount; c++) {
					const k = cols[c];
					if (cards[hands[k] * 2] !== dealt && cards[hands[k] * 2 + 1] !== dealt) childCols[childColCount++] = k;
				}
				if (childColCount === 0) continue;
				for (let k = 0; k < hands.length; k++) mappedHands[k] = map[hands[k]];

				const value = walk(
					ctx, buffers, traverser, mappedHands.subarray(0, hands.length), child, childBoard, colReach,
					childCols, childColCount, childLive, childCount, depth + 1,
				);
				for (let c = 0; c < childColCount; c++) {
					const row = childCols[c] * COMBOS;
					for (let i = 0; i < liveCount; i++) {
						const combo = live[i];
						if (cards[combo * 2] === dealt || cards[combo * 2 + 1] === dealt) continue;
						out[row + combo] += value[row + map[combo]];
					}
				}
			}
		}
		return out;
	}

	// --- decision ---
	const actions = tree.numEdges[node];
	const edgeBase = tree.firstEdge[node];
	const owner = tree.player[node] as 0 | 1;
	const lists = ctx.active;
	const listSlot = (lists.roundBase[tree.round[node]] + board) * 2 + owner;
	const activeFrom = lists.start[listSlot];
	const activeCount = lists.count[listSlot];
	// Storage, and so the strategy, is laid out by position in this list.
	const stride = activeCount;
	const slotBase = ctx.layout.offset[node] + actions * ctx.layout.rowStart[listSlot];
	const strategy = buffers.strategy[depth];
	averageStrategy(ctx.strategySum, slotBase, actions, stride, strategy, ctx.regret);

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
					// A packed entry's strategy is every hand's it stands for.
					const share = strategy[a * stride + i];
					for (let m = lists.memberStart[activeFrom + i]; m < lists.memberStart[activeFrom + i + 1]; m++) {
						const combo = lists.memberCombo[m];
						out[row + combo] += share * value[row + combo];
					}
				}
			}
		}
		return out;
	}

	// The opposing hands act: each column follows its own hand's strategy.
	const childReach = buffers.colReach[depth + 1];
	const childCols = buffers.cols[depth + 1];
	// Each opposing hand's position in the acting player's list here.
	const position = buffers.position;
	markMembers(lists, activeFrom, activeCount, position, false);
	const at = buffers.at[depth];
	for (let c = 0; c < colCount; c++) at[cols[c]] = position[hands[cols[c]]];
	markMembers(lists, activeFrom, activeCount, position, true);
	for (let a = 0; a < actions; a++) {
		const offset = a * COMBOS;
		let childCount = 0;
		for (let c = 0; c < colCount; c++) {
			const k = cols[c];
			// A hand not in the list here cannot be holding it.
			const r = at[k] < 0 ? 0 : colReach[k] * strategy[a * stride + at[k]];
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
