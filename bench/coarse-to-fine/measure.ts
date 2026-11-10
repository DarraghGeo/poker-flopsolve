/**
 * Root-EV accuracy against wall clock, for a cold solve and a coarse-to-fine
 * one (issue #24).
 *
 * Purpose: the measurement shared by the Node and browser runs of
 * `bench/coarse-to-fine/run.ts`. Plain functions over the public API, so the
 * same file bundles into the browser harness unchanged.
 *
 * A schedule solves a coarser version of the spot for part of the budget, then
 * warm-starts the real spot from it and solves that for the rest. The clock
 * counts solving only: building each run, the warm start and every iteration.
 * The EV and exploitability checks taken along the way are paused out.
 */

import { COMBO_CARDS, COMBOS, createRun, defineSpot } from '../../src/index.ts';
import type { CoarseStart, SolveRun, SpotConfig } from '../../src/index.ts';
import { warmStart } from '../../src/warm.ts';

/** Per-combination root EV of each player, in % of pot; NaN outside the range. */
export type RootEvs = [number[], number[]];

/** Root-EV error of one player, in % of pot. */
export interface PlayerError {
	/** Range-weighted mean absolute error over combinations. */
	readonly mae: number;
	/** Largest error over combinations with weight at least 1%. */
	readonly max: number;
	/** Error of the range-level EV. */
	readonly range: number;
}

/**
 * Root EV of every combination under the current average strategy.
 *
 * `valuesAt` gives counterfactual values; dividing by the opponent's mass the
 * combination does not block (times the runouts each matchup is dealt over)
 * gives chips per hand. Weighted by that same mass these average back to
 * `Solution.evChips` exactly.
 */
export function rootEvs(run: SolveRun): RootEvs {
	const { spot, solver } = run;
	const pot = spot.potUnits / spot.chipScale;
	const weights = [spot.players[0].weights, spot.players[1].weights];
	// Every runout from the root deals each matchup this many times.
	let deals = 1;
	for (let round = 1; round < spot.runouts.rounds; round++) deals *= 52 - 4 - spot.runouts.width[round - 1];
	const out: RootEvs = [[], []];
	for (const player of [0, 1] as const) {
		const mine = weights[player];
		const theirs = weights[1 - player];
		const values = solver.valuesAt(0, 0, player, mine, theirs, solver.rootLive, solver.rootCount);
		// Opponent mass not blocked by each combination, by inclusion-exclusion.
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
		out[player] = ev;
	}
	return out;
}

/** The range-level EV of each player, in % of pot, from per-combination EVs. */
export function rangeEvs(evs: RootEvs, run: SolveRun): [number, number] {
	const weights = [run.spot.players[0].weights, run.spot.players[1].weights];
	const out: [number, number] = [0, 0];
	for (const player of [0, 1] as const) {
		const mine = weights[player];
		const theirs = weights[1 - player];
		const card = new Float64Array(52);
		let total = 0;
		for (let h = 0; h < COMBOS; h++) {
			total += theirs[h];
			card[COMBO_CARDS[h * 2]] += theirs[h];
			card[COMBO_CARDS[h * 2 + 1]] += theirs[h];
		}
		let sum = 0;
		let mass = 0;
		for (let h = 0; h < COMBOS; h++) {
			if (!(mine[h] > 0) || Number.isNaN(evs[player][h])) continue;
			const open = total - card[COMBO_CARDS[h * 2]] - card[COMBO_CARDS[h * 2 + 1]] + theirs[h];
			sum += mine[h] * open * evs[player][h];
			mass += mine[h] * open;
		}
		out[player] = sum / mass;
	}
	return out;
}

