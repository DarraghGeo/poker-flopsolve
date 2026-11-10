/**
 * Walking a solved spot on the benchmark page: any decision, on any board
 * the solver stored, as the page's grid and action mix.
 *
 * Purpose: the page shows more than the first decision. A `Solution` holds
 * live typed arrays that cannot leave the worker, so the worker answers each
 * step with a `NodeView`, plain data the page can draw.
 */

import { COMBO_CARDS, formatCards, NodeKind } from '../../src/index.ts';
import type { Solution, Spot } from '../../src/index.ts';
import { cellOfCards, CELLS } from './hands.ts';

/** Where an action leads: the next decision and the board it is on, or null where the hand ends. */
export interface Step {
	readonly node: number;
	readonly board: number;
	/** A card is dealt on the way. */
	readonly dealt: boolean;
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
	readonly actions: readonly string[];
	/** Each action's share over the range that gets here; zeros when nobody does. */
	readonly frequencies: readonly number[];
	/** Each grid cell's action mix, weighted by how much of it gets here; null where none does. */
	readonly cells: readonly (readonly number[] | null)[];
	/** Where each action leads. */
	readonly next: readonly (Step | null)[];
	/** The other cards that could have come at this street, to switch to; empty at the first street. */
	readonly runouts: readonly { readonly board: number; readonly card: string }[];
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
	return tree.kind[child] === NodeKind.Decision ? { node: child, board: at, dealt } : null;
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

	const siblings: { board: number; card: string }[] = [];
	if (round > 0) {
		const parent = runouts.parent[round][board];
		for (let b = runouts.childStart[round][parent]; b < runouts.childStart[round][parent + 1]; b++) {
			siblings.push({ board: b, card: formatCards([runouts.cards[round][b * width + width - 1]]) });
		}
	}

	return {
		node,
		board,
		player: view.player,
		round,
		cards: formatCards(boardCards),
		pot: tree.pot[node] / spot.chipScale,
		actions: [...view.actions],
		frequencies: Array.from(total, (p) => (mass > 0 ? p / mass : 0)),
		cells,
		next: view.actions.map((_, k) => stepOf(spot, node, board, k)),
		runouts: siblings,
	};
}
