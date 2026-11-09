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
	 * measured. A raise nearly doubles the tree.
	 */
	readonly laterRaise?: boolean;
	/** Cap the flop's aggressions (the opening bet the first). Default: the caller's. */
	readonly flopMaxRaises?: number;
	/** Forbid donk bets on the turn and river (`SpotConfig.noDonk`). Default: the caller's setting. */
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
	 * Default {}: sampled, which runs on one thread whatever `workers` says.
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
 * `chanceSampling`, and `settle` with its defaults.
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
