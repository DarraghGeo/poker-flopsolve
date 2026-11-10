/**
 * Issue #123: does a stop that waits for the ranges lite brings to the turn
 * earn its time under `keepBudget`?
 *
 *   node --import tsx bench/lite/turn-stop.ts <rainbow|two-tone|monotone> [workers]
 *
 * Solves `keepWithin(liteConfig(T))` at 150 MiB (`KEEP`), `precision: 'i16'`
 * with `wasmStorage`, sampled, to `CAP` iterations (default 800). The clock
 * counts the pick and solving only. Every 10 iterations, off the clock, it
 * reads the root play (`rootPlay`) and each kept line's turn ranges
 * (`Solution.reachAt` at the line's first turn decision, what
 * `resolveSubgame` starts from). At each of `CHECKPOINTS` (default
 * 280,360,440,520,600,700,800), also off the clock, it re-solves the 9 saved
 * turn subgames (300 iterations, 4 threads) and scores them as
 * `measure.ts` does, against the unshared reference in
 * `scratch/blueprint-share/<board>-none/`.
 *
 * Offline it then tabulates, for each candidate stop rule, where it stops,
 * its time, and the re-solve gain at the first checkpoint at or after it:
 * - `root e:t:p`: `settle` as it is, every `e`, tolerance `t`, patience `p`;
 * - `turn e:t:p/max|mean`: the turn ranges' movement over `e` iterations,
 *   per line and player the total variation of the normalised range; the
 *   largest over lines and players (`max`), or the mean over lines weighted
 *   by how often each is reached, the larger player (`mean`). The root rule
 *   at its defaults must also hold.
 *
 * Writes `bench/lite/out/turn-stop/<board>-<workers>t.json`.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { COMBOS, createRun, defineSpot, keepWithin, liteConfig, rootPlay, rootPlayMovement } from '../../src/index.ts';
import type { RootPlay, Solution, SolveRun } from '../../src/index.ts';
import { matchupMass, Mode } from '../../src/cfr.ts';
import { wasmStorage } from '../../src/wasm-storage.ts';
import { resolveSubgame } from '../../src/resolve.ts';
import { configFromJson, lineNode, nodeEvs, openMass, turnBoard } from '../nested/lib.ts';
import { full as fullTree, type Board } from '../blueprint-share/spots.ts';

const [boardName, workerArg] = process.argv.slice(2) as [Board, string?];
const WORKERS = Number(workerArg ?? 4);
const CAP = Number(process.env.CAP ?? 800);
const KEEP = Number(process.env.KEEP ?? 150);
const CHECKPOINTS = (process.env.CHECKPOINTS ?? '280,360,440,520,600,700,800').split(',').map(Number);
const RESOLVE_ITS = 300;
const RESOLVE_WORKERS = Number(process.env.RESOLVE_WORKERS ?? 4);
const MiB = 2 ** 20;
const STEP = 10;
const storage = { precision: 'i16' as const, wasmStorage };

const full = fullTree(boardName);
const pickStart = performance.now();
const config = keepWithin(liteConfig(full), { keepBudget: KEEP * MiB, workers: WORKERS, ...storage, sampling: {} });
const pickMs = performance.now() - pickStart;
const kept = typeof config.shareHistories === 'object' ? [...(config.shareHistories.keepLines ?? [])] : [];
console.log(`${boardName}: kept ${kept.length} line(s) in ${(pickMs / 1000).toFixed(1)} s: ${kept.join(' | ')}`);
const later = {
	betSizes: full.betSizes, raiseSizes: full.raiseSizes, maxRaises: full.maxRaises, allowAllIn: full.allowAllIn, maxBytes: full.maxBytes,
	noDonk: false,
};
const REF = new URL(`../../scratch/blueprint-share/${boardName}-none/`, import.meta.url);

// ---------------------------------------------------------------- reference subgames
function loadReference(key: string): { run: SolveRun; sol: Solution; meta: { line: string; turn: string; lineReach: number } } {
	const meta = JSON.parse(readFileSync(new URL(`${key}.json`, REF), 'utf8'));
	const refRun = createRun(defineSpot(configFromJson(meta.config)), { analysisOnly: true });
	const bytes = readFileSync(new URL(`${key}.sums`, REF));
	const sums = refRun.solver.ctx.strategySum as Float32Array;
	if (bytes.byteLength !== sums.byteLength) throw new Error(`${key}: sums size mismatch`);
	sums.set(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
	return { run: refRun, sol: refRun.snapshot(), meta };
}

/** The opponent's best response to `sol`'s `player` minus its reference value, under reference ranges, % of the subgame's pot. */
function gain(sol: Solution, ref: Solution, player: 0 | 1): number {
	const opponent = (1 - player) as 0 | 1;
	const known = (p: 0 | 1): Float64Array =>
		Float64Array.from(ref.spot.players[p].weights, (w, h) => (sol.spot.players[p].slot[h] >= 0 ? w : 0));
	const knownP = known(player);
	const knownO = known(opponent);
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

const keys = readdirSync(REF).filter((f) => f.endsWith('.sums')).map((f) => f.slice(0, -5)).sort();
const refs = keys.map(loadReference);

/** Re-solve gain weighted by line reach, OOP / IP, and the mean re-solve time. */
function resolveGain(bp: Solution): { gain: [number, number]; seconds: number } {
	let mass = 0;
	const sum = [0, 0];
	let secs = 0;
	for (const { sol: ref, meta } of refs) {
		const node = lineNode(bp, meta.line);
		const board = turnBoard(bp, meta.turn);
		for (const player of [0, 1] as const) {
			const t = performance.now();
			const resolved = resolveSubgame(bp, node, board, {
				player, betting: later, iterations: RESOLVE_ITS, solve: { workers: RESOLVE_WORKERS, ...storage },
			});
			secs += (performance.now() - t) / 1000;
			sum[player] += meta.lineReach * gain(resolved.solution, ref, player);
		}
		mass += meta.lineReach;
	}
	return { gain: [sum[0] / mass, sum[1] / mass], seconds: secs / (2 * refs.length) };
}

// ---------------------------------------------------------------- turn ranges
/** Each kept line's ranges at its first turn decision, normalised, and its reach share. */
interface TurnRanges {
	readonly ranges: Float64Array[][];
	readonly shares: number[];
}
function turnRanges(sol: Solution, nodes: number[]): TurnRanges {
	const rootMass = matchupMass(sol.spot.players[0].weights, sol.spot.players[1].weights);
	const ranges: Float64Array[][] = [];
	const shares: number[] = [];
	for (const node of nodes) {
		const pair = ([0, 1] as const).map((p) => sol.reachAt(node, 0, p));
		shares.push(matchupMass(pair[0], pair[1]) / rootMass);
		ranges.push(pair.map((r) => {
			let total = 0;
			for (let h = 0; h < r.length; h++) total += r[h];
			return total > 0 ? r.map((x) => x / total) : r;
		}));
	}
	return { ranges, shares };
}
/** Per line and player, total variation between two readings. */
function turnMovement(a: TurnRanges, b: TurnRanges): number[][] {
	return b.ranges.map((pair, l) => pair.map((r, p) => {
		let tv = 0;
		for (let h = 0; h < r.length; h++) tv += Math.abs(r[h] - a.ranges[l][p][h]);
		return tv / 2;
	}));
}

// ---------------------------------------------------------------- blueprint
const spot = defineSpot(config);
const run = createRun(spot, { workers: WORKERS, approximations: { chanceSampling: {} }, ...storage });
const first = run.snapshot();
const nodes = kept.map((line) => lineNode(first, line));
const plays: RootPlay[] = [];
const turns: TurnRanges[] = [];
const seconds: number[] = [];
const checkpoints: { iterations: number; seconds: number; gain: [number, number]; resolveSeconds: number }[] = [];
let solveMs = pickMs;
for (let done = 0; done < CAP; ) {
	const t = performance.now();
	run.step(STEP);
	solveMs += performance.now() - t;
	done += STEP;
	const sol = run.snapshot();
	plays.push(rootPlay(sol));
	turns.push(turnRanges(sol, nodes));
	seconds.push(solveMs / 1000);
	if (CHECKPOINTS.includes(done)) {
		const r = resolveGain(sol);
		checkpoints.push({ iterations: done, seconds: solveMs / 1000, gain: r.gain, resolveSeconds: r.seconds });
		console.log(`  ${done} it, ${(solveMs / 1000).toFixed(1)} s: re-solve gain ${r.gain.map((x) => x.toFixed(2)).join(' / ')}, ${r.seconds.toFixed(1)} s each`);
	}
}
run.close();
for (const { run: refRun } of refs) refRun.close();

// ---------------------------------------------------------------- rules, offline
interface Hit {
	rule: string;
	iterations: number | null;
	seconds: number | null;
	gain: [number, number] | null;
}
const at = (i: number): number => (i + 1) * STEP;
const gainAt = (iterations: number): [number, number] | null => checkpoints.find((c) => c.iterations >= iterations)?.gain ?? null;
/** First check index where `moved(i)` held `patience` times running on checks `every` apart. */
function stopOf(every: number, patience: number, still: (i: number, lag: number) => boolean): number {
	let count = 0;
	const lag = every / STEP;
	for (let i = lag; i < plays.length; i++) {
		if (at(i) % every !== 0 || at(i) < 2 * every) continue;
		count = still(i, lag) ? count + 1 : 0;
		if (count >= patience) return i;
	}
	return -1;
}
const hit = (rule: string, i: number): Hit =>
	i < 0 ? { rule, iterations: null, seconds: null, gain: null } : { rule, iterations: at(i), seconds: seconds[i], gain: gainAt(at(i)) };
const rootStill = (tol: number) => (i: number, lag: number): boolean => rootPlayMovement(plays[i - lag], plays[i]) <= tol;
const rules: Hit[] = [];
for (const tol of [0.01, 0.005, 0.0035, 0.0025]) for (const patience of [2, 3]) rules.push(hit(`root 20:${tol}:${patience}`, stopOf(20, patience, rootStill(tol))));
for (const min of [500, 600, 800]) {
	const i = stopOf(20, 2, (j, lag) => at(j) >= min && rootStill(0.01)(j, lag));
	rules.push(hit(`root 20:0.01:2 min ${min}`, i));
}
const turnMax = (i: number, lag: number): number => Math.max(0, ...turnMovement(turns[i - lag], turns[i]).flat());
const turnMean = (i: number, lag: number): number => {
	const moved = turnMovement(turns[i - lag], turns[i]);
	const shares = turns[i].shares;
	const mass = shares.reduce((s, x) => s + x, 0);
	return moved.reduce((s, pair, l) => s + shares[l] * Math.max(...pair), 0) / (mass || 1);
};
for (const every of [20, 40]) {
	for (const tol of [0.02, 0.015, 0.01, 0.0075, 0.005]) {
		for (const [name, measure] of [['max', turnMax], ['mean', turnMean]] as const) {
			const i = stopOf(every, 2, (j, lag) => {
				// The root rule at its defaults, over its own 20 iterations, must hold too.
				const rootLag = 20 / STEP;
				return j >= rootLag && rootStill(0.01)(j, rootLag) && measure(j, lag) <= tol;
			});
			rules.push(hit(`turn ${every}:${tol}:2/${name}`, i));
		}
	}
}
for (const r of rules) {
	console.log(`  ${r.rule}: ${r.iterations === null ? 'never' : `${r.iterations} it, ${r.seconds!.toFixed(1)} s, gain ${r.gain ? r.gain.map((x) => x.toFixed(2)).join(' / ') : 'past the last checkpoint'}`}`);
}
// The raw movement series, for picking other tolerances offline.
const series = plays.map((_, i) => ({
	iterations: at(i),
	seconds: +seconds[i].toFixed(2),
	root: i >= 2 ? +rootPlayMovement(plays[i - 2], plays[i]).toFixed(5) : null,
	turn20max: i >= 2 ? +turnMax(i, 2).toFixed(5) : null,
	turn20mean: i >= 2 ? +turnMean(i, 2).toFixed(5) : null,
}));
const OUT = new URL('./out/turn-stop/', import.meta.url);
mkdirSync(OUT, { recursive: true });
writeFileSync(
	new URL(`${boardName}-${WORKERS}t.json`, OUT),
	JSON.stringify({ board: boardName, kept, shares: turns.at(-1)!.shares, pickMs, checkpoints, rules, series }, null, 1),
);
