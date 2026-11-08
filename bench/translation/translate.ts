/**
 * Action translation for issue #54: read a strategy solved in a tree with
 * fewer raises (`raiseOver`) as a strategy of the full tree.
 *
 * The two trees are walked together from the root, as `warm.ts` walks them.
 * Where the full tree offers a sized raise that the solved one does not — a
 * raise over a bet it solved no raises over — the raiser is given probability
 * 0 there, which is a legal strategy of the full game, and the subtree below
 * that raise, which a best response can still walk into, is read from the
 * solved tree's raise over the nearest anchor bet. That is the translation:
 * facing a raise over a 0.33-pot bet, the bettor plays as it would facing the
 * same raise over a 0.75-pot bet.
 *
 * The raise is a pot fraction in both lines (0.75 of the pot after the call),
 * so the pot odds it lays are the same and the pseudo-harmonic mapping of
 * Ganzfried and Sandholm (2013) is deterministic here: it maps a size onto
 * itself. Only the geometry behind it differs — a smaller pot and a deeper
 * stack in the translated line.
 */

import { averageStrategy, blockBase, type Context } from '../../src/cfr.ts';
import type { SolveRun } from '../../src/index.ts';
import type { Tree } from '../../src/tree.ts';
import { ActionKind, NodeKind } from '../../src/tree.ts';

/** Each full-tree decision's counterpart in the solved tree, and which solved action each full action plays as. */
export interface Translation {
	/** Solved-tree node for each full-tree node, or -1. */
	readonly node: Int32Array;
	/** For each full-tree edge: the solved-tree edge whose probability it takes, or -1 for never. */
	readonly edge: Int32Array;
	/** Full-tree decisions reached through a translated raise. */
	readonly translatedNodes: number;
	/** Full-tree decisions with no counterpart; they would play uniformly. */
	readonly unmatched: number;
	/** The full-tree decisions just below a translated raise: the player facing it. */
	readonly entries: readonly number[];
	/** 1 for full-tree decisions reached through a translated raise. */
	readonly translatedMask: Uint8Array;
}

const aggressive = (kind: number): boolean =>
	kind === ActionKind.Bet || kind === ActionKind.Raise || kind === ActionKind.AllIn;

/** What the actor at `node` has in, and what the opponent has in. */
function stakes(tree: Tree, node: number): { mine: number; theirs: number } {
	const first = tree.firstEdge[node];
	if (tree.edgeAction[first] === ActionKind.Fold) {
		return { mine: tree.edgeTarget[first], theirs: tree.edgeTarget[first + 1] };
	}
	return { mine: tree.edgeTarget[first], theirs: tree.edgeTarget[first] };
}

/** A sized action as a fraction of the pot after calling. */
export function sizeOf(tree: Tree, node: number, edge: number): number {
	const { mine, theirs } = stakes(tree, node);
	const owed = theirs - mine;
	return (tree.edgeTarget[edge] - theirs) / (tree.pot[node] + owed);
}

/** The edge at `node` of `kind` whose size is nearest `size`, or -1. */
function nearest(tree: Tree, node: number, kinds: (kind: number) => boolean, size: number): number {
	let best = -1;
	let gap = Infinity;
	for (let e = tree.firstEdge[node]; e < tree.firstEdge[node] + tree.numEdges[node]; e++) {
		if (!kinds(tree.edgeAction[e])) continue;
		const g = Math.abs(Math.log((sizeOf(tree, node, e) + 1e-9) / (size + 1e-9)));
		if (g < gap) {
			gap = g;
			best = e;
		}
	}
	return best;
}

/**
 * Pair the full tree `full` with the solved tree `solved`.
 */
