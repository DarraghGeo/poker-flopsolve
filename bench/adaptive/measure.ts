/**
 * Measurements for issue #51: per-combination root EVs and EVs of each root
 * action, how much each bet size is used and what it earns across the tree,
 * and errors against a reference.
 *
 * Everything reads a solved run through `Solver.valuesAt` on one thread, so
 * it works the same on a run solved with worker threads once they are closed.
 */

import { COMBO_CARDS, COMBOS } from '../../src/index.ts';
import type { SolveRun } from '../../src/index.ts';
import { boardAtRound } from '../../src/runouts.ts';
import { ActionKind, NodeKind } from '../../src/tree.ts';
import type { Tree } from '../../src/tree.ts';
import type { Runouts } from '../../src/runouts.ts';

/** Per-combination values of each player, in % of pot; NaN outside the range. */
export type ComboEvs = [number[], number[]];

/** How often a matchup is dealt over the runouts from the root. */
function rootDeals(run: SolveRun): number {
	let deals = 1;
	for (let round = 1; round < run.spot.runouts.rounds; round++) deals *= 52 - 4 - run.spot.runouts.width[round - 1];
	return deals;
}

/** Opponent mass each combination does not block, by inclusion-exclusion. */
function openMass(theirs: Float64Array): Float64Array {
	const card = new Float64Array(52);
	let total = 0;
	for (let h = 0; h < COMBOS; h++) {
		total += theirs[h];
		card[COMBO_CARDS[h * 2]] += theirs[h];
		card[COMBO_CARDS[h * 2 + 1]] += theirs[h];
	}
	const open = new Float64Array(COMBOS);
	for (let h = 0; h < COMBOS; h++) open[h] = total - card[COMBO_CARDS[h * 2]] - card[COMBO_CARDS[h * 2 + 1]] + theirs[h];
	return open;
}

/** Counterfactual values from `node` (a root-round node) to per-combination % of pot. */
function toPercent(run: SolveRun, values: Float64Array, player: 0 | 1): number[] {
	const { spot } = run;
	const pot = spot.potUnits / spot.chipScale;
	const mine = spot.players[player].weights;
	const open = openMass(spot.players[1 - player].weights);
	const deals = rootDeals(run);
	const ev = new Array<number>(COMBOS).fill(NaN);
	for (let h = 0; h < COMBOS; h++) {
		if (mine[h] === 0 || !(open[h] > 0)) continue;
		ev[h] = (100 * values[h]) / (open[h] * deals) / pot;
	}
	return ev;
}

/** Root EV of every combination under the average strategy, % of pot. */
export function rootEvs(run: SolveRun): ComboEvs {
	const { spot, solver } = run;
	const w = [spot.players[0].weights, spot.players[1].weights];
	return ([0, 1] as const).map((p) =>
		toPercent(run, solver.valuesAt(0, 0, p, w[p], w[1 - p], solver.rootLive, solver.rootCount), p),
	) as ComboEvs;
}

/**
 * EV of each root action for each of the root actor's combinations, % of pot:
 * what the hand wins taking that action and playing the average strategy after.
 * Keyed by the action's label (`bet 18.15`, `check`, ...).
 */
export function rootActionEvs(run: SolveRun): Record<string, number[]> {
	const { spot, solver } = run;
	const { tree } = spot;
	const w = [spot.players[0].weights, spot.players[1].weights];
	const out: Record<string, number[]> = {};
	for (let e = 0; e < tree.numEdges[0]; e++) {
		const edge = tree.firstEdge[0] + e;
		const values = solver.valuesAt(tree.edgeChild[edge], 0, 0, w[0], w[1], solver.rootLive, solver.rootCount);
		out[edgeLabel(tree, edge, spot.chipScale)] = toPercent(run, values, 0);
	}
	return out;
}

export function edgeLabel(tree: Tree, edge: number, chipScale: number): string {
	const kind = tree.edgeAction[edge];
	const names = ['fold', 'check', 'call', 'bet', 'raise', 'allin'];
	return kind >= ActionKind.Bet ? `${names[kind]} ${tree.edgeTarget[edge] / chipScale}` : names[kind];
}

/** Root-EV error of one player, in % of pot. */
export interface PlayerError {
	/** Range-weighted mean absolute error over combinations. */
	readonly mae: number;
	/** Largest error over combinations with weight at least 1%. */
	readonly max: number;
}

/**
 * Error of `evs` against `reference`, weighted by range weight times the
 * opponent mass a combination can face.
 */
