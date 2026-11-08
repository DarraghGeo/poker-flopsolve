/**
 * Depth-limited flop solving with blueprint continuations (issue #48).
 *
 * Purpose: solve a flop spot whose full tree is far too large, by holding
 * only its flop betting and standing a fixed table of values in for each
 * line's turn and river, after Brown, Sandholm & Amos, "Depth-Limited Solving
 * for Imperfect-Information Games" (NeurIPS 2018). Opt-in: nothing else in
 * the solver reaches this file.
 *
 * 1. A blueprint — the same spot with one bet size per street, which fits
 *    easily — is solved first.
 * 2. Each line of the real flop tree that reaches the turn deal becomes a
 *    `Continuation` leaf. Its value table comes from the blueprint line most
 *    like it (same last flop aggressor, nearest pot): the blueprint's turn
 *    and river strategy is copied into a small spot starting at the leaf's
 *    real pot and stacks, the players' ranges there being the blueprint's
 *    own on that line, and played out on every runout.
 * 3. Played out with `k` continuations per player — the blueprint strategy
 *    and copies biased toward folding, calling or raising (that family of
 *    actions ×`bias`, renormalised) — every pair gives each player's EV per
 *    hand. Only those vectors are kept: `k² × leaves × hands` numbers each.
 *    The blueprint and the small spots are released.
 * 4. The flop is solved with every size and raise. At a leaf each player
 *    picks a continuation per hand, unseen by the other, as a decision CFR
 *    trains; a hand's value for a pair of picks is its stored EV times the
 *    opponent mass it faces there. Lines where someone is all in still run
 *    out exactly.
 *
 * The values are per hand against the blueprint's range on the matching
 * line, not against the range the flop solve actually sends there: that
 * keeps them small and cheap (a value per hand pair would be ~n times the
 * walks), but they cannot follow the flop solve's ranges, and the game at
 * the leaves is not zero-sum, so `exploitabilityPercent()` of a
 * depth-limited run is only indicative. There is no strategy past the flop.
 */

import { COMBO_CARDS, COMBOS } from './cards.ts';
import type { Context, LeafValues, RegretStore, SumStore } from './cfr.ts';
import { averageStrategy, blockBase, buildLayout, dcfrFactors, Mode } from './cfr.ts';
import type { BetSize, RaiseSizes, Tree } from './tree.ts';
import { ActionKind, NodeKind } from './tree.ts';
import type { Solution, SolveOptions, SolveRun, Spot, SpotConfig } from './index.ts';
import { createRun, defineSpot, solve } from './index.ts';

/** How a continuation leans away from the blueprint. */
export type ContinuationBias = 'blueprint' | 'fold' | 'call' | 'raise';

/** The blueprint's betting: one row for every street, or one per street. */
export interface BlueprintBetting {
	readonly betSizes: readonly (readonly BetSize[])[];
	readonly raiseSizes?: RaiseSizes;
	readonly maxRaises?: number | readonly number[];
	readonly allowAllIn?: boolean | readonly boolean[];
	readonly allInThreshold?: number;
}

export interface DepthLimitedOptions {
	/** The blueprint's betting. Default one 0.75-pot bet a street and no raise. */
	readonly blueprint?: BlueprintBetting;
	/** Stop the blueprint at this exploitability, % of pot. Default 0.5. */
	readonly blueprintTarget?: number;
	/** At most this many blueprint iterations. Default 300. */
	readonly blueprintIterations?: number;
	/** Continuations each player picks among. Default all four, blueprint first. */
	readonly continuations?: readonly ContinuationBias[];
	/** How strongly a biased continuation leans. Default 5. */
	readonly bias?: number;
	/**
	 * How a leaf's table stands for its continuations. 'additive' (default):
	 * each player's EV per hand, a pair of hands worth the difference — `k²`
	 * numbers a hand. 'pairs': the value of every pair of hands, exact for
	 * the continuations but `n` times the memory and about `n` times the
	 * walks to build, `n` the opponent's hands; for measuring what the
	 * additive model loses.
	 */
	readonly leafModel?: 'additive' | 'pairs';
	/** Threads for the blueprint and the leaf tables; the flop solve is one thread. */
	readonly workers?: SolveOptions['workers'];
	/** Passed to the blueprint's and the leaf tables' runs. */
	readonly simd?: boolean;
	readonly engine?: 'js';
	/** Called at the end of each phase, e.g. to sample memory. */
	readonly onPhase?: (phase: 'blueprint' | 'leaf' | 'tables' | 'flop') => void;
	/**
	 * Called with each leaf spot while it is still open, after its table is
	 * built, and the blueprint's solution: for diagnostics.
	 */
	readonly onLeafSpot?: (leaf: { readonly line: string; readonly source: number; readonly run: SolveRun; readonly table: Float64Array }, blueprint: Solution) => void;
}

