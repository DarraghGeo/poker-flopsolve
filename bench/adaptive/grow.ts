/**
 * Growing a budgeted tree (issue #51): start from one size per node and add
 * the cut lines of a full tree whose best-response gain per byte is highest,
 * until a byte budget is used.
 *
 * A budgeted tree is the full tree with some bets, raises and shoves cut out
 * by `removeActions`. It is described here by the set of sized edges of the
 * full tree it keeps: walking the full tree from the root, a sized edge not
 * kept is cut, and its subtree is not visited. The cuts met that way are
 * exactly its `removeActions`, and each of them is a candidate to add back.
 */

import v8 from 'node:v8';
import vm from 'node:vm';
import { COMBO_CARDS, createRun, defineSpot, DECK } from '../../src/index.ts';
import type { Precision, SolveRun, Spot, SpotConfig } from '../../src/index.ts';
import { orbitLeader } from '../../src/cfr.ts';
import { ActionKind, actionLabel, NodeKind } from '../../src/tree.ts';
import type { Tree } from '../../src/tree.ts';
import { warmStart } from '../../src/warm.ts';
import { boardDeals } from './measure.ts';

v8.setFlagsFromString('--expose-gc');
const collect = vm.runInNewContext('gc') as () => void;

/**
 * Let closed runs go: their worker threads finish terminating only once the
 * event loop turns, and their storage, outside the JS heap, is freed only by
 * a collection. A synchronous chain of runs otherwise keeps every one of them.
 */
export async function release(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 250));
	collect();
}

/** One bet, raise or shove of the full tree. */
export interface SizedEdge {
	readonly edge: number;
	readonly parent: number;
	/** Path of the node it leads to: what `removeActions` names it by. */
	readonly path: string;
	readonly kind: number;
	readonly round: number;
	/** Bets and raises: the amount beyond a call over the pot after calling. */
	readonly fraction: number;
	readonly facingBet: boolean;
	/** Kept in the one-size starting tree. */
	readonly base: boolean;
}

/** A full tree to cut from, with what every cut costs. */
export interface FullTree {
	readonly config: SpotConfig;
	readonly tree: Tree;
	readonly paths: string[];
	readonly sized: Map<number, SizedEdge>;
	readonly byPath: Map<string, SizedEdge>;
	/** Hand rows of all stored boards of a round, per player: slots per action. */
	readonly rows: number[][];
	/** Bytes of everything but the decision storage: the showdown tables. */
	readonly fixedBytes: number;
}

/** Every node's readable path, as `Solution.path` writes it. */
export function nodePaths(tree: Tree, chipScale: number): string[] {
	const paths = new Array<string>(tree.nodeCount).fill('');
	paths[0] = '';
	const visit = (node: number): void => {
		for (let e = 0; e < tree.numEdges[node]; e++) {
			const edge = tree.firstEdge[node] + e;
			const child = tree.edgeChild[edge];
			const step = tree.kind[node] === NodeKind.Decision ? actionLabel(tree.edgeAction[edge], tree.edgeTarget[edge], chipScale) : '/';
			paths[child] = paths[node] ? `${paths[node]} ${step}` : step;
			visit(child);
		}
	};
	visit(0);
	return paths;
}

/**
 * Index a full tree.
 * @param baseFraction the one size every opening bet and raise keeps
 */
export function indexFull(config: SpotConfig, baseFraction = 0.75): FullTree {
	const spot = defineSpot({ ...config, removeActions: undefined });
	const { tree, chipScale, potUnits, stackUnits } = spot;
	const paths = nodePaths(tree, chipScale);
	const sized = new Map<number, SizedEdge>();
	const byPath = new Map<string, SizedEdge>();
	const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.02;

	const walk = (node: number, inv: [number, number]): void => {
		if (tree.kind[node] === NodeKind.Chance) {
			walk(tree.edgeChild[tree.firstEdge[node]], inv);
			return;
		}
		if (tree.kind[node] !== NodeKind.Decision) return;
		const me = tree.player[node];
		const mine = inv[me];
		const theirs = inv[1 - me];
		const owed = Math.max(0, theirs - mine);
		const potAfterCall = potUnits + inv[0] + inv[1] + owed;
		const infos: SizedEdge[] = [];
		for (let e = 0; e < tree.numEdges[node]; e++) {
			const edge = tree.firstEdge[node] + e;
			const kind = tree.edgeAction[edge];
			if (kind < ActionKind.Bet) continue;
			infos.push({
				edge, parent: node, path: paths[tree.edgeChild[edge]], kind, round: tree.round[node],
				fraction: (tree.edgeTarget[edge] - mine - owed) / potAfterCall, facingBet: owed > 0, base: false,
			});
		}
		// The base size, or a shove where the base size would be one.
		const hasBase = infos.some((info) => info.kind !== ActionKind.AllIn && near(info.fraction, baseFraction));
		const baseShoves = !hasBase && mine + owed + baseFraction * potAfterCall >= stackUnits;
		for (const info of infos) {
			const base = info.kind === ActionKind.AllIn ? baseShoves : near(info.fraction, baseFraction);
			const entry = { ...info, base };
			sized.set(info.edge, entry);
			byPath.set(info.path, entry);
		}
		for (let e = 0; e < tree.numEdges[node]; e++) {
			const edge = tree.firstEdge[node] + e;
			const next: [number, number] = [...inv];
			next[me] = Math.max(inv[me], tree.edgeTarget[edge]);
			walk(tree.edgeChild[edge], next);
		}
	};
	walk(0, [0, 0]);

	const fixedBytes = spot.estimate.bytes - 8 * spot.estimate.totalSlots;
	return { config, tree, paths, sized, byPath, rows: handRows(spot), fixedBytes };
}

