/**
 * A stopping rule for solves that never reach an exploitability target: stop
 * once the root play stops moving (issue #100).
 *
 * Purpose: a blueprint with `shareHistories` plateaus several percent of the
 * pot from equilibrium, so `targetPercent` cannot end it, yet its first
 * decisions go on settling and are what a caller reads (issue #85). This
 * reads them cheaply: the average strategy at two nodes, with no
 * best-response pass, so a check costs a tiny fraction of an iteration.
 *
 * The root play is the decision opening the spot (out of position) and, after
 * a check there, in position's: neither player has acted before them, so each
 * decision is played by the whole range and is weighted by it. Its movement
 * between two strategies is, per decision, the total variation of each hand's
 * action mix (half the summed absolute change), averaged over the range by
 * weight; the larger of the two decisions counts. 0.01 means the range's
 * play moved by 1% of its mass. #85 called the root play still once both
 * decisions moved under 1% between checks 20 iterations apart.
 */

import type { Solution, StrategyView } from './index.ts';
import { ActionKind, NodeKind } from './tree.ts';

/** See `SolveOptions.settle`. */
export interface SettleOptions {
	/** Iterations between checks. Default 20. */
	readonly every?: number;
	/**
	 * Movement between consecutive checks, as a share of the range, under
	 * which the root play counts as still: see `rootPlayMovement`. Default
	 * 0.01.
	 */
	readonly tolerance?: number;
	/** Consecutive still checks before stopping. Default 2. */
	readonly patience?: number;
	/** Iterations before the first check counts. Default 0. */
	readonly minIterations?: number;
}

/** The strategies `rootPlayMovement` compares; see `rootPlay`. */
export interface RootPlay {
	/** The root, then in position's decision after a check there, when there is one. */
	readonly views: readonly StrategyView[];
	/** Range weight per combination of each view's player, indexed like `COMBO_CARDS`. */
	readonly weights: readonly Float64Array[];
}

/** The decisions that make up the root play of a solved spot. */
export function rootPlayNodes(solution: Solution): number[] {
	const { tree } = solution.spot;
	if (tree.kind[0] !== NodeKind.Decision) return [];
	const nodes = [0];
	for (let e = 0; e < tree.numEdges[0]; e++) {
		const edge = tree.firstEdge[0] + e;
		const child = tree.edgeChild[edge];
		if (tree.edgeAction[edge] === ActionKind.Check && tree.kind[child] === NodeKind.Decision) nodes.push(child);
	}
	return nodes;
}

/**
 * The root play of a solution as it stands: the average strategy at the
 * root and at in position's decision after a check. Cheap: two strategy
 * reads, no best-response pass.
 */
export function rootPlay(solution: Solution): RootPlay {
	const views = rootPlayNodes(solution).map((node) => solution.strategyAt(node, 0));
	return { views, weights: views.map((view) => solution.spot.players[view.player].weights) };
}

/**
 * How far the root play moved from `before` to `after`, two readings of the
 * same spot: per decision, the range-weighted mean of each hand's total
 * variation, and the larger over the decisions. 0 is unmoved, 1 is every
 * hand switching to actions it never took.
 */
export function rootPlayMovement(before: RootPlay, after: RootPlay): number {
	if (before.views.length !== after.views.length) throw new Error('Root plays of different spots cannot be compared');
	let worst = 0;
	for (let d = 0; d < after.views.length; d++) {
		const a = before.views[d];
		const b = after.views[d];
		const actions = b.actions.length;
		if (a.node !== b.node || a.actions.length !== actions || a.combos.length !== b.combos.length) {
			throw new Error('Root plays of different spots cannot be compared');
		}
		const weights = after.weights[d];
		let moved = 0;
		let mass = 0;
		for (let i = 0; i < b.combos.length; i++) {
			const w = weights[b.combos[i]];
			if (!(w > 0)) continue;
			let tv = 0;
			for (let k = 0; k < actions; k++) tv += Math.abs(b.probs[i * actions + k] - a.probs[i * actions + k]);
			moved += (w * tv) / 2;
			mass += w;
		}
		if (mass > 0) worst = Math.max(worst, moved / mass);
	}
	return worst;
}

/** Validated settle settings, defaults filled in. */
export function settlePlan(options: SettleOptions): Required<SettleOptions> {
	const plan = {
		every: options.every ?? 20,
		tolerance: options.tolerance ?? 0.01,
		patience: options.patience ?? 2,
		minIterations: options.minIterations ?? 0,
	};
	if (!(Number.isInteger(plan.every) && plan.every > 0)) throw new Error(`settle.every must be a positive whole number; got ${plan.every}`);
	if (!(plan.tolerance >= 0)) throw new Error(`settle.tolerance must be 0 or more; got ${plan.tolerance}`);
	if (!(Number.isInteger(plan.patience) && plan.patience > 0)) {
		throw new Error(`settle.patience must be a positive whole number; got ${plan.patience}`);
	}
	if (!(plan.minIterations >= 0)) throw new Error(`settle.minIterations must be 0 or more; got ${plan.minIterations}`);
	return plan;
}

/**
 * A running settle check for a caller that steps a run itself. Feed it a
 * snapshot after each `every` iterations; it says when the root play has
 * stayed still for `patience` checks in a row.
 */
export interface SettleTracker {
	/** Record a snapshot taken after `iterations` in all; true once settled. */
	check(solution: Solution, iterations: number): boolean;
	/** Movement at the last check, or NaN before the second. */
	readonly movement: number;
	/** Whether the last check settled it. */
	readonly settled: boolean;
}

/** Start a settle check; see `SettleTracker`. */
export function trackSettle(options: SettleOptions = {}): SettleTracker {
	const plan = settlePlan(options);
	let previous: RootPlay | null = null;
	let still = 0;
	let movement = Number.NaN;
	let settled = false;
	return {
		check(solution, iterations) {
			const play = rootPlay(solution);
			movement = previous ? rootPlayMovement(previous, play) : Number.NaN;
			previous = play;
			still = movement <= plan.tolerance ? still + 1 : 0;
			settled = still >= plan.patience && iterations >= plan.minIterations;
			return settled;
		},
		get movement() {
			return movement;
		},
		get settled() {
			return settled;
		},
	};
}
