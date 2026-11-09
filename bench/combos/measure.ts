/**
 * Issue #102: one combination of memory levers on one spot, measured.
 *
 *   node --import tsx bench/combos/measure.ts <spot> <combination> [checkpoints]
 *
 * `spot` and `combination` are named in `spots.ts` (e.g. `T thin+i16`).
 * `checkpoints` is a comma list of iteration counts (default
 * 10,20,40,80,120,160,200,250,300). Environment:
 *
 * - `REF`: a reference to score against, either `bench/adaptive/results/
 *   rainbow-T0.json` (the exact T₀ solve, OOP's root actions only) or a
 *   `*.root.json` this script saved;
 * - `EXPL`: checkpoints at which to measure exploitability, a comma list,
 *   `all` or `last` (default `last`; each costs about an iteration);
 * - `MAX_SECONDS`: stop at the first checkpoint after this much training;
 * - `SAVE=1`: save the final root data as `out/<spot>-<combination>.root.json`,
 *   to serve as a reference;
 * - `WORKERS`: threads, default 4.
 *
 * At each checkpoint it records training seconds, peak RSS, and against the
 * reference:
 * - root-play loss: for each decision the reference covers (OOP at the root,
 *   and IP after a check), each hand's best reference action EV minus the
 *   reference EV of the mix this solve plays, weighted by the reference's
 *   reach times the opponent mass the hand does not block, % of pot
 *   (`bench/blueprint-share/measure.ts`, #85);
 * - per-combination root EV error, % of pot, mean (weighted as above) and max
 *   over weight ≥ 1% (`bench/adaptive/measure.ts`, #51);
 * - drift: the range-weighted mean total-variation distance of OOP's root
 *   strategy from the previous checkpoint.
 *
 * Writes `out/<spot>-<combination>.json`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { COMBOS, createRun, defineSpot } from '../../src/index.ts';
import type { Solution } from '../../src/index.ts';
import { fromJson, openMass, rootActionEvs, rootEvs, toJson } from '../nested/lib.ts';
import type { ActionEvs, Vec } from '../nested/lib.ts';
import { combination, SPOTS } from './spots.ts';

const [spotName, comboName, checkpointArg] = process.argv.slice(2);
const checkpoints = (checkpointArg ?? '10,20,40,80,120,160,200,250,300').split(',').map(Number);
const workers = Number(process.env.WORKERS ?? 4);
const maxSeconds = Number(process.env.MAX_SECONDS ?? Infinity);
const explAt = process.env.EXPL ?? 'last';
const tag = `${spotName}-${comboName}${process.env.TAG ?? ''}`;
const out = (suffix: string): URL => new URL(`./out/${tag}${suffix}`, import.meta.url);
const GiB = 2 ** 30;

const { config: levers, options } = combination(comboName);
const config = { ...SPOTS[spotName], ...levers };

/** A reference: per-combination root EVs and, per decision, each action's EVs (% of pot). */
interface Reference {
	evs: Vec[];
	decisions: { player: 0 | 1; actions: string[]; evs: Vec[]; reach: Vec | null; probs: Vec[] | null }[];
}
function loadReference(path: string): Reference {
	const json = JSON.parse(readFileSync(path, 'utf8'));
	if (json.decisions) {
		return {
			evs: json.evs.map(fromJson),
			decisions: json.decisions.map((d: Record<string, never>) => ({
				player: d.player, actions: d.actions, evs: (d.evs as never[]).map(fromJson), reach: fromJson(d.reach),
				probs: (d.probs as never[]).map(fromJson),
			})),
		};
	}
	// bench/adaptive's exact solves: OOP's root actions, keyed by label in edge order.
	return {
		evs: json.evs.map(fromJson),
		decisions: [{ player: 0, actions: Object.keys(json.actions), evs: Object.values(json.actions as Record<string, never>).map(fromJson), reach: null, probs: null }],
	};
}
const reference = process.env.REF ? loadReference(process.env.REF) : null;