/** Hand rows of all stored boards of each round, per player, as `buildLayout` counts them. */
function handRows(spot: Spot): number[][] {
	const { runouts, players } = spot;
	const rows: number[][] = [];
	const onBoard = new Uint8Array(DECK);
	for (let round = 0; round < runouts.rounds; round++) {
		const pair = [0, 0];
		const width = runouts.width[round];
		for (let board = 0; board < runouts.counts[round]; board++) {
			onBoard.fill(0);
			for (let i = 0; i < width; i++) onBoard[runouts.cards[round][board * width + i]] = 1;
			for (const p of [0, 1]) {
				const index = players[p];
				for (let i = 0; i < index.count; i++) {
					const combo = index.combos[i];
					if (onBoard[COMBO_CARDS[combo * 2]] || onBoard[COMBO_CARDS[combo * 2 + 1]]) continue;
					if (!orbitLeader(runouts, round, board, combo)) continue;
					pair[p]++;
				}
			}
		}
		rows.push(pair);
	}
	return rows;
}

/** The set of sized edges the one-size starting tree keeps. */
export function baseKept(full: FullTree): Set<string> {
	const kept = new Set<string>();
	for (const info of full.sized.values()) if (info.base) kept.add(info.path);
	return kept;
}

/** Cut lines of the budgeted tree keeping `kept`: its `removeActions`, and its candidates. */
export function cutsFor(full: FullTree, kept: ReadonlySet<string>): string[] {
	const { tree, sized } = full;
	const cuts: string[] = [];
	const walk = (node: number): void => {
		for (let e = 0; e < tree.numEdges[node]; e++) {
			const edge = tree.firstEdge[node] + e;
			const info = sized.get(edge);
			if (info && !kept.has(info.path)) {
				cuts.push(info.path);
				continue;
			}
			walk(tree.edgeChild[edge]);
		}
	};
	walk(0);
	return cuts;
}

/** Decision slots below `node` in the budgeted tree, its own block included. */
function slotsBelow(full: FullTree, kept: ReadonlySet<string>, node: number): number {
	const { tree, sized, rows } = full;
	let total = 0;
	let actions = 0;
	for (let e = 0; e < tree.numEdges[node]; e++) {
		const edge = tree.firstEdge[node] + e;
		const info = sized.get(edge);
		if (info && !kept.has(info.path)) continue;
		actions++;
		total += slotsBelow(full, kept, tree.edgeChild[edge]);
	}
	if (tree.kind[node] === NodeKind.Decision) total += actions * rows[tree.round[node]][tree.player[node]];
	return total;
}

/** Storage of the budgeted tree at 32 bits, as `Estimate.bytes` counts it. */
export function treeBytes(full: FullTree, kept: ReadonlySet<string>): number {
	return full.fixedBytes + 8 * slotsBelow(full, kept, 0);
}

/** What adding one cut line back costs at 32 bits: its subtree, and its row at the parent. */
export function lineBytes(full: FullTree, kept: ReadonlySet<string>, line: string): number {
	const info = full.byPath.get(line)!;
	const child = full.tree.edgeChild[info.edge];
	const withIt = new Set(kept).add(line);
	return 8 * (slotsBelow(full, withIt, child) + full.rows[info.round][full.tree.player[info.parent]]);
}

