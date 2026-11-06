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
import { DEFAULT_MAX_BYTES, PLATFORM, spawnEngineWorker, THREADS_AVAILABLE } from './platform/node.ts';
import type { Context, PlayerIndex, RegretStore, Solver, SumStore } from './cfr.ts';
import {
	buildActiveLists,
	buildLayout,
	buildPlayerIndex,
	makeSolver,
	makeTerminalScratch,
	matchupMass,
	runoutWeights,
} from './cfr.ts';

export * from './cards.ts';
export * from './eval7.ts';
export { activeCombos, parseRange, rangeWeight } from './range.ts';
export type { ResolvedBoard } from './runouts.ts';
export type { WarmStartReport } from './warm.ts';
export { simdAvailable } from './kernels.ts';
export type { BetSize } from './tree.ts';
export type { Solver } from './cfr.ts';
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
	 * The browser build is single-threaded: any count resolves to 1 there.
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
	 */
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
	/** Chips per hand for a player, under the average strategy. */
	ev(player: 0 | 1): number;
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
	// A saved strategy is loaded as float32 sums, so analysis stays there.
	const maxBytes = spot.source.maxBytes ?? DEFAULT_MAX_BYTES;
	const { totalSlots, bytes } = spot.estimate;
	const precision: Precision = options.analysisOnly
		? 'f32'
		: options.precision ??
			(bytes <= maxBytes ? 'f32' : 'i16');

	// Hands neither player holds never carry reach, so they need no ranking.
	const relevant = new Uint8Array(COMBOS);
	for (const combo of spot.players[0].combos) relevant[combo] = 1;
	for (const combo of spot.players[1].combos) relevant[combo] = 1;

	const showdown = buildShowdownTable(spot.runouts, relevant);
	const layout = buildLayout(spot.tree, spot.runouts, spot.players, PRECISION_BYTES[precision]);
	const weights = runoutWeights(spot.runouts);

	const requested = resolveWorkers(options);
	const plan = requested > 1 ? planShards(spot.tree, spot.runouts, requested) : null;

	// Workers need the accumulators in shared memory. Allocating shared for a
	// single-threaded solve would cost nothing but buys nothing either.
	const allocate = (bytes: number): ArrayBuffer | SharedArrayBuffer =>
		plan ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
	const width = PRECISION_BYTES[precision];
	const quantised = precision === 'i16';

	const active = buildActiveLists(spot.runouts, spot.players, showdown);
	const hands = buildHandSpace(spot.runouts, spot.players, active);
	// The WebAssembly engine, where it applies: one thread, 32-bit storage,
	// a platform with WebAssembly SIMD. It owns the storage; the context sees
	// it through views.
	const engine =
		options.engine !== 'js' && precision === 'f32' && !options.analysisOnly && options.simd !== false
			? createEngine(
					{
						tree: spot.tree, runouts: spot.runouts, players: spot.players, layout, active, hands,
						runoutWeight: weights, chipScale: spot.chipScale,
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

	// Seeded before any worker starts, so they all see the inherited values.
	let warm: WarmStartReport | null = null;
	let offset = 0;
	if (options.warmStart) {
		const source = options.warmStart;
		warm = warmStart(ctx, source.solver.ctx, sameSpot(spot.source, source.spot.source));
		offset = options.warmIteration ?? source.totalIterations;
	}

	const solver = makeSolver(ctx);
	// The engine runs its own threads; the JavaScript pool is for the rest.
	const pool: Pool | null = plan && !engine
		? startPool(ctx, solver, plan, { config: spot.source, dcfr: ctx.dcfr, precision, approximations: options.approximations, simd: ctx.simd }, requested)
		: null;
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
			return makeSolution(spot, ctx, solver, completed, offset + completed, [...history], stoppedAt, threadCount);
		},
	};
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

let warnedThreads = false;

/**
 * Threads a run will use. The browser build has none to offer, so anything
 * above one falls back to the calling thread, with a single warning.
 */
function resolveWorkers(options: SolveOptions): number {
	if (options.analysisOnly) return 1;
	const asked = options.workers === 'auto' ? defaultWorkerCount() : (options.workers ?? 1);
	if (asked > 1 && !THREADS_AVAILABLE) {
		if (!warnedThreads) {
			warnedThreads = true;
			console.warn(`poker-flopsolve: worker threads are Node-only; solving on one thread (${PLATFORM} build)`);
		}
		return 1;
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
	const started = Date.now();

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
					prevIteration,
					prevExploitability,
					done,
					info.exploitability,
					(target * spot.potUnits) / (100 * spot.chipScale),
				);
				const aim = predicted > 0 ? predicted * 0.95 : done * MAX_GROWTH;
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

	let cachedEv: [number, number] | null = null;
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
			cachedEv ??= solver.expectedValue();
			return cachedEv[player];
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
