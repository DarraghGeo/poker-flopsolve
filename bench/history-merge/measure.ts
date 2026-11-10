/**
 * History merging against the exact solve (issue #49, step 2).
 *
 *   node --import tsx bench/history-merge/measure.ts --spot M3 --variants off,river --iters 300
 *
 * The reference is the unshared spot solved to `--target` % of pot (default
 * 0.3), cached in `results/ref-<spot>.json`; `--target none` skips it, for
 * a spot whose exact solve does not fit, and reports exploitability alone.
 * Each variant runs `--iters`
 * iterations and reports, at checkpoints: exploitability in the full game
 * (the shared strategy is one for every node, so this is exact), and the
 * error of per-combination root EVs against the reference, in % of pot —
 * range-weighted mean and the largest over combos weighted 1% or more.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { COMBO_CARDS, COMBOS, createRun, defineSpot } from '../../src/index.ts';
import type { SolveOptions, SolveRun, SpotConfig } from '../../src/index.ts';
import { ActionKind } from '../../src/tree.ts';

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
	river: true,
};

const args: Record<string, string> = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].slice(2)] = process.argv[i + 1];
const name = args.spot ?? 'M3';
const config = SPOTS[name];
const workers = Number(args.workers ?? 4);
const target = Number(args.target ?? 0.3);
const noReference = args.target === 'none';
const iterations = Number(args.iters ?? 300);
const precision = (args.precision ?? undefined) as SolveOptions['precision'];
const engine = args.engine === 'js' ? ('js' as const) : undefined;
const pot = config.pot;
const dir = new URL('./results/', import.meta.url);
mkdirSync(dir, { recursive: true });

interface Reference {
	/** The `--target` it was solved to; absent in older files, which used 0.3. */
	target?: number;
	exploitability: number;
	iterations: number;
	seconds: number;
	weights: number[][];
	evs: number[][];
	/** Out of position's EV in chips for each root action, per combination; absent in older files. */
	actions?: number[][];
}

/**
 * Out of position's EV in chips per combination after each root action,
 * under the average strategy: the value of opening with that action.
 */
function rootActions(run: SolveRun): number[][] {
	const { spot, solver } = run;
	const tree = spot.tree;
	const me = new Float64Array(COMBOS);
	const opp = new Float64Array(COMBOS);
	for (const combo of spot.players[0].combos) me[combo] = spot.players[0].weights[combo];
	for (const combo of spot.players[1].combos) opp[combo] = spot.players[1].weights[combo];
	// Compatible opponent mass, which turns a counterfactual value into chips per dealt hand.
	const mass = new Float64Array(COMBOS);
	for (const combo of spot.players[0].combos) {
		const a = COMBO_CARDS[combo * 2];
		const b = COMBO_CARDS[combo * 2 + 1];
		for (const h of spot.players[1].combos) {
			const c = COMBO_CARDS[h * 2];
			const d = COMBO_CARDS[h * 2 + 1];
			if (c !== a && c !== b && d !== a && d !== b) mass[combo] += opp[h];
		}
	}
	const scale = solver.ctx.runoutWeight[0];
	const out: number[][] = [];
	for (let e = 0; e < tree.numEdges[0]; e++) {
		const child = tree.edgeChild[tree.firstEdge[0] + e];
		const values = solver.valuesAt(child, 0, 0, me, opp, solver.rootLive, solver.rootCount);
		out.push(Array.from(values, (v, combo) => (mass[combo] > 0 ? v / (mass[combo] * scale) : 0)));
	}
	return out;
}

/**
 * Against the reference's root actions: the range-weighted mean error of
 * each action's EV in % of pot, and how much of the range picks the same
 * bet size as best among the sizes it can bet.
 */