/** EV the played mix loses against each hand's best reference action, % of pot; weight `reach` × open opponent mass. */
function playLoss(probs: Vec[], refEv: Vec[], reach: ArrayLike<number>, opponent: ArrayLike<number>): { mean: number; max: number } {
	const open = openMass(opponent);
	let sum = 0;
	let mass = 0;
	let max = 0;
	for (let h = 0; h < COMBOS; h++) {
		const w = reach[h] * open[h];
		if (!(w > 0) || Number.isNaN(refEv[0][h])) continue;
		let best = -Infinity;
		let played = 0;
		for (let a = 0; a < refEv.length; a++) {
			best = Math.max(best, refEv[a][h]);
			played += (probs[a][h] || 0) * refEv[a][h];
		}
		sum += w * (best - played);
		mass += w;
		if (reach[h] >= 0.01) max = Math.max(max, best - played);
	}
	return { mean: sum / mass, max };
}

/** Per-combination EV error, % of pot: mean weighted by range × open mass, max over weight ≥ 1%. */
function evError(mine: Vec, theirs: Vec, w: ArrayLike<number>, opponent: ArrayLike<number>): { mean: number; max: number } {
	const open = openMass(opponent);
	let sum = 0;
	let mass = 0;
	let max = 0;
	for (let h = 0; h < COMBOS; h++) {
		if (!(w[h] > 0) || Number.isNaN(mine[h]) || Number.isNaN(theirs[h])) continue;
		const gap = Math.abs(mine[h] - theirs[h]);
		sum += w[h] * open[h] * gap;
		mass += w[h] * open[h];
		if (w[h] >= 0.01) max = Math.max(max, gap);
	}
	return { mean: sum / mass, max };
}

/** Range-weighted mean total-variation distance between two strategies at a decision. */
function drift(a: Vec[], b: Vec[], reach: ArrayLike<number>): number {
	let sum = 0;
	let mass = 0;
	for (let h = 0; h < COMBOS; h++) {
		if (!(reach[h] > 0) || Number.isNaN(a[0][h])) continue;
		let tv = 0;
		for (let x = 0; x < a.length; x++) tv += Math.abs(a[x][h] - b[x][h]);
		sum += reach[h] * tv * 0.5;
		mass += reach[h];
	}
	return sum / mass;
}

function score(sol: Solution): { row: Record<string, unknown>; evs: Vec[]; decisions: ActionEvs[] } {
	const evs = rootEvs(sol);
	const decisions = rootActionEvs(sol);
	const row: Record<string, unknown> = {};
	if (reference) {
		const w = [sol.spot.players[0].weights, sol.spot.players[1].weights];
		const err = ([0, 1] as const).map((p) => evError(evs[p], reference.evs[p], w[p], w[1 - p]));
		row.evError = err.map((e) => ({ mean: +e.mean.toFixed(4), max: +e.max.toFixed(3) }));
		row.loss = reference.decisions.map((ref, d) => {
			const mine = decisions[d];
			if (mine.actions.length !== ref.actions.length) throw new Error(`decision ${d}: ${mine.actions} vs ${ref.actions}`);
			// The reference's reach where it has one, else the range (the root).
			const reach = ref.reach ?? Array.from(w[ref.player]);
			const opponent = d === 0 ? w[1] : decisions[0].reach.map((_, h) => w[0][h] * (decisions[0].probs[0][h] || 0));
			const refOpp = ref.reach && d === 1 ? reference.decisions[0].reach!.map((r, h) => r * (reference.decisions[0].probs![0][h] || 0)) : opponent;
			const l = playLoss(mine.probs, ref.evs, reach, refOpp);
			return { mean: +l.mean.toFixed(4), max: +l.max.toFixed(3) };
		});
	}
	return { row, evs, decisions };
}

