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
	/**
	 * First block of each decision node, else -1. A block is one node on one
	 * board — `actions * activeCombosOfItsOwner` slots, exactly what one visit
	 * updates — and block `blockOffset[node] + board` is where 16-bit storage
	 * keeps its scale.
	 */
	readonly blockOffset: Int32Array;
	readonly blocks: number;
	readonly totalSlots: number;
	readonly maxActions: number;
	readonly bytes: number;
}

/**
 * Size storage. A node holds, for every board of its round, `actions` slots
 * per combination its owner can hold on that board. Hands the board blocks
 * get no slots: on a flop solve's rivers that is about one in twelve.
 * @param active from {@link buildActiveLists}
 * @param bytesPerElement 8 for float64, 4 for float32, 2 for 16-bit, which
 *   also keeps one float32 scale per block for each accumulator
 */
export function buildLayout(tree: Tree, runouts: Runouts, active: ActiveLists, bytesPerElement: number): Layout {
	const offset = new Int32Array(tree.nodeCount).fill(-1);
	const blockOffset = new Int32Array(tree.nodeCount).fill(-1);
	let total = 0;
	let blocks = 0;
	let maxActions = 0;

	for (let i = 0; i < tree.decisionNodes.length; i++) {
		const node = tree.decisionNodes[i];
		const actions = tree.numEdges[node];
		if (actions > maxActions) maxActions = actions;
		offset[node] = total;
		blockOffset[node] = blocks;
		total += actions * active.roundTotal[tree.round[node] * 2 + tree.player[node]];
		blocks += runouts.counts[tree.round[node]];
	}
	const scales = bytesPerElement === 2 ? blocks * 4 * 2 : 0;
	return { offset, blockOffset, blocks, totalSlots: total, maxActions, bytes: total * bytesPerElement * 2 + scales };
}

/** Accumulated regrets: float, or 16-bit integers scaled per block. */
export type RegretStore = Float64Array | Float32Array | Int16Array;
/** Accumulated strategy sums: float, or 16-bit integers scaled per block. */
export type SumStore = Float64Array | Float32Array | Uint16Array;

/** Largest magnitudes 16-bit storage encodes. */
const REGRET_STEPS = 32767;
const SUM_STEPS = 65535;

/** Everything a traversal needs. */
export interface Context {
	readonly tree: Tree;
	readonly runouts: Runouts;
	readonly players: readonly [PlayerIndex, PlayerIndex];
	readonly layout: Layout;
	readonly showdown: ShowdownTable;
	readonly regret: RegretStore;
	readonly strategySum: SumStore;
	/**
	 * Per-block scales when the accumulators are 16-bit, else null: a stored
	 * integer `q` in block `b` means `q * scale[b]`. Only updates need them.
	 * Everything that reads a strategy divides each hand's values by their own
	 * total within one block, so the scale cancels and the integers are read
	 * as they are.
	 */
	readonly regretScale: Float32Array | null;
	readonly sumScale: Float32Array | null;
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
	/** Discounted CFR in place of CFR+; see `DCFR_ALPHA`. */
	readonly dcfr: boolean;
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
export interface ActiveLists {
	/**
	 * Start of each list in `list`, indexed by
	 * `(roundBase[round] + board) * 2 + player`.
	 */
	readonly start: Int32Array;
	readonly count: Uint16Array;
	readonly list: Uint16Array;
	/** Each entry's position in its player's index, beside `list`. */
	readonly slot: Uint16Array;
	/**
	 * Same indexing as `start`: active entries of that player on the earlier
	 * boards of the round. A node's block on a board starts `actions` times
	 * this into the node, and the hand at list position `i` sits at `i`.
	 */
	readonly slotStart: Int32Array;
	/** Active entries per `round * 2 + player`, over every board of the round. */
	readonly roundTotal: Float64Array;
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
	const slotStart = new Int32Array(slots);
	const roundTotal = new Float64Array(runouts.rounds * 2);
	const onBoard = new Uint8Array(DECK);

