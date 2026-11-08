/**
 * Issue #50: storage compression, measured. Solves a spot with one storage
 * variant and records, at each checkpoint, exploitability (of the profile the
 * variant yields: average strategy where sums are kept, current profile
 * where they are not) and per-combination root EV error against a saved
 * reference; at the last, per-hand EV at each root action too.
 *
 *   node --import tsx bench/storage/run.ts <spot> <variant> [workers] [checkpoints] [--ref]
 *
 * `checkpoints` is a comma list of iteration counts. `--ref` saves the final
 * EVs as the spot's reference instead of comparing against one.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { COMBO_CARDS } from '../../src/cards.ts';
import type { CompactStorage, SolveOptions, SolveRun } from '../../src/index.ts';
import { createRun, defineSpot } from '../../src/index.ts';
import { STORAGE_SPOTS } from './spots.ts';

export const VARIANTS: Record<string, { storage?: CompactStorage; options?: SolveOptions }> = {
	f32: { options: { engine: 'js' } },
	wasm: {},
	i16: { options: { precision: 'i16' } },
	// Option 1 alone: sums dropped, regrets kept at 32 bits.
	'nosums-turn': { storage: { from: 1, float: true, sums: false } },
	'nosums-river': { storage: { from: 2, float: true, sums: false } },
	'nosums-all': { storage: { from: 0, float: true, sums: false } },
	// Option 2: 8-bit regrets, with the sums dropped from the same round.
	'i8-turn': { storage: { from: 1, sums: false } },
	'i8-river': { storage: { from: 2, sums: false } },
	'i8-turn-nearest': { storage: { from: 1, nearest: true, sums: false } },
	'i8-turn-block': { storage: { from: 1, blockScale: true, sums: false } },
	'i8-turn-block-nearest': { storage: { from: 1, blockScale: true, nearest: true, sums: false } },
	'i6-turn': { storage: { from: 1, steps: 31, sums: false } },
	'i5-turn': { storage: { from: 1, steps: 15, sums: false } },
	'i4-turn': { storage: { from: 1, steps: 7, sums: false } },
	'i3-turn': { storage: { from: 1, steps: 3, sums: false } },
	// From the flop on: no sums anywhere, the current profile throughout.
	'i8-all': { storage: { from: 0, sums: false } },
	'i8-all-block': { storage: { from: 0, blockScale: true, sums: false } },
	'i8-all-block-nearest': { storage: { from: 0, blockScale: true, nearest: true, sums: false } },
	'cfr+': { options: { engine: 'js', algorithm: 'cfr+' } },
	'nosums-all-cfr+': { storage: { from: 0, float: true, sums: false }, options: { algorithm: 'cfr+' } },
	'i8-all-cfr+': { storage: { from: 0, sums: false }, options: { algorithm: 'cfr+' } },
	'i8-all-block-cfr+': { storage: { from: 0, blockScale: true, sums: false }, options: { algorithm: 'cfr+' } },
	'i8s-all': { storage: { from: 0, sums: true } },
	'i8s-all-cfr+': { storage: { from: 0, sums: true }, options: { algorithm: 'cfr+' } },
	'i6-all': { storage: { from: 0, steps: 31, sums: false } },
	'i4-all': { storage: { from: 0, steps: 7, sums: false } },
};

const [spotName, variantName, workersArg, checkpointsArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const saveRef = process.argv.includes('--ref');
const variant = VARIANTS[variantName];
if (!variant) throw new Error(`unknown variant ${variantName}`);
const workers = Number(workersArg ?? 1);
const checkpoints = (checkpointsArg ?? '10,20,40,80,160').split(',').map(Number);

const config = { ...STORAGE_SPOTS[spotName], ...(variant.storage ? { compactStorage: variant.storage } : {}) };
const spot = defineSpot(config);
const pot = config.pot;
const refPath = `bench/storage/results/${spotName}-ref.json`;
interface Ref {
	iterations: number;
	exploitability: number;
	evs: [number[], number[]];
	actionEvs: number[][];
	actions: string[];
	/** OOP's root strategy, per combination then action. */
	rootStrategy?: number[];
}
const ref: Ref | null = !saveRef && existsSync(refPath) ? JSON.parse(readFileSync(refPath, 'utf8')) : null;

