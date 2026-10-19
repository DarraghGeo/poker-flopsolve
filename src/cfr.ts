/**
 * Vector CFR+ over a fixed board.
 *
 * Purpose: the one place equilibrium computation happens.
 *
 * Every traversal carries vectors over all 1326 combinations, so one walk of
 * the tree updates every hand at once. Returned values are counterfactual — the
 * opponent's reach is already folded in — which is exactly what the regret
 * update expects, so nothing is rescaled anywhere.
 *
 * Values are UNNORMALISED: summed over runouts rather than averaged. CFR is
 * invariant to a positive scale, and dividing once at the top by the total
 * weighted mass of legal matchups is both cheaper and harder to get wrong than
 * threading a probability through every node.
 *
 * Storage is sized by each player's own range, not by all 1326 combinations —
 * a decision node belongs to one player, and a typical range is a few hundred
 * hands, so this is the difference between fitting and not.
 */

import { COMBO_CARDS, COMBOS, DECK } from './cards.ts';
import type { Runouts } from './runouts.ts';
import type { ShowdownTable, TerminalScratch } from './showdown.ts';
import { foldValues, makeTerminalScratch, showdownValues } from './showdown.ts';
import type { Tree } from './tree.ts';
import { pairValues } from './pairs.ts';
import { NodeKind } from './tree.ts';

/** Which combinations a player holds, and where each sits in storage. */
export interface PlayerIndex {
	/** Combinations with any weight, ascending. */
	readonly combos: Uint16Array;
	readonly count: number;
	/** Combination to storage slot, or -1. */
	readonly slot: Int32Array;
	/** Starting reach: the range weights themselves. */
	readonly weights: Float64Array;
}

/** Build a player's index from their range weights. */
export function buildPlayerIndex(weights: Float64Array): PlayerIndex {
	const combos: number[] = [];
	const slot = new Int32Array(COMBOS).fill(-1);
	for (let combo = 0; combo < COMBOS; combo++) {
		if (weights[combo] > 0) {
			slot[combo] = combos.length;
			combos.push(combo);
		}
	}
	return { combos: Uint16Array.from(combos), count: combos.length, slot, weights };
}

/** Slot offsets for every decision node. */
export interface Layout {
	readonly offset: Int32Array;
	readonly totalSlots: number;
	readonly maxActions: number;
	readonly bytes: number;
}

/**
 * Size storage. A node's block is `boards * actions * combosOfItsOwner`.
 * @param bytesPerElement 4 for float32, 8 for float64
 */
export function buildLayout(
	tree: Tree,
	runouts: Runouts,
	players: readonly [PlayerIndex, PlayerIndex],
	bytesPerElement: number,
): Layout {
	const offset = new Int32Array(tree.nodeCount).fill(-1);
	let total = 0;
	let maxActions = 0;

	for (let i = 0; i < tree.decisionNodes.length; i++) {
		const node = tree.decisionNodes[i];
		const actions = tree.numEdges[node];
		if (actions > maxActions) maxActions = actions;
		offset[node] = total;
		total += runouts.counts[tree.round[node]] * actions * players[tree.player[node]].count;
	}
	return { offset, totalSlots: total, maxActions, bytes: total * bytesPerElement * 2 };
}

/** Everything a traversal needs. */
export interface Context {
	readonly tree: Tree;
	readonly runouts: Runouts;
	readonly players: readonly [PlayerIndex, PlayerIndex];
	readonly layout: Layout;
	readonly showdown: ShowdownTable;
	readonly regret: Float64Array | Float32Array;
	readonly strategySum: Float64Array | Float32Array;
	readonly scratch: TerminalScratch;
	readonly chipScale: number;
	/** Which combinations each player can hold on each board. */
	readonly active: ActiveLists;
	/**
	 * Board completions still to come after each round, with four cards already
	 * removed for the two hands. A hand that ends early would otherwise be
	 * counted once while one reaching showdown is counted once per runout.
	 */
	readonly runoutWeight: Float64Array;
	/** Total weighted mass of legal matchups; divides raw values into chips. */
	readonly totalMass: number;
	/**
	 * Runout range this traversal is responsible for, as [start, end), at
	 * `shardRound`. Workers each take a slice; a single-threaded solve takes
	 * the whole level. Runouts partition storage, so slices never collide.
	 */
	shardStart: number;
	shardEnd: number;
	/** Round at which sharding applies; -1 to disable. */
	shardRound: number;
	/** Whether traverser nodes accumulate regret. False during a collect pass. */
	applyUpdates: boolean;
	/** Captures the reach a worker will need, instead of expanding. */
	chanceCollect: ((node: number, reachMe: Float64Array, reachOpp: Float64Array) => void) | null;
	/** Values to substitute for chance nodes at the shard round, by entry index. */
	chanceOverride: Float64Array | null;
	/** Node index to entry index for shard-round chance nodes, else -1. */
	entryIndexOf: Int32Array | null;
}