/** Error of `evs` against `reference`, both from runs of the same spot. */
export function rootError(evs: RootEvs, reference: RootEvs, run: SolveRun): [PlayerError, PlayerError] {
	const weights = [run.spot.players[0].weights, run.spot.players[1].weights];
	const ranges = rangeEvs(evs, run);
	const refRanges = rangeEvs(reference, run);
	return ([0, 1] as const).map((player) => {
		let sum = 0;
		let mass = 0;
		let max = 0;
		for (let h = 0; h < COMBOS; h++) {
			const w = weights[player][h];
			const a = evs[player][h];
			const b = reference[player][h];
			if (!(w > 0) || Number.isNaN(a) || Number.isNaN(b)) continue;
			const gap = Math.abs(a - b);
			sum += w * gap;
			mass += w;
			if (w >= 0.01 && gap > max) max = gap;
		}
		return { mae: sum / mass, max, range: Math.abs(ranges[player] - refRanges[player]) };
	}) as [PlayerError, PlayerError];
}

/** A coarse-to-fine schedule; no `coarse` is a cold solve. */
export interface Schedule {
	readonly name: string;
	/** Overrides that make the coarse spot, e.g. `{ runoutBuckets: 12 }`. */
	readonly coarse?: Partial<SpotConfig>;
	/** Share of the budget the coarse stage gets. */
	readonly split?: number;
	/** `warmIteration` of the fine stage; unset, the coarse run's own count. */
	readonly warmIteration?: number;
	/** Carry the coarse average strategy over too, not only the regrets. */
	readonly averages?: boolean;
	/** Instead of the above: the shipped option, `approximations.coarseStart`. */
	readonly coarseStart?: CoarseStart;
}

/** One checkpoint of a timed solve. */
export interface Sample {
	readonly ms: number;
	readonly stage: 'coarse' | 'fine';
	readonly iterations: number;
	/** Exploitability of the run measured, in its own game. */
	readonly exploitability: number;
	readonly error: [PlayerError, PlayerError];
}

/**
 * Solve `config` under `schedule` for `budgetMs` of solving time, measuring
 * root-EV error at each of `checkpoints` (ms, ascending).
 *
 * Checkpoints in the coarse stage measure the coarse run, whose answer is an
 * EV estimate too; the error is still taken against the real spot.
 */
export function timedSolve(
	config: SpotConfig,
	schedule: Schedule,
	budgetMs: number,
	checkpoints: readonly number[],
	reference: RootEvs,
): Sample[] {
	const samples: Sample[] = [];
	let clock = 0;
	let next = 0;
	const timed = <T>(work: () => T): T => {
		const started = performance.now();
		const value = work();
		clock += performance.now() - started;
		return value;
	};
	// Measured, paused out of the clock.
	const measureAgainst = (run: SolveRun, stage: 'coarse' | 'fine', iterations: number): void => {
		const evs = rootEvs(run);
		samples.push({
			ms: Math.round(clock),
			stage,
			iterations,
			exploitability: run.exploitabilityPercent(),
			error: rootError(evs, reference, run),
		});
	};
	const runFor = (run: SolveRun, until: number, stage: 'coarse' | 'fine', counted: () => number): void => {
		while (clock < until) {
			timed(() => run.step(1));
			while (next < checkpoints.length && clock >= checkpoints[next]) {
				measureAgainst(run, stage, counted());
				next++;
			}
		}
	};

	let fineFrom: SolveRun | undefined;
	let coarseIterations = 0;
	if (schedule.coarse) {
		const coarse = timed(() => createRun(defineSpot({ ...config, ...schedule.coarse }), { workers: 1 }));
		runFor(coarse, budgetMs * (schedule.split ?? 0.25), 'coarse', () => coarse.completed);
		coarseIterations = coarse.completed;
		fineFrom = coarse;
	}
	const fine = timed(() =>
		createRun(defineSpot(config), {
			workers: 1,
			warmStart: fineFrom,
			warmIteration: fineFrom ? schedule.warmIteration : undefined,
			approximations: schedule.coarseStart ? { coarseStart: schedule.coarseStart } : undefined,
		}),
	);
	if (schedule.coarseStart) coarseIterations = fine.totalIterations - fine.completed;
	if (fineFrom && schedule.averages) timed(() => warmStart(fine.solver.ctx, fineFrom.solver.ctx, true));
	fineFrom?.close();
	runFor(fine, budgetMs, 'fine', () => coarseIterations + fine.completed);
	fine.close();
	return samples;
}
