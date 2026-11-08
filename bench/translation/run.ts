/**
 * Experiment 2 of issue #54: solve with raises only over some bet sizes,
 * translate the rest, and measure against the full tree.
 *
 *   node --import tsx bench/translation/run.ts ref <board> [pot stack]
 *   node --import tsx bench/translation/run.ts cut <board> <raiseOver JSON> [pot stack]
 *
 * `ref` solves the full tree (T's betting) to 0.3% of pot and saves per-combo
 * root EVs and the per-hand EVs of each root bet size. `cut` solves the tree
 * with `raiseOver`, reports its memory and time, compares its EVs with the
 * saved reference, and measures the translated strategy's exploitability in
 * the full tree. Results go to bench/translation/results/.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { COMBO_CARDS, COMBOS } from '../../src/cards.ts';
import { Mode } from '../../src/cfr.ts';
import { createRun, defineSpot, type SolveRun, type Spot, type SpotConfig } from '../../src/index.ts';
import { ActionKind } from '../../src/tree.ts';
import { comboEvs, evError, type ComboEv } from '../library/measure.ts';
import { targetSpot } from './spots.ts';
import { applyTranslation, matchFrequencies, sizeOf, translate } from './translate.ts';

const [stage, board, ...rest] = process.argv.slice(2);
const raiseOver = stage === 'cut' ? (JSON.parse(rest.shift()!) as number[]) : undefined;
const [pot, stack] = rest.length ? rest.map(Number) : [55, 975];
const TARGET = Number(process.env.TARGET ?? 0.3);
const WORKERS = Number(process.env.WORKERS ?? 4);
const PRECISION = (process.env.PRECISION ?? 'f32') as 'f32' | 'i16';
const tag = `${board.replace(/ /g, '')}-${pot}-${stack}`;
const dir = new URL('./results/', import.meta.url);
mkdirSync(dir, { recursive: true });

const config = (extra: Partial<SpotConfig> = {}): SpotConfig => ({
	...targetSpot(board),
	pot,
	stack,
	maxBytes: 12 * 2 ** 30,
	...extra,
});

interface Saved {
	ev: number[][];
	mass: number[][];
	weight: number[][];
	rangeEv: number[];
	/** [player][size] per-combo EV of betting that size at the player's first decision (IP: after a check). */
	sizes: number[][][];
	sizeLabels: string[][];
	/** OOP's reach at the check, under the reference, for IP's size EVs. */
	checkReach: number[];
}

const toArr = (a: Float64Array): number[] => Array.from(a, (x) => (Number.isNaN(x) ? null : x) as number);
const fromArr = (a: number[]): Float64Array => Float64Array.from(a, (x) => (x === null ? Number.NaN : x));

/** Per-combo EV of each sized bet (and shove) at a player's first decision. */
function sizeEvs(spot: Spot, run: SolveRun, player: 0 | 1, checkReach: Float64Array | null): { evs: Float64Array[]; labels: string[] } {
	const { tree } = spot;
	const solver = run.solver;
	let node = 0;
	if (player === 1) node = tree.edgeChild[tree.firstEdge[0]]; // after the check
	const me = new Float64Array(COMBOS);
	const opp = new Float64Array(COMBOS);
	const own = spot.players[player];
	const other = spot.players[1 - player];
	for (let i = 0; i < own.count; i++) me[own.combos[i]] = own.weights[own.combos[i]];
	for (let i = 0; i < other.count; i++) opp[other.combos[i]] = checkReach ? checkReach[other.combos[i]] : other.weights[other.combos[i]];
	const evs: Float64Array[] = [];
	const labels: string[] = [];
	const runoutWeight = solver.ctx.runoutWeight[0];
	for (let e = tree.firstEdge[node]; e < tree.firstEdge[node] + tree.numEdges[node]; e++) {
		const kind = tree.edgeAction[e];
		if (kind !== ActionKind.Bet && kind !== ActionKind.AllIn) continue;
		labels.push(kind === ActionKind.AllIn ? 'allin' : sizeOf(tree, node, e).toFixed(2));
		const values = solver.valuesAt(tree.edgeChild[e], 0, player, me, opp, solver.rootLive, solver.rootCount);
		const ev = new Float64Array(COMBOS).fill(Number.NaN);
		for (let i = 0; i < own.count; i++) {
			const combo = own.combos[i];
			const a = COMBO_CARDS[combo * 2];
			const b = COMBO_CARDS[combo * 2 + 1];
			let facing = 0;
			for (let j = 0; j < other.count; j++) {
				const h = other.combos[j];
				const c = COMBO_CARDS[h * 2];
				const d = COMBO_CARDS[h * 2 + 1];
				if (c !== a && c !== b && d !== a && d !== b) facing += opp[h];
			}
			if (facing > 0) ev[combo] = values[combo] / (facing * runoutWeight);
		}
		evs.push(ev);
	}
	return { evs, labels };
}

