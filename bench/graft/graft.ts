/**
 * Strategy grafting over the flop's opening bet (issue #56).
 *
 * Purpose: solve R — three sizes on the flop's opening bet, one size after it
 * — without ever holding R in memory, by solving it in pieces one at a time
 * and stitching them at the two decisions that open the flop's betting.
 *
 * The pieces partition R below those two decisions:
 *
 * - `P_a`: OOP opens with bet `a` (each size, and the shove);
 * - `Q_a`: OOP checks, IP opens with `a`;
 * - `X`: both check.
 *
 * Each piece is R's own tree with every edge of the opening prefix but the
 * piece's own taken out, so its root still is R's root (a one-action
 * decision), and its ranges are the stitch's: each player's range times the
 * probability of the prefix actions they take. Nothing but the piece is in
 * memory while it solves; what is kept from it is each player's per-hand
 * counterfactual value at its root, a few kilobytes.
 *
 * The stitch is regret matching (RM+) over those values at the two opening
 * decisions, one update per round: OOP's root over {check, sizes, shove},
 * IP's decision after a check likewise. A round solves every piece for the
 * ranges the current stitch sends into it. This is the decomposition of
 * strategy grafting (Waugh, Bard & Bowling, 2009) with the grafts cut down to
 * the subtrees they add, and of CFR-D (Burch, Johanson & Bowling, 2014),
 * whose trunk here is two decisions deep.
 *
 * Every hand of each player stays in every piece, at no less than `floor`
 * times its range weight, so the stitch learns the value of actions a hand
 * does not yet take. The opponent then trains against that floor too: a
 * small, deliberate bias.
 */

import { COMBOS, ActionKind, createRun, defineSpot, NodeKind } from '../../src/index.ts';
import type { SolveRun, Spot, SpotConfig } from '../../src/index.ts';
import { suitSymmetries } from '../../src/abstraction.ts';
import { comboIndex, COMBO_CARDS } from '../../src/cards.ts';
import { buildLayout } from '../../src/cfr.ts';
import type { Tree } from '../../src/tree.ts';
import { warmStart } from '../../src/warm.ts';
import type { Context } from '../../src/cfr.ts';

/** Keep only `keep[node]` (an edge index) at each listed node; renumber. */
export function restrictTree(tree: Tree, keep: Map<number, number>): { tree: Tree; original: Int32Array } {
	const kept = (node: number): number[] =>
		keep.has(node) ? [keep.get(node)!] : Array.from({ length: tree.numEdges[node] }, (_, e) => e);
	// Breadth-first, so each node's children are numbered together.
	const order: number[] = [0];
	const index = new Int32Array(tree.nodeCount).fill(-1);
	index[0] = 0;
	for (let head = 0; head < order.length; head++) {
		const node = order[head];
		for (const e of kept(node)) {
			const child = tree.edgeChild[tree.firstEdge[node] + e];
			index[child] = order.length;
			order.push(child);
		}
	}
	const n = order.length;
	const kind = new Uint8Array(n);
	const player = new Int8Array(n);
	const round = new Uint8Array(n);
	const firstEdge = new Int32Array(n).fill(-1);
	const numEdges = new Uint8Array(n);
	const pot = new Int32Array(n);
	const payoff = new Int32Array(n);
	const edgeAction: number[] = [];
	const edgeTarget: number[] = [];
	const edgeChild: number[] = [];
	for (let i = 0; i < n; i++) {
		const node = order[i];
		kind[i] = tree.kind[node];
		player[i] = tree.player[node];
		round[i] = tree.round[node];
		pot[i] = tree.pot[node];
		payoff[i] = tree.payoff[node];
		const edges = kept(node);
		if (tree.numEdges[node] === 0) continue;
		firstEdge[i] = edgeAction.length;
		numEdges[i] = edges.length;
		for (const e of edges) {
			const edge = tree.firstEdge[node] + e;
			edgeAction.push(tree.edgeAction[edge]);
			edgeTarget.push(tree.edgeTarget[edge]);
			edgeChild.push(index[tree.edgeChild[edge]]);
		}
	}
	const decisionNodes: number[] = [];
	for (let i = 0; i < n; i++) if (kind[i] === NodeKind.Decision) decisionNodes.push(i);
	return {
		tree: {
			nodeCount: n,
			edgeCount: edgeAction.length,
			kind, player, round, firstEdge, numEdges, pot, payoff,
			edgeAction: Uint8Array.from(edgeAction),
			edgeTarget: Int32Array.from(edgeTarget),
			edgeChild: Int32Array.from(edgeChild),
			decisionNodes: Int32Array.from(decisionNodes),
		},
		original: Int32Array.from(order),
	};
}