	// Two passes, counting and then filling, so the lists go straight into
	// typed arrays: a flop's lists hold about a million entries, and growing
	// plain arrays to that size left tens of megabytes of heap behind in every
	// thread that built them.
	let list = new Uint16Array(0);
	let entrySlots = new Uint16Array(0);
	for (let pass = 0; pass < 2; pass++) {
		let entries = 0;
		for (let round = 0; round < runouts.rounds; round++) {
			const width = runouts.width[round];
			const cards = runouts.cards[round];
			for (let board = 0; board < runouts.counts[round]; board++) {
				onBoard.fill(0);
				for (let i = 0; i < width; i++) onBoard[cards[board * width + i]] = 1;
				for (let player = 0; player < 2; player++) {
					const index = players[player];
					const slot = (roundBase[round] + board) * 2 + player;
					start[slot] = entries;
					for (let i = 0; i < index.count; i++) {
						const combo = index.combos[i];
						if (onBoard[COMBO_CARDS[combo * 2]] || onBoard[COMBO_CARDS[combo * 2 + 1]]) continue;
						if (pass === 1) {
							list[entries] = combo;
							entrySlots[entries] = i;
						}
						entries++;
					}
					if (pass === 1) {
						count[slot] = entries - start[slot];
						slotStart[slot] = roundTotal[round * 2 + player];
						roundTotal[round * 2 + player] += count[slot];
					}
				}
			}
		}
		if (pass === 0) {
			list = new Uint16Array(entries);
			entrySlots = new Uint16Array(entries);
		}
	}
	return { start, count, list, slot: entrySlots, slotStart, roundTotal, roundBase };
}

/** Where a decision node's block on one board starts in storage. */
export function blockBase(ctx: Context, node: number, board: number): number {
	const lists = ctx.active;
	const listSlot = (lists.roundBase[ctx.tree.round[node]] + board) * 2 + ctx.tree.player[node];
	return ctx.layout.offset[node] + ctx.tree.numEdges[node] * lists.slotStart[listSlot];
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
	readonly live: Uint16Array[];
	/** One block's new values while 16-bit storage re-encodes it. */
	readonly staged: Float64Array;
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
		live: make(() => new Uint16Array(COMBOS)),
		staged: new Float64Array(2 * maxActions * COMBOS),
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

/**
 * Discounted CFR (Brown & Sandholm, 2019) at its usual setting. Before
 * iteration `t` adds its regrets, accumulated positive regret is scaled by
 * `(t-1)^α / ((t-1)^α + 1)` and negative regret by `(t-1)^β / ((t-1)^β + 1)`,
 * so a negative regret is halved each iteration rather than clamped; the
 * strategy sum is scaled by `((t-1) / t)^γ`, weighting iteration `t` about
 * `t^γ`. Every slot is visited exactly once per iteration, by its owner's
 * traversal, so discounting at that visit is the same as discounting
 * everything between iterations — without a separate pass over memory.
 */
const DCFR_ALPHA = 1.5;
const DCFR_BETA = 0;
const DCFR_GAMMA = 2;

export const Mode = { Train: 0, BestResponse: 1, Average: 2 } as const;
export type Mode = (typeof Mode)[keyof typeof Mode];

/**
 * Normalise accumulated values into a strategy: each action's share of the
 * positive values, uniform where there are none. One hand at a time, so its
 * few actions stay in registers rather than round-tripping through a sum array.
 *
 * @param source regrets for the current strategy, strategy sums for the average
 * @param base the block's first slot; the hand at list position `i` is at
 *   `base + i`, each action a further `count` on
 */
function normalise(
	source: RegretStore | SumStore,
	base: number,
	actions: number,
	active: Uint16Array,
	from: number,
	count: number,
	strategy: Float64Array,
): void {
	const uniform = 1 / actions;
	for (let i = 0; i < count; i++) {
		const combo = active[from + i];
		const at = base + i;
		let total = 0;
		for (let a = 0; a < actions; a++) {
			const value = source[at + a * count];
			const positive = value > 0 ? value : 0;
			strategy[a * COMBOS + combo] = positive;
			total += positive;
		}
		if (total > 0) {
			for (let a = 0; a < actions; a++) strategy[a * COMBOS + combo] /= total;
		} else {
			for (let a = 0; a < actions; a++) strategy[a * COMBOS + combo] = uniform;
		}
	}
}

/** Current strategy from positive regrets; uniform where there is none. */
function regretMatch(
	regret: RegretStore,
	base: number,
	actions: number,
	active: Uint16Array,
	from: number,
	count: number,
	strategy: Float64Array,
): void {
	normalise(regret, base, actions, active, from, count, strategy);
}

/** Average strategy from accumulated sums, which are never negative. */
export function averageStrategy(
	strategySum: SumStore,
	base: number,
	actions: number,
	active: Uint16Array,
	from: number,
	count: number,
	strategy: Float64Array,
): void {
	normalise(strategySum, base, actions, active, from, count, strategy);
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
	const isTraverser = owner === traverser;

	// Which hands this player can hold here was settled when the boards were
	// enumerated; it does not depend on the node.
	const lists = ctx.active;
	const listSlot = (lists.roundBase[tree.round[node]] + board) * 2 + owner;
	const active = lists.list;
	const activeFrom = lists.start[listSlot];
	const activeCount = lists.count[listSlot];
	const slotBase = ctx.layout.offset[node] + actions * lists.slotStart[listSlot];

	const strategy = buffers.strategy[depth];
	if (mode === Mode.Train) {
		regretMatch(ctx.regret, slotBase, actions, active, activeFrom, activeCount, strategy);
	} else {
		averageStrategy(ctx.strategySum, slotBase, actions, active, activeFrom, activeCount, strategy);
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

	if (isTraverser && mode === Mode.Train && ctx.applyUpdates && ctx.regretScale !== null) {
		updateQuantised(
			ctx, ctx.layout.blockOffset[node] + board, slotBase, actions,
			active, activeFrom, activeCount, iterWeight, reachMe, strategy, actionValues, out, buffers.staged,
		);
	} else if (isTraverser && mode === Mode.Train && ctx.applyUpdates && ctx.dcfr) {
		// `iterWeight` is the iteration number, counted from 1.
		const previous = iterWeight - 1;
		const grown = previous ** DCFR_ALPHA;
		const shrunk = previous ** DCFR_BETA;
		const keepPositive = grown / (grown + 1);
		const keepNegative = shrunk / (shrunk + 1);
		const keepSum = (previous / iterWeight) ** DCFR_GAMMA;
		const regret = ctx.regret;
		const strategySum = ctx.strategySum;
		for (let a = 0; a < actions; a++) {
			const offset = a * COMBOS;
			const slotRow = slotBase + a * activeCount;
			for (let i = 0; i < activeCount; i++) {
				const combo = active[activeFrom + i];
				const at = slotRow + i;
				const accumulated = regret[at];
				regret[at] =
					accumulated * (accumulated > 0 ? keepPositive : keepNegative) + actionValues[offset + combo] - out[combo];
				strategySum[at] = strategySum[at] * keepSum + reachMe[combo] * strategy[offset + combo];
			}
		}
	} else if (isTraverser && mode === Mode.Train && ctx.applyUpdates) {
		const regret = ctx.regret;
		const strategySum = ctx.strategySum;
		for (let a = 0; a < actions; a++) {
			const offset = a * COMBOS;
			const slotRow = slotBase + a * activeCount;
			for (let i = 0; i < activeCount; i++) {
				const combo = active[activeFrom + i];
				const at = slotRow + i;
				// CFR+: clamp the accumulated regret at zero in the same pass.
				const updated = regret[at] + actionValues[offset + combo] - out[combo];
				regret[at] = updated > 0 ? updated : 0;
				strategySum[at] += iterWeight * reachMe[combo] * strategy[offset + combo];
			}
		}
	}

	return out;
}

/**
 * The regret and strategy-sum update for 16-bit storage, under either rule.
 *
 * A block is rescaled whole on every update: decode, update in float, find the
 * block's largest magnitude, re-encode against it. The block is contiguous, so
 * the new values are staged in block order and re-encoded in one flat pass.
 *
 * Regrets round to nearest. Strategy sums round up or down at random, with
 * odds set by the remainder, so each is right on average: rounded to nearest,
 * a hand whose sum is small beside its block's largest loses most of every
 * iteration's contribution, and measured, exploitability stalls near 0.04%
 * of pot where float32 keeps falling. The randomness is a stream seeded by
 * the block and the iteration, so a solve stays deterministic at any thread
 * count: one block is only ever updated by one thread.
 */
function updateQuantised(
	ctx: Context,
	block: number,
	slotBase: number,
	actions: number,
	active: Uint16Array,
	activeFrom: number,
	activeCount: number,
	iterWeight: number,
	reachMe: Float64Array,
	strategy: Float64Array,
	actionValues: Float64Array,
	out: Float64Array,
	staged: Float64Array,
): void {
	const regret = ctx.regret;
	const strategySum = ctx.strategySum;
	const regretScale = ctx.regretScale!;
	const sumScale = ctx.sumScale!;
	const oldRegret = regretScale[block];
	const oldSum = sumScale[block];
	const size = actions * activeCount;

	// CFR+ is the special case that clamps and keeps everything: a negative
	// regret is floored at zero, a positive one kept whole, and iteration `t`
	// is weighted `t` in the sum.
	let keepPositive = 1;
	let keepNegative = 0;
	let keepSum = oldSum;
	let weight = iterWeight;
	const floor = ctx.dcfr ? -Infinity : 0;
	if (ctx.dcfr) {
		const previous = iterWeight - 1;
		const grown = previous ** DCFR_ALPHA;
		const shrunk = previous ** DCFR_BETA;
		keepPositive = grown / (grown + 1);
		keepNegative = shrunk / (shrunk + 1);
		keepSum = oldSum * (previous / iterWeight) ** DCFR_GAMMA;
		weight = 1;
	}
	const positiveScale = oldRegret * keepPositive;
	const negativeScale = oldRegret * keepNegative;

	let maxReach = 0;
	for (let i = 0; i < activeCount; i++) {
		const r = reachMe[active[activeFrom + i]];
		if (r > maxReach) maxReach = r;
	}
	const bound = SUM_STEPS * keepSum + weight * maxReach;
	const sumStep = bound > 0 ? SUM_STEPS / bound : 0;
	let state = seed(slotBase, iterWeight);
	let largestRegret = 0;
	for (let a = 0; a < actions; a++) {
		const offset = a * COMBOS;
		const row = a * activeCount;
		for (let i = 0; i < activeCount; i++) {
			const combo = active[activeFrom + i];
			const at = slotBase + row + i;
			const q = regret[at];
			let updated = q * (q > 0 ? positiveScale : negativeScale) + actionValues[offset + combo] - out[combo];
			if (updated < floor) updated = 0;
			const magnitude = updated < 0 ? -updated : updated;
			if (magnitude > largestRegret) largestRegret = magnitude;
			staged[row + i] = updated;
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			const sum = (strategySum[at] * keepSum + weight * reachMe[combo] * strategy[offset + combo]) * sumStep + (state >>> 0) * DITHER_UNIT;
			strategySum[at] = sum < SUM_STEPS ? sum : SUM_STEPS;
		}
	}
	const regretStep = largestRegret > 0 ? REGRET_STEPS / largestRegret : 0;
	for (let k = 0; k < size; k++) {
		const r = staged[k] * regretStep;
		regret[slotBase + k] = r < 0 ? r - 0.5 : r + 0.5;
	}
	regretScale[block] = largestRegret / REGRET_STEPS;
	sumScale[block] = bound / SUM_STEPS;
}

/** Maps a 32-bit unsigned integer onto [0, 1). */
const DITHER_UNIT = 1 / 4294967296;

/** A non-zero xorshift state for a block on an iteration. */
function seed(block: number, iteration: number): number {
	let h = Math.imul(block ^ Math.imul(iteration, 0x9e3779b1), 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return h === 0 ? 0x6d2b79f5 : h;
}

/** A whole-tree traversal, returning the root value vector. */
export type RootTraversal = (mode: Mode, traverser: 0 | 1, iterWeight: number) => Float64Array;

/** A prepared solver. */
export interface Solver {
	readonly ctx: Context;
	/**
	 * One traversal for `traverser` on this thread alone, returning the root
	 * value vector.
	 */
	traverseRoot(mode: Mode, traverser: 0 | 1, iterWeight: number): Float64Array;
	/**
	 * Route the whole-tree traversals behind `iterate`, `expectedValue` and
	 * `exploitability` elsewhere — a worker pool — or back to `traverseRoot`
	 * with null.
	 */
	useRoot(root: RootTraversal | null): void;
	/** One chance node's subtree, honouring the context shard. */
	traverseChance(
		mode: Mode,
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

	let root: RootTraversal = run;

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
		useRoot(next) {
			root = next ?? run;
		},
		traverseChance(mode, traverser, iterWeight, node, me, opp) {
			return traverse(
				ctx, buffers, mode, traverser, iterWeight, node, 0, me, opp, rootLive, rootCount, 0,
			);
		},
		iterate(count, from) {
			for (let i = 0; i < count; i++) {
				const t = from + i + 1;
				root(Mode.Train, 0, t);
				root(Mode.Train, 1, t);
			}
		},
		expectedValue() {
			return [total(root(Mode.Average, 0, 0), 0), total(root(Mode.Average, 1, 0), 1)];
		},
		exploitability() {
			const br0 = total(root(Mode.BestResponse, 0, 0), 0);
			const br1 = total(root(Mode.BestResponse, 1, 0), 1);
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
			const base = blockBase(ctx, node, board);
			const lists = ctx.active;
			const listSlot = (lists.roundBase[ctx.tree.round[node]] + board) * 2 + owner;
			const from = lists.start[listSlot];
			const count = lists.count[listSlot];
			// Hands the board blocks have no storage, and read as uniform.
			const probs = new Float64Array(index.count * actions).fill(1 / actions);
			for (let i = 0; i < count; i++) {
				const at = lists.slot[from + i] * actions;
				let sum = 0;
				for (let a = 0; a < actions; a++) sum += ctx.strategySum[base + a * count + i];
				if (sum <= 0) continue;
				for (let a = 0; a < actions; a++) probs[at + a] = ctx.strategySum[base + a * count + i] / sum;
			}
			return { actions, probs };
		},
	};
}

export { buildActiveLists, makeTerminalScratch };
