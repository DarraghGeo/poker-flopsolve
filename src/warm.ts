/**
 * Warm starts.
 *
 * Purpose: begin a solve from a previous one's regrets and strategy sums
 * instead of from nothing.
 *
 * A tweaked spot — a different pot, a bet size nudged, a range reweighted —
 * has nearly the same equilibrium as the one before, so starting there costs
 * a fraction of the iterations. Nothing about the answer is approximate: CFR
 * converges from any starting point, and this one is merely close.
 *
 * What carries over is the regrets — they ARE the current strategy, which is
 * what a nearby equilibrium shares — and, only for the very same spot, the
 * average strategy too, so a solve can be resumed exactly.
 *
 * The two trees are walked together from the root. A decision matches when
 * the same player acts in the same round; its actions match by kind, and bets
 * and raises by size as a fraction of the pot, the nearest within a factor of
 * `SIZE_TOLERANCE`. Whatever matches nothing starts cold. Boards match by
 * their real cards, so two spots may store different runouts (one folding
 * mirrored deals, the other not); hands match by combination, so a range may
 * have grown or shrunk.
 */

import type { Context, RegretStore, SumStore } from './cfr.ts';
import { tieBlock } from './cfr.ts';
import { COMBOS } from './cards.ts';
import type { Runouts } from './runouts.ts';
import { resolveBoard } from './runouts.ts';
import type { Tree } from './tree.ts';
import { ActionKind, NodeKind } from './tree.ts';

/** Largest ratio between two bet sizes, as pot fractions, still taken as the same. */
const SIZE_TOLERANCE = 1.35;

const REGRET_STEPS = 32767;
const SUM_STEPS = 65535;

/** What a warm start carried over. */
export interface WarmStartReport {
	/** Decision nodes of the new tree that found a match in the old one. */
	readonly matchedNodes: number;
	readonly decisionNodes: number;
	/**
	 * Whether the average strategy was carried over too. Only for the very
	 * same spot: the average of another spot's iterations would have to be
	 * outweighed before the new spot's own could show, and measured, that
	 * costs more than it saves — a pot 20% bigger took 475 iterations to
	 * reach 0.1% of pot carrying it, 100 without, 125 from cold.
	 */
	readonly averages: boolean;
}

/**
 * Pair each decision node of `to` with its counterpart in `from`, or -1.
 */
export function matchNodes(to: Tree, from: Tree): Int32Array {
	const match = new Int32Array(to.nodeCount).fill(-1);
	const walk = (a: number, b: number): void => {
		if (to.kind[a] !== from.kind[b] || to.round[a] !== from.round[b]) return;
		if (to.kind[a] === NodeKind.Chance) {
			walk(to.edgeChild[to.firstEdge[a]], from.edgeChild[from.firstEdge[b]]);
			return;
		}
		if (to.kind[a] !== NodeKind.Decision || to.player[a] !== from.player[b]) return;
		match[a] = b;
		for (let e = 0; e < to.numEdges[a]; e++) {
			const edge = to.firstEdge[a] + e;
			const other = matchEdge(to, edge, a, from, b);
			if (other >= 0) walk(to.edgeChild[edge], from.edgeChild[other]);
		}
	};
	walk(0, 0);
	return match;
}

function matchEdge(to: Tree, edge: number, node: number, from: Tree, other: number): number {
	const kind = to.edgeAction[edge];
	const sized = kind === ActionKind.Bet || kind === ActionKind.Raise;
	const size = to.edgeTarget[edge] / to.pot[node];
	let best = -1;
	let bestGap = Infinity;
	for (let e = 0; e < from.numEdges[other]; e++) {
		const candidate = from.firstEdge[other] + e;
		if (from.edgeAction[candidate] !== kind) continue;
		if (!sized) return candidate;
		const gap = Math.abs(Math.log(from.edgeTarget[candidate] / from.pot[other] / size));
		if (gap < bestGap) {
			bestGap = gap;
			best = candidate;
		}
	}
	return bestGap <= Math.log(SIZE_TOLERANCE) ? best : -1;
}

/** Read one block — a node on a board — as plain numbers, `actions * count` of them. */
function readBlock(
	store: RegretStore | SumStore,
	scale: Float64Array | null,
	block: number,
	base: number,
	length: number,
	out: Float64Array,
): void {
	const factor = scale ? scale[block] : 1;
	for (let i = 0; i < length; i++) out[i] = store[base + i] * factor;
}