/**
 * A spot whose tree is `config`'s with the given prefix forced.
 *
 * Built from the full game's spot, so `config` must fit its own `maxBytes`
 * (the bench sets it high), and `source` stays the full game's: only the
 * WebAssembly engine, which takes the tree as given, may run it on several
 * threads. JavaScript workers rebuild the spot from `source`.
 */
export function pieceSpot(config: SpotConfig, keep: Map<number, number>, oop: Float64Array, ip: Float64Array): Spot {
	const full = defineSpot({ ...config, oop, ip });
	const { tree } = restrictTree(full.tree, keep);
	const showdownBytes = full.runouts.counts[full.runouts.rounds - 1] * (2 * COMBOS + COMBOS + 1) * 2;
	const bytes = buildLayout(tree, full.runouts, full.players, 4).bytes + showdownBytes;
	const compressedBytes = buildLayout(tree, full.runouts, full.players, 2).bytes + showdownBytes;
	return {
		...full,
		tree,
		estimate: { ...full.estimate, decisionNodes: tree.decisionNodes.length, totalSlots: buildLayout(tree, full.runouts, full.players, 4).totalSlots, bytes, compressedBytes },
	};
}

/** Opening actions of a decision node: index, kind and label. */
export interface OpeningAction {
	readonly edge: number;
	readonly label: string;
	readonly check: boolean;
}

export function openingActions(tree: Tree, node: number, potUnits: number): OpeningAction[] {
	const out: OpeningAction[] = [];
	for (let e = 0; e < tree.numEdges[node]; e++) {
		const edge = tree.firstEdge[node] + e;
		const kind = tree.edgeAction[edge];
		const invested = (tree.pot[node] - potUnits) / 2;
		const label =
			kind === ActionKind.Check ? 'check' : kind === ActionKind.AllIn ? 'allin' : ((tree.edgeTarget[edge] - invested) / tree.pot[node]).toFixed(2);
		out.push({ edge: e, label, check: kind === ActionKind.Check });
	}
	return out;
}

/** Average weights over the spot's suit symmetries, so a piece keeps them. */
function symmetrise(weights: Float64Array, maps: readonly Uint8Array[]): Float64Array {
	if (maps.length <= 1) return weights;
	const out = new Float64Array(COMBOS);
	for (let h = 0; h < COMBOS; h++) {
		if (weights[h] === 0) continue;
		let sum = 0;
		for (const map of maps) sum += weights[comboIndex(map[COMBO_CARDS[h * 2]], map[COMBO_CARDS[h * 2 + 1]])];
		out[h] = sum / maps.length;
	}
	// Exactly equal across each orbit: one representative's value for all.
	for (let h = 0; h < COMBOS; h++) {
		if (weights[h] === 0) continue;
		let lead = h;
		for (const map of maps) lead = Math.min(lead, comboIndex(map[COMBO_CARDS[h * 2]], map[COMBO_CARDS[h * 2 + 1]]));
		out[h] = out[lead];
	}
	return out;
}

export interface GraftOptions {
	/** Rounds of the stitch. */
	readonly rounds: number;
	/** Iterations each piece gets, per round (one entry per round, or one for all). */
	readonly pieceIterations: number | readonly number[];
	/** Blueprint: iterations of the one-size game that seeds the stitch; 0 starts uniform. */
	readonly baseIterations: number;
	/** The one-size game, for the blueprint. */
	readonly base?: SpotConfig;
	readonly workers?: number;
	/** Least share of a hand's range weight it keeps in every piece. Default 1e-3. */
	readonly floor?: number;
	/** Seed the stitch with this opening strategy instead of the blueprint's. */
	readonly seed?: [Float64Array[], Float64Array[]];
	/** The last round plays the rounds' average stitch (CFR-D's output) rather than the latest. Default true. */
	readonly average?: boolean;
	/**
	 * Which stitch the pieces are solved for each round: the latest RM+
	 * strategy, as CFR-D does, or the running average so far, which moves
	 * less from round to round. Regrets are measured against the stitch the
	 * pieces were solved for, the only one whose values the round has, so
	 * 'average' is a fictitious-play-like variant rather than RM+ proper;
	 * measured, it did better than 'current'. Default 'current'.
	 */
	readonly play?: 'current' | 'average';
	/** Called after each piece solves. */
	readonly onPiece?: (info: PieceInfo) => void;
	/** Called with each piece of the last round while its run is open, e.g. to assemble it. */
	readonly onLastRound?: (run: SolveRun, piece: string) => void;
}

export interface PieceInfo {
	readonly round: number;
	readonly piece: string;
	readonly ms: number;
	readonly bytes: number;
	readonly iterations: number;
}