/** The spot for a budgeted tree. */
export function budgetedConfig(full: FullTree, kept: ReadonlySet<string>): SpotConfig {
	const cuts = cutsFor(full, kept);
	return { ...full.config, removeActions: cuts.length ? cuts : undefined };
}

/** Options for solving and probing. */
export interface GrowOptions {
	readonly precision?: Precision;
	readonly workers?: number;
	/** Iterations a probe runs after its warm start. */
	readonly probeIterations?: number;
	/** The iteration count a probe resumes at, which sets how fast inherited regrets fade. */
	readonly probeResume?: number;
	/** Largest probe tree, at 32 bits; candidates are probed in chunks that fit. */
	readonly probeBytes?: number;
	/** Probe every n-th stored board of a candidate's round, to bound the cost. */
	readonly boardStride?: number;
	/** Which gain ranks the lines; default 'bestResponse'. */
	readonly estimator?: 'bestResponse' | 'firstOrder';
	readonly log?: (message: string) => void;
}

/**
 * Solve a spot to a target, warm from a run of another tree where given
 * (every bet mapped to the nearest one).
 */
export function solveTo(
	config: SpotConfig,
	targetPercent: number,
	maxIterations: number,
	options: GrowOptions,
	from?: SolveRun,
	resume?: number,
): { run: SolveRun; seconds: number; exploitability: number } {
	const started = performance.now();
	const spot = defineSpot(config);
	const run = createRun(spot, {
		precision: options.precision,
		workers: options.workers ?? 1,
		...(from ? { warmStart: from, warmIteration: resume ?? from.totalIterations } : {}),
	});
	if (from) warmStart(run.solver.ctx, from.solver.ctx, false, undefined, Infinity);
	let next = 10;
	let exploitability = Infinity;
	while (run.completed < maxIterations) {
		run.step(Math.min(next, maxIterations) - run.completed);
		exploitability = run.exploitabilityPercent();
		options.log?.(`    ${run.completed} iterations, ${exploitability.toFixed(3)}% of pot`);
		if (exploitability <= targetPercent) break;
		next = Math.ceil(run.completed * 1.3);
	}
	return { run, seconds: (performance.now() - started) / 1000, exploitability };
}

/**
 * Best-response gain of each candidate line against the strategy of a run
 * that contains it: summed over the actor's hands at the parent node, how much
 * more the hand would win taking the candidate (and playing on as the run
 * does) than its best action of the tree without the candidates. In % of pot
 * over the whole game.
 */
export function lineGains(run: SolveRun, lines: readonly string[], boardStride = 1): Map<string, LineGain> {
	const { spot, solver } = run;
	const { tree, runouts } = spot;
	const solution = run.snapshot();
	const paths = nodePaths(tree, spot.chipScale);
	const nodeOf = new Map<string, number>();
	paths.forEach((path, node) => nodeOf.set(path, node));
	const parent = new Int32Array(tree.nodeCount).fill(-1);
	for (let node = 0; node < tree.nodeCount; node++) {
		for (let e = 0; e < tree.numEdges[node]; e++) parent[tree.edgeChild[tree.firstEdge[node] + e]] = node;
	}
	const deals = boardDeals(runouts);
	const pot = spot.potUnits / spot.chipScale;
	const isCandidate = new Set(lines);

	// Candidates by the node they leave.
	const byParent = new Map<number, number[]>();
	for (const line of lines) {
		const child = nodeOf.get(line);
		if (child === undefined) throw new Error(`probe tree lacks ${line}`);
		const list = byParent.get(parent[child]) ?? [];
		list.push(child);
		byParent.set(parent[child], list);
	}

	const gains = new Map<string, LineGain>();
	for (const [node] of byParent) {
		const owner = tree.player[node] as 0 | 1;
		const round = tree.round[node];
		const actions = tree.numEdges[node];
		const old: number[] = [];
		const fresh: number[] = [];
		for (let e = 0; e < actions; e++) {
			const child = tree.edgeChild[tree.firstEdge[node] + e];
			(isCandidate.has(paths[child]) ? fresh : old).push(e);
		}
		const sums = new Float64Array(actions);
		const used = new Float64Array(actions);
		const index = spot.players[owner];
		const boards = runouts.counts[round];
		const stride = boards >= boardStride * 4 ? boardStride : 1;
		for (let board = 0; board < boards; board += stride) {
			const mine = solution.reachAt(node, board, owner);
			let mass = 0;
			for (let i = 0; i < index.count; i++) mass += mine[index.combos[i]];
			if (mass === 0) continue;
			const theirs = solution.reachAt(node, board, (1 - owner) as 0 | 1);
			const q = Array.from({ length: actions }, (_, e) =>
				solver.valuesAt(tree.edgeChild[tree.firstEdge[node] + e], board, owner, mine, theirs, solver.rootLive, solver.rootCount),
			);
			const { probs } = solver.averageStrategyAt(node, board);
			for (const e of fresh) {
				let gain = 0;
				let firstOrder = 0;
				for (let i = 0; i < index.count; i++) {
					const combo = index.combos[i];
					if (mine[combo] === 0) continue;
					let best = -Infinity;
					for (const a of old) if (q[a][combo] > best) best = q[a][combo];
					const better = q[e][combo] - best;
					if (better > 0) gain += mine[combo] * better;
					firstOrder += mine[combo] * probs[i * actions + e] * better;
				}
				sums[e] += gain * deals[round][board] * stride;
				used[e] += firstOrder * deals[round][board] * stride;
			}
		}
		const scale = 100 / solver.ctx.totalMass / pot;
		for (const e of fresh) {
			gains.set(paths[tree.edgeChild[tree.firstEdge[node] + e]], { bestResponse: sums[e] * scale, firstOrder: used[e] * scale });
		}
	}
	return gains;
}

