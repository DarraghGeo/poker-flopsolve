/**
 * Postflop Texas Hold'em solver.
 *
 * Purpose: the public surface. Give it a board, a pot, stacks, two ranges and a
 * betting scheme; it solves to showdown.
 *
 * There is no preflop round. The ranges you supply already encode whatever spot
 * you are in, so the solver starts from a dead pot with both players even.
 */

import { COMBO_CARDS, COMBOS, formatCards, parseCards } from './cards.ts';
import type { BetSize, Tree } from './tree.ts';
import { ACTION_LABELS, ActionKind, buildTree, NodeKind } from './tree.ts';
import type { Runouts } from './runouts.ts';
import { enumerateRunouts } from './runouts.ts';
import { activeCombos, parseRange, rangeWeight } from './range.ts';
import { buildShowdownTable } from './showdown.ts';
import type { Context, PlayerIndex, Solver } from './cfr.ts';
import {
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
export type { BetSize } from './tree.ts';
export { ACTION_LABELS, ActionKind, NodeKind } from './tree.ts';

/** Sub-chip resolution, so pot-fraction sizing is exact. */
const DEFAULT_CHIP_SCALE = 100;

/** Default ceiling on solver storage. */
const DEFAULT_MAX_BYTES = 6 * 1024 * 1024 * 1024;

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
	/** Range notation for the out-of-position player, who acts first. */
	readonly oop: string;
	/** Range notation for the in-position player. */
	readonly ip: string;
	/** Bet sizes per betting round; a single row applies to every round. */
	readonly betSizes: readonly (readonly BetSize[])[];
	/** Maximum aggressive actions per round; the opening bet is the first. */
	readonly maxRaises?: number;
	/** Offer a shove alongside the configured sizes. Default false. */
	readonly allowAllIn?: boolean;
	/** Refuse a range wider than this many combinations. */
	readonly maxCombos?: number;
	/** Refuse a spot needing more than this much storage. */
	readonly maxBytes?: number;
	readonly chipScale?: number;
}

/** Projected cost of solving a spot. */
export interface Estimate {
	readonly rounds: number;
	readonly runouts: number;
	readonly combos: readonly [number, number];
	readonly decisionNodes: number;
	readonly totalSlots: number;
	readonly bytes: number;
	readonly secondsPerThousandIterations: number;
	readonly fits: boolean;
	readonly suggestions: readonly string[];
}