/** What a grafted solve gives back. */
export interface GraftResult {
	/** Opening decisions' action labels: OOP's root, IP's after a check. */
	readonly actions: [string[], string[]];
	/** Final stitch: [decision][action][combo] probabilities. */
	readonly strategy: [Float64Array[], Float64Array[]];
	/**
	 * Per-hand counterfactual values from the last round: OOP's of each root
	 * action, and IP's of each action after a check.
	 */
	readonly values: { oop: Float64Array[]; ipAfterCheck: Float64Array[] };
	/** Largest storage of any one run (blueprint or piece), estimated bytes at 32 bits. */
	readonly peakBytes: number;
	readonly pieces: PieceInfo[];
	readonly baseMs: number;
	readonly totalMs: number;
}

export function graftSolve(config: SpotConfig, options: GraftOptions): GraftResult {
	const started = performance.now();
	const workers = options.workers ?? 4;
	const floor = options.floor ?? 1e-3;
	const full = defineSpot(config);
	const { tree, potUnits } = full;
	const weights = [full.players[0].weights, full.players[1].weights];
	const maps = suitSymmetries(full.board, weights);
	const root = 0;
	const rootActions = openingActions(tree, root, potUnits);
	const checkEdge = rootActions.find((a) => a.check)!.edge;
	const after = tree.edgeChild[tree.firstEdge[root] + checkEdge];
	const ipActions = openingActions(tree, after, potUnits);
	const A = rootActions.length;
	const B = ipActions.length;
	let peakBytes = 0;

	// The stitch's strategy, regrets and the values it read.
	const sigma = [Array.from({ length: A }, () => new Float64Array(COMBOS).fill(1 / A)), Array.from({ length: B }, () => new Float64Array(COMBOS).fill(1 / B))];
	const regret = [Array.from({ length: A }, () => new Float64Array(COMBOS)), Array.from({ length: B }, () => new Float64Array(COMBOS))];

	// Blueprint: the one-size game's opening strategy, its bet spread over every size.
	let baseMs = 0;
	if (options.baseIterations > 0 && options.base) {
		const t = performance.now();
		const baseSpot = defineSpot(options.base);
		peakBytes = Math.max(peakBytes, baseSpot.estimate.bytes);
		const run = createRun(baseSpot, { workers });
		run.step(options.baseIterations);
		const solution = run.snapshot();
		const bt = baseSpot.tree;
		const bAfter = bt.edgeChild[bt.firstEdge[0] + openingActions(bt, 0, potUnits).find((a) => a.check)!.edge];
		for (const [d, node, actions] of [[0, 0, rootActions], [1, bAfter, ipActions]] as const) {
			const view = solution.strategyAt(node, 0);
			const labels = openingActions(bt, node, potUnits).map((a) => a.label);
			const sized = (label: string): boolean => label !== 'check' && label !== 'allin';
			const bets = actions.filter((a) => sized(a.label)).length;
			for (let i = 0; i < view.combos.length; i++) {
				const h = view.combos[i];
				for (const a of actions) {
					let p = 0;
					for (let j = 0; j < labels.length; j++) {
						const q = view.probs[i * labels.length + j];
						if (sized(a.label) && sized(labels[j])) p += q / bets;
						else if (labels[j] === a.label) p += q;
					}
					sigma[d][a.edge][h] = p;
				}
			}
		}
		run.close();
		baseMs = performance.now() - t;
	}

	if (options.seed) for (const d of [0, 1]) options.seed[d].forEach((p, a) => sigma[d][a].set(p));
	const sum = [sigma[0].map(() => new Float64Array(COMBOS)), sigma[1].map(() => new Float64Array(COMBOS))];

	let playing = sigma;
	const pieces: PieceInfo[] = [];
	const values: GraftResult['values'] = {
		oop: Array.from({ length: A }, () => new Float64Array(COMBOS)),
		ipAfterCheck: Array.from({ length: B }, () => new Float64Array(COMBOS)),
	};
	const schedule = (round: number): number =>
		typeof options.pieceIterations === 'number'
			? options.pieceIterations
			: options.pieceIterations[Math.min(round, options.pieceIterations.length - 1)];

	for (let round = 0; round < options.rounds; round++) {
		const last = round === options.rounds - 1;
		const iterations = schedule(round);
		// Linear averaging, as CFR+ does; the last round plays the average.
		for (const d of [0, 1]) sigma[d].forEach((p, a) => { for (let h = 0; h < COMBOS; h++) sum[d][a][h] += (round + 1) * p[h]; });
		playing = sigma.map((rows) => rows.map((p) => p.slice()));
		if ((last && options.average !== false) || options.play === 'average') {
			for (const d of [0, 1]) {
				for (let h = 0; h < COMBOS; h++) {
					let total = 0;
					for (const s of sum[d]) total += s[h];
					if (total > 0) for (let a = 0; a < sum[d].length; a++) playing[d][a][h] = sum[d][a][h] / total;
				}
			}
		}
		// Reach into each piece, floored so every hand keeps a value there.
		const reach = (player: 0 | 1, prob: Float64Array | null, floored: boolean): Float64Array => {
			const out = new Float64Array(COMBOS);
			for (let h = 0; h < COMBOS; h++) {
				const w = weights[player][h];
				if (w === 0) continue;
				const p = prob ? prob[h] : 1;
				out[h] = w * (floored ? Math.max(p, floor) : p);
			}
			return floored ? symmetrise(out, maps) : out;
		};
		const solvePiece = (name: string, keep: Map<number, number>, oop: Float64Array, ip: Float64Array, read: (run: SolveRun) => void): void => {
			const t = performance.now();
			const spot = pieceSpot(config, keep, oop, ip);
			peakBytes = Math.max(peakBytes, spot.estimate.bytes);
			const run = createRun(spot, { workers, precision: 'f32' });
			if (run.engine !== 'wasm' && run.workers > 1) {
				run.close();
				throw new Error('a piece runs on several threads only on the WebAssembly engine');
			}
			run.step(iterations);
			read(run);
			if (last) options.onLastRound?.(run, name);
			run.close();
			const info = { round, piece: name, ms: performance.now() - t, bytes: spot.estimate.bytes, iterations };
			pieces.push(info);
			options.onPiece?.(info);
		};
		const cfv = (run: SolveRun, traverser: 0 | 1, me: Float64Array, opp: Float64Array): Float64Array =>
			run.solver.valuesAt(0, 0, traverser, me, opp, run.solver.rootLive, run.solver.rootCount);

		for (const a of rootActions) {
			if (a.check) continue;
			const oop = reach(0, playing[0][a.edge], true);
			const ip = reach(1, null, false);
			solvePiece(`P ${a.label}`, new Map([[root, a.edge]]), oop, ip, (run) => {
				values.oop[a.edge] = cfv(run, 0, oop, ip);
			});
		}
		values.oop[checkEdge] = new Float64Array(COMBOS);
		for (const b of ipActions) {
			const oop = reach(0, playing[0][checkEdge], true);
			const ip = reach(1, playing[1][b.edge], true);
			solvePiece(b.check ? 'X' : `Q ${b.label}`, new Map([[root, checkEdge], [after, b.edge]]), oop, ip, (run) => {
				const v = cfv(run, 0, oop, reach(1, playing[1][b.edge], false));
				for (let h = 0; h < COMBOS; h++) values.oop[checkEdge][h] += v[h];
				values.ipAfterCheck[b.edge] = cfv(run, 1, ip, reach(0, playing[0][checkEdge], false));
			});
		}

		if (last) break;
		// RM+ at both opening decisions.
		for (const [d, v, n] of [[0, values.oop, A], [1, values.ipAfterCheck, B]] as const) {
			for (let h = 0; h < COMBOS; h++) {
				if (weights[d][h] === 0) continue;
				let mean = 0;
				for (let a = 0; a < n; a++) mean += playing[d][a][h] * v[a][h];
				let total = 0;
				for (let a = 0; a < n; a++) {
					regret[d][a][h] = Math.max(0, regret[d][a][h] + v[a][h] - mean);
					total += regret[d][a][h];
				}
				for (let a = 0; a < n; a++) sigma[d][a][h] = total > 0 ? regret[d][a][h] / total : 1 / n;
			}
		}
	}

	return {
		actions: [rootActions.map((a) => a.label), ipActions.map((a) => a.label)],
		strategy: [playing[0], playing[1]],
		values,
		peakBytes,
		pieces,
		baseMs,
		totalMs: performance.now() - started,
	};
}

/** Copy a piece's strategy into an analysis run of the full game, by matching nodes. */
export function assemble(into: Context, piece: SolveRun): void {
	warmStart(into, piece.solver.ctx, true);
}

/** Write the stitch's opening strategy into an analysis run's strategy sums. */
export function writeOpenings(into: Context, result: GraftResult): void {
	const { tree, active, layout } = into;
	const after = tree.edgeChild[tree.firstEdge[0] + result.actions[0].indexOf('check')];
	for (const [d, node] of [[0, 0], [1, after]] as const) {
		const player = tree.player[node];
		const actions = tree.numEdges[node];
		const slot = (active.roundBase[0] + 0) * 2 + player;
		const from = active.start[slot];
		const count = active.count[slot];
		const base = layout.offset[node] + actions * layout.rowStart[slot];
		for (let i = 0; i < count; i++) {
			const combo = active.memberCombo[active.memberStart[from + i]];
			for (let e = 0; e < actions; e++) into.strategySum[base + e * count + i] = result.strategy[d][e][combo];
		}
	}
}