/**
 * Completions remaining after each round, both players' cards removed.
 * Constant across hands because the two hands are always disjoint.
 */
export function runoutWeights(runouts: Runouts): Float64Array {
	const weights = new Float64Array(runouts.rounds).fill(1);
	for (let round = 0; round < runouts.rounds; round++) {
		let weight = 1;
		for (let r = round + 1; r < runouts.rounds; r++) weight *= DECK - 4 - runouts.width[r - 1];
		weights[round] = weight;
	}
	return weights;
}

/**
 * Weighted mass of hand pairs the two players can hold at once.
 *
 * Not a combination count: with weighted ranges it is
 * `sum over disjoint (h0, h1) of w0(h0) * w1(h1)`. Getting this wrong scales
 * every reported number silently.
 */
export function matchupMass(a: Float64Array, b: Float64Array): number {
	// Card-level sums turn the disjointness test into inclusion-exclusion.
	const single = new Float64Array(DECK);
	const pair = new Float64Array(COMBOS);
	let totalB = 0;
	for (let combo = 0; combo < COMBOS; combo++) {
		const w = b[combo];
		if (w === 0) continue;
		totalB += w;
		single[COMBO_CARDS[combo * 2]] += w;
		single[COMBO_CARDS[combo * 2 + 1]] += w;
		pair[combo] += w;
	}

	let mass = 0;
	for (let combo = 0; combo < COMBOS; combo++) {
		const w = a[combo];
		if (w === 0) continue;
		const clash = single[COMBO_CARDS[combo * 2]] + single[COMBO_CARDS[combo * 2 + 1]] - pair[combo];
		mass += w * (totalB - clash);
	}
	return mass;
}

/**
 * Which combinations each player can hold on each board.
 *
 * This depends only on the board and the player, never on the node, so
 * rebuilding it at every one of the tens of thousands of node visits per
 * traversal was pure repetition.
 */
interface ActiveLists {
	/** Start of each list in `list`, indexed by `slotOf(round, board, player)`. */
	readonly start: Int32Array;
	readonly count: Uint16Array;
	readonly list: Uint16Array;
	/** First list index of each round. */
	readonly roundBase: Int32Array;
}

function buildActiveLists(
	runouts: Runouts,
	players: readonly [PlayerIndex, PlayerIndex],
): ActiveLists {
	const roundBase = new Int32Array(runouts.rounds + 1);
	for (let round = 0; round < runouts.rounds; round++) {
		roundBase[round + 1] = roundBase[round] + runouts.counts[round];
	}
	const slots = roundBase[runouts.rounds] * 2;

	const start = new Int32Array(slots);
	const count = new Uint16Array(slots);
	const entries: number[] = [];
	const onBoard = new Uint8Array(DECK);

	for (let round = 0; round < runouts.rounds; round++) {
		const width = runouts.width[round];
		const cards = runouts.cards[round];
		for (let board = 0; board < runouts.counts[round]; board++) {
			onBoard.fill(0);
			for (let i = 0; i < width; i++) onBoard[cards[board * width + i]] = 1;
			for (let player = 0; player < 2; player++) {
				const index = players[player];
				const slot = (roundBase[round] + board) * 2 + player;
				start[slot] = entries.length;
				for (let i = 0; i < index.count; i++) {
					const combo = index.combos[i];
					if (onBoard[COMBO_CARDS[combo * 2]] || onBoard[COMBO_CARDS[combo * 2 + 1]]) continue;
					entries.push(combo);
				}
				count[slot] = entries.length - start[slot];
			}
		}
	}
	return { start, count, list: Uint16Array.from(entries), roundBase };
}

