/**
 * Shared by `bench/depth-limit.ts` in Node and in the browser: the spots, the
 * variants, and how a run is turned into per-combination root EVs. No Node
 * imports, so the browser bundle can take it whole.
 */

import { COMBO_CARDS, COMBOS, createRun, defineSpot, solve } from '../src/index.ts';
import type { Solver, Spot, SpotConfig } from '../src/index.ts';
import { SPOTS as COMPARE } from './compare/spots.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';

/**
 * The issue's spots: `flop` and `monotone` from bench/compare, and the wide
 * flop of the README's performance table (`bin/bench.ts`'s flop; the
 * README's 211 vs 203 count predates the current ranges).
 */
export const SPOTS: Record<string, SpotConfig> = {
	flop: COMPARE.flop,
	monotone: COMPARE.monotone,
	wide: { board: 'AsKh7d', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.66]], maxRaises: 1 },
};

/** Depth-limit settings tried, by name. */
export const VARIANTS: Record<string, SpotConfig['depthLimit']> = {
	'river k1': { continuations: ['checkdown'] },
	'river k2': { continuations: ['checkdown', 'polar'] },
	'river k4': { continuations: ['checkdown', 'polar', 'polar-bias', 'station'] },
	'river k4 halves': { continuations: ['checkdown', 'polar', 'station', 'halves'] },
	'turn k1': { at: 'turn', continuations: ['checkdown'] },
	'turn k4': { at: 'turn', continuations: ['checkdown', 'polar', 'polar-bias', 'station'] },
};

/** Per-combination root EV of each player, in chips, and the range EVs. */
export interface RootEv {
	readonly combos: [number[], number[]];
	readonly ev: [number[], number[]];
	readonly weight: [number[], number[]];
	readonly range: [number, number];
}

/** Root EVs under a run's average strategy. */
export function rootEv(run: { readonly solver: Solver; readonly spot: Spot }): RootEv {
	const { solver, spot } = run;
	const ctx = solver.ctx;
	const weights = [spot.players[0].weights, spot.players[1].weights];
	const out: RootEv = { combos: [[], []], ev: [[], []], weight: [[], []], range: [0, 0] };
	for (const player of [0, 1] as const) {
		const opp = weights[1 - player];
		const values = solver.valuesAt(0, 0, player, weights[player], opp, solver.rootLive, solver.rootCount);
		let total = 0;
		const index = spot.players[player];
		for (let i = 0; i < index.count; i++) {
			const combo = index.combos[i];
			const a = COMBO_CARDS[combo * 2];
			const b = COMBO_CARDS[combo * 2 + 1];
			let mass = 0;
			for (let other = 0; other < COMBOS; other++) {
				if (opp[other] === 0) continue;
				const c = COMBO_CARDS[other * 2];
				const d = COMBO_CARDS[other * 2 + 1];
				if (c === a || c === b || d === a || d === b) continue;
				mass += opp[other];
			}
			const value = values[combo];
			total += weights[player][combo] * value;
			out.combos[player].push(combo);
			out.weight[player].push(weights[player][combo]);
			out.ev[player].push(mass > 0 ? value / (mass * ctx.runoutWeight[0]) : 0);
		}
		out.range[player] = total / ctx.totalMass;
	}
	return out;
}

/** One measured solve. */
export interface Measured {
	readonly iterations: number;
	readonly seconds: number;
	readonly exploitability: number;
	readonly bytes: number;
	readonly result: RootEv;
}

/** Solve a depth-limited variant to `target` % of pot in its own game, or until `seconds`. */
export function measureLimited(config: SpotConfig, depthLimit: SpotConfig['depthLimit'], target: number, seconds: number): Measured {
	const spot = defineSpot({ ...config, depthLimit });
	const started = performance.now();
	const run = createRun(spot, {});
	let done = 0;
	let next = 10;
	let exploitability = Infinity;
	while ((performance.now() - started) / 1000 < seconds) {
		run.step(next - done);
		done = next;
		exploitability = run.exploitabilityPercent();
		if (exploitability <= target) break;
		next = Math.ceil(done * 1.3);
	}
	const elapsed = (performance.now() - started) / 1000;
	const result = rootEv(run);
	run.close();
	return { iterations: done, seconds: elapsed, exploitability, bytes: spot.estimate.bytes, result };
}

