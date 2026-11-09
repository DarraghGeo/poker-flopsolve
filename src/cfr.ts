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
import { makeTerminalScratch } from './showdown.ts';
import type { HandSpace } from './hands.ts';
import { foldValuesHands, foldValuesPacked, showdownValuesHands, showdownValuesPacked } from './hands.ts';
import type { Tree } from './tree.ts';
import { pairValues } from './pairs.ts';
import type { Kernels } from './kernels.ts';
import { loadKernels } from './kernels.ts';
import { NodeKind } from './tree.ts';
import type { LineScale } from './lines.ts';

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

/**
 * Whether a combination is the one stored for its mirror orbit on a board:
 * the lowest combination the board's own symmetries send it to. A board
 * without symmetry stores every hand.
 */
export function orbitLeader(runouts: Runouts, round: number, board: number, combo: number): boolean {
	const from = runouts.stabiliserStart[round][board];
	const to = runouts.stabiliserStart[round][board + 1];
	for (let k = from + 1; k < to; k++) {
		if (runouts.maps.combo[runouts.stabiliserMap[round][k]][combo] < combo) return false;
	}
	return true;
}

const INT32_MAX = 2 ** 31 - 1;

/** Slot offsets for every decision node. */
export interface Layout {
	/**
	 * Where each decision node's storage starts. Its block on a board is
	 * `actions` rows of the owner's hands live there, in hand-list order —
	 * entry `i` of their active list — so a row is as long as that list and
	 * blocked hands take no room. See `blockBase`. Int32 while every slot
	 * fits one, which keeps the traversal's indexing on integers; Float64,
	 * exact to 2^53, for a tree past 2^31 slots, where Int32 would wrap.
	 * With compact storage, a node of a compact round's offset is into its
	 * chunk of the compact arrays instead.
	 */
	readonly offset: Int32Array | Float64Array;
	/** For each list slot `(roundBase[r] + board) * 2 + p`: rows before this board's. */
	readonly rowStart: Int32Array;
	/** First list index of each round, as `ActiveLists.roundBase`. */
	readonly roundBase: Int32Array;
	/**
	 * First block of each decision node, else -1. A block is one node on one
	 * board — `actions * combosOfItsOwner` slots, exactly what one visit
	 * updates — and block `blockOffset[node] + board` is where 16-bit storage
	 * keeps its scale.
	 */
	readonly blockOffset: Int32Array;
	readonly blocks: number;
	readonly totalSlots: number;
	/** Slots one iteration walks: `totalSlots`, and with shared storage what it would be unshared. */
	readonly walkedSlots: number;
	readonly maxActions: number;
	readonly bytes: number;
	/**
	 * Whether some nodes share another's storage (`SpotConfig.shareHistories`):
	 * a block may then be visited more than once an iteration.
	 */
	readonly shared: boolean;
	/**
	 * Per node, 1 where regret updates are weighted by the actor's own reach:
	 * nodes whose storage more than one history shares, under
	 * `shareHistories` with that weighting. Null otherwise.
	 */
	readonly reachWeighted: Uint8Array | null;
	/**
	 * The first round stored compactly (see `CompactStorage`); the round
	 * count when none is, so `round >= compactFrom` says whether a node is.
	 */
	readonly compactFrom: number;
	/** Slots of compactly stored regrets; 0 without compact storage. */
	readonly compactSlots: number;
	/** Per node of a compact round: where its hands' scales start in its chunk, else -1. */
	readonly handOffset: Float64Array | null;
	readonly compactHands: number;
	/**
	 * Compact storage comes in chunks, each its own buffer, because browsers
	 * refuse an ArrayBuffer of 2 GiB or more. A node's storage is all in one
	 * chunk: per node of a compact round, which (else -1); its `offset` and
	 * `handOffset` count from that chunk's start.
	 */
	readonly compactChunk: Int32Array | null;
	/** Per chunk: its slots, its hands, and the slots of every chunk before it. */
	readonly chunkSlots: readonly number[];
	readonly chunkHands: readonly number[];
	readonly chunkStart: readonly number[];
}

/**
 * Compact storage, for `SpotConfig.compactStorage`: from round `from` on,
 * regrets and (with `sums`) strategy sums as 8-bit integers; without sums,
 * each hand's strategy there is read as the current profile.
 */
export interface CompactPlan {
	/** First round stored compactly, counted from the spot's first. */
	readonly from: number;
	/** Largest magnitude stored: 127 for 8 bits. */
	readonly steps: number;
	/** One power-of-two scale per hand per block, else one float64 per block. */
	readonly perHand: boolean;
	/** Round at random, unbiased, rather than to nearest. */
	readonly stochastic: boolean;
	/** Keep the regrets as float32: only the sums are dropped. */
	readonly float: boolean;
	/** Largest buffer to allocate; compact storage is split in chunks no bigger. */
	readonly chunkBytes: number;
	/**
	 * Keep 8-bit strategy sums too, with their own per-hand scale, so these
	 * nodes keep the average strategy. Per-hand scale only.
	 */
	readonly sums: boolean;
}

/**
 * Size storage. A node's block is `boards * actions * combosOfItsOwner`.
 * @param bytesPerElement 8 for float64, 4 for float32, 2 for 16-bit, which
 *   also keeps one float64 scale per block for each accumulator
 * @param alias each node's storage owner, from `aliasHistories`: a node
 *   owned by another takes its owner's blocks and adds none. Unset, every
 *   node owns its own.
 * @param compact compact storage's plan, for `SpotConfig.compactStorage`
 */
export function buildLayout(
	tree: Tree,
	runouts: Runouts,
	players: readonly [PlayerIndex, PlayerIndex],
	bytesPerElement: number,
	alias?: Int32Array,
	reachWeighted = false,
	compact?: CompactPlan,
	boards?: { readonly from: Int32Array; readonly to: Int32Array },
): Layout {
	// How many of each player's hands each board leaves live: a block's rows.
	const roundBase = new Int32Array(runouts.rounds + 1);
	for (let round = 0; round < runouts.rounds; round++) roundBase[round + 1] = roundBase[round] + runouts.counts[round];
	const rowStart = new Int32Array(roundBase[runouts.rounds] * 2);
	const totals = new Int32Array(runouts.rounds * 2);
	const onBoard = new Uint8Array(DECK);
	for (let round = 0; round < runouts.rounds; round++) {
		const width = runouts.width[round];
		const cards = runouts.cards[round];
		for (let board = 0; board < runouts.counts[round]; board++) {
			onBoard.fill(0);
			for (let i = 0; i < width; i++) onBoard[cards[board * width + i]] = 1;
			for (let player = 0; player < 2; player++) {
				const index = players[player];
				let live = 0;
				for (let i = 0; i < index.count; i++) {
					const combo = index.combos[i];
					if (onBoard[COMBO_CARDS[combo * 2]] || onBoard[COMBO_CARDS[combo * 2 + 1]]) continue;
					if (!orbitLeader(runouts, round, board, combo)) continue;
					live++;
				}
				rowStart[(roundBase[round] + board) * 2 + player] = totals[round * 2 + player];
				totals[round * 2 + player] += live;
			}
		}
	}

	const offset = new Float64Array(tree.nodeCount).fill(-1);
	const blockOffset = new Int32Array(tree.nodeCount).fill(-1);
	const compactFrom = compact ? compact.from : runouts.rounds;
	const handOffset = compact ? new Float64Array(tree.nodeCount).fill(-1) : null;
	const compactChunk = compact ? new Int32Array(tree.nodeCount).fill(-1) : null;
	const chunkSlots: number[] = [];
	const chunkHands: number[] = [];
	const chunkStart: number[] = [];
	const width = compact?.float ? 4 : 1;
	let total = 0;
	let compactSlots = 0;
	let compactHands = 0;
	let blocks = 0;
	let maxActions = 0;
	let shared = false;
	let walked = 0;
	for (let i = 0; i < tree.decisionNodes.length; i++) {
		const node = tree.decisionNodes[i];
		const actions = tree.numEdges[node];
		if (actions > maxActions) maxActions = actions;
		const hands = totals[tree.round[node] * 2 + tree.player[node]];
		if (boards) {
			// Line runouts (never with `alias` or `compact`): only the boards of
			// the node's own line, blocks still addressed by board index,
			// shifted so that its first board starts here.
			const round = tree.round[node];
			const slot = (board: number): number => (roundBase[round] + board) * 2 + tree.player[node];
			const end = boards.to[node] < runouts.counts[round] ? rowStart[slot(boards.to[node])] : hands;
			const begin = rowStart[slot(boards.from[node])];
			walked += actions * (end - begin);
			offset[node] = total - actions * begin;
			blockOffset[node] = blocks - boards.from[node];
			total += actions * (end - begin);
			blocks += boards.to[node] - boards.from[node];
			continue;
		}
		// An owner always comes before the nodes it owns, so its blocks are placed.
		walked += actions * hands;
		if (alias !== undefined && alias[node] !== node) {
			const owner = alias[node];
			if (owner > node) throw new Error('buildLayout: a storage owner must come before the nodes it owns');
			offset[node] = offset[owner];
			blockOffset[node] = blockOffset[owner];
			if (compact) {
				handOffset![node] = handOffset![owner];
				compactChunk![node] = compactChunk![owner];
			}
			shared = true;
			continue;
		}
		blockOffset[node] = blocks;
		blocks += runouts.counts[tree.round[node]];
		if (tree.round[node] >= compactFrom) {
			const slots = actions * hands;
			let chunk = chunkSlots.length - 1;
			if (slots * width > compact!.chunkBytes) {
				throw new Error(
					`compactStorage.chunkBytes is ${compact!.chunkBytes}, but one decision needs ${slots * width} bytes`,
				);
			}
			if (chunk < 0 || (chunkSlots[chunk] + slots) * width > compact!.chunkBytes || chunkHands[chunk] + hands > compact!.chunkBytes) {
				chunk++;
				chunkSlots.push(0);
				chunkHands.push(0);
				chunkStart.push(compactSlots);
			}
			compactChunk![node] = chunk;
			offset[node] = chunkSlots[chunk];
			handOffset![node] = chunkHands[chunk];
			chunkSlots[chunk] += slots;
			chunkHands[chunk] += hands;
			compactSlots += slots;
			compactHands += hands;
		} else {
			offset[node] = total;
			total += actions * hands;
		}
	}
	const scales = bytesPerElement === 2 ? blocks * 8 * 2 : 0;
	const compactBytes = !compact
		? 0
		: compact.float
			? compactSlots * 4
			: (compactSlots + (compact.perHand ? compactHands : blocks * 8)) * (compact.sums ? 2 : 1);
	return {
		offset: Math.max(total, ...chunkSlots) <= INT32_MAX ? Int32Array.from(offset) : offset,
		blockOffset, blocks, totalSlots: total, walkedSlots: walked, maxActions, rowStart, roundBase,
		bytes: total * bytesPerElement * 2 + scales + compactBytes,
		shared,
		reachWeighted: shared && reachWeighted ? sharedNodes(tree, alias!) : null,
		compactFrom, compactSlots, handOffset, compactHands, compactChunk, chunkSlots, chunkHands, chunkStart,
	};
}

