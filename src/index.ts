/**
 * Postflop Texas Hold'em solver.
 *
 * Purpose: the public surface. Give it a board, a pot, stacks, two ranges and a
 * betting scheme; it solves to showdown.
 *
 * There is no preflop round. The ranges you supply already encode whatever spot
 * you are in, so the solver starts from a dead pot with both players even.
 */

import { COMBO_CARDS, COMBOS, comboIndex, formatCards, parseCards } from './cards.ts';
import type { BetSize, RaiseSizes, Tree } from './tree.ts';
import type { PerPlayer } from './tree.ts';
import { ACTION_LABELS, ActionKind, buildTree, forPlayer, isPerPlayer, mapPlayers, NodeKind, raisesPerRound } from './tree.ts';
import type { Runouts } from './runouts.ts';
import type { ResolvedBoard } from './runouts.ts';
export { rankSwap } from './runouts.ts';
import type { RunoutMerge } from './runouts.ts';
import { boardAtRound, enumerateRunouts, rankSwap, resolveBoard } from './runouts.ts';
import { suitSymmetries } from './abstraction.ts';
import { activeCombos, parseRange, rangeWeight } from './range.ts';
import { buildShowdownTable } from './showdown.ts';
import { buildHandSpace } from './hands.ts';
import { createEngine } from './engine.ts';
import type { WarmStartReport } from './warm.ts';
import { warmStart } from './warm.ts';
import type { Pool } from './parallel.ts';
import { defaultWorkerCount, planShards, startPool } from './parallel.ts';
import { DEFAULT_MAX_BYTES, PLATFORM, spawnEngineWorker, threadAdvice, threadLimit } from './platform/node.ts';
import type { Context, PlayerIndex, RegretStore, RootValues, SamplingOptions, Solver, SumStore } from './cfr.ts';
import {
	buildActiveLists,
	buildLayout,
	buildPlayerIndex,
	makeSampling,
	planSampling,
	samplingBytes,
	makeSolver,
	makeTerminalScratch,
	matchupMass,
	Mode,
	runoutWeights,
} from './cfr.ts';

export * from './cards.ts';
export * from './eval7.ts';
export { activeCombos, parseRange, rangeWeight } from './range.ts';
export type { ResolvedBoard } from './runouts.ts';
export type { WarmStartReport } from './warm.ts';
export { simdAvailable } from './kernels.ts';
export type { BetSize } from './tree.ts';
export type { SamplingOptions, Solver } from './cfr.ts';
export { ACTION_LABELS, ActionKind, NodeKind } from './tree.ts';
export type { PerPlayer, RaiseSizes } from './tree.ts';
/** 'node' or 'browser': which build is running. */
export { PLATFORM } from './platform/node.ts';

/** Sub-chip resolution, so pot-fraction sizing is exact. */
const DEFAULT_CHIP_SCALE = 100;

/** Measured throughput on a warm run, used only to project solve time. */
const OPS_PER_SECOND = 2e8;

/** A spot to solve. */
export interface SpotConfig {
	/** 3, 4 or 5 cards, e.g. "AsKh7d" or "As Kh 7d 2c". */
	readonly board: string;
	/** Dead money already in the middle, in chips. */
	readonly pot: number;
	/** Effective stack behind, per player, in chips. */
	readonly stack: number;
	/**
	 * The out-of-position player's range, who acts first: range notation, or
	 * a weight per combination indexed like `COMBO_CARDS`, as
	 * `Solution.subgameAt` produces.
	 */
	readonly oop: string | Float64Array;
	/** The in-position player's range, in either form. */
	readonly ip: string | Float64Array;
	/**
	 * Bet sizes per betting round; a single row applies to every round.
	 *
	 * This and every other betting setting below (`raiseSizes`, `maxRaises`,
	 * `allowAllIn`, `allInThreshold`) can be given apart for each player as
	 * `{ oop: …, ip: … }`, each side in the setting's usual form:
	 * `betSizes: { oop: [[0.33]], ip: [[0.5, 1]] }`. They only shape the
	 * tree, so a solve costs the same either way.
	 */
	readonly betSizes: PerPlayer<readonly (readonly BetSize[])[]>;
	/**
	 * Sizes offered when facing a bet; unset, raises use the bet sizes. One
	 * row for every round, or a row per round like `betSizes`.
	 */
	readonly raiseSizes?: PerPlayer<RaiseSizes | undefined>;
	/**
	 * Maximum aggressive actions per round; the opening bet is the first.
	 * One number, or one per round. Default 1. Given apart, a player may bet
	 * or raise only while the round's aggressions are under their own limit.
	 */
	readonly maxRaises?: PerPlayer<number | readonly number[]>;
	/** Offer a shove alongside the configured sizes; once, or per round. Default false. */
	readonly allowAllIn?: PerPlayer<boolean | readonly boolean[]>;
	/**
	 * Turn a bet or raise into a shove when it would commit at least this
	 * fraction of the actor's remaining stack — 0.67 makes any bet of two
	 * thirds of what is left an all-in. Trims the near-all-in lines that
	 * multiply a tree for little strategic difference. Once, or per round.
	 * Unset, never.
	 */
	readonly allInThreshold?: PerPlayer<number | readonly number[] | undefined>;
	/**
	 * Forbid donk bets: out of position may only check when opening a round
	 * into the player who made the last bet or raise of the round before.
	 * Once, or per round. Default false.
	 */
	readonly noDonk?: boolean | readonly boolean[];
	/**
	 * Collapse pot-fraction sizes closer together than this into their mean:
	 * with 0.1, sizes 0.33 and 0.4 become one 0.365. Default 0, none.
	 */
	readonly mergeSizes?: number;
	/** Refuse a range wider than this many combinations. */
	readonly maxCombos?: number;
	/**
	 * Drop combinations weighted below this from both ranges. Imported ranges
	 * are often full of hands at a few percent that barely move the answer
	 * but cost as much as any other; this removes them. It edits the ranges,
	 * so it changes the game being solved. Default 0, keep everything.
	 */
	readonly minWeight?: number;
	/**
	 * Refuse a spot needing more than this much storage. Defaults to 6 GiB in
	 * the Node build and 512 MiB in the browser build, where a tab has far less
	 * to give.
	 */
	readonly maxBytes?: number;
	readonly chipScale?: number;
	/**
	 * Fold mirror-image runouts together. When the board and both ranges are
	 * unchanged by swapping some suits — two suits absent from a two-tone flop,
	 * three from a monotone one — a deal in one of those suits is the mirror
	 * image of a deal in another, so only one is solved and it stands for both.
	 * Exact, not an approximation: strategies on a mirrored runout are the
	 * stored ones relabelled. Default true; ranges that differ between suits
	 * anywhere simply have no symmetry to use.
	 */
	readonly isomorphism?: boolean;
	/**
	 * Solve one turn or river card for several that play alike — an
	 * approximation. Two cards of one suit are bucketed together when neither
	 * pairs the board, they connect equally to its straights, and swapping
	 * their ranks maps each range onto itself (so `98s` in a range keeps an 8
	 * and a 9 apart). The stored card stands for the others with hands
	 * relabelled by that swap. How much it saves depends on the ranges: with
	 * pairs and broadway hands most low cards bucket together; suited
	 * connectors keep them apart. `trueExploitabilityPercent()` measures the
	 * strategy in the real game, every card dealt. Default false.
	 */
	readonly runoutBuckets?: boolean | number;
}

/** Projected cost of solving a spot. */
export interface Estimate {
	readonly rounds: number;
	/**
	 * Final boards stored. With `isomorphism` a mirrored runout is not
	 * stored, so this can be well under the number of real runouts.
	 */
	readonly runouts: number;
	readonly combos: readonly [number, number];
	readonly decisionNodes: number;
	readonly totalSlots: number;
	/** Storage at 32-bit precision, the default for any sizeable spot. */
	readonly bytes: number;
	/**
	 * Storage at 16-bit precision, a little over half of `bytes`; what a spot
	 * that does not fit at 32 bits is solved with.
	 */
	readonly compressedBytes: number;
	readonly secondsPerThousandIterations: number;
	/** Whether the spot fits `maxBytes` at 16 bits or better. */
	readonly fits: boolean;
	readonly suggestions: readonly string[];
}

/** Thrown when a spot would need more memory than allowed. */
export class SpotTooLargeError extends Error {
	readonly estimate: Estimate;
	constructor(estimate: Estimate, maxBytes: number) {
		super(
			`This spot needs ~${formatBytes(estimate.compressedBytes)} even at 16-bit precision, ` +
				`but the limit is ${formatBytes(maxBytes)}.\n` +
				`  ${estimate.decisionNodes} decision nodes x up to ${estimate.runouts.toLocaleString()} runouts ` +
				`x ${Math.max(...estimate.combos)} combos.\n` +
				(estimate.suggestions.length
					? `Try:\n${estimate.suggestions.map((s) => `  - ${s}`).join('\n')}\n`
					: '') +
				'Raise the ceiling with `maxBytes` if you have the memory.',
		);
		this.name = 'SpotTooLargeError';
		this.estimate = estimate;
	}
}