/** The exact solver stopped by time: as many iterations as fit in `seconds`. */
export function measureBaseline(config: SpotConfig, seconds: number): Measured {
	const spot = defineSpot(config);
	const started = performance.now();
	const run = createRun(spot, {});
	let done = 0;
	while ((performance.now() - started) / 1000 < seconds) {
		run.step(1);
		done++;
	}
	const elapsed = (performance.now() - started) / 1000;
	const exploitability = run.exploitabilityPercent();
	const result = rootEv(run);
	run.close();
	return { iterations: done, seconds: elapsed, exploitability, bytes: spot.estimate.bytes, result };
}

/** The reference: an exact solve to `target` % of pot. */
export function measureReference(config: SpotConfig, target: number, workers: number): Measured {
	const spot = defineSpot(config);
	const started = performance.now();
	const solution = solve(spot, { targetPercent: target, iterations: 3000, workers });
	const elapsed = (performance.now() - started) / 1000;
	const result = rootEv(solution);
	return {
		iterations: solution.iterations, seconds: elapsed, exploitability: solution.exploitabilityPercent(),
		bytes: spot.estimate.bytes, result,
	};
}

/** Errors against a reference, in % of pot. */
export interface Errors {
	/** Range-weighted mean absolute per-combination error, per player. */
	readonly mae: [number, number];
	/** Largest per-combination error over combinations weighted at least 1%. */
	readonly max: [number, number];
	/** Error of the range-level EV. */
	readonly range: [number, number];
	/** Range-weighted mean absolute error by hand class on the first board. */
	readonly byClass: Record<string, [number, number]>;
}

/** Made hand (pair or better), draw (flush or straight draw) or air, on the spot's board. */
export function handClass(board: readonly number[], combo: number): 'made' | 'draw' | 'air' {
	const cards = [...board, COMBO_CARDS[combo * 2], COMBO_CARDS[combo * 2 + 1]];
	const ranks = cards.map((c) => c >> 2);
	const suits = cards.map((c) => c & 3);
	const hole = ranks.slice(board.length);
	const boardRanks = ranks.slice(0, board.length);
	if (hole[0] === hole[1] || hole.some((r) => boardRanks.includes(r))) return 'made';
	for (let s = 0; s < 4; s++) if (suits.filter((x) => x === s).length >= 4) return 'draw';
	const present = new Set(ranks.flatMap((r) => (r === 12 ? [r, -1] : [r])));
	for (let low = -1; low <= 8; low++) {
		let have = 0;
		for (let r = low; r < low + 5; r++) if (present.has(r)) have++;
		if (have >= 4) return 'draw';
	}
	return 'air';
}

export function errors(board: readonly number[], pot: number, got: RootEv, ref: RootEv): Errors {
	const out: Errors = { mae: [0, 0], max: [0, 0], range: [0, 0], byClass: {} };
	const sums: Record<string, [number, number, number, number]> = {};
	for (const player of [0, 1] as const) {
		const at = new Map(ref.combos[player].map((combo, i) => [combo, i]));
		let weighted = 0;
		let weight = 0;
		for (let i = 0; i < got.combos[player].length; i++) {
			const j = at.get(got.combos[player][i])!;
			const error = (100 * Math.abs(got.ev[player][i] - ref.ev[player][j])) / pot;
			const w = got.weight[player][i];
			weighted += w * error;
			weight += w;
			if (w >= 0.01 && error > out.max[player]) out.max[player] = error;
			const kind = handClass(board, got.combos[player][i]);
			sums[kind] ??= [0, 0, 0, 0];
			sums[kind][player * 2] += w * error;
			sums[kind][player * 2 + 1] += w;
		}
		out.mae[player] = weighted / weight;
		out.range[player] = (100 * Math.abs(got.range[player] - ref.range[player])) / pot;
	}
	for (const [kind, s] of Object.entries(sums)) out.byClass[kind] = [s[0] / (s[1] || 1), s[2] / (s[3] || 1)];
	return out;
}
