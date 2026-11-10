/**
 * Walking a solved spot on the benchmark page: any decision, on any board
 * the solver stored, as the page's grid and action mix.
 *
 * Purpose: the page shows more than the first decision. A `Solution` holds
 * live typed arrays that cannot leave the worker, so the worker answers each
 * step with a `NodeView`, plain data the page can draw.
 */

import { ACTION_LABELS, ActionKind, COMBO_CARDS, formatCards, NodeKind } from '../../src/index.ts';
import type { Solution, Spot } from '../../src/index.ts';
import { cellOfCards, CELLS } from './hands.ts';

/** Where an action leads: the next decision and the board it is on, or null where the hand ends. */
export interface Step {
	readonly node: number;
	readonly board: number;
	/** A card is dealt on the way. */
	readonly dealt: boolean;
	/** The street of that decision, 0 at the spot's first. */
	readonly round: number;
}

/** One decision on one board, ready to draw. */
export interface NodeView {
	readonly node: number;
	readonly board: number;
	readonly player: 0 | 1;
	/** 0 at the spot's first street. */
	readonly round: number;
	/** The board's cards here, e.g. "Ks 9d 4c 2h". */
	readonly cards: string;
	/** Pot at the decision, chips. */
	readonly pot: number;
	/**
	 * `check`, `call`, `fold`, or the kind and the chips the actor has in on
	 * this street after it: `bet 10`, `raise 30`, `allin 45`.
	 */
	readonly actions: readonly string[];
	/** Each action's share over the range that gets here; zeros when nobody does. */
	readonly frequencies: readonly number[];
	/** Each grid cell's action mix, weighted by how much of it gets here; null where none does. */
	readonly cells: readonly (readonly number[] | null)[];
	/** Where each action leads. */
	readonly next: readonly (Step | null)[];
	/**
	 * The cards that could have come at this street, to switch to; empty at
	 * the first street. A stored runout stands for its suit mirrors too
	 * (`also`), which play the same with the suits swapped.
	 */
	readonly runouts: readonly { readonly board: number; readonly card: string; readonly also: readonly string[] }[];
}

/** The decision an action leads to, through any card dealt, or null where the hand ends. */
export function stepOf(spot: Spot, node: number, board: number, action: number): Step | null {
	const { tree, runouts } = spot;
	let child = tree.edgeChild[tree.firstEdge[node] + action];
	let at = board;
	let dealt = false;
	while (tree.kind[child] === NodeKind.Chance) {
		const round = tree.round[tree.edgeChild[tree.firstEdge[child]]];
		const first = runouts.childStart[round]?.[at];
		if (first === undefined || first >= runouts.childStart[round][at + 1]) return null;
		at = first;
		dealt = true;
		child = tree.edgeChild[tree.firstEdge[child]];
	}
	return tree.kind[child] === NodeKind.Decision ? { node: child, board: at, dealt, round: tree.round[child] } : null;
}

const streetStarts = new WeakMap<Spot, Int32Array>();

/** Each decision's pot when its street began, in units; the tree keeps only the pot at the node. */
function streetStartPots(spot: Spot): Int32Array {
	const cached = streetStarts.get(spot);
	if (cached) return cached;
	const { tree } = spot;
	const out = new Int32Array(tree.nodeCount);
	const stack: [number, number][] = [[0, tree.pot[0]]];
	while (stack.length > 0) {
		const [node, start] = stack.pop()!;
		const kind = tree.kind[node];
		if (kind === NodeKind.Chance) {
			const child = tree.edgeChild[tree.firstEdge[node]];
			stack.push([child, tree.pot[child]]);
			continue;
		}
		if (kind !== NodeKind.Decision) continue;
		out[node] = start;
		for (let e = 0; e < tree.numEdges[node]; e++) stack.push([tree.edgeChild[tree.firstEdge[node] + e], start]);
	}
	streetStarts.set(spot, out);
	return out;
}

/** An action as `NodeView.actions` names it, counting this street's chips only. */
function streetLabel(spot: Spot, node: number, edge: number): string {
	const { tree } = spot;
	const action = tree.edgeAction[edge];
	if (action < ActionKind.Bet) return ACTION_LABELS[action];
	// Both players have the same in when a street begins.
	const before = (streetStartPots(spot)[node] - tree.pot[0]) / 2;
	return `${ACTION_LABELS[action]} ${(tree.edgeTarget[edge] - before) / spot.chipScale}`;
}

/**
 * The cards that could have come at `round` instead of `board`'s, `board`'s
 * own among them; empty at the first round.
 */
export function runoutsOf(spot: Spot, round: number, board: number): NodeView['runouts'] {
	const { runouts } = spot;
	if (round === 0) return [];
	const width = runouts.width[round];
	const parent = runouts.parent[round][board];
	const orbits = runouts.orbitStart[round];
	const siblings: { board: number; card: string; also: string[] }[] = [];
	for (let b = runouts.childStart[round][parent]; b < runouts.childStart[round][parent + 1]; b++) {
		const also: string[] = [];
		for (let m = orbits[b] + 1; m < orbits[b + 1]; m++) also.push(formatCards([runouts.orbitCard[round][m]]));
		siblings.push({ board: b, card: formatCards([runouts.cards[round][b * width + width - 1]]), also });
	}
	return siblings;
}

/** The view of `node` on `board`. */
export function nodeView(spot: Spot, solution: Solution, node: number, board: number): NodeView {
	const { tree, runouts } = spot;
	if (tree.kind[node] !== NodeKind.Decision) throw new Error(`node ${node} is not a decision`);
	const round = tree.round[node];
	if (!(board >= 0 && board < runouts.counts[round])) throw new Error(`no board ${board} at round ${round}`);
	const width = runouts.width[round];
	const boardCards = runouts.cards[round].subarray(board * width, board * width + width);

	const view = solution.strategyAt(node, board);
	const reach = solution.reachAt(node, board, view.player);
	const actions = view.actions.length;
	const total = new Float64Array(actions);
	const cellMix = new Float64Array(CELLS * actions);
	const cellWeight = new Float64Array(CELLS);
	let mass = 0;
	for (let i = 0; i < view.combos.length; i++) {
		const combo = view.combos[i];
		const a = COMBO_CARDS[combo * 2];
		const b = COMBO_CARDS[combo * 2 + 1];
		// A hand the runout has taken cannot be held here.
		if (boardCards.includes(a) || boardCards.includes(b)) continue;
		const weight = reach[combo];
		if (!(weight > 0)) continue;
		const cell = cellOfCards(a, b);
		mass += weight;
		cellWeight[cell] += weight;
		for (let k = 0; k < actions; k++) {
			const p = view.probs[i * actions + k] * weight;
			total[k] += p;
			cellMix[cell * actions + k] += p;
		}
	}
	const cells: (number[] | null)[] = [];
	for (let cell = 0; cell < CELLS; cell++) {
		const w = cellWeight[cell];
		cells.push(w > 0 ? Array.from({ length: actions }, (_, k) => cellMix[cell * actions + k] / w) : null);
	}

	return {
		node,
		board,
		player: view.player,
		round,
		cards: formatCards(boardCards),
		pot: tree.pot[node] / spot.chipScale,
		actions: view.actions.map((_, k) => streetLabel(spot, node, tree.firstEdge[node] + k)),
		frequencies: Array.from(total, (p) => (mass > 0 ? p / mass : 0)),
		cells,
		next: view.actions.map((_, k) => stepOf(spot, node, board, k)),
		runouts: runoutsOf(spot, round, board),
	};
}