/** Write one block, re-encoding it when storage is 16-bit. */
function writeBlock(
	store: RegretStore | SumStore,
	scale: Float64Array | null,
	steps: number,
	block: number,
	base: number,
	length: number,
	values: Float64Array,
): void {
	if (!scale) {
		for (let i = 0; i < length; i++) store[base + i] = values[i];
		return;
	}
	let largest = 0;
	for (let i = 0; i < length; i++) {
		const magnitude = Math.abs(values[i]);
		if (magnitude > largest) largest = magnitude;
	}
	const step = largest > 0 ? steps / largest : 0;
	for (let i = 0; i < length; i++) store[base + i] = Math.round(values[i] * step);
	scale[block] = largest / steps;
}

/** The real cards of a stored board. */
function realCards(runouts: Runouts, round: number, board: number): number[] {
	const width = runouts.width[round];
	return Array.from(runouts.cards[round].subarray(board * width, (board + 1) * width));
}

/**
 * Seed `to` from `from`. Both must be built on the same board.
 *
 * @returns what matched
 * @throws if the boards differ
 */
export function warmStart(to: Context, from: Context, averages: boolean): WarmStartReport {
	const a = to.runouts.initial;
	const b = from.runouts.initial;
	if (a.length !== b.length || a.some((card, i) => card !== b[i])) {
		throw new Error('A warm start must come from a solve of the same board');
	}
	const match = matchNodes(to.tree, from.tree);
	const { tree } = to;
	const width = to.layout.maxActions * COMBOS;
	const oldRegret = new Float64Array(width);
	const oldSum = new Float64Array(width);
	const newRegret = new Float64Array(width);
	const newSum = new Float64Array(width);
	const hasRegret = to.regret.length > 0 && from.regret.length > 0;

	// A combination's position in the old board's hand list, or -1.
	const position = new Int32Array(COMBOS).fill(-1);
	let matched = 0;
	for (const node of tree.decisionNodes) {
		const old = match[node];
		if (old < 0) continue;
		matched++;
		const round = tree.round[node];
		const owner = tree.player[node];
		const actions = tree.numEdges[node];
		const oldActions = from.tree.numEdges[old];

		// Which old action each new one continues.
		const actionOf = new Int32Array(actions).fill(-1);
		for (let e = 0; e < actions; e++) {
			const other = matchEdge(tree, tree.firstEdge[node] + e, node, from.tree, old);
			if (other >= 0) actionOf[e] = other - from.tree.firstEdge[old];
		}

		for (let board = 0; board < to.runouts.counts[round]; board++) {
			const resolved = resolveBoard(from.runouts, realCards(to.runouts, round, board));
			// Blocks are laid out by position in each board's hand list.
			const oldSlot = (from.active.roundBase[round] + resolved.board) * 2 + owner;
			const oldFrom = from.active.start[oldSlot];
			const oldCount = from.active.count[oldSlot];
			const oldBlock = from.layout.blockOffset[old] + resolved.board;
			const oldBase = from.layout.offset[old] + oldActions * from.layout.rowStart[oldSlot];
			const oldLength = oldActions * oldCount;
			if (hasRegret) readBlock(from.regret, from.regretScale, oldBlock, oldBase, oldLength, oldRegret);
			readBlock(from.strategySum, from.sumScale, oldBlock, oldBase, oldLength, oldSum);
			for (let j = 0; j < oldCount; j++) position[from.active.list[oldFrom + j]] = j;

			const newSlot = (to.active.roundBase[round] + board) * 2 + owner;
			const newFrom = to.active.start[newSlot];
			const count = to.active.count[newSlot];
			const length = actions * count;
			newRegret.fill(0, 0, length);
			newSum.fill(0, 0, length);
			for (let i = 0; i < count; i++) {
				const j = position[resolved.combos[to.active.list[newFrom + i]]];
				if (j < 0) continue;
				for (let e = 0; e < actions; e++) {
					const action = actionOf[e];
					if (action < 0) continue;
					newRegret[e * count + i] = oldRegret[action * oldCount + j];
					newSum[e * count + i] = oldSum[action * oldCount + j];
				}
			}
			for (let j = 0; j < oldCount; j++) position[from.active.list[oldFrom + j]] = -1;

			const block = to.layout.blockOffset[node] + board;
			const base = to.layout.offset[node] + actions * to.layout.rowStart[newSlot];
			if (hasRegret) writeBlock(to.regret, to.regretScale, REGRET_STEPS, block, base, length, newRegret);
			if (averages) writeBlock(to.strategySum, to.sumScale, SUM_STEPS, block, base, length, newSum);
			// The old solve may not have kept mirrored hands equal; this one must.
			tieBlock(to, node, board);
		}
	}
	return { matchedNodes: matched, decisionNodes: tree.decisionNodes.length, averages };
}
