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
import type { CompressedRanges, CompressRangesOptions } from './compress.ts';
import { compressRanges, rebuildRanges } from './compress.ts';
import { linesWithin } from './hybrid.ts';
import { activeCombos, parseRange } from './range.ts';
import type { ShareHistories, Solution, SolveOptions, SolveRun, SpotConfig, SubgameBetting } from './index.ts';
import { createRun, defineSpot, runToStop, solve } from './index.ts';
import type { PresetChanges, SettingChange } from './presets.ts';
import { presetChanges, samplingNote } from './presets.ts';
import type { ResolvedSubgame, ResolveOptions } from './resolve.ts';
import { resolveSubgame } from './resolve.ts';
import type { SettleOptions } from './settle.ts';
import { settlePlan } from './settle.ts';
import type { BetSize, PerPlayer, RaiseSizes } from './tree.ts';
import { mapPlayers, perRound, raisesPerRound } from './tree.ts';
import { warmStart } from './warm.ts';

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
	/**
	 * `SpotConfig.shareHistories` for the blueprint. Default true, the river.
	 *
	 * For better turn re-solves, keep the most-reached flop lines unshared
	 * within a memory budget: `SolveLiteOptions.keepBudget` (issue #113),
	 * which picks them with `linesWithin` for you. Lines given here in
	 * `keepLines` are kept besides.
	 */
	readonly shareHistories?: boolean | ShareHistories;
	/**
	 * Compress both ranges before the blueprint is solved (`compressRanges`,
	 * issue #156): each keeps the fewest of its combinations, re-weighted,
	 * whose equity distributions on this board and those that can follow it
	 * stay within `tolerance` (default 0.01 on a flop, 0.005 on a spot that
	 * starts later) of the full range's. Default off. True for the
	 * defaults. On a river spot there is next to no time to save.
	 *
	 * It keeps how the range plays, not what one combination does: the
	 * blueprint and its re-solves hold a strategy only for the combinations
	 * kept. `minWeight` is applied before compressing, not after.
	 */
	readonly compressRanges?: boolean | CompressRangesOptions;
}

/** Settings for {@link solveLite}. */
export interface SolveLiteOptions
	extends LiteOptions,
		Pick<SolveOptions, 'workers' | 'precision' | 'wasmStorage' | 'algorithm' | 'onProgress' | 'targetPercent'> {
	/** Iteration cap. Default 2000; the solve normally settles well before. */
	readonly iterations?: number;
	/** The stop on the root play (`SolveOptions.settle`); false to run to `iterations`. Default {}, its own defaults; tolerance 0.005 unless given when `keepBudget` keeps lines. */
	readonly settle?: SettleOptions | false;
	/**
	 * `Approximations.chanceSampling` for the blueprint, or false for none.
	 * Default {}: sampled at p 0.35, on `workers` threads.
	 */
	readonly sampling?: SamplingOptions | false;
	/**
	 * Keep the most-reached first-round lines' later streets unshared
	 * (`ShareHistories.keepLines`, issue #101), as many as this many bytes
	 * of storage at `precision` (default 'f32') allow; `keepWithin` picks
	 * them, and the blueprint with them kept is solved from cold. It is for
	 * turn re-solves: on issue #47's flops it cut their gain by a third to a
	 * half at the settle point, more when run longer, root play unchanged.
	 * 150 MiB with `precision: 'i16'` and `wasmStorage` kept 3–19 lines and
	 * peaked at 317–534 MiB in Chromium, re-solve included. When it keeps a
	 * line, `settle` stops later: its tolerance defaults to 0.005, not 0.01, as the kept
	 * lines' turn ranges go on improving after the root play settles (issue
	 * #123); give `settle.tolerance` to choose. Throws if the shared
	 * blueprint alone is over the budget, or if it shares nothing. Unset,
	 * off. Measures are in `solveLite`'s notes.
	 */
	readonly keepBudget?: number;
	/** Iterations of the picking solve under `keepBudget`. Default 80, as issue #101 measured. */
	readonly pickIterations?: number;
}

/** Settings for `LiteSolution.resolve`. */
export interface LiteResolveOptions extends Omit<ResolveOptions, 'betting' | 'ranges'> {
	/** Overrides on the caller's own betting for the subgame. */
	readonly betting?: SubgameBetting;
	/**
	 * For a blueprint solved with `compressRanges`: solve the subgame for
	 * the caller's own ranges, every combination back in
	 * (`rebuildRanges`), and not for the kept combinations alone. Default
	 * true for such a blueprint, but false with `measure`, which compares
	 * against the blueprint on its own ranges. Up to the node a combination's
	 * play is the kept combination's nearest to it; from the node on it is
	 * solved in its own right.
	 */
	readonly rebuild?: boolean;
}

