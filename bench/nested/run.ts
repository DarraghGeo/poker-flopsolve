/**
 * Issue #47: solve a blueprint (T's flop betting, simplified turn and river),
 * measure it against a reference from `reference.ts`, then re-solve the
 * sampled turn nodes at T's full betting with each gadget and measure those.
 *
 *   node --import tsx bench/nested/run.ts <rainbow|monotone> <variant> [iterations] [gadgets]
 *
 * Writes `scratch/nested/<board>-T/run-<variant>.json` and prints a summary.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { COMBOS, createRun, defineSpot, NodeKind, solve } from '../../src/index.ts';
import type { Solution, SolveRun, SpotConfig } from '../../src/index.ts';
import { Mode, matchupMass } from '../../src/cfr.ts';
import { resolveSubgame } from '../../src/resolve.ts';
import { copySubtree } from '../../src/subtree.ts';
import type { Gadget } from '../../src/resolve.ts';
import { configFromJson, fromJson, lineNode, nodeEvs, openMass, rootActionEvs, rootEvs, toJson, turnBoard } from './lib.ts';
import { blueprint, small, target, VARIANTS, type BoardName } from './spots.ts';


const [boardName, variantName, iterArg, gadgetArg] = process.argv.slice(2) as [BoardName, string, string?, string?];
const variant = VARIANTS[variantName];
if (!variant) throw new Error(`unknown variant ${variantName}`);
const RESOLVE_ITERATIONS = Number(iterArg ?? 300);
const GADGETS = (gadgetArg ?? 'unsafe,resolve,maxmargin,reach-maxmargin').split(',') as Gadget[];
// NESTED_VALUES=blueprint guarantees blueprint values instead of best responses.
const VALUES = process.env.NESTED_VALUES === 'blueprint' ? 'blueprint' : 'best-response';
// NESTED_REF=T0 measures against the smaller tree's reference instead.
const refTree = process.env.NESTED_REF === 'T0' ? 'T0' : 'T';
const full = (refTree === 'T0' ? small : target)(boardName);
const REF = new URL(`../../scratch/nested/${boardName}-${refTree}/`, import.meta.url);
const GiB = 2 ** 30;
const MiB = 2 ** 20;

// ---------------------------------------------------------------- blueprint
const config: SpotConfig = { ...blueprint(full, variant.later), runoutBuckets: variant.buckets ?? false };
const spot = defineSpot(config);
console.log(
	`${boardName} ${variantName}: ${spot.estimate.decisionNodes} nodes, ${spot.estimate.runouts} runouts, ` +
		`${(spot.estimate.bytes / MiB).toFixed(0)} MiB f32 / ${(spot.estimate.compressedBytes / MiB).toFixed(0)} MiB i16`,
);
const started = performance.now();
const bp = solve(spot, {
	workers: 4,
	targetPercent: 0.3,
	iterations: 2000,
	precision: variant.precision,
	onProgress: (p) =>
		console.log(`  ${p.iteration} it, ${((100 * p.exploitability) / full.pot).toFixed(3)}%, ${(p.elapsedMs / 1000).toFixed(0)} s`),
});
const solveSeconds = (performance.now() - started) / 1000;
const storageBytes = variant.precision === 'i16' ? spot.estimate.compressedBytes : spot.estimate.bytes;
const rssAfterSolve = process.resourceUsage().maxRSS * 1024;
console.log(
	`blueprint: ${bp.iterations} it, ${bp.exploitabilityPercent().toFixed(3)}% (own game), ${solveSeconds.toFixed(0)} s, ` +
		`storage ${(storageBytes / MiB).toFixed(0)} MiB, peak RSS ${(rssAfterSolve / MiB).toFixed(0)} MiB`,
);

// ---------------------------------------------------------------- root EVs
const reference = JSON.parse(readFileSync(new URL('root.json', REF), 'utf8')) as {
	evs: (number | null)[][];
	actions: { player: 0 | 1; actions: string[]; evs: (number | null)[][]; reach: (number | null)[]; probs?: (number | null)[][] }[];
};
const refEvs = reference.evs.map(fromJson);
const evs = rootEvs(bp);
const weights = [spot.players[0].weights, spot.players[1].weights];

interface Err {
	mae: number;
	max: number;
	range: number;
}
function evError(a: number[], b: number[], w: Float64Array, opp: Float64Array): Err {
	const open = openMass(opp);
	let sum = 0;
	let mass = 0;
	let max = 0;
	let ra = 0;
	let rb = 0;
	let rm = 0;
	for (let h = 0; h < COMBOS; h++) {
		if (!(w[h] > 0) || Number.isNaN(a[h]) || Number.isNaN(b[h])) continue;
		const gap = Math.abs(a[h] - b[h]);
		sum += w[h] * gap;
		mass += w[h];
		if (w[h] >= 0.01 && gap > max) max = gap;
		ra += w[h] * open[h] * a[h];
		rb += w[h] * open[h] * b[h];
		rm += w[h] * open[h];
	}
	return { mae: sum / mass, max, range: Math.abs(ra - rb) / rm };
}
const rootError = ([0, 1] as const).map((p) => evError(evs[p], refEvs[p], weights[p], weights[1 - p]));
console.log(
	`root EV error (% pot): OOP mae ${rootError[0].mae.toFixed(3)} max ${rootError[0].max.toFixed(3)} range ${rootError[0].range.toFixed(3)}; ` +
		`IP mae ${rootError[1].mae.toFixed(3)} max ${rootError[1].max.toFixed(3)} range ${rootError[1].range.toFixed(3)}`,
);

// Per-action EVs at the root decisions, and which size each hand prefers.
const actions = rootActionEvs(bp);
const sizeReport = actions.map((mine, d) => {
	const ref = reference.actions[d];
	if (mine.actions.join() !== ref.actions.join()) throw new Error(`root actions differ: ${mine.actions} vs ${ref.actions}`);
	const reach = fromJson(ref.reach);
	const sized = mine.actions.map((a, i) => (a.startsWith('bet') ? i : -1)).filter((i) => i >= 0);
	const perAction = mine.actions.map((name, a) => {
		const err = evError(mine.evs[a], fromJson(ref.evs[a]), Float64Array.from(reach, (x) => (x > 0 ? x : 0)), new Float64Array(COMBOS).fill(1));
		return { action: name, mae: err.mae, max: err.max };
	});
	const refEv = ref.evs.map(fromJson);
	let agree = 0;
	let agreeBest = 0;
	let mass = 0;
	let tvSum = 0;
	for (let h = 0; h < COMBOS; h++) {
		const w = reach[h];
		if (!(w > 0)) continue;
		const pick = (table: number[][]): number => {
			let best = -1;
			for (const a of sized) if (!Number.isNaN(table[a][h]) && (best < 0 || table[a][h] > table[best][h])) best = a;
			return best;
		};
		const mineEv = mine.evs;
		const a = pick(mineEv);
		const b = pick(refEv);
		if (a < 0 || b < 0) continue;
		mass += w;
		if (a === b) agree += w;
		// Best of all actions, check included.
		const all = (table: number[][]): number => table.reduce((best, row, i) => (row[h] > table[best][h] ? i : best), 0);
		if (all(mineEv) === all(refEv)) agreeBest += w;
		if (ref.probs) {
			let tv = 0;
			for (let x = 0; x < mine.actions.length; x++) tv += Math.abs(mine.probs[x][h] - (ref.probs[x][h] ?? 0));
			tvSum += (w * tv) / 2;
		}
	}
	return {
		player: mine.player,
		perAction,
		sizeAgreement: agree / mass,
		bestActionAgreement: agreeBest / mass,
		strategyTv: ref.probs ? tvSum / mass : null,
	};
});
for (const s of sizeReport) {
	console.log(
		`  ${s.player ? 'IP after check' : 'OOP at root'}: size agreement ${(100 * s.sizeAgreement).toFixed(1)}%, ` +
			`best-action agreement ${(100 * s.bestActionAgreement).toFixed(1)}%` +
			(s.strategyTv !== null ? `, strategy TV ${s.strategyTv.toFixed(3)}` : '') +
			`; action EV mae ${s.perAction.map((a) => `${a.action} ${a.mae.toFixed(2)}`).join(', ')}`,
	);
}

// ---------------------------------------------------------------- re-solves
const later = {
	betSizes: full.betSizes,
	raiseSizes: full.raiseSizes,
	maxRaises: full.maxRaises,
	allowAllIn: full.allowAllIn,
	maxBytes: full.maxBytes,
};

/** Action class for comparing trees with different sizes: fold, passive, aggressive. */
const actionClass = (label: string): number => (label.startsWith('fold') ? 0 : label.startsWith('check') || label.startsWith('call') ? 1 : 2);

