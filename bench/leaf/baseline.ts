/**
 * The baseline for the turn-leaf experiment: the exact solver,
 * single-threaded, stopped by wall clock at 5, 10 and 15 s, in Node and in
 * headless Chromium, its per-combo root EV scored against the 0.1% reference
 * from ref.ts.
 *
 *   node --import tsx bench/leaf/baseline.ts <refdir> [spot,...]
 */
import { readFileSync } from 'node:fs';
import { COMBO_CARDS, createRun, defineSpot } from '../../src/index.ts';
import type { SpotConfig } from '../../src/index.ts';
import { runInBrowser } from '../../scripts/browser-harness.ts';
import { comboEv } from './lib.ts';
import { MEASURE } from './spots.ts';

const [dir, list] = process.argv.slice(2);
const names = (list ?? 'flop,monotone,wide,flopPB').split(',');
const CHECKPOINTS = [5000, 10000, 15000];

interface Checkpoint { ms: number; iterations: number; exploit: number; rootEv: (number | null)[][] }

/** Shared by both places: solve until each checkpoint, read root EVs there. */
function timed(config: SpotConfig, checkpoints: number[]): Checkpoint[] {
	const started = performance.now();
	const spot = defineSpot(config);
	const run = createRun(spot, { workers: 1 });
	const reach = [Float64Array.from(spot.players[0].weights), Float64Array.from(spot.players[1].weights)];
	const out: Checkpoint[] = [];
	let iterations = 0;
	let paused = 0; // time spent reading EVs, not counted against the solve
	for (const at of checkpoints) {
		while (performance.now() - started - paused < at) {
			run.step(1);
			iterations++;
		}
		const ms = performance.now() - started - paused;
		const t = performance.now();
		const rootEv = [0, 1].map((p) => Array.from(comboEv(run, 0, 0, p as 0 | 1, reach[p], reach[1 - p], spot.board).ev, (v) => (Number.isNaN(v) ? null : v)));
		const exploit = run.exploitabilityPercent();
		paused += performance.now() - t;
		out.push({ ms, iterations, exploit, rootEv });
	}
	run.close();
	return out;
}

export function score(ref: { rootEv: (number | null)[][]; weights: number[][] }, ev: (number | null)[][], pot = 100) {
	return [0, 1].map((p) => {
		const w = ref.weights[p], o = ref.weights[1 - p];
		let sw = 0, err = 0, max = 0, t = 0, q = 0;
		for (let c = 0; c < w.length; c++) {
			const a = ref.rootEv[p][c], b = ev[p][c];
			if (a === null || b === null || w[c] === 0) continue;
			// The combo's share of the range: its weight times the opposing mass it meets.
			const m = mass(c, o);
			sw += w[c] * m;
			err += w[c] * m * Math.abs(a - b);
			t += w[c] * m * a;
			q += w[c] * m * b;
			if (w[c] >= 0.01) max = Math.max(max, Math.abs(a - b));
		}
		return { mae: (100 * err) / sw / pot, max: (100 * max) / pot, range: (100 * Math.abs(q - t)) / sw / pot };
	});
}

function mass(c: number, opp: number[]): number {
	const a = COMBO_CARDS[c * 2], b = COMBO_CARDS[c * 2 + 1];
	let m = 0;
	for (let d = 0; d < opp.length; d++) {
		if (!opp[d]) continue;
		const x = COMBO_CARDS[d * 2], y = COMBO_CARDS[d * 2 + 1];
		if (x !== a && x !== b && y !== a && y !== b) m += opp[d];
	}
	return m;
}

const configs = Object.fromEntries(names.map((n) => [n, MEASURE[n]]));
const browser = await runInBrowser<Record<string, Checkpoint[]>>(
	`
	import { createRun, defineSpot } from './src/index.ts';
	import { comboEv } from './bench/leaf/lib.ts';
	const timed = ${timed.toString()};
	export default async function run() {
		const out = {};
		for (const [name, config] of Object.entries(${JSON.stringify(configs)})) out[name] = timed(config, ${JSON.stringify(CHECKPOINTS)});
		return out;
	}
	`,
	1_800_000,
);
const f = (x: number) => x.toFixed(2).padStart(6);
console.log('spot      where    s   iters  exploit% | OOP mae   max  range | IP mae   max  range  (% of pot)');
for (const name of names) {
	const ref = JSON.parse(readFileSync(`${dir}/ref-${name}.json`, 'utf8'));
	const node = timed(configs[name], CHECKPOINTS);
	for (const [where, list] of [['node', node], ['browser', browser[name]]] as const) {
		for (const c of list) {
			const [a, b] = score(ref, c.rootEv);
			console.log(`${name.padEnd(9)} ${where.padEnd(7)} ${String(Math.round(c.ms / 1000)).padStart(3)} ${String(c.iterations).padStart(6)} ${f(c.exploit)}   | ${f(a.mae)} ${f(a.max)} ${f(a.range)} | ${f(b.mae)} ${f(b.max)} ${f(b.range)}`);
		}
	}
}