/** 1 for every node whose storage more than one node uses, owner included. */
function sharedNodes(tree: Tree, alias: Int32Array): Uint8Array {
	const marks = new Uint8Array(tree.nodeCount);
	for (let node = 0; node < tree.nodeCount; node++) {
		if (alias[node] !== node) marks[node] = marks[alias[node]] = 1;
	}
	return marks;
}

/**
 * Where a node's block on a board starts: `actions` rows of the owner's hands
 * live on that board, in their hand-list order.
 */
export function blockBase(layout: Layout, tree: Tree, node: number, board: number): number {
	// Into the compact regrets for a node of a compact round.
	const slot = (layout.roundBase[tree.round[node]] + board) * 2 + tree.player[node];
	return layout.offset[node] + tree.numEdges[node] * layout.rowStart[slot];
}

/** Accumulated regrets: float, or 16-bit integers scaled per block. */
export type RegretStore = Float64Array | Float32Array | Int16Array;
/** Regrets as one of the stores, or compact storage's 8-bit ones. */
export type AnyRegrets = RegretStore | Int8Array;
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
	readonly regretScale: Float64Array | null;
	readonly sumScale: Float64Array | null;
	/**
	 * Compact storage (`Approximations.compactStorage`), else unset: nodes of
	 * rounds from `compact.from` on keep only `compactRegret`, one array per
	 * chunk (`layout.compactChunk`) laid out by `layout.offset` as other
	 * nodes' regrets are, and each hand's scale in
	 * `handShift` — a stored integer `q` means `q * 2^(shift - SHIFT_BIAS)`,
	 * and a shift of 0 means the hand's regrets are all zero. With a block
	 * scale instead, `compactScale` holds it as `regretScale` does for 16-bit
	 * storage.
	 */
	readonly compact?: CompactPlan | null;
	readonly compactRegret?: readonly (Int8Array | Float32Array)[] | null;
	readonly handShift?: readonly Uint8Array[] | null;
	/**
	 * With `compact.sums`: 8-bit strategy sums, laid out as `compactRegret`,
	 * and their per-hand scales, as `handShift` is for regrets.
	 */
	readonly compactSum?: readonly Uint8Array[] | null;
	readonly sumShift?: readonly Uint8Array[] | null;
	/** Compact storage's per-block scales, when it keeps one per block rather than per hand. */
	readonly compactScale?: Float64Array | null;
	readonly scratch: TerminalScratch;
	readonly chipScale: number;
	/**
	 * With `SpotConfig.lineRunouts`: per chance node, the children table its
	 * deal uses and the per-hand rescaling of its values (see `lines.ts`).
	 * Unset, every deal uses `runouts.childStart`.
	 */
	readonly lineStarts?: readonly (Int32Array | null)[];
	readonly lineScales?: readonly (LineScale | null)[];
	/** Which combinations each player can hold on each board. */
	readonly active: ActiveLists;
	/** How hand-space vectors move between boards and meet at terminals. */
	readonly hands: HandSpace;
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
	/**
	 * How a stored board stands for the deals it represents. False: add its
	 * values relabelled, which is exact when reach is symmetric under the
	 * spot's symmetries — always so from the root, since the ranges are. True:
	 * walk it once per represented deal with that deal's reach relabelled
	 * onto it, exact for any reach, at the cost of the walks saved.
	 */
	expandOrbits: boolean;
	/** Use the WebAssembly SIMD kernels where the platform has them. */
	readonly simd: boolean;
	/**
	 * Chance sampling with baselines, for `Approximations.chanceSampling`;
	 * unset or null for the exact traversal.
	 */
	sampling?: Sampling | null;
	/**
	 * With shared storage (`Layout.shared`), per block the iteration DCFR
	 * last discounted it in. A shared block is visited once per history that
	 * reaches it, and only the first visit of an iteration discounts. Unset or
	 * null for unshared storage, where every block is visited once.
	 */
	discounted?: Int32Array | null;
}

/** How chance sampling picks deals; see `Approximations.chanceSampling`. */
export interface SamplingOptions {
	/**
	 * Probability of walking each deal on a training iteration, chosen at
	 * random per deal and iteration. Default 0.35. Ignored with `every`.
	 */
	readonly p?: number;
	/**
	 * Walk every deal exactly once every this many iterations, in rotation,
	 * instead of at random. Measured, it converges worse than random at the
	 * same rate; kept for comparison.
	 */
	readonly every?: number;
	/**
	 * Betting rounds whose deals are sampled, counted from the spot's first:
	 * from a flop, 1 is the turn and 2 the river. Default every round after
	 * the first.
	 */
	readonly rounds?: readonly number[];
	/**
	 * How a walked deal's fresh value meets its baseline: 'unbiased' adds
	 * `(v - b) / p` to the baseline, the VR-MCCFR estimator; 'latest' uses
	 * `v` itself, the freshest value without the correction.
	 */
	readonly estimator?: 'unbiased' | 'latest';
	/** Apply the DCFR discounts a skipped subtree missed when it is next walked. Default true. */
	readonly catchUp?: boolean;
}

/** Where sampling keeps what, for a spot; see `makeSampling`. */
export interface SamplingPlan {
	readonly rounds: Uint8Array;
	readonly p: number;
	readonly every: number;
	readonly unbiased: boolean;
	readonly catchUp: boolean;
	/** Per chance node into a sampled round: where its baselines start, else -1. */
	readonly baseOffset: Int32Array;
	/** Per list slot of a sampled round: offset of that board and player's baseline within a node's. */
	readonly boardOffset: Int32Array;
	/** Per chance node: where its last-walk entries start, two per child board. */
	readonly walkOffset: Int32Array;
	/** Baseline values, last-walk entries and blocks the state holds. */
	readonly values: number;
	readonly walks: number;
	readonly blocks: number;
}

/** Sampling state: baselines, when each was last walked, when each block was last updated. */
export interface Sampling extends SamplingPlan {
	readonly baseline: Float32Array;
	readonly lastWalk: Int32Array;
	/** Per block: the iteration it was last updated in, for DCFR catch-up. */
	readonly lastUpdate: Int32Array;
	/** Memory the state takes. */
	readonly bytes: number;
}

/** Lay out sampling state for a spot. */
export function planSampling(
	tree: Tree,
	runouts: Runouts,
	active: ActiveLists,
	layout: Layout,
	options: SamplingOptions,
): SamplingPlan {
	const rounds = new Uint8Array(runouts.rounds);
	const asked = options.rounds ?? Array.from({ length: runouts.rounds }, (_, r) => r);
	for (const r of asked) if (r > 0 && r < runouts.rounds) rounds[r] = 1;
	const boardOffset = new Int32Array(active.roundBase[runouts.rounds] * 2);
	const perNode = new Float64Array(runouts.rounds);
	for (let r = 1; r < runouts.rounds; r++) {
		if (!rounds[r]) continue;
		let total = 0;
		for (let b = 0; b < runouts.counts[r]; b++) {
			for (let p = 0; p < 2; p++) {
				const slot = (active.roundBase[r] + b) * 2 + p;
				boardOffset[slot] = total;
				total += active.count[slot];
			}
		}
		perNode[r] = total;
	}
	const baseOffset = new Int32Array(tree.nodeCount).fill(-1);
	const walkOffset = new Int32Array(tree.nodeCount).fill(-1);
	let values = 0;
	let walks = 0;
	for (let node = 0; node < tree.nodeCount; node++) {
		if (tree.kind[node] !== NodeKind.Chance) continue;
		const next = tree.round[node] + 1;
		if (next >= runouts.rounds || !rounds[next]) continue;
		baseOffset[node] = values;
		walkOffset[node] = walks;
		values += perNode[next];
		walks += runouts.counts[next] * 2;
	}
	if (values > 0x3fffffff) throw new Error('chanceSampling: too many baseline values for this spot');
	const every = options.every ?? 0;
	const p = every > 0 ? 1 / every : (options.p ?? 0.35);
	if (!(p > 0 && p <= 1)) throw new Error(`chanceSampling: p must be in (0, 1], got ${p}`);
	return {
		rounds, p, every,
		unbiased: (options.estimator ?? 'unbiased') === 'unbiased',
		catchUp: options.catchUp ?? true,
		baseOffset, boardOffset, walkOffset,
		values, walks, blocks: layout.blocks,
	};
}

