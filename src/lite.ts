/**
 * Lite mode (issue #100): one opt-in that turns the caller's betting into the
 * phone/laptop blueprint issue #85 measured, solves it until its root play
 * settles, and re-solves later streets at the caller's full betting on demand.
 *
 * Purpose: the recipe needs a dozen settings — the flop betting kept, one
 * size on the turn and river, `shareHistories`, `runoutBuckets`,
 * `chanceSampling`, a stop on the root play rather than on exploitability —
 * and callers should not have to assemble it. Nothing else in the package
 * calls this; unused, it changes nothing.
 *
 * What is measured, and what each default costs, is in `solveLite`'s notes.
 */

import { parseCards } from './cards.ts';
import type { SamplingOptions } from './cfr.ts';
import type { ShareHistories, Solution, SolveOptions, SpotConfig, SubgameBetting } from './index.ts';
import { defineSpot, solve } from './index.ts';
import type { ResolvedSubgame, ResolveOptions } from './resolve.ts';
import { resolveSubgame } from './resolve.ts';
import type { SettleOptions } from './settle.ts';
import type { BetSize, PerPlayer, RaiseSizes } from './tree.ts';
import { mapPlayers, perRound, raisesPerRound } from './tree.ts';

/** How `liteConfig` simplifies the caller's betting. */
export interface LiteOptions {
	/**
	 * The turn and river keep one bet size: the caller's pot-fraction size
	 * nearest this. Default 0.75.
	 */
	readonly laterSize?: number;
	/**
	 * Keep one raise on the turn and river, of the caller's raise size
	 * nearest `laterSize`. Default false: a bet and no raise, as issue #85
	 * measured. A raise nearly doubles the tree: on issue #47's rainbow
	 * betting 707 MiB unshared became 1375 (173 shared became 261), an
	 * iteration cost 1.74 times as much and Node peaked at 546 MiB.
	 */
	readonly laterRaise?: boolean;
	/**
	 * Cap the flop's aggressions, the opening bet the first. Default: the
	 * caller's. A speed trim, off by default: see `solveLite`'s notes for
	 * what it saved and cost.
	 */
	readonly flopMaxRaises?: number;
	/**
	 * Forbid donk bets on the turn and river (`SpotConfig.noDonk`). Default:
	 * the caller's setting. A speed trim, off by default: see `solveLite`'s
	 * notes for what it saved and cost.
	 */
	readonly noDonk?: boolean;
	/** `SpotConfig.runoutBuckets` for the blueprint. Default 3. */
	readonly runoutBuckets?: number;
	/** `SpotConfig.shareHistories` for the blueprint. Default true, the river. */
	readonly shareHistories?: boolean | ShareHistories;
}

/** Settings for {@link solveLite}. */
export interface SolveLiteOptions
	extends LiteOptions,
		Pick<SolveOptions, 'workers' | 'precision' | 'wasmStorage' | 'algorithm' | 'onProgress' | 'targetPercent'> {
	/** Iteration cap. Default 2000; the solve normally settles well before. */
	readonly iterations?: number;
	/** The stop on the root play (`SolveOptions.settle`); false to run to `iterations`. Default {}, its own defaults. */
	readonly settle?: SettleOptions | false;
	/**
	 * `Approximations.chanceSampling` for the blueprint, or false for none.
	 * Default {}: sampled at p 0.35, on `workers` threads.
	 */
	readonly sampling?: SamplingOptions | false;
}

/** Settings for `LiteSolution.resolve`. */
export interface LiteResolveOptions extends Omit<ResolveOptions, 'betting'> {
	/** Overrides on the caller's own betting for the subgame. */
	readonly betting?: SubgameBetting;
}

/** What {@link solveLite} returns. */
export interface LiteSolution {
	/** The blueprint's solution. */
	readonly solution: Solution;
	/** The blueprint spot that was solved (`liteConfig`'s). */
	readonly blueprint: SpotConfig;
	/** The caller's spot, full betting. */
	readonly source: SpotConfig;
	/**
	 * Re-solve the subgame at a node opening the turn or river, at the
	 * caller's full betting for the streets from there: `resolveSubgame`,
	 * 'unsafe' and 200 iterations unless `options` say otherwise, on the
	 * blueprint's thread count.
	 */
	resolve(node: number, board: number, options: LiteResolveOptions): ResolvedSubgame;
}

