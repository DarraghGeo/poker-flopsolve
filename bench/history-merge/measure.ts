/**
 * History merging against the exact solve (issue #49, step 2).
 *
 *   node --import tsx bench/history-merge/measure.ts --spot M3 --variants exact,river,spr0.25 --iters 300
 *
 * The reference is the unshared spot solved to `--target` % of pot (default
 * 0.3), cached in `results/ref-<spot>.json`. Each variant runs `--iters`
 * iterations and reports, at checkpoints: exploitability in the full game
 * (the shared strategy is one for every node, so this is exact), and the
 * error of per-combination root EVs against the reference, in % of pot —
 * range-weighted mean and the largest over combos weighted 1% or more.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRun, defineSpot } from '../../src/index.ts';
import type { SolveOptions, SpotConfig } from '../../src/index.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';
const base = { pot: 55, stack: 975, oop: OOP, ip: IP, maxBytes: 2 ** 40 };
const T = { betSizes: [[0.33, 0.75, 1.5]], raiseSizes: [[0.75]], allowAllIn: true, maxRaises: 3 };
export const SPOTS: Record<string, SpotConfig> = {
	M3: { board: 'As Kh 7d', ...base, betSizes: [[0.5]], raiseSizes: [['allin']], maxRaises: 2 } as SpotConfig,
	M1: { board: 'As Kh 7d', ...base, betSizes: [[0.33, 0.75]], raiseSizes: [['allin']], maxRaises: 2 } as SpotConfig,
	T0: { board: 'As Kh 7d', ...base, ...T, raiseSizes: [['allin']], maxRaises: 2 } as SpotConfig,
	T: { board: 'As Kh 7d', ...base, ...T } as SpotConfig,
	'T-mono': { board: 'Ks 9s 4s', ...base, ...T } as SpotConfig,
	small: {
		board: 'Ts 9s 4h', pot: 60, stack: 100,
		oop: 'AA,KK,QQ,AKs,AQs,KQs,76s,65s', ip: 'JJ,TT,99,AJs,KJs,QJs,JTs,T9s',
		betSizes: [[0.66]], maxRaises: 1,
	} as SpotConfig,
};

/** A variant: what `shareHistories` it sets. */
const VARIANTS: Record<string, SpotConfig['shareHistories']> = {
	off: false,
	exact: true,
	'exact-cf': { weighting: 'counterfactual' },
	river: { fromRound: 2 },
	'river-cf': { fromRound: 2, weighting: 'counterfactual' },
};
for (const w of [0.1, 0.25, 0.5, 1, 4]) {
	VARIANTS[`spr${w}`] = { spr: w };
	VARIANTS[`river-spr${w}`] = { spr: w, fromRound: 2 };
}

const args: Record<string, string> = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].slice(2)] = process.argv[i + 1];
const name = args.spot ?? 'M3';
const config = SPOTS[name];
const workers = Number(args.workers ?? 4);
const target = Number(args.target ?? 0.3);
const iterations = Number(args.iters ?? 300);
const precision = (args.precision ?? undefined) as SolveOptions['precision'];
const engine = args.engine === 'js' ? ('js' as const) : undefined;
const pot = config.pot;
const dir = new URL('./results/', import.meta.url);
mkdirSync(dir, { recursive: true });

interface Reference {
	exploitability: number;
	iterations: number;
	seconds: number;
	weights: number[][];
	evs: number[][];
}

function reference(): Reference {
	const file = new URL(`ref-${name}.json`, dir);
	if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Reference;
	const spot = defineSpot(config);
	const run = createRun(spot, { workers, precision });
	const started = performance.now();
	let exploitability = Infinity;
	while (exploitability > target && run.completed < 5000) {
		run.step(run.completed < 50 ? 25 : 50);
		exploitability = run.exploitabilityPercent();
		console.error(`reference ${name}: ${run.completed} iterations, ${exploitability.toFixed(3)}%`);
	}
	const solution = run.snapshot();
	const ref: Reference = {
		exploitability,
		iterations: run.completed,
		seconds: (performance.now() - started) / 1000,
		weights: [0, 1].map((p) => Array.from(spot.players[p].weights)),
		evs: [0, 1].map((p) => Array.from(solution.handEvs(p as 0 | 1))),
	};
	run.close();
	writeFileSync(file, JSON.stringify(ref));
	return ref;
}

/** Range-weighted mean and the largest error over combos weighted ≥ 1%, in % of pot. */
function evError(ref: Reference, evs: Float64Array[]): { mean: number; max: number } {
	let sum = 0;
	let mass = 0;
	let max = 0;
	for (let p = 0; p < 2; p++) {
		for (let c = 0; c < evs[p].length; c++) {
			const w = ref.weights[p][c];
			if (!(w > 0) || ref.evs[p][c] === 0) continue;
			const error = (100 * Math.abs(evs[p][c] - ref.evs[p][c])) / pot;
			sum += w * error;
			mass += w;
			if (w >= 0.01 && error > max) max = error;
		}
	}
	return { mean: sum / mass, max };
}

const ref = reference();
console.log(
	`\n## ${name}: reference ${ref.exploitability.toFixed(3)}% of pot after ${ref.iterations} iterations (${ref.seconds.toFixed(0)} s, ${workers} threads)`,
);
console.log('| variant | storage f32 | iterations | exploitability % | EV MAE % pot | EV max % pot | s/iter |');
console.log('|---|---|---|---|---|---|---|');
const checkpoints = (args.checkpoints ?? `${iterations}`).split(',').map(Number);
for (const variant of (args.variants ?? 'exact').split(',')) {
	const spot = defineSpot({ ...config, shareHistories: VARIANTS[variant] });
	const run = createRun(spot, { workers, precision, engine });
	let elapsed = 0;
	for (const at of checkpoints) {
		const started = performance.now();
		run.step(at - run.completed);
		elapsed += performance.now() - started;
		const solution = run.snapshot();
		const error = evError(ref, [solution.handEvs(0), solution.handEvs(1)]);
		console.log(
			`| ${variant} | ${(spot.estimate.bytes / 2 ** 30).toFixed(2)} GiB | ${at} | ${run.exploitabilityPercent().toFixed(3)} | ` +
				`${error.mean.toFixed(3)} | ${error.max.toFixed(2)} | ${(elapsed / 1000 / at).toFixed(2)} |`,
		);
	}
	run.close();
}