/** What {@link litePreset} returns: the blueprint spot and the solve's settings, and what they changed. */
export interface LitePreset {
	/** The blueprint spot (`liteConfig`'s). */
	readonly config: SpotConfig;
	/** The blueprint solve's settings: `iterations`, `settle`, sampling and the solve options given. */
	readonly options: SolveOptions;
	/** Everything the preset changed against the caller's spot. */
	readonly changes: PresetChanges;
}

/** What {@link solveLite} returns. */
export interface LiteSolution {
	/** The blueprint's solution. */
	readonly solution: Solution;
	/** The blueprint spot that was solved (`liteConfig`'s, with `keepBudget` its kept lines). */
	readonly blueprint: SpotConfig;
	/** The lines kept unshared (`ShareHistories.keepLines`); empty without `keepBudget` or kept lines of the caller's. */
	readonly kept: readonly string[];
	/** The caller's spot, full betting. */
	readonly source: SpotConfig;
	/**
	 * What the blueprint changed against `source`: the sizes cut on each
	 * street (the flop's own only with `flopMaxRaises`), the streets
	 * simplified, and the sharing, buckets, sampling and stop rule switched
	 * on. `resolve` puts the cut sizes back below the node it re-solves.
	 */
	readonly changes: PresetChanges;
	/**
	 * Re-solve the subgame at a node opening the turn or river, at the
	 * caller's full betting for the streets from there, the caller's cuts
	 * below the node included: `resolveSubgame` with 200 iterations
	 * unless `options` say otherwise, with the blueprint's `workers`,
	 * `precision` and `wasmStorage`. Under `compressRanges` the subgame is
	 * solved for the caller's own ranges, every combination back in
	 * (`LiteResolveOptions.rebuild`).
	 */
	resolve(node: number, board: number, options: LiteResolveOptions): ResolvedSubgame;
}

/**
 * The blueprint of `config`: its first round's betting as given, every later
 * round one bet size (the given size nearest `laterSize`) and, with
 * `laterRaise`, one raise; no shove offered after the first round; and
 * `shareHistories` and `runoutBuckets: 3`. Ranges, pot, stacks and everything
 * else carry over, the ranges compressed first with `compressRanges`
 * (which takes `minWeight` with it). Per-player betting is simplified side
 * by side.
 *
 * Bet and raise cuts (`removeActions`) on the first round carry over, but
 * for those past `flopMaxRaises`; those below a deal are dropped, as the
 * later rounds' sizes no longer exist (`LiteSolution.resolve` puts them
 * back). The caller's own `shareHistories` stands unless `options` give one.
 */