export function translate(full: Tree, solved: Tree): Translation {
	const node = new Int32Array(full.nodeCount).fill(-1);
	const edge = new Int32Array(full.edgeCount).fill(-1);
	// The edge into each solved node, to find the anchor bet beside it.
	const parentEdge = new Int32Array(solved.nodeCount).fill(-1);
	const parentNode = new Int32Array(solved.nodeCount).fill(-1);
	for (let n = 0; n < solved.nodeCount; n++) {
		for (let e = solved.firstEdge[n]; e < solved.firstEdge[n] + solved.numEdges[n]; e++) {
			if (solved.edgeChild[e] >= 0) {
				parentEdge[solved.edgeChild[e]] = e;
				parentNode[solved.edgeChild[e]] = n;
			}
		}
	}
	let translatedNodes = 0;
	const entries: number[] = [];
	const translatedMask = new Uint8Array(full.nodeCount);

	/** Facing a bet `solved` raises nothing over: the same raise over the nearest bet it does. */
	const anchorRaise = (a: number, size: number): number => {
		const into = parentEdge[a];
		const bettor = parentNode[a];
		if (into < 0 || solved.kind[bettor] !== NodeKind.Decision) return -1;
		const facing = sizeOf(solved, bettor, into);
		let best = -1;
		let gap = Infinity;
		for (let e = solved.firstEdge[bettor]; e < solved.firstEdge[bettor] + solved.numEdges[bettor]; e++) {
			if (solved.edgeAction[e] !== ActionKind.Bet) continue;
			const child = solved.edgeChild[e];
			if (solved.kind[child] !== NodeKind.Decision) continue;
			const raise = nearest(solved, child, (k) => k === ActionKind.Raise, size);
			if (raise < 0) continue;
			const g = Math.abs(Math.log(sizeOf(solved, bettor, e) / facing));
			if (g < gap) {
				gap = g;
				best = raise;
			}
		}
		return best;
	};

	const walk = (f: number, a: number, translated: boolean): void => {
		if (full.kind[f] !== solved.kind[a] || full.round[f] !== solved.round[a]) return;
		if (full.kind[f] === NodeKind.Chance) {
			walk(full.edgeChild[full.firstEdge[f]], solved.edgeChild[solved.firstEdge[a]], translated);
			return;
		}
		if (full.kind[f] !== NodeKind.Decision || full.player[f] !== solved.player[a]) return;
		node[f] = a;
		if (translated) {
			translatedNodes++;
			translatedMask[f] = 1;
		}
		for (let e = full.firstEdge[f]; e < full.firstEdge[f] + full.numEdges[f]; e++) {
			const kind = full.edgeAction[e];
			const child = full.edgeChild[e];
			let other = -1;
			if (!aggressive(kind)) {
				for (let o = solved.firstEdge[a]; o < solved.firstEdge[a] + solved.numEdges[a]; o++) {
					if (solved.edgeAction[o] === kind) other = o;
				}
			} else {
				other = nearest(solved, a, (k) => k === kind, sizeOf(full, f, e));
				// A shove the solved tree reached as a sized action, or the reverse.
				if (other < 0 && kind !== ActionKind.Raise) other = nearest(solved, a, aggressive, sizeOf(full, f, e));
			}
			if (other >= 0) {
				edge[e] = other;
				walk(child, solved.edgeChild[other], translated);
				continue;
			}
			if (kind === ActionKind.Raise && process.env.TRANSLATE !== 'off') {
				// Never raised here; what follows is read from the anchor line.
				const anchor = anchorRaise(a, sizeOf(full, f, e));
				if (anchor >= 0) {
					if (full.kind[child] === NodeKind.Decision) entries.push(child);
					walk(child, solved.edgeChild[anchor], true);
				}
				else {
					const shove = nearest(solved, a, aggressive, sizeOf(full, f, e));
					if (shove >= 0) walk(child, solved.edgeChild[shove], true);
				}
			}
		}
	};
	walk(0, 0, false);

	let unmatched = 0;
	for (const n of full.decisionNodes) if (node[n] < 0) unmatched++;
	return { node, edge, translatedNodes, unmatched, entries, translatedMask };
}

/**
 * Write the solved strategy, translated, into the full tree's strategy sums
 * as probabilities. `to` should be an analysis-only, 32-bit context of the
 * same spot with the full tree, so its hand lists match `from`'s row for row.
 */
