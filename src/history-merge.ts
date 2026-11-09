/**
 * History merging: turn and river storage shared between betting histories
 * (issue #49). An imperfect-recall abstraction of the betting history.
 *
 * Purpose: decide which decision nodes share one block of storage.
 *
 * Every flop line gets its own copy of the turn and river below it, but a
 * round's subtree depends only on where the round starts: the pot and stacks.
 * Lines that reach the same start — check, bet 33%, call against bet 33%,
 * call — have identical subtrees. Aliasing their nodes' storage lets every
 * history keep its own walk (its own reach, its own values) while regrets and
 * strategy sums accumulate in one place.
 *
 * A round root is the first decision of a later round, the child of a chance
 * node. Only the last round's roots share. Roots with identical subtrees form
 * a group; within a group every root is walked in step with the first one and
 * each node is aliased to its counterpart.
 */

import type { Runouts } from './runouts.ts';
import type { Tree } from './tree.ts';
import { NodeKind } from './tree.ts';

export interface HistoryShareOptions {
	/** Nodes marked 1 never share: a marked round root keeps its own subtree. */
	readonly keep?: Uint8Array;
}

export interface HistoryShare {
	/** Each node's storage owner: itself, or the node it shares with. */
	readonly alias: Int32Array;
	/** Round roots per round, and how many groups the shared round formed. */
	readonly roots: Int32Array;
	readonly groups: Int32Array;
}

/** Intern strings as small integers. */
function interner(): (key: string) => number {
	const ids = new Map<string, number>();
	return (key) => {
		let id = ids.get(key);
		if (id === undefined) ids.set(key, (id = ids.size));
		return id;
	};
}

/**
 * Subtree signatures: equal exactly when two subtrees are identical, amounts
 * included, so nothing below the nodes changes the game.
 */
function signatures(tree: Tree): Int32Array {
	const exact = new Int32Array(tree.nodeCount);
	const exactId = interner();
	// Children always come after their parent, so a reverse sweep sees them first.
	for (let node = tree.nodeCount - 1; node >= 0; node--) {
		let e = `${tree.kind[node]},${tree.player[node]},${tree.round[node]},${tree.pot[node]},${tree.payoff[node]}`;
		const first = tree.firstEdge[node];
		for (let i = 0; i < tree.numEdges[node]; i++) {
			const edge = first + i;
			e += `|${tree.edgeAction[edge]}:${tree.edgeTarget[edge]}:${exact[tree.edgeChild[edge]]}`;
		}
		exact[node] = exactId(e);
	}
	return exact;
}

/** Decide which nodes share storage. */
export function aliasHistories(tree: Tree, runouts: Runouts, options: HistoryShareOptions = {}): HistoryShare {
	const exact = signatures(tree);
	const alias = new Int32Array(tree.nodeCount);
	for (let node = 0; node < tree.nodeCount; node++) alias[node] = node;

	// Round roots, by round. Children come after parents, so these are in tree order.
	const rootsByRound: number[][] = Array.from({ length: runouts.rounds }, () => []);
	for (let node = 0; node < tree.nodeCount; node++) {
		if (tree.kind[node] !== NodeKind.Chance) continue;
		const child = tree.edgeChild[tree.firstEdge[node]];
		if (tree.kind[child] === NodeKind.Decision) rootsByRound[tree.round[child]].push(child);
	}

	const walk = (rep: number, member: number): void => {
		alias[member] = rep;
		const a = tree.firstEdge[rep];
		const b = tree.firstEdge[member];
		for (let i = 0; i < tree.numEdges[rep]; i++) walk(tree.edgeChild[a + i], tree.edgeChild[b + i]);
	};

	const roots = new Int32Array(runouts.rounds);
	const groups = new Int32Array(runouts.rounds);
	const last = runouts.rounds - 1;
	if (last >= 1) {
		const reps = new Map<number, number>();
		for (const root of rootsByRound[last]) {
			if (options.keep?.[root]) continue;
			const rep = reps.get(exact[root]);
			if (rep === undefined) reps.set(exact[root], root);
			else walk(rep, root);
		}
		groups[last] = reps.size;
	}
	for (let round = 1; round < runouts.rounds; round++) roots[round] = rootsByRound[round].length;

	return { alias, roots, groups };
}
