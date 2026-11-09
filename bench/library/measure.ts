/**
 * Shared measurement for the flop-library experiment (#30): per-combination
 * root EVs, their errors against a reference, and convergence traces.
 */

import { COMBO_CARDS, COMBOS, comboIndex } from '../../src/cards.ts';
import type { SolveRun, Solution, Spot } from '../../src/index.ts';
import { rankSwap } from '../../src/runouts.ts';

export const RANKS = '23456789TJQKA';
export const REFERENCE_PERCENT = 0.1;
export const CHECK_EVERY = 4;
export const MAX_ITERATIONS = 400;
export const STOP_PERCENT = 0.25;
export const TARGETS = [1, 0.5, 0.3] as const;
export const THREADS = 4;

/** Root EV of every combination for one player, chips per hand, and its weight. */
export interface ComboEv {
	/** Indexed by combination; NaN outside the range. */
	readonly ev: Float64Array;
	/** Range weight times the opposing weight it can face: how much it counts. */
	readonly mass: Float64Array;
	/** The player's own range weight, for the 1% reach floor. */
	readonly weight: Float64Array;
	readonly rangeEv: number;
}

/**
 * Per-combination root EV under whatever strategy the solver holds (average
 * strategy, falling back to the regret-matched one where no sums exist).
 * The opponent's range is `against`'s, by default the spot's own; values are
 * linear in it, so this is also the reweighted average of every per-matchup
 * value a library would store.
 */
export function comboEvs(spot: Spot, solver: Solution['solver'], player: 0 | 1, against: Spot = spot): ComboEv {
	const me = new Float64Array(COMBOS);
	const opp = new Float64Array(COMBOS);
	const own = spot.players[player];
	const other = against.players[1 - player];
	for (let i = 0; i < own.count; i++) me[own.combos[i]] = own.weights[own.combos[i]];
	for (let i = 0; i < other.count; i++) opp[other.combos[i]] = other.weights[other.combos[i]];
	const values = solver.valuesAt(0, 0, player, me, opp, solver.rootLive, solver.rootCount);
	const runoutWeight = solver.ctx.runoutWeight[0];
	const ev = new Float64Array(COMBOS).fill(Number.NaN);
	const mass = new Float64Array(COMBOS);
	const weight = new Float64Array(COMBOS);
	let total = 0;
	let totalMass = 0;
	for (let i = 0; i < own.count; i++) {
		const combo = own.combos[i];
		const a = COMBO_CARDS[combo * 2];
		const b = COMBO_CARDS[combo * 2 + 1];
		let facing = 0;
		for (let j = 0; j < other.count; j++) {
			const h = other.combos[j];
			const c = COMBO_CARDS[h * 2];
			const d = COMBO_CARDS[h * 2 + 1];
			if (c !== a && c !== b && d !== a && d !== b) facing += opp[h];
		}
		if (facing <= 0) continue;
		ev[combo] = values[combo] / (facing * runoutWeight);
		mass[combo] = me[combo] * facing;
		weight[combo] = me[combo];
		total += mass[combo] * ev[combo];
		totalMass += mass[combo];
	}
	return { ev, mass, weight, rangeEv: total / totalMass };
}

/** Relabel a neighbour's EVs onto the target's combinations; misses take the range EV. */
export function relabel(source: ComboEv, target: ComboEv, cards: Uint8Array): { evs: ComboEv; coverage: number } {
	const ev = new Float64Array(COMBOS).fill(Number.NaN);
	let covered = 0;
	let all = 0;
	for (let combo = 0; combo < COMBOS; combo++) {
		if (!(target.mass[combo] > 0)) continue;
		const image = comboIndex(cards[COMBO_CARDS[combo * 2]], cards[COMBO_CARDS[combo * 2 + 1]]);
		const value = source.ev[image];
		all += target.mass[combo];
		if (Number.isNaN(value)) {
			ev[combo] = source.rangeEv;
		} else {
			ev[combo] = value;
			covered += target.mass[combo];
		}
	}
	let total = 0;
	let mass = 0;
	for (let combo = 0; combo < COMBOS; combo++) {
		if (!(target.mass[combo] > 0)) continue;
		total += target.mass[combo] * ev[combo];
		mass += target.mass[combo];
	}
	return { evs: { ev, mass: target.mass, weight: target.weight, rangeEv: total / mass }, coverage: covered / all };
}