/** Bytes sampling state takes beyond its plan's small offset tables. */
export function samplingBytes(plan: SamplingPlan): number {
	return (plan.values + plan.walks + plan.blocks) * 4;
}

/**
 * Sampling state over the given storage, or freshly allocated by `allocate`
 * (plain buffers by default; shared ones for a threaded solve, whose threads
 * each keep the state of their own runouts in it).
 */
export function makeSampling(
	plan: SamplingPlan,
	storage?: { baseline: Float32Array; lastWalk: Int32Array; lastUpdate: Int32Array },
	allocate: (bytes: number) => ArrayBuffer | SharedArrayBuffer = (bytes) => new ArrayBuffer(bytes),
): Sampling {
	return {
		...plan,
		baseline: storage?.baseline ?? new Float32Array(allocate(plan.values * 4)),
		lastWalk: storage?.lastWalk ?? new Int32Array(allocate(plan.walks * 4)),
		lastUpdate: storage?.lastUpdate ?? new Int32Array(allocate(plan.blocks * 4)),
		bytes: samplingBytes(plan),
	};
}

/** Whether a deal is walked on an iteration. */
function sampled(s: Sampling, node: number, board: number, t: number): boolean {
	let h = Math.imul(node ^ Math.imul(board, 0x9e3779b1), 0x85ebca6b);
	if (s.every > 0) {
		h ^= h >>> 13;
		h = Math.imul(h, 0xc2b2ae35);
		h ^= h >>> 16;
		return ((h >>> 0) + t) % s.every === 0;
	}
	h ^= Math.imul(t, 0x27d4eb2f);
	h ^= h >>> 15;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 13;
	h = Math.imul(h, 0x165667b1);
	h ^= h >>> 16;
	return (h >>> 0) / 4294967296 < s.p;
}

const factorCache: { keepPositive: number; keepNegative: number; keepSum: number }[] = [];
function cachedFactors(t: number): { keepPositive: number; keepNegative: number; keepSum: number } {
	let f = factorCache[t];
	if (f === undefined) factorCache[t] = f = dcfrFactors(t);
	return f;
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
	/** Start of each list in `list`, indexed by `slotOf(round, board, player)`. */
	readonly start: Int32Array;
	readonly count: Uint16Array;
	readonly list: Uint16Array;
	/**
	 * Each entry's storage slot in its player's index, beside `list`, so the
	 * hot loops read it in sequence instead of looking it up per combination.
	 */
	readonly slot: Uint16Array;
	/** First list index of each round. */
	readonly roundBase: Int32Array;
	/** Each entry's two cards, beside `list`. */
	readonly cardA: Uint8Array;
	readonly cardB: Uint8Array;
	/**
	 * Each entry's strength on its final board, beside `list`; final-board
	 * lists are sorted by it. Zero elsewhere.
	 */
	readonly strength: Int32Array;
	/**
	 * On a board with symmetry left, a list holds one hand per mirror orbit —
	 * the lowest combination, see `orbitLeader` — standing for the whole
	 * orbit. Mirrored hands play alike, since the board and both ranges look
	 * the same after swapping suits, so one hand's strategy, reach and value
	 * are all of theirs; storing them once is exact, and shortens every vector
	 * there. Whether a list holds any orbit of more than one hand, beside
	 * `start`: only those need the weighted deal and terminal kernels.
	 */
	readonly packed: Uint8Array;
	/** How many hands each entry stands for, beside `list`: 1 unpacked. */
	readonly multiplicity: Float64Array;
	/**
	 * The hands each entry stands for, itself first: `memberCombo` and their
	 * cards from `memberStart[e]` to `memberStart[e + 1]`.
	 */
	readonly memberStart: Int32Array;
	readonly memberCombo: Uint16Array;
	readonly memberA: Uint8Array;
	readonly memberB: Uint8Array;
}

function buildActiveLists(
	runouts: Runouts,
	players: readonly [PlayerIndex, PlayerIndex],
	showdown: ShowdownTable | null = null,
): ActiveLists {
	const roundBase = new Int32Array(runouts.rounds + 1);
	for (let round = 0; round < runouts.rounds; round++) {
		roundBase[round + 1] = roundBase[round] + runouts.counts[round];
	}
	const slots = roundBase[runouts.rounds] * 2;

	const start = new Int32Array(slots);
	const count = new Uint16Array(slots);
	const packedSlot = new Uint8Array(slots);
	const entries: number[] = [];
	const entrySlots: number[] = [];
	const memberStart: number[] = [];
	const members: number[] = [];
	const onBoard = new Uint8Array(DECK);
	const seen = new Uint8Array(COMBOS);

	for (let round = 0; round < runouts.rounds; round++) {
		const width = runouts.width[round];
		const cards = runouts.cards[round];
		const stabStart = runouts.stabiliserStart[round];
		const stabMap = runouts.stabiliserMap[round];
		for (let board = 0; board < runouts.counts[round]; board++) {
			onBoard.fill(0);
			for (let i = 0; i < width; i++) onBoard[cards[board * width + i]] = 1;
			const symmetric = stabStart[board + 1] - stabStart[board] > 1;
			for (let player = 0; player < 2; player++) {
				const index = players[player];
				const slot = (roundBase[round] + board) * 2 + player;
				start[slot] = entries.length;
				const here: number[] = [];
				for (let i = 0; i < index.count; i++) {
					const combo = index.combos[i];
					if (onBoard[COMBO_CARDS[combo * 2]] || onBoard[COMBO_CARDS[combo * 2 + 1]]) continue;
					if (symmetric && !orbitLeader(runouts, round, board, combo)) continue;
					here.push(i);
				}
				// On a final board, hands in order of strength: a showdown is
				// then one contiguous sweep. Order is free everywhere else.
				if (showdown !== null && round === runouts.rounds - 1) {
					const group = strengthOn(showdown, board);
					here.sort((x, y) => group[index.combos[x]] - group[index.combos[y]] || x - y);
				}
				for (const i of here) {
					const combo = index.combos[i];
					entries.push(combo);
					entrySlots.push(i);
					memberStart.push(members.length);
					members.push(combo);
					if (!symmetric) continue;
					// The rest of its orbit, which it stands for.
					seen[combo] = 1;
					for (let k = stabStart[board] + 1; k < stabStart[board + 1]; k++) {
						const image = runouts.maps.combo[stabMap[k]][combo];
						if (seen[image]) continue;
						seen[image] = 1;
						members.push(image);
						packedSlot[slot] = 1;
					}
					for (let m = memberStart[memberStart.length - 1]; m < members.length; m++) seen[members[m]] = 0;
				}
				count[slot] = entries.length - start[slot];
			}
		}
	}
	memberStart.push(members.length);

	const list = Uint16Array.from(entries);
	const cardA = new Uint8Array(list.length);
	const cardB = new Uint8Array(list.length);
	const multiplicity = new Float64Array(list.length);
	for (let e = 0; e < list.length; e++) {
		cardA[e] = COMBO_CARDS[list[e] * 2];
		cardB[e] = COMBO_CARDS[list[e] * 2 + 1];
		multiplicity[e] = memberStart[e + 1] - memberStart[e];
	}
	const memberCombo = Uint16Array.from(members);
	const memberA = new Uint8Array(members.length);
	const memberB = new Uint8Array(members.length);
	for (let m = 0; m < members.length; m++) {
		memberA[m] = COMBO_CARDS[members[m] * 2];
		memberB[m] = COMBO_CARDS[members[m] * 2 + 1];
	}
	// Each entry's strength on its final board, for the showdown sweep.
	const strength = new Int32Array(list.length);
	if (showdown !== null) {
		const last = runouts.rounds - 1;
		for (let board = 0; board < runouts.counts[last]; board++) {
			const group = strengthOn(showdown, board);
			for (let player = 0; player < 2; player++) {
				const slot = (roundBase[last] + board) * 2 + player;
				for (let e = start[slot]; e < start[slot] + count[slot]; e++) strength[e] = group[list[e]];
			}
		}
	}
	return {
		start, count, list, slot: Uint16Array.from(entrySlots), roundBase,
		cardA, cardB, strength, packed: packedSlot, multiplicity, memberStart: Int32Array.from(memberStart), memberCombo, memberA, memberB,
	};
}

const strengthScratch = new Int32Array(COMBOS);

/** Each combination's tie-group index on a final board: higher is stronger. Shared scratch. */
function strengthOn(table: ShowdownTable, board: number): Int32Array {
	const orderBase = board * table.stride;
	const groupBase = board * (table.stride + 1);
	for (let g = 0; g < table.groupCount[board]; g++) {
		for (let i = table.groupStart[groupBase + g]; i < table.groupStart[groupBase + g + 1]; i++) {
			strengthScratch[table.order[orderBase + i]] = g;
		}
	}
	return strengthScratch;
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
	readonly strategy: Float64Array[];
	readonly actionValues: Float64Array[];
	readonly live: Uint16Array[];
	/** Reach and live hands relabelled onto a stored board, for `expandOrbits`. */
	readonly mappedMe: Float64Array[];
	readonly mappedOpp: Float64Array[];
	readonly mappedLive: Uint16Array[];
	/** This thread's SIMD kernels, whose memory holds `strategy`; null for JavaScript. */
	readonly kernels: Kernels | null;
	/** 52 doubles for the terminal kernels' per-card sums, kept zero between uses. */
	readonly cardSums: Float64Array;
}

