/**
 * History-dependent runouts against an exact solve (issue #53, step 2).
 *
 *   node --import tsx bench/history-runouts/measure.ts ref --spot M [--workers 4] [--target 0.3]
 *   node --import tsx bench/history-runouts/measure.ts line --spot M --raises 1 --band 13 [--iters 300]
 *
 * `ref` solves the spot exactly to `target` % of pot and saves per-combo root
 * EVs, the out-of-position player's per-combo EV of each root action, and the
 * reach mass of each line class (raises and aggressions before each deal)
 * to `results/<spot>-ref.json`. `line` solves it with `lineRunouts`, for the
 * the reference's iteration count (its own game's exploitability is no stopping
 * rule: the rescaled game is not zero-sum, and can read below zero), and
 * reports storage, peak memory, time, root-EV error, whether each hand still
 * prefers the reference's root bet size, and exploitability in the full game.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { COMBO_CARDS, COMBOS, createRun, defineSpot } from '../../src/index.ts';
import type { SolveRun, SpotConfig } from '../../src/index.ts';
import { matchupMass } from '../../src/cfr.ts';
import { ActionKind, NodeKind } from '../../src/tree.ts';
import { rootError, rootEvs } from '../coarse-to-fine/measure.ts';
import type { RootEvs } from '../coarse-to-fine/measure.ts';
import { SPOTS } from './spots.ts';

const args = process.argv.slice(2);
const mode = args[0];
const opt = (name: string, fallback?: string): string | undefined => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 ? args[at + 1] : fallback;
};
const name = opt('spot', 'M')!;
const workers = Number(opt('workers', '4'));
const target = Number(opt('target', '0.3'));
const precision = (opt('precision', 'f32') as 'f32' | 'i16');
const dir = new URL('./results/', import.meta.url);
mkdirSync(dir, { recursive: true });
const refFile = new URL(`${name}-ref.json`, dir);

interface Reference {
	evs: RootEvs;
	actionEvs: number[][];
	actions: string[];
	iterations: number;
	exploitability: number;
	seconds: number;
	reach: Record<string, number>;
}

/** The out-of-position player's per-combo EV of each root action, % of pot; NaN outside the range. */
function actionEvs(run: SolveRun): number[][] {
	const { spot, solver } = run;
	const { tree } = spot;
	const pot = spot.potUnits / spot.chipScale;
	const mine = spot.players[0].weights;
	const theirs = spot.players[1].weights;
	let deals = 1;
	for (let round = 1; round < spot.runouts.rounds; round++) deals *= 52 - 4 - spot.runouts.width[round - 1];
	const card = new Float64Array(52);
	let total = 0;
	for (let h = 0; h < COMBOS; h++) {
		total += theirs[h];
		card[COMBO_CARDS[h * 2]] += theirs[h];
		card[COMBO_CARDS[h * 2 + 1]] += theirs[h];
	}
	const out: number[][] = [];
	for (let e = 0; e < tree.numEdges[0]; e++) {
		const child = tree.edgeChild[tree.firstEdge[0] + e];
		const values = solver.valuesAt(child, 0, 0, mine, theirs, solver.rootLive, solver.rootCount);
		const ev = new Array<number>(COMBOS).fill(NaN);
		for (let h = 0; h < COMBOS; h++) {
			if (mine[h] === 0) continue;
			const open = total - card[COMBO_CARDS[h * 2]] - card[COMBO_CARDS[h * 2 + 1]] + theirs[h];
			if (open > 0) ev[h] = (100 * values[h]) / (open * deals) / pot;
		}
		out.push(ev);
	}
	return out;
}

/**
 * Probability that a deal of each street is reached in each line class:
 * matchup mass reaching its chance nodes, over the mass dealt there.
 */