/**
 * A line's gain two ways, % of pot over the whole game. `bestResponse`: each
 * hand takes the line where it beats the best old action, by that margin.
 * `firstOrder`: each hand takes it as often as the probe's average strategy
 * does, by its margin over the best old action, which can be negative.
 */
export interface LineGain {
	readonly bestResponse: number;
	readonly firstOrder: number;
}

/** One round of growth: what was probed, what each line earned, what was added. */
export interface GrowRound {
	readonly bytes: number;
	readonly exploitability: number;
	readonly candidates: number;
	readonly added: { line: string; gain: number; bytes: number }[];
	readonly seconds: number;
}

/**
 * Probe every candidate line of the budgeted tree `kept`, solved in `run`:
 * chunks of candidates whose probe tree fits `probeBytes`, each warm-started
 * from `run`, iterated a little, and measured. Returns each line's gain and cost.
 */
export async function probeAll(
	full: FullTree,
	kept: ReadonlySet<string>,
	run: SolveRun,
	options: GrowOptions,
): Promise<{ line: string; gain: number; firstOrder: number; bytes: number }[]> {
	const log = options.log ?? (() => {});
	const cap = options.probeBytes ?? 2 * 2 ** 30;
	const lines = cutsFor(full, kept).map((line) => ({ line, bytes: lineBytes(full, kept, line) }));
	const base = treeBytes(full, kept);
	// Cheapest first, and by street, so a chunk shares rounds and fills well.
	lines.sort((a, b) => full.byPath.get(a.line)!.round - full.byPath.get(b.line)!.round || a.bytes - b.bytes);
	const chunks: { line: string; bytes: number }[][] = [];
	let chunk: { line: string; bytes: number }[] = [];
	let used = base;
	for (const entry of lines) {
		if (base + entry.bytes > cap) continue; // never fits beside the tree; never added either
		if (used + entry.bytes > cap && chunk.length) {
			chunks.push(chunk);
			chunk = [];
			used = base;
		}
		chunk.push(entry);
		used += entry.bytes;
	}
	if (chunk.length) chunks.push(chunk);

	const out: { line: string; gain: number; firstOrder: number; bytes: number }[] = [];
	for (const [i, entries] of chunks.entries()) {
		const withChunk = new Set(kept);
		for (const entry of entries) withChunk.add(entry.line);
		const config = budgetedConfig(full, withChunk);
		const started = performance.now();
		const probe = createRun(defineSpot(config), {
			precision: options.precision,
			workers: options.workers ?? 1,
			warmStart: run,
			warmIteration: options.probeResume ?? 10,
		});
		warmStart(probe.solver.ctx, run.solver.ctx, false, undefined, Infinity);
		probe.step(options.probeIterations ?? 20);
		probe.close();
		const gains = lineGains(probe, entries.map((entry) => entry.line), options.boardStride ?? 1);
		for (const entry of entries) {
			const gain = gains.get(entry.line);
			const value = options.estimator === 'firstOrder' ? gain?.firstOrder : gain?.bestResponse;
			out.push({ ...entry, gain: value ?? 0, firstOrder: gain?.firstOrder ?? 0 });
		}
		log(`  probe ${i + 1}/${chunks.length}: ${entries.length} lines, ${((performance.now() - started) / 1000).toFixed(0)} s, rss ${(process.memoryUsage().rss / 2 ** 30).toFixed(2)} GiB`);
		await release();
	}
	return out;
}