export function makeBuffers(tree: Tree, maxActions: number, simd: boolean): Buffers {
	const depth = treeDepth(tree) + 2;
	const make = <T>(factory: () => T): T[] => Array.from({ length: depth }, factory);
	const kernels = simd ? loadKernels(depth, maxActions * COMBOS) : null;
	return {
		kernels,
		cardSums: new Float64Array(DECK),
		value: make(() => new Float64Array(COMBOS)),
		reachFor: [make(() => new Float64Array(COMBOS)), make(() => new Float64Array(COMBOS))],
		strategy: kernels
			? Array.from({ length: depth }, (_, d) => kernels.strategy(d))
			: make(() => new Float64Array(maxActions * COMBOS)),
		actionValues: make(() => new Float64Array(maxActions * COMBOS)),
		live: make(() => new Uint16Array(COMBOS)),
		mappedMe: make(() => new Float64Array(COMBOS)),
		mappedOpp: make(() => new Float64Array(COMBOS)),
		mappedLive: make(() => new Uint16Array(COMBOS)),
	};
}

export function treeDepth(tree: Tree): number {
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
 * Discounted CFR (Brown & Sandholm, 2019). Before iteration `t` adds its
 * regrets, accumulated positive regret is scaled by `s^α / (s^α + 1)` with
 * `s = t - 2` (see `dcfrFactors`) and negative regret by `s^β / (s^β + 1)`,
 * so a negative regret is halved each iteration rather than clamped; the
 * strategy sum is scaled by `((t-1) / t)^γ`, weighting iteration `t` about
 * `t^γ`. Every slot is visited exactly once per iteration, by its owner's
 * traversal, so discounting at that visit is the same as discounting
 * everything between iterations — without a separate pass over memory.
 *
 * Each iteration adds its strategy to the sum as it is, not weighted by the
 * hand's own reach (as postflop-solver does). A hand that equilibrium play
 * stops sending to a node then still averages to what its regrets settled on
 * there; with own-reach weighting the near-uniform early iterations swamped
 * it, so play continued off the path was close to random (issue #8). This
 * holds at every precision, here and in assembly/engine.ts. CFR+ keeps the
 * own-reach weighting: its iterates oscillate, and unweighted they averaged
 * to 2–3× the exploitability at the same iteration count.
 */
// assembly/engine.ts repeats these in its sampling catch-up; keep in step.
const DCFR_ALPHA = 1.5;
const DCFR_BETA = 0;
const DCFR_GAMMA = 3;

/**
 * DCFR's three factors before iteration `t` (counted from 1) adds its own
 * values: what positive regret, negative regret and the strategy sum keep.
 *
 * The positive factor counts iterations from the second, so iteration 2
 * keeps none of iteration 1's positive regret: that came from the uniform
 * starting strategy and says little. Measured against counting from the
 * first, it reaches 0.3% of pot in 10–15% fewer iterations on flop and turn
 * spots and is never worse; with γ 3 rather than 2, on top, it is better
 * still on most and never worse. A restart of the average at powers of 4 was
 * tried too and was worse on the turn.
 */
export function dcfrFactors(t: number): { keepPositive: number; keepNegative: number; keepSum: number } {
	const age = t > 2 ? t - 2 : 0;
	const grown = age ** DCFR_ALPHA;
	const shrunk = age ** DCFR_BETA;
	return {
		keepPositive: grown / (grown + 1),
		keepNegative: shrunk / (shrunk + 1),
		keepSum: ((t - 1) / t) ** DCFR_GAMMA,
	};
}

/**
 * What a traversal plays and does. Train plays the current (regret-matched)
 * profile and updates the traverser's regrets and sums; Current plays that
 * same profile and updates nothing, for reading its values; Average plays the
 * average profile; BestResponse has the traverser best-respond to it.
 */
export const Mode = { Train: 0, BestResponse: 1, Average: 2, Current: 3 } as const;
export type Mode = (typeof Mode)[keyof typeof Mode];

/**
 * Normalise accumulated values into a strategy: each action's share of the
 * positive values, uniform where there are none. One hand at a time, so its
 * few actions stay in registers rather than round-tripping through a sum array.
 *
 * Storage and strategy share a layout: `actions` rows of `count` hands.
 *
 * @param source regrets, for the current strategy
 */
function normalise(
	source: AnyRegrets | SumStore,
	base: number,
	actions: number,
	count: number,
	strategy: Float64Array,
): void {
	const uniform = 1 / actions;
	for (let i = 0; i < count; i++) {
		const at = base + i;
		let total = 0;
		for (let a = 0; a < actions; a++) {
			const value = source[at + a * count];
			const positive = value > 0 ? value : 0;
			strategy[a * count + i] = positive;
			total += positive;
		}
		if (total > 0) {
			for (let a = 0; a < actions; a++) strategy[a * count + i] /= total;
		} else {
			for (let a = 0; a < actions; a++) strategy[a * count + i] = uniform;
		}
	}
}

/** Current strategy from positive regrets; uniform where there is none. */
export function regretMatch(regret: AnyRegrets, base: number, actions: number, count: number, strategy: Float64Array): void {
	normalise(regret, base, actions, count, strategy);
}

/**
 * Average strategy from accumulated sums, which are never negative.
 *
 * A hand whose sum is zero here has no average to give: under CFR+, whose
 * sums follow the hand's own reach, it never reached this node on its own;
 * under DCFR, whose sums do not (issue #8), only a loaded strategy with gaps,
 * a warm start or 16-bit rounding leaves one. Its regrets are still updated — weighted by
 * the opponent's reach — so it plays the current strategy: whatever goes on to
 * continue it from here (a best response, another player's rules, a user
 * browsing the line) then sees sensible play rather than every action at an
 * equal share. Uniform only where the regrets are all non-positive too, or
 * where there are none (an `analysisOnly` run).
 *
 * @param regret the regrets beside `strategySum`, or omitted for none
 */
export function averageStrategy(
	strategySum: SumStore | Uint8Array,
	base: number,
	actions: number,
	count: number,
	strategy: Float64Array,
	regret?: AnyRegrets,
): void {
	const fallback = regret !== undefined && regret.length > 0 ? regret : null;
	const uniform = 1 / actions;
	for (let i = 0; i < count; i++) {
		const at = base + i;
		let total = 0;
		for (let a = 0; a < actions; a++) {
			const value = strategySum[at + a * count];
			strategy[a * count + i] = value;
			total += value;
		}
		if (total > 0) {
			for (let a = 0; a < actions; a++) strategy[a * count + i] /= total;
			continue;
		}
		if (fallback !== null) {
			for (let a = 0; a < actions; a++) {
				const value = fallback[at + a * count];
				const positive = value > 0 ? value : 0;
				strategy[a * count + i] = positive;
				total += positive;
			}
		}
		if (total > 0) {
			for (let a = 0; a < actions; a++) strategy[a * count + i] /= total;
		} else {
			for (let a = 0; a < actions; a++) strategy[a * count + i] = uniform;
		}
	}
}

/**
 * One walk of the subtree below `node`, for `traverser`, returning their
 * counterfactual values.
 *
 * Vectors are in hand space: `reachMe`, the result and every buffer for the
 * traverser hold one entry per hand of theirs live on `board` — entry `i` of
 * their active list there — and `reachOpp` likewise for the opponent. The
 * result is valid for the traverser's `count` hands on this board.
 */
export function traverse(
	ctx: Context,
	buffers: Buffers,
	mode: Mode,
	traverser: 0 | 1,
	iterWeight: number,
	node: number,
	board: number,
	reachMe: Float64Array,
	reachOpp: Float64Array,
	depth: number,
): Float64Array {
	const { tree, runouts } = ctx;
	const out = buffers.value[depth];
	const kind = tree.kind[node];
	const round = tree.round[node];
	const lists = ctx.active;
	const opponent = (1 - traverser) as 0 | 1;
	const mySlot = (lists.roundBase[round] + board) * 2 + traverser;
	const oppSlot = (lists.roundBase[round] + board) * 2 + opponent;
	const myFrom = lists.start[mySlot];
	const myCount = lists.count[mySlot];
	const oppFrom = lists.start[oppSlot];
	const oppCount = lists.count[oppSlot];

	if (kind === NodeKind.TerminalFold) {
		const signed = traverser === 0 ? tree.payoff[node] : -tree.payoff[node];
		const weight = ctx.runoutWeight[round] / ctx.chipScale;
		const hands = ctx.hands;
		if (lists.packed[oppSlot]) {
			foldValuesPacked(
				reachOpp, lists.cardA, lists.cardB, lists.memberStart, lists.memberA, lists.memberB,
				oppFrom, oppCount, myFrom, myCount, hands.same, hands.sameStart[mySlot], signed * weight, buffers.cardSums, out,
			);
			return out;
		}
		foldValuesHands(
			reachOpp, lists.cardA, lists.cardB, oppFrom, oppCount, myFrom, myCount,
			hands.same, hands.sameStart[mySlot], signed * weight, buffers.cardSums, out,
		);
		return out;
	}

	if (kind === NodeKind.TerminalShowdown) {
		const weight = ctx.runoutWeight[round] / ctx.chipScale;
		if (lists.packed[oppSlot]) {
			showdownValuesPacked(
				reachOpp, lists.cardA, lists.cardB, lists.memberStart, lists.memberA, lists.memberB, lists.strength,
				oppFrom, oppCount, myFrom, myCount, tree.payoff[node] * weight, buffers.cardSums, out,
			);
			return out;
		}
		showdownValuesHands(
			reachOpp, lists.cardA, lists.cardB, lists.strength, oppFrom, oppCount, myFrom, myCount,
			tree.payoff[node] * weight, buffers.cardSums, out,
		);
		return out;
	}

	if (kind === NodeKind.Chance) {
		for (let i = 0; i < myCount; i++) out[i] = 0;
		const nextRound = round + 1;

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
					for (let i = 0; i < myCount; i++) out[i] = ctx.chanceOverride[base + i];
					return out;
				}
			}
		}

		const child = tree.edgeChild[tree.firstEdge[node]];
		const orbitStart = runouts.orbitStart[nextRound];
		const upStart = ctx.hands.upStart[nextRound];
		const up = ctx.hands.up;
		const childMe = buffers.reachFor[traverser][depth];
		const childOpp = buffers.reachFor[opponent][depth];

		// Workers own contiguous slices of the boards at the shard round.
		const sharded = nextRound === ctx.shardRound;
		const starts = ctx.lineStarts === undefined ? runouts.childStart[nextRound] : ctx.lineStarts[node]!;
		const first = starts[board];
		const last = starts[board + 1];
		const from = sharded && ctx.shardStart > first ? ctx.shardStart : first;
		const to = sharded && ctx.shardEnd < last ? ctx.shardEnd : last;

		// Chance sampling decides how each deal's values are had; how they
		// spread over the deal's mirror images is the same either way.
		const sampling = ctx.sampling ?? null;
		const sampleHere =
			sampling !== null && mode === Mode.Train && ctx.applyUpdates && !ctx.expandOrbits && sampling.rounds[nextRound] === 1;

		for (let childBoard = from; childBoard < to; childBoard++) {
			const childMySlot = (lists.roundBase[nextRound] + childBoard) * 2 + traverser;
			const childOppSlot = (lists.roundBase[nextRound] + childBoard) * 2 + opponent;
			const nMe = lists.count[childMySlot];
			const nOpp = lists.count[childOppSlot];
			const firstMember = orbitStart[childBoard];
			const membersEnd = orbitStart[childBoard + 1];

			// Every real deal this board stands for, the stored one first. A
			// child hand's parent is `up`, through the deal's relabelling.
			// Without `expandOrbits`, reach is symmetric under the relabelling,
			// so one walk serves every member and only the values are spread.
			let value: Float64Array | Float32Array | null = null;
			for (let m = firstMember; m < membersEnd; m++) {
				const upMe = upStart[m * 2 + traverser];
				if (sampleHere && value === null) {
					value = sampledValue(
						ctx, sampling!, buffers, traverser, iterWeight, node, child, nextRound, childBoard,
						reachMe, reachOpp, childMe, childOpp, depth,
					);
				} else if (value === null || ctx.expandOrbits) {
					const upOpp = upStart[m * 2 + opponent];
					for (let k = 0; k < nMe; k++) childMe[k] = reachMe[up[upMe + k]];
					for (let k = 0; k < nOpp; k++) childOpp[k] = reachOpp[up[upOpp + k]];
					value = traverse(ctx, buffers, mode, traverser, iterWeight, child, childBoard, childMe, childOpp, depth + 1);
				}
				if (lists.packed[childMySlot]) {
					// An entry stands for its whole orbit: weight it so, and
					// share the parent's total among its own orbit below.
					const childFrom = lists.start[childMySlot];
					for (let k = 0; k < nMe; k++) out[up[upMe + k]] += value[k] * lists.multiplicity[childFrom + k];
				} else {
					for (let k = 0; k < nMe; k++) out[up[upMe + k]] += value[k];
				}
			}
		}
		if (lists.packed[mySlot]) {
			for (let i = 0; i < myCount; i++) out[i] /= lists.multiplicity[myFrom + i];
		}
		if (ctx.lineScales !== undefined) {
			const scale = ctx.lineScales[node];
			if (scale !== null) {
				const at = myFrom - scale.base;
				for (let i = 0; i < myCount; i++) out[i] *= scale.values[at + i];
			}
		}
		return out;
	}

	// --- decision ---
	const actions = tree.numEdges[node];
	const edgeBase = tree.firstEdge[node];
	const owner = tree.player[node] as 0 | 1;
	const isTraverser = owner === traverser;

	// The acting player's hands here: their active list on this board, which
	// is also how their storage block is laid out — `actions` rows of
	// `activeCount` hands from `slotBase`.
	const listSlot = isTraverser ? mySlot : oppSlot;
	const activeCount = lists.count[listSlot];
	const stride = activeCount;
	const slotBase = ctx.layout.offset[node] + actions * ctx.layout.rowStart[listSlot];

	// Laid out as storage is: `strategy[a * stride + i]`.
	const strategy = buffers.strategy[depth];
	const length = actions * stride;
	// A compactly stored node without sums has no average: it plays the
	// current profile wherever a strategy is read.
	const compactNode = round >= ctx.layout.compactFrom;
	const chunk = compactNode ? ctx.layout.compactChunk![node] : 0;
	const regrets: AnyRegrets = compactNode ? ctx.compactRegret![chunk] : ctx.regret;
	const compactSums = compactNode && ctx.compact!.sums;
	const current = mode === Mode.Train || mode === Mode.Current || (compactNode && !compactSums);
	if (current && buffers.kernels !== null) {
		const kernels = buffers.kernels;
		kernels.input.set(regrets.subarray(slotBase, slotBase + length));
		kernels.regretMatch(strategy, actions, stride);
	} else if (current) {
		regretMatch(regrets, slotBase, actions, stride, strategy);
	} else if (compactSums) {
		averageStrategy(ctx.compactSum![chunk], slotBase, actions, stride, strategy, regrets);
	} else if (buffers.kernels !== null) {
		const kernels = buffers.kernels;
		kernels.input.set(ctx.strategySum.subarray(slotBase, slotBase + length));
		const hasRegret = ctx.regret.length > 0;
		if (hasRegret) kernels.second.set(ctx.regret.subarray(slotBase, slotBase + length));
		kernels.averageMatch(strategy, actions, stride, hasRegret);
	} else {
		averageStrategy(ctx.strategySum, slotBase, actions, stride, strategy, ctx.regret);
	}

	if (isTraverser && mode === Mode.BestResponse) {
		for (let a = 0; a < actions; a++) {
			const value = traverse(
				ctx, buffers, mode, traverser, iterWeight,
				tree.edgeChild[edgeBase + a], board, reachMe, reachOpp, depth + 1,
			);
			if (a === 0) {
				for (let i = 0; i < myCount; i++) out[i] = value[i];
			} else {
				for (let i = 0; i < myCount; i++) if (value[i] > out[i]) out[i] = value[i];
			}
		}
		return out;
	}

	for (let i = 0; i < myCount; i++) out[i] = 0;
	const childReach = buffers.reachFor[owner][depth];
	const actionValues = buffers.actionValues[depth];

	for (let a = 0; a < actions; a++) {
		const row = a * stride;
		const source = isTraverser ? reachMe : reachOpp;
		for (let i = 0; i < activeCount; i++) childReach[i] = source[i] * strategy[row + i];

		const value = traverse(
			ctx, buffers, mode, traverser, iterWeight,
			tree.edgeChild[edgeBase + a], board,
			isTraverser ? childReach : reachMe,
			isTraverser ? reachOpp : childReach,
			depth + 1,
		);

		if (isTraverser) {
			const offset = a * myCount;
			for (let i = 0; i < myCount; i++) {
				actionValues[offset + i] = value[i];
				out[i] += strategy[row + i] * value[i];
			}
		} else {
			// The opponent's strategy already sits inside their reach, so the
			// counterfactual value is the plain sum over their actions.
			for (let i = 0; i < myCount; i++) out[i] += value[i];
		}
	}

	const weighted = ctx.layout.reachWeighted;
	if (weighted !== null && weighted[node] && isTraverser && mode === Mode.Train && ctx.applyUpdates) {
		// Each history's regret counts as often as this hand plays into it.
		for (let a = 0; a < actions; a++) {
			const offset = a * myCount;
			for (let i = 0; i < myCount; i++) {
				actionValues[offset + i] = out[i] + reachMe[i] * (actionValues[offset + i] - out[i]);
			}
		}
	}
	if (isTraverser && mode === Mode.Train && ctx.applyUpdates && compactNode) {
		updateCompact(
			ctx, node, chunk, ctx.layout.blockOffset[node] + board, slotBase,
			ctx.layout.handOffset![node] + ctx.layout.rowStart[listSlot], actions, stride, iterWeight,
			reachMe, strategy, actionValues, out,
		);
	} else if (isTraverser && mode === Mode.Train && ctx.applyUpdates && ctx.regretScale !== null) {
		updateQuantised(
			ctx, node, ctx.layout.blockOffset[node] + board, slotBase, actions, stride,
			iterWeight, reachMe, strategy, actionValues, out,
		);
	} else if (isTraverser && mode === Mode.Train && ctx.applyUpdates && ctx.dcfr) {
		// `iterWeight` is the iteration number, counted from 1.
		let { keepPositive, keepNegative, keepSum } = dcfrFactors(iterWeight);
		const discounted = ctx.discounted;
		if (discounted !== undefined && discounted !== null) {
			// Another history already discounted this shared block this iteration.
			const block = ctx.layout.blockOffset[node] + board;
			if (discounted[block] === iterWeight) keepPositive = keepNegative = keepSum = 1;
			discounted[block] = iterWeight;
		}
		const sampling = ctx.sampling;
		if (sampling !== undefined && sampling !== null) {
			// A subtree chance sampling skipped missed those iterations'
			// discounts; nothing was added meanwhile, so each sign held.
			const block = ctx.layout.blockOffset[node] + board;
			if (sampling.catchUp) {
				for (let s = sampling.lastUpdate[block] + 1; s < iterWeight; s++) {
					const f = cachedFactors(s);
					keepPositive *= f.keepPositive;
					keepNegative *= f.keepNegative;
					keepSum *= f.keepSum;
				}
			}
			sampling.lastUpdate[block] = iterWeight;
		}
		const regret = ctx.regret;
		const strategySum = ctx.strategySum;
		for (let a = 0; a < actions; a++) {
			const offset = a * activeCount;
			const slotRow = slotBase + a * stride;
			const row = a * stride;
			for (let i = 0; i < activeCount; i++) {
				const at = slotRow + i;
				const accumulated = regret[at];
				regret[at] = accumulated * (accumulated > 0 ? keepPositive : keepNegative) + actionValues[offset + i] - out[i];
				strategySum[at] = strategySum[at] * keepSum + strategy[row + i];
			}
		}
	} else if (isTraverser && mode === Mode.Train && ctx.applyUpdates) {
		const regret = ctx.regret;
		const strategySum = ctx.strategySum;
		for (let a = 0; a < actions; a++) {
			const offset = a * activeCount;
			const slotRow = slotBase + a * stride;
			const row = a * stride;
			for (let i = 0; i < activeCount; i++) {
				const at = slotRow + i;
				// CFR+: clamp the accumulated regret at zero in the same pass.
				const updated = regret[at] + actionValues[offset + i] - out[i];
				regret[at] = updated > 0 ? updated : 0;
				strategySum[at] += iterWeight * reachMe[i] * strategy[row + i];
			}
		}
	}

	return out;
}