/** The analysis-only reference subgame saved by `reference.ts`. */
function loadReference(key: string): {
	run: SolveRun;
	sol: Solution;
	meta: { line: string; turn: string; lineReach?: number; localExploitability?: number };
} {
	const meta = JSON.parse(readFileSync(new URL(`${key}.json`, REF), 'utf8'));
	const run = createRun(defineSpot(configFromJson(meta.config)), { analysisOnly: true });
	const bytes = readFileSync(new URL(`${key}.sums`, REF));
	const sums = run.solver.ctx.strategySum as Float32Array;
	if (bytes.byteLength !== sums.byteLength) throw new Error(`${key}: sums size mismatch`);
	sums.set(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
	return { run, sol: run.snapshot(), meta };
}

/**
 * Reach-weighted total-variation distance between `a`'s and `ref`'s strategies
 * for `player` at every turn-round decision of `player`, weighted by joint
 * reach in `ref`. With `classes`, actions are first grouped into fold /
 * check-call / bet-raise, so trees with different sizes compare; then each
 * node is matched by its path of action classes and `a`'s tree may differ.
 */
function turnTv(a: Solution, ref: Solution, player: 0 | 1, classes: boolean): number {
	const tree = ref.spot.tree;
	let sum = 0;
	let mass = 0;
	const nodesA = new Map<string, number>();
	const sameTree = a.spot.tree.nodeCount === tree.nodeCount;
	if (classes && !sameTree) {
		const t = a.spot.tree;
		for (let n = 0; n < t.nodeCount; n++) {
			if (t.kind[n] !== NodeKind.Decision || t.round[n] !== 0) continue;
			const key = classPath(a, n);
			if (!nodesA.has(key)) nodesA.set(key, n);
		}
	}
	for (let node = 0; node < tree.nodeCount; node++) {
		if (tree.kind[node] !== NodeKind.Decision || tree.round[node] !== 0 || tree.player[node] !== player) continue;
		const mine = classes && !sameTree ? nodesA.get(classPath(ref, node)) : node;
		if (mine === undefined) continue;
		const reachP = ref.reachAt(node, 0, player);
		const reachO = ref.reachAt(node, 0, (1 - player) as 0 | 1);
		const open = openMass(reachO);
		const x = a.strategyAt(mine, 0);
		const y = ref.strategyAt(node, 0);
		const slotX = new Map<number, number>();
		x.combos.forEach((c, i) => slotX.set(c, i));
		for (let i = 0; i < y.combos.length; i++) {
			const combo = y.combos[i];
			const w = reachP[combo] * open[combo];
			if (!(w > 0)) continue;
			const j = slotX.get(combo);
			if (j === undefined) continue;
			const px = classes ? [0, 0, 0] : Array.from(x.probs.subarray(j * x.actions.length, (j + 1) * x.actions.length));
			const py = classes ? [0, 0, 0] : Array.from(y.probs.subarray(i * y.actions.length, (i + 1) * y.actions.length));
			if (classes) {
				x.actions.forEach((label, k) => (px[actionClass(label)] += x.probs[j * x.actions.length + k]));
				y.actions.forEach((label, k) => (py[actionClass(label)] += y.probs[i * y.actions.length + k]));
			}
			let tv = 0;
			for (let k = 0; k < px.length; k++) tv += Math.abs(px[k] - py[k]);
			sum += (w * tv) / 2;
			mass += w;
		}
	}
	return mass > 0 ? sum / mass : Number.NaN;
}

/** A turn-round node's path within its subgame, by action class. */
function classPath(sol: Solution, node: number): string {
	const path = sol.path(node);
	if (path === '(root)') return '';
	return path
		.split(/ (?=[a-z])/)
		.map((step) => actionClass(step))
		.join('');
}

/**
 * The opponent's best response to `sol`'s `player` strategy minus the
 * opponent's value in the reference, both under the reference ranges, as a
 * percentage of the subgame's pot. What the refined player gives away
 * against the ranges that truly arrive.
 */
function gain(sol: Solution, ref: Solution, player: 0 | 1): number {
	const opponent = (1 - player) as 0 | 1;
	const reachP = ref.spot.players[player].weights;
	const reachO = ref.spot.players[opponent].weights;
	// Restricted to hands the re-solve knows; a hand the blueprint never
	// brings here has no strategy in it.
	const knownP = Float64Array.from(reachP, (w, h) => (sol.spot.players[player].slot[h] >= 0 ? w : 0));
	const knownO = Float64Array.from(reachO, (w, h) => (sol.spot.players[opponent].slot[h] >= 0 ? w : 0));
	const br = nodeEvs(sol, 0, 0, opponent, knownO, knownP, Mode.BestResponse);
	const eq = nodeEvs(ref, 0, 0, opponent, knownO, knownP, Mode.Average);
	const open = openMass(knownP);
	let sum = 0;
	let mass = 0;
	for (let h = 0; h < COMBOS; h++) {
		if (!(knownO[h] > 0) || Number.isNaN(br[h]) || Number.isNaN(eq[h])) continue;
		sum += knownO[h] * open[h] * (br[h] - eq[h]);
		mass += knownO[h] * open[h];
	}
	return (100 * (sum / mass)) / (sol.spot.potUnits / sol.spot.chipScale);
}

/** Share of the reference reach (joint) the re-solve's ranges miss. */
function missing(sol: Solution, ref: Solution): number {
	const r = [0, 1].map((p) => ref.spot.players[p].weights);
	const k = [0, 1].map((p) => Float64Array.from(r[p], (w, h) => (sol.spot.players[p].slot[h] >= 0 ? w : 0)));
	return 1 - matchupMass(k[0], k[1]) / matchupMass(r[0], r[1]);
}

/** Total variation between the normalised ranges of two solutions at their roots. */
function rangeTv(a: Float64Array, b: Float64Array): number {
	const sa = a.reduce((s, x) => s + x, 0);
	const sb = b.reduce((s, x) => s + x, 0);
	let tv = 0;
	for (let h = 0; h < COMBOS; h++) tv += Math.abs(a[h] / sa - b[h] / sb);
	return tv / 2;
}

const keys = readdirSync(REF)
	// Turn subgames only, not the whole saved strategy.
	.filter((f) => f.endsWith('.sums') && f !== 'strategy.sums')
	.map((f) => f.slice(0, -5));
const nodeResults: unknown[] = [];
for (const key of keys) {
	const { sol: ref, run: refRun, meta } = loadReference(key);
	const node = lineNode(bp, meta.line);
	const board = turnBoard(bp, meta.turn);
	const subBp = defineSpot(bp.subgameAt(node, board));
	// The blueprint's own play at the node, as a subgame for comparing.
	const bpSub = createRun(subBp, { analysisOnly: true });
	copySubtree(bpSub.solver.ctx, bp.solver.ctx, true, node);
	const bpSol = bpSub.snapshot();
	const refPot = ref.spot.potUnits / ref.spot.chipScale;
	const row: Record<string, unknown> = {
		key,
		pot: refPot,
		lineReach: meta.lineReach,
		referenceExploitability: meta.localExploitability,
		reachTv: [0, 1].map((p) => rangeTv(bpSol.spot.players[p].weights, ref.spot.players[p].weights)),
		referenceGain: [gain(ref, ref, 0), gain(ref, ref, 1)],
		blueprintClassTv: [turnTv(bpSol, ref, 0, true), turnTv(bpSol, ref, 1, true)],
		resolves: [] as unknown[],
	};
	console.log(
		`${key} (pot ${refPot}, line reached ${(100 * (meta.lineReach ?? 0)).toFixed(1)}%, reference local expl ` +
			`${(meta.localExploitability ?? Number.NaN).toFixed(2)}%): blueprint reach TV ${(row.reachTv as number[]).map((x) => x.toFixed(3)).join('/')}, ` +
			`blueprint class-TV ${(row.blueprintClassTv as number[]).map((x) => x.toFixed(3)).join('/')}, ` +
			`reference self-gain ${(row.referenceGain as number[]).map((x) => x.toFixed(3)).join('/')}`,
	);
	bpSub.close();
	for (const gadget of GADGETS) {
		for (const player of [0, 1] as const) {
			const t = performance.now();
			const resolved = resolveSubgame(bp, node, board, { player, gadget, betting: later, iterations: RESOLVE_ITERATIONS, values: VALUES, measure: true });
			const ms = performance.now() - t;
			const sub = resolved.solution;
			if (sub.spot.tree.nodeCount !== ref.spot.tree.nodeCount) throw new Error(`${key}: re-solved tree differs from the reference's`);
			let margin = Number.NaN;
			if (resolved.alternative && resolved.entered) {
				// Range-weighted mean of (best response - guaranteed), chips → % pot.
				const w = sub.spot.players[1 - player].weights;
				let s = 0;
				let m = 0;
				for (let h = 0; h < COMBOS; h++) {
					if (!(w[h] > 0) || Number.isNaN(resolved.entered[h])) continue;
					s += w[h] * (resolved.entered[h] - resolved.alternative[h]);
					m += w[h];
				}
				margin = (100 * s) / m / refPot;
			}
			const result = {
				gadget,
				player,
				ms,
				bytes: sub.spot.estimate.bytes,
				tv: turnTv(sub, ref, player, false),
				classTv: turnTv(sub, ref, player, true),
				gain: gain(sub, ref, player),
				missing: missing(sub, ref),
				margin,
			};
			(row.resolves as unknown[]).push(result);
			console.log(
				`  ${gadget.padEnd(15)} p${player}: ${(ms / 1000).toFixed(1)} s, ${(result.bytes / MiB).toFixed(1)} MiB, ` +
					`TV ${result.tv.toFixed(3)}, class-TV ${result.classTv.toFixed(3)}, gain ${result.gain.toFixed(3)}% pot, ` +
					`excess over blueprint ${Number.isNaN(margin) ? '-' : margin.toFixed(3)}%`,
			);
		}
	}
	refRun.close();
	nodeResults.push(row);
}

writeFileSync(
	new URL(`run-${variantName}${VALUES === 'blueprint' ? '-ev' : ''}.json`, REF),
	JSON.stringify(
		{
			board: boardName,
			variant: variantName,
			resolveIterations: RESOLVE_ITERATIONS,
			values: VALUES,
			blueprint: {
				nodes: spot.estimate.decisionNodes,
				runouts: spot.estimate.runouts,
				storageBytes,
				peakRss: rssAfterSolve,
				iterations: bp.iterations,
				seconds: solveSeconds,
				exploitability: bp.exploitabilityPercent(),
			},
			rootError,
			sizeReport,
			nodes: nodeResults,
			evs: evs.map(toJson),
		},
		null,
		1,
	),
);
console.log(`max RSS ${(process.resourceUsage().maxRSS * 1024 / GiB).toFixed(2)} GiB`);