/** What building a depth-limited run did. */
export interface DepthLimitedReport {
	readonly leaves: number;
	readonly continuations: number;
	readonly blueprintIterations: number;
	readonly blueprintExploitability: number;
	readonly blueprintBytes: number;
	readonly blueprintMs: number;
	/** Largest leaf spot's storage. */
	readonly leafBytes: number;
	readonly tablesMs: number;
	/** The kept value tables. */
	readonly tableBytes: number;
	/** For each leaf: its flop line, and the blueprint line its table came from. */
	readonly lines: readonly { readonly leaf: string; readonly source: string }[];
}

export interface DepthLimitedRun extends SolveRun {
	readonly report: DepthLimitedReport;
	/**
	 * Rebuild every leaf's table against the ranges the flop solve sends
	 * there now, instead of the blueprint's. The continuations stay the
	 * blueprint's; only who they are played against changes.
	 */
	refresh(): void;
}

const DEFAULT_BLUEPRINT: BlueprintBetting = { betSizes: [[0.75]], maxRaises: 1 };
const DEFAULT_CONTINUATIONS: readonly ContinuationBias[] = ['blueprint', 'fold', 'call', 'raise'];

/** A cut tree's leaf and where it stands. */
interface LeafLine {
	readonly node: number;
	readonly pot: number;
	/** What each player has put in on the flop. */
	readonly invested: number;
	/** Who made the last flop bet or raise, or -1. */
	readonly aggressor: number;
	readonly path: string;
	/** The chance node it stands for in the tree it was cut from. */
	readonly origin: number;
}

const LABEL = ['f', 'x', 'c', 'b', 'r', 'a'];

/**
 * Copy `tree` up to the turn deal: a chance node into the turn with betting
 * after it becomes a `Continuation` leaf; one with someone all in keeps its
 * runout to showdown.
 */
export function cutAtTurn(tree: Tree): { tree: Tree; leaves: LeafLine[]; allIns: { node: number; payoff: number }[] } {
	const kind: number[] = [];
	const player: number[] = [];
	const round: number[] = [];
	const firstEdge: number[] = [];
	const numEdges: number[] = [];
	const pot: number[] = [];
	const payoff: number[] = [];
	const edgeAction: number[] = [];
	const edgeTarget: number[] = [];
	const edgeChild: number[] = [];
	const leaves: LeafLine[] = [];
	const allIns: { node: number; payoff: number }[] = [];
	const potUnits = tree.pot[0];

	const copy = (from: number, aggressor: number, path: string): number => {
		const node = kind.length;
		const deal = tree.kind[from] === NodeKind.Chance && tree.round[from] === 0;
		const leaf = deal && tree.kind[tree.edgeChild[tree.firstEdge[from]]] === NodeKind.Decision;
		kind.push(deal ? NodeKind.Continuation : tree.kind[from]);
		player.push(tree.player[from]);
		round.push(tree.round[from]);
		pot.push(tree.pot[from]);
		payoff.push(tree.payoff[from]);
		firstEdge.push(-1);
		numEdges.push(0);
		if (leaf) {
			leaves.push({ node, pot: tree.pot[from], invested: (tree.pot[from] - potUnits) / 2, aggressor, path, origin: from });
			return node;
		}
		if (deal) {
			// Someone is all in: the board runs out to a showdown, which the
			// leaf values from a table of who beats whom.
			let end = from;
			while (tree.kind[end] === NodeKind.Chance) end = tree.edgeChild[tree.firstEdge[end]];
			allIns.push({ node, payoff: tree.payoff[end] });
			return node;
		}
		const count = tree.numEdges[from];
		const base = edgeChild.length;
		firstEdge[node] = base;
		numEdges[node] = count;
		for (let e = 0; e < count; e++) {
			edgeAction.push(tree.edgeAction[tree.firstEdge[from] + e]);
			edgeTarget.push(tree.edgeTarget[tree.firstEdge[from] + e]);
			edgeChild.push(-1);
		}
		for (let e = 0; e < count; e++) {
			const edge = tree.firstEdge[from] + e;
			const action = tree.edgeAction[edge];
			const aggressive = action >= ActionKind.Bet && tree.round[from] === 0 && tree.kind[from] === NodeKind.Decision;
			const step = tree.kind[from] === NodeKind.Decision ? LABEL[action] : '';
			edgeChild[base + e] = copy(tree.edgeChild[edge], aggressive ? tree.player[from] : aggressor, path + step);
		}
		return node;
	};
	copy(0, -1, '');

	const decisionNodes: number[] = [];
	for (let i = 0; i < kind.length; i++) if (kind[i] === NodeKind.Decision) decisionNodes.push(i);
	return {
		tree: {
			nodeCount: kind.length,
			edgeCount: edgeChild.length,
			kind: Uint8Array.from(kind),
			player: Int8Array.from(player),
			round: Uint8Array.from(round),
			firstEdge: Int32Array.from(firstEdge),
			numEdges: Uint8Array.from(numEdges),
			pot: Int32Array.from(pot),
			payoff: Int32Array.from(payoff),
			edgeAction: Uint8Array.from(edgeAction),
			edgeTarget: Int32Array.from(edgeTarget),
			edgeChild: Int32Array.from(edgeChild),
			decisionNodes: Int32Array.from(decisionNodes),
		},
		leaves,
		allIns,
	};
}

