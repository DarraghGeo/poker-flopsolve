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
import { actionLabel, buildTree, forPlayer, mapPlayers, NodeKind, raisesPerRound } from './tree.ts';
import type { Runouts } from './runouts.ts';
import type { ResolvedBoard } from './runouts.ts';
export { rankSwap } from './runouts.ts';
import type { RunoutMerge } from './runouts.ts';
import { boardAtRound, enumerateRunouts, rankSwap, resolveBoard } from './runouts.ts';
import { suitSymmetries } from './abstraction.ts';
import { activeCombos, parseRange } from './range.ts';
import { buildShowdownTable } from './showdown.ts';
import { buildHandSpace } from './hands.ts';
import { createEngine, threadProfiles } from './engine.ts';
import type { WasmStorage } from './engine.ts';
import type { WarmStartReport } from './warm.ts';
import { warmStart } from './warm.ts';
import type { SettleOptions } from './settle.ts';
import { settlePlan, trackSettle } from './settle.ts';
import { aliasHistories } from './history-merge.ts';
import { betRows, DEFAULT_CHIP_SCALE, treeConfig } from './betting.ts';
import type { Pool } from './parallel.ts';
import { defaultWorkerCount, planShards, startPool } from './parallel.ts';
import { DEFAULT_MAX_BYTES, PLATFORM, spawnEngineWorker, threadAdvice, threadLimit } from './platform/node.ts';
import type { CompactPlan, Context, Layout, PlayerIndex, RegretStore, RootValues, SamplingOptions, Solver, SumStore } from './cfr.ts';
import {
	buildActiveLists,
	buildLayout,
	buildPlayerIndex,
	makeSampling,
	planSampling,
	sampledRounds,
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
export { resolveSubgame } from './resolve.ts';
export { rootPlay, rootPlayMovement, rootPlayNodes, trackSettle } from './settle.ts';
export type { RootPlay, SettleOptions, SettleTracker } from './settle.ts';
export { linesWithin, turnLineReach } from './hybrid.ts';
export type { LineReach, LinesWithinOptions } from './hybrid.ts';
export type { ResolvedSubgame, ResolveOptions } from './resolve.ts';
export { simdAvailable } from './kernels.ts';
export type { BetSize } from './tree.ts';
export type { SamplingOptions, Solver } from './cfr.ts';
export type { WasmStorage } from './engine.ts';
export { ACTION_LABELS, ActionKind, NodeKind } from './tree.ts';
export type { PerPlayer, RaiseSizes } from './tree.ts';
/** 'node' or 'browser': which build is running. */
export { PLATFORM } from './platform/node.ts';

/** Measured throughput on a warm run, used only to project solve time. */
const OPS_PER_SECOND = 2e8;

/** A spot to solve. */
export interface SpotConfig {
	/** 3, 4 or 5 cards, e.g. "AsKh7d" or "As Kh 7d 2c". */
	readonly board: string;
	/** Dead money already in the middle, in chips. */
	readonly pot: number;
	/**
	 * The pot `Solution.ev` and `Solution.handEvs` are percentages of, in
	 * chips. Default `pot`. `Solution.subgameAt` sets it to the original
	 * spot's, so a re-solved turn or river reports in the flop pot and its
	 * values read the same way as the flop's down a hand.
	 */
	readonly evPot?: number;
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
	/**
	 * Bets, raises and shoves to cut from the tree, with everything below
	 * them: each the readable path of the node the action leads to, exactly as
	 * `Solution.path` writes it — `"check bet 18.15"`, `"bet 41.25 raise
	 * 133.31"`, `"check check / bet 18.15"`, chips being the actor's total
	 * investment after the action and `/` a deal. Only the line named goes; the
	 * same size elsewhere stays. Checks, calls and folds cannot be cut, and a
	 * path that names no such action in the tree is refused.
	 *
	 * For a budgeted tree: keep three sizes where they earn their memory, one
	 * where they do not. A tree's memory is almost all on the river, and each
	 * flop or turn action multiplies the river subtrees below it, so cutting a
	 * line saves what its whole subtree stores. Default none; unset, the tree
	 * is the one the other settings build, unchanged.
	 */
	readonly removeActions?: readonly string[];
	/**
	 * Thin the bet sizes to a shape that keeps most of what the full ones are
	 * worth in a fraction of the memory. Every size stays at the root, where
	 * out of position opens the first round. Everywhere else a decision keeps
	 * one bet, raise or shove: the one nearest three quarters of the pot, a
	 * shove where that would be one. Opening the last round after an earlier
	 * round saw a bet, sizes above the pot and the shove stay as well.
	 *
	 * The shape is what growing sizes one at a time by their value per byte
	 * picked on As Kh 7d and Ks 9s 4s (issue #51). Measured on As Kh 7d, pot
	 * 55, stack 975, sizes 0.33 / 0.75 / 1.5 with shove-only raises and two
	 * aggressions: see the #51 entry in docs/APPROXIMATIONS.md for its memory and error.
	 * It is a fixed rule, so it costs nothing to apply. A subgame from
	 * `Solution.subgameAt` gets the full sizes back unless its betting sets
	 * this again, and then it is thinned as a tree of its own: bets on the
	 * streets before it do not count, so a river after a bet on the flop
	 * keeps only the 0.75 size, where the whole tree also kept its big sizes
	 * and shove. Default false; unset, the tree is unchanged.
	 */
	readonly thinSizes?: boolean;
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
	/**
	 * Share river storage between betting histories that reach the same pot,
	 * a lossy approximation for fitting a spot in memory (issue #49). Off by
	 * default.
	 *
	 * Every earlier line gets its own copy of the streets below it, yet with
	 * pot-fraction sizes many lines meet: check, bet, call and bet, call
	 * reach the same pot, and so does every raise line taken in either order.
	 * Their subtrees are identical, so their nodes keep one set of regrets and
	 * strategy sums. Each history is still walked with its own reach, so an
	 * iteration costs exactly what it did; only storage shrinks. On the
	 * three-size target spot (AsKh7d, pot 55, stack 975, sizes 33/75/150%, a
	 * 75% raise and all-in, three aggressions) 173 river starts collapse to 23
	 * and storage falls 5.9 times: 17.2 GiB to 2.9 at 32 bits, 8.7 to 1.5 at 16.
	 * There, at 16 bits, a Node solve peaked at 1.6 GiB on one thread and 2.0
	 * on four (30 s an iteration), and was 12% of pot exploitable after 150
	 * iterations.
	 *
	 * What is lost is recall: a player plays one strategy for every line that
	 * met, though the ranges each line brings differ. Each history's regret is
	 * weighted by how often the acting hand plays into it, which cut the cost
	 * fourfold against plain CFR's sum. Measured on AsKh7d, pot 55, stack
	 * 975, against the exact solve, 4 threads: with sizes 33/75/150%, an
	 * all-in raise and two aggressions, 5.8 GiB became 1.22 GiB, and after
	 * 400 iterations the strategy was 8.0% of pot exploitable, with
	 * per-combination root EVs 0.72% of pot off on average and 2.5% at worst
	 * (the exact solve: 0.28%). With one 50% size, 4.0% exploitable after
	 * 300 iterations, EVs 0.67% off on average and 6.8% at worst.
	 * Exploitability is measured in the full game, which the strategy covers
	 * node by node, so it is exact. Do not expect it to approach
	 * equilibrium: expect a strategy several percent of the pot from it, in
	 * a spot that otherwise does not fit.
	 *
	 * Two consequences of one block serving several histories, both part of
	 * the approximation: within an iteration, a history visited later plays
	 * the regrets an earlier one has already updated, so the result depends a
	 * little on the order of the tree; and under `algorithm: 'cfr+'` each
	 * history's update is clamped at zero on its own, rather than their sum.
	 * A spot with it can warm-start only from a solve that shares too.
	 *
	 * On issue #47's blueprint (issue #85; T's flop betting, one 0.75 bet on
	 * the turn and river with no raise, `runoutBuckets: 3`) it saves 4.1 times
	 * on rainbow, two-tone and monotone flops alike, because the flop's sizes
	 * and raises still meet at a few turn pots: 196 river decisions keep 44
	 * blocks. On AsKh7d 707 MiB becomes 173 at 32 bits, so the blueprint stays
	 * on the WebAssembly engine; in Chromium on 4 threads the tab peaked at
	 * 327 MiB, against 860 unshared. An iteration costs what an unshared one
	 * does (458 ms there). Exploitability stops falling near 2.7% of pot by
	 * 160 iterations and never reaches 0.3%; the root play goes on settling.
	 * Judged at the unshared blueprint's own per-action values (solved to
	 * 0.045%), after 300 iterations (138 s) its root play lost 0.011% of pot
	 * where the unshared blueprint's lost 0.008%, but at 60 s it was 0.054%:
	 * the unshared one needs 115 s to reach 0.3% itself. Per-hand root EVs
	 * came out 0.4–0.6% of pot from the unshared ones (2–3% at worst), and
	 * turns re-solved from it with T's betting gave the opponent 2.2–3.0% of
	 * their pot under the unshared ranges, against 0.5–0.7% from the unshared
	 * blueprint. `chanceSampling` composes: on one thread 238 ms an iteration,
	 * the root settled in 109 s, 453 MiB; on 4 threads (issue #99) 70 ms, the
	 * root settled in 33 s at the same iteration, 452 MiB. `coarseStart` composes
	 * but finds no coarser copy at a gap of 3. `bench/blueprint-share/` has
	 * the scripts and figures.
	 *
	 * Where a shared solve stops depends on its first few iterations (issue
	 * #105). A shared block plays one strategy for every history meeting in
	 * it, so the game has many stable points, and which one the solve settles
	 * on is decided early, when regret matching plays nearly pure. Any
	 * randomness then picks another: chance sampling, 8-bit stochastic
	 * rounding, even float rounding under CFR+. On #103's turn spot
	 * (exploitability 5.8% of pot), sampling at p 0.9 ended at 0.3–1.6%
	 * over six different sets of draws. On a second turn spot (0.7%) it
	 * changed nothing. On the blueprint above, neither sampling at p 0.9
	 * (2.9%) nor 8-bit stochastic storage (2.5%) moved the plateau beyond
	 * that spread, against 2.6% shared alone. Do not count on noise to
	 * lower it. Of the deterministic changes tried (other regret
	 * weighting, discount start, uniform play mixed into the first
	 * iterations), none was a reliable gain. `bench/share-noise/` has the
	 * measurements.
	 *
	 * `true` shares the river. See `ShareHistories` for the turn and for
	 * lossier buckets.
	 */
	readonly shareHistories?: boolean | ShareHistories;
	/**
	 * Store regrets and strategy sums at 8 bits — an approximation, off by
	 * default. See `CompactStorage`. Set here rather than on the solve because it
	 * decides how much memory the spot needs, which `maxBytes` is checked
	 * against when the spot is defined.
	 */
	readonly compactStorage?: CompactStorage;
}

/**
 * Compact storage (issue #50): accumulators as 8-bit integers, each hand on
 * each board scaled by its own power of two, instead of 32- or 16-bit
 * values. Regret matching and the average strategy both divide a hand's
 * values by their own total, so a per-hand scale cancels wherever a strategy
 * is read and costs only a byte per hand. Rounding is at random, with odds
 * set by the remainder, so every stored value is right on average; the
 * randomness is a hash of the slot and iteration, so a solve is deterministic
 * at any thread count.
 *
 * Two modes:
 *
 * - With strategy sums (the default): regrets and sums at 8 bits, about 2.75
 *   bytes a slot against 16-bit storage's 4 and 32-bit's 8. Measured, it
 *   converges like the full solve: on the bench flop (AsKh7d, one size) 0.18%
 *   of pot at 80 iterations against 0.18%, 0.058% at 160 against 0.052%; on
 *   the monotone flop with three sizes (Ks9s4s, issue #20's T₀) 1.87% at 160
 *   against 1.85%. Rounding the sums leaves a floor, near 0.03% of pot on the
 *   bench flop and 0.1% on a small, narrow-range spot. On issue #20's T₀
 *   (AsKh7d, three sizes, all-in raise, SPR 18), at 320 iterations it was
 *   0.81% of pot exploitable where 32-bit storage was 0.69%, per-hand root
 *   EVs 0.23% of pot off a 0.17% reference, every hand's preferred bet size
 *   kept, in 1.75 GiB where 32-bit storage took 5.1 and 16-bit 2.6. T itself
 *   takes 5.9 GiB, 16-bit storage 8.7.
 * - `sums: false`: no strategy sums, so each node's strategy, wherever one is
 *   read (`strategyAt`, `reachAt`, EVs, exploitability), is the current
 *   profile, the regret-matched strategy the next iteration plays. About 1.4
 *   bytes a slot, 1.03 with `blockScale`: T in 2.2 GiB. Per-hand root EVs stay as close as
 *   the average's, as `currentProfileEv` found, but the strategy is far more
 *   exploitable: 2 times at equal iterations on the bench flop, 5 to 8 times
 *   on deeper or narrower spots (T₀ monotone: 4.0% of pot at 320 iterations
 *   against 0.71%), and the bet size each hand prefers at the root agreed with
 *   the reference for 62-82% of the hands where it was clear, against all of
 *   them for the average. `algorithm: 'cfr+'`, whose current profile swings
 *   less, is the better rule for the strategy; DCFR's current profile gives
 *   the closer EVs (on T₀ monotone 0.55% of pot against the average's 1.19%,
 *   but 4.9% exploitable).
 *
 * Rounding regrets to 8 bits costs training almost nothing: with 32-bit
 * regrets and no sums (`float`) the same runs were no better.
 *
 * Training is otherwise the exact solve's; exploitability is measured
 * exactly, in the full tree. Storage is split in chunks under `chunkBytes`,
 * because browsers refuse a buffer of 2 GiB. Runs on the JavaScript engine
 * and its Node worker threads, where an iteration costs about 1.5 times a
 * 32-bit one, or on the WebAssembly engine, threads included, with
 * `SolveOptions.wasmStorage` (issue #84). Not with `analysisOnly`, which
 * loads float32 sums. `precision` sets the rounds before `from`; a warm
 * start, a coarse start or `runoutBuckets`' measure of the real game reads
 * and writes compact storage, rounded to nearest; `chanceSampling` applies
 * its DCFR catch-up to compact nodes too.
 *
 * With `shareHistories`, a node sharing another's storage shares its compact
 * storage too; together they fit issue #20's target T in 0.99 GiB (0.37
 * without sums). Measured on T₀ at 160 iterations, compact storage did not
 * add to sharing's own loss: 9.0% of pot exploitable against 9.5%, root EVs
 * 0.63% of pot off against 0.66%, and all clear bet-size choices kept
 * against 97%, in a third of the memory.
 *
 * What was measured and left out is with the other approximations, in the
 * comment inside `Approximations`.
 */
export interface CompactStorage {
	/**
	 * Keep 8-bit strategy sums, and with them the average strategy. Default
	 * true; false stores only regrets and plays the current profile.
	 */
	readonly sums?: boolean;
	/**
	 * With `sums: false`, one scale per node and board instead of one per
	 * hand: about 1.03 bytes a slot instead of 1.4. Under CFR+ it measured
	 * nearly as accurate (0.077% of pot against 0.064% on the bench flop at
	 * 320 iterations); under DCFR, whose large negative regrets then crowd
	 * the scale, clearly less (0.16% against 0.08%).
	 */
	readonly blockScale?: boolean;
	/**
	 * First round stored compactly, from the spot's first (0); earlier rounds
	 * keep 32-bit regrets and sums. Default 0. With `sums: false`, an earlier
	 * round's average above the current profile measured worse than the
	 * current profile throughout (0.053% of pot against 0.035% on the bench
	 * flop): the two come from different iterations.
	 */
	readonly from?: number;
	/**
	 * Largest single buffer to allocate, in bytes; storage is split in chunks
	 * no bigger, a node never split. Default 1 GiB: Chromium refuses an
	 * ArrayBuffer of 2 GiB, but gives several smaller ones.
	 */
	readonly chunkBytes?: number;
	/** For measurement: the largest regret magnitude stored, at most 127. */
	readonly steps?: number;
	/** For measurement: round regrets to nearest instead of at random. */
	readonly nearest?: boolean;
	/** For measurement, with `sums: false`: keep 32-bit regrets, dropping only the sums. */
	readonly float?: boolean;
}

/** See `SpotConfig.shareHistories`. */
export interface ShareHistories {
	/**
	 * Lines whose later streets keep storage of their own, each named as
	 * `Solution.path` names a node (a flop line opening the turn reads like
	 * `"check check /"`). Every node at or below a listed one is left out of
	 * sharing, and so is any round root above one. The rest share as
	 * before. Unset or empty, nothing is kept. A warm start into a spot that
	 * differs only here, keeping at least the lines its source keeps,
	 * carries the average strategy too, as for the same spot.
	 *
	 * What it is for (issue #101): a turn re-solved from a shared blueprint
	 * (`resolveSubgame`) inherits only the ranges the blueprint brings to
	 * it, and sharing distorts those. Its flop play is stored unshared, but
	 * it learns from river values that several histories share. Keeping the
	 * few most-reached flop lines unshared gives the flop exact values
	 * where most of the play is, and that straightens the ranges on the
	 * lines left shared too. Pick them with `linesWithin` (the most-reached
	 * lines, `turnLineReach`, that a storage budget allows) from a short
	 * solve, 80 iterations, of a cheap copy of the spot (below); close that
	 * and solve the hybrid spot from cold. Continuing from the picking solve
	 * instead is worse: its average lingers.
	 *
	 * Measured on issue #47's blueprint (`1size-b3`), 400 iterations, against
	 * the unshared blueprint solved to 0.045% of pot. "Re-solve gain" is the
	 * opponent's best response to an unsafe turn re-solve at the full
	 * three-size betting, under the unshared blueprint's ranges, in % of the
	 * subgame pot, weighted by line reach, refining OOP / IP; the unshared
	 * blueprint's own re-solves give 0.67 / 0.50. On AsKh7d:
	 *
	 * | kept | storage, f32 | re-solve gain | root EV error, mean |
	 * |---|---|---|---|
	 * | none (plain sharing) | 173 MiB | 3.05 / 2.15 | 0.57 / 0.46 |
	 * | top 1 | 201 MiB | 2.48 / 1.58 | 0.46 / 0.53 |
	 * | top 3 | 285 MiB | 1.10 / 0.83 | 0.24 / 0.21 |
	 * | top 6 | 383 MiB | 1.16 / 0.65 | 0.23 / 0.27 |
	 * | all (unshared) | 707 MiB | 0.67 / 0.50 | 0 |
	 *
	 * On Ts9s4h and Ks9s4s plain sharing gives 4.10 / 3.69 and 4.23 /
	 * 2.72 against 0.48 / 0.55 and 0.44 / 0.47 unshared. Kept by a 300 MiB
	 * budget (`linesWithin`), two-tone keeps 6 lines in 282 MiB for 0.61 /
	 * 0.72, and monotone all 19 in 187 MiB. The top 3 alone are not enough
	 * on two-tone (1.82 / 1.96), so budget the storage, not the count.
	 *
	 * In Chromium the picking solve's WebAssembly memory stays resident
	 * until it is collected, so it adds to the peak. Rank on a cheap copy
	 * instead: the blueprint with its river checked down (57 MiB on AsKh7d)
	 * ranked the same top 3 there. Within 512 MiB on AsKh7d, store the
	 * hybrid at 16 bits (`precision: 'i16'` with `wasmStorage`) with a 150
	 * MiB budget at that precision. It keeps the same 3 lines, re-solves at
	 * 1.47 / 0.92, and peaked at 392 MiB on 4 threads, 592 ms an iteration
	 * against 495 shared, its root play settled in 127 s. Two-tone the same
	 * way: 0.88 / 0.85. `bench/blueprint-share/` has the scripts and figures.
	 */
	readonly keepLines?: readonly string[];
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
	/** Storage with `compactStorage`, which `maxBytes` is then checked against; else null. */
	readonly compactBytes: number | null;
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
			(estimate.compactBytes !== null
				? `This spot needs ~${formatBytes(estimate.compactBytes)} even with compact storage, `
				: `This spot needs ~${formatBytes(estimate.compressedBytes)} even at 16-bit precision, `) +
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
	/** Each node's storage owner under `shareHistories`; unset without it. */
	readonly historyAlias?: Int32Array;
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
	if (config.evPot !== undefined && !(Number.isFinite(config.evPot) && config.evPot > 0)) {
		throw new Error(`evPot must be a positive number of chips; got ${config.evPot}`);
	}

	const rows = betRows(config, rounds);

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
	const merge =
		config.runoutBuckets && board.length < 5
			? rangeRankMerge(players, config.runoutBuckets === true ? DEFAULT_BUCKET_GAP : config.runoutBuckets)
			: undefined;
	const runouts = enumerateRunouts(board, symmetries, merge);
	const tree = buildTree(treeConfig(config, rows), runouts);

	const historyAlias = config.shareHistories ? shareHistories(tree, runouts, config, chipScale) : undefined;
	const layout = buildLayout(tree, runouts, players, 4, historyAlias);
	const last = runouts.rounds - 1;
	const showdownBytes = runouts.counts[last] * (2 * COMBOS + COMBOS + 1) * 2;
	const bytes = layout.bytes + showdownBytes;
	const compressedBytes = buildLayout(tree, runouts, players, 2, historyAlias).bytes + showdownBytes;
	// Shared storage is walked once per history all the same.
	const walkedSlots = layout.walkedSlots;
	const compact = config.compactStorage ? compactPlan(config.compactStorage, runouts.rounds) : null;
	const compactBytes = compact
		? buildLayout(tree, runouts, players, 4, historyAlias, compact).bytes + showdownBytes
		: null;
	const needed = compactBytes ?? compressedBytes;

	const suggestions: string[] = [];
	if (needed > maxBytes) {
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
		compactBytes,
		secondsPerThousandIterations: (walkedSlots * 4 * 1000) / OPS_PER_SECOND,
		fits: needed <= maxBytes,
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
		...(historyAlias ? { historyAlias } : {}),
		resolveBoard(cards) {
			return resolveBoard(runouts, typeof cards === 'string' ? parseCards(cards) : cards);
		},
	};
}

/** `SpotConfig.shareHistories` resolved into each node's storage owner. */
function shareHistories(tree: Tree, runouts: Runouts, config: SpotConfig, chipScale: number): Int32Array {
	const asked: ShareHistories = config.shareHistories === true ? {} : config.shareHistories || {};
	const keep = asked.keepLines && asked.keepLines.length > 0 ? keptNodes(tree, chipScale, asked.keepLines) : undefined;
	return aliasHistories(tree, runouts, { keep }).alias;
}

/**
 * `ShareHistories.keepLines` as node marks: each listed node, everything
 * below it, and everything above it, so that no round root containing it
 * is shared either.
 */
function keptNodes(tree: Tree, chipScale: number, lines: readonly string[]): Uint8Array {
	const parent = new Int32Array(tree.nodeCount).fill(-1);
	const paths: string[] = new Array(tree.nodeCount);
	paths[0] = '(root)';
	// Children come after their parents, so a parent's path is always ready.
	for (let node = 0; node < tree.nodeCount; node++) {
		for (let e = 0; e < tree.numEdges[node]; e++) {
			const edge = tree.firstEdge[node] + e;
			const child = tree.edgeChild[edge];
			parent[child] = node;
			const step = tree.kind[node] === NodeKind.Decision ? actionLabel(tree.edgeAction[edge], tree.edgeTarget[edge], chipScale) : '/';
			paths[child] = node === 0 ? step : `${paths[node]} ${step}`;
		}
	}
	const listed = new Set(lines);
	const missing = new Set(lines);
	const marks = new Uint8Array(tree.nodeCount);
	// At or below a listed node: parents come first, so one sweep does.
	for (let node = 0; node < tree.nodeCount; node++) {
		if (listed.has(paths[node])) {
			missing.delete(paths[node]);
			marks[node] = 1;
		} else if (parent[node] >= 0 && marks[parent[node]]) {
			marks[node] = 1;
		}
	}
	if (missing.size > 0) {
		throw new Error(`shareHistories.keepLines: no node of this tree has the path ${[...missing].map((l) => `"${l}"`).join(', ')}`);
	}
	// Above one: every ancestor of a marked node.
	for (let node = tree.nodeCount - 1; node > 0; node--) if (marks[node]) marks[parent[node]] = 1;
	return marks;
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
	/**
	 * Stop once the root play stops moving (issue #100): every `every`
	 * iterations (default 20) read the average strategy at the root and at in
	 * position's decision after a check, and stop once it has moved less than
	 * `tolerance` (default 0.01: 1% of the range's mass, total variation
	 * weighted by range) at `patience` checks in a row (default 2).
	 * `stoppedAt` is then 'settled'. `rootPlayMovement` defines the measure.
	 *
	 * For solves that never reach an exploitability target, such as a
	 * blueprint with `shareHistories`, which plateaus several percent of the
	 * pot out while its first decisions go on settling (issue #85). A check
	 * reads two nodes' strategies and no best-response pass, so it costs
	 * almost nothing; with it, `Progress.exploitability` is NaN unless
	 * `targetPercent` is set too, which then measures at every check and
	 * stops on whichever comes first. `exploitEvery` is ignored. Measured
	 * costs are in `solveLite`'s notes. Unset, off.
	 */
	readonly settle?: SettleOptions;
	readonly onProgress?: (info: Progress) => void;
	/**
	 * Accumulator storage. Unset, 'f32' — what the WebAssembly engine runs —
	 * or 'i16' for a spot too big for it under `maxBytes` (beside chance
	 * sampling's baselines, when `approximations.chanceSampling` is on). 'f64' is there on
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
	 * — 32-bit storage (or 16-bit and compact with `wasmStorage`), WebAssembly
	 * SIMD available — and the JavaScript one otherwise. 'js' forces
	 * JavaScript, to compare the two.
	 */
	readonly engine?: 'js';
	/**
	 * 16-bit and compact storage on the WebAssembly engine (issue #84): pass
	 * `wasmStorage` from `poker-flopsolve/wasm-storage`. With it, a solve at
	 * `precision: 'i16'` or of a `compactStorage` spot runs on the engine,
	 * threads included, rather than on JavaScript. Its updates are the
	 * JavaScript ones, step for step, worked in 32-bit floats rather than
	 * 64-bit ones, so a stored value differs only where it lies within float32
	 * precision of a rounding boundary; the random rounding hashes the same
	 * slot and iteration, read to 24 bits rather than 32. Compact scales
	 * below 2^-126 (regrets under 10^-35) are taken as 0. Unset, those solves run on
	 * JavaScript as before; 32-bit solves run on the default engine either
	 * way, and `precision: 'f64'` on JavaScript.
	 */
	readonly wasmStorage?: WasmStorage;
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
	 * Every other approximation measured and left out, or measured as a
	 * combination and offered only as a preset, is recorded with its numbers
	 * and issue in docs/APPROXIMATIONS.md.
	 */
	/**
	 * Chance sampling with baselines (VR-MCCFR; Schmid et al., 2019). Each
	 * training iteration walks each turn and river deal with probability `p`
	 * (default 0.35, both rounds). A deal left out adds the per-hand values it
	 * returned when last walked, its baseline; a walked deal adds
	 * `b + (v - b) / p` and its values become the new baseline. DCFR discounts
	 * a skipped subtree missed are applied when it is next walked. This is
	 * what made sampling pay where the plain 1/p weighting (docs/APPROXIMATIONS.md) did not:
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
	 * `maxBytes`. Any storage: 32-, 64- or 16-bit, or `compactStorage`
	 * over 32 or 16 bits (16-bit since issue #102, with the same DCFR
	 * catch-up, in both engines).
	 *
	 * Threads (issue #99): it runs on `workers` threads, in the JavaScript
	 * pool and on the WebAssembly engine's threads alike. Threads split the
	 * runouts as for an exact solve, and the state sampling keeps (baselines,
	 * when each deal was last walked, when each block was last updated for
	 * the catch-up) lives in shared memory, each thread's runouts' entries
	 * its own. There is no per-thread random stream: whether a deal is walked
	 * on an iteration is a hash of its chance node, the deal and the
	 * iteration, in both engines, so every thread count walks the same deals
	 * on the same iterations. A fixed count is then bitwise repeatable, and
	 * different counts differ only as unsampled ones do (see `workers`). A
	 * spot sampling a round above the threads' split, which no flop or turn
	 * spot has, runs on one thread. Measured in Chromium on issue #47's
	 * blueprint, 4 threads ran 3.1–3.2 times faster than 1 on three flops,
	 * and the shared AsKh7d blueprint's root play settled in 33 s against
	 * 105 s (`bench/blueprint-share/README.md`). With `targetPercent`, a sampled solve runs more
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
	/** In chips; NaN at a `settle` check made without `targetPercent`. */
	readonly exploitability: number;
	readonly elapsedMs: number;
	/** With `settle`: how far the root play moved since the last check (`rootPlayMovement`), NaN at the first. */
	readonly movement?: number;
}

/** Which stopping rule ended a solve: see `Solution.stoppedAt`. */
export type StopReason = 'target' | 'iterations' | 'settled';

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
	 * for — worth surfacing rather than swallowing. 'settled' is
	 * `SolveOptions.settle`'s: the root play stopped moving.
	 */
	readonly stoppedAt: StopReason;
	/** Worker threads the solve actually used, which 'auto' does not tell you. */
	readonly workers: number;
	/** The solver behind this solution, for analysis and warm starts. */
	readonly solver: Solver;
	/**
	 * The pot, in chips, that `ev` and `handEvs` are percentages of:
	 * `SpotConfig.evPot`, which defaults to the spot's own `pot` (rounded to
	 * chip units, as the tree holds it). A subgame
	 * from `subgameAt` carries the original spot's.
	 */
	readonly evPot: number;
	/**
	 * A player's share of the pot, in percent of `evPot`: what they win on
	 * average per hand, `100 × (evChips + evPot / 2) / evPot`. Folding, or
	 * losing every showdown, is 0; winning the pot uncontested is 100; the
	 * two players' values add up to 100. In a subgame, whose own pot holds
	 * chips both players put in earlier, folding at its root reads below 0:
	 * the earlier chips given up, as a share of `evPot`. Under the average
	 * strategy, or the current profile with `approximations.currentProfileEv`.
	 */
	ev(player: 0 | 1): number;
	/**
	 * `ev` in chips per hand, against a baseline where each player already
	 * owns half the pot: folding is worth −pot/2 and the players' values add
	 * up to 0. The same baseline at every round, since a round opens with
	 * both players level. `Solver.valuesAt` and the traversal use it.
	 */
	evChips(player: 0 | 1): number;
	/** `handEvs` in chips on `evChips`'s half-pot baseline. Returns a fresh copy. */
	handEvsChips(player: 0 | 1): Float64Array;
	/**
	 * Root EV for each combination a player can hold, in percent of `evPot`
	 * as `ev` is, indexed like `COMBO_CARDS` (as `reachAt` is): what that hand
	 * wins on average, over the opponent hands it can be dealt against. Zero
	 * for combinations outside the range or blocked by the board, and for a
	 * hand no opponent hand can be dealt against, which has no EV to give;
	 * those carry no weight. Weighted by range weight times compatible
	 * opponent mass, the mean is `ev(player)`, and the same pass serves both.
	 * Under the average strategy, or the current profile with
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
		| 'betSizes'
		| 'raiseSizes'
		| 'maxRaises'
		| 'allowAllIn'
		| 'allInThreshold'
		| 'noDonk'
		| 'mergeSizes'
		| 'removeActions'
		| 'thinSizes'
		| 'maxCombos'
		| 'maxBytes'
	>
>;

/** Subgame settings that shape the tree, which a carried-over cut would not fit. */
const TREE_SETTINGS = [
	'betSizes', 'raiseSizes', 'maxRaises', 'allowAllIn', 'allInThreshold', 'noDonk', 'mergeSizes', 'thinSizes',
] as const satisfies readonly (keyof SubgameBetting)[];

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
	snapshot(history?: readonly Progress[], stoppedAt?: StopReason): Solution;
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
	const { bytes } = spot.estimate;
	const compact = spot.source.compactStorage ? compactPlan(spot.source.compactStorage, spot.runouts.rounds) : null;
	if (compact) {
		const clashes: [unknown, string][] = [
			// An analysis-only run loads float32 sums, which compact nodes do not have.
			[options.analysisOnly, 'analysisOnly'],
		];
		const clash = clashes.find(([set]) => set)?.[1];
		if (clash) throw new Error(`compactStorage does not combine with ${clash}`);
	}
	// With compact storage, `precision` is that of the rounds before `compactStorage.from`.
	const defaulted = !compact && !options.analysisOnly && options.precision === undefined;
	let precision: Precision = compact
		? options.precision ?? 'f32'
		: options.analysisOnly
		? 'f32'
		: options.precision ??
			(bytes <= maxBytes ? 'f32' : 'i16');

	// Hands neither player holds never carry reach, so they need no ranking.
	const relevant = new Uint8Array(COMBOS);
	for (const combo of spot.players[0].combos) relevant[combo] = 1;
	for (const combo of spot.players[1].combos) relevant[combo] = 1;

	const showdown = buildShowdownTable(spot.runouts, relevant);
	const layoutAt = (at: Precision): Layout => buildLayout(
		spot.tree, spot.runouts, spot.players, PRECISION_BYTES[at], spot.historyAlias, compact ?? undefined,
	);
	let layout = layoutAt(precision);
	const weights = runoutWeights(spot.runouts);
	const active = buildActiveLists(spot.runouts, spot.players, showdown);
	const hands = buildHandSpace(spot.runouts, spot.players, active);
	const samplingOptions = options.approximations?.chanceSampling;
	// The plan reads only the layout's blocks, which do not depend on precision.
	const samplingPlan = samplingOptions ? planSampling(spot.tree, spot.runouts, active, layout, samplingOptions) : undefined;
	// Measured as the precision choice measures storage: by the estimate at
	// the precision chosen (16-bit storage by its own); with compact storage,
	// which that estimate does not know, by the layout.
	const storageAt = (at: Precision, of: Layout): number => compact
		? of.bytes
		: Math.max(at === 'i16' ? spot.estimate.compressedBytes : bytes, of.bytes);
	const baselineBytes = samplingPlan ? samplingBytes(samplingPlan) : 0;
	// A default 32-bit choice that fits alone but not beside the baselines
	// falls back to 16 bits, as a spot too big for 32 bits does.
	if (defaulted && precision === 'f32' && samplingPlan && storageAt('f32', layout) + baselineBytes > maxBytes) {
		precision = 'i16';
		layout = layoutAt(precision);
	}
	const storageBytes = storageAt(precision, layout);
	if (samplingPlan && storageBytes + baselineBytes > maxBytes) {
		throw new Error(
			`chanceSampling needs ${Math.ceil(baselineBytes / 2 ** 20)} MiB of baselines beside ` +
				`${Math.ceil(storageBytes / 2 ** 20)} MiB of storage, over maxBytes; sample fewer rounds or raise maxBytes`,
		);
	}

	// Planned once the precision is settled (beside the baselines) and before
	// the accumulators are allocated, so a bad option or a coarse spot that
	// does not fit fails here; solved only once the real run exists.
	// The real run's storage by the larger of the layout it allocates and the
	// estimate the coarse spot is measured by, so neither undercounts it.
	const held = Math.max(storageBytes, storageCost(spot, precision)) + baselineBytes;
	const coarsePlan = planCoarseStart(spot, options, maxBytes, held);

	// The WebAssembly engine, where it applies: 32-bit storage, or 16-bit and
	// compact storage with `wasmStorage`, and a platform with WebAssembly
	// SIMD. Decided before the thread count, because the browser build can
	// only thread the engine.
	const storageEngine = options.wasmStorage !== undefined && precision !== 'f64' && (precision === 'i16' || compact !== null);
	const wantsEngine =
		options.engine !== 'js' && !options.analysisOnly && options.simd !== false &&
		((precision === 'f32' && !compact) || storageEngine);
	const requested = resolveWorkers(options, wantsEngine);
	const shards = requested > 1 ? planShards(spot.tree, spot.runouts, requested) : null;
	// Threads sample the deals of their own runouts, below the split. A
	// sampled round above it would be sampled by the main thread after the
	// threads had walked it, so such a spot stays on one thread; the split
	// sits at the first round with more than one board, so no flop or turn
	// spot has one: this is a guard, not a case a real spot reaches.
	const plan = shards && samplingOptions && sampledRounds(samplingOptions, spot.runouts.rounds).some((r) => r < shards.round)
		? null
		: shards;

	// Workers need the accumulators in shared memory. Allocating shared for a
	// single-threaded solve would cost nothing but buys nothing either.
	const allocate = (bytes: number): ArrayBuffer | SharedArrayBuffer =>
		plan ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
	const width = PRECISION_BYTES[precision];
	const quantised = precision === 'i16';

	// The engine owns the storage; the context sees it through views.
	const engine = wantsEngine
		? createEngine(
				{
					tree: spot.tree, runouts: spot.runouts, players: spot.players, layout, active, hands,
					runoutWeight: weights, chipScale: spot.chipScale, sampling: samplingPlan,
					...(storageEngine ? { storage: { source: options.wasmStorage!, quantised, compact } } : {}),
				},
				plan ? { plan, threads: requested, spawn: spawnEngineWorker } : undefined,
			)
		: null;
	const engineCompact = engine?.compact ?? null;
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
		regretScale: !quantised ? null : engine ? engine.regretScale : new Float64Array(allocate(layout.blocks * 8)),
		sumScale: !quantised ? null : engine ? engine.sumScale : new Float64Array(allocate(layout.blocks * 8)),
		compact,
		compactRegret: !compact
			? null
			: engineCompact
				? engineCompact.regret
				: layout.chunkSlots.map((slots) =>
						compact.float ? new Float32Array(allocate(slots * 4)) : new Int8Array(allocate(slots)),
					),
		handShift: !compact?.perHand
			? null
			: engineCompact
				? engineCompact.handShift
				: layout.chunkHands.map((hands) => new Uint8Array(allocate(hands))),
		compactSum: !compact?.sums
			? null
			: engineCompact
				? engineCompact.sum
				: layout.chunkSlots.map((slots) => new Uint8Array(allocate(slots))),
		sumShift: !compact?.sums
			? null
			: engineCompact
				? engineCompact.sumShift
				: layout.chunkHands.map((hands) => new Uint8Array(allocate(hands))),
		compactScale:
			!compact || compact.perHand || compact.float
				? null
				: engineCompact
					? engineCompact.scale
					: new Float64Array(allocate(layout.blocks * 8)),
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
	if (samplingPlan) ctx.sampling = makeSampling(samplingPlan, engine?.sampling ?? undefined, allocate);
	if (layout.shared) ctx.discounted = engine?.discounted ?? new Int32Array(layout.blocks);

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
		if (engine?.profile) threadProfiles.set(solver, engine.profile);
		if (warm && coarsePlan) coarseMs.set(solver, coarsePlan.elapsed);
		// The engine runs its own threads; the JavaScript pool is for the rest.
		pool = plan && !engine
			? startPool(ctx, solver, plan, { config: spot.source, dcfr: ctx.dcfr, precision, approximations: options.approximations, simd: ctx.simd, compact }, requested)
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
				wasmStorage: options.wasmStorage,
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
				spot, solver, completed, offset + completed, [...history], stoppedAt, threadCount,
				options.approximations?.currentProfileEv === true,
			);
		},
	};
}

