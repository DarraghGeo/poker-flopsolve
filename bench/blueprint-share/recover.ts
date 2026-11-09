/**
 * Issue #101: why turns re-solved from a shared blueprint give away more than
 * from an unshared one, and what recovers it.
 *
 *   node --import tsx bench/blueprint-share/recover.ts <rainbow|two-tone|monotone> <name> '<json>'
 *
 * `json` picks the blueprint and what is done with it:
 * - `share`: 'river' (default), 'none' or 'turn+river'; `weighting`: 'counterfactual';
 * - `keep`: lines whose rivers stay unshared (`ShareHistories.keepLines`),
 *   or `keepTop`/`keepReach`/`keepMiB` (`linesWithin`, storage in MiB): the
 *   lines `turnLineReach` ranks highest after a
 *   `pick`-iteration shared solve (default 80), the blueprint then starting
 *   cold;
 * - `checkpoints`: iteration counts to measure at (default [400]);
 * - `sampling`: true for `chanceSampling` (one thread);
 * - `refine`: after the last checkpoint, for each reference line, a copy
 *   of the blueprint with that line's rivers unshared (`refine.ts`) runs
 *   `iterations` more, and that line's turns are re-solved from it.
 *
 * At each checkpoint, against `measure.ts`'s unshared reference in
 * `scratch/blueprint-share/<board>-none/`:
 * - the root play's loss at reference values and root EV error, as `measure.ts`;
 * - at each saved turn node, how far each player's range is from the
 *   reference's (total variation of the normalised ranges, and the ratio of
 *   their masses: how much more or less often the line is reached);
 * - the opponent's gain against an 'unsafe' re-solve (T's betting, 300
 *   iterations) under the reference's ranges, as `measure.ts`, and the same
 *   with the OOP or the IP range swapped for the reference's, which splits
 *   the gain between the two ranges.
 *
 * Writes `bench/blueprint-share/out/recover-<board>-<name>.json`.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { COMBOS, createRun, defineSpot, linesWithin, parseCards, turnLineReach } from '../../src/index.ts';
import { refineLines } from './refine.ts';
import type { Approximations, Solution, SolveRun, SpotConfig } from '../../src/index.ts';
import { Mode } from '../../src/cfr.ts';
import { configFromJson, fromJson, lineNode, nodeEvs, offCards, openMass, rootActionEvs, rootEvs, turnBoard } from '../nested/lib.ts';
import { blueprintOf, full as fullTree, type Board } from './spots.ts';

interface Plan {
	share?: string;
	weighting?: 'counterfactual';
	keep?: string[];
	keepTop?: number;
	keepReach?: number;
	/** Keep the most-reached lines whose storage fits this many MiB (`linesWithin`). */
	keepMiB?: number;
	pick?: number;
	checkpoints?: number[];
	sampling?: boolean;
	refine?: { iterations: number };
	/** With `keepTop`/`keepReach`: continue from the picking solve (`refineLines`) rather than start cold; checkpoints count its iterations. */
	warm?: boolean;
	workers?: number;
}

const [boardName, name, json] = process.argv.slice(2) as [Board, string, string?];
const plan: Plan = json ? JSON.parse(json) : {};
const checkpoints = plan.checkpoints ?? [400];
const RESOLVE_ITERATIONS = 300;
const MiB = 2 ** 20;
const workers = plan.sampling ? 1 : (plan.workers ?? 4);
const approximations: Approximations = plan.sampling ? { chanceSampling: {} } : {};

const full = fullTree(boardName);
const later = {
	betSizes: full.betSizes, raiseSizes: full.raiseSizes, maxRaises: full.maxRaises, allowAllIn: full.allowAllIn, maxBytes: full.maxBytes,
};
const REF = new URL(`../../scratch/blueprint-share/${boardName}-none/`, import.meta.url);

/** The blueprint config with `keepLines` and weighting applied. */
function configWith(keep: readonly string[]): SpotConfig {
	const base = blueprintOf(boardName, plan.share ?? 'river');
	const asked = base.shareHistories;
	if (asked === undefined) return base;
	const options = { ...(asked === true ? {} : asked), ...(plan.weighting ? { weighting: plan.weighting } : {}) };
	return { ...base, shareHistories: keep.length > 0 ? { ...options, keepLines: keep } : (Object.keys(options).length ? options : true) };
}