/**
 * One deal's values in a sampled chance node's training walk. A deal not
 * walked gives its baseline, the values it returned when last walked; a
 * walked deal gives `b + (v - b) / p` and its `v` becomes the new baseline
 * (with the 'latest' estimator, `v` itself). A deal never walked yet is
 * always walked. Returned in the child's hand space, as a walk's are.
 */
function sampledValue(
	ctx: Context,
	s: Sampling,
	buffers: Buffers,
	traverser: 0 | 1,
	t: number,
	node: number,
	child: number,
	nextRound: number,
	childBoard: number,
	reachMe: Float64Array,
	reachOpp: Float64Array,
	childMe: Float64Array,
	childOpp: Float64Array,
	depth: number,
): Float64Array | Float32Array {
	const lists = ctx.active;
	const opponent = (1 - traverser) as 0 | 1;
	const childMySlot = (lists.roundBase[nextRound] + childBoard) * 2 + traverser;
	const nMe = lists.count[childMySlot];
	const at = s.baseOffset[node] + s.boardOffset[childMySlot];
	const walkAt = s.walkOffset[node] + childBoard * 2 + traverser;
	const fresh = s.lastWalk[walkAt] === 0;
	if (!fresh && !sampled(s, node, childBoard, t)) return s.baseline.subarray(at, at + nMe);

	const childOppSlot = (lists.roundBase[nextRound] + childBoard) * 2 + opponent;
	const nOpp = lists.count[childOppSlot];
	const member = ctx.runouts.orbitStart[nextRound][childBoard];
	const upStart = ctx.hands.upStart[nextRound];
	const up = ctx.hands.up;
	const upMe = upStart[member * 2 + traverser];
	const upOpp = upStart[member * 2 + opponent];
	for (let k = 0; k < nMe; k++) childMe[k] = reachMe[up[upMe + k]];
	for (let k = 0; k < nOpp; k++) childOpp[k] = reachOpp[up[upOpp + k]];
	const value = traverse(ctx, buffers, Mode.Train, traverser, t, child, childBoard, childMe, childOpp, depth + 1);
	// The child's buffer is free again, so the estimate goes in place.
	const weight = s.unbiased ? 1 / s.p : 1;
	const baseline = s.baseline;
	for (let k = 0; k < nMe; k++) {
		const v = value[k];
		const b = baseline[at + k];
		baseline[at + k] = v;
		// `v + (w - 1)(v - b)` is `b + w(v - b)`, and exactly `v` at w = 1.
		if (!fresh) value[k] = v + (weight - 1) * (v - b);
	}
	s.lastWalk[walkAt] = t;
	return value;
}

