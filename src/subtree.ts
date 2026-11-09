/**
 * Copy the subtree below a node of a solve into a subgame (issue #47).
 *
 * Purpose: read a solve's own strategy below a node as a subgame of its own,
 * the spot `Solution.subgameAt` builds, so that re-solves and references can
 * be compared with it node for node. Analysis only: nothing in the package
 * imports this, so it costs a bundle nothing.
 *
 * `warmStart` copies a whole solve into one of the same board; this is the
 * same copy started at a node that opens a later betting round. Two things
 * differ there. The subgame's rounds count from its own first one, and its
 * bet sizes count from what each player puts in from then on, where the
 * solve's count from the start of the hand.
 */

import type { Context } from './cfr.ts';
import { COMBOS } from './cards.ts';
import { markMembers } from './hands.ts';
import { resolveBoard } from './runouts.ts';
import type { Tree } from './tree.ts';
import { ActionKind, NodeKind } from './tree.ts';
import type { WarmStartReport } from './warm.ts';
import { readBlock, realCards, REGRET_STEPS, SIZE_TOLERANCE, SUM_STEPS, writeBlock } from './warm.ts';

/**
 * Pair each decision node of subgame `to` with its counterpart below `fromRoot`
 * in `from`, or -1.
 *
 * @throws if `fromRoot` does not open a betting round
 */
export function matchSubtree(to: Tree, from: Tree, fromRoot: number): Int32Array {
	if (!opensRound(from, fromRoot)) {
		throw new Error(`Node ${fromRoot} is inside a betting round; a subtree can only be copied from a node that opens a betting round`);
	}
	const match = new Int32Array(to.nodeCount).fill(-1);
	const shift = from.round[fromRoot];
	const invested = investedBefore(from, fromRoot);
	const walk = (a: number, b: number): void => {
		if (to.kind[a] !== from.kind[b] || to.round[a] + shift !== from.round[b]) return;
		if (to.kind[a] === NodeKind.Chance) {
			walk(to.edgeChild[to.firstEdge[a]], from.edgeChild[from.firstEdge[b]]);
			return;
		}
		if (to.kind[a] !== NodeKind.Decision || to.player[a] !== from.player[b]) return;
		match[a] = b;
		for (let e = 0; e < to.numEdges[a]; e++) {
			const edge = to.firstEdge[a] + e;
			const other = matchEdge(to, edge, a, from, b, invested);
			if (other >= 0) walk(to.edgeChild[edge], from.edgeChild[other]);
		}
	};
	walk(0, fromRoot);
	return match;
}

/**
 * Copy `from`'s strategy below `fromNode` into `to`, a subgame of `from` at
 * that node and one of its boards (`Solution.subgameAt`).
 *
 * @param averages copy the average strategy as well as the regrets
 * @throws if `fromNode` does not open a betting round, or `to`'s board is
 *   not one dealt there
 */