/** Per-depth buffers, so the hot loop never allocates. */
interface Buffers {
	readonly value: Float64Array[];
	/**
	 * Reach buffers per player. Only ever written at that player's own
	 * combinations, so entries belonging to the other player stay zero from
	 * allocation and never need clearing.
	 */
	readonly reachFor: readonly [Float64Array[], Float64Array[]];
	readonly other: Float64Array[];
	readonly strategy: Float64Array[];
	readonly actionValues: Float64Array[];
	readonly sum: Float64Array[];
	readonly live: Uint16Array[];
}

function makeBuffers(tree: Tree, maxActions: number): Buffers {
	const depth = treeDepth(tree) + 2;
	const make = <T>(factory: () => T): T[] => Array.from({ length: depth }, factory);
	return {
		value: make(() => new Float64Array(COMBOS)),
		reachFor: [make(() => new Float64Array(COMBOS)), make(() => new Float64Array(COMBOS))],
		other: make(() => new Float64Array(COMBOS)),
		strategy: make(() => new Float64Array(maxActions * COMBOS)),
		actionValues: make(() => new Float64Array(maxActions * COMBOS)),
		sum: make(() => new Float64Array(COMBOS)),
		live: make(() => new Uint16Array(COMBOS)),
	};
}

function treeDepth(tree: Tree): number {
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
	return max;
}

export const Mode = { Train: 0, BestResponse: 1, Average: 2 } as const;
export type Mode = (typeof Mode)[keyof typeof Mode];

/** Current strategy from positive regrets; uniform where there is none. */
function regretMatch(
	regret: Float64Array | Float32Array,
	base: number,
	actions: number,
	stride: number,
	active: Uint16Array,
	from: number,
	count: number,
	slot: Int32Array,
	strategy: Float64Array,
	sum: Float64Array,
): void {
	for (let i = 0; i < count; i++) sum[active[from + i]] = 0;
	for (let a = 0; a < actions; a++) {
		const row = base + a * stride;
		const to = a * COMBOS;
		for (let i = 0; i < count; i++) {
			const combo = active[from + i];
			const value = regret[row + slot[combo]];
			const positive = value > 0 ? value : 0;
			strategy[to + combo] = positive;
			sum[combo] += positive;
		}
	}
	const uniform = 1 / actions;
	for (let a = 0; a < actions; a++) {
		const to = a * COMBOS;
		for (let i = 0; i < count; i++) {
			const combo = active[from + i];
			strategy[to + combo] = sum[combo] > 0 ? strategy[to + combo] / sum[combo] : uniform;
		}
	}
}

/** Average strategy from accumulated sums. */
export function averageStrategy(
	strategySum: Float64Array | Float32Array,
	base: number,
	actions: number,
	stride: number,
	active: Uint16Array,
	from: number,
	count: number,
	slot: Int32Array,
	strategy: Float64Array,
	sum: Float64Array,
): void {
	for (let i = 0; i < count; i++) sum[active[from + i]] = 0;
	for (let a = 0; a < actions; a++) {
		const row = base + a * stride;
		for (let i = 0; i < count; i++) sum[active[from + i]] += strategySum[row + slot[active[from + i]]];
	}
	const uniform = 1 / actions;
	for (let a = 0; a < actions; a++) {
		const row = base + a * stride;
		const to = a * COMBOS;
		for (let i = 0; i < count; i++) {
			const combo = active[from + i];
			strategy[to + combo] = sum[combo] > 0 ? strategySum[row + slot[combo]] / sum[combo] : uniform;
		}
	}
}