/**
 * The regret and strategy-sum update for 16-bit storage, under either rule.
 *
 * A block is rescaled whole on every update: decode, update in float, find the
 * block's largest magnitude, re-encode against it.
 *
 * Regrets round to nearest. Strategy sums round up or down at random, with
 * odds set by the remainder, so each is right on average: rounded to nearest,
 * a hand whose sum is small beside its block's largest loses most of every
 * iteration's contribution, and measured, exploitability stalls near 0.04%
 * of pot where float32 keeps falling. The randomness is a hash of the slot and
 * the iteration, so a solve stays deterministic at any thread count. With
 * shared storage it is salted with the history's `node` (else 0): every
 * history that reaches a shared block re-encodes it in an iteration, and with
 * one stream for all of them their roundings would push the same way
 * (issue #94). The node is fixed by the tree, so the salt does not depend on
 * threads or on the order histories are visited in.
 *
 * `actionValues` and `strategy` are not needed once their values are used, so
 * the new regrets and sums are staged in them rather than in buffers of their
 * own.
 */
function updateQuantised(
	ctx: Context,
	node: number,
	block: number,
	slotBase: number,
	actions: number,
	count: number,
	iterWeight: number,
	reachMe: Float64Array,
	strategy: Float64Array,
	actionValues: Float64Array,
	out: Float64Array,
): void {
	const regret = ctx.regret;
	const strategySum = ctx.strategySum;
	const regretScale = ctx.regretScale!;
	const sumScale = ctx.sumScale!;
	const oldRegret = regretScale[block];
	const oldSum = sumScale[block];

	// CFR+ is the special case that clamps and keeps everything: a negative
	// regret is floored at zero, a positive one kept whole, and iteration `t`
	// is weighted `t` in the sum.
	let keepPositive = 1;
	let keepNegative = 0;
	let keepSum = 1;
	let weight = iterWeight;
	const clamp = !ctx.dcfr;
	if (ctx.dcfr) {
		({ keepPositive, keepNegative, keepSum } = dcfrFactors(iterWeight));
		weight = 1;
		const discounted = ctx.discounted;
		if (discounted !== undefined && discounted !== null) {
			// Another history already discounted this shared block this iteration.
			if (discounted[block] === iterWeight) keepPositive = keepNegative = keepSum = 1;
			discounted[block] = iterWeight;
		}
	}

	let largestRegret = 0;
	let largestSum = 0;
	for (let a = 0; a < actions; a++) {
		const offset = a * count;
		const slotRow = slotBase + a * count;
		for (let i = 0; i < count; i++) {
			const at = slotRow + i;
			const accumulated = regret[at] * oldRegret;
			let updated =
				accumulated * (accumulated > 0 ? keepPositive : keepNegative) + actionValues[offset + i] - out[i];
			if (clamp && updated < 0) updated = 0;
			const magnitude = updated < 0 ? -updated : updated;
			if (magnitude > largestRegret) largestRegret = magnitude;
			actionValues[offset + i] = updated;

			// DCFR adds the strategy unweighted by own reach (issue #8); CFR+ keeps the weight.
			const added = clamp ? weight * reachMe[i] * strategy[a * count + i] : weight * strategy[a * count + i];
			const sum = strategySum[at] * oldSum * keepSum + added;
			if (sum > largestSum) largestSum = sum;
			strategy[a * count + i] = sum;
		}
	}

	// Storing into a 16-bit array truncates toward zero, so adding a half away
	// from zero rounds to nearest, and adding the dither rounds at random. A
	// value at the very top of the range plus nearly a whole dither would
	// reach 65536 and wrap to zero, hence the cap.
	const regretStep = largestRegret > 0 ? REGRET_STEPS / largestRegret : 0;
	const sumStep = largestSum > 0 ? SUM_STEPS / largestSum : 0;
	// Which history is re-encoding a shared block; 0 keeps unshared streams as they were.
	const salt = ctx.layout.shared ? node : 0;
	for (let a = 0; a < actions; a++) {
		const offset = a * count;
		const slotRow = slotBase + a * count;
		for (let i = 0; i < count; i++) {
			const at = slotRow + i;
			const r = actionValues[offset + i] * regretStep;
			regret[at] = r < 0 ? r - 0.5 : r + 0.5;
			const s = strategy[a * count + i] * sumStep + dither(at, iterWeight, salt);
			strategySum[at] = s < SUM_STEPS ? s : SUM_STEPS;
		}
	}
	regretScale[block] = largestRegret / REGRET_STEPS;
	sumScale[block] = largestSum / SUM_STEPS;
}

/** Bias of a compact hand's scale exponent; see `Context.handShift`. */
const SHIFT_BIAS = 160;
/** `2^(shift - SHIFT_BIAS)` for every shift, 0 for a shift of 0. */
export const SHIFT_SCALE = Float64Array.from({ length: 256 }, (_, e) => (e === 0 ? 0 : 2 ** (e - SHIFT_BIAS)));

/**
 * The update for a compactly stored node: decode, update in float as the rule
 * says, re-encode; with `sums`, the strategy sum too. Each hand is scaled by
 * its own power of two, chosen so its largest value uses the top of the
 * range; regret matching and the average only compare a hand's own values,
 * so a hand whose values are small beside the block's keeps all its
 * precision. Rounding is at random with odds set by the remainder (unless
 * `stochastic` is off), so each stored value is right on average; the
 * randomness is a hash of the slot's place in all of compact storage and the
 * iteration, so it does not depend on threads or chunks. With shared storage
 * the history's `node` goes into the hash too: every history reaching a
 * shared block re-encodes it, and the same random numbers each time would
 * push its rounding errors the same way instead of letting them cancel
 * (issue #88).
 */