function reachCensus(run: SolveRun): Record<string, number> {
	const solution = run.snapshot();
	const { spot } = run;
	const { tree, runouts } = spot;
	const out: Record<string, number> = {};
	const dealt = new Float64Array(runouts.rounds);
	const masked = (reach: Float64Array, round: number, board: number): Float64Array => {
		const width = runouts.width[round];
		const on = new Set(runouts.cards[round].subarray(board * width, board * width + width));
		for (let h = 0; h < COMBOS; h++) if (on.has(COMBO_CARDS[h * 2]) || on.has(COMBO_CARDS[h * 2 + 1])) reach[h] = 0;
		return reach;
	};
	const weightOf = (round: number, board: number): number => runouts.orbitStart[round][board + 1] - runouts.orbitStart[round][board];
	for (let round = 0; round < runouts.rounds - 1; round++) {
		for (let b = 0; b < runouts.counts[round]; b++) {
			const w0 = masked(Float64Array.from(spot.players[0].weights), round, b);
			const w1 = masked(Float64Array.from(spot.players[1].weights), round, b);
			let orbit = 1;
			for (let r = round, x = b; r > 0; x = runouts.parent[r][x], r--) orbit *= weightOf(r, x);
			dealt[round] += orbit * matchupMass(w0, w1);
		}
	}
	const walk = (node: number, raises: number, aggressions: number, facing: boolean): void => {
		const kind = tree.kind[node];
		if (kind === NodeKind.TerminalFold || kind === NodeKind.TerminalShowdown) return;
		if (kind === NodeKind.Chance) {
			const round = tree.round[node];
			let mass = 0;
			for (let b = 0; b < runouts.counts[round]; b++) {
				let orbit = 1;
				for (let r = round, x = b; r > 0; x = runouts.parent[r][x], r--) orbit *= weightOf(r, x);
				const r0 = masked(solution.reachAt(node, b, 0), round, b);
				const r1 = masked(solution.reachAt(node, b, 1), round, b);
				mass += orbit * matchupMass(r0, r1);
			}
			const street = round === 0 ? 'turn' : 'river';
			for (const key of [`${street} raises ${Math.min(raises, 2)}`, `${street} aggressions ${Math.min(aggressions, 3)}`]) {
				out[key] = (out[key] ?? 0) + mass / dealt[round];
			}
			walk(tree.edgeChild[tree.firstEdge[node]], raises, aggressions, false);
			return;
		}
		for (let e = 0; e < tree.numEdges[node]; e++) {
			const action = tree.edgeAction[tree.firstEdge[node] + e];
			const aggressive = action === ActionKind.Bet || action === ActionKind.Raise || action === ActionKind.AllIn;
			walk(tree.edgeChild[tree.firstEdge[node] + e], raises + (aggressive && facing ? 1 : 0), aggressions + (aggressive ? 1 : 0), facing || aggressive);
		}
	};
	walk(0, 0, 0, false);
	return out;
}

const gib = (bytes: number): string => `${(bytes / 2 ** 30).toFixed(2)} GiB`;

function solveTo(config: SpotConfig, cap: number, label: string, stopAtTarget = true): { run: SolveRun; seconds: number; exploitability: number } {
	const spot = defineSpot({ ...config, maxBytes: 2 ** 36 });
	console.log(`${label}: boards ${spot.runouts.counts.join('/')}, storage f32 ${gib(spot.estimate.bytes)}, i16 ${gib(spot.estimate.compressedBytes)}`);
	const started = performance.now();
	const run = createRun(spot, { workers, precision, engine: 'js' });
	let solving = 0;
	let exploitability = Infinity;
	let next = 10;
	while (run.completed < cap) {
		const t = performance.now();
		run.step(1);
		solving += performance.now() - t;
		if (run.completed >= next || run.completed === cap) {
			exploitability = run.exploitabilityPercent();
			console.log(`  ${run.completed} iterations, ${(solving / 1000).toFixed(0)} s solving, exploitability ${exploitability.toFixed(3)}%`);
			if (stopAtTarget && exploitability <= target) break;
			next = run.completed + (exploitability > 2 * target ? 20 : 10);
		}
	}
	console.log(`  built and solved in ${((performance.now() - started) / 1000).toFixed(0)} s wall`);
	return { run, seconds: solving / 1000, exploitability };
}