function traverse(
	ctx: Context,
	buffers: Buffers,
	mode: Mode,
	traverser: 0 | 1,
	iterWeight: number,
	node: number,
	board: number,
	reachMe: Float64Array,
	reachOpp: Float64Array,
	live: Uint16Array,
	liveCount: number,
	depth: number,
): Float64Array {
	const { tree, runouts } = ctx;
	const out = buffers.value[depth];
	const kind = tree.kind[node];

	if (kind === NodeKind.TerminalFold) {
		const signed = traverser === 0 ? tree.payoff[node] : -tree.payoff[node];
		const weight = ctx.runoutWeight[tree.round[node]] / ctx.chipScale;
		foldValues(reachOpp, live, liveCount, signed * weight, ctx.scratch, out);
		return out;
	}

	if (kind === NodeKind.TerminalShowdown) {
		const weight = ctx.runoutWeight[tree.round[node]] / ctx.chipScale;
		showdownValues(reachOpp, ctx.showdown, board, tree.payoff[node] * weight, ctx.scratch, out);
		return out;
	}

	if (kind === NodeKind.Chance) {
		for (let i = 0; i < liveCount; i++) out[live[i]] = 0;
		const nextRound = tree.round[node] + 1;

		// At the shard boundary the subtree below belongs to the workers: the
		// collect pass records what they need, and the apply pass reads back
		// the totals they produced.
		if (ctx.entryIndexOf !== null && nextRound === ctx.shardRound) {
			const entry = ctx.entryIndexOf[node];
			if (entry >= 0) {
				if (ctx.chanceCollect !== null) {
					ctx.chanceCollect(node, reachMe, reachOpp);
					return out;
				}
				if (ctx.chanceOverride !== null) {
					const base = entry * COMBOS;
					for (let i = 0; i < liveCount; i++) out[live[i]] = ctx.chanceOverride[base + live[i]];
					return out;
				}
			}
		}

		const factor = runouts.childFactor[nextRound];
		const child = tree.edgeChild[tree.firstEdge[node]];
		const width = runouts.width[nextRound];
		const cards = runouts.cards[nextRound];

		const childMe = buffers.reachFor[traverser][depth];
		const childOpp = buffers.other[depth];
		const childLive = buffers.live[depth];
		const comboCards = COMBO_CARDS;

		const sharded = nextRound === ctx.shardRound;
		const from = sharded ? ctx.shardStart : 0;
		const to = sharded ? ctx.shardEnd : factor;

		for (let local = from; local < to; local++) {
			const childBoard = board * factor + local;
			const dealt = cards[childBoard * width + width - 1];

			// Copying only the live entries beats a whole-array set() by the
			// ratio of the deck to the range, which for a narrow range is large.
			let childCount = 0;
			for (let i = 0; i < liveCount; i++) {
				const combo = live[i];
				if (comboCards[combo * 2] === dealt || comboCards[combo * 2 + 1] === dealt) continue;
				childMe[combo] = reachMe[combo];
				childOpp[combo] = reachOpp[combo];
				childLive[childCount++] = combo;
			}

			const value = traverse(
				ctx, buffers, mode, traverser, iterWeight,
				child, childBoard, childMe, childOpp, childLive, childCount, depth + 1,
			);
			for (let i = 0; i < childCount; i++) out[childLive[i]] += value[childLive[i]];
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
	const isTraverser = owner === traverser;

	// Which hands this player can hold here was settled when the boards were
	// enumerated; it does not depend on the node.
	const lists = ctx.active;
	const listSlot = (lists.roundBase[tree.round[node]] + board) * 2 + owner;
	const active = lists.list;
	const activeFrom = lists.start[listSlot];
	const activeCount = lists.count[listSlot];

	const strategy = buffers.strategy[depth];
	const sum = buffers.sum[depth];
	if (mode === Mode.Train) {
		regretMatch(ctx.regret, slotBase, actions, stride, active, activeFrom, activeCount, index.slot, strategy, sum);
	} else {
		averageStrategy(ctx.strategySum, slotBase, actions, stride, active, activeFrom, activeCount, index.slot, strategy, sum);
	}

	for (let i = 0; i < liveCount; i++) out[live[i]] = 0;

	if (isTraverser && mode === Mode.BestResponse) {
		let first = true;
		for (let a = 0; a < actions; a++) {
			const value = traverse(
				ctx, buffers, mode, traverser, iterWeight,
				tree.edgeChild[edgeBase + a], board, reachMe, reachOpp, live, liveCount, depth + 1,
			);
			if (first) {
				for (let i = 0; i < activeCount; i++) out[active[activeFrom + i]] = value[active[activeFrom + i]];
				first = false;
			} else {
				for (let i = 0; i < activeCount; i++) {
					const combo = active[activeFrom + i];
					if (value[combo] > out[combo]) out[combo] = value[combo];
				}
			}
		}
		return out;
	}

	// Owned by whoever is acting, so hands they cannot hold are already zero
	// and only their own need writing.
	const childReach = buffers.reachFor[owner][depth];
	const actionValues = buffers.actionValues[depth];

	for (let a = 0; a < actions; a++) {
		const offset = a * COMBOS;
		const source = isTraverser ? reachMe : reachOpp;
		for (let i = 0; i < activeCount; i++) {
			const combo = active[activeFrom + i];
			childReach[combo] = source[combo] * strategy[offset + combo];
		}

		const value = traverse(
			ctx, buffers, mode, traverser, iterWeight,
			tree.edgeChild[edgeBase + a], board,
			isTraverser ? childReach : reachMe,
			isTraverser ? reachOpp : childReach,
			live, liveCount, depth + 1,
		);

		if (isTraverser) {
			for (let i = 0; i < activeCount; i++) {
				const combo = active[activeFrom + i];
				actionValues[offset + combo] = value[combo];
				out[combo] += strategy[offset + combo] * value[combo];
			}
		} else {
			// The opponent's strategy already sits inside their reach, so the
			// counterfactual value is the plain sum over their actions.
			for (let i = 0; i < liveCount; i++) out[live[i]] += value[live[i]];
		}
	}

	if (isTraverser && mode === Mode.Train && ctx.applyUpdates) {
		const regret = ctx.regret;
		const strategySum = ctx.strategySum;
		for (let a = 0; a < actions; a++) {
			const offset = a * COMBOS;
			const slotRow = slotBase + a * stride;
			for (let i = 0; i < activeCount; i++) {
				const combo = active[activeFrom + i];
				const at = slotRow + index.slot[combo];
				// CFR+: clamp the accumulated regret at zero in the same pass.
				const updated = regret[at] + actionValues[offset + combo] - out[combo];
				regret[at] = updated > 0 ? updated : 0;
				strategySum[at] += iterWeight * reachMe[combo] * strategy[offset + combo];
			}
		}
	}

	return out;
}

/** A prepared solver. */
export interface Solver {
	readonly ctx: Context;
	/** One traversal for `traverser`, returning the root value vector. */
	traverseRoot(mode: Mode, traverser: 0 | 1, iterWeight: number): Float64Array;
	/** One chance node's subtree, honouring the context shard. */
	traverseChance(
		traverser: 0 | 1,
		iterWeight: number,
		node: number,
		reachMe: Float64Array,
		reachOpp: Float64Array,
	): Float64Array;
	/** Combinations live on the given board, shared by root and workers. */
	readonly rootLive: Uint16Array;
	readonly rootCount: number;
	iterate(count: number, from: number): void;
	expectedValue(): [number, number];
	exploitability(): number;
	averageStrategyAt(node: number, board: number): { actions: number; probs: Float64Array };
	/**
	 * Counterfactual values under the average strategy from any node, for
	 * reach vectors the caller supplies. Returns a fresh copy.
	 */
	valuesAt(
		node: number,
		board: number,
		traverser: 0 | 1,
		reachMe: Float64Array,
		reachOpp: Float64Array,
		live: Uint16Array,
		liveCount: number,
	): Float64Array;
	/**
	 * Counterfactual values under the average strategy from any node against
	 * each of `hands` alone, at the reach given for it: the same as `valuesAt`
	 * with a one-hot opponent reach, for many opposing hands in one walk.
	 * Returns `hands.length * COMBOS` values, one row per opposing hand.
	 */
	pairValuesAt(
		node: number,
		board: number,
		traverser: 0 | 1,
		hands: Uint16Array,
		handReach: Float64Array,
		live: Uint16Array,
		liveCount: number,
	): Float64Array;
}

/** Create a solver over prepared structures. */
export function makeSolver(ctx: Context): Solver {
	const buffers = makeBuffers(ctx.tree, ctx.layout.maxActions);
	const reach0 = new Float64Array(COMBOS);
	const reach1 = new Float64Array(COMBOS);
	const rootLive = new Uint16Array(COMBOS);

	// Only hands one of the players can actually hold, minus whatever the given
	// board blocks. Carrying the other thousand-odd combinations through every
	// traversal would cost far more than the solve itself.
	let rootCount = 0;
	{
		const onBoard = new Uint8Array(DECK);
		for (const card of ctx.runouts.initial) onBoard[card] = 1;
		for (let combo = 0; combo < COMBOS; combo++) {
			if (ctx.players[0].slot[combo] < 0 && ctx.players[1].slot[combo] < 0) continue;
			if (onBoard[COMBO_CARDS[combo * 2]] || onBoard[COMBO_CARDS[combo * 2 + 1]]) continue;
			rootLive[rootCount++] = combo;
		}
	}

	const run = (mode: Mode, traverser: 0 | 1, iterWeight: number): Float64Array => {
		reach0.set(ctx.players[0].weights);
		reach1.set(ctx.players[1].weights);
		for (let i = 0; i < COMBOS; i++) {
			// Anything the board holds cannot be in either range.
			if (ctx.players[0].slot[i] < 0) reach0[i] = 0;
			if (ctx.players[1].slot[i] < 0) reach1[i] = 0;
		}
		const me = traverser === 0 ? reach0 : reach1;
		const opp = traverser === 0 ? reach1 : reach0;
		return traverse(ctx, buffers, mode, traverser, iterWeight, 0, 0, me, opp, rootLive, rootCount, 0);
	};

	const total = (values: Float64Array, traverser: 0 | 1): number => {
		// Values are counterfactual, so weighting by this player's own reach
		// turns them into the value of the spot.
		const weights = ctx.players[traverser].weights;
		let sum = 0;
		for (let i = 0; i < rootCount; i++) {
			const combo = rootLive[i];
			sum += weights[combo] * values[combo];
		}
		return sum / ctx.totalMass;
	};

	return {
		ctx,
		rootLive,
		get rootCount() {
			return rootCount;
		},
		traverseRoot: run,
		traverseChance(traverser, iterWeight, node, me, opp) {
			return traverse(
				ctx, buffers, Mode.Train, traverser, iterWeight, node, 0, me, opp, rootLive, rootCount, 0,
			);
		},
		iterate(count, from) {
			for (let i = 0; i < count; i++) {
				const t = from + i + 1;
				run(Mode.Train, 0, t);
				run(Mode.Train, 1, t);
			}
		},
		expectedValue() {
			return [total(run(Mode.Average, 0, 0), 0), total(run(Mode.Average, 1, 0), 1)];
		},
		exploitability() {
			const br0 = total(run(Mode.BestResponse, 0, 0), 0);
			const br1 = total(run(Mode.BestResponse, 1, 0), 1);
			return (br0 + br1) / 2;
		},
		valuesAt(node, board, traverser, reachMe, reachOpp, live, liveCount) {
			const value = traverse(
				ctx, buffers, Mode.Average, traverser, 0, node, board, reachMe, reachOpp, live, liveCount, 0,
			);
			return Float64Array.from(value.subarray(0, COMBOS));
		},
		pairValuesAt(node, board, traverser, hands, handReach, live, liveCount) {
			return pairValues(ctx, node, board, traverser, hands, handReach, live, liveCount);
		},
		averageStrategyAt(node, board) {
			const owner = ctx.tree.player[node] as 0 | 1;
			const index = ctx.players[owner];
			const actions = ctx.tree.numEdges[node];
			const base = ctx.layout.offset[node] + board * actions * index.count;
			const probs = new Float64Array(index.count * actions);
			for (let i = 0; i < index.count; i++) {
				let sum = 0;
				for (let a = 0; a < actions; a++) sum += ctx.strategySum[base + a * index.count + i];
				for (let a = 0; a < actions; a++) {
					probs[i * actions + a] = sum > 0 ? ctx.strategySum[base + a * index.count + i] / sum : 1 / actions;
				}
			}
			return { actions, probs };
		},
	};
}

export { buildActiveLists, makeTerminalScratch };