/**
 * The blueprint of `config`: its first round's betting as given, every later
 * round one bet size (the given size nearest `laterSize`) and, with
 * `laterRaise`, one raise; no shove offered after the first round; and
 * `shareHistories` and `runoutBuckets: 3`. Ranges, pot, stacks and everything
 * else carry over. Per-player betting is simplified side by side.
 *
 * Bet and raise cuts (`removeActions`) on the first round carry over; those
 * below a deal are dropped, as the later rounds' sizes no longer exist.
 */
export function liteConfig(config: SpotConfig, options: LiteOptions = {}): SpotConfig {
	const target = options.laterSize ?? 0.75;
	if (!(target > 0)) throw new Error(`laterSize must be above 0; got ${target}`);
	if (config.lineRunouts) throw new Error('lineRunouts does not combine with the lite blueprint, which shares histories');
	const rounds = 6 - parseCards(config.board).length;
	if (!(rounds >= 1 && rounds <= 3)) throw new Error(`A board has 3, 4 or 5 cards; got ${config.board}`);
	const flopCap = options.flopMaxRaises;
	if (flopCap !== undefined && !(Number.isInteger(flopCap) && flopCap >= 1)) {
		throw new Error(`flopMaxRaises must be a whole number of at least 1; got ${flopCap}`);
	}

	const betSizes = mapPlayers(config.betSizes, (rows) =>
		perRound(rows, true, rounds, 'betSizes').map((row, r) => (r === 0 ? row : nearest(row, target))),
	);
	// Unset raise sizes follow the bet sizes, which are already down to one.
	const raiseSizes =
		config.raiseSizes === undefined
			? undefined
			: mapPlayers(config.raiseSizes, (side: RaiseSizes | undefined): RaiseSizes | undefined =>
					side === undefined
						? undefined
						: raiseRows(side, rounds).map((row, r) => (r === 0 ? row : nearest(row, target))),
				);
	const maxRaises = mapPlayers(config.maxRaises ?? 1, (side) =>
		perRound(side, Array.isArray(side), rounds, 'maxRaises').map((n, r) =>
			r === 0 ? (flopCap === undefined ? n : Math.min(n, flopCap)) : Math.min(n, options.laterRaise ? 2 : 1),
		),
	);
	const allowAllIn = mapPlayers(config.allowAllIn ?? false, (side) =>
		perRound(side, Array.isArray(side), rounds, 'allowAllIn').map((on, r) => (r === 0 ? on : false)),
	);
	const removeActions = config.removeActions?.filter((line) => !line.includes('/'));
	const buckets = options.runoutBuckets ?? 3;
	const given = typeof config.runoutBuckets === 'number' ? config.runoutBuckets : config.runoutBuckets ? 1 : 0;
	return {
		...config,
		betSizes: betSizes as SpotConfig['betSizes'],
		...(raiseSizes === undefined ? {} : { raiseSizes: raiseSizes as SpotConfig['raiseSizes'] }),
		maxRaises: maxRaises as SpotConfig['maxRaises'],
		allowAllIn: allowAllIn as SpotConfig['allowAllIn'],
		...(options.noDonk === undefined ? {} : { noDonk: options.noDonk }),
		...(removeActions === undefined ? {} : { removeActions }),
		runoutBuckets: Math.max(buckets, given),
		shareHistories: options.shareHistories ?? true,
	};
}

/** Raise sizes as one row per round. */
function raiseRows(side: RaiseSizes, rounds: number): (readonly BetSize[])[] {
	return raisesPerRound(side)
		? perRound<readonly BetSize[]>(side, true, rounds, 'raiseSizes')
		: Array.from({ length: rounds }, () => side as readonly BetSize[]);
}

