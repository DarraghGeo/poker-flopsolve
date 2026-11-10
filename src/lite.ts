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
import { linesWithin } from './hybrid.ts';
import type { ShareHistories, Solution, SolveOptions, SpotConfig, SubgameBetting } from './index.ts';
import { defineSpot, solve } from './index.ts';
import type { PresetChanges, SettingChange } from './presets.ts';
import { presetChanges, samplingNote } from './presets.ts';
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
	/**
	 * `SpotConfig.shareHistories` for the blueprint. Default true, the river.
	 *
	 * For better turn re-solves, keep the most-reached flop lines unshared
	 * within a memory budget: `SolveLiteOptions.keepBudget` (issue #113),
	 * which picks them with `linesWithin` for you. Lines given here in
	 * `keepLines` are kept besides.
	 */
	readonly shareHistories?: boolean | ShareHistories;
}

/** Settings for {@link solveLite}. */
export interface SolveLiteOptions
	extends LiteOptions,
		Pick<SolveOptions, 'workers' | 'precision' | 'wasmStorage' | 'algorithm' | 'onProgress' | 'targetPercent'> {
	/** Iteration cap. Default 2000; the solve normally settles well before. */
	readonly iterations?: number;
	/** The stop on the root play (`SolveOptions.settle`); false to run to `iterations`. Default {}, its own defaults; with `keepBudget`, tolerance 0.005 unless given. */
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
	 * peaked at 317–534 MiB in Chromium, re-solve included. With it, `settle`
	 * stops later: its tolerance defaults to 0.005, not 0.01, as the kept
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
export interface LiteResolveOptions extends Omit<ResolveOptions, 'betting'> {
	/** Overrides on the caller's own betting for the subgame. */
	readonly betting?: SubgameBetting;
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
	 * `precision` and `wasmStorage`.
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
	return {
		...config,
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
 * / 463 / 469, Ks 9s 4s 32 / 19 / 11 s and 290 / 301 / 317; the later stop
 * adds a quarter to a third to the time, the same peak.
 *
 * Root play is as without it; the re-solve gain falls by a third to a half
 * at the old stop, and the later one takes off 15–34% more for out of
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
	const blueprint = preset.config;
	const share = blueprint.shareHistories;
	const kept = typeof share === 'object' ? [...(share.keepLines ?? [])] : [];
	const solution = solve(defineSpot(blueprint), preset.options);
	const subgameSolve = pick(options, ['workers', 'precision', 'wasmStorage']);
	const { tree } = solution.spot;
	const scale = solution.spot.chipScale;
	return {
		solution,
		blueprint,
		kept,
		source: config,
		changes: preset.changes,
		resolve(node, board, resolveOptions) {
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
				betting: { ...bettingFrom(config, round), removeActions, ...resolveOptions.betting },
				solve: { ...subgameSolve, ...resolveOptions.solve },
			});
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
 * defaults, `chanceSampling` at p 0.35, and the solve options given), and a
 * report of everything changed against `config`. With `keepBudget` it
 * does solve: the short picking solve `keepWithin` ranks lines on, whose
 * kept lines are in the blueprint and the report. For a page that steps its
 * own run: `createRun(defineSpot(preset.config), preset.options)`, with
 * `trackSettle` for the stop, and `resolveSubgame` with `bettingFrom(config,
 * round)` for the re-solves `LiteSolution.resolve` would make.
 */
export function litePreset(config: SpotConfig, options: SolveLiteOptions = {}): LitePreset {
	const blueprint = keepWithin(liteConfig(config, options), options);
	const sampling = options.sampling === undefined ? {} : options.sampling;
	const asked = options.settle === undefined ? {} : options.settle;
	// Kept lines bring better turn ranges, but only once the solve runs past
	// the root play's settling (issue #123): a later stop unless asked otherwise.
	const settle = asked && options.keepBudget !== undefined && asked.tolerance === undefined
		? { ...asked, tolerance: KEEP_TOLERANCE }
		: asked;
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
	if (sampling) change('approximations.chanceSampling', undefined, sampling, samplingNote(sampling));
	if (settle) {
		const tolerance = settle.tolerance ?? 0.01;
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
