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
 * node. Roots are grouped by a key; within a group every root is walked in
 * step with the first one and each node is aliased to its counterpart.
 */

import type { Runouts } from './runouts.ts';
import type { Tree } from './tree.ts';
import { NodeKind } from './tree.ts';

/**
 * Which round roots share. `exact`: identical subtrees, amounts included.
 * `spr`: the same actions in the same order, amounts ignored, with the
 * stack-to-pot ratio in one bucket of log-width `width`.
 */
export type HistoryKey = { readonly kind: 'exact' } | { readonly kind: 'spr'; readonly width: number };

export interface HistoryShareOptions {
	readonly key: HistoryKey;
	/** First round whose roots share; later rounds share too. 1 is the turn on a flop spot. */
	readonly fromRound: number;
}

export interface HistoryShare {
	/** Each node's storage owner: itself, or the node it shares with. */
	readonly alias: Int32Array;
	/** Round roots per round, and how many groups the shared rounds formed. */
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
 * Subtree signatures: `exact` covers everything that changes the game below a
 * node; `shape` only kinds, players and actions.
 */
function signatures(tree: Tree): { exact: Int32Array; shape: Int32Array } {
	const exact = new Int32Array(tree.nodeCount);
	const shape = new Int32Array(tree.nodeCount);
	const exactId = interner();
	const shapeId = interner();
	// Children always come after their parent, so a reverse sweep sees them first.
	for (let node = tree.nodeCount - 1; node >= 0; node--) {
		const head = `${tree.kind[node]},${tree.player[node]},${tree.round[node]}`;
		let e = `${head},${tree.pot[node]},${tree.payoff[node]}`;
		let s = head;
		const first = tree.firstEdge[node];
		for (let i = 0; i < tree.numEdges[node]; i++) {
			const edge = first + i;
			const child = tree.edgeChild[edge];
			e += `|${tree.edgeAction[edge]}:${tree.edgeTarget[edge]}:${exact[child]}`;
			s += `|${tree.edgeAction[edge]}:${shape[child]}`;
		}
		exact[node] = exactId(e);
		shape[node] = shapeId(s);
	}
	return { exact, shape };
}

/**
 * Decide which nodes share storage.
 * @param stackUnits effective stack, for the SPR key
 */
export function aliasHistories(
	tree: Tree,
	runouts: Runouts,
	options: HistoryShareOptions,
	stackUnits?: number,
): HistoryShare {
	if (options.key.kind === 'spr' && !(stackUnits !== undefined && stackUnits > 0)) {
		throw new Error('aliasHistories: an SPR key needs the effective stack');
	}
	const { exact, shape } = signatures(tree);
	const alias = new Int32Array(tree.nodeCount);
	for (let node = 0; node < tree.nodeCount; node++) alias[node] = node;

	// Round roots, by round. Children come after parents, so these are in tree order.
	const rootsByRound: number[][] = Array.from({ length: runouts.rounds }, () => []);
	for (let node = 0; node < tree.nodeCount; node++) {
		if (tree.kind[node] !== NodeKind.Chance) continue;
		const child = tree.edgeChild[tree.firstEdge[node]];
		if (tree.kind[child] === NodeKind.Decision) rootsByRound[tree.round[child]].push(child);
	}

	const potUnits = tree.pot[0];
	const bucketOf = (root: number): number => {
		if (options.key.kind === 'exact') return 0;
		const invested = (tree.pot[root] - potUnits) / 2;
		const spr = (stackUnits! - invested) / tree.pot[root];
		return Math.floor(Math.log(spr) / Math.log(1 + options.key.width));
	};

	const walk = (rep: number, member: number): void => {
		alias[member] = rep;
		const a = tree.firstEdge[rep];
		const b = tree.firstEdge[member];
		for (let i = 0; i < tree.numEdges[rep]; i++) walk(tree.edgeChild[a + i], tree.edgeChild[b + i]);
	};

	const roots = new Int32Array(runouts.rounds);
	const groups = new Int32Array(runouts.rounds);
	for (let round = Math.max(1, options.fromRound); round < runouts.rounds; round++) {
		const reps = new Map<string, number>();
		for (const root of rootsByRound[round] ?? []) {
			// Already following a representative from an earlier round's walk.
			if (alias[root] !== root) continue;
			const key = options.key.kind === 'exact' ? `${exact[root]}` : `${shape[root]}/${bucketOf(root)}`;
			const rep = reps.get(key);
			if (rep === undefined) reps.set(key, root);
			else walk(rep, root);
		}
		groups[round] = reps.size;
	}
	// A node can follow a representative that later follows another.
	for (let node = 0; node < tree.nodeCount; node++) {
		let owner = alias[node];
		while (alias[owner] !== owner) owner = alias[owner];
		alias[node] = owner;
	}
	for (let round = 1; round < runouts.rounds; round++) roots[round] = rootsByRound[round].length;

	return { alias, roots, groups };
}