/**
 * A per-street setting, given once or as a list of one or three, as three
 * entries with the flop's replaced.
 */
function streets<T>(list: readonly T[], flop: T): T[] {
	const out = list.length === 1 ? [list[0], list[0], list[0]] : [...list];
	if (out.length !== 3) throw new Error('A blueprint setting given per street needs one entry for each of the three');
	out[0] = flop;
	return out;
}

/** A setting given once or per street, as a list. */
function listed<T>(value: T | readonly T[] | undefined, fallback: T): readonly T[] {
	return value === undefined ? [fallback] : Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

/** Raise sizes given once or per street, as rows. */
function raiseRows(sizes: RaiseSizes): readonly (readonly BetSize[])[] {
	return sizes.length > 0 && Array.isArray(sizes[0]) ? (sizes as readonly (readonly BetSize[])[]) : [sizes as readonly BetSize[]];
}

/**
 * The blueprint's decision node in `bp` matching each decision in `leaf`
 * below a pair of chance nodes, with each leaf edge's blueprint edge or -1.
 * A leaf decision with no counterpart is listed with source -1.
 */
function matchNodes(leaf: Tree, from: number, bp: Tree, to: number): { node: number; source: number; edges: Int32Array }[] {
	const pairs: { node: number; source: number; edges: Int32Array }[] = [];
	const unmatched = (node: number): void => {
		if (leaf.kind[node] === NodeKind.Decision) pairs.push({ node, source: -1, edges: new Int32Array(leaf.numEdges[node]).fill(-1) });
		for (let e = 0; e < leaf.numEdges[node]; e++) unmatched(leaf.edgeChild[leaf.firstEdge[node] + e]);
	};
	const walk = (a: number, b: number): void => {
		const kind = leaf.kind[a];
		if (kind === NodeKind.TerminalFold || kind === NodeKind.TerminalShowdown) return;
		if (b < 0 || bp.kind[b] !== kind || (kind === NodeKind.Decision && bp.player[b] !== leaf.player[a])) {
			unmatched(a);
			return;
		}
		if (kind === NodeKind.Chance) {
			walk(leaf.edgeChild[leaf.firstEdge[a]], bp.edgeChild[bp.firstEdge[b]]);
			return;
		}
		const edges = new Int32Array(leaf.numEdges[a]).fill(-1);
		for (let e = 0; e < leaf.numEdges[a]; e++) {
			const action = leaf.edgeAction[leaf.firstEdge[a] + e];
			let best = -1;
			for (let f = 0; f < bp.numEdges[b]; f++) {
				const other = bp.edgeAction[bp.firstEdge[b] + f];
				if (other === action) {
					best = f;
					break;
				}
				// A bet the stack caps is a shove here, a bet there, or back.
				if (best < 0 && action >= ActionKind.Bet && other >= ActionKind.Bet) best = f;
			}
			edges[e] = best;
		}
		pairs.push({ node: a, source: b, edges });
		for (let e = 0; e < leaf.numEdges[a]; e++) {
			const child = leaf.edgeChild[leaf.firstEdge[a] + e];
			walk(child, edges[e] < 0 ? -1 : bp.edgeChild[bp.firstEdge[b] + edges[e]]);
		}
	};
	walk(from, to);
	return pairs;
}

/** Each action family's weight under a bias. */
function biasFactor(bias: ContinuationBias, action: number, strength: number): number {
	if (bias === 'fold') return action === ActionKind.Fold ? strength : 1;
	if (bias === 'call') return action === ActionKind.Check || action === ActionKind.Call ? strength : 1;
	if (bias === 'raise') return action >= ActionKind.Bet ? strength : 1;
	return 1;
}

/** The first chance node down a chain of single-action decisions from the root. */
function firstChance(tree: Tree): number {
	let node = 0;
	while (tree.kind[node] === NodeKind.Decision) node = tree.edgeChild[tree.firstEdge[node]];
	if (tree.kind[node] !== NodeKind.Chance) throw new Error('A leaf spot must check through the flop');
	return node;
}

/**
 * Prepare a depth-limited solve of a flop spot: solve its blueprint, build
 * the leaf tables, and return a run over the flop alone. See the file
 * comment. JavaScript traversal, one thread, for the flop. The blueprint
 * stays in memory until `close()`, for `refresh()`.
 */
export function createDepthLimitedRun(config: SpotConfig, options: DepthLimitedOptions = {}): DepthLimitedRun {
	const continuations = options.continuations ?? DEFAULT_CONTINUATIONS;
	const k = continuations.length;
	if (k === 0) throw new Error('A depth-limited solve needs at least one continuation');
	const strength = options.bias ?? 5;
	const betting = options.blueprint ?? DEFAULT_BLUEPRINT;
	const model = options.leafModel ?? 'additive';
	if (config.runoutBuckets) throw new Error('A depth-limited solve deals every card; leave runoutBuckets off');

	// The real spot's tree, cut at the turn deal. Its full storage is never
	// allocated, so its size does not matter.
	const full = defineSpot({ ...config, maxBytes: Number.POSITIVE_INFINITY });
	if (full.runouts.rounds !== 3) throw new Error('A depth-limited solve starts from the flop');
	const cut = cutAtTurn(full.tree);
	const flopLayout = buildLayout(cut.tree, full.runouts, full.players, 4);
	const flopSpot: Spot = {
		...full,
		tree: cut.tree,
		estimate: {
			...full.estimate,
			decisionNodes: cut.tree.decisionNodes.length,
			totalSlots: flopLayout.totalSlots,
			bytes: flopLayout.bytes,
			compressedBytes: buildLayout(cut.tree, full.runouts, full.players, 2).bytes,
			fits: true,
			suggestions: [],
		},
	};

	// 1. The blueprint.
	const started = Date.now();
	const blueprintSpot = defineSpot({
		...config,
		betSizes: betting.betSizes,
		raiseSizes: betting.raiseSizes,
		maxRaises: betting.maxRaises ?? 1,
		allowAllIn: betting.allowAllIn ?? false,
		allInThreshold: betting.allInThreshold,
		noDonk: undefined,
		mergeSizes: undefined,
	});
	const blueprint = solve(blueprintSpot, {
		workers: options.workers,
		simd: options.simd,
		engine: options.engine,
		targetPercent: options.blueprintTarget ?? 0.5,
		iterations: options.blueprintIterations ?? 300,
	});
	const blueprintMs = Date.now() - started;
	options.onPhase?.('blueprint');
	const bp = blueprint.solver.ctx;
	const bpLines = cutAtTurn(blueprintSpot.tree).leaves;
	if (bpLines.length === 0) throw new Error('The blueprint has no line into the turn');

	// Each leaf's blueprint line: the same last flop aggressor, the nearest pot.
	const sources = cut.leaves.map((line) => {
		let source = 0;
		let bestCost = Number.POSITIVE_INFINITY;
		bpLines.forEach((candidate, s) => {
			const cost = Math.abs(Math.log(line.pot / candidate.pot)) + (candidate.aggressor === line.aggressor ? 0 : 100);
			if (cost < bestCost) {
				bestCost = cost;
				source = s;
			}
		});
		return bpLines[source];
	});

	const lists = bp.active;
	const counts = [lists.count[0], lists.count[1]];
	let leafBytes = 0;

	/**
	 * A leaf spot's ranges from reach at a node: symmetric, and with every
	 * hand of the spot present, however faintly, so its hand lists are the
	 * blueprint's.
	 */
	const leafRange = (reach: Float64Array, p: 0 | 1): Float64Array => {
		const weights = bp.players[p].weights;
		let top = 0;
		for (let c = 0; c < COMBOS; c++) if (reach[c] > top) top = reach[c];
		const out = new Float64Array(COMBOS);
		const from = lists.start[p];
		for (let e = 0; e < lists.count[p]; e++) {
			const lead = lists.memberCombo[lists.memberStart[from + e]];
			for (let m = lists.memberStart[from + e]; m < lists.memberStart[from + e + 1]; m++) {
				const combo = lists.memberCombo[m];
				out[combo] = reach[lead] + 1e-9 * (top > 0 ? top : 1) * weights[combo];
			}
		}
		return out;
	};

	/** One leaf's table: each player's EV per hand for every pair of continuations. */
	const buildTable = (l: number, reach: readonly [Float64Array, Float64Array]): Float64Array => {
		const line = cut.leaves[l];
		const sourceNode = sources[l].origin;
		const leafSpot = defineSpot({
			...config,
			pot: line.pot / full.chipScale,
			stack: (full.stackUnits - line.invested) / full.chipScale,
			chipScale: full.chipScale,
			oop: leafRange(reach[0], 0),
			ip: leafRange(reach[1], 1),
			minWeight: 0,
			maxCombos: undefined,
			maxBytes: Number.POSITIVE_INFINITY,
			// The flop checks through: the leaf spot's betting starts on the turn.
			betSizes: streets(betting.betSizes, []),
			raiseSizes: betting.raiseSizes === undefined ? undefined : streets(raiseRows(betting.raiseSizes), []),
			maxRaises: streets(listed(betting.maxRaises, 1), 1),
			allowAllIn: streets(listed(betting.allowAllIn, false), false),
			allInThreshold: betting.allInThreshold,
			noDonk: undefined,
			mergeSizes: undefined,
		});
		if (leafSpot.runouts.counts[2] !== blueprintSpot.runouts.counts[2]) {
			throw new Error('A leaf spot and the blueprint store different runouts');
		}
		leafBytes = Math.max(leafBytes, leafSpot.estimate.bytes);
		const run = createRun(leafSpot, { workers: options.workers, simd: options.simd, engine: options.engine, precision: 'f32' });
		try {
			const ctx = run.solver.ctx;
			const tree = leafSpot.tree;
			const pairs = matchNodes(tree, firstChance(tree), blueprintSpot.tree, sourceNode);
			// The blueprint's strategy on each matched decision, mapped to the
			// leaf's edges; a decision with no counterpart checks or calls.
			const base = new Float32Array(ctx.strategySum.length);
			const scratch = new Float64Array(16 * COMBOS);
			const passive = (action: number): number => (action === ActionKind.Check || action === ActionKind.Call ? 1 : 0);
			for (const { node, source: from, edges } of pairs) {
				const round = tree.round[node];
				const owner = tree.player[node];
				const actions = tree.numEdges[node];
				for (let board = 0; board < leafSpot.runouts.counts[round]; board++) {
					const count = ctx.active.count[(ctx.active.roundBase[round] + board) * 2 + owner];
					const at = blockBase(ctx.layout, tree, node, board);
					if (from >= 0) {
						averageStrategy(
							bp.strategySum, blockBase(bp.layout, blueprintSpot.tree, from, board),
							blueprintSpot.tree.numEdges[from], count, scratch, bp.regret,
						);
					}
					for (let i = 0; i < count; i++) {
						let total = 0;
						for (let e = 0; e < actions; e++) {
							const f = from < 0 ? -1 : edges[e];
							const p = f < 0 ? 0 : scratch[f * count + i];
							base[at + e * count + i] = p;
							total += p;
						}
						// A hand whose matched actions all vanished checks or calls.
						if (total > 0) continue;
						for (let e = 0; e < actions; e++) base[at + e * count + i] = passive(tree.edgeAction[tree.firstEdge[node] + e]);
					}
				}
			}

			// Every pair of continuations: player 0's `a` against player 1's `b`.
			const pairs0 = counts[0] * counts[1];
			const table = new Float64Array(model === 'pairs' ? 2 * k * k * pairs0 : k * k * (counts[0] + counts[1] + 1));
			const sums = ctx.strategySum as Float32Array;
			const lean = (owner: 0 | 1, bias: ContinuationBias): void => {
				if (bias === 'blueprint') return;
				for (const { node } of pairs) {
					if (tree.player[node] !== owner) continue;
					const round = tree.round[node];
					const actions = tree.numEdges[node];
					for (let board = 0; board < leafSpot.runouts.counts[round]; board++) {
						const count = ctx.active.count[(ctx.active.roundBase[round] + board) * 2 + owner];
						const at = blockBase(ctx.layout, tree, node, board);
						for (let e = 0; e < actions; e++) {
							const factor = biasFactor(bias, tree.edgeAction[tree.firstEdge[node] + e], strength);
							if (factor === 1) continue;
							for (let i = 0; i < count; i++) sums[at + e * count + i] *= factor;
						}
					}
				}
			};
			for (let a = 0; a < k; a++) {
				for (let b = 0; b < k; b++) {
					sums.set(base);
					lean(0, continuations[a]);
					lean(1, continuations[b]);
					if (model === 'pairs') {
						const [t0, t1] = pairTables(run, firstChance(tree), lists);
						table.set(t0, (a * k + b) * pairs0);
						table.set(t1, k * k * pairs0 + (b * k + a) * pairs0);
						continue;
					}
					const { values, totals } = run.solver.rootValues(Mode.Average);
					table[k * k * (counts[0] + counts[1]) + a * k + b] = totals[0];
					for (const p of [0, 1] as const) {
						const evs = run.solver.handEvs(p, values[p]);
						// Each player's rows are by their own pick first.
						const pair = p === 0 ? a * k + b : b * k + a;
						const at = p === 0 ? pair * counts[0] : k * k * counts[0] + pair * counts[1];
						const from = lists.start[p];
						for (let e = 0; e < counts[p]; e++) table[at + e] = evs[lists.list[from + e]];
					}
				}
			}
			options.onLeafSpot?.({ line: line.path, source: sourceNode, run, table }, blueprint);
			return table;
		} finally {
			run.close();
			options.onPhase?.('leaf');
		}
	};

	// 2–3. The leaf tables, against the blueprint's ranges on each line.
	const tablesStarted = Date.now();
	const tables = cut.leaves.map((_, l) =>
		buildTable(l, [blueprint.reachAt(sources[l].origin, 0, 0), blueprint.reachAt(sources[l].origin, 0, 1)]),
	);
	const tablesMs = Date.now() - tablesStarted;
	options.onPhase?.('tables');

	// 4. The flop.
	const run = createRun(flopSpot, { workers: 1, engine: 'js', precision: 'f32' });
	const showdown = showdownTable(config, lists);
	const leaf = makeLeafValues(run.solver.ctx, cut.leaves, tables, k, cut.allIns, showdown.tables, showdown.payoff, model);
	run.solver.ctx.leaf = leaf.values;
	const report: DepthLimitedReport = {
		leaves: cut.leaves.length,
		continuations: k,
		blueprintIterations: blueprint.iterations,
		blueprintExploitability: blueprint.exploitabilityPercent(),
		blueprintBytes: blueprintSpot.estimate.bytes,
		blueprintMs,
		get leafBytes() {
			return leafBytes;
		},
		tablesMs,
		tableBytes: tables.reduce((sum, t) => sum + t.byteLength, 0) + leaf.bytes,
		lines: cut.leaves.map((line, l) => ({ leaf: line.path, source: sources[l].path })),
	};
	return Object.assign(run, {
		report,
		refresh() {
			// Ranges as the flop solve now sends them; a line it no longer
			// plays keeps the blueprint's.
			const now = run.snapshot();
			cut.leaves.forEach((line, l) => {
				const reach = ([0, 1] as const).map((p) => now.reachAt(line.node, 0, p)) as [Float64Array, Float64Array];
				const fresh = reach.every((r) => r.some((x) => x > 1e-6));
				if (fresh) tables[l] = buildTable(l, reach);
			});
		},
	});
}

/**
 * Each player's counterfactual value from `node` (on the flop board) for each
 * of their hand-list entries against each opposing entry at reach 1, an
 * entry's mirrored hands summed in: rows by the player's entries.
 */
function pairTables(run: SolveRun, node: number, lists: Context['active']): [Float64Array, Float64Array] {
	const members = (p: number): Uint16Array =>
		lists.memberCombo.slice(lists.memberStart[lists.start[p]], lists.memberStart[lists.start[p] + lists.count[p]]);
	const mine = members(0);
	const theirs = members(1);
	const rows = run.solver.pairValuesAt(node, 0, 0, theirs, new Float64Array(theirs.length).fill(1), mine, mine.length);
	const column = new Int32Array(COMBOS).fill(-1);
	theirs.forEach((combo, at) => (column[combo] = at));
	const n0 = lists.count[0];
	const n1 = lists.count[1];
	const table0 = new Float64Array(n0 * n1);
	const table1 = new Float64Array(n1 * n0);
	for (let i = 0; i < n0; i++) {
		const lead = lists.memberCombo[lists.memberStart[lists.start[0] + i]];
		for (let j = 0; j < n1; j++) {
			let sum = 0;
			for (let m = lists.memberStart[lists.start[1] + j]; m < lists.memberStart[lists.start[1] + j + 1]; m++) {
				sum += rows[column[lists.memberCombo[m]] * COMBOS + lead];
			}
			table0[i * n1 + j] = sum;
		}
	}
	for (let j = 0; j < n1; j++) {
		const lead = lists.memberCombo[lists.memberStart[lists.start[1] + j]];
		for (let i = 0; i < n0; i++) {
			let sum = 0;
			for (let m = lists.memberStart[lists.start[0] + i]; m < lists.memberStart[lists.start[0] + i + 1]; m++) {
				sum -= rows[column[lead] * COMBOS + lists.memberCombo[m]];
			}
			table1[j * n0 + i] = sum;
		}
	}
	return [table0, table1];
}

/**
 * Who beats whom over every runout from the flop, as counterfactual values
 * for each player's hands against each opposing hand at reach 1, at the
 * payoff of a pot checked down: one table a player, rows by their hand-list
 * entries, columns by the opponent's, an entry's mirrored hands summed in.
 */
export function showdownTable(
	config: SpotConfig,
	lists: Context['active'],
): { tables: [Float64Array, Float64Array]; payoff: number } {
	const spot = defineSpot({
		...config, betSizes: [[]], raiseSizes: undefined, maxRaises: 1, allowAllIn: false, allInThreshold: undefined,
		noDonk: undefined, maxBytes: Number.POSITIVE_INFINITY,
	});
	const run = createRun(spot, { analysisOnly: true, engine: 'js' });
	try {
		const node = firstChance(spot.tree);
		let end = node;
		while (spot.tree.kind[end] === NodeKind.Chance) end = spot.tree.edgeChild[spot.tree.firstEdge[end]];
		while (spot.tree.kind[end] === NodeKind.Decision) end = spot.tree.edgeChild[spot.tree.firstEdge[end]];
		while (spot.tree.kind[end] === NodeKind.Chance) end = spot.tree.edgeChild[spot.tree.firstEdge[end]];
		while (spot.tree.kind[end] === NodeKind.Decision) end = spot.tree.edgeChild[spot.tree.firstEdge[end]];
		if (spot.tree.kind[end] !== NodeKind.TerminalShowdown) throw new Error('A checked-down flop should end in a showdown');
		const [table0, table1] = pairTables(run, node, lists);
		return { tables: [table0, table1], payoff: spot.tree.payoff[end] };
	} finally {
		run.close();
	}
}

/**
 * The leaf values of a depth-limited flop: the tables, the continuation
 * choices CFR trains, and how many of each opponent hand each of a player's
 * hands can face.
 */
function makeLeafValues(
	ctx: Context,
	leaves: readonly LeafLine[],
	tables: readonly Float64Array[],
	k: number,
	allIns: readonly { node: number; payoff: number }[],
	showdown: readonly [Float64Array, Float64Array],
	showdownPayoff: number,
	model: 'additive' | 'pairs',
): { values: LeafValues; bytes: number } {
	const lists = ctx.active;
	const counts = [lists.count[0], lists.count[1]];
	const leafIndex = new Int32Array(ctx.tree.nodeCount).fill(-1);
	leaves.forEach((line, l) => (leafIndex[line.node] = l));
	const allInScale = new Float64Array(ctx.tree.nodeCount);
	for (const { node, payoff } of allIns) allInScale[node] = payoff / showdownPayoff;

	// Opposing hands each entry can be dealt against, members counted.
	const faces = ([0, 1] as const).map((p) => {
		const q = 1 - p;
		const out = new Uint8Array(counts[p] * counts[q]);
		for (let i = 0; i < counts[p]; i++) {
			const mine = lists.memberCombo[lists.memberStart[lists.start[p] + i]];
			const a = COMBO_CARDS[mine * 2];
			const b = COMBO_CARDS[mine * 2 + 1];
			for (let j = 0; j < counts[q]; j++) {
				let n = 0;
				for (let m = lists.memberStart[lists.start[q] + j]; m < lists.memberStart[lists.start[q] + j + 1]; m++) {
					const theirs = lists.memberCombo[m];
					const c = COMBO_CARDS[theirs * 2];
					const d = COMBO_CARDS[theirs * 2 + 1];
					if (c !== a && c !== b && d !== a && d !== b) n++;
				}
				out[i * counts[q] + j] = n;
			}
		}
		return out;
	});

	// Choice accumulators: per leaf, player 0's k rows then player 1's.
	const stride = k * (counts[0] + counts[1]);
	const regret = new Float64Array(leaves.length * stride);
	const strategySum = new Float64Array(leaves.length * stride);
	const choiceBase = (l: number, p: number): number => l * stride + (p === 0 ? 0 : k * counts[0]);
	const mine = new Float64Array(k * COMBOS);
	const theirs = new Float64Array(k * COMBOS);
	const mass = new Float64Array(COMBOS);
	const weighted = new Float64Array(COMBOS);
	const strong = new Float64Array(COMBOS);
	const values = new Float64Array(k * COMBOS);
	const weight = ctx.runoutWeight[0];

	const leafValues: LeafValues = (mode, traverser, iterWeight, node, reachMe, reachOpp, out) => {
		const l = leafIndex[node];
		const p = traverser;
		const q = 1 - p;
		const n = counts[p];
		const m = counts[q];
		if (l < 0) {
			// All in: a showdown on every runout.
			const table = showdown[p];
			const scale = allInScale[node];
			for (let i = 0; i < n; i++) {
				let sum = 0;
				const row = i * m;
				for (let j = 0; j < m; j++) sum += table[row + j] * reachOpp[j];
				out[i] = sum * scale;
			}
			return out;
		}
		const current = mode === Mode.Train || mode === Mode.Current;
		choose(current ? regret : strategySum, choiceBase(l, q), m, theirs, current ? null : regret);

		if (model === 'pairs') {
			const table = tables[l];
			const size = n * m;
			const ownAt = p === 0 ? 0 : k * k * size;
			for (let a = 0; a < k * COMBOS; a++) values[a] = 0;
			for (let b = 0; b < k; b++) {
				for (let j = 0; j < m; j++) weighted[j] = reachOpp[j] * theirs[b * COMBOS + j];
				for (let a = 0; a < k; a++) {
					const at = ownAt + (a * k + b) * size;
					for (let i = 0; i < n; i++) {
						let sum = 0;
						const row = at + i * m;
						for (let j = 0; j < m; j++) sum += table[row + j] * weighted[j];
						values[a * COMBOS + i] += sum;
					}
				}
			}
		} else {
		// The leaf pays a pair of hands `E₀(i) − E₁(j) − C` to player 0: each
		// side's own EV for its hand, less the other's for theirs, centred so
		// that against the ranges the table was built for both players' EVs
		// come out as built. Zero-sum, and linear in either player's reach.
		const face = faces[p];
		const table = tables[l];
		const ownRows = p === 0 ? 0 : k * k * counts[0];
		const otherRows = p === 0 ? k * k * counts[0] : 0;
		const centre = k * k * (counts[0] + counts[1]);
		for (let a = 0; a < k * COMBOS; a++) values[a] = 0;
		for (let b = 0; b < k; b++) {
			// The opponent's reach into pick `b`, and what it faces from each hand.
			for (let j = 0; j < m; j++) weighted[j] = reachOpp[j] * theirs[b * COMBOS + j] * weight;
			for (let i = 0; i < n; i++) {
				let sum = 0;
				const row = i * m;
				for (let j = 0; j < m; j++) sum += face[row + j] * weighted[j];
				mass[i] = sum;
			}
			for (let a = 0; a < k; a++) {
				// Their EV for their hands, my pick `a` against their `b`.
				const theirsAt = otherRows + (b * k + a) * m;
				for (let j = 0; j < m; j++) strong[j] = weighted[j] * table[theirsAt + j];
				const c = p === 0 ? table[centre + a * k + b] : -table[centre + b * k + a];
				const mineAt = ownRows + (a * k + b) * n;
				for (let i = 0; i < n; i++) {
					let against = 0;
					const row = i * m;
					for (let j = 0; j < m; j++) against += face[row + j] * strong[j];
					values[a * COMBOS + i] += (table[mineAt + i] - c) * mass[i] - against;
				}
			}
		}
		}

		if (mode === Mode.BestResponse) {
			for (let i = 0; i < n; i++) {
				let best = values[i];
				for (let a = 1; a < k; a++) if (values[a * COMBOS + i] > best) best = values[a * COMBOS + i];
				out[i] = best;
			}
			return out;
		}
		const own = choiceBase(l, p);
		choose(current ? regret : strategySum, own, n, mine, current ? null : regret);
		for (let i = 0; i < n; i++) {
			let sum = 0;
			for (let a = 0; a < k; a++) sum += mine[a * COMBOS + i] * values[a * COMBOS + i];
			out[i] = sum;
		}
		if (mode !== Mode.Train || !ctx.applyUpdates) return out;
		if (ctx.dcfr) {
			const { keepPositive, keepNegative, keepSum } = dcfrFactors(iterWeight);
			for (let a = 0; a < k; a++) {
				for (let i = 0; i < n; i++) {
					const at = own + a * n + i;
					const r = regret[at];
					regret[at] = r * (r > 0 ? keepPositive : keepNegative) + values[a * COMBOS + i] - out[i];
					strategySum[at] = strategySum[at] * keepSum + reachMe[i] * mine[a * COMBOS + i];
				}
			}
		} else {
			for (let a = 0; a < k; a++) {
				for (let i = 0; i < n; i++) {
					const at = own + a * n + i;
					const r = regret[at] + values[a * COMBOS + i] - out[i];
					regret[at] = r > 0 ? r : 0;
					strategySum[at] += iterWeight * reachMe[i] * mine[a * COMBOS + i];
				}
			}
		}
		return out;
	};
	const bytes =
		regret.byteLength + strategySum.byteLength + faces[0].byteLength + faces[1].byteLength +
		showdown[0].byteLength + showdown[1].byteLength;
	return { values: leafValues, bytes };
}

/**
 * Each hand's share of positive values in a `k`-row block (`count` hands a
 * row) into `into` (rows of COMBOS); with `fallback`, a hand with none reads
 * the fallback's, as `averageStrategy` does; else uniform.
 */
function choose(
	source: RegretStore | SumStore,
	base: number,
	count: number,
	into: Float64Array,
	fallback: RegretStore | null,
): void {
	const k = into.length / COMBOS;
	for (let i = 0; i < count; i++) {
		let total = 0;
		for (let a = 0; a < k; a++) {
			const v = source[base + a * count + i];
			const positive = v > 0 ? v : 0;
			into[a * COMBOS + i] = positive;
			total += positive;
		}
		if (total <= 0 && fallback !== null) {
			for (let a = 0; a < k; a++) {
				const v = fallback[base + a * count + i];
				const positive = v > 0 ? v : 0;
				into[a * COMBOS + i] = positive;
				total += positive;
			}
		}
		for (let a = 0; a < k; a++) into[a * COMBOS + i] = total > 0 ? into[a * COMBOS + i] / total : 1 / k;
	}
}

/**
 * Solve a flop spot depth-limited: `iterations` of the flop, then for each
 * of `refreshes`, a `refresh()` and as many again.
 */
export function solveDepthLimited(
	config: SpotConfig,
	options: DepthLimitedOptions & { readonly iterations?: number; readonly refreshes?: number } = {},
): Solution & { readonly report: DepthLimitedReport } {
	const run = createDepthLimitedRun(config, options);
	try {
		const iterations = options.iterations ?? 200;
		run.step(iterations);
		for (let r = 0; r < (options.refreshes ?? 0); r++) {
			run.refresh();
			run.step(iterations);
		}
		options.onPhase?.('flop');
		return Object.assign(run.snapshot(), { report: run.report });
	} finally {
		run.close();
	}
}