const started = performance.now();
let keep = plan.keep ?? [];
let pickSeconds = 0;
let pre: SolveRun | null = null;
if (plan.keepTop !== undefined || plan.keepReach !== undefined || plan.keepMiB !== undefined) {
	pre = createRun(defineSpot(configWith([])), { workers, approximations });
	pre.step(plan.pick ?? 80);
	const ranked = turnLineReach(pre.snapshot());
	if (!plan.warm) {
		pre.close();
		pre = null;
	}
	keep = plan.keepMiB !== undefined
		? linesWithin(pre!.snapshot(), plan.keepMiB * MiB)
		: ranked.filter((l, i) => (plan.keepTop !== undefined ? i < plan.keepTop : l.share >= plan.keepReach!)).map((l) => l.line);
	pickSeconds = (performance.now() - started) / 1000;
	console.log(`picked ${keep.length} lines in ${pickSeconds.toFixed(0)} s: ${ranked.slice(0, Math.max(keep.length, 4)).map((l) => `${l.line} ${(100 * l.share).toFixed(1)}%`).join('; ')}`);
}
const config = configWith(keep);
const spot = defineSpot(config);
console.log(`${boardName}-${name}: ${(spot.estimate.bytes / MiB).toFixed(0)} MiB f32, keep ${keep.length} lines`);

// ---------------------------------------------------------------- reference
const reference = JSON.parse(readFileSync(new URL('root.json', REF), 'utf8')) as {
	evs: (number | null)[][];
	actions: { actions: string[]; evs: (number | null)[][]; reach: (number | null)[]; probs: (number | null)[][] }[];
};
const keys = readdirSync(REF).filter((f) => f.endsWith('.sums')).map((f) => f.slice(0, -5)).sort();