const weights = [spot.players[0].weights, spot.players[1].weights];

/** Range-weighted mean and the max over weight >= 1%, of |ev - ref| in % of pot, both players. */
function evError(evs: Float64Array[], refEvs: number[][]): { mae: number; max: number } {
	let num = 0;
	let den = 0;
	let max = 0;
	for (const p of [0, 1]) {
		for (let c = 0; c < weights[p].length; c++) {
			const w = weights[p][c];
			if (w === 0) continue;
			const err = (100 * Math.abs(evs[p][c] - refEvs[p][c])) / pot;
			num += w * err;
			den += w;
			if (w >= 0.01 && err > max) max = err;
		}
	}
	return { mae: num / den, max };
}

/** OOP's EV per combination after each root action, chips. */
function rootActionEvs(run: SolveRun): { actions: string[]; evs: Float64Array[] } {
	const { tree } = spot;
	const solver = run.solver;
	const ctx = solver.ctx;
	const first = tree.firstEdge[0];
	const actions: string[] = [];
	const evs: Float64Array[] = [];
	const snap = run.snapshot();
	for (let a = 0; a < tree.numEdges[0]; a++) {
		const child = tree.edgeChild[first + a];
		actions.push(snap.path(child));
		const values = solver.valuesAt(child, 0, 0, weights[0], weights[1], solver.rootLive, solver.rootCount);
		const out = new Float64Array(weights[0].length);
		for (let c = 0; c < out.length; c++) {
			if (weights[0][c] === 0) continue;
			const a1 = COMBO_CARDS[c * 2];
			const b1 = COMBO_CARDS[c * 2 + 1];
			let mass = 0;
			for (let o = 0; o < weights[1].length; o++) {
				if (weights[1][o] === 0) continue;
				const x = COMBO_CARDS[o * 2];
				const y = COMBO_CARDS[o * 2 + 1];
				if (x !== a1 && x !== b1 && y !== a1 && y !== b1) mass += weights[1][o];
			}
			out[c] = mass > 0 ? values[c] / (mass * ctx.runoutWeight[0]) : 0;
		}
		evs.push(out);
	}
	return { actions, evs };
}

/** OOP's root strategy, per combination then action; zero off the range. */
function rootStrategy(run: SolveRun): Float64Array {
	const view = run.snapshot().strategyAt(0, 0);
	const actions = view.actions.length;
	const out = new Float64Array(weights[0].length * actions);
	for (let i = 0; i < view.combos.length; i++) {
		for (let a = 0; a < actions; a++) out[view.combos[i] * actions + a] = view.probs[i * actions + a];
	}
	return out;
}

const started = performance.now();
const run = createRun(spot, { ...variant.options, workers });
const setupMs = performance.now() - started;
const layout = run.solver.ctx.layout;
const storageBytes = layout.bytes;
const rows: Record<string, unknown>[] = [];
let done = 0;
let trainMs = 0;
let peakRss = 0;
for (const target of checkpoints) {
	const t0 = performance.now();
	run.step(target - done);
	trainMs += performance.now() - t0;
	done = target;
	const exploitability = run.exploitabilityPercent();
	const snap = run.snapshot();
	const evs = [snap.handEvs(0), snap.handEvs(1)];
	const row: Record<string, unknown> = { iterations: done, trainSeconds: +(trainMs / 1000).toFixed(1), exploitability: +exploitability.toFixed(4) };
	// Option 3's census: the share of stored regrets that are positive, and
	// how many hands have a single positive action, over the late rounds.
	{
		const ctx = run.solver.ctx;
		const stores = ctx.compactRegret ?? [ctx.regret];
		let positive = 0;
		let length = 0;
		for (const store of stores) {
			for (let i = 0; i < store.length; i++) if (store[i] > 0) positive++;
			length += store.length;
		}
		row.positiveShare = +(positive / length).toFixed(4);
	}
	if (ref) Object.assign(row, Object.fromEntries(Object.entries(evError(evs, ref.evs)).map(([k, v]) => [k, +v.toFixed(4)])));
	peakRss = Math.max(peakRss, process.memoryUsage().rss);
	rows.push(row);
	console.log(JSON.stringify(row));
	if (saveRef && target === checkpoints[checkpoints.length - 1]) {
		const { actions, evs: actionEvs } = rootActionEvs(run);
		const out: Ref = {
			iterations: done, exploitability,
			evs: [Array.from(evs[0]), Array.from(evs[1])],
			actionEvs: actionEvs.map((e) => Array.from(e)), actions,
			rootStrategy: Array.from(rootStrategy(run)),
		};
		writeFileSync(refPath, JSON.stringify(out));
	}
}