export function copySubtree(to: Context, from: Context, averages: boolean, fromNode: number): WarmStartReport {
	// As for warmStart: into shared storage each history would overwrite its group's block.
	if (to.layout.shared && !from.layout.shared) {
		throw new Error('A spot with shareHistories can only copy from a solve that shares histories too');
	}
	const shift = from.tree.round[fromNode];
	const a = to.runouts.initial;
	const b = from.runouts.initial;
	if (a.length !== from.runouts.width[shift] || b.some((card, i) => card !== a[i])) {
		throw new Error(`A subgame must have a board dealt at node ${fromNode} of the solve it copies`);
	}
	const match = matchSubtree(to.tree, from.tree, fromNode);
	const invested = investedBefore(from.tree, fromNode);
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
			const other = matchEdge(tree, tree.firstEdge[node] + e, node, from.tree, old, invested);
			if (other >= 0) actionOf[e] = other - from.tree.firstEdge[old];
		}

		for (let board = 0; board < to.runouts.counts[round]; board++) {
			const resolved = resolveBoard(from.runouts, realCards(to.runouts, round, board));
			const oldSlot = (from.active.roundBase[round + shift] + resolved.board) * 2 + owner;
			const oldFrom = from.active.start[oldSlot];
			const oldCount = from.active.count[oldSlot];
			const oldBlock = from.layout.blockOffset[old] + resolved.board;
			const oldBase = from.layout.offset[old] + oldActions * from.layout.rowStart[oldSlot];
			const oldLength = oldActions * oldCount;
			if (hasRegret) readBlock(from.regret, from.regretScale, oldBlock, oldBase, oldLength, oldRegret);
			readBlock(from.strategySum, from.sumScale, oldBlock, oldBase, oldLength, oldSum);
			markMembers(from.active, oldFrom, oldCount, position, false);

			const newSlot = (to.active.roundBase[round] + board) * 2 + owner;
			const newFrom = to.active.start[newSlot];
			const count = to.active.count[newSlot];
			const length = actions * count;
			newRegret.fill(0, 0, length);
			newSum.fill(0, 0, length);
			for (let i = 0; i < count; i++) {
				// An entry stands for its mirror orbit here, which the solve
				// may have stored apart: it takes their mean.
				const firstMember = to.active.memberStart[newFrom + i];
				const membersEnd = to.active.memberStart[newFrom + i + 1];
				const share = 1 / (membersEnd - firstMember);
				for (let m = firstMember; m < membersEnd; m++) {
					const j = position[resolved.combos[to.active.memberCombo[m]]];
					if (j < 0) continue;
					for (let e = 0; e < actions; e++) {
						const action = actionOf[e];
						if (action < 0) continue;
						newRegret[e * count + i] += share * oldRegret[action * oldCount + j];
						newSum[e * count + i] += share * oldSum[action * oldCount + j];
					}
				}
			}
			markMembers(from.active, oldFrom, oldCount, position, true);

			const block = to.layout.blockOffset[node] + board;
			const offset = to.layout.offset[node] + actions * to.layout.rowStart[newSlot];
			if (hasRegret) writeBlock(to.regret, to.regretScale, REGRET_STEPS, block, offset, length, newRegret);
			if (averages) writeBlock(to.strategySum, to.sumScale, SUM_STEPS, block, offset, length, newSum);
		}
	}
	return { matchedNodes: matched, decisionNodes: tree.decisionNodes.length, averages };
}

/** Whether `node` is a decision a chance node deals into. */
function opensRound(tree: Tree, node: number): boolean {
	if (tree.kind[node] !== NodeKind.Decision) return false;
	for (let chance = 0; chance < tree.nodeCount; chance++) {
		if (tree.kind[chance] !== NodeKind.Chance) continue;
		for (let e = 0; e < tree.numEdges[chance]; e++) if (tree.edgeChild[tree.firstEdge[chance] + e] === node) return true;
	}
	return false;
}

/** What each player put in before `node`, which opens a round level. */
function investedBefore(tree: Tree, node: number): number {
	return (tree.pot[node] - tree.pot[0]) / 2;
}

/**
 * The edge of `from` at `other` that continues `to`'s `edge`: the same action
 * and, for a bet or raise, the nearest size as a share of the pot, counting
 * `from`'s investment from `invested` on.
 */
function matchEdge(to: Tree, edge: number, node: number, from: Tree, other: number, invested: number): number {
	const kind = to.edgeAction[edge];
	const sized = kind === ActionKind.Bet || kind === ActionKind.Raise;
	const size = to.edgeTarget[edge] / to.pot[node];
	let best = -1;
	let bestGap = Infinity;
	for (let e = 0; e < from.numEdges[other]; e++) {
		const candidate = from.firstEdge[other] + e;
		if (from.edgeAction[candidate] !== kind) continue;
		if (!sized) return candidate;
		const gap = Math.abs(Math.log((from.edgeTarget[candidate] - invested) / from.pot[other] / size));
		if (gap < bestGap) {
			bestGap = gap;
			best = candidate;
		}
	}
	return bestGap <= Math.log(SIZE_TOLERANCE) ? best : -1;
}