interface Ref { key: string; sol: Solution; run: SolveRun; config: SpotConfig; line: string; turn: string; lineReach: number }
const refs: Ref[] = keys.map((key) => {
	const meta = JSON.parse(readFileSync(new URL(`${key}.json`, REF), 'utf8'));
	const cfg = configFromJson(meta.config);
	const run = createRun(defineSpot(cfg), { analysisOnly: true });
	const bytes = readFileSync(new URL(`${key}.sums`, REF));
	const sums = run.solver.ctx.strategySum as Float32Array;
	if (bytes.byteLength !== sums.byteLength) throw new Error(`${key}: sums size mismatch`);
	sums.set(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
	return { key, sol: run.snapshot(), run, config: cfg, line: meta.line, turn: meta.turn, lineReach: meta.lineReach };
});

// ---------------------------------------------------------------- scores
function evError(a: number[], b: number[], w: ArrayLike<number>): { mae: number; max: number } {
	let sum = 0;
	let mass = 0;
	let max = 0;
	for (let h = 0; h < COMBOS; h++) {
		if (!(w[h] > 0) || Number.isNaN(a[h]) || Number.isNaN(b[h])) continue;
		const gap = Math.abs(a[h] - b[h]);
		sum += w[h] * gap;
		mass += w[h];
		if (w[h] >= 0.01 && gap > max) max = gap;
	}
	return { mae: sum / mass, max };
}

function playLoss(probs: ArrayLike<number>[], refEv: number[][], reach: number[]): number {
	let sum = 0;
	let mass = 0;
	for (let h = 0; h < COMBOS; h++) {
		const w = reach[h];
		if (!(w > 0) || Number.isNaN(refEv[0][h])) continue;
		let bestEv = -Infinity;
		let played = 0;
		for (let a = 0; a < refEv.length; a++) {
			bestEv = Math.max(bestEv, refEv[a][h]);
			played += (probs[a][h] || 0) * refEv[a][h];
		}
		sum += w * (bestEv - played);
		mass += w;
	}
	return sum / mass;
}

/** As `measure.ts`: the opponent's best response to `sol`'s `player` over the reference's value, under reference ranges, % of the subgame pot. */
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

/** Total variation between the normalised ranges, and the mass ratio a / b. */
function rangeGap(a: ArrayLike<number>, b: ArrayLike<number>, cards: number[]): { tv: number; mass: number } {
	const x = offCards(a, cards);
	const y = offCards(b, cards);
	const sx = x.reduce((s, v) => s + v, 0);
	const sy = y.reduce((s, v) => s + v, 0);
	let tv = 0;
	for (let h = 0; h < COMBOS; h++) tv += Math.abs(x[h] / sx - y[h] / sy);
	return { tv: tv / 2, mass: sx / sy };
}

/** Both players' gains against an 'unsafe' solve of `cfg`, whose tree must be the reference's. */
function resolveGains(cfg: SpotConfig, ref: Ref): [number, number] {
	const run = createRun(defineSpot(cfg), { workers: 4 });
	try {
		run.step(RESOLVE_ITERATIONS);
		const sol = run.snapshot();
		if (sol.spot.tree.nodeCount !== ref.sol.spot.tree.nodeCount) throw new Error(`${ref.key}: re-solved tree differs`);
		return [gain(sol, ref.sol, 0), gain(sol, ref.sol, 1)];
	} finally {
		run.close();
	}
}

interface TurnScore {
	key: string;
	lineReach: number;
	range: [{ tv: number; mass: number }, { tv: number; mass: number }];
	gain: [number, number];
	gainRefOop: [number, number];
	gainRefIp: [number, number];
}

function scoreTurn(bp: Solution, ref: Ref): TurnScore {
	const node = lineNode(bp, ref.line);
	const board = turnBoard(bp, ref.turn);
	const sub: SpotConfig = { ...bp.subgameAt(node, board, later) };
	const cards = parseCards(sub.board as string);
	const range = ([0, 1] as const).map((p) =>
		rangeGap(p === 0 ? (sub.oop as Float64Array) : (sub.ip as Float64Array), p === 0 ? (ref.config.oop as Float64Array) : (ref.config.ip as Float64Array), cards),
	) as TurnScore['range'];
	return {
		key: ref.key,
		lineReach: ref.lineReach,
		range,
		gain: resolveGains(sub, ref),
		gainRefOop: resolveGains({ ...sub, oop: ref.config.oop }, ref),
		gainRefIp: resolveGains({ ...sub, ip: ref.config.ip }, ref),
	};
}

function weighted(rows: TurnScore[], pick: (r: TurnScore) => number): number {
	const mass = rows.reduce((s, r) => s + r.lineReach, 0);
	return rows.reduce((s, r) => s + r.lineReach * pick(r), 0) / mass;
}

function report(label: string, turns: TurnScore[]): Record<string, number> {
	const summary = {
		gainOop: weighted(turns, (r) => r.gain[0]),
		gainIp: weighted(turns, (r) => r.gain[1]),
		refOopGainOop: weighted(turns, (r) => r.gainRefOop[0]),
		refOopGainIp: weighted(turns, (r) => r.gainRefOop[1]),
		refIpGainOop: weighted(turns, (r) => r.gainRefIp[0]),
		refIpGainIp: weighted(turns, (r) => r.gainRefIp[1]),
		tvOop: weighted(turns, (r) => r.range[0].tv),
		tvIp: weighted(turns, (r) => r.range[1].tv),
	};
	for (const t of turns) {
		console.log(
			`    ${t.key}: TV ${t.range[0].tv.toFixed(3)} / ${t.range[1].tv.toFixed(3)}, mass ×${t.range[0].mass.toFixed(3)} / ×${t.range[1].mass.toFixed(3)}; ` +
				`gain ${t.gain.map((g) => g.toFixed(2)).join(' / ')}, ref OOP range ${t.gainRefOop.map((g) => g.toFixed(2)).join(' / ')}, ` +
				`ref IP range ${t.gainRefIp.map((g) => g.toFixed(2)).join(' / ')}`,
		);
	}
	console.log(
		`  ${label}: re-solve gain ${summary.gainOop.toFixed(3)} / ${summary.gainIp.toFixed(3)}; with the reference OOP range ` +
			`${summary.refOopGainOop.toFixed(3)} / ${summary.refOopGainIp.toFixed(3)}, IP range ${summary.refIpGainOop.toFixed(3)} / ${summary.refIpGainIp.toFixed(3)}; ` +
			`range TV ${summary.tvOop.toFixed(3)} / ${summary.tvIp.toFixed(3)}`,
	);
	return summary;
}

function rootScore(bp: Solution): { loss: [number, number]; evError: [{ mae: number; max: number }, { mae: number; max: number }] } {
	const evs = rootEvs(bp);
	const actions = rootActionEvs(bp);
	const weights = [bp.spot.players[0].weights, bp.spot.players[1].weights];
	const evError2 = ([0, 1] as const).map((p) => evError(evs[p], fromJson(reference.evs[p]), weights[p])) as [{ mae: number; max: number }, { mae: number; max: number }];
	const loss = actions.map((mine, d) => {
		const ref = reference.actions[d];
		if (mine.actions.join() !== ref.actions.join()) throw new Error('root actions differ');
		return playLoss(mine.probs, ref.evs.map(fromJson), fromJson(ref.reach));
	}) as [number, number];
	return { loss, evError: evError2 };
}

// ---------------------------------------------------------------- solve
let done = 0;
let run: SolveRun;
if (pre) {
	done = pre.totalIterations;
	run = refineLines(pre, keep, { iterations: 0, workers, approximations });
	pre.close();
} else {
	run = createRun(spot, { workers, approximations });
}
const out: Record<string, unknown>[] = [];
let solveSeconds = 0;
for (const at of checkpoints) {
	const t = performance.now();
	run.step(at - done);
	solveSeconds += (performance.now() - t) / 1000;
	done = at;
	const bp = run.snapshot();
	const exploitability = bp.exploitabilityPercent();
	const root = rootScore(bp);
	console.log(
		`${done} it (${solveSeconds.toFixed(0)} s solving): ${exploitability.toFixed(3)}% of pot; root play loses ${root.loss.map((l) => l.toFixed(4)).join(' / ')}%; ` +
			`root EV error ${root.evError.map((e) => `${e.mae.toFixed(3)} (${e.max.toFixed(2)})`).join(' / ')}`,
	);
	const turns = refs.map((ref) => scoreTurn(bp, ref));
	out.push({ iterations: done, solveSeconds, exploitability, root, summary: report(`${done} it`, turns), turns });
}

// ---------------------------------------------------------------- refinement
let refined: Record<string, unknown> | null = null;
if (plan.refine) {
	const turns: TurnScore[] = [];
	const lines = [...new Set(refs.map((r) => r.line))];
	const timing: { line: string; seconds: number; bytes: number }[] = [];
	for (const line of lines) {
		const t = performance.now();
		const local = refineLines(run, [line], { iterations: plan.refine.iterations, workers, approximations });
		const seconds = (performance.now() - t) / 1000;
		timing.push({ line, seconds, bytes: local.spot.estimate.bytes });
		const bp = local.snapshot();
		console.log(`  refined ${line}: ${plan.refine.iterations} it, ${seconds.toFixed(0)} s, ${(local.spot.estimate.bytes / MiB).toFixed(0)} MiB, root play loses ${rootScore(bp).loss.map((l) => l.toFixed(4)).join(' / ')}%`);
		for (const ref of refs.filter((r) => r.line === line)) turns.push(scoreTurn(bp, ref));
		local.close();
	}
	refined = { iterations: plan.refine.iterations, timing, summary: report(`refined ${plan.refine.iterations} it`, turns), turns };
}
run.close();
for (const r of refs) r.run.close();

const peakRss = process.resourceUsage().maxRSS * 1024;
console.log(`peak RSS ${(peakRss / MiB).toFixed(0)} MiB, ${((performance.now() - started) / 1000).toFixed(0)} s in all`);
const OUT = new URL('./out/', import.meta.url);
mkdirSync(OUT, { recursive: true });
writeFileSync(
	new URL(`recover-${boardName}-${name}.json`, OUT),
	JSON.stringify({ board: boardName, name, plan, keep, pickSeconds, storageBytes: spot.estimate.bytes, peakRss, checkpoints: out, refined }, null, 1),
);
