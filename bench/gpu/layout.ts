/**
 * The river showdown, laid out for a GPU.
 *
 * Purpose: turn a prepared solve's final-round hand lists, the ones the
 * WebAssembly engine already sweeps (`showdown` in assembly/engine.ts), into
 * flat tables a compute kernel can read. Then list the batch of jobs one
 * traversal would hand it: every river showdown node on every river board.
 *
 * The engine's showdown is two sequential sweeps, which a GPU cannot run
 * well. The same numbers come out of prefix sums, though. With the
 * opponent's list sorted by strength, let `lo` count the opponent's entries
 * weaker than my hand and `hi` those no stronger. Then
 *
 *     win  = P(lo)        - Ca(lo)         - Cb(lo)
 *     lose = P(n) - P(hi) - (Ca(n) - Ca(hi)) - (Cb(n) - Cb(hi))
 *
 * where P(x) is the reach of the first x entries, and Cc(x) is the reach of
 * those among them that hold card c (counted once per member hand for packed
 * lists). P is one parallel scan. Each Cc is a scan along a short list of
 * positions, built once per board because the lists never change. `lo` and
 * `hi` are binary searches. Nothing depends on the hand before.
 *
 * This file is bench-only: nothing in src/ imports it.
 */

import { DECK } from '../../src/cards.ts';
import type { ActiveLists, Layout } from '../../src/cfr.ts';
import type { Runouts } from '../../src/runouts.ts';
import { NodeKind } from '../../src/tree.ts';
import type { Tree } from '../../src/tree.ts';

/** Card-list buckets per opponent list: one per card. */
export const CARD_BUCKETS = DECK;

/** The longest lists a kernel workgroup holds in its shared memory. */
export const MAX_LIST = 512;
export const MAX_CARD_LIST = 1024;

/** Flat, upload-once tables for the final round. */
export interface ShowdownTables {
	/** Each active entry's strength, as `ActiveLists.strength`. */
	readonly strength: Int32Array;
	/** Each active entry's two cards, `a | b << 8`. */
	readonly cards: Uint32Array;
	/** How many hands each entry stands for: 1 unpacked. */
	readonly members: Float32Array;
	/**
	 * Per final-round list `(board * 2 + player)`, 53 offsets into
	 * `cardPos`: card c's positions run from `cardStart[l * 53 + c]` to
	 * `cardStart[l * 53 + c + 1]`.
	 */
	readonly cardStart: Uint32Array;
	/** Positions in the opponent's list, ascending within each card. */
	readonly cardPos: Uint32Array;
	/** The longest list, and the longest card-position run of one list. */
	readonly maxList: number;
	readonly maxCardList: number;
}

/** One showdown job: a river showdown node on one river board, for one traverser. */
export interface ShowdownJob {
	readonly node: number;
	readonly board: number;
	readonly myFrom: number;
	readonly myCount: number;
	readonly oppFrom: number;
	readonly oppCount: number;
	/** Final-round list index of the opponent's list, into `cardStart`. */
	readonly oppList: number;
	readonly packed: boolean;
	/** Payoff times the runout weight over the chip scale, as the engine's `scale`. */
	readonly scale: number;
}

/** One regret-matching block: a river decision node on one river board. */
export interface MatchBlock {
	/** Where the block starts in the regret storage. */
	readonly offset: number;
	readonly actions: number;
	readonly count: number;
}

/** What the tables and jobs are made from: a prepared solve's context. */
export interface PreparedSpot {
	readonly tree: Tree;
	readonly runouts: Runouts;
	readonly active: ActiveLists;
	readonly layout: Layout;
	readonly runoutWeight: Float64Array;
	readonly chipScale: number;
}

/** Build the final round's tables. */
export function buildShowdownTables(spot: PreparedSpot): ShowdownTables {
	const { runouts, active } = spot;
	const round = runouts.rounds - 1;
	const boards = runouts.counts[round];
	const entries = active.list.length;
	const cards = new Uint32Array(entries);
	const members = new Float32Array(entries);
	for (let e = 0; e < entries; e++) {
		cards[e] = active.cardA[e] | (active.cardB[e] << 8);
		members[e] = active.memberStart[e + 1] - active.memberStart[e];
	}

	const lists = boards * 2;
	const cardStart = new Uint32Array(lists * (CARD_BUCKETS + 1));
	const positions: number[] = [];
	let maxList = 0;
	let maxCardList = 0;
	const buckets: number[][] = Array.from({ length: CARD_BUCKETS }, () => []);
	for (let list = 0; list < lists; list++) {
		const slot = active.roundBase[round] * 2 + list;
		const from = active.start[slot];
		const count = active.count[slot];
		if (count > maxList) maxList = count;
		for (const bucket of buckets) bucket.length = 0;
		for (let j = 0; j < count; j++) {
			const entry = from + j;
			for (let m = active.memberStart[entry]; m < active.memberStart[entry + 1]; m++) {
				buckets[active.memberA[m]].push(j);
				buckets[active.memberB[m]].push(j);
			}
		}
		const base = list * (CARD_BUCKETS + 1);
		const first = positions.length;
		for (let c = 0; c < CARD_BUCKETS; c++) {
			cardStart[base + c] = positions.length;
			for (const j of buckets[c]) positions.push(j);
		}
		cardStart[base + CARD_BUCKETS] = positions.length;
		if (positions.length - first > maxCardList) maxCardList = positions.length - first;
	}
	return {
		strength: active.strength, cards, members, cardStart, cardPos: Uint32Array.from(positions), maxList, maxCardList,
	};
}

/**
 * Every river showdown a traversal for `traverser` evaluates, in the
 * engine's terms. The engine visits each of them once per traversal, with no
 * pruning, so a training iteration (one traversal per player) runs this
 * list twice over.
 */