function solveTo(spot: Spot): { run: SolveRun; ms: number; iterations: number; exploitability: number } {
	const run = createRun(spot, { workers: WORKERS, precision: PRECISION, engine: process.env.ENGINE === 'js' ? 'js' : undefined });
	const start = performance.now();
	let exploitability = Infinity;
	let checkMs = 0;
	while (run.completed < 1000) {
		run.step(run.completed < 20 ? 10 : run.completed < 100 ? 5 : 10);
		const c = performance.now();
		exploitability = run.exploitabilityPercent();
		checkMs += performance.now() - c;
		console.log(`  ${run.completed} iterations, ${exploitability.toFixed(3)}% of pot, ${((performance.now() - start) / 1000).toFixed(0)} s`);
		if (exploitability <= TARGET) break;
	}
	return { run, ms: performance.now() - start - checkMs, iterations: run.completed, exploitability };
}

const memory = (): string => {
	const m = process.memoryUsage();
	return `rss ${(m.rss / 2 ** 30).toFixed(2)} GiB, heap ${(m.heapUsed / 2 ** 20).toFixed(0)} MiB, arrayBuffers ${(m.arrayBuffers / 2 ** 30).toFixed(2)} GiB`;
};

if (stage === 'ref') {
	const spot = defineSpot(config());
	console.log(`reference ${tag}: ${(spot.estimate.bytes / 2 ** 30).toFixed(2)} GiB f32, ${spot.estimate.decisionNodes} decisions`);
	const { run, ms, iterations, exploitability } = solveTo(spot);
	const solution = run.snapshot();
	const evs = [0, 1].map((p) => comboEvs(spot, run.solver, p as 0 | 1));
	const checkReach = solution.reachAt(spot.tree.edgeChild[spot.tree.firstEdge[0]], 0, 0);
	const s0 = sizeEvs(spot, run, 0, null);
	const s1 = sizeEvs(spot, run, 1, checkReach);
	const saved: Saved = {
		ev: evs.map((e) => toArr(e.ev)),
		mass: evs.map((e) => toArr(e.mass)),
		weight: evs.map((e) => toArr(e.weight)),
		rangeEv: evs.map((e) => e.rangeEv),
		sizes: [s0.evs.map(toArr), s1.evs.map(toArr)],
		sizeLabels: [s0.labels, s1.labels],
		checkReach: toArr(checkReach),
	};
	writeFileSync(new URL(`ref-${tag}.json`, dir), JSON.stringify(saved));
	const summary = { tag, bytes: spot.estimate.bytes, compressedBytes: spot.estimate.compressedBytes, iterations, ms, exploitability, memory: memory() };
	writeFileSync(new URL(`ref-${tag}.summary.json`, dir), JSON.stringify(summary, null, 1));
	console.log(summary);
	run.close();
} else if (stage === 'cut') {
	const ref = JSON.parse(readFileSync(new URL(`ref-${tag}.json`, dir), 'utf8')) as Saved;
	const refEv = (p: number): ComboEv => ({
		ev: fromArr(ref.ev[p]),
		mass: fromArr(ref.mass[p]),
		weight: fromArr(ref.weight[p]),
		rangeEv: ref.rangeEv[p],
	});
	const spot = defineSpot(config({ raiseOver }));
	console.log(`raiseOver ${JSON.stringify(raiseOver)} on ${tag}: ${(spot.estimate.bytes / 2 ** 30).toFixed(2)} GiB f32, ${(spot.estimate.compressedBytes / 2 ** 30).toFixed(2)} GiB i16`);
	const { run, ms, iterations, exploitability } = solveTo(spot);
	const peak = memory();
	const evs = [0, 1].map((p) => comboEvs(spot, run.solver, p as 0 | 1));
	const errors = evs.map((e, p) => evError(e, refEv(p), pot));

	// Which size each hand prefers, against the reference.
	const checkReach = fromArr(ref.checkReach);
	const sizeReport = [0, 1].map((p) => {
		const mine = sizeEvs(spot, run, p as 0 | 1, p === 1 ? checkReach : null);
		const refSizes = ref.sizes[p].map(fromArr);
		const mass = fromArr(ref.mass[p]);
		const sized = ref.sizeLabels[p].map((l, i) => (l === 'allin' ? -1 : i)).filter((i) => i >= 0);
		let agree = 0;
		let total = 0;
		let agreeClear = 0;
		let totalClear = 0;
		const sizeMae = sized.map(() => 0);
		let massAll = 0;
		for (let combo = 0; combo < COMBOS; combo++) {
			if (!(mass[combo] > 0)) continue;
			const r = sized.map((i) => refSizes[i][combo]);
			const m = sized.map((i) => mine.evs[i][combo]);
			if (r.some(Number.isNaN) || m.some(Number.isNaN)) continue;
			sized.forEach((_, k) => (sizeMae[k] += mass[combo] * Math.abs(r[k] - m[k])));
			massAll += mass[combo];
			const best = (v: number[]): number => v.indexOf(Math.max(...v));
			const sortedR = [...r].sort((x, y) => y - x);
			const same = best(r) === best(m);
			total += mass[combo];
			if (same) agree += mass[combo];
			// A clear preference: the best size beats the next by over 0.5% of pot.
			if (sortedR[0] - sortedR[1] > 0.005 * pot) {
				totalClear += mass[combo];
				if (same) agreeClear += mass[combo];
			}
		}
		return {
			labels: sized.map((i) => ref.sizeLabels[p][i]),
			sizeMaePercent: sizeMae.map((x) => (100 * x) / massAll / pot),
			agreement: agree / total,
			agreementClear: agreeClear / totalClear,
			clearShare: totalClear / total,
		};
	});

	// The translated strategy in the full tree.
	const full = defineSpot(config());
	const analysis = createRun(full, { analysisOnly: true, workers: WORKERS });
	const t = translate(full.tree, spot.tree);
	applyTranslation(analysis.solver.ctx, run.solver.ctx, t, (process.env.UNMATCHED ?? 'uniform') as 'uniform');
	if (process.env.MATCH === '1') matchFrequencies(analysis, run, t);
	const fullExploit = analysis.exploitabilityPercent();
	// Where the leak is: the reference's own strategy in the translated
	// subtrees, the solved one everywhere else; and the reverse.
	let split: { referenceInTranslated: number; referenceElsewhere: number } | undefined;
	if (process.env.DECOMPOSE === '1') {
		const reference = solveTo(full).run;
		const identity = translate(full.tree, full.tree);
		applyTranslation(analysis.solver.ctx, reference.solver.ctx, identity, 'uniform', t.translatedMask);
		const referenceInTranslated = analysis.solver.exploitability() / (pot * full.chipScale) * 100;
		applyTranslation(analysis.solver.ctx, run.solver.ctx, t);
		const rest = Uint8Array.from(t.translatedMask, (x) => 1 - x);
		applyTranslation(analysis.solver.ctx, reference.solver.ctx, identity, 'uniform', rest);
		const referenceElsewhere = analysis.solver.exploitability() / (pot * full.chipScale) * 100;
		split = { referenceInTranslated, referenceElsewhere };
		applyTranslation(analysis.solver.ctx, run.solver.ctx, t);
		reference.close();
	}
	// Each player's best-response gain over the reference value, % of pot.
	const brGain = [0, 1].map((p) => {
		const ctx = analysis.solver.ctx;
		const slot = ctx.active.roundBase[0] * 2 + p;
		const values = analysis.solver.traverseRoot(Mode.BestResponse, p as 0 | 1, 0).slice(0, ctx.active.count[slot]);
		const ev = analysis.solver.handEvs(p as 0 | 1, values);
		const mass = fromArr(ref.mass[p]);
		let sum = 0;
		let total = 0;
		for (let c = 0; c < COMBOS; c++) if (mass[c] > 0) { sum += mass[c] * ev[c]; total += mass[c]; }
		return (100 * (sum / total - ref.rangeEv[p])) / pot;
	});
	const fullEvs = [0, 1].map((p) => comboEvs(full, analysis.solver, p as 0 | 1));
	const fullErrors = fullEvs.map((e, p) => evError(e, refEv(p), pot));
	const summary = {
		tag,
		raiseOver,
		unmatchedPlay: process.env.UNMATCHED ?? 'uniform',
		frequencyMatched: process.env.MATCH === '1',
		bytes: spot.estimate.bytes,
		compressedBytes: spot.estimate.compressedBytes,
		fullBytes: full.estimate.bytes,
		iterations,
		ms,
		ownExploitability: exploitability,
		peak,
		rootEvError: errors,
		sizes: sizeReport,
		translated: { exploitability: fullExploit, split, brGain, translatedNodes: t.translatedNodes, unmatched: t.unmatched, rootEvError: fullErrors },
	};
	writeFileSync(new URL(`cut-${tag}-${JSON.stringify(raiseOver)}${process.env.UNMATCHED ? '-' + process.env.UNMATCHED : ''}${process.env.MATCH === '1' ? '-matched' : ''}.json`, dir), JSON.stringify(summary, null, 1));
	console.log(JSON.stringify(summary, null, 1));
	analysis.close();
	run.close();
}