let sizeChoice: Record<string, number> | null = null;
if (ref) {
	// Per-hand EV at each root action, and whether the preferred bet size
	// (and the preferred action) still matches the reference's.
	const { evs: actionEvs } = rootActionEvs(run);
	const bets = ref.actions.map((a, i) => [a, i] as const).filter(([a]) => !/check/i.test(a.split(/[,>]/).pop() ?? a)).map(([, i]) => i);
	let num = 0;
	let den = 0;
	let max = 0;
	// The same, only where the reference plays the action at least 5%.
	let onNum = 0;
	let onDen = 0;
	let onMax = 0;
	const played = ref.rootStrategy ?? null;
	let agreeAll = 0;
	let agreeBet = 0;
	let agreeBetClear = 0;
	let clear = 0;
	const argmax = (vals: number[]): number => vals.indexOf(Math.max(...vals));
	for (let c = 0; c < weights[0].length; c++) {
		const w = weights[0][c];
		if (w === 0) continue;
		for (let a = 0; a < actionEvs.length; a++) {
			const err = (100 * Math.abs(actionEvs[a][c] - ref.actionEvs[a][c])) / pot;
			num += w * err;
			den += w;
			if (w >= 0.01 && err > max) max = err;
			if (played !== null && played[c * actionEvs.length + a] >= 0.05) {
				onNum += w * err;
				onDen += w;
				if (w >= 0.01 && err > onMax) onMax = err;
			}
		}
		const mine = actionEvs.map((e) => e[c]);
		const theirs = ref.actionEvs.map((e) => e[c]);
		if (argmax(mine) === argmax(theirs)) agreeAll += w;
		const myBet = bets[argmax(bets.map((i) => mine[i]))];
		const refBet = bets[argmax(bets.map((i) => theirs[i]))];
		if (myBet === refBet) agreeBet += w;
		// Only where the reference's best size beats the next by 0.5% of pot.
		const sorted = bets.map((i) => theirs[i]).sort((x, y) => y - x);
		if ((100 * (sorted[0] - sorted[1])) / pot >= 0.5) {
			clear += w;
			if (myBet === refBet) agreeBetClear += w;
		}
	}
	const total = weights[0].reduce((s, w) => s + w, 0);
	sizeChoice = {
		actionMae: +(num / den).toFixed(4),
		actionMax: +max.toFixed(4),
		playedActionMae: +(onDen > 0 ? onNum / onDen : NaN).toFixed(4),
		playedActionMax: +onMax.toFixed(4),
		sameBestAction: +(agreeAll / total).toFixed(4),
		sameBestSize: +(agreeBet / total).toFixed(4),
		sameBestSizeWhereClear: +(clear > 0 ? agreeBetClear / clear : 1).toFixed(4),
		clearShare: +(clear / total).toFixed(4),
	};
	console.log(JSON.stringify(sizeChoice));
}
run.close();
const summary = {
	spot: spotName, variant: variantName, workers: run.workers, engine: run.engine,
	storageMiB: +(storageBytes / 2 ** 20).toFixed(1),
	estimateMiB: +(((spot.estimate.compactBytes ?? (variantName === 'i16' ? spot.estimate.compressedBytes : spot.estimate.bytes)) / 2 ** 20)).toFixed(1),
	peakRssMiB: Math.round(peakRss / 2 ** 20),
	setupSeconds: +(setupMs / 1000).toFixed(1),
	rows, sizeChoice,
};
writeFileSync(`bench/storage/results/${spotName}-${variantName}-w${workers}.json`, JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ ...summary, rows: undefined }));