if (mode === 'ref') {
	const { run, seconds, exploitability } = solveTo(SPOTS[name], Number(opt('iters', '2000')), `${name} exact`);
	const reference: Reference = {
		evs: rootEvs(run),
		actionEvs: actionEvs(run),
		actions: Array.from({ length: run.spot.tree.numEdges[0] }, (_, e) => run.snapshot().path(run.spot.tree.edgeChild[run.spot.tree.firstEdge[0] + e])),
		iterations: run.completed,
		exploitability,
		seconds,
		reach: reachCensus(run),
	};
	run.close();
	writeFileSync(refFile, JSON.stringify(reference, (_, v: unknown) => (typeof v === 'number' && Number.isNaN(v) ? null : v)));
	console.log('reach by class:', reference.reach);
} else {
	const reference = JSON.parse(readFileSync(refFile, 'utf8'), (_, v: unknown) => (v === null ? NaN : v)) as Reference;
	const rule = {
		...(opt('raises') ? { raises: Number(opt('raises')) } : {}),
		...(opt('aggressions') ? { aggressions: Number(opt('aggressions')) } : {}),
		band: Number(opt('band', '13')),
	};
	// `--buckets g` instead: the existing global `runoutBuckets`, for comparison at equal memory.
	const buckets = opt('buckets');
	const config: SpotConfig = buckets ? { ...SPOTS[name], runoutBuckets: Number(buckets) } : { ...SPOTS[name], lineRunouts: rule };
	const label = `${name} ${buckets ? `runoutBuckets ${buckets}` : JSON.stringify(rule)}`;
	const { run, seconds, exploitability } = solveTo(config, Number(opt('iters', String(reference.iterations))), label, false);
	const peakRss = process.resourceUsage().maxRSS * 1024;
	const heap = process.memoryUsage().heapUsed;
	const [oop, ip] = rootError(rootEvs(run), reference.evs, run);
	// Which root bet size each hand prefers, by EV: agreement weighted by range.
	const evs = actionEvs(run);
	const weights = run.spot.players[0].weights;
	const bets = reference.actions.map((a, i) => (/bet|allin/.test(a) ? i : -1)).filter((i) => i >= 0);
	let agree = 0;
	let mass = 0;
	let actionError = 0;
	let actionMass = 0;
	for (let h = 0; h < COMBOS; h++) {
		if (!(weights[h] > 0) || Number.isNaN(reference.actionEvs[0][h])) continue;
		const best = (table: number[][]): number => bets.reduce((x, y) => (table[y][h] > table[x][h] ? y : x), bets[0]);
		mass += weights[h];
		if (best(evs) === best(reference.actionEvs)) agree += weights[h];
		for (const a of bets) {
			actionError += weights[h] * Math.abs(evs[a][h] - reference.actionEvs[a][h]);
			actionMass += weights[h];
		}
	}
	const storage = precision === 'i16' ? run.spot.estimate.compressedBytes : run.spot.estimate.bytes;
	const t = performance.now();
	const truth = run.trueExploitabilityPercent();
	run.close();
	const result = {
		spot: name, rule: buckets ? { runoutBuckets: Number(buckets) } : rule, iterations: run.completed, seconds: Math.round(seconds), storage: gib(storage), peakRss: gib(peakRss), heap: gib(heap),
		ownExploitability: +exploitability.toFixed(3), trueExploitability: +truth.toFixed(3),
		rootEv: { oop: { mae: +oop.mae.toFixed(3), max: +oop.max.toFixed(3) }, ip: { mae: +ip.mae.toFixed(3), max: +ip.max.toFixed(3) } },
		rootBetEvMae: +(actionError / actionMass).toFixed(3),
		preferredSizeAgreement: +((100 * agree) / mass).toFixed(1),
		reference: { iterations: reference.iterations, seconds: Math.round(reference.seconds), exploitability: reference.exploitability },
		trueExploitabilitySeconds: Math.round((performance.now() - t) / 1000),
	};
	console.log(JSON.stringify(result));
	const tag = buckets ? `buckets${buckets}` : Object.entries(rule).map(([k, v]) => `${k}${v}`).join('-');
	writeFileSync(new URL(`${name}-${tag}.json`, dir), JSON.stringify(result, null, 1));
}
