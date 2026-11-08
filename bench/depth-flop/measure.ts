/**
 * Root EVs for issue #48: per combination for both players, and per
 * combination for each of the out-of-position player's root actions.
 */

import { COMBO_CARDS, COMBOS } from '../../src/index.ts';
import type { Solver, Spot } from '../../src/index.ts';

/** Per-combination EV in % of pot, NaN outside the range. */
export type Evs = number[];

export interface RootReport {
	/** Root EV per combination, each player. */
	readonly evs: [Evs, Evs];
	/** The root's action labels, in edge order. */
	readonly actions: string[];
	/** The out-of-position player's EV per combination for taking each root action. */
	readonly actionEvs: Evs[];
}

/** Per-combination EV of `player` from `node`, both players' reach their full ranges. */
export function nodeEvs(spot: Spot, solver: Solver, node: number, player: 0 | 1): Evs {
	const pot = spot.potUnits / spot.chipScale;
	const mine = spot.players[player].weights;
	const theirs = spot.players[1 - player].weights;
	let deals = 1;
	for (let round = 1; round < spot.runouts.rounds; round++) deals *= 52 - 4 - spot.runouts.width[round - 1];
	const values = solver.valuesAt(node, 0, player, mine, theirs, solver.rootLive, solver.rootCount);
	const card = new Float64Array(52);
	let total = 0;
	for (let h = 0; h < COMBOS; h++) {
		total += theirs[h];
		card[COMBO_CARDS[h * 2]] += theirs[h];
		card[COMBO_CARDS[h * 2 + 1]] += theirs[h];
	}
	const ev = new Array<number>(COMBOS).fill(NaN);
	for (let h = 0; h < COMBOS; h++) {
		if (mine[h] === 0) continue;
		const open = total - card[COMBO_CARDS[h * 2]] - card[COMBO_CARDS[h * 2 + 1]] + theirs[h];
		if (open > 0) ev[h] = (100 * values[h]) / (open * deals) / pot;
	}
	return ev;
}

const LABELS = ['fold', 'check', 'call', 'bet', 'raise', 'allin'];

/** Root EVs of both players and of each out-of-position root action. */
export function rootReport(spot: Spot, solver: Solver): RootReport {
	const tree = spot.tree;
	const actions: string[] = [];
	const actionEvs: Evs[] = [];
	for (let e = 0; e < tree.numEdges[0]; e++) {
		const edge = tree.firstEdge[0] + e;
		const chips = (tree.edgeTarget[edge] / spot.chipScale).toFixed(1);
		actions.push(`${LABELS[tree.edgeAction[edge]]}${tree.edgeTarget[edge] > 0 ? ` ${chips}` : ''}`);
		actionEvs.push(nodeEvs(spot, solver, tree.edgeChild[edge], 0));
	}
	return { evs: [nodeEvs(spot, solver, 0, 0), nodeEvs(spot, solver, 0, 1)], actions, actionEvs };
}

/** Root-EV error of one player against a reference, in % of pot. */
export interface PlayerError {
	/** Range-weighted mean absolute error. */
	readonly mae: number;
	/** Largest error over combinations weighted at least 1%. */
	readonly max: number;
}

export function evError(evs: Evs, reference: Evs, weights: Float64Array): PlayerError {
	let sum = 0;
	let mass = 0;
	let max = 0;
	for (let h = 0; h < COMBOS; h++) {
		const w = weights[h];
		if (!(w > 0) || Number.isNaN(evs[h]) || Number.isNaN(reference[h])) continue;
		const gap = Math.abs(evs[h] - reference[h]);
		sum += w * gap;
		mass += w;
		if (w >= 0.01 && gap > max) max = gap;
	}
	return { mae: sum / mass, max };
}

/** How the out-of-position player's root bet sizes compare with the reference's. */
export interface SizeReport {
	/** Range-weighted MAE of each action's per-hand EV, in % of pot. */
	readonly actionMae: number[];
	/** Share of the range (by weight) whose best bet size, among the bets, matches the reference's. */
	readonly sizeAgreement: number;
	/** The same, among every root action including check. */
	readonly actionAgreement: number;
}

export function sizeReport(report: RootReport, reference: RootReport, weights: Float64Array): SizeReport {
	const actionMae = report.actionEvs.map((evs, a) => evError(evs, reference.actionEvs[a], weights).mae);
	const bets = report.actions.map((label, a) => (label.startsWith('bet') ? a : -1)).filter((a) => a >= 0);
	const all = report.actions.map((_, a) => a);
	const best = (evs: Evs[], among: number[], h: number): number => {
		let top = among[0];
		for (const a of among) if (evs[a][h] > evs[top][h]) top = a;
		return top;
	};
	let agree = 0;
	let agreeAll = 0;
	let mass = 0;
	for (let h = 0; h < COMBOS; h++) {
		const w = weights[h];
		if (!(w > 0) || Number.isNaN(reference.actionEvs[0][h])) continue;
		mass += w;
		if (best(report.actionEvs, bets, h) === best(reference.actionEvs, bets, h)) agree += w;
		if (best(report.actionEvs, all, h) === best(reference.actionEvs, all, h)) agreeAll += w;
	}
	return { actionMae, sizeAgreement: agree / mass, actionAgreement: agreeAll / mass };
}