/** The one size of `row` nearest `target` pot: the nearest pot fraction, else the first size. */
function nearest(row: readonly BetSize[], target: number): BetSize[] {
	let best: BetSize | undefined;
	let gap = Infinity;
	for (const size of row) {
		if (typeof size !== 'number') continue;
		const g = Math.abs(Math.log(size / target));
		if (g < gap) {
			gap = g;
			best = size;
		}
	}
	if (best === undefined && row.length > 0) best = row[0];
	return best === undefined ? [] : [best];
}

/**
 * Solve `config`'s lite blueprint (`liteConfig`) until its root play settles,
 * and hand back a re-solver for later streets at the full betting.
 *
 * Defaults: `shareHistories` on the river, `runoutBuckets: 3`,
 * `chanceSampling` at p 0.35, and `settle` with its defaults (every 20
 * iterations, under 1% of the range moved, twice running).
 *
 * Measured (issue #100) on issue #47's betting (0.33 / 0.75 / 1.5 pot, a
 * 0.75 raise, all-in, three aggressions; pot 55, stack 975, the bench
 * ranges), so the blueprint plays 0.75 and no raise on the turn and river.
 * Headless Chromium, `poker-flopsolve/threads`; the clock counts solving
 * and the settle checks. Root play loss is the EV OOP's root mix and IP's
 * mix after a check lose at the unshared blueprint's per-action values
 * (solved to 0.05% of pot), % of pot, with that blueprint's own loss as the
 * floor; it measures what sharing, sampling and stopping early cost, not
 * distance to the full game. Re-solve gain is the opponent's best response
 * against a turn re-solved at the full betting (300 iterations, 'unsafe'),
 * under the unshared blueprint's ranges, % of the subgame's pot, weighted
 * over 3 lines × 3 turns by how often each is reached:
 *
 * | flop | settled | Chromium, 1 / 2 / 4 threads | peak RSS | root play loss (floor) | per-hand EV error | re-solve gain (unshared) | re-solve, 1 / 2 / 4 threads |
 * |---|---|---|---|---|---|---|---|
 * | As Kh 7d | 400 it | 103 / 59 / 35 s | 511 MiB | 0.023 / 0.014 (0.009 / 0.008) | 0.75 / 0.85 | 3.1 / 2.7 (0.67 / 0.50) | 38 / 22 / 14 s |
 * | Ts 9s 4h | 320 it | 64 / 38 / 21 s | 426 MiB | 0.118 / 0.076 (0.116 / 0.052) | 0.54 / 0.60 | 4.0 / 3.3 (0.48 / 0.55) | 42 / 23 / 13 s |
 * | Ks 9s 4s | 360 it | 31 / 19 / 12 s | 253 MiB | 0.059 / 0.037 (0.047 / 0.025) | 1.5 / 1.9 | 3.6 / 3.6 (0.44 / 0.47) | 28 / 17 / 10 s |
 *
 * Sampling runs on the threads (issue #99): the same iterations settle the
 * root on every count, within 0.002% of pot. Unsampled, the rainbow
 * blueprint took 473 ms an iteration on 4 threads in Node against 251
 * sampled on one, and settled later. Peak memory counts the page, the
 * blueprint and a re-solve; it is the most a phone must give. The rainbow root play's loss is
 * 0.014% of pot over its floor for OOP; `settle: { every: 40, tolerance:
 * 0.02, patience: 3 }` brings it to 0.009 in 120 s instead of 104 (Node).
 *
 * Against exact solves of the full game, which separate what the turn and
 * river simplification costs:
 * - issue #51's T₀ on As Kh 7d (0.33 / 0.75 / 1.5 on every street, all-in
 *   raises, two aggressions, solved to 0.22% of pot): OOP's root play lost
 *   0.072% of pot at T₀'s per-action values, the simplified blueprint
 *   unshared and solved to 0.04% lost 0.057; per-hand root EVs were 3.9 /
 *   2.9% of pot off, unshared 4.1 / 3.1. Simplifying is the cost; sharing,
 *   sampling and the stop add 0.015. T₀ stores no strategy, so there is no
 *   floor from its own play.
 * - napkinpoker's postflop-solver solves (issue #87; two flop sizes, 75% on
 *   the turn and river with 3× raises and all-in, weighted BU/CO/SB ranges,
 *   SRP and 3-bet pots, 0.3% of pot), 8 spots across textures, one thread in
 *   Node: root play lost 0.034 / 0.135% of pot on average at the stored
 *   per-action values, where the stored solve's own play lost 0.027 /
 *   0.131; settled in 38-176 s. Wide single-raised ranges took up to
 *   452 MiB of storage, near a browser's default `maxBytes` of 512: give it
 *   room, or `compactStorage` with `wasmStorage` (on rainbow, 300 MiB peak
 *   in Node against 411, 27% slower). `minWeight: 0.05` there cut 2-5% of
 *   storage and up to 15% of the time, root play unchanged; it edits the
 *   ranges, so it is the caller's to set.
 *
 * `laterRaise`'s cost is on it; the trims `flopMaxRaises` and `noDonk`, and
 * what was rejected, are in `Approximations`' notes in `index.ts`.
 */