export interface EvError {
	/** Range-weighted mean absolute error per combination, % of pot. */
	mae: number;
	/** Largest error over combinations with at least 1% reach, % of pot. */
	max: number;
	/** Error of the range EV, % of pot. */
	range: number;
}

export function evError(estimate: ComboEv, reference: ComboEv, pot: number): EvError {
	let sum = 0;
	let mass = 0;
	let max = 0;
	for (let combo = 0; combo < COMBOS; combo++) {
		const m = reference.mass[combo];
		if (!(m > 0)) continue;
		const error = Math.abs(estimate.ev[combo] - reference.ev[combo]);
		sum += m * error;
		mass += m;
		if (reference.weight[combo] >= 0.01 && error > max) max = error;
	}
	const scale = 100 / pot;
	return { mae: (sum / mass) * scale, max: max * scale, range: Math.abs(estimate.rangeEv - reference.rangeEv) * scale };
}

/** The card relabelling for a rank swap, as `warmCards` takes it. */
export function swapCards(swap: readonly [string, string]): Uint8Array {
	return rankSwap(RANKS.indexOf(swap[0]), RANKS.indexOf(swap[1]));
}

export interface Checkpoint {
	iterations: number;
	/** Solve time so far, checks excluded. */
	ms: number;
	exploitability: number;
	error: [EvError, EvError];
}

export interface Trace {
	label: string;
	/** Time spent seeding the run, before its first iteration. */
	setupMs: number;
	checkpoints: Checkpoint[];
	reached: Record<string, { iterations: number; ms: number } | null>;
}

export function trace(label: string, spot: Spot, make: () => SolveRun, reference: [ComboEv, ComboEv], pot: number): Trace {
	const started = performance.now();
	const run = make();
	const setupMs = performance.now() - started;
	const checkpoints: Checkpoint[] = [];
	const reached: Trace['reached'] = {};
	for (const target of TARGETS) reached[String(target)] = null;
	let ms = 0;
	const record = (): number => {
		const exploitability = run.exploitabilityPercent();
		const error: [EvError, EvError] = [0, 1].map((player) =>
			evError(comboEvs(spot, run.solver, player as 0 | 1), reference[player], pot),
		) as [EvError, EvError];
		checkpoints.push({ iterations: run.completed, ms, exploitability, error });
		for (const target of TARGETS) {
			if (reached[String(target)] === null && exploitability <= target) {
				reached[String(target)] = { iterations: run.completed, ms };
			}
		}
		process.stdout.write(
			`  ${label.padEnd(22)} it ${String(run.completed).padStart(4)}  ${(ms / 1000).toFixed(1).padStart(6)} s  ` +
				`expl ${exploitability.toFixed(3).padStart(7)}%  MAE ${error[0].mae.toFixed(3)} / ${error[1].mae.toFixed(3)}\n`,
		);
		return exploitability;
	};
	record();
	while (run.completed < MAX_ITERATIONS) {
		const at = performance.now();
		run.step(CHECK_EVERY);
		ms += performance.now() - at;
		if (record() <= STOP_PERCENT) break;
	}
	run.close();
	return { label, setupMs, checkpoints, reached };
}

/** Zero the regrets of every decision from round `from` on, as if never seeded. */
export function forget(ctx: Solution['solver']['ctx'], from: number): void {
	const { tree, layout, active } = ctx;
	for (const node of tree.decisionNodes) {
		const round = tree.round[node];
		if (round < from) continue;
		const actions = tree.numEdges[node];
		const owner = tree.player[node];
		for (let board = 0; board < ctx.runouts.counts[round]; board++) {
			const slot = (active.roundBase[round] + board) * 2 + owner;
			const base = layout.offset[node] + actions * layout.rowStart[slot];
			ctx.regret.fill(0, base, base + actions * active.count[slot]);
		}
	}
}

export function evsOf(spot: Spot, solution: Solution): [ComboEv, ComboEv] {
	return [comboEvs(spot, solution.solver, 0), comboEvs(spot, solution.solver, 1)];
}

export const fmt = (e: EvError): string => `${e.mae.toFixed(3)} / ${e.max.toFixed(2)} / ${e.range.toFixed(3)}`;