export function comboError(evs: ComboEvs, reference: ComboEvs, run: SolveRun): [PlayerError, PlayerError] {
	const w = [run.spot.players[0].weights, run.spot.players[1].weights];
	return ([0, 1] as const).map((p) => {
		const open = openMass(w[1 - p]);
		let sum = 0;
		let mass = 0;
		let max = 0;
		for (let h = 0; h < COMBOS; h++) {
			const a = evs[p][h];
			const b = reference[p][h];
			if (!(w[p][h] > 0) || Number.isNaN(a) || Number.isNaN(b)) continue;
			const error = Math.abs(a - b);
			sum += w[p][h] * open[h] * error;
			mass += w[p][h] * open[h];
			if (w[p][h] >= 0.01 && error > max) max = error;
		}
		return { mae: sum / mass, max };
	}) as [PlayerError, PlayerError];
}

/** One action's row of the census. */
export interface CensusRow {
	readonly round: number;
	/** Aggressive actions already taken this round when the node is reached. */
	readonly aggressions: number;
	/** Aggressive actions on earlier rounds of the line. */
	readonly prior: number;
	readonly player: 0 | 1;
	/** 'bet', 'raise' or 'allin' — the census counts sized actions only. */
	readonly kind: string;
	/** Bets and raises: the amount added beyond a call, as a fraction of the pot after calling. */
	readonly fraction: number;
	/** Stack-to-pot ratio at the node, behind over the pot. */
	readonly spr: number;
	/** Probability the line reaches the node and takes the action, over the whole game. */
	readonly frequency: number;
	/**
	 * What the actor would lose, in % of pot over the whole game, if the
	 * action were removed and each hand took its best remaining action
	 * instead, everything else held fixed. A first-order measure of the
	 * EV the action contributes; never negative at an equilibrium.
	 */
	readonly evLoss: number;
	/** Slots below and at this action, the storage it costs. */
	readonly slots: number;
	readonly path: string;
}

/**
 * Per-node per-action usage and EV contribution under the average strategy.
 *
 * For every decision node and every stored board at its round, each player's
 * own reach comes from the strategy above (`reachAt`), and each action's
 * counterfactual values from a walk of its subtree (`valuesAt`). Boards a
 * stored one stands for under the spot's symmetries count as many times.
 *
 * @param maxRound census decisions up to this round only, to bound the cost
 */