/** Validate `SpotConfig.compactStorage` into the solver's plan. */
function compactPlan(settings: CompactStorage, rounds: number): CompactPlan {
	const from = settings.from ?? 0;
	if (!Number.isInteger(from) || from < 0 || from >= rounds) {
		throw new Error(`compactStorage.from must be a round of this spot, 0 to ${rounds - 1}; got ${from}`);
	}
	const chunkBytes = settings.chunkBytes ?? 2 ** 30;
	if (!Number.isInteger(chunkBytes) || chunkBytes < 1) {
		throw new Error(`compactStorage.chunkBytes must be a positive whole number of bytes; got ${chunkBytes}`);
	}
	const steps = settings.steps ?? 127;
	if (!Number.isInteger(steps) || steps < 1 || steps > 127) {
		throw new Error(`compactStorage.steps must be an integer from 1 to 127; got ${steps}`);
	}
	if (settings.sums !== false && (settings.blockScale || settings.float)) {
		throw new Error('compactStorage.sums keeps a scale per hand, so blockScale and float need sums: false');
	}
	return {
		from, steps, perHand: !settings.blockScale && !settings.float, stochastic: !settings.nearest,
		float: settings.float === true, chunkBytes, sums: settings.sums ?? true,
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
 * `used` is what the real run holds: its storage and, with chance
 * sampling, its baselines. The coarse run's own baselines count too.
 */
function planCoarseStart(spot: Spot, options: SolveOptions, maxBytes: number, used: number): CoarsePlan | null {
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

	// A compact spot's coarse spot is compact too: its storage is its layout at
	// that precision, beside the rest `estimate.compactBytes` counts at 32 bits.
	const left = maxBytes - used;
	const sampling = options.approximations?.chanceSampling;
	const refuse = (needs: number): Error => new Error(
		`coarseStart needs ~${formatBytes(needs)} beside this spot's ~${formatBytes(used)}` +
			`${sampling ? ' (storage and chanceSampling baselines, for each)' : ''}, ` +
			`over the ${formatBytes(maxBytes)} limit; raise maxBytes or leave coarseStart off`,
	);
	// Storage first: where even the smallest storage does not fit, the
	// baselines need not be laid out to know it.
	const narrowest = storageCost(coarseSpot, options.precision ?? 'i16');
	if (narrowest > left) throw refuse(narrowest);
	const coarseBaselines = sampling ? baselineCost(coarseSpot, sampling) : 0;
	const coarsePrecision: Precision = options.precision ?? (storageCost(coarseSpot, 'f32') + coarseBaselines <= left ? 'f32' : 'i16');
	const needs = storageCost(coarseSpot, coarsePrecision) + coarseBaselines;
	if (needs > left) throw refuse(needs);
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
		wasmStorage: options.wasmStorage,
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
 * Bytes chance sampling's baselines take for `of`, as `createRun` lays them
 * out. They depend on the layout's blocks, not on its precision.
 */
function baselineCost(of: Spot, sampling: SamplingOptions): number {
	const relevant = new Uint8Array(COMBOS);
	for (const combo of of.players[0].combos) relevant[combo] = 1;
	for (const combo of of.players[1].combos) relevant[combo] = 1;
	const active = buildActiveLists(of.runouts, of.players, buildShowdownTable(of.runouts, relevant));
	const compact = of.source.compactStorage ? compactPlan(of.source.compactStorage, of.runouts.rounds) : undefined;
	const layout = buildLayout(of.tree, of.runouts, of.players, 4, of.historyAlias, compact);
	return samplingBytes(planSampling(of.tree, of.runouts, active, layout, sampling));
}

/** Bytes `of` takes stored at `at`, compact storage included. */
export function storageCost(of: Spot, at: Precision): number {
	if (of.estimate.compactBytes === null) {
		return at === 'i16' ? of.estimate.compressedBytes : of.estimate.bytes * (at === 'f64' ? 2 : 1);
	}
	const plan = compactPlan(of.source.compactStorage!, of.runouts.rounds);
	const bytesAt = (width: number): number =>
		buildLayout(of.tree, of.runouts, of.players, width, of.historyAlias, plan).bytes;
	return of.estimate.compactBytes + bytesAt(PRECISION_BYTES[at]) - bytesAt(4);
}

/**
 * Whether two configurations describe the very same game. Limits and how
 * runouts are stored do not change the game, so they are left out.
 */
function sameSpot(a: SpotConfig, b: SpotConfig): boolean {
	// `evPot` only says how EV is reported, not what game is played.
	const plain = ({ maxBytes: _bytes, maxCombos: _combos, isomorphism: _iso, evPot: _evPot, ...game }: SpotConfig): string =>
		JSON.stringify(game, (_, value: unknown) => (value instanceof Float64Array ? Array.from(value) : value));
	const kept = (config: SpotConfig): readonly string[] | undefined =>
		typeof config.shareHistories === 'object' ? config.shareHistories.keepLines : undefined;
	if (kept(a) === undefined && kept(b) === undefined) return plain(a) === plain(b);
	// `keepLines` only gives nodes their shared block's own copy, so a warm
	// start into a spot keeping every line its source keeps copies each node
	// exactly, average included; into one keeping fewer, several histories
	// would write one block.
	const mine = new Set(kept(a) ?? []);
	if (!(kept(b) ?? []).every((line) => mine.has(line))) return false;
	return plain(withoutKeptLines(a)) === plain(withoutKeptLines(b));
}

/** `config` with `keepLines` dropped and its sharing in one form: `true` and `{}` alike, unset keys gone. */
function withoutKeptLines(config: SpotConfig): SpotConfig {
	const asked = config.shareHistories;
	if (!asked) return config;
	const { keepLines: _kept, ...rest } = asked === true ? {} : asked;
	const set = Object.entries(rest).filter(([, value]) => value !== undefined);
	return { ...config, shareHistories: set.length > 0 ? Object.fromEntries(set) : true };
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
	// Validated before any storage is taken.
	const settle = options.settle ? settlePlan(options.settle) : null;
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
		if (settle) return runSettled(settle);
		// Nothing to measure for: run straight through in one call.
		if (fixed <= 0 && target <= 0) {
			run.step(iterations);
			return run.snapshot(history, 'iterations');
		}

		let stoppedAt: StopReason = 'iterations';
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

	/** `settle`'s loop: a cheap root-play check every `every` iterations. */
	function runSettled(plan: Required<SettleOptions>): Solution {
		const tracker = trackSettle(plan);
		let stoppedAt: StopReason = 'iterations';
		let done = 0;
		while (done < iterations) {
			const until = Math.min(done + plan.every, iterations);
			// A short last step moves the play less; it is not a check.
			const full = until - done === plan.every;
			run.step(until - done);
			done = until;
			const measured = run.snapshot();
			const settled = full && tracker.check(measured, done);
			const info: Progress = {
				iteration: done,
				exploitability: target > 0 ? measured.exploitability() : Number.NaN,
				elapsedMs: Date.now() - started,
				movement: full ? tracker.movement : Number.NaN,
			};
			history.push(info);
			options.onProgress?.(info);
			if (target > 0 && measured.exploitabilityPercent() <= target) {
				stoppedAt = 'target';
				break;
			}
			if (settled) {
				stoppedAt = 'settled';
				break;
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
	solver: Solver,
	iterations: number,
	totalIterations: number,
	history: Progress[],
	stoppedAt: StopReason,
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

	const label = (edge: number): string => actionLabel(tree.edgeAction[edge], tree.edgeTarget[edge], spot.chipScale);

	const path = (node: number): string => {
		const steps: string[] = [];
		let current = node;
		while (parent[current] >= 0) {
			const owner = parent[current];
			steps.push(tree.kind[owner] === NodeKind.Decision ? label(viaEdge[current]) : '/');
			current = owner;
		}
		return steps.reverse().join(' ') || '(root)';
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
	const cachedChips: [Float64Array | null, Float64Array | null] = [null, null];
	let cachedExploit: number | null = null;
	// The pot as the tree holds it, rounded to chip units, so the half-pot
	// baseline cancels exactly and a fold reads 0.
	const evPot = spot.source.evPot ?? spot.potUnits / spot.chipScale;
	// Chips on the half-pot baseline to a share of `evPot`.
	const share = (chips: number): number => (100 * (chips + evPot / 2)) / evPot;

	return {
		spot,
		iterations,
		totalIterations,
		stoppedAt,
		workers,
		solver,
		history,
		evPot,
		ev(player) {
			return share(rootValues().totals[player]);
		},
		evChips(player) {
			return rootValues().totals[player];
		},
		handEvs(player) {
			cachedHands[player] ??= solver.handEvs(player, rootValues().values[player], share);
			return cachedHands[player].slice();
		},
		handEvsChips(player) {
			cachedChips[player] ??= solver.handEvs(player, rootValues().values[player]);
			return cachedChips[player].slice();
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
		path,
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
			// Cuts below the node carry over, re-rooted at it, while the tree
			// keeps the old betting; new betting builds a tree they need not fit.
			// Settings read with `??` fall back when given as undefined, and an
			// unset thinSizes is the full tree the cuts were made on.
			const keeps = (key: keyof SubgameBetting): boolean =>
				key === 'thinSizes' ? !betting.thinSizes : betting[key] === undefined && ['betSizes', 'maxRaises', 'allowAllIn'].includes(key);
			const reshaped = TREE_SETTINGS.some((key) => key in betting && !keeps(key));
			const prefix = node === 0 ? '' : `${path(node)} `;
			// Chips in a path are the actor's total investment, which a subgame
			// counts from its own start: each amount drops by what is already in.
			const rebase = (step: string): string => {
				const [label, chips] = step.split(' ');
				return chips === undefined ? step : `${label} ${(Math.round(Number(chips) * spot.chipScale) - invested) / spot.chipScale}`;
			};
			const cuts = source.removeActions
				?.filter((line) => line.startsWith(prefix))
				.map((line) => line.slice(prefix.length).split(' ').reduce<string[]>((steps, word, i, words) => {
					// Words come as single actions ("check", "/") or a label and its chips.
					if (/^-?[\d.]+$/.test(word)) steps[steps.length - 1] = rebase(`${words[i - 1]} ${word}`);
					else steps.push(word);
					return steps;
				}, []).join(' '));
			const removeActions =
				'removeActions' in betting ? betting.removeActions : reshaped || !cuts || cuts.length === 0 ? undefined : cuts;

			return {
				board: formatCards(cards),
				pot: tree.pot[node] / spot.chipScale,
				// EV stays a share of the original spot's pot down a hand.
				evPot,
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
				...(removeActions ? { removeActions } : {}),
				// The thinned shape is the whole tree's, so a subgame starts full.
				...(betting.thinSizes ? { thinSizes: true } : {}),
				minWeight: source.minWeight,
				isomorphism: source.isomorphism,
				maxCombos: 'maxCombos' in betting ? betting.maxCombos : source.maxCombos,
				maxBytes: 'maxBytes' in betting ? betting.maxBytes : source.maxBytes,
				chipScale: spot.chipScale,
				compactStorage: source.compactStorage,
			};
		},
	};
}

export { formatCards, parseCards };
export { bettingFrom, checkedDown, keepWithin, liteConfig, litePreset, solveLite } from './lite.ts';
export type { LiteOptions, LitePreset, LiteResolveOptions, LiteSolution, SolveLiteOptions } from './lite.ts';
export type { PresetChanges, SettingChange, SizesCut, Street } from './presets.ts';