export function liteConfig(config: SpotConfig, options: LiteOptions = {}): SpotConfig {
	const target = options.laterSize ?? 0.75;
	if (!(target > 0)) throw new Error(`laterSize must be above 0; got ${target}`);
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
	// Cuts below a deal name sizes the blueprint no longer has, and cuts past
	// the flop cap name raises it no longer has.
	const aggressions = (line: string): number => line.split(' ').filter((w) => w === 'bet' || w === 'raise' || w === 'allin').length;
	const removeActions = config.removeActions?.filter(
		(line) => !line.includes('/') && (flopCap === undefined || aggressions(line) <= flopCap),
	);
	const buckets = options.runoutBuckets ?? 3;
	const given = typeof config.runoutBuckets === 'number' ? config.runoutBuckets : config.runoutBuckets ? 1 : 0;
	// Compressed weights are relative to the largest kept, so the caller's
	// floor is applied to the ranges as given and not carried over.
	const compressed = options.compressRanges
		? compressRanges(config, options.compressRanges === true ? {} : options.compressRanges)
		: undefined;
	return {
		...config,
		...(compressed ? { oop: compressed.oop, ip: compressed.ip, minWeight: undefined } : {}),
		betSizes: betSizes as SpotConfig['betSizes'],
		...(raiseSizes === undefined ? {} : { raiseSizes: raiseSizes as SpotConfig['raiseSizes'] }),
		maxRaises: maxRaises as SpotConfig['maxRaises'],
		allowAllIn: allowAllIn as SpotConfig['allowAllIn'],
		...(options.noDonk === undefined ? {} : { noDonk: options.noDonk }),
		...(removeActions === undefined ? {} : { removeActions }),
		runoutBuckets: Math.max(buckets, given),
		shareHistories: options.shareHistories ?? config.shareHistories ?? true,
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
 * against a turn re-solved at the full betting (300 iterations),
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
 * what was rejected, are in docs/APPROXIMATIONS.md.
 *
 * `keepBudget` (issue #113) recovers part of the re-solve gain above, and
 * stops later (issue #123): `settle`'s tolerance 0.005, not 0.01. With
 * `keepBudget: 150 * 2 ** 20, precision: 'i16', wasmStorage` (the recipe
 * issue #101 measured), the same measures, the pick included in the time,
 * on 4 threads (Chromium; the rest Node):
 *
 * | flop | kept, storage | settled | Chromium | peak RSS | root play loss | per-hand EV error | re-solve gain | at tolerance 0.01 |
 * |---|---|---|---|---|---|---|---|---|
 * | As Kh 7d | 3 lines, 150 MiB | 580 it | 45 s | 534 MiB | 0.022 / 0.008 | 0.44 / 0.52 | 1.78 / 1.42 | 440 it, 35 s, 2.46 / 1.70 |
 * | Ts 9s 4h | 6 lines, 141 MiB | 440 it | 29 s | 467 MiB | 0.104 / 0.047 | 0.28 / 0.27 | 1.51 / 1.20 | 320 it, 22 s, 1.78 / 1.24 |
 * | Ks 9s 4s | all 19, 97 MiB | 460 it | 13 s | 315 MiB | 0.056 / 0.031 | 0.50 / 0.63 | 1.80 / 1.24 | 360 it, 11 s, 2.51 / 1.88 |
 *
 * At the old stop, on 1 / 2 / 4 threads in Chromium, As Kh 7d took 123 / 61
 * / 35 s and peaked at 489 / 509 / 534 MiB, Ts 9s 4h 69 / 37 / 22 s and 437
 * / 463 / 469, Ks 9s 4s 32 / 19 / 11 s and 290 / 301 / 317; on 4 threads
 * the later stop adds 16–32% to the time in Chromium (25–31% in Node), the
 * same peak.
 *
 * Root play is as without it; the re-solve gain falls by a third to a half
 * at the old stop, and the later one takes off 15–28% more for out of
 * position, 3–34% for in position, still over the unshared blueprint's
 * 0.4–0.7. The rest is still the stop: the root play settles before the
 * ranges it brings to the turn do. A stop that also waited for the kept
 * lines' turn ranges stopped no better than a tighter root tolerance
 * (`bench/lite/turn-stop.ts`); 0.0035 stopped at 680 / 540 / 540 iterations,
 * re-solving at 1.57 / 1.30, 1.36 / 1.23 and 1.50 / 1.00 for 39–51% more
 * time than 0.01. Run to 800 iterations (`settle: false, iterations: 800`),
 * As Kh 7d re-solves at 1.33 / 1.14 in 59 s in Chromium, peaking at 533
 * MiB, where plain sharing gives 2.23 / 2.41. A re-solve times as without
 * it.
 *
 * Its memory: the picking solve's WebAssembly memory is freed only once the
 * caller yields to the event loop, so it stays resident beside the
 * blueprint's. The pick samples the turn but not the checked-down river,
 * whose baselines would be most of it (182 MiB resident on As Kh 7d sampled
 * on both, 56 on the turn alone, the same lines kept on all three flops);
 * sampling both, rainbow peaked at 661 MiB on 4 threads.
 */
export function solveLite(config: SpotConfig, options: SolveLiteOptions = {}): LiteSolution {
	const preset = litePreset(config, options);
	return liteSolution(solve(defineSpot(preset.config), preset.options), config, preset.config, preset.changes, options);
}

/** A blueprint's solution with the re-solver for its later streets. */
function liteSolution(
	solution: Solution,
	config: SpotConfig,
	blueprint: SpotConfig,
	changes: PresetChanges,
	options: SolveLiteOptions,
): LiteSolution {
	const share = blueprint.shareHistories;
	const kept = typeof share === 'object' ? [...(share.keepLines ?? [])] : [];
	const subgameSolve = pick(options, ['workers', 'precision', 'wasmStorage']);
	const { tree } = solution.spot;
	const scale = solution.spot.chipScale;
	// A compressed blueprint's stand-ins, worked out at the first re-solve
	// that wants them: the compression again, which is the same every time.
	const compressing = options.compressRanges ? (options.compressRanges === true ? {} : options.compressRanges) : null;
	let standIns: CompressedRanges | null = null;
	return {
		solution,
		blueprint,
		kept,
		source: config,
		changes,
		resolve(node, board, { rebuild, ...resolveOptions }) {
			if (rebuild && !compressing) throw new Error('rebuild is for a blueprint solved with compressRanges');
			if (rebuild && resolveOptions.measure) throw new Error('measure compares with the blueprint on its own ranges; it cannot be used with rebuild');
			let ranges: [Float64Array, Float64Array] | undefined;
			if (compressing && (rebuild ?? !resolveOptions.measure)) {
				standIns ??= compressRanges(config, { ...compressing, standIns: true });
				ranges = rebuildRanges(config, standIns, solution, node, board);
			}
			const round = tree.round[node];
			// The caller's cuts below the node, re-rooted there as `subgameAt`
			// does its own: chips count from what each player has put in.
			const prefix = `${solution.path(node)} `;
			const invested = (tree.pot[node] - solution.spot.potUnits) / 2;
			const removeActions = (config.removeActions ?? [])
				.filter((line) => line.startsWith(prefix))
				.map((line) =>
					line
						.slice(prefix.length)
						.split(' ')
						.map((word) => (/^-?[\d.]+$/.test(word) ? String((Math.round(Number(word) * scale) - invested) / scale) : word))
						.join(' '),
				);
			return resolveSubgame(solution, node, board, {
				...resolveOptions,
				...(ranges ? { ranges } : {}),
				betting: { ...bettingFrom(config, round), removeActions, ...resolveOptions.betting },
				solve: { ...subgameSolve, ...resolveOptions.solve },
			});
		},
	};
}

/**
 * The iteration count a session's blueprint resumes from after a change of
 * range (`SetRangeOptions.resume`): more than an exact solve's 10, which
 * chance sampling made unstable.
 */
const LITE_RESUME = 30;

/** A Lite blueprint kept live, so its ranges can change without solving it again; see {@link openLite}. */
export interface LiteSession {
	/**
	 * The blueprint as it stands. It reads the session's live storage, so it
	 * is good until the next `setRange`, and after `close` on this thread.
	 * Its `changes` are those of the blueprint as opened: under
	 * `compressRanges` the counts they give are the opening ranges'.
	 */
	readonly current: LiteSolution;
	/**
	 * Change a player's range and settle the blueprint again from where it
	 * stands. Any range is taken: in place where every hand of it is stored
	 * and it keeps the blueprint's suit symmetries, and otherwise on a
	 * wider run the blueprint's run grows into (`SetRangeOptions.grow`).
	 * With `compressRanges`, which picks other hands for every range, a new
	 * run is created on the new ranges and started from this one's regrets.
	 * A new run costs a run's setup and holds both blueprints for a moment.
	 * Either way it
	 * settles in a fraction of the iterations a new `solveLite` takes. The
	 * settle rule starts over, with `resettle` laid over the session's own.
	 * Returns the new `current`; the one before it is stale.
	 *
	 * @param player 0 out of position, 1 in position
	 * @param range the whole new range
	 * @throws if the range is empty or cannot be held against the other,
	 *   changing nothing; or from the settling after it (a throwing
	 *   `onProgress`, a failed thread), with the range changed and
	 *   `current` the blueprint as far as it got
	 */
	setRange(player: 0 | 1, range: string | Float64Array): LiteSolution;
	/**
	 * Run `iterations` more on the range as it stands, with no stop: what a
	 * page does while the slider is at rest, since a blueprint goes on
	 * improving past its settle point. Returns the new `current`.
	 */
	refine(iterations: number): LiteSolution;
	/** Iterations run since the session opened, over every range. */
	readonly iterations: number;
	/** Release the threads. `current` stays readable. */
	close(): void;
}

/** Settings for {@link openLite}. */
export interface OpenLiteOptions extends SolveLiteOptions {
	/**
	 * Changes to `settle` for the stop after a `setRange`. Default none:
	 * the same rule, which with the play before the move as its first
	 * reading can stop after two checks, 40 iterations. With `settle:
	 * false` it is the whole rule for the moves, the first solve running to
	 * `iterations`.
	 */
	readonly resettle?: SettleOptions;
}

/**
 * {@link solveLite}, kept live for a range slider: solve the blueprint until
 * its root play settles, then let `setRange` move either range and settle it
 * again from there.
 *
 * Measured (`bench/lite/slider.ts`) on issue #47's betting and the bench
 * ranges, 4 threads in Node, out of position's range moved five times (two
 * classes added, nine added, back, two dropped, a third dropped), nine
 * classes in reserve:
 *
 * | flop | five moves | five `solveLite` | a move | iterations a move | less exploitable | first solve |
 * |---|---|---|---|---|---|---|
 * | As Kh 7d | 95 s | 163 s | 12–27 s against 28–44 | 120–260 against 400–420 | 4 moves of 5 | 46 s against 30 |
 * | Ts 9s 4h | 69 s | 103 s | 11–20 s against 19–25 | 140–280 against 320 | 5 of 5 | 24 s against 18 |
 * | Ks 9s 4s | 27 s | 52 s | 3–8 s against 9–14 | 80–240 against 340–380 | 2 of 5 | 12 s against 10 |
 *
 * Exploitability in the blueprint's own game: 2.97–4.66% of pot against
 * `solveLite`'s 3.16–5.45 on the first two, lower in 9 moves of 10; on the
 * monotone flop the three moves that dropped hands ended 0.6–1.8 higher. The range's root action
 * frequencies were closer to a 1000-iteration blueprint's than `solveLite`'s
 * in 11 moves of 15; hand by hand they were further in 10, by 0.5–8 points,
 * the reserve's different buckets being part of it. The reserve cost 27–42%
 * an iteration.
 *
 * `oopReserve` and `ipReserve` on `config` are optional. With the widest
 * ranges the slider can reach in them, every move changes in place; a
 * stored hand costs what a held one does, though (27–42% an iteration for
 * nine classes). Without them the blueprint costs what `solveLite`'s does,
 * and a move that adds a hand it does not store gets a new run started from
 * the old one's regrets, which stores that hand and every hand stored
 * before it. A range that breaks a suit symmetry gets one too, and the
 * session then stays without that symmetry. The same five
 * moves with no reserve took 27 s on Ks 9s 4s against 51 for `solveLite`,
 * as the reserve's did.
 *
 * `compressRanges` compresses both ranges again at every move and gets a new
 * run each time. `algorithm: 'cfr+'` clears its average at a move and keeps
 * its count, and settles to half the tolerance unless `resettle` gives one.
 *
 * @param config the caller's spot, full betting
 * @param options `solveLite`'s, and `resettle`
 */
export function openLite(config: SpotConfig, options: OpenLiteOptions = {}): LiteSession {
	const preset = litePreset(config, options);
	const { settle, ...rest } = preset.options;
	// The stop after a move: `resettle` over the session's own, or alone where that is off.
	const moved = settle || options.resettle ? { ...settle, ...options.resettle } : null;
	// CFR+ clears its average at a move, and the fresh one stops moving
	// before it is as good: half the tolerance unless one is given.
	const resettle = moved && options.algorithm === 'cfr+' && options.resettle?.tolerance === undefined
		? { ...moved, tolerance: settlePlan(moved).tolerance / 2 }
		: moved;
	// Validated before anything is solved.
	if (resettle) settlePlan(resettle);
	const compress = options.compressRanges ? (options.compressRanges === true ? {} : options.compressRanges) : null;
	let run = createRun(defineSpot(preset.config), preset.options);
	let source = config;
	// Iterations of the runs before this one: a range that cannot change in place gets a new run.
	let earlier = 0;
	/** The blueprint as it stands, its iterations the session's: a run made for a move counts only its own. */
	const reading = (solution: Solution): LiteSolution =>
		liteSolution({ ...solution, iterations: earlier + run.completed }, source, run.spot.source, preset.changes, options);
	/** `solve`'s loop on the live run: to the cap, the target or the settle stop. */
	const settleRun = (plan: SettleOptions | null | undefined): LiteSolution =>
		reading(runToStop(run, plan ? { ...rest, settle: plan } : rest));
	/** Where a changed range's count resumes: early under DCFR, kept under CFR+ (`SolveRun.setRange`). */
	const resumed = (): number => (options.algorithm === 'cfr+' ? run.totalIterations : Math.min(run.totalIterations, LITE_RESUME));

	let current: LiteSolution;
	try {
		current = settleRun(settle);
	} catch (error) {
		run.close();
		throw error;
	}
	return {
		get current() {
			return current;
		},
		get iterations() {
			return earlier + run.completed;
		},
		setRange(player, range) {
			const next: SpotConfig = { ...source, [player === 0 ? 'oop' : 'ip']: typeof range === 'string' ? range : range.slice() };
			if (!compress) {
				// In place where every hand is stored and the symmetries hold, and
				// on a wider run of its own making where not (`SetRangeOptions.grow`).
				// A range that is none throws here, with nothing changed.
				run.setRange(player, range, { resume: LITE_RESUME });
			} else {
				// A new run on the new ranges, started from this one's regrets:
				// both ranges are compressed again, each against the other, and
				// keep other hands.
				const ranges = compressRanges(next, compress);
				const blueprint: SpotConfig = { ...preset.config, oop: ranges.oop, ip: ranges.ip };
				// Defined before anything is let go: a spot that cannot be throws here, with nothing changed.
				const spot = defineSpot(blueprint);
				// The old run's threads first, which the new one needs where
				// threads are borrowed (a browser); its storage stays readable.
				const count = resumed();
				const old = run;
				old.close();
				let replacement: SolveRun;
				try {
					replacement = createRun(spot, { ...preset.options, warmStart: old, warmIteration: count });
				} catch (error) {
					// Back on the ranges it had: the same spot, so the average comes
					// too. If that fails as well the session keeps its closed run,
					// and the first failure is the one to report.
					try {
						replacement = createRun(old.spot, { ...preset.options, warmStart: old });
					} catch {
						throw error;
					}
					earlier += old.completed;
					run = replacement;
					throw error;
				}
				earlier += old.completed;
				run = replacement;
			}
			source = next;
			try {
				current = settleRun(resettle);
			} catch (error) {
				// The range has changed all the same: `current` must not read the new storage as the old range's.
				current = reading(run.snapshot([], 'iterations'));
				throw error;
			}
			return current;
		},
		refine(count) {
			if (!(Number.isInteger(count) && count > 0)) throw new Error(`refine: iterations must be a positive whole number; got ${count}`);
			run.step(count);
			current = reading(run.snapshot([], 'iterations'));
			return current;
		},
		close() {
			run.close();
		},
	};
}

/**
 * `settle`'s tolerance under `keepBudget` (issue #123): half its default, so
 * the solve runs on past the root play's settling while the kept lines' turn
 * ranges are still improving.
 */
const KEEP_TOLERANCE = 0.005;

/**
 * What {@link solveLite} solves, without solving it: `liteConfig`'s
 * blueprint, the solve's settings (`iterations` 2000, `settle` at its
 * defaults, or tolerance 0.005 when `keepBudget` keeps lines, `chanceSampling`
 * at p 0.35, and the solve options given), and a
 * report of everything changed against `config`. With `keepBudget` it
 * does solve: the short picking solve `keepWithin` ranks lines on, whose
 * kept lines are in the blueprint and the report. For a page that steps its
 * own run: `createRun(defineSpot(preset.config), preset.options)`, with
 * `trackSettle(preset.options.settle)` for the stop, and `resolveSubgame` with `bettingFrom(config,
 * round)` for the re-solves `LiteSolution.resolve` would make.
 */
export function litePreset(config: SpotConfig, options: SolveLiteOptions = {}): LitePreset {
	const blueprint = keepWithin(liteConfig(config, options), options);
	const sampling = options.sampling === undefined ? {} : options.sampling;
	const asked = options.settle === undefined ? {} : options.settle;
	// Kept lines bring better turn ranges, but only once the solve runs past
	// the root play's settling (issue #123): a later stop unless asked otherwise.
	const share = blueprint.shareHistories;
	const keeps = options.keepBudget !== undefined && typeof share === 'object' && (share.keepLines?.length ?? 0) > 0;
	const settle = asked && keeps && asked.tolerance === undefined ? { ...asked, tolerance: KEEP_TOLERANCE } : asked;
	// Validated before the report reads it.
	const tolerance = settle ? settlePlan(settle).tolerance : 0;
	const solveOptions: SolveOptions = {
		iterations: options.iterations ?? 2000,
		...(settle ? { settle } : {}),
		...(sampling ? { approximations: { chanceSampling: sampling } } : {}),
		...pick(options, ['workers', 'precision', 'wasmStorage', 'algorithm', 'onProgress', 'targetPercent']),
	};

	// Each setting compared by what it does, so equivalent spellings
	// (unset and false, true and a gap of 1) are no change.
	const settings: SettingChange[] = [];
	const notes: string[] = [];
	const change = (setting: string, from: unknown, to: unknown, note: string): void => {
		settings.push({ setting, from, to });
		notes.push(`${setting}: ${note}`);
	};
	const rounds = 6 - parseCards(config.board).length;
	const streets = ['flop', 'turn', 'river'].slice(3 - rounds);
	const donks = (value: SpotConfig['noDonk']): boolean[] => perRound(value ?? false, Array.isArray(value), rounds, 'noDonk');
	const [donkFrom, donkTo] = [donks(config.noDonk), donks(blueprint.noDonk)];
	if (donkFrom.join() !== donkTo.join()) {
		const on = streets.filter((_, r) => donkTo[r]);
		change('noDonk', config.noDonk, blueprint.noDonk, on.length
			? `donk bets forbidden on the ${on.join(' and ')}, a speed trim that changes the game`
			: 'donk bets allowed on every street');
	}
	const gap = (value: SpotConfig['runoutBuckets']): number => (value === true ? 1 : typeof value === 'number' ? value : 0);
	if (gap(config.runoutBuckets) !== gap(blueprint.runoutBuckets)) {
		const to = gap(blueprint.runoutBuckets);
		change('runoutBuckets', config.runoutBuckets, blueprint.runoutBuckets, to > 0
			? `gap ${to}: turn and river cards that play alike are solved once (approximate; folds nothing on ranges with no rank symmetry)`
			: 'off: every turn and river card solved');
	}
	const sharing = (value: SpotConfig['shareHistories']): string => JSON.stringify(value === true ? {} : value || null);
	if (sharing(config.shareHistories) !== sharing(blueprint.shareHistories)) {
		const kept = typeof blueprint.shareHistories === 'object' ? (blueprint.shareHistories.keepLines?.length ?? 0) : 0;
		change('shareHistories', config.shareHistories, blueprint.shareHistories, blueprint.shareHistories
			? `lines that meet share river storage${kept ? `, but for ${kept} line${kept > 1 ? 's' : ''} kept apart` : ''} (approximate: exploitability plateaus a few % of pot from equilibrium; read the root play)`
			: 'off: every line stores its own river');
	}
	const dropped = (config.removeActions?.length ?? 0) - (blueprint.removeActions?.length ?? 0);
	if (dropped > 0) {
		change('removeActions', config.removeActions, blueprint.removeActions, `${dropped} line${dropped > 1 ? 's' : ''} below a deal or past the flop cap left out of the blueprint; resolve puts those below a deal back`);
	}
	if (options.compressRanges) {
		const count = (range: string | Float64Array): number => activeCombos(typeof range === 'string' ? parseRange(range) : range).length;
		change('compressRanges', undefined, options.compressRanges, `compressed to ${count(blueprint.oop)} and ${count(blueprint.ip)} re-weighted combinations (out of position, in position) that keep each range's equity distribution on this board and those that can follow it; approximate: the blueprint has no strategy for a combination left out, and what one combination does is not preserved; resolve solves the later streets for every combination again`);
	}
	if (sampling) change('approximations.chanceSampling', undefined, sampling, samplingNote(sampling));
	if (settle) {
		change('settle', undefined, settle, `stops once the root play moves under ${+(100 * tolerance).toFixed(2)}% of the range between checks, not at an exploitability target${settle === asked ? '' : ' (later than its default, for the kept lines\' turn ranges)'}`);
	}
	return { config: blueprint, options: solveOptions, changes: presetChanges(config, blueprint, settings, notes) };
}

/**
 * `blueprint` keeping the lines `options.keepBudget` allows, picked with
 * `linesWithin` from `options.pickIterations` of `checkedDown(blueprint)`;
 * `blueprint` itself without a budget. What `solveLite` solves; exported so
 * a caller stepping its own run can do the same. The picking solve uses
 * `options`' `workers`, `precision`, `wasmStorage`, `algorithm` and
 * `sampling`, the last on every round but the checked-down one.
 */
export function keepWithin(blueprint: SpotConfig, options: SolveLiteOptions = {}): SpotConfig {
	const budget = options.keepBudget;
	if (budget === undefined) return blueprint;
	if (!(budget > 0)) throw new Error(`keepBudget must be a number of bytes above 0; got ${budget}`);
	const its = options.pickIterations ?? 80;
	if (!(Number.isInteger(its) && its >= 1)) throw new Error(`pickIterations must be a whole number of at least 1; got ${its}`);
	const asked = blueprint.shareHistories;
	if (!asked) throw new Error('keepBudget keeps lines out of shareHistories; this blueprint shares nothing');
	const cheap = defineSpot(checkedDown(blueprint));
	const picked = solve(cheap, {
		iterations: its,
		...pickSampling(options.sampling === undefined ? {} : options.sampling, cheap.runouts.rounds),
		...pick(options, ['workers', 'precision', 'wasmStorage', 'algorithm']),
	});
	const keepLines = linesWithin(picked, budget, { config: blueprint, precision: options.precision ?? 'f32' });
	return { ...blueprint, shareHistories: { ...(asked === true ? {} : asked), keepLines } };
}

/**
 * The picking solve's sampling: the blueprint's, but not on the last round,
 * which `checkedDown` leaves without bets. Its baselines are most of a
 * sampled solve's memory (on As Kh 7d, 126 of 182 MiB), and `solveLite`
 * cannot let the picking solve's memory go before the blueprint starts, as
 * WebAssembly memory is freed only once the caller yields. Sampling the
 * turn alone ranked the same lines on all three of issue #47's flops.
 */
function pickSampling(sampling: SamplingOptions | false, rounds: number): { approximations?: { chanceSampling: SamplingOptions } } {
	if (!sampling) return {};
	const asked = sampling.rounds ?? Array.from({ length: rounds - 1 }, (_, i) => i + 1);
	const kept = asked.filter((r) => r < rounds - 1);
	return kept.length > 0 ? { approximations: { chanceSampling: { ...sampling, rounds: kept } } } : {};
}

/**
 * `config` with its last round checked down: no bet or all-in there, and
 * cuts naming that round's actions dropped. Its first rounds are the same
 * game tree, so how often each line reaches the next round
 * (`turnLineReach`) comes out much as the real spot's, at a fraction of its
 * storage: what `solveLite`'s `keepBudget` ranks lines on (issue #101: on
 * As Kh 7d the lite blueprint so cut stores 57 MiB, against 173, and ranked
 * the same top 3). `shareHistories.keepLines` is dropped, as it may name
 * nodes the cut removes.
 */
export function checkedDown(config: SpotConfig): SpotConfig {
	const rounds = 6 - parseCards(config.board).length;
	if (!(rounds >= 1 && rounds <= 3)) throw new Error(`A board has 3, 4 or 5 cards; got ${config.board}`);
	const last = rounds - 1;
	const betSizes = mapPlayers(config.betSizes, (rows) =>
		perRound(rows, true, rounds, 'betSizes').map((row, r) => (r === last ? [] : row)),
	);
	const allowAllIn = mapPlayers(config.allowAllIn ?? false, (side) =>
		perRound(side, Array.isArray(side), rounds, 'allowAllIn').map((on, r) => (r === last ? false : on)),
	);
	// A cut's round is the number of deals ('/') before its last action.
	const removeActions = config.removeActions?.filter((line) => line.split('/').length - 1 < last);
	const asked = config.shareHistories;
	const shareHistories = typeof asked === 'object' ? (({ keepLines: _kept, ...rest }) => rest)(asked) : asked;
	return {
		...config,
		betSizes: betSizes as SpotConfig['betSizes'],
		allowAllIn: allowAllIn as SpotConfig['allowAllIn'],
		...(removeActions === undefined ? {} : { removeActions }),
		...(shareHistories === undefined ? {} : { shareHistories }),
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

/**
 * How exploitable a Lite solve's play is in the caller's full game, % of the
 * pot (issue #154). Lite cannot measure itself: its exploitability is that
 * of the simplified game, sizes cut, runouts bucketed, histories shared.
 *
 * `exact` is a run of the caller's own spot, solved as far as the caller
 * likes. Every decision of it that `lite` also has takes `lite`'s average
 * strategy, as a warm start copies it, so an action `lite` lacks there gets
 * none; the decisions only reachable through such an action (a size Lite
 * cut, a raise) keep `exact`'s play, the best answer at hand. The figure is
 * then the exploitability of that strategy: what Lite's own decisions cost,
 * with no penalty for the ones it never made. `exact`'s own exploitability
 * is its floor, since what Lite lacks is played no better than `exact`
 * plays it. A combination Lite left out (`compressRanges`) keeps `exact`'s
 * play too, so the figure covers only the combinations Lite solved.
 *
 * `exact` is spent: its strategy is overwritten, so read anything else from
 * it first and close it after.
 *
 * @param lite the Lite solve, or any solve of the same board
 * @param exact a run of the full game: same board, unshared histories
 * @throws if the boards differ or `exact` shares histories
 */
export function exploitabilityInExact(lite: Solution | SolveRun, exact: SolveRun): number {
	// Shared storage would let one history's copy overwrite another's.
	if (exact.solver.ctx.layout.shared) throw new Error('The Exact run shares histories; measure in one that keeps them apart');
	warmStart(exact.solver.ctx, lite.solver.ctx, true);
	return exact.exploitabilityPercent();
}