export function listShowdownJobs(spot: PreparedSpot, traverser: 0 | 1): ShowdownJob[] {
	const { tree, runouts, active } = spot;
	const round = runouts.rounds - 1;
	const jobs: ShowdownJob[] = [];
	for (let node = 0; node < tree.nodeCount; node++) {
		if (tree.kind[node] !== NodeKind.TerminalShowdown || tree.round[node] !== round) continue;
		const scale = (tree.payoff[node] * spot.runoutWeight[round]) / spot.chipScale;
		for (let board = 0; board < runouts.counts[round]; board++) {
			const base = (active.roundBase[round] + board) * 2;
			const mySlot = base + traverser;
			const oppSlot = base + 1 - traverser;
			jobs.push({
				node, board,
				myFrom: active.start[mySlot], myCount: active.count[mySlot],
				oppFrom: active.start[oppSlot], oppCount: active.count[oppSlot],
				oppList: board * 2 + 1 - traverser,
				packed: active.packed[oppSlot] !== 0,
				scale,
			});
		}
	}
	return jobs;
}

/** Every river decision block, as regret matching sees it. */
export function listMatchBlocks(spot: PreparedSpot): MatchBlock[] {
	const { tree, runouts, active, layout } = spot;
	const round = runouts.rounds - 1;
	const blocks: MatchBlock[] = [];
	for (const node of tree.decisionNodes) {
		if (tree.round[node] !== round) continue;
		const actions = tree.numEdges[node];
		for (let board = 0; board < runouts.counts[round]; board++) {
			const slot = (layout.roundBase[round] + board) * 2 + tree.player[node];
			blocks.push({ offset: layout.offset[node] + actions * layout.rowStart[slot], actions, count: active.count[slot] });
		}
	}
	return blocks;
}

/**
 * A batch of jobs as the kernels read it: 8 words per job (see the `Job`
 * struct in wgsl.ts and `runShowdowns` in assembly/bench-showdown.ts), with
 * each job's reach and values packed one after another.
 */
export function packJobs(jobs: readonly ShowdownJob[]): { records: Uint32Array; reachLength: number; outLength: number } {
	const records = new Uint32Array(jobs.length * 8);
	const scales = new Float32Array(records.buffer);
	let reachAt = 0;
	let outAt = 0;
	jobs.forEach((job, i) => {
		const r = i * 8;
		records[r] = job.myFrom;
		records[r + 1] = job.myCount;
		records[r + 2] = job.oppFrom;
		records[r + 3] = job.oppCount;
		records[r + 4] = (job.oppList | (job.packed ? 0x80000000 : 0)) >>> 0;
		records[r + 5] = reachAt;
		records[r + 6] = outAt;
		scales[r + 7] = job.scale;
		reachAt += job.oppCount;
		outAt += job.myCount;
	});
	return { records, reachLength: reachAt, outLength: outAt };
}

/** Regret-matching blocks as the kernels read them: 4 words each. */
export function packBlocks(blocks: readonly MatchBlock[]): Uint32Array {
	const records = new Uint32Array(blocks.length * 4);
	blocks.forEach((block, i) => {
		records[i * 4] = block.offset;
		records[i * 4 + 1] = block.actions;
		records[i * 4 + 2] = block.count;
	});
	return records;
}

/** How many of a sorted run are below `value` (`strict`) or at most `value`. */
function countBelow(values: ArrayLike<number>, from: number, count: number, value: number, strict: boolean): number {
	let lo = 0;
	let hi = count;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		const v = values[from + mid];
		if (strict ? v < value : v <= value) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/**
 * The kernel's algorithm in plain JavaScript, in double precision: what each
 * GPU thread computes, so the reformulation can be checked against the
 * engine's sweeps without a GPU. `out[i]` gets my entry i's value.
 */
export function showdownByPrefix(
	tables: ShowdownTables,
	job: ShowdownJob,
	reach: ArrayLike<number>,
	out: Float64Array,
): void {
	const n = job.oppCount;
	const prefix = new Float64Array(n + 1);
	for (let j = 0; j < n; j++) prefix[j + 1] = prefix[j] + reach[j] * tables.members[job.oppFrom + j];
	const base = job.oppList * (CARD_BUCKETS + 1);
	const runStart = tables.cardStart[base];
	const runs = new Float64Array(tables.cardStart[base + CARD_BUCKETS] - runStart);
	for (let c = 0; c < CARD_BUCKETS; c++) {
		let sum = 0;
		for (let k = tables.cardStart[base + c]; k < tables.cardStart[base + c + 1]; k++) {
			sum += reach[tables.cardPos[k]];
			runs[k - runStart] = sum;
		}
	}
	// Reach on card c among the first x entries.
	const card = (c: number, x: number): number => {
		const from = tables.cardStart[base + c];
		const below = countBelow(tables.cardPos, from, tables.cardStart[base + c + 1] - from, x, true);
		return below === 0 ? 0 : runs[from - runStart + below - 1];
	};
	for (let i = 0; i < job.myCount; i++) {
		const level = tables.strength[job.myFrom + i];
		const lo = countBelow(tables.strength, job.oppFrom, n, level, true);
		const hi = countBelow(tables.strength, job.oppFrom, n, level, false);
		const packedCards = tables.cards[job.myFrom + i];
		const a = packedCards & 0xff;
		const b = packedCards >> 8;
		const win = prefix[lo] - card(a, lo) - card(b, lo);
		const lose = prefix[n] - prefix[hi] - (card(a, n) - card(a, hi)) - (card(b, n) - card(b, hi));
		out[i] = job.scale * (win - lose);
	}
}