export function updateCompact(
	ctx: Context,
	node: number,
	chunk: number,
	block: number,
	slotBase: number,
	handBase: number,
	actions: number,
	count: number,
	iterWeight: number,
	reachMe: Float64Array,
	strategy: Float64Array,
	actionValues: Float64Array,
	out: Float64Array,
): void {
	const plan = ctx.compact!;
	const q = ctx.compactRegret![chunk];
	// Rounding hashes the slot's place in all of compact storage, so how it
	// is chunked changes nothing.
	const hashBase = ctx.layout.chunkStart[chunk] + slotBase;
	// Which history is re-encoding a shared block; 0 keeps unshared streams as they were.
	const salt = ctx.layout.shared ? node : 0;
	const steps = plan.steps;
	let keepPositive = 1;
	let keepNegative = 0;
	let keepSum = 1;
	let weight = iterWeight;
	const clamp = !ctx.dcfr;
	if (ctx.dcfr) {
		({ keepPositive, keepNegative, keepSum } = dcfrFactors(iterWeight));
		weight = 1;
		const discounted = ctx.discounted;
		if (discounted !== undefined && discounted !== null) {
			// Another history already discounted this shared block this iteration.
			if (discounted[block] === iterWeight) keepPositive = keepNegative = keepSum = 1;
			discounted[block] = iterWeight;
		}
		const sampling = ctx.sampling;
		if (sampling !== undefined && sampling !== null) {
			// A subtree chance sampling skipped missed those iterations'
			// discounts, as in the 32-bit update.
			if (sampling.catchUp) {
				for (let s = sampling.lastUpdate[block] + 1; s < iterWeight; s++) {
					const f = cachedFactors(s);
					keepPositive *= f.keepPositive;
					keepNegative *= f.keepNegative;
					keepSum *= f.keepSum;
				}
			}
			sampling.lastUpdate[block] = iterWeight;
		}
	}

	if (plan.float) {
		for (let k = 0; k < actions * count; k++) {
			const accumulated = q[slotBase + k];
			const updated = accumulated * (accumulated > 0 ? keepPositive : keepNegative) + actionValues[k] - out[k % count];
			q[slotBase + k] = clamp && updated < 0 ? 0 : updated;
		}
		return;
	}

	if (!plan.perHand) {
		// One scale for the block, as 16-bit storage keeps.
		const scales = ctx.compactScale!;
		const old = scales[block];
		let largest = 0;
		for (let a = 0; a < actions; a++) {
			const row = a * count;
			for (let i = 0; i < count; i++) {
				const accumulated = q[slotBase + row + i] * old;
				let updated = accumulated * (accumulated > 0 ? keepPositive : keepNegative) + actionValues[row + i] - out[i];
				if (clamp && updated < 0) updated = 0;
				actionValues[row + i] = updated;
				const magnitude = updated < 0 ? -updated : updated;
				if (magnitude > largest) largest = magnitude;
			}
		}
		const step = largest > 0 ? steps / largest : 0;
		const stochastic = plan.stochastic;
		// One hash per row, stepped on for each hand.
		for (let a = 0; a < actions; a++) {
			const row = a * count;
			let h = stochastic ? streamSeed(hashBase + row, iterWeight, salt) : 0;
			for (let i = 0; i < count; i++) {
				const value = actionValues[row + i] * step;
				let rounded: number;
				if (stochastic) {
					h = nextState(h);
					rounded = Math.floor(value + (h >>> 0) / 4294967296);
				} else {
					rounded = Math.round(value);
				}
				q[slotBase + row + i] = rounded > steps ? steps : rounded < -steps ? -steps : rounded;
			}
		}
		scales[block] = largest / steps;
		return;
	}

	const shifts = ctx.handShift![chunk];
	const stochastic = plan.stochastic;
	const sums = plan.sums ? ctx.compactSum![chunk] : null;
	const sumShifts = plan.sums ? ctx.sumShift![chunk] : null;
	for (let i = 0; i < count; i++) {
		const scale = SHIFT_SCALE[shifts[handBase + i]];
		let largest = 0;
		for (let a = 0; a < actions; a++) {
			const k = a * count + i;
			const accumulated = q[slotBase + k] * scale;
			let updated = accumulated * (accumulated > 0 ? keepPositive : keepNegative) + actionValues[k] - out[i];
			if (clamp && updated < 0) updated = 0;
			actionValues[k] = updated;
			const magnitude = updated < 0 ? -updated : updated;
			if (magnitude > largest) largest = magnitude;
		}
		const exponent = scaleExponent(largest, steps);
		shifts[handBase + i] = exponent;
		const inverse = exponent === 0 ? 0 : 1 / SHIFT_SCALE[exponent];
		// One hash per hand, stepped on for each action.
		let h = stochastic || sums !== null ? streamSeed(hashBase + i, iterWeight, salt) : 0;
		for (let a = 0; a < actions; a++) {
			const k = a * count + i;
			const value = actionValues[k] * inverse;
			let rounded: number;
			if (stochastic) {
				h = nextState(h);
				rounded = Math.floor(value + (h >>> 0) / 4294967296);
			} else {
				rounded = Math.round(value);
			}
			q[slotBase + k] = rounded > steps ? steps : rounded < -steps ? -steps : rounded;
		}

		if (sums === null) continue;
		// The strategy sum, as 16-bit storage keeps it but scaled per hand:
		// the average divides each hand's sums by their own total, so the
		// scale cancels there just as it does for regret matching.
		const sumScale = SHIFT_SCALE[sumShifts![handBase + i]];
		let largestSum = 0;
		for (let a = 0; a < actions; a++) {
			const k = a * count + i;
			// DCFR adds the strategy unweighted by own reach (issue #8); CFR+ keeps the weight.
			const added = clamp ? weight * reachMe[i] * strategy[k] : weight * strategy[k];
			const sum = sums[slotBase + k] * sumScale * keepSum + added;
			strategy[k] = sum;
			if (sum > largestSum) largestSum = sum;
		}
		const sumExponent = scaleExponent(largestSum, COMPACT_SUM_STEPS);
		sumShifts![handBase + i] = sumExponent;
		const sumInverse = sumExponent === 0 ? 0 : 1 / SHIFT_SCALE[sumExponent];
		for (let a = 0; a < actions; a++) {
			const k = a * count + i;
			h = nextState(h);
			const rounded = Math.floor(strategy[k] * sumInverse + (h >>> 0) / 4294967296);
			sums[slotBase + k] = rounded < COMPACT_SUM_STEPS ? rounded : COMPACT_SUM_STEPS;
		}
	}
}

/** Largest strategy sum compact storage keeps per hand: the top of a byte. */
export const COMPACT_SUM_STEPS = 255;

/**
 * A hand's scale exponent: the smallest power of two that brings `largest`
 * within `steps`, read off the float's exponent bits, biased by
 * `SHIFT_BIAS`; 0, for all zeros, below the smallest scale there is.
 */
export function scaleExponent(largest: number, steps: number): number {
	if (!(largest > 0)) return 0;
	EXPONENT_FLOAT[0] = largest / steps;
	const high = EXPONENT_BITS[1];
	let exponent = ((high >>> 20) & 0x7ff) - 1023 + SHIFT_BIAS;
	if ((high & 0xfffff) !== 0 || EXPONENT_BITS[0] !== 0) exponent++;
	return exponent < 1 ? 0 : exponent > 255 ? 255 : exponent;
}

/**
 * Start of a slot's random stream on an iteration, for rounding a run of
 * values with `nextState`; `salt` tells apart histories sharing the slot
 * (0 when none do). Never zero, the stream's fixed point.
 */
function streamSeed(slot: number, iteration: number, salt: number): number {
	return Math.imul(slot ^ Math.imul(iteration, 0x9e3779b1) ^ Math.imul(salt, 0x7feb352d) ^ 0x5bd1e995, 0x85ebca6b) | 1;
}

/** One step of a random stream: the next state, whose `(h >>> 0) / 2^32` is uniform in [0, 1). */
function nextState(h: number): number {
	h ^= h >>> 15;
	h = Math.imul(h, 0x2c1b3c6d);
	return h ^ (h >>> 12);
}

/** Scratch for reading a float's exponent bits (little-endian: the high word second). */
const EXPONENT_FLOAT = new Float64Array(1);
const EXPONENT_BITS = new Uint32Array(EXPONENT_FLOAT.buffer);

/**
 * The strategy a block's storage stands for, outside training: the average,
 * or the current profile where compact storage keeps no average.
 */
export function storedStrategy(
	ctx: Context,
	node: number,
	base: number,
	actions: number,
	count: number,
	strategy: Float64Array,
): void {
	if (ctx.tree.round[node] >= ctx.layout.compactFrom && ctx.compact!.sums) {
		const chunk = ctx.layout.compactChunk![node];
		averageStrategy(ctx.compactSum![chunk], base, actions, count, strategy, ctx.compactRegret![chunk]);
	} else if (ctx.tree.round[node] >= ctx.layout.compactFrom) {
		regretMatch(ctx.compactRegret![ctx.layout.compactChunk![node]], base, actions, count, strategy);
	} else {
		averageStrategy(ctx.strategySum, base, actions, count, strategy, ctx.regret);
	}
}

/**
 * A deterministic uniform value in [0, 1) for a slot on an iteration, from
 * the stream `salt` picks; salt 0 is the stream unshared storage has always
 * used. Distinct salts give a slot distinct hash inputs on every iteration.
 */