function actionError(ref: Reference, run: SolveRun, values: number[][]): { mean: number; agree: number } {
	const tree = run.spot.tree;
	const bets: number[] = [];
	for (let e = 0; e < tree.numEdges[0]; e++) {
		if (tree.edgeAction[tree.firstEdge[0] + e] >= ActionKind.Bet) bets.push(e);
	}
	let sum = 0;
	let mass = 0;
	let agree = 0;
	let weight = 0;
	for (let combo = 0; combo < COMBOS; combo++) {
		const w = ref.weights[0][combo];
		if (!(w > 0) || ref.evs[0][combo] === 0) continue;
		for (let a = 0; a < values.length; a++) {
			sum += w * (100 * Math.abs(values[a][combo] - ref.actions![a][combo])) / pot;
			mass += w;
		}
		const best = (v: number[][]): number => bets.reduce((x, y) => (v[y][combo] > v[x][combo] ? y : x));
		weight += w;
		if (best(values) === best(ref.actions!)) agree += w;
	}
	return { mean: sum / mass, agree: (100 * agree) / weight };
}

function reference(): Reference | null {
	if (noReference) return null;
	const file = new URL(`ref-${name}.json`, dir);
	if (existsSync(file)) {
		const cached = JSON.parse(readFileSync(file, 'utf8')) as Reference;
		if ((cached.target ?? 0.3) !== target) {
			throw new Error(`${file.pathname} was solved to ${cached.target ?? 0.3}% of pot, not ${target}%; delete it to re-solve`);
		}
		return cached;
	}
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
		target,
		exploitability,
		iterations: run.completed,
		seconds: (performance.now() - started) / 1000,
		weights: [0, 1].map((p) => Array.from(spot.players[p].weights)),
		evs: [0, 1].map((p) => Array.from(solution.handEvsChips(p as 0 | 1))),
		actions: rootActions(run),
	};
	run.close();
	writeFileSync(file, JSON.stringify(ref));
	return ref;
}

/** Range-weighted mean and the largest error over combos weighted ≥ 1%, in % of pot. */
function evError(ref: Reference | null, evs: Float64Array[]): { mean: number; max: number } {
	if (ref === null) return { mean: Number.NaN, max: Number.NaN };
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

/** Peak resident memory of this process so far: storage, JS heap and all. */
function peakRss(): number {
	return process.resourceUsage().maxRSS * 1024;
}

const ref = reference();
console.log(
	ref
		? `\n## ${name}: reference ${ref.exploitability.toFixed(3)}% of pot after ${ref.iterations} iterations (${ref.seconds.toFixed(0)} s, ${workers} threads)`
		: `\n## ${name}: no reference`,
);
console.log('| variant | storage f32 | storage i16 | iterations | exploitability % | EV MAE % pot | EV max % pot | root action EV MAE | same best size | s/iter | engine | peak RSS |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
const checkpoints = (args.checkpoints ?? `${iterations}`).split(',').map(Number);
for (const variant of (args.variants ?? 'river').split(',')) {
	const spot = defineSpot({ ...config, shareHistories: VARIANTS[variant] });
	const run = createRun(spot, { workers, precision, engine });
	let elapsed = 0;
	for (const at of checkpoints) {
		const started = performance.now();
		run.step(at - run.completed);
		elapsed += performance.now() - started;
		const solution = run.snapshot();
		const error = evError(ref, [solution.handEvsChips(0), solution.handEvsChips(1)]);
		const gib = (bytes: number): string => `${(bytes / 2 ** 30).toFixed(2)} GiB`;
		const actions = ref?.actions ? actionError(ref, run, rootActions(run)) : null;
		const actionColumns = actions ? `${actions.mean.toFixed(3)} | ${actions.agree.toFixed(1)}%` : '– | –';
		console.log(
			`| ${variant} | ${gib(spot.estimate.bytes)} | ${gib(spot.estimate.compressedBytes)} | ${at} | ${run.exploitabilityPercent().toFixed(3)} | ` +
				`${error.mean.toFixed(3)} | ${error.max.toFixed(2)} | ${actionColumns} | ${(elapsed / 1000 / at).toFixed(2)} | ${run.engine} | ${gib(peakRss())} |`,
		);
	}
	run.close();
}