function formatBytes(bytes: number): string {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** A prepared spot, ready to solve. */
export interface Spot {
	readonly board: number[];
	readonly tree: Tree;
	readonly runouts: Runouts;
	readonly players: readonly [PlayerIndex, PlayerIndex];
	readonly estimate: Estimate;
	readonly chipScale: number;
	readonly potUnits: number;
	readonly stackUnits: number;
	/** The configuration this was built from, so a worker can rebuild it. */
	readonly source: SpotConfig;
	/**
	 * Find the stored board standing for a real one, and how hands relabel
	 * onto it. Board indices everywhere else — `strategyAt`, `reachAt`,
	 * `subgameAt` — index stored boards; with `isomorphism` a mirrored runout
	 * is not stored, and this is how to read it.
	 *
	 * @param board the spot's board followed by the cards dealt, in order
	 */
	resolveBoard(board: string | readonly number[]): ResolvedBoard;
}

/**
 * Validate a spot and build everything needed to solve it.
 * @throws {SpotTooLargeError} when it would exceed the memory ceiling
 */
export function defineSpot(config: SpotConfig): Spot {
	const chipScale = config.chipScale ?? DEFAULT_CHIP_SCALE;
	const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
	const board = parseCards(config.board);
	if (board.length < 3 || board.length > 5) {
		throw new Error(`A postflop board has 3, 4 or 5 cards; got ${board.length} (${formatCards(board)})`);
	}
	const rounds = 6 - board.length;

	if (config.pot <= 0) throw new Error('pot must be positive');
	if (config.stack <= 0) throw new Error('stack must be positive');

	// One row per round, for each player.
	const rowsFor = (sizes: readonly (readonly BetSize[])[], who: string): readonly (readonly BetSize[])[] => {
		const expanded = sizes.length === 1 ? Array.from({ length: rounds }, () => sizes[0]) : sizes;
		if (expanded.length !== rounds) {
			throw new Error(
				`${who}betSizes has ${sizes.length} rows but this board has ${rounds} ` +
					'betting rounds; give one row per round, or a single row for all of them',
			);
		}
		return expanded;
	};
	const rows = isPerPlayer(config.betSizes)
		? { oop: rowsFor(config.betSizes.oop, 'oop '), ip: rowsFor(config.betSizes.ip, 'ip ') }
		: rowsFor(config.betSizes, '');

	// Board cards cannot be in anyone's range.
	const onBoard = new Set(board);
	const trim = (range: string | Float64Array, who: string): Float64Array => {
		const weights = typeof range === 'string' ? parseRange(range) : Float64Array.from(range);
		if (weights.length !== COMBOS) {
			throw new Error(`The ${who} range has ${weights.length} weights; one per combination is ${COMBOS}`);
		}
		const floor = config.minWeight ?? 0;
		for (let combo = 0; combo < COMBOS; combo++) {
			if (weights[combo] === 0) continue;
			if (onBoard.has(COMBO_CARDS[combo * 2]) || onBoard.has(COMBO_CARDS[combo * 2 + 1])) {
				weights[combo] = 0;
			} else if (weights[combo] < floor) {
				weights[combo] = 0;
			}
		}
		const live = activeCombos(weights).length;
		if (live === 0) throw new Error(`The ${who} range is empty once the board is removed`);
		if (config.maxCombos !== undefined && live > config.maxCombos) {
			throw new Error(
				`The ${who} range has ${live} combinations, over the ${config.maxCombos} limit. ` +
					'Narrow the range or raise `maxCombos`.',
			);
		}
		return weights;
	};

	const players: [PlayerIndex, PlayerIndex] = [
		buildPlayerIndex(trim(config.oop, 'out-of-position')),
		buildPlayerIndex(trim(config.ip, 'in-position')),
	];

	// Symmetry needs the ranges, so the runouts come after them.
	const symmetries =
		config.isomorphism === false || board.length === 5
			? undefined
			: suitSymmetries(board, [players[0].weights, players[1].weights]);
	const runouts = enumerateRunouts(
		board,
		symmetries,
		config.runoutBuckets && board.length < 5
			? rangeRankMerge(players, config.runoutBuckets === true ? DEFAULT_BUCKET_GAP : config.runoutBuckets)
			: undefined,
	);

	const tree = buildTree(
		{
			potUnits: Math.round(config.pot * chipScale),
			stackUnits: Math.round(config.stack * chipScale),
			betSizes: rows,
			raiseSizes: config.raiseSizes,
			maxRaises: config.maxRaises ?? 1,
			allowAllIn: config.allowAllIn ?? false,
			allInThreshold: config.allInThreshold,
			noDonk: config.noDonk,
			mergeSizes: config.mergeSizes,
			chipScale,
			minRaiseUnits: chipScale,
		},
		runouts,
	);

	const layout = buildLayout(tree, runouts, players, 4);
	const last = runouts.rounds - 1;
	const showdownBytes = runouts.counts[last] * (2 * COMBOS + COMBOS + 1) * 2;
	const bytes = layout.bytes + showdownBytes;
	const compressedBytes = buildLayout(tree, runouts, players, 2).bytes + showdownBytes;

	const suggestions: string[] = [];
	if (compressedBytes > maxBytes) {
		const widest = Math.max(...[0, 1].flatMap((p) => forPlayer(rows, p).map((r) => r.length)));
		if (widest > 1) suggestions.push(`use fewer bet sizes (currently up to ${widest} per round)`);
		const raises = [0, 1].flatMap((p) => [forPlayer(config.maxRaises ?? 1, p)].flat());
		if (Math.max(...raises) > 1) suggestions.push(`lower maxRaises to 1`);
		suggestions.push(`narrow the ranges (currently ${players[0].count} and ${players[1].count} combos)`);
		if (runouts.rounds === 3) suggestions.push('solve from the turn instead of the flop');
	}

	const estimate: Estimate = {
		rounds: runouts.rounds,
		runouts: runouts.counts[last],
		combos: [players[0].count, players[1].count],
		decisionNodes: tree.decisionNodes.length,
		totalSlots: layout.totalSlots,
		bytes,
		compressedBytes,
		secondsPerThousandIterations: (layout.totalSlots * 4 * 1000) / OPS_PER_SECOND,
		fits: compressedBytes <= maxBytes,
		suggestions,
	};
	if (!estimate.fits) throw new SpotTooLargeError(estimate, maxBytes);

	return {
		board,
		tree,
		runouts,
		players,
		estimate,
		chipScale,
		potUnits: Math.round(config.pot * chipScale),
		stackUnits: Math.round(config.stack * chipScale),
		source: config,
		resolveBoard(cards) {
			return resolveBoard(runouts, typeof cards === 'string' ? parseCards(cards) : cards);
		},
	};
}

/** Solver tuning. */
export interface SolveOptions {
	/**
	 * Iterations to run. With `targetPercent` set this is only a cap, and the
	 * solve normally stops well before it; `stoppedAt` on the result says which
	 * of the two ended it.
	 */
	readonly iterations?: number;
	/**
	 * Stop once exploitability falls to this percentage of the pot — the
	 * accuracy knob, and the cheapest way to cut solve time.
	 *
	 * Solvers conventionally quote accuracy this way, and it is the only form
	 * comparable between spots of different sizes. As a rough guide, 1% of pot
	 * is a sketch, 0.5% is enough to read strategies off, 0.1% is publishable
	 * and costs several times as long.
	 *
	 * Checking is not free — see `exploitEvery` — so the solve overshoots the
	 * target slightly rather than stopping on the exact iteration it was met.
	 */
	readonly targetPercent?: number;
	/**
	 * Measure exploitability every N iterations. Each costs about one iteration,
	 * because it is a full best-response pass for both players.
	 *
	 * Left unset with `targetPercent` given, checks are scheduled by predicting
	 * when the target will be met rather than at any fixed cadence — see
	 * `nextCheck`. Setting this forces a fixed cadence instead.
	 */
	readonly exploitEvery?: number;
	readonly onProgress?: (info: Progress) => void;
	/**
	 * Accumulator storage. Unset, 'f32' — what the WebAssembly engine runs —
	 * or 'i16' for a spot too big for it under `maxBytes`. 'f64' is there on
	 * request and runs the JavaScript engine; measured, it buys no accuracy
	 * an exploitability target can see.
	 *
	 * 'i16' stores regrets and strategy sums as 16-bit integers with one scale
	 * per node and board, about halving memory. It is for fitting a spot, not
	 * for speed: the solver is compute-bound, and re-encoding each block on
	 * update costs a little time per iteration.
	 */
	readonly precision?: Precision;
	/**
	 * Threads to split the runouts across, the calling thread included: 2 is
	 * the caller and one worker. 1 stays single-threaded; 'auto' picks a count
	 * from the machine. Exploitability and EV passes use them too.
	 *
	 * A fixed worker count is bitwise deterministic, but CHANGING it moves the
	 * answer slightly: a worker sums its own slice of runouts before the totals
	 * are summed across workers, which associates the same addition
	 * differently, and the non-linear clamp in CFR+ compounds that rounding.
	 * Measured here it sits at 1e-15 through three hundred iterations and
	 * reaches 1e-7 by two thousand — always orders of magnitude under the
	 * exploitability, so never the largest error in the answer, but do not
	 * expect two worker counts to agree bit for bit.
	 *
	 * The browser build is single-threaded unless `enableThreads` from
	 * `poker-flopsolve/threads` has started its workers; any count above what
	 * is available resolves to what is, with one warning.
	 */
	readonly workers?: number | 'auto';
	/**
	 * The update rule. 'dcfr' (the default) is Discounted CFR, which discounts
	 * old regrets and weights recent iterations more heavily; measured, it
	 * reaches 0.3% of pot in 35–45% fewer iterations than 'cfr+' on river,
	 * turn and flop spots alike. 'cfr+' clamps regrets at zero and weights
	 * iteration `t` by `t` in the average.
	 *
	 * Predictive Discounted CFR+ (Xu et al., 2024) was implemented and measured
	 * against 'dcfr' and is not offered: at the paper's parameters (α 2.3,
	 * γ 5) it took 165 iterations to 0.3% of pot on the bench turn spot where
	 * 'dcfr' takes 85, and 120 to 65 on the river; no α, γ tried (1 to 2.3, 2
	 * to 5) came close, with or without the prediction.
	 */
	readonly algorithm?: Algorithm;
	/**
	 * Allocate only the strategy sums, for loading a saved strategy and
	 * analysing it. Such a run must never be stepped.
	 */
	readonly analysisOnly?: boolean;
	/**
	 * Start from a previous solve of the same board instead of from nothing.
	 *
	 * For re-solving a tweaked spot — another pot or stack, a bet size nudged,
	 * a range reweighted — whose equilibrium is close to the old one. The
	 * answer is not approximate: CFR converges from any start, and this one is
	 * near. Nodes match by the actions leading to them, bet sizes by the
	 * nearest pot fraction; hands by combination; anything without a match
	 * starts cold. `SolveRun.warmStart` says how much matched.
	 *
	 * Regrets carry over; the average strategy only when the spot is the
	 * same, which resumes a solve exactly. Measured on a river spot re-solved
	 * to 0.1% of pot, a nudged bet size took 15 iterations instead of 130 from
	 * cold, a reweighted range 80 instead of 130, a 20% bigger pot 100
	 * instead of 125.
	 */
	readonly warmStart?: Solution | SolveRun;
	/**
	 * For a `warmStart` from a solve of a different board: each card of this
	 * spot's deck to the card of the old spot's it plays as, a permutation of
	 * the 52 cards taking this board onto the old one. A rank swap (`6` and
	 * `7` in every suit, say) carries a solve of AsKh6d onto AsKh7d with every
	 * hand keeping its role: 66 there is 77 here (`rankSwap` builds that map).
	 * Hands and runouts relabel through it; whatever the old ranges lacked
	 * starts cold. Unset, a warm start must come from the same board. The
	 * average strategy never carries over through it, even for a relabelling
	 * that leaves the game unchanged: only regrets do.
	 *
	 * Measured on the bench flop (AsKh7d, single-threaded, to 0.5% of pot):
	 * 52 iterations cold, 8 warm from a 0.1% solve of AsKh6d, 20 from AsQh7d.
	 * It pays only when the whole old solve is at hand: seeding the flop's
	 * decisions alone, as a downloadable library could, saved at most 15%
	 * (see `Approximations`).
	 */
	readonly warmCards?: Uint8Array;
	/**
	 * The iteration to carry on counting from, which sets how heavily DCFR
	 * discounts the inherited regrets and how CFR+ weights the averages. Unset,
	 * the old solve's own count: the new solve continues it. Lower it to let
	 * the new spot's own iterations outweigh the old ones sooner.
	 */
	readonly warmIteration?: number;
	/**
	 * Approximations that keep the game but solve it more cheaply. All off by
	 * default. Each costs some accuracy, which the exploitability — measured
	 * exactly, in the full game — shows.
	 */
	readonly approximations?: Approximations;
	/**
	 * Use the WebAssembly SIMD kernels where the platform supports them,
	 * falling back to JavaScript where it does not. Results are identical
	 * either way, to the bit; this exists to compare the two. Default true.
	 */
	readonly simd?: boolean;
	/**
	 * Which traversal runs. Unset, the WebAssembly engine wherever it applies
	 * — one thread, 32-bit storage, WebAssembly SIMD available — and the
	 * JavaScript one otherwise. 'js' forces JavaScript, to compare the two.
	 */
	readonly engine?: 'js';
}

/** See `SolveOptions.approximations`. */
export interface Approximations {
	/**
	 * Solve a coarser copy of the spot first and start the real one from its
	 * regrets — coarse to fine, as multigrid methods do. The copy buckets
	 * turn and river cards like `runoutBuckets`, so each of its iterations
	 * is cheaper (a flop stores ~40% fewer runouts at a gap of 3), and its
	 * equilibrium is close enough to the real one's that the real solve picks
	 * up roughly where it left off. The answer is still the real spot's: the
	 * coarse game only chooses where it starts, and exploitability and
	 * `targetPercent` measure the real game. Unset, off.
	 *
	 * Measured on three flop spots in Chromium, one thread, stopped at 15 s,
	 * with 40 coarse iterations (issue #24): root-EV error per combination
	 * against a 0.1%-of-pot reference fell from 1.51% to 0.19% of pot on
	 * AsKh7d (exploitability 0.94% to 0.40%), and 0.26% to 0.06% on the
	 * wider bench flop. A monotone flop, which a cold solve already settles
	 * within 15 s, reached 0.5% error in half the time but ended a little
	 * looser, 0.11% against 0.04%. To an exploitability target in Node it
	 * was faster on all three: 0.1% on the monotone flop in 14.5 s instead of
	 * 15.3, 0.2% on the wide one in 15.5 instead of 19.3, 0.3% on AsKh7d in
	 * 23.8 instead of 31.5. Around 40 iterations suits a flop; far fewer
	 * leave the coarse solve too rough to help, far more spend the time
	 * where the real solve would have spent it better.
	 *
	 * Carrying the coarse average strategy, restarting DCFR's count (a
	 * `warmIteration` of 0 or 10), a bucket gap of 1, or forbidding donk bets
	 * in the coarse spot were measured too, and were all worse.
	 *
	 * The coarse iterations count toward `totalIterations`, not `completed`
	 * or `Solution.iterations`; DCFR carries on counting from them unless
	 * `warmIteration` says otherwise. Both solves are in memory at the
	 * switch, the coarse one about 60% the size of the real one on a flop.
	 * Where bucketing folds no runouts together — a river spot, ranges with no rank symmetry — it does
	 * nothing. Not with `warmStart`, which it already is. The coarse solve
	 * runs inside `createRun`, all at once and without progress reports, so
	 * a caller stepping a run to stay responsive should keep it short; it
	 * must fit in what `maxBytes` leaves beside the real spot, at 16 bits if
	 * not 32, or `createRun` refuses.
	 */
	readonly coarseStart?: CoarseStart;
	/**
	 * Report `Solution.ev` and `Solution.handEvs` under the current profile —
	 * the regret-matched strategy the next iteration would play — instead of
	 * the average strategy. Default off. Measured under DCFR, the default
	 * update rule; it applies to CFR+ alike.
	 *
	 * Measured against a solve to 0.045% of pot, after a 15 s single-threaded
	 * browser budget, the current profile's per-hand root EVs had a mean error
	 * of 1.23% of pot where the average's had 2.18% (flop As Kh 7d), 0.11%
	 * against 0.37% (monotone Ks 9s 4s) and 1.40% against 2.02% (wide Qs Jh
	 * 2c). Across those three spots it was the closer one at 62 of 65
	 * checkpoints from 15 s down to 0.1% exploitability, often by 2–4 times.
	 * It costs the same one pass per player as reading the average's EVs.
	 *
	 * Those EVs then belong to a different profile from the strategy
	 * `strategyAt` and `reachAt` show, which stays the average: the average is
	 * what converges to equilibrium and what exploitability measures, while
	 * the current profile's values happen to settle sooner. Read them as the
	 * better estimate of the equilibrium's EVs, not as the EVs of the strategy
	 * on screen. A run with `analysisOnly` has no regrets and cannot use this.
	 */
	readonly currentProfileEv?: boolean;
	/*
	 * Threshold pruning — skipping opponent actions taken with negligible
	 * reach — was built and measured, and is deliberately not offered: a
	 * threshold on reach mass also skips deep lines that are rare overall but
	 * matter to the few hands that reach them, their strategy stops training,
	 * and the best response walks straight into it. On a wide turn spot it
	 * plateaued near 0.8% of pot where the unpruned solve reached 0.17%, for
	 * at most 15% less time per iteration.
	 *
	 * River hand buckets — one strategy per set of hands of equal strength
	 * and equal ranks, suits told apart only where a flush is possible — were
	 * built and measured too, and also left out. The solver updates every hand
	 * in one vector pass, so fewer separate strategies did not mean fewer
	 * iterations, while the lost blocker detail put a floor under accuracy:
	 * 105 iterations to 0.3% of pot on a turn spot instead of 85, and a
	 * plateau near 0.15% where the exact solve went on to 0.1%.
	 *
	 * Chance sampling — walking each river deal in training with probability
	 * p and weighting it by 1/p, with DCFR discounts caught up for deals left
	 * out — was built and measured as well. Iterations got cheaper, but the
	 * sampling noise, which DCFR's weighting of recent iterations amplifies,
	 * cost more iterations than it saved: a flop spot on 4 threads reached
	 * 0.3% of pot in 14.1 s exact, 23.1 s at p = 0.5, and not within 400
	 * iterations at p = 0.25; at best it broke even to 1%.
	 *
	 * Hand classes at the flop root — each player's flop vector shortened to
	 * weighted classes of nearly equivalent combos (rank pair, suitedness, and
	 * how many flop cards share each hole card's suit), expanded back to
	 * combos at the turn deal — were counted and not built, because they
	 * cannot pay: the flop round is 0.005% to 0.02% of the decision slots and
	 * terminal work of the bench flop spots (rainbow, monotone, and the
	 * same in pairs-and-broadway form), the river 99%, so shortening the flop
	 * vectors 2 to 3 times (198 combos to 92 classes on As Kh 7d, 217 to 75 on
	 * Ks 9s 4s) bounds the speed-up at 0.02%.
	 *
	 * Carried through every street (#40), against the packed hand lists, the
	 * same classes shorten river vectors 1.9 to 2.1 times (784,806 to 384,948
	 * on As Kh 7d, 171,442 to 90,704 on Ks 9s 4s, 177,944 to 84,404 on Ks 9s
	 * 4s in pairs and broadway), and they were measured before building
	 * (`bench/hand-classes/`). The test was the best case: every class's
	 * regrets and strategy sums were tied after each iteration, so each
	 * decision played one strategy per class while payoffs and card removal
	 * stayed exact. They are not offered, for two reasons.
	 *
	 * - Accuracy. On As Kh 7d the classes put a hearts flush draw and the
	 *   same ranks in clubs together, and they stalled at 0.53% of pot, where
	 *   the exact solve reaches 0.3% in 60 iterations and 0.1% in 105.
	 *   Keying the suit counts on the current board instead keeps draws
	 *   apart. That shortened rainbow vectors only 1.6 times (1.1 times on
	 *   monotone), needed twice the iterations to reach 0.1%, and stalled
	 *   near 0.09%. On Ks 9s 4s only spades can flush, so the classes cost
	 *   little: the same iterations to 0.3%, 10–15% more to 0.1%, and
	 *   0.024% after 500 iterations where the exact solve had 0.005%. In
	 *   pairs and broadway they cost nothing, because the exact solve already
	 *   plays every member of a class alike.
	 * - Speed. Only the decision rows shrink. The fold and showdown kernels
	 *   must still read each hand's own two cards to keep card removal
	 *   exact, and they are about 70% of an iteration: single-threaded in a
	 *   cloud container, Ks 9s 4s took 93 ms, and 27 ms with the engine's
	 *   fold and showdown calls replaced by zeros; As Kh 7d took 358 and 116
	 *   ms. So the bound is
	 *   1.15 to 1.2 times, before the cost of expanding classes into hands at
	 *   every terminal. Kernels at class length would need each class's
	 *   blocked mass averaged over its members. That is only approximate, and
	 *   it can only make the floors above worse.
	 *
	 * Regret-based pruning — skipping the subtree below an action no hand of
	 * the actor plays (Brown & Sandholm, 2015) — was measured before building
	 * and is not offered either; `bench/prune-census.ts` counts the work it
	 * could skip. The provably safe form cannot skip anything under this DCFR:
	 * with β = 0 a negative regret is halved every iteration, so it never
	 * falls below twice the largest one-iteration regret, and the skip it
	 * proves safe is zero iterations. The unsafe form's ceiling is small too.
	 * Below actions played by no hand sat 4–10% of the work to reach 0.5% and
	 * 0.3% of pot, on the bench flop, monotone, wide-flop and turn spots and
	 * on pairs-and-broadway ranges. Most of that was iterations 2–5, before
	 * every board has a hand that likes each action, and after them it was
	 * 1–8% per iteration. Half of it, at opponent nodes, could be skipped
	 * without changing any value, but the traverser's own nodes below would
	 * then miss their discount and strategy-sum update.
	 *
	 * Depth-limited solving (Brown, Sandholm & Amos, 2018) was built and
	 * measured too: the tree stopped at the deal of the river (or the turn),
	 * and at each leaf both players chose per hand, unseen by the other, one
	 * of k fixed continuations: check down; value-bet the top 30% with
	 * balanced bluffs and call by MDF; that betting ×1.5; that calling ×1.5;
	 * top-half bet and call. CFR trained the choice. It cut flop memory about
	 * tenfold (246 MB to 22 MB) but lost on accuracy and did not win on speed.
	 * Against an exact solve to 0.1% of pot, the depth-limited game's own
	 * equilibrium kept per-combination root EVs 2–5% of pot off on average
	 * (8–20% for single combos), with draws and made hands worst and air
	 * nearly right. That is the implied-odds and value-extraction play a fixed
	 * continuation keyed on starting-range percentile cannot follow once the
	 * flop and turn have narrowed the ranges. The exact solver stopped at 15 s,
	 * single-threaded in Chromium, was closer on every spot measured: 0.02% on
	 * the monotone flop, 0.3–0.6% on the wide one, 2.0–2.4% on AsKh7d at pot
	 * 100, where the best depth-limited run was 4.2%. It was not faster either.
	 * These trees' river betting is one size with no raise, already as cheap
	 * as a leaf's five terminal passes, so with k ≥ 2 an iteration cost as
	 * much as the full tree. Cutting at the turn was cheaper still, and worse:
	 * 3–14% mean error. The implementation is in this repository's history
	 * (commit 32e8424, issue #21).
	 *
	 * The same idea was measured again for memory (issue #48), with
	 * continuations from a solved blueprint instead of fixed rules and the cut
	 * at the turn deal, and is not offered either. A one-size blueprint (0.75
	 * pot, no raise, 235 MiB) was solved first. Each flop line into the turn
	 * took the blueprint's turn and river strategy from the blueprint line most
	 * like it, played out from the line's real pot and stacks. Both players
	 * then picked per hand among k continuations: the blueprint, and copies
	 * leaning ×5 toward folding, calling or raising. The flop was solved with
	 * every size and raise.
	 *
	 * Leaf values were stored as each player's EV per hand for each pair of
	 * picks, a pair of hands worth the difference. Plain per-hand vectors
	 * made the leaf game non-zero-sum and CFR cycled. Exact per-pair tables
	 * cost about n times the walks (n the opponent's hands) to build.
	 *
	 * It fit easily. On the round's target spot (As Kh 7d, pot 55, stack 975,
	 * sizes 0.33 / 0.75 / 1.5, a 0.75 raise, three aggressions; 17 GiB exact)
	 * it peaked at 0.5–0.8 GiB and took 31–55 s on 4 threads in Chromium. It
	 * lost on accuracy.
	 *
	 * Root EV per combination was off by these amounts on average, in % of
	 * pot, OOP / IP:
	 *
	 * - 4.5 / 4.4 against an exact T₀ (all-in-only raise, 0.84% of pot),
	 *   where the one-size blueprint alone was 5.2 / 6.4;
	 * - 3.1–3.6 / 2.3–3.8 on Ks 9s 4s, against 3.5 / 4.4;
	 * - 6.3 / 4.7–6.1 on a T-shaped spot at SPR 3, against 2.0 / 3.0.
	 *
	 * Single hands were off by up to 35% of pot. The best root bet size per
	 * hand matched the exact solve for 32–37% of the range on As Kh 7d,
	 * chance for three sizes. More continuations (k = 2, 4) never helped.
	 * Exact per-pair leaf tables only brought it level with the blueprint
	 * alone. So it does no better than solving its own blueprint, which
	 * already fits. The implementation and bench are in this repository's
	 * history (commit ab0b66a, issue #48).
	 *
	 * Cheaper EV estimates (issue #27) were measured offline with bench/ev on
	 * three flops, against each solve run on to 0.045% of pot, and none is
	 * offered here. The idea was that per-hand EVs settle before
	 * exploitability does; they do not. The range-weighted mean error of
	 * per-hand root EVs runs at 1 to 2.5 times the exploitability throughout,
	 * so getting under 1% of pot takes about 47 iterations on every spot.
	 * Stopping on EV stability stopped too early: the change between checks
	 * understates the error left, and at ε 0.5% it stopped with 2.2–2.6% of
	 * pot still wrong. `targetPercent` already tracks the error. Bracketing
	 * with the best-response values did not help either: their midpoint with
	 * the average was worse than the average alone, and the best blend, fitted
	 * in hindsight, gained at most 10% with a weight that drifted from 0.1 to
	 * 0.85 over a run. Extrapolating the EV sequence was unstable because
	 * DCFR's average values do not follow a clean C/T^p. Even with each
	 * correction capped at three times the last step, Richardson on the
	 * whole vector beat the plain average at only 11 of 51 checkpoints and
	 * was up to 8 times worse; per-hand Aitken beat it at 17 of 51 and was
	 * up to 4 times worse. The one win was evaluating EVs under the
	 * current profile rather than the average: at equal iterations its error
	 * was lower at 62 of 65 checkpoints, often by 2 to 4 times. Issue #35 takes
	 * that up as its own opt-in.
	 *
	 * Learned turn-leaf values — solving only the flop betting and asking a
	 * model for each hand's value where the turn is dealt, as DeepStack does —
	 * were measured too (`bench/leaf/`), and are not offered: no model came
	 * near the accuracy the exact solve already reaches in the time budget.
	 * Fitted on turn spots solved to 0.3% of pot and scored on the real turn
	 * leaves of 0.1% flop solves, per-hand EV was off by 9–17% of the leaf pot
	 * for equity times a realisation factor per hand class (a hand's value at
	 * a stack-to-pot ratio of 2 is not bounded by its share of the pot: strong
	 * hands win stacks, weak ones fold), 3–5% for a cubic in equity per class,
	 * and 1.7–2.7% for an MLP on equity-distribution features trained on
	 * 10,000 spots. Errors move together across turn cards, so averaging them
	 * into the flop barely cancels them: 1.1–4.2% of the flop pot with the
	 * flop strategy held at the reference, where the exact solve stopped at
	 * 15 s, single-threaded in Chromium, is within 0.1–1.7% at the root. Nor
	 * would it be faster: the network over one leaf's turn cards took about
	 * 140 ms, three leaves more than an exact flop iteration (about 350 ms),
	 * before the range-dependent features it needs.
	 *
	 * A library of precomputed flops (#30) — the 1,755 suit-isomorphic flops
	 * solved for a few archetype ranges, answering a query by lookup and then
	 * warm-starting — was measured and is not offered. The experiment is in
	 * `bench/library/`: the bench `flop` (AsKh7d) and `monotone` (Ks9s4s)
	 * spots and a wide AsKh7d (213 vs 205 combos), references solved to 0.1%
	 * of pot, a budget of 15 s single-threaded in Chromium (36, 96 and 36
	 * iterations), errors in per-combination root EV, % of pot.
	 *
	 * - A lookup is only as good as the nearest stored spot. From a flop a
	 *   rank swap away (AsKh6d for AsKh7d, Ks9s5s for Ks9s4s) the mean error
	 *   was 0.8–1.8 and the largest 7–40, since the hands whose role changes
	 *   are simply wrong; from AsQh7d or Ks8s4s the mean was 3–8. For a custom range on the same flop,
	 *   re-weighting the archetype's per-matchup values (the strategies cannot
	 *   adapt) gave a mean of 1.3–4.5 and a largest of 3–14. Cold solves
	 *   reached a mean of 0.2–2.4 and a largest of 0.4–4.9 inside the budget,
	 *   so a lookup wins only in the first seconds and never on the worst
	 *   hands.
	 * - A warm start from the whole of a neighbour's solve is fast (0.5% in 8
	 *   iterations instead of 52) and stays available in-session as
	 *   `SolveOptions.warmCards`. But the whole tree is 9–33 MB per flop at a
	 *   byte per value, 16–58 GB per archetype for every flop. What a library
	 *   can ship is the flop's decisions (~2 KB a flop) or the flop's and the
	 *   turn's (~0.2 MB). Seeded with the flop's alone, solves took 76–92
	 *   iterations to 0.5% where cold took 40–52: the later streets start cold
	 *   but are discounted as if late in the solve. Restarting the count at 10
	 *   recovered 44–52 on rainbow flops and 44–56 on monotone ones (a cold
	 *   solve restarted at 10, nothing seeded, took 52–68); flop and turn,
	 *   52–68. At most 15% fewer iterations on some spots and more on others,
	 *   for thousands of precomputed solves per tree and archetype, rebuilt
	 *   whenever the defaults change.
	 *
	 * Out-of-core river storage (#55) — the flop and turn in memory, the
	 * river's accumulators in an Origin Private File System file paged through
	 * one buffer, one turn card of one turn chance node at a time and in file
	 * order — was built, measured and is not offered. It is exact (bit for bit
	 * at 32 bits) and fits the round's target spot T (AsKh7d, three sizes a
	 * street, 8.7 GiB at 16 bits) in a tab: 0.33 GiB peak in headless
	 * Chromium against a 10 GiB OPFS quota, with I/O 5–8% of each iteration
	 * (sequential reads 3–4.5 GiB/s, read and write back about 1 GiB/s). What
	 * it cannot change is T's compute: 81 s an iteration on one thread, and
	 * a few hundred iterations to 0.3% of pot (T₀, smaller, was still at 3.8%
	 * after 80), so hours per solve where the bar was two minutes. Each
	 * iteration also rewrites the whole river file, terabytes per solve on a
	 * laptop SSD, and a private window keeps OPFS in memory and failed before
	 * 1 GiB. CFR-D, re-solving every river subgame from the trunk's ranges
	 * each iteration, would cost tens of times more and was not built. The
	 * implementation is in this repository's history (commit 0f80fcc);
	 * `bench/ooc/` keeps the OPFS throughput and sizing benchmarks.
	 *
	 * Pruning for space (#52) — freeing the storage under lines no hand plays,
	 * as best-response pruning does (Brown & Sandholm, 2017), and rebuilding
	 * it if the line comes back — was measured before building and is not
	 * offered. `bench/prune-space-census.ts` walks both players' reach under
	 * the current profile after every iteration and counts the regret and
	 * strategy-sum storage of blocks (a node on one board) that one player or
	 * the other reaches with no hand. That is everything freeing could release.
	 * On T₀ (AsKh7d, pot 55, stack 975, bets 33/75/150%, all-in raise, two
	 * aggressions, 5.1 GiB at f32) it was 2.8%, 3.4%, 7.6% and 15.8% of
	 * storage at iterations 20, 50, 100 and 200 (1.1% of pot). Only 6.0% had
	 * stayed unreached for the last 50 iterations, and no decision node was
	 * unreached on every board it is dealt on, which is the unit a whole-node
	 * allocator would free. The target tree itself on Ks9s4s (3.75 GiB) was
	 * alike: 15.0% per block at iteration 150 (2.5% of pot), 3.3% for 50
	 * iterations running, 0% per node. Turn-rooted copies of the target's
	 * betting, solved to 0.3–0.6% of pot, reached 15–20% per block and 3–4%
	 * per node. Some hand on some board keeps every line alive: per node,
	 * almost nothing can be freed, and per block, freeing all of it would
	 * still leave the target at about 14 GiB at f32, where 2 GiB needs a
	 * cut of about 9×.
	 *
	 * The bound that makes freeing safe does not hold here either. With
	 * DCFR's β = 0 a negative regret halves every iteration, so it never
	 * falls below about twice the largest one-iteration regret, and the
	 * number of iterations it proves an action stays unprofitable is zero
	 * (as for pruning work, above). And WebAssembly memory grows but never
	 * shrinks, so freed blocks only cut peak memory if storage starts small
	 * and is allocated when the traversal first reaches it. That means a
	 * per-block indirection through every kernel, the AssemblyScript engine,
	 * the threads' shared memory, the 16-bit scales and warm starts, for an
	 * 8–20% saving at best.
	 *
	 * Runout clusters — potential-aware card abstraction (Ganzfried &
	 * Sandholm, 2014): turn and river cards grouped by k-medoids under the
	 * earth mover's distance between each range's river-equity distribution,
	 * plus flush, straight and pair texture, one walk per cluster with reach
	 * gathered from every member — were built and measured as well, and left
	 * out (prototype and data in bench/clusters, commit ef1fa9c). Rank swaps
	 * alone cannot get there: suited connectors leave only ranks 2-5 swappable on
	 * AsKh7d, so about 37 of 49 turns stay apart whatever k asks for, and the
	 * rest need hands mapped by strength order, and that is where the error
	 * comes from. At 15 s in the browser, single-threaded (measured before
	 * #8 changed how strategy sums are weighted), true exploitability:
	 * bench flop 2.3% at k = 16 (rivers 20) against 1.8% exact and 0.7% for
	 * `runoutBuckets`, which also beat it on per-combination EV; both monotone
	 * flops lost to exact on every measure. It won only where exact gets
	 * almost nowhere in 15 s — a two-size wide flop, under 10 iterations —
	 * and on the pairs-and-broadway flop's EVs (mean error 0.3% of pot against
	 * 1.0%, at 0.8% exploitability against 0.6%). Its error has a floor that
	 * more iterations do not lower: on the bench flop 1.1-3.2% of pot mean
	 * per-combination EV error and 2.2-4.7% exploitability from k = 16 down
	 * to 4, on the wide flop 1.3-2.3% and 4-10%.
	 *
	 * Action translation of raises (#54) was built and measured, and is not
	 * offered. The tree solved sized raises only over opening bets of chosen
	 * sizes and offered just fold, call and the shove facing any other bet.
	 * A full-tree raise over a 0.33 or 1.5 bet was read from the solved raise
	 * over the nearest anchor, 0.75 (the pseudo-harmonic mapping is the
	 * identity there, since the raise is 0.75 of the pot in both lines). Sized
	 * raises are 64% of the round's target T (AsKh7d, 17.2 GiB at 32 bits):
	 * those over a 0.33 bet 35%, over 0.75 20%, over 1.5 9%. Cutting them is
	 * not enough. Raises over 0.75 alone left 9.1 GiB (4.6 at 16 bits), and
	 * dropping every sized raise left 5.8 (2.9), both over the 2 GiB mark. On
	 * the monotone Ks9s4s, where T is 3.75 GiB (1.9 at 16 bits, already
	 * under the mark), raises over 0.75 alone took it to 2.0 GiB (1.0). That
	 * solve needed 680 iterations to 0.3% of pot where the full tree needed
	 * 510, and ran 20 minutes on 4 threads. Its per-combination root EVs were
	 * 2.1–2.3% of pot off the full tree's on average and 8–9% at worst. Out
	 * of position still chose the same root bet size for 93% of its range,
	 * and for every hand with a clear preference. In position, after a check,
	 * it agreed for 51%: a 0.33 bet that cannot be raised looks too good.
	 * Translated into the full tree, the strategy was exploitable for 43% of
	 * the pot. A turn spot with T's betting (AsKh7d2c) said the same: 2.2–3.4%
	 * mean EV error and 31–68% exploitability across the anchor choices,
	 * against 92–128% with no translation at all. The leak is the pairing.
	 * With the full tree's own strategy put into only the translated
	 * subtrees, exploitability was 0.2%. With the translated subtrees kept and
	 * the full tree's strategy everywhere else, it was 0.14%. What fails is
	 * the abstract game's 0.33 and 1.5 bets, shaped knowing they cannot be
	 * raised, met by responses made for a range that could. Matching the
	 * anchor's continue frequency at the first translated decision did not
	 * help (39%). This is the pathology Ganzfried and Sandholm (2013)
	 * describe. The implementation is in this repository's history (commit
	 * f40fb76). `bench/translation/census.ts` keeps the storage census, and
	 * `bench/translation/results/` keeps the measurements.
	 *
	 * Strategy grafting over bet sizes (#56; Waugh, Bard & Bowling, 2009) —
	 * one size at a time in the same memory, stitched by a small game that
	 * picks each hand's size — was built for the flop's opening bet,
	 * measured, and is not offered. `bench/graft/` has it. R, the game it
	 * approximates, is T's three sizes (and the shove) on the flop's opening
	 * bet with 0.75 after it. Its grafts are cut down to the subtrees they
	 * add: R's tree with every opening edge but one taken out, below OOP's
	 * bet and below IP's bet after a check, plus check-check. Each is solved
	 * alone for the ranges the stitch sends in, and only per-hand root values
	 * are kept. The stitch is RM+ at the two opening decisions on those
	 * values, one update per round of re-solving every piece; the trunk is
	 * CFR-D's, two decisions deep.
	 *
	 * Memory is what it promises: the largest piece is 868 MiB at 32 bits on
	 * AsKh7d (191 MiB on Ks9s4s) where R is 3.7 GiB (0.81), and grafting
	 * every street's opening bet would not grow it. Time and accuracy are
	 * not. The pieces partition R, so a round costs about one solve of R,
	 * and the stitch needs many rounds. The ranges move from round to round,
	 * every piece re-equilibrates, and the trunk oscillates as CFR-D's does.
	 * On Ks9s4s, 4 threads in Node, R itself solved to 0.25% of pot in 158
	 * s. Grafted with 150 iterations a piece: the 0.75 blueprint's opening
	 * spread over the three sizes, then one round, took 130 s and was 61% of
	 * pot exploitable in R, with root EVs 1.1–2.9% of pot off per combination
	 * on average and the preferred size agreeing with R's for 86% (OOP) and
	 * 47% (IP after a check) of hands. Four rounds took 396 s: 15%, 13–16%
	 * off. Eight took 809 s: 6.6%, 8.5–9.8% off, 78% and 28%; RM+'s latest
	 * stitch instead of its average, 820 s: 13%, 12–13% off. On AsKh7d one
	 * round after the blueprint took 417 s and was 91% exploitable, 2.2% off,
	 * the size agreeing for 22% and 41% of hands. On a small turn
	 * spot that R solves to 0.18% in 4 s, 64 rounds took 186 s and were
	 * still 7–11% exploitable. Even the reference's own opening strategy,
	 * fed in for one round, came out 42% exploitable: an opening a hand never
	 * takes (the shove, IP's bets after a check) gets an answer to the
	 * pieces' floor range, not an equilibrium one, until the stitch's rounds
	 * correct it. And it is still only R: exactly solved, R's root EVs are
	 * 0.8–1.0% of pot off T's per combination on Ks9s4s (T itself took 50
	 * minutes on 4 threads to 0.23%), and T's turn and river sizes would
	 * need grafts per flop line, which multiplies the solves.
	 */
	/**
	 * Chance sampling with baselines (VR-MCCFR; Schmid et al., 2019). Each
	 * training iteration walks each turn and river deal with probability `p`
	 * (default 0.35, both rounds). A deal left out adds the per-hand values it
	 * returned when last walked, its baseline; a walked deal adds
	 * `b + (v - b) / p` and its values become the new baseline. DCFR discounts
	 * a skipped subtree missed are applied when it is next walked. This is
	 * what made sampling pay where the plain 1/p weighting above did not:
	 * the correction only carries how much a deal's values moved since its
	 * last walk, which is small.
	 *
	 * Iterations get several times cheaper and take 2–5 times as many to a
	 * target, so the net is about 1.2–1.5 times faster to 0.3% of pot, and
	 * per-hand root EVs come out closer to the true ones at the same
	 * exploitability. Measured single-threaded in Node against the exact
	 * solve, time to 0.3% of pot (to 1%): AsKh7d 23.7 s → 15.9 s (13.3 → 9.0),
	 * Ks9s4s 6.0 → 4.3 (3.4 → 2.3), the README's wide flop 13.4 → 9.3
	 * (7.5 → 5.3), and pairs-and-broadway ranges on AsKh7d 16.7 → 12.9 and on
	 * Ks9s4s 5.5 → 4.5. Exploitability is measured exactly, in the full game.
	 *
	 * Costs: one float per hand per stored deal per chance node, 6–31 MB on
	 * those flops (about 12–20% beside their storage), counted against
	 * `maxBytes`; always one thread (`workers` is ignored); 32- or 64-bit
	 * storage only. With `targetPercent`, a sampled solve runs more
	 * iterations, so it makes a few more exploitability checks.
	 * Off, nothing changes; at `p: 1` it is the exact solve, bit for bit.
	 */
	readonly chanceSampling?: SamplingOptions;
}

/** See `Approximations.coarseStart`. */
export interface CoarseStart {
	/** Iterations of the coarse spot to run before the real one. */
	readonly iterations: number;
	/**
	 * The coarse spot's `runoutBuckets`, at least the spot's own. Default 3;
	 * a wider gap folds more runouts only where the ranges allow it.
	 */
	readonly runoutBuckets?: number;
}

export type Algorithm = 'cfr+' | 'dcfr';

export type Precision = 'f64' | 'f32' | 'i16';

/** Bytes per stored value at each precision. */
export const PRECISION_BYTES = { f64: 8, f32: 4, i16: 2 } as const;

export interface Progress {
	readonly iteration: number;
	readonly exploitability: number;
	readonly elapsedMs: number;
}

/** A solved spot. */
export interface Solution {
	readonly spot: Spot;
	/** Iterations this solve ran. */
	readonly iterations: number;
	/** Iterations behind the strategy, counting any a warm start inherited. */
	readonly totalIterations: number;
	/**
	 * Which stopping rule ended the solve. 'iterations' with a `targetPercent`
	 * set means the target was NOT reached and the answer is looser than asked
	 * for — worth surfacing rather than swallowing.
	 */
	readonly stoppedAt: 'target' | 'iterations';
	/** Worker threads the solve actually used, which 'auto' does not tell you. */
	readonly workers: number;
	/** The solver behind this solution, for analysis and warm starts. */
	readonly solver: Solver;
	/**
	 * Chips per hand for a player, under the average strategy — or under the
	 * current profile with `approximations.currentProfileEv`.
	 */
	ev(player: 0 | 1): number;
	/**
	 * Root EV in chips for each combination a player can hold, indexed like
	 * `COMBO_CARDS` (as `reachAt` is): what that hand wins on average, over
	 * the opponent hands it can be dealt against. Zero for combinations outside
	 * the range or blocked by the board, and for a hand no opponent hand can be
	 * dealt against, which has no EV to give. Weighted by range weight times
	 * compatible opponent mass, the mean is `ev(player)`, and the same pass
	 * serves both. Under the average strategy, or the current profile with
	 * `approximations.currentProfileEv`. Returns a fresh copy.
	 */
	handEvs(player: 0 | 1): Float64Array;
	/** Distance from equilibrium, in chips per hand. */
	exploitability(): number;
	/**
	 * Distance from equilibrium as a percentage of the pot, which is how
	 * solvers conventionally report it and the only form comparable between
	 * spots of different sizes.
	 */
	exploitabilityPercent(): number;
	/** Action probabilities for every combination this player holds. */
	strategyAt(node: number, board: number): StrategyView;
	/** Readable action path to a node. */
	path(node: number): string;
	/**
	 * How likely each combination is to reach a node on a board, for one
	 * player: their range weight times the probability of every action they
	 * took on the way, under the average strategy. Indexed by combination.
	 * The other player's actions do not enter: this is the player's own range
	 * at the node, not the joint probability of getting there.
	 */
	reachAt(node: number, board: number, player: 0 | 1): Float64Array;
	/**
	 * The spot that starts at a node: the board as dealt there, the pot and
	 * stacks as they stand, and each player's range as `reachAt` gives it.
	 * Defining and solving it re-solves that part of the game, typically with
	 * more bet sizes than the whole spot could afford.
	 *
	 * This is unsafe re-solving: the subgame is solved for the ranges that
	 * arrive, so its strategy can be exploited in ways the original solution
	 * did not allow for. It answers "how should these ranges play from here"
	 * well; it does not make the earlier streets any more accurate.
	 *
	 * @param node a decision that opens a betting round after the first, or the root
	 * @param board the board index at that node's round
	 * @param betting overrides; unset, the original spot's betting carries over
	 */
	subgameAt(node: number, board: number, betting?: SubgameBetting): SpotConfig;
	readonly history: readonly Progress[];
}

/** Betting for a subgame; anything unset keeps the original spot's. */
export type SubgameBetting = Partial<
	Pick<
		SpotConfig,
		'betSizes' | 'raiseSizes' | 'maxRaises' | 'allowAllIn' | 'allInThreshold' | 'noDonk' | 'mergeSizes' | 'maxCombos' | 'maxBytes'
	>
>;

export interface StrategyView {
	readonly node: number;
	readonly board: number;
	readonly player: 0 | 1;
	readonly actions: readonly string[];
	readonly combos: Uint16Array;
	/** Row-major `combos.length * actions.length`. */
	readonly probs: Float64Array;
}

/** An in-progress solve the caller drives. */
export interface SolveRun {
	readonly spot: Spot;
	/** Iterations completed so far, by this run; a warm start's are not counted. */
	readonly completed: number;
	/** Iterations behind the strategy, counting any a warm start inherited. */
	readonly totalIterations: number;
	/** Which traversal runs: the WebAssembly engine or the JavaScript one. */
	readonly engine: 'wasm' | 'js';
	/** What a warm start carried over, or null without one. */
	readonly warmStart: WarmStartReport | null;
	/** Run `count` more iterations. */
	step(count: number): void;
	/** Distance from equilibrium as a percentage of the pot. */
	exploitabilityPercent(): number;
	/**
	 * Exploitability in the real game, every card dealt, as a percentage of
	 * the pot. The same as `exploitabilityPercent()` unless `runoutBuckets`
	 * folded cards that are not exact mirror images; then the strategy is
	 * copied onto every real runout of an unbucketed spot and measured there,
	 * which costs that spot's memory and one best-response pass over it.
	 */
	trueExploitabilityPercent(): number;
	/** A view of the strategy as it stands; cheap, take a fresh one each time. */
	snapshot(history?: readonly Progress[], stoppedAt?: 'target' | 'iterations'): Solution;
	/** Release worker threads. Snapshots taken before this stay usable. */
	close(): void;
	/** Worker threads actually in use; 1 when single-threaded. */
	readonly workers: number;
	/** The underlying solver, for per-node analysis once solving is done. */
	readonly solver: Solver;
}

/**
 * Prepare a solve without running it.
 *
 * Stepping costs nothing over one long call — the work per iteration is
 * identical — and it is what lets a caller report progress or stop early while
 * keeping the partial answer.
 *
 * @param spot from {@link defineSpot}
 * @param options solver setup
 */
export function createRun(spot: Spot, options: SolveOptions = {}): SolveRun {
	if (options.analysisOnly && options.approximations?.currentProfileEv) {
		throw new Error('approximations.currentProfileEv needs regrets, and an analysisOnly run has none');
	}
	// A saved strategy is loaded as float32 sums, so analysis stays there.
	const maxBytes = spot.source.maxBytes ?? DEFAULT_MAX_BYTES;
	const { totalSlots, bytes } = spot.estimate;
	const precision: Precision = options.analysisOnly
		? 'f32'
		: options.precision ??
			(bytes <= maxBytes ? 'f32' : 'i16');

	// Planned before anything is allocated, so a bad option or a coarse spot
	// that does not fit fails here; solved only once the real run exists.
	const coarsePlan = planCoarseStart(spot, options, precision, maxBytes);

	// Hands neither player holds never carry reach, so they need no ranking.
	const relevant = new Uint8Array(COMBOS);
	for (const combo of spot.players[0].combos) relevant[combo] = 1;
	for (const combo of spot.players[1].combos) relevant[combo] = 1;

	const showdown = buildShowdownTable(spot.runouts, relevant);
	const layout = buildLayout(spot.tree, spot.runouts, spot.players, PRECISION_BYTES[precision]);
	const weights = runoutWeights(spot.runouts);

	// The WebAssembly engine, where it applies: 32-bit storage and a platform
	// with WebAssembly SIMD. Decided before the thread count, because the
	// browser build can only thread the engine.
	const wantsEngine =
		options.engine !== 'js' && precision === 'f32' && !options.analysisOnly && options.simd !== false;
	// Sampling's state is one thread's; see `Approximations.chanceSampling`.
	const samplingOptions = options.approximations?.chanceSampling;
	const requested = samplingOptions ? 1 : resolveWorkers(options, wantsEngine);
	const plan = requested > 1 ? planShards(spot.tree, spot.runouts, requested) : null;

	// Workers need the accumulators in shared memory. Allocating shared for a
	// single-threaded solve would cost nothing but buys nothing either.
	const allocate = (bytes: number): ArrayBuffer | SharedArrayBuffer =>
		plan ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
	const width = PRECISION_BYTES[precision];
	const quantised = precision === 'i16';

	const active = buildActiveLists(spot.runouts, spot.players, showdown);
	const hands = buildHandSpace(spot.runouts, spot.players, active);
	if (samplingOptions && quantised) throw new Error('chanceSampling needs 32- or 64-bit storage');
	const samplingPlan = samplingOptions ? planSampling(spot.tree, spot.runouts, active, layout, samplingOptions) : undefined;
	// Measured as the precision choice above measures storage: by the estimate.
	const storageBytes = Math.max(bytes, layout.bytes);
	if (samplingPlan && storageBytes + samplingBytes(samplingPlan) > maxBytes) {
		throw new Error(
			`chanceSampling needs ${Math.ceil(samplingBytes(samplingPlan) / 2 ** 20)} MiB of baselines beside ` +
				`${Math.ceil(storageBytes / 2 ** 20)} MiB of storage, over maxBytes; sample fewer rounds or raise maxBytes`,
		);
	}
	// The engine owns the storage; the context sees it through views.
	const engine = wantsEngine
		? createEngine(
				{
					tree: spot.tree, runouts: spot.runouts, players: spot.players, layout, active, hands,
					runoutWeight: weights, chipScale: spot.chipScale, sampling: samplingPlan,
				},
				plan ? { plan, threads: requested, spawn: spawnEngineWorker } : undefined,
			)
		: null;
	const ctx: Context = {
		tree: spot.tree,
		runouts: spot.runouts,
		players: spot.players,
		layout,
		showdown,
		regret: engine
			? engine.regret
			: options.analysisOnly
				? new Float32Array(0)
				: makeRegretStore(precision, allocate(layout.totalSlots * width)),
		strategySum: engine ? engine.strategySum : makeSumStore(precision, allocate(layout.totalSlots * width)),
		regretScale: quantised ? new Float64Array(allocate(layout.blocks * 8)) : null,
		sumScale: quantised ? new Float64Array(allocate(layout.blocks * 8)) : null,
		scratch: makeTerminalScratch(),
		chipScale: spot.chipScale,
		active,
		hands,
		runoutWeight: weights,
		shardStart: 0,
		shardEnd: plan ? plan.boards : 0,
		shardRound: plan ? plan.round : -1,
		applyUpdates: true,
		chanceCollect: null,
		chanceOverride: null,
		entryIndexOf: plan ? plan.entryIndexOf : null,
		expandOrbits: false,
		simd: options.simd ?? true,
		// The traversal sums over every runout, so the denominator has to count
		// them too: a hand pair is dealt once per compatible completion, not
		// once. With a river board that factor is 1, which is exactly why this
		// is easy to miss.
		totalMass: matchupMass(spot.players[0].weights, spot.players[1].weights) * weights[0],
		dcfr: (options.algorithm ?? 'dcfr') === 'dcfr',
	};
	if (samplingPlan) ctx.sampling = makeSampling(samplingPlan, engine?.sampling ?? undefined);

	// Seeded before any worker starts, so they all see the inherited values.
	let warm: WarmStartReport | null = null;
	let offset = 0;
	let solver: Solver;
	let pool: Pool | null;
	try {
		if (options.warmCards && !options.warmStart) {
			throw new Error('`warmCards` relabels a warm start, so it needs `warmStart` too');
		}
		if (options.warmStart) {
			const source = options.warmStart;
			warm = options.warmCards
				? warmStart(ctx, source.solver.ctx, false, options.warmCards)
				: warmStart(ctx, source.solver.ctx, sameSpot(spot.source, source.spot.source));
			offset = options.warmIteration ?? source.totalIterations;
		} else if (coarsePlan && coarsePlan.iterations > 0) {
			// Regrets only: the bucketed game's average would have to be outweighed.
			const coarse = solveCoarse(coarsePlan, options);
			try {
				warm = warmStart(ctx, coarse.solver.ctx, false);
			} finally {
				coarse.close();
			}
			offset = options.warmIteration ?? coarse.totalIterations;
		}
		// Inherited accumulators are discounted up to where the count resumes.
		if (warm) ctx.sampling?.lastUpdate.fill(offset);

		solver = makeSolver(ctx);
		if (warm && coarsePlan) coarseMs.set(solver, coarsePlan.elapsed);
		// The engine runs its own threads; the JavaScript pool is for the rest.
		pool = plan && !engine
			? startPool(ctx, solver, plan, { config: spot.source, dcfr: ctx.dcfr, precision, approximations: options.approximations, simd: ctx.simd }, requested)
			: null;
	} catch (error) {
		// The engine's threads would otherwise stay parked on this run for good.
		engine?.close();
		throw error;
	}
	if (pool) solver.useRoot(pool.traverse);
	if (engine) solver.useRoot(engine.root(ctx.dcfr));
	const threadCount = pool ? pool.workers : engine ? engine.threads : 1;
	let completed = 0;

	return {
		spot,
		solver,
		workers: threadCount,
		get completed() {
			return completed;
		},
		warmStart: warm,
		engine: engine ? 'wasm' : 'js',
		get totalIterations() {
			return offset + completed;
		},
		step(count) {
			if (count <= 0) return;
			solver.iterate(count, offset + completed);
			completed += count;
		},
		close() {
			// Snapshots stay usable afterwards, on this thread alone.
			solver.useRoot(null);
			pool?.close();
			engine?.close();
		},
		exploitabilityPercent() {
			return (100 * solver.exploitability()) / (spot.potUnits / spot.chipScale);
		},
		trueExploitabilityPercent() {
			if (!spot.runouts.approximate) return this.exploitabilityPercent();
			const real = createRun(defineSpot({ ...spot.source, runoutBuckets: false }), {
				workers: threadCount,
				precision,
			});
			try {
				warmStart(real.solver.ctx, ctx, true);
				return real.exploitabilityPercent();
			} finally {
				real.close();
			}
		},
		snapshot(history = [], stoppedAt = 'iterations') {
			return makeSolution(
				spot, ctx, solver, completed, offset + completed, [...history], stoppedAt, threadCount,
				options.approximations?.currentProfileEv === true,
			);
		},
	};
}

/** Bucket gap of the coarse spot when `CoarseStart.runoutBuckets` is unset. */
const DEFAULT_COARSE_GAP = 3;

/** A coarse start to run: its spot and settings, and once solved, how long it took. */
interface CoarsePlan {
	readonly spot: Spot;
	readonly iterations: number;
	readonly precision: Precision;
	elapsed: number;
}

/** Milliseconds a run's coarse start took, by the real run's solver, for `solve()`'s clock. */
const coarseMs = new WeakMap<Solver, number>();

/**
 * Validate `approximations.coarseStart` and define its spot, or null when
 * there is nothing to solve: the option unset, no iterations, or bucketing
 * folds no more runouts than the spot itself does.
 *
 * The coarse spot must fit in what `maxBytes` leaves beside the real one,
 * since both are in memory at the switch; at 32 bits if it can, else 16.
 */
function planCoarseStart(spot: Spot, options: SolveOptions, precision: Precision, maxBytes: number): CoarsePlan | null {
	const settings = options.approximations?.coarseStart;
	if (!settings) return null;
	const { iterations, runoutBuckets = DEFAULT_COARSE_GAP } = settings;
	if (!(Number.isInteger(iterations) && iterations >= 0)) {
		throw new Error(`coarseStart.iterations must be a whole number of iterations; got ${iterations}`);
	}
	if (!(Number.isInteger(runoutBuckets) && runoutBuckets >= 1)) {
		throw new Error(`coarseStart.runoutBuckets must be a rank gap of 1 or more; got ${runoutBuckets}`);
	}
	if (options.warmStart) throw new Error('coarseStart is a warm start of its own; give one or the other, not both');
	if (options.analysisOnly) throw new Error('coarseStart solves; an analysis-only run must never be stepped');

	// Never a narrower gap than the spot already uses, and only a wider one helps.
	const own = spot.source.runoutBuckets;
	const ownGap = own === true ? DEFAULT_BUCKET_GAP : own || 0;
	if (iterations === 0 || spot.board.length === 5 || runoutBuckets <= ownGap) return null;
	const coarseSpot = defineSpot({ ...spot.source, runoutBuckets });
	if (coarseSpot.runouts.counts.at(-1)! >= spot.runouts.counts.at(-1)!) return null;

	const used = precision === 'i16' ? spot.estimate.compressedBytes : spot.estimate.bytes * (precision === 'f64' ? 2 : 1);
	const left = maxBytes - used;
	const coarsePrecision: Precision =
		options.precision ?? (coarseSpot.estimate.bytes <= left ? 'f32' : 'i16');
	const needs =
		coarsePrecision === 'i16'
			? coarseSpot.estimate.compressedBytes
			: coarseSpot.estimate.bytes * (coarsePrecision === 'f64' ? 2 : 1);
	if (needs > left) {
		throw new Error(
			`coarseStart needs ~${formatBytes(needs)} beside this spot's ~${formatBytes(used)}, ` +
				`over the ${formatBytes(maxBytes)} limit; raise maxBytes or leave coarseStart off`,
		);
	}
	return { spot: coarseSpot, iterations, precision: coarsePrecision, elapsed: 0 };
}

/** Solve a planned coarse start, returning the run to warm-start from. */
function solveCoarse(plan: CoarsePlan, options: SolveOptions): SolveRun {
	const started = Date.now();
	const { coarseStart: _, ...rest } = options.approximations!;
	const run = createRun(plan.spot, {
		workers: options.workers,
		precision: plan.precision,
		algorithm: options.algorithm,
		simd: options.simd,
		engine: options.engine,
		approximations: rest,
	});
	try {
		run.step(plan.iterations);
	} catch (error) {
		run.close();
		throw error;
	}
	plan.elapsed = Date.now() - started;
	return run;
}

/**
 * Whether two configurations describe the very same game. Limits and how
 * runouts are stored do not change the game, so they are left out.
 */
function sameSpot(a: SpotConfig, b: SpotConfig): boolean {
	const plain = ({ maxBytes: _bytes, maxCombos: _combos, isomorphism: _iso, ...game }: SpotConfig): string =>
		JSON.stringify(game, (_, value: unknown) => (value instanceof Float64Array ? Array.from(value) : value));
	return plain(a) === plain(b);
}

/** Largest rank distance within a runout bucket, for `runoutBuckets: true`. */
const DEFAULT_BUCKET_GAP = 1;

/** Rank swaps that keep every hand of both ranges in its range. */
function rangeRankMerge(players: readonly [PlayerIndex, PlayerIndex], maxGap: number): RunoutMerge {
	const allowed = new Uint8Array(13 * 13);
	for (let a = 0; a < 13; a++) {
		for (let b = a; b < 13; b++) {
			const map = rankSwap(a, b);
			let ok = true;
			for (const player of players) {
				for (let i = 0; ok && i < player.count; i++) {
					const combo = player.combos[i];
					const image = comboIndex(map[COMBO_CARDS[combo * 2]], map[COMBO_CARDS[combo * 2 + 1]]);
					if (player.slot[image] < 0) ok = false;
				}
			}
			allowed[a * 13 + b] = allowed[b * 13 + a] = ok ? 1 : 0;
		}
	}
	return { ranks: (a, b) => allowed[a * 13 + b] === 1, maxGap };
}

const threadWarnings = new Set<string>();

/**
 * Threads a run will use. Anything above what the platform can run now falls
 * back to what it can, with one warning per reason: the browser build threads
 * only the WebAssembly engine, and only after `enableThreads` from
 * `poker-flopsolve/threads` has started its workers.
 * @param options solver tuning
 * @param engine whether the WebAssembly engine is to run
 */
function resolveWorkers(options: SolveOptions, engine: boolean): number {
	if (options.analysisOnly) return 1;
	const asked = options.workers === 'auto' ? defaultWorkerCount() : (options.workers ?? 1);
	const limit = threadLimit(engine);
	if (asked > limit) {
		const advice = threadAdvice(engine);
		if (!threadWarnings.has(advice)) {
			threadWarnings.add(advice);
			console.warn(`poker-flopsolve: ${asked} threads asked for, solving on ${limit} (${PLATFORM} build): ${advice}`);
		}
		return limit;
	}
	return asked;
}

/** View a buffer as regret storage of the given precision. */
export function makeRegretStore(precision: Precision, buffer: ArrayBuffer | SharedArrayBuffer): RegretStore {
	if (precision === 'f64') return new Float64Array(buffer);
	return precision === 'f32' ? new Float32Array(buffer) : new Int16Array(buffer);
}

/** View a buffer as strategy-sum storage of the given precision. */
export function makeSumStore(precision: Precision, buffer: ArrayBuffer | SharedArrayBuffer): SumStore {
	if (precision === 'f64') return new Float64Array(buffer);
	return precision === 'f32' ? new Float32Array(buffer) : new Uint16Array(buffer);
}

/**
 * Solve a prepared spot.
 * @param spot from {@link defineSpot}
 * @param options solver tuning
 */
export function solve(spot: Spot, options: SolveOptions = {}): Solution {
	const iterations = options.iterations ?? 500;
	const target = options.targetPercent ?? 0;
	const fixed = options.exploitEvery ?? 0;
	const run = createRun(spot, options);
	const history: Progress[] = [];
	// A coarse start solves inside createRun, and that is solving time too.
	const started = Date.now() - (coarseMs.get(run.solver) ?? 0);
	// Where DCFR's count stands before this run's first iteration, for
	// predicting the target; only a coarse start shifts it, as a warm start's
	// checks were always scheduled from zero.
	const before = coarseMs.has(run.solver) ? run.totalIterations : 0;

	try {
		return runAll();
	} finally {
		run.close();
	}

	function runAll(): Solution {
		// Nothing to measure for: run straight through in one call.
		if (fixed <= 0 && target <= 0) {
			run.step(iterations);
			return run.snapshot(history, 'iterations');
		}

		let stoppedAt: 'target' | 'iterations' = 'iterations';
		let done = 0;
		let next = fixed > 0 ? fixed : Math.min(iterations, FIRST_CHECK);
		let prevIteration = 0;
		let prevExploitability = 0;

		while (done < iterations) {
			const until = Math.min(next, iterations);
			run.step(until - done);
			done = until;

			// One snapshot, because it caches the best-response pass that both
			// of these read. Two calls on the run itself would pay for it twice.
			const measured = run.snapshot();
			const info: Progress = {
				iteration: done,
				exploitability: measured.exploitability(),
				elapsedMs: Date.now() - started,
			};
			history.push(info);
			options.onProgress?.(info);

			if (target > 0 && measured.exploitabilityPercent() <= target) {
				stoppedAt = 'target';
				break;
			}

			if (fixed > 0) {
				next = done + fixed;
			} else {
				// Aim just short of where the target is predicted to be met, so
				// the overshoot is a few iterations rather than a whole doubling.
				const predicted = predictCrossing(
					before + prevIteration,
					prevExploitability,
					before + done,
					info.exploitability,
					(target * spot.potUnits) / (100 * spot.chipScale),
				);
				const aim = predicted > 0 ? predicted * 0.95 - before : done * MAX_GROWTH;
				const bounded = Math.min(Math.max(aim, done * MIN_GROWTH), done * MAX_GROWTH);
				next = Math.max(done + 1, Math.ceil(bounded));
				prevIteration = done;
				prevExploitability = info.exploitability;
			}
		}
		return run.snapshot(history, stoppedAt);
	}
}

/** Iterations before the first exploitability check. */
const FIRST_CHECK = 10;

/** Bounds on how far ahead the next check may be scheduled. */
const MIN_GROWTH = 1.1;
const MAX_GROWTH = 2;

/**
 * Predict the iteration at which exploitability will reach `target`.
 *
 * CFR+ exploitability falls as roughly `C / T^p`, so two measurements pin both
 * constants and the crossing follows. This beats any fixed cadence badly enough
 * to be worth the eight lines: a check is a full best-response pass for both
 * players, as costly as an iteration.
 *
 * Returns 0 when the two points say nothing useful — equal values, a rise, or a
 * non-finite fit — and the caller falls back to stepping the gap up.
 *
 * Exported because the browser UI drives its own loop, to stay stoppable, and
 * should schedule its checks the same way rather than reinventing a cadence.
 * Unit-agnostic: `e1`, `e2` and `target` need only share units.
 */
export function predictCrossing(
	t1: number,
	e1: number,
	t2: number,
	e2: number,
	target: number,
): number {
	if (!(e1 > e2) || !(e2 > 0) || t2 <= t1) return 0;
	const p = Math.log(e1 / e2) / Math.log(t2 / t1);
	if (!(p > 0)) return 0;
	const predicted = t2 * (e2 / target) ** (1 / p);
	return Number.isFinite(predicted) ? predicted : 0;
}

function makeSolution(
	spot: Spot,
	ctx: Context,
	solver: Solver,
	iterations: number,
	totalIterations: number,
	history: Progress[],
	stoppedAt: 'target' | 'iterations',
	workers: number,
	currentProfileEv: boolean,
): Solution {
	const { tree } = spot;
	const parent = new Int32Array(tree.nodeCount).fill(-1);
	const viaEdge = new Int32Array(tree.nodeCount).fill(-1);
	for (let node = 0; node < tree.nodeCount; node++) {
		for (let e = 0; e < tree.numEdges[node]; e++) {
			const edge = tree.firstEdge[node] + e;
			parent[tree.edgeChild[edge]] = node;
			viaEdge[tree.edgeChild[edge]] = edge;
		}
	}

	const label = (edge: number): string => {
		const kind = tree.edgeAction[edge];
		const amount = tree.edgeTarget[edge] / spot.chipScale;
		return kind >= ActionKind.Bet ? `${ACTION_LABELS[kind]} ${amount}` : ACTION_LABELS[kind];
	};

	const reachAt = (node: number, board: number, player: 0 | 1): Float64Array => {
		const index = spot.players[player];
		const reach = new Float64Array(COMBOS);
		for (let i = 0; i < index.count; i++) reach[index.combos[i]] = index.weights[index.combos[i]];
		const round = tree.round[node];

		for (let current = node; parent[current] >= 0; current = parent[current]) {
			const owner = parent[current];
			if (tree.kind[owner] !== NodeKind.Decision || tree.player[owner] !== player) continue;
			const at = boardAtRound(spot.runouts, board, round, tree.round[owner]);
			const { actions, probs } = solver.averageStrategyAt(owner, at);
			const action = viaEdge[current] - tree.firstEdge[owner];
			for (let i = 0; i < index.count; i++) reach[index.combos[i]] *= probs[i * actions + action];
		}
		return reach;
	};

	// One pass per player serves `ev` and `handEvs` alike.
	let cachedEv: RootValues | null = null;
	const rootValues = (): RootValues =>
		(cachedEv ??= solver.rootValues(currentProfileEv ? Mode.Current : Mode.Average));
	const cachedHands: [Float64Array | null, Float64Array | null] = [null, null];
	let cachedExploit: number | null = null;

	return {
		spot,
		iterations,
		totalIterations,
		stoppedAt,
		workers,
		solver,
		history,
		ev(player) {
			return rootValues().totals[player];
		},
		handEvs(player) {
			cachedHands[player] ??= solver.handEvs(player, rootValues().values[player]);
			return cachedHands[player].slice();
		},
		exploitability() {
			cachedExploit ??= solver.exploitability();
			return cachedExploit;
		},
		exploitabilityPercent() {
			cachedExploit ??= solver.exploitability();
			return (100 * cachedExploit) / (spot.potUnits / spot.chipScale);
		},
		strategyAt(node, board) {
			if (tree.kind[node] !== NodeKind.Decision) throw new Error(`Node ${node} is not a decision`);
			const owner = tree.player[node] as 0 | 1;
			const { actions, probs } = solver.averageStrategyAt(node, board);
			const names: string[] = [];
			for (let a = 0; a < actions; a++) names.push(label(tree.firstEdge[node] + a));
			return { node, board, player: owner, actions: names, combos: spot.players[owner].combos, probs };
		},
		path(node) {
			const steps: string[] = [];
			let current = node;
			while (parent[current] >= 0) {
				const owner = parent[current];
				steps.push(tree.kind[owner] === NodeKind.Decision ? label(viaEdge[current]) : '/');
				current = owner;
			}
			return steps.reverse().join(' ') || '(root)';
		},
		reachAt,
		subgameAt(node, board, betting = {}) {
			const opensRound = node === 0 || (parent[node] >= 0 && tree.kind[parent[node]] === NodeKind.Chance);
			if (tree.kind[node] !== NodeKind.Decision || !opensRound) {
				throw new Error(`Node ${node} does not open a betting round; a subgame must start where one does`);
			}
			const round = tree.round[node];
			if (board < 0 || board >= spot.runouts.counts[round]) {
				throw new Error(`Board ${board} is out of range for round ${round}`);
			}

			// A round opens with both players level, so what is in the middle
			// is dead money from here on and the stacks have shrunk equally.
			const width = spot.runouts.width[round];
			const cards = spot.runouts.cards[round].subarray(board * width, board * width + width);
			const invested = (tree.pot[node] - spot.potUnits) / 2;
			const { source } = spot;
			// Settings given per round lose the rounds already played.
			const later = <T>(value: T | readonly T[], listed: boolean): T | readonly T[] =>
				listed && (value as readonly T[]).length > 1 ? (value as readonly T[]).slice(round) : value;
			// Each player's side of a setting loses the played rounds alike.
			const laterEach = <T>(value: PerPlayer<T> | undefined, listed: (side: T) => boolean): PerPlayer<T> | undefined =>
				value === undefined ? undefined : (mapPlayers(value, (side) => later(side, listed(side)) as T) as PerPlayer<T>);
			const rows = laterEach(source.betSizes, () => true) as SpotConfig['betSizes'];
			const raiseRows = laterEach(source.raiseSizes, (side) => side !== undefined && raisesPerRound(side));

			return {
				board: formatCards(cards),
				pot: tree.pot[node] / spot.chipScale,
				stack: (spot.stackUnits - invested) / spot.chipScale,
				oop: reachAt(node, board, 0),
				ip: reachAt(node, board, 1),
				betSizes: betting.betSizes ?? rows,
				raiseSizes: 'raiseSizes' in betting ? betting.raiseSizes : raiseRows,
				maxRaises: betting.maxRaises ?? laterEach(source.maxRaises, Array.isArray),
				allowAllIn: betting.allowAllIn ?? laterEach(source.allowAllIn, Array.isArray),
				allInThreshold: 'allInThreshold' in betting ? betting.allInThreshold : laterEach(source.allInThreshold, Array.isArray),
				noDonk: 'noDonk' in betting ? betting.noDonk : source.noDonk === undefined ? undefined : later(source.noDonk, Array.isArray(source.noDonk)),
				mergeSizes: 'mergeSizes' in betting ? betting.mergeSizes : source.mergeSizes,
				minWeight: source.minWeight,
				isomorphism: source.isomorphism,
				maxCombos: 'maxCombos' in betting ? betting.maxCombos : source.maxCombos,
				maxBytes: 'maxBytes' in betting ? betting.maxBytes : source.maxBytes,
				chipScale: spot.chipScale,
			};
		},
	};
}

export { formatCards, parseCards };