export function census(run: SolveRun, maxRound = 2, onNode?: (done: number, total: number) => void): CensusRow[] {
	const { spot, solver } = run;
	const { tree, runouts } = spot;
	const solution = run.snapshot();
	const pot = spot.potUnits / spot.chipScale;
	const totalMass = solver.ctx.totalMass;
	const roundBoards = (r: number): number => {
		let n = 1;
		for (let k = 1; k <= r; k++) n *= 52 - runouts.width[k - 1];
		return n;
	};
	const deals = boardDeals(runouts);

	// Per node: investments, aggressions this round and before, and slots below.
	const info = new Map<number, { inv: [number, number]; agg: number; prior: number }>();
	const walk = (node: number, inv: [number, number], agg: number, prior: number): void => {
		const kind = tree.kind[node];
		if (kind === NodeKind.Chance) {
			walk(tree.edgeChild[tree.firstEdge[node]], inv, 0, prior + agg);
			return;
		}
		if (kind !== NodeKind.Decision) return;
		info.set(node, { inv, agg, prior });
		const me = tree.player[node];
		for (let e = 0; e < tree.numEdges[node]; e++) {
			const edge = tree.firstEdge[node] + e;
			const next: [number, number] = [...inv];
			next[me] = Math.max(inv[me], tree.edgeTarget[edge]);
			const aggressive = tree.edgeAction[edge] >= ActionKind.Bet;
			walk(tree.edgeChild[edge], next, aggressive ? agg + 1 : agg, prior);
		}
	};
	walk(0, [0, 0], 0, 0);
	const slotsBelow = subtreeSlots(run);

	const rows: CensusRow[] = [];
	const nodes = Array.from(tree.decisionNodes).filter((n) => tree.round[n] <= maxRound);
	let done = 0;
	for (const node of nodes) {
		onNode?.(done++, nodes.length);
		const round = tree.round[node];
		const owner = tree.player[node] as 0 | 1;
		const actions = tree.numEdges[node];
		const { inv, agg, prior } = info.get(node)!;
		const sized: number[] = [];
		for (let e = 0; e < actions; e++) if (tree.edgeAction[tree.firstEdge[node] + e] >= ActionKind.Bet) sized.push(e);
		if (sized.length === 0) continue;
		const frequency = new Float64Array(actions);
		const loss = new Float64Array(actions);
		for (let board = 0; board < runouts.counts[round]; board++) {
			const mine = solution.reachAt(node, board, owner);
			const theirs = solution.reachAt(node, board, (1 - owner) as 0 | 1);
			let mineMass = 0;
			let theirMass = 0;
			for (let h = 0; h < COMBOS; h++) {
				mineMass += mine[h];
				theirMass += theirs[h];
			}
			if (mineMass === 0 || theirMass === 0) continue;
			const { probs } = solver.averageStrategyAt(node, board);
			const index = spot.players[owner];
			const q: Float64Array[] = [];
			for (let e = 0; e < actions; e++) {
				q.push(solver.valuesAt(tree.edgeChild[tree.firstEdge[node] + e], board, owner, mine, theirs, solver.rootLive, solver.rootCount));
			}
			const weight = deals[round][board];
			for (const e of sized) {
				let used = 0;
				let lost = 0;
				for (let i = 0; i < index.count; i++) {
					const combo = index.combos[i];
					const p = mine[combo] * probs[i * actions + e];
					if (p === 0) continue;
					used += p;
					let alternative = -Infinity;
					for (let a = 0; a < actions; a++) if (a !== e && q[a][combo] > alternative) alternative = q[a][combo];
					lost += p * (q[e][combo] - alternative);
				}
				frequency[e] += (weight * used * theirMass) / roundBoards(round);
				loss[e] += weight * lost;
			}
		}
		const w0 = spot.players[0].weights.reduce((a, b) => a + b, 0);
		const w1 = spot.players[1].weights.reduce((a, b) => a + b, 0);
		const potHere = (spot.potUnits + inv[0] + inv[1]) / spot.chipScale;
		const behind = (spot.stackUnits - Math.max(inv[0], inv[1])) / spot.chipScale;
		for (const e of sized) {
			const edge = tree.firstEdge[node] + e;
			const owed = Math.max(0, inv[1 - owner] - inv[owner]);
			const added = tree.edgeTarget[edge] - inv[owner] - owed;
			rows.push({
				round,
				aggressions: agg,
				prior,
				player: owner,
				kind: ['fold', 'check', 'call', 'bet', 'raise', 'allin'][tree.edgeAction[edge]],
				fraction: added / (spot.potUnits + inv[0] + inv[1] + owed),
				spr: behind / potHere,
				frequency: frequency[e] / (w0 * w1),
				evLoss: (100 * loss[e]) / totalMass / pot,
				slots: slotsBelow.get(tree.edgeChild[edge])!,
				path: `${solution.path(node)} | ${edgeLabel(tree, edge, spot.chipScale)}`,
			});
		}
	}
	return rows;
}

/** Real deals each stored board stands for, per round: one each without symmetry. */
export function boardDeals(runouts: Runouts): Float64Array[] {
	const deals: Float64Array[] = [];
	for (let round = 0; round < runouts.rounds; round++) {
		const count = runouts.counts[round];
		const out = new Float64Array(count);
		for (let b = 0; b < count; b++) {
			const own = runouts.orbitStart[round][b + 1] - runouts.orbitStart[round][b];
			out[b] = round === 0 ? 1 : own * deals[round - 1][boardAtRound(runouts, b, round, round - 1)];
		}
		deals.push(out);
	}
	return deals;
}

/** Slots in the subtree below each node, its own block included. */
export function subtreeSlots(run: SolveRun): Map<number, number> {
	const { tree } = run.spot;
	const rows = rowsPerRoundPlayer(run);
	const out = new Map<number, number>();
	const visit = (node: number): number => {
		let total = 0;
		if (tree.kind[node] === NodeKind.Decision) total += tree.numEdges[node] * rows[tree.round[node]][tree.player[node]];
		for (let e = 0; e < tree.numEdges[node]; e++) total += visit(tree.edgeChild[tree.firstEdge[node] + e]);
		out.set(node, total);
		return total;
	};
	visit(0);
	return out;
}

/** Hand rows a block of each round and player has, summed over that round's stored boards. */
export function rowsPerRoundPlayer(run: SolveRun): number[][] {
	const { active, runouts } = run.solver.ctx;
	const rows: number[][] = [];
	for (let round = 0; round < runouts.rounds; round++) {
		const pair = [0, 0];
		for (let board = 0; board < runouts.counts[round]; board++) {
			for (const p of [0, 1]) pair[p] += active.count[(active.roundBase[round] + board) * 2 + p];
		}
		rows.push(pair);
	}
	return rows;
}