/** Thrown when a spot would need more memory than allowed. */
export class SpotTooLargeError extends Error {
	readonly estimate: Estimate;
	constructor(estimate: Estimate, maxBytes: number) {
		super(
			`This spot needs ~${formatBytes(estimate.bytes)} but the limit is ${formatBytes(maxBytes)}.\n` +
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
}

/**
 * Validate a spot and build everything needed to solve it.
 * @throws {SpotTooLargeError} when it would exceed the memory ceiling
 */
export function defineSpot(config: SpotConfig): Spot {
	const chipScale = config.chipScale ?? DEFAULT_CHIP_SCALE;
	const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
	const board = parseCards(config.board);
	const runouts = enumerateRunouts(board);

	if (config.pot <= 0) throw new Error('pot must be positive');
	if (config.stack <= 0) throw new Error('stack must be positive');

	const rows =
		config.betSizes.length === 1
			? Array.from({ length: runouts.rounds }, () => config.betSizes[0])
			: config.betSizes;
	if (rows.length !== runouts.rounds) {
		throw new Error(
			`betSizes has ${config.betSizes.length} rows but this board has ${runouts.rounds} ` +
				'betting rounds; give one row per round, or a single row for all of them',
		);
	}

	// Board cards cannot be in anyone's range.
	const onBoard = new Set(board);
	const trim = (notation: string, who: string): Float64Array => {
		const weights = parseRange(notation);
		for (let combo = 0; combo < COMBOS; combo++) {
			if (weights[combo] === 0) continue;
			if (onBoard.has(COMBO_CARDS[combo * 2]) || onBoard.has(COMBO_CARDS[combo * 2 + 1])) {
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

	const tree = buildTree(
		{
			potUnits: Math.round(config.pot * chipScale),
			stackUnits: Math.round(config.stack * chipScale),
			betSizes: rows,
			maxRaises: config.maxRaises ?? 1,
			allowAllIn: config.allowAllIn ?? false,
			chipScale,
			minRaiseUnits: chipScale,
		},
		runouts,
	);

	const layout = buildLayout(tree, runouts, players, 4);
	const last = runouts.rounds - 1;
	const showdownBytes = runouts.counts[last] * (2 * COMBOS + COMBOS + 1) * 2;
	const bytes = layout.bytes + showdownBytes;

	const suggestions: string[] = [];
	if (bytes > maxBytes) {
		const widest = Math.max(...rows.map((r) => r.length));
		if (widest > 1) suggestions.push(`use fewer bet sizes (currently up to ${widest} per round)`);
		if ((config.maxRaises ?? 1) > 1) suggestions.push(`lower maxRaises to 1`);
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
		secondsPerThousandIterations: (layout.totalSlots * 4 * 1000) / OPS_PER_SECOND,
		fits: bytes <= maxBytes,
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
	};
}

/** Solver tuning. */
export interface SolveOptions {
	readonly iterations?: number;
	/** Measure exploitability every N iterations. Each costs about one iteration. */
	readonly exploitEvery?: number;
	readonly onProgress?: (info: Progress) => void;
	readonly precision?: 'f32' | 'f64';
}

export interface Progress {
	readonly iteration: number;
	readonly exploitability: number;
	readonly elapsedMs: number;
}

/** A solved spot. */
export interface Solution {
	readonly spot: Spot;
	readonly iterations: number;
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
	readonly history: readonly Progress[];
}

export interface StrategyView {
	readonly node: number;
	readonly board: number;
	readonly player: 0 | 1;
	readonly actions: readonly string[];
	readonly combos: Uint16Array;
	/** Row-major `combos.length * actions.length`. */
	readonly probs: Float64Array;
}

/**
 * Solve a prepared spot.
 * @param spot from {@link defineSpot}
 * @param options solver tuning
 */
export function solve(spot: Spot, options: SolveOptions = {}): Solution {
	const iterations = options.iterations ?? 500;
	const exploitEvery = options.exploitEvery ?? 0;
	const precision = options.precision ?? (spot.estimate.totalSlots < 4_000_000 ? 'f64' : 'f32');

	// Hands neither player holds never carry reach, so they need no ranking.
	const relevant = new Uint8Array(COMBOS);
	for (const combo of spot.players[0].combos) relevant[combo] = 1;
	for (const combo of spot.players[1].combos) relevant[combo] = 1;
	const showdown = buildShowdownTable(spot.runouts, relevant);
	const layout = buildLayout(spot.tree, spot.runouts, spot.players, precision === 'f64' ? 8 : 4);
	const alloc = precision === 'f64' ? Float64Array : Float32Array;

	const weights = runoutWeights(spot.runouts);
	const ctx: Context = {
		tree: spot.tree,
		runouts: spot.runouts,
		players: spot.players,
		layout,
		showdown,
		regret: new alloc(layout.totalSlots),
		strategySum: new alloc(layout.totalSlots),
		scratch: makeTerminalScratch(),
		chipScale: spot.chipScale,
		runoutWeight: weights,
		// The traversal sums over every runout, so the denominator has to count
		// them too: a hand pair is dealt once per compatible completion, not
		// once. With a river board that factor is 1, which is exactly why this
		// is easy to miss.
		totalMass: matchupMass(spot.players[0].weights, spot.players[1].weights) * weights[0],
	};

	const solver = makeSolver(ctx);
	const history: Progress[] = [];
	const started = Date.now();

	let done = 0;
	while (done < iterations) {
		const chunk = exploitEvery > 0 ? Math.min(exploitEvery, iterations - done) : iterations - done;
		solver.iterate(chunk, done);
		done += chunk;
		if (exploitEvery > 0) {
			const info: Progress = {
				iteration: done,
				exploitability: solver.exploitability(),
				elapsedMs: Date.now() - started,
			};
			history.push(info);
			options.onProgress?.(info);
		}
	}

	return makeSolution(spot, ctx, solver, iterations, history);
}

function makeSolution(
	spot: Spot,
	ctx: Context,
	solver: Solver,
	iterations: number,
	history: Progress[],
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

	let cachedEv: [number, number] | null = null;
	let cachedExploit: number | null = null;

	return {
		spot,
		iterations,
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
	};
}

export { formatCards, parseCards };