const spot = defineSpot(config);
console.log(
	`${tag}: ${spot.estimate.decisionNodes} nodes, ${spot.estimate.runouts} runouts; estimate f32 ${(spot.estimate.bytes / GiB).toFixed(2)} GiB, ` +
		`i16 ${(spot.estimate.compressedBytes / GiB).toFixed(2)}, compact ${spot.estimate.compactBytes === null ? '-' : (spot.estimate.compactBytes / GiB).toFixed(2)}`,
);
const setupStart = performance.now();
const run = createRun(spot, { ...options, workers });
const setupSeconds = (performance.now() - setupStart) / 1000;
const storageBytes = run.solver.ctx.layout.bytes;
console.log(`  engine ${run.engine}, ${run.workers} threads, storage ${(storageBytes / GiB).toFixed(3)} GiB, setup ${setupSeconds.toFixed(1)} s`);

const rows: Record<string, unknown>[] = [];
let trained = 0;
let done = 0;
let previous: ActionEvs[] | null = null;
let last: { evs: Vec[]; decisions: ActionEvs[]; exploitability: number | null } | null = null;
for (const [i, target] of checkpoints.entries()) {
	const t = performance.now();
	run.step(target - done);
	trained += (performance.now() - t) / 1000;
	done = target;
	const final = i === checkpoints.length - 1 || trained >= maxSeconds;
	const wantExpl = explAt === 'all' || (explAt === 'last' ? final : explAt.split(',').map(Number).includes(target));
	const exploitability = wantExpl ? run.exploitabilityPercent() : null;
	const sol = run.snapshot();
	const { row, evs, decisions } = score(sol);
	const oopReach = decisions[0].reach;
	const entry = {
		iterations: done,
		seconds: +trained.toFixed(1),
		perIteration: +(trained / done).toFixed(3),
		exploitability: exploitability === null ? undefined : +exploitability.toFixed(3),
		...row,
		drift: previous ? +drift(decisions[0].probs, previous[0].probs, oopReach).toFixed(4) : undefined,
		peakRssGiB: +((process.resourceUsage().maxRSS * 1024) / GiB).toFixed(2),
	};
	previous = decisions;
	last = { evs, decisions, exploitability };
	rows.push(entry);
	console.log('  ' + JSON.stringify(entry));
	if (final) break;
}
run.close();

/** First checkpoint from which the OOP root-play loss stays within `tolerance` % of pot of the final one. */
function settled(tolerance: number): { iterations: number; seconds: number } | null {
	const losses = rows.map((r) => (r.loss as { mean: number }[] | undefined)?.[0]?.mean);
	if (losses.some((l) => l === undefined)) return null;
	const end = losses.at(-1)!;
	let from = rows.length - 1;
	while (from > 0 && Math.abs(losses[from - 1]! - end) <= tolerance) from--;
	return { iterations: rows[from].iterations as number, seconds: rows[from].seconds as number };
}

const summary = {
	spot: spotName, combination: comboName, engine: run.engine, workers: run.workers,
	estimate: { f32: spot.estimate.bytes, i16: spot.estimate.compressedBytes, compact: spot.estimate.compactBytes },
	storageGiB: +(storageBytes / GiB).toFixed(3),
	setupSeconds: +setupSeconds.toFixed(1),
	peakRssGiB: +((process.resourceUsage().maxRSS * 1024) / GiB).toFixed(2),
	settled: { within002: settled(0.02), within005: settled(0.05) },
	reference: process.env.REF ?? null,
	rows,
};
writeFileSync(out('.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ ...summary, rows: undefined }));
if (process.env.SAVE === '1' && last) {
	writeFileSync(
		out('.root.json'),
		JSON.stringify({
			spot: spotName, combination: comboName, iterations: done, exploitability: last.exploitability,
			evs: last.evs.map(toJson),
			decisions: last.decisions.map((d) => ({ player: d.player, actions: d.actions, evs: d.evs.map(toJson), reach: toJson(d.reach), probs: d.probs.map(toJson) })),
		}),
	);
}