export function dither(slot: number, iteration: number, salt = 0): number {
	let h = Math.imul(slot ^ Math.imul(iteration, 0x9e3779b1) ^ Math.imul(salt, 0x27d4eb2f), 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return (h >>> 0) / 4294967296;
}

/** See `Solver.rootValues`. */
export interface RootValues {
	readonly totals: readonly [number, number];
	readonly values: readonly [Float64Array, Float64Array];
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
	/**
	 * One root pass per player under the average profile (`Mode.Average`) or
	 * the current one (`Mode.Current`): each player's chips per hand, as
	 * `expectedValue` gives them for the average, and a copy of their root
	 * counterfactual values, one per hand of their root active list.
	 */
	rootValues(mode: typeof Mode.Average | typeof Mode.Current): RootValues;
	/**
	 * Root EV in chips for each combination, indexed like `COMBO_CARDS`, from
	 * root counterfactual values `rootValues` returned for `player`: each
	 * hand's value over the opponent mass it can be dealt against. Zero for a
	 * combination off the root list or with no opponent hand to face.
	 */
	handEvs(player: 0 | 1, values: Float64Array): Float64Array;
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
	 * The whole-tree traversal `iterate` and the other passes run now: this
	 * thread's own, or what `useRoot` routed them to. For wrapping it.
	 */
	readonly root: RootTraversal;
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
	const buffers = makeBuffers(ctx.tree, ctx.layout.maxActions, ctx.simd);
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

	// Hand-space vectors for a round and board, from combination-indexed
	// arrays, and back.
	const lists = ctx.active;
	const listOf = (round: number, board: number, player: 0 | 1): [number, number] => {
		const slot = (lists.roundBase[round] + board) * 2 + player;
		return [lists.start[slot], lists.count[slot]];
	};
	const gather = (source: Float64Array, round: number, board: number, player: 0 | 1, into: Float64Array): void => {
		const [from, count] = listOf(round, board, player);
		for (let i = 0; i < count; i++) into[i] = source[lists.list[from + i]];
	};

	const run = (mode: Mode, traverser: 0 | 1, iterWeight: number): Float64Array => {
		gather(ctx.players[0].weights, 0, 0, 0, reach0);
		gather(ctx.players[1].weights, 0, 0, 1, reach1);
		const me = traverser === 0 ? reach0 : reach1;
		const opp = traverser === 0 ? reach1 : reach0;
		return traverse(ctx, buffers, mode, traverser, iterWeight, 0, 0, me, opp, 0);
	};

	let root: RootTraversal = run;

	const total = (values: Float64Array, traverser: 0 | 1): number => {
		// Values are counterfactual, so weighting by this player's own reach
		// turns them into the value of the spot.
		const weights = ctx.players[traverser].weights;
		const [from, count] = listOf(0, 0, traverser);
		let sum = 0;
		for (let i = 0; i < count; i++) sum += weights[lists.list[from + i]] * lists.multiplicity[from + i] * values[i];
		return sum / ctx.totalMass;
	};

	return {
		ctx,
		rootLive,
		get rootCount() {
			return rootCount;
		},
		traverseRoot: run,
		get root() {
			return root;
		},
		useRoot(next) {
			root = next ?? run;
		},
		traverseChance(mode, traverser, iterWeight, node, me, opp) {
			// Hand-space vectors for the chance node's own board, which at the
			// shard boundary is always board 0 of its round.
			return traverse(ctx, buffers, mode, traverser, iterWeight, node, 0, me, opp, 0);
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
		rootValues(mode) {
			if (mode === Mode.Current && ctx.regret.length === 0 && !ctx.compactRegret) {
				throw new Error('The current profile needs regrets, and an analysis-only run has none');
			}
			// Each root vector is a buffer the next traversal reuses, so it is
			// read and copied before the other player's pass.
			const one = (player: 0 | 1): [number, Float64Array] => {
				const values = root(mode, player, 0);
				return [total(values, player), values.slice(0, listOf(0, 0, player)[1])];
			};
			const [total0, values0] = one(0);
			const [total1, values1] = one(1);
			return { totals: [total0, total1], values: [values0, values1] };
		},
		handEvs(player, values) {
			const opponent = ctx.players[1 - player];
			const evs = new Float64Array(COMBOS);
			const [from, count] = listOf(0, 0, player);
			if (values.length !== count) {
				throw new Error(`Player ${player} has ${count} root hands, but ${values.length} values were given`);
			}
			const scale = ctx.runoutWeight[0];
			for (let i = 0; i < count; i++) {
				// A packed entry's value is each of its mirrored hands' own.
				for (let m = lists.memberStart[from + i]; m < lists.memberStart[from + i + 1]; m++) {
					const combo = lists.memberCombo[m];
					const a = COMBO_CARDS[combo * 2];
					const b = COMBO_CARDS[combo * 2 + 1];
					// Summed directly rather than by inclusion-exclusion over
					// cards, so a hand with nothing to face gets exactly zero
					// mass, not a rounding residue to divide by. Board-blocked
					// opponent hands already weigh zero.
					let mass = 0;
					for (let j = 0; j < opponent.count; j++) {
						const other = opponent.combos[j];
						const c = COMBO_CARDS[other * 2];
						const d = COMBO_CARDS[other * 2 + 1];
						if (c !== a && c !== b && d !== a && d !== b) mass += opponent.weights[other];
					}
					evs[combo] = mass > 0 ? values[i] / (mass * scale) : 0;
				}
			}
			return evs;
		},
		exploitability() {
			const br0 = total(root(Mode.BestResponse, 0, 0), 0);
			const br1 = total(root(Mode.BestResponse, 1, 0), 1);
			return (br0 + br1) / 2;
		},
		valuesAt(node, board, traverser, reachMe, reachOpp, live, liveCount) {
			void live;
			void liveCount;
			const round = ctx.tree.round[node];
			const opponent = (1 - traverser) as 0 | 1;
			// Values depend on the opponent's reach alone. A packed list can
			// carry it only when mirrored hands hold equally much, as they do
			// for any reach the solve itself produces.
			const [oppFrom, oppCount] = listOf(round, board, opponent);
			let symmetric = true;
			for (let j = 0; j < oppCount && symmetric; j++) {
				const own = reachOpp[lists.list[oppFrom + j]];
				for (let m = lists.memberStart[oppFrom + j] + 1; m < lists.memberStart[oppFrom + j + 1]; m++) {
					if (reachOpp[lists.memberCombo[m]] !== own) symmetric = false;
				}
			}
			const members = (player: 0 | 1): Uint16Array => {
				const [from, count] = listOf(round, board, player);
				return lists.memberCombo.slice(lists.memberStart[from], lists.memberStart[from + count]);
			};
			if (!symmetric) {
				// Values are linear in the opponent's reach, so they are the
				// sum of the values against each opposing hand alone, which
				// are walked with every hand apart. Slower, by about the
				// number of opposing hands over 64.
				const theirs = members(opponent).filter((combo) => reachOpp[combo] !== 0);
				const mine = members(traverser);
				const handReach = Float64Array.from(theirs, (combo) => reachOpp[combo]);
				const rows = pairValues(ctx, node, board, traverser, theirs, handReach, mine, mine.length);
				const result = new Float64Array(COMBOS);
				for (let k = 0; k < theirs.length; k++) {
					for (const combo of mine) result[combo] += rows[k * COMBOS + combo];
				}
				return result;
			}
			// Mirrored deals below need not see symmetric reach, so they are
			// walked rather than assumed.
			const expanded = ctx.expandOrbits;
			ctx.expandOrbits = true;
			try {
				const me = new Float64Array(COMBOS);
				const opp = new Float64Array(COMBOS);
				gather(reachMe, round, board, traverser, me);
				gather(reachOpp, round, board, opponent, opp);
				const value = traverse(ctx, buffers, Mode.Average, traverser, 0, node, board, me, opp, 0);
				const result = new Float64Array(COMBOS);
				const [from, count] = listOf(round, board, traverser);
				for (let i = 0; i < count; i++) {
					for (let m = lists.memberStart[from + i]; m < lists.memberStart[from + i + 1]; m++) {
						result[lists.memberCombo[m]] = value[i];
					}
				}
				return result;
			} finally {
				ctx.expandOrbits = expanded;
			}
		},
		pairValuesAt(node, board, traverser, hands, handReach, live, liveCount) {
			return pairValues(ctx, node, board, traverser, hands, handReach, live, liveCount);
		},
		averageStrategyAt(node, board) {
			// In range order, as callers read it: hands the board blocks play
			// uniformly, as they always have.
			const owner = ctx.tree.player[node] as 0 | 1;
			const index = ctx.players[owner];
			const actions = ctx.tree.numEdges[node];
			const slot = (lists.roundBase[ctx.tree.round[node]] + board) * 2 + owner;
			const from = lists.start[slot];
			const count = lists.count[slot];
			const base = ctx.layout.offset[node] + actions * ctx.layout.rowStart[slot];
			const strategy = new Float64Array(actions * count);
			storedStrategy(ctx, node, base, actions, count, strategy);
			const probs = new Float64Array(index.count * actions).fill(1 / actions);
			for (let i = 0; i < count; i++) {
				// A packed entry's strategy is its whole orbit's.
				for (let m = lists.memberStart[from + i]; m < lists.memberStart[from + i + 1]; m++) {
					const at = index.slot[lists.memberCombo[m]];
					for (let a = 0; a < actions; a++) probs[at * actions + a] = strategy[a * count + i];
				}
			}
			return { actions, probs };
		},
	};
}

export { buildActiveLists, makeTerminalScratch };
