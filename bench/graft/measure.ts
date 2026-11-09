/**
 * What issue #56 reads off a solve: per-combination root EV of both players
 * (via bench/coarse-to-fine), and at each of the two flop decisions that open
 * the betting — OOP's root, and IP's after a check — every hand's EV for each
 * action it can take there, and its average strategy.
 */

import { ActionKind, COMBO_CARDS, COMBOS, NodeKind } from '../../src/index.ts';
import type { SolveRun } from '../../src/index.ts';
import { rootEvs } from '../coarse-to-fine/measure.ts';
import type { RootEvs } from '../coarse-to-fine/measure.ts';

export { rootEvs, rootError, rangeEvs } from '../coarse-to-fine/measure.ts';
export type { RootEvs } from '../coarse-to-fine/measure.ts';

/** One opening decision: its actions, and per action each combination's EV and frequency. */
export interface Opening {
	readonly player: 0 | 1;
	/** 'check', or the bet as a pot fraction. */
	readonly actions: string[];
	/** [action][combo] EV in % of the starting pot, NaN outside the range. */
	readonly evs: number[][];
	/** [action][combo] average-strategy probability, NaN outside the range. */
	readonly probs: number[][];
	/** Each combination's reach at the decision. */
	readonly reach: number[];
}

/** Snapshot of everything measured. */
export interface Reading {
	readonly root: RootEvs;
	readonly openings: [Opening, Opening];
}

/** Times each matchup is dealt from a flop root: every turn and river card. */
export function deals(run: SolveRun): number {
	const { runouts } = run.spot;
	let count = 1;
	for (let round = 1; round < runouts.rounds; round++) count *= 52 - 4 - runouts.width[round - 1];
	return count;
}

/** Opponent mass each combination can be dealt against, by inclusion-exclusion. */
export function openMass(theirs: Float64Array): Float64Array {
	const card = new Float64Array(52);
	let total = 0;
	for (let h = 0; h < COMBOS; h++) {
		total += theirs[h];
		card[COMBO_CARDS[h * 2]] += theirs[h];
		card[COMBO_CARDS[h * 2 + 1]] += theirs[h];
	}
	const out = new Float64Array(COMBOS);
	for (let h = 0; h < COMBOS; h++) out[h] = total - card[COMBO_CARDS[h * 2]] - card[COMBO_CARDS[h * 2 + 1]] + theirs[h];
	return out;
}

/** The edge of `node` with `kind`. */
export function edgeOf(run: SolveRun, node: number, kind: number): number {
	const { tree } = run.spot;
	for (let e = 0; e < tree.numEdges[node]; e++) if (tree.edgeAction[tree.firstEdge[node] + e] === kind) return tree.firstEdge[node] + e;
	throw new Error(`node ${node} has no action ${kind}`);
}

/** Label of an opening action: 'check', or the bet as a fraction of the pot. */
export function openingLabel(run: SolveRun, node: number, edge: number): string {
	const { tree } = run.spot;
	const kind = tree.edgeAction[edge];
	if (kind === ActionKind.Check) return 'check';
	if (kind === ActionKind.AllIn) return 'allin';
	return ((tree.edgeTarget[edge] - (tree.pot[node] - run.spot.potUnits) / 2) / tree.pot[node]).toFixed(2);
}

function opening(run: SolveRun, node: number): Opening {
	const { tree, potUnits, chipScale } = run.spot;
	const solution = run.snapshot();
	const player = tree.player[node] as 0 | 1;
	const me = solution.reachAt(node, 0, player);
	const opp = solution.reachAt(node, 0, (1 - player) as 0 | 1);
	const mass = openMass(opp);
	const scale = deals(run) * (potUnits / chipScale);
	const view = solution.strategyAt(node, 0);
	const slot = new Int32Array(COMBOS).fill(-1);
	view.combos.forEach((combo, i) => (slot[combo] = i));
	const actions: string[] = [];
	const evs: number[][] = [];
	const probs: number[][] = [];
	for (let a = 0; a < tree.numEdges[node]; a++) {
		const edge = tree.firstEdge[node] + a;
		actions.push(openingLabel(run, node, edge));
		const values = run.solver.valuesAt(tree.edgeChild[edge], 0, player, me, opp, run.solver.rootLive, run.solver.rootCount);
		const ev = new Array<number>(COMBOS).fill(NaN);
		const p = new Array<number>(COMBOS).fill(NaN);
		for (let h = 0; h < COMBOS; h++) {
			if (!(me[h] > 0) || slot[h] < 0) continue;
			if (mass[h] > 0) ev[h] = (100 * values[h]) / (mass[h] * scale);
			p[h] = view.probs[slot[h] * view.actions.length + a];
		}
		evs.push(ev);
		probs.push(p);
	}
	return { player, actions, evs, probs, reach: Array.from(me) };
}

/** OOP's root and IP's decision after OOP checks. */
export function openingNodes(run: SolveRun): [number, number] {
	const { tree } = run.spot;
	if (tree.kind[0] !== NodeKind.Decision) throw new Error('root is not a decision');
	return [0, tree.edgeChild[edgeOf(run, 0, ActionKind.Check)]];
}

export function read(run: SolveRun): Reading {
	const [a, b] = openingNodes(run);
	return { root: rootEvs(run), openings: [opening(run, a), opening(run, b)] };
}