export function solveLite(config: SpotConfig, options: SolveLiteOptions = {}): LiteSolution {
	const blueprint = liteConfig(config, options);
	const sampling = options.sampling === undefined ? {} : options.sampling;
	const settle = options.settle === undefined ? {} : options.settle;
	const solution = solve(defineSpot(blueprint), {
		iterations: options.iterations ?? 2000,
		...(settle ? { settle } : {}),
		...(sampling ? { approximations: { chanceSampling: sampling } } : {}),
		...pick(options, ['workers', 'precision', 'wasmStorage', 'algorithm', 'onProgress', 'targetPercent']),
	});
	const workers = options.workers;
	return {
		solution,
		blueprint,
		source: config,
		resolve(node, board, resolveOptions) {
			const round = solution.spot.tree.round[node];
			return resolveSubgame(solution, node, board, {
				...resolveOptions,
				betting: { ...bettingFrom(config, round), ...resolveOptions.betting },
				solve: { ...(workers === undefined ? {} : { workers }), ...resolveOptions.solve },
			});
		},
	};
}

/** Only the listed keys of `from` that are set. */
function pick<T extends object, K extends keyof T>(from: T, keys: readonly K[]): Partial<Pick<T, K>> {
	const out: Partial<Pick<T, K>> = {};
	for (const key of keys) if (from[key] !== undefined) out[key] = from[key];
	return out;
}

/**
 * `config`'s tree-shaping betting for a subgame opening round `round`: each
 * setting given per round loses the rounds before it, as
 * `Solution.subgameAt` does with the spot's own.
 */
export function bettingFrom(config: SpotConfig, round: number): SubgameBetting {
	const rounds = 6 - parseCards(config.board).length;
	const from = <T>(value: T | readonly T[], listed: boolean, name: string): T | readonly T[] =>
		listed ? perRound(value as readonly T[], true, rounds, name).slice(round) : value;
	const each = <T>(value: PerPlayer<T> | undefined, listed: (side: T) => boolean, name: string): PerPlayer<T> | undefined =>
		value === undefined ? undefined : (mapPlayers(value, (side) => from(side, listed(side), name) as T) as PerPlayer<T>);
	const out: Record<string, unknown> = {
		betSizes: each(config.betSizes, () => true, 'betSizes'),
		raiseSizes: each(config.raiseSizes, (side) => side !== undefined && raisesPerRound(side), 'raiseSizes'),
		maxRaises: each(config.maxRaises ?? 1, Array.isArray, 'maxRaises'),
		allowAllIn: each(config.allowAllIn ?? false, Array.isArray, 'allowAllIn'),
		allInThreshold: each(config.allInThreshold, Array.isArray, 'allInThreshold'),
		// The blueprint may forbid donk bets where the caller did not.
		noDonk: from(config.noDonk ?? false, Array.isArray(config.noDonk), 'noDonk'),
	};
	// `subgameAt` reads these with `in`, so an unset one stays present and
	// says "none" rather than carrying the blueprint's over.
	return out as SubgameBetting;
}