export function applyTranslation(
	to: Context,
	from: Context,
	t: Translation,
	unmatched: 'uniform' | 'call' | 'fold' = 'uniform',
	only?: Uint8Array,
): void {
	const tree = to.tree;
	const strategy = new Float64Array(from.layout.maxActions * 2048);
	for (const n of tree.decisionNodes) {
		if (only && !only[n]) continue;
		const a = t.node[n];
		if (a < 0) {
			// No counterpart: a fixed play, to see how much these nodes matter.
			if (unmatched === 'uniform') continue;
			const want = unmatched === 'call' ? ActionKind.Call : ActionKind.Fold;
			for (let board = 0; board < to.runouts.counts[tree.round[n]]; board++) {
				const slot = (to.active.roundBase[tree.round[n]] + board) * 2 + tree.player[n];
				const count = to.active.count[slot];
				const base = blockBase(to.layout, tree, n, board);
				for (let e = 0; e < tree.numEdges[n]; e++) {
					const kind = tree.edgeAction[tree.firstEdge[n] + e];
					const hit = kind === want || (want === ActionKind.Call && kind === ActionKind.Check);
					for (let i = 0; i < count; i++) to.strategySum[base + e * count + i] = hit ? 1 : 0;
				}
			}
			continue;
		}
		const round = tree.round[n];
		const owner = tree.player[n];
		const actions = tree.numEdges[n];
		const solvedActions = from.tree.numEdges[a];
		// How many full actions share each solved one, so they split it.
		const share = new Float64Array(solvedActions);
		for (let e = 0; e < actions; e++) {
			const o = t.edge[tree.firstEdge[n] + e];
			if (o >= 0) share[o - from.tree.firstEdge[a]]++;
		}
		for (let board = 0; board < to.runouts.counts[round]; board++) {
			const slot = (to.active.roundBase[round] + board) * 2 + owner;
			const count = to.active.count[slot];
			averageStrategy(from.strategySum, blockBase(from.layout, from.tree, a, board), solvedActions, count, strategy, from.regret);
			const base = blockBase(to.layout, tree, n, board);
			for (let e = 0; e < actions; e++) {
				const o = t.edge[tree.firstEdge[n] + e];
				for (let i = 0; i < count; i++) {
					to.strategySum[base + e * count + i] =
						o < 0 ? 0 : strategy[(o - from.tree.firstEdge[a]) * count + i] / share[o - from.tree.firstEdge[a]];
				}
			}
		}
	}
}

/**
 * Frequency-matched translation at the first translated decision: the player
 * facing a translated raise continues as often as their anchor range did,
 * not hand for hand. Hands are ranked by how often the anchor continued with
 * them and the top of the player's real range continues, playing the
 * anchor's mix of non-folds; the rest fold. This answers the obvious failure
 * of hand-for-hand translation: after a 0.33 bet the range is wider and
 * weaker than after a 0.75 one, so copying each hand's anchor play folds far
 * too often to the raise.
 *
 * @param full the full-tree run holding the translated strategy
 * @param solved the abstract run it was read from
 */
export function matchFrequencies(full: SolveRun, solved: SolveRun, t: Translation): void {
	const to = full.solver.ctx;
	const tree = to.tree;
	const fullView = full.snapshot();
	const solvedView = solved.snapshot();
	for (const n of t.entries) {
		const a = t.node[n];
		const round = tree.round[n];
		const owner = tree.player[n] as 0 | 1;
		const actions = tree.numEdges[n];
		const fold = tree.edgeAction[tree.firstEdge[n]] === ActionKind.Fold ? 0 : -1;
		if (fold < 0) continue;
		// The anchor's continue frequency needs reach there; boards in order.
		for (let board = 0; board < to.runouts.counts[round]; board++) {
			const slot = (to.active.roundBase[round] + board) * 2 + owner;
			const start = to.active.start[slot];
			const count = to.active.count[slot];
			const base = blockBase(to.layout, tree, n, board);
			const reachFull = fullView.reachAt(n, board, owner);
			const reachSolved = solvedView.reachAt(a, board, owner);
			const cont = new Float64Array(count);
			let massSolved = 0;
			let contSolved = 0;
			let massFull = 0;
			for (let i = 0; i < count; i++) {
				const combo = to.active.list[start + i];
				const m = to.active.multiplicity[start + i];
				cont[i] = 1 - to.strategySum[base + fold * count + i];
				massSolved += m * reachSolved[combo];
				contSolved += m * reachSolved[combo] * cont[i];
				massFull += m * reachFull[combo];
			}
			if (!(massSolved > 0) || !(massFull > 0)) continue;
			let budget = (contSolved / massSolved) * massFull;
			const order = Array.from({ length: count }, (_, i) => i).sort((x, y) => cont[y] - cont[x]);
			for (const i of order) {
				const combo = to.active.list[start + i];
				const m = to.active.multiplicity[start + i] * reachFull[combo];
				const keep = m <= 0 ? (budget > 0 ? 1 : 0) : Math.max(0, Math.min(1, budget / m));
				if (m > 0) budget -= keep * m;
				// The anchor's mix of non-folds, or a call where it only folded.
				let rest = 0;
				for (let e = 0; e < actions; e++) if (e !== fold) rest += to.strategySum[base + e * count + i];
				for (let e = 0; e < actions; e++) {
					if (e === fold) continue;
					const p = rest > 0 ? to.strategySum[base + e * count + i] / rest : tree.edgeAction[tree.firstEdge[n] + e] === ActionKind.Call ? 1 : 0;
					to.strategySum[base + e * count + i] = keep * p;
				}
				to.strategySum[base + fold * count + i] = 1 - keep;
			}
		}
	}
}
