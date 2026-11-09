/**
 * Issue #100: lite mode on issue #47's target betting, in Node, scored against
 * the unshared blueprint (issue #85's yardstick).
 *
 *   node --import tsx bench/lite/measure.ts <rainbow|two-tone|monotone> [variant,...] [workers]
 *
 * Variants (comma-separated, on top of `liteConfig`'s defaults):
 * `nosample` (no chanceSampling), `nodonk`, `flop2` (flop capped at two
 * aggressions), `raise` (one turn/river raise), `p=<x>` (sampling
 * probability), `turn+river` (share the turn too).
 *
 * Environment:
 * - `RULE`: the stop rule, `every:tolerance:patience` (default `20:0.01:2`,
 *   `settle`'s defaults), or `none` to run to `CAP` and tabulate when each
 *   of a grid of rules would have stopped;
 * - `CAP`: iteration cap (default 1000);
 * - `RESOLVES=0`: skip the turn re-solves;
 * - `RESOLVE_ITS`: re-solve iterations to try, comma-separated (default 300);
 * - `WARM`: re-solve warm starts to try, comma-separated `off`, `0`, `bp`
 *   (DCFR count from 0, or from the blueprint's) (default `off`).
 *
 * The clock counts solving only (`step`); every 10 iterations, off the clock,
 * it reads the root play (`rootPlay`), and every 50 the exploitability. At the
 * stop it measures, against the unshared blueprint from
 * `bench/blueprint-share/measure.ts <board> none` (`BLUEPRINT_TARGET=0.05`,
 * in `scratch/blueprint-share/<board>-none/`):
 * - root play loss: the EV OOP's root mix and IP's mix after a check lose
 *   at the reference's per-action values, % of pot (`bench/nested/sizes.ts`);
 * - per-hand root EV error, % of pot (mean, and max over weight ≥ 0.01);
 * - for each saved turn subgame (3 lines × 3 turns, T's betting, 600
 *   reference iterations), the opponent's best-response gain against an
 *   'unsafe' re-solve, % of the subgame's pot, under the reference ranges,
 *   and its wall time; and the mean weighted by line reach.
 *
 * Writes `bench/lite/out/<board>-<variants>-<workers>t[-<rule>].json`.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { COMBOS, createRun, defineSpot, liteConfig, rootPlay, rootPlayMovement } from '../../src/index.ts';
import type { Approximations, LiteOptions, RootPlay, Solution, SolveRun, SpotConfig } from '../../src/index.ts';
import { Mode } from '../../src/cfr.ts';
import { resolveSubgame } from '../../src/resolve.ts';
import { configFromJson, fromJson, lineNode, nodeEvs, openMass, rootEvs, turnBoard } from '../nested/lib.ts';
import { full as fullTree, type Board } from '../blueprint-share/spots.ts';

const [boardName, variantArg, workerArg] = process.argv.slice(2) as [Board, string?, string?];
const variants = (variantArg ?? 'base').split(',').filter((v) => v !== 'base');
const WORKERS = Number(workerArg ?? 1);
const CAP = Number(process.env.CAP ?? 1000);
const RULE = process.env.RULE ?? '20:0.01:2';
const RESOLVES = process.env.RESOLVES !== '0';
const RESOLVE_ITS = (process.env.RESOLVE_ITS ?? '300').split(',').map(Number);
const WARM = (process.env.WARM ?? 'off').split(',');
const MiB = 2 ** 20;
const STEP = 10;

const lite: LiteOptions = {
	...(variants.includes('nodonk') ? { noDonk: true } : {}),
	...(variants.includes('flop2') ? { flopMaxRaises: 2 } : {}),
	...(variants.includes('raise') ? { laterRaise: true } : {}),
	...(variants.includes('turn+river') ? { shareHistories: { fromRound: 1 } } : {}),
};
const pArg = variants.find((v) => v.startsWith('p='));
const approximations: Approximations = variants.includes('nosample')
	? {}
	: { chanceSampling: pArg ? { p: Number(pArg.slice(2)) } : {} };
const tag = `${boardName}-${variants.length ? variants.join('+') : 'base'}-${WORKERS}t${RULE === '20:0.01:2' ? '' : `-${RULE.replaceAll(':', '_')}`}`;

const full = fullTree(boardName);
const config: SpotConfig = liteConfig(full, lite);
const later = {
	betSizes: full.betSizes, raiseSizes: full.raiseSizes, maxRaises: full.maxRaises, allowAllIn: full.allowAllIn, maxBytes: full.maxBytes,
};
const REF = new URL(`../../scratch/blueprint-share/${boardName}-none/`, import.meta.url);
const reference = JSON.parse(readFileSync(new URL('root.json', REF), 'utf8')) as {
	evs: (number | null)[][];
	actions: { player: 0 | 1; actions: string[]; evs: (number | null)[][]; reach: (number | null)[]; probs: (number | null)[][] }[];
};
const refActions = reference.actions.map((a) => ({ actions: a.actions, evs: a.evs.map(fromJson), reach: fromJson(a.reach) }));

/** EV a root play loses at reference values, per decision, % of pot. */
function lossOf(play: RootPlay): number[] {
	return play.views.map((view, d) => {
		const { evs, reach, actions } = refActions[d];
		if (view.actions.join() !== actions.join()) throw new Error(`root actions differ: ${view.actions} vs ${actions}`);
		let lost = 0;
		let mass = 0;
		const n = view.actions.length;
		for (let i = 0; i < view.combos.length; i++) {
			const combo = view.combos[i];
			const w = reach[combo];
			if (!(w > 0) || Number.isNaN(evs[0][combo])) continue;
			let best = -Infinity;
			let played = 0;
			for (let a = 0; a < n; a++) {
				best = Math.max(best, evs[a][combo]);
				played += view.probs[i * n + a] * evs[a][combo];
			}
			lost += w * (best - played);
			mass += w;
		}
		return lost / mass;
	});
}

// ---------------------------------------------------------------- blueprint
const spot = defineSpot(config);
console.log(
	`${tag}: ${spot.estimate.decisionNodes} nodes, ${spot.estimate.runouts} runouts, ${(spot.estimate.bytes / MiB).toFixed(0)} MiB f32`,
);
const run = createRun(spot, { workers: WORKERS, approximations });
interface Check {
	iterations: number;
	seconds: number;
	loss: number[];
	exploitability: number | null;
}
const checks: Check[] = [];
const plays: RootPlay[] = [];
const [ruleEvery, ruleTol, rulePatience] = RULE === 'none' ? [0, 0, 0] : RULE.split(':').map(Number);
let still = 0;
let solveMs = 0;
let stoppedAt = 'cap';
for (let done = 0; done < CAP; ) {
	const t = performance.now();
	run.step(STEP);
	solveMs += performance.now() - t;
	done += STEP;
	const sol = run.snapshot();
	const play = rootPlay(sol);
	plays.push(play);
	const exploitability = done % 50 === 0 ? run.exploitabilityPercent() : null;
	checks.push({ iterations: done, seconds: solveMs / 1000, loss: lossOf(play), exploitability });
	if (exploitability !== null) {
		console.log(`  ${done} it, ${(solveMs / 1000).toFixed(1)} s, ${exploitability.toFixed(3)}%, loss ${checks.at(-1)!.loss.map((x) => x.toFixed(4)).join(' / ')}`);
	}
	if (ruleEvery > 0 && done % ruleEvery === 0 && done >= 2 * ruleEvery) {
		const before = plays[plays.length - 1 - ruleEvery / STEP];
		still = rootPlayMovement(before, play) <= ruleTol ? still + 1 : 0;
		if (still >= rulePatience) {
			stoppedAt = 'settled';
			break;
		}
	}
}
const bp = run.snapshot();
const done = checks.at(-1)!.iterations;
const seconds = solveMs / 1000;
const exploitability = run.exploitabilityPercent();
const peakRss = process.resourceUsage().maxRSS * 1024;
console.log(
	`blueprint: ${stoppedAt} at ${done} it, ${seconds.toFixed(1)} s solving (${((1000 * seconds) / done).toFixed(0)} ms/it), ` +
		`${exploitability.toFixed(3)}%, engine ${run.engine}, ${run.workers} thread(s), peak RSS ${(peakRss / MiB).toFixed(0)} MiB`,
);

// ---------------------------------------------------------------- rules, offline
interface RuleHit {
	rule: string;
	iterations: number | null;
	seconds: number | null;
	loss: number[] | null;
}
const rules: RuleHit[] = [];
if (RULE === 'none') {
	const final = checks.at(-1)!.loss;
	console.log(`final loss ${final.map((x) => x.toFixed(4)).join(' / ')} at ${done} it`);
	// #85's retrospective marks, for comparison.
	const settledAt = checks.findIndex((_, i) => checks.slice(i).every((c) => c.loss.every((x, k) => Math.abs(x - final[k]) <= 0.01)));
	console.log(`  loss settled (±0.01% of final) at ${settledAt < 0 ? 'never' : `${checks[settledAt].iterations} it, ${checks[settledAt].seconds.toFixed(1)} s`}`);
	for (const every of [10, 20, 40]) {
		for (const tol of [0.005, 0.01, 0.02, 0.03]) {
			for (const patience of [1, 2, 3]) {
				let count = 0;
				let hit = -1;
				for (let i = 0; i < checks.length && hit < 0; i++) {
					const it = checks[i].iterations;
					if (it % every !== 0 || it < 2 * every) continue;
					const moved = rootPlayMovement(plays[i - every / STEP], plays[i]);
					count = moved <= tol ? count + 1 : 0;
					if (count >= patience) hit = i;
				}
				const rule = `${every}:${tol}:${patience}`;
				rules.push(hit < 0
					? { rule, iterations: null, seconds: null, loss: null }
					: { rule, iterations: checks[hit].iterations, seconds: checks[hit].seconds, loss: checks[hit].loss });
				const r = rules.at(-1)!;
				console.log(
					`  rule ${rule}: ${r.iterations === null ? 'never' : `${r.iterations} it, ${r.seconds!.toFixed(1)} s, loss ${r.loss!.map((x) => x.toFixed(4)).join(' / ')}`}`,
				);
			}
		}
	}
}

// ---------------------------------------------------------------- accuracy at the stop
/** Per-combination gap, % of pot: mean weighted by `w`, max over weight ≥ 0.01. */
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
const evs = rootEvs(bp);
const weights = [spot.players[0].weights, spot.players[1].weights];
const rootError = ([0, 1] as const).map((p) => evError(evs[p], fromJson(reference.evs[p]), weights[p]));
const loss = lossOf(rootPlay(bp));
const refLoss = reference.actions.map((a) => {
	// The reference's own play at its own values: the floor.
	let lost = 0;
	let mass = 0;
	const evsA = a.evs.map(fromJson);
	const probs = a.probs.map(fromJson);
	const reach = fromJson(a.reach);
	for (let h = 0; h < COMBOS; h++) {
		if (!(reach[h] > 0) || Number.isNaN(evsA[0][h])) continue;
		let best = -Infinity;
		let played = 0;
		for (let k = 0; k < evsA.length; k++) {
			best = Math.max(best, evsA[k][h]);
			played += (probs[k][h] || 0) * evsA[k][h];
		}
		lost += reach[h] * (best - played);
		mass += reach[h];
	}
	return lost / mass;
});
console.log(
	`root EV error, % pot: OOP mean ${rootError[0].mae.toFixed(3)} max ${rootError[0].max.toFixed(3)}; ` +
		`IP mean ${rootError[1].mae.toFixed(3)} max ${rootError[1].max.toFixed(3)}`,
);
console.log(
	`root play loss at reference values, % pot: ${loss.map((x) => x.toFixed(4)).join(' / ')} ` +
		`(reference's own ${refLoss.map((x) => x.toFixed(4)).join(' / ')})`,
);
run.close();

// ---------------------------------------------------------------- turn re-solves
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

const keys = !RESOLVES ? [] : readdirSync(REF).filter((f) => f.endsWith('.sums')).map((f) => f.slice(0, -5)).sort();
interface ResolveResult {
	key: string;
	lineReach: number;
	iterations: number;
	warm: string;
	gain: [number, number];
	seconds: [number, number];
}
const resolves: ResolveResult[] = [];
for (const key of keys) {
	const { sol: ref, run: refRun, meta } = loadReference(key);
	const node = lineNode(bp, meta.line);
	const board = turnBoard(bp, meta.turn);
	for (const iterations of RESOLVE_ITS) {
		for (const warm of WARM) {
			const seconds: number[] = [];
			const g = ([0, 1] as const).map((player) => {
				const t = performance.now();
				const resolved = resolveSubgame(bp, node, board, {
					player, gadget: 'unsafe', betting: later, iterations, solve: { workers: WORKERS },
					...(warm === 'off' ? {} : { warmStart: { iteration: warm === 'bp' ? bp.totalIterations : Number(warm) } }),
				});
				seconds.push((performance.now() - t) / 1000);
				if (resolved.solution.spot.tree.nodeCount !== ref.spot.tree.nodeCount) throw new Error(`${key}: re-solved tree differs`);
				return gain(resolved.solution, ref, player);
			}) as [number, number];
			resolves.push({ key, lineReach: meta.lineReach, iterations, warm, gain: g, seconds: seconds as [number, number] });
			console.log(
				`  re-solve ${key} (reached ${(100 * meta.lineReach).toFixed(1)}%), ${iterations} it, warm ${warm}: ` +
					`opponent gains ${g.map((x) => x.toFixed(3)).join(' / ')}% of its pot, ${seconds.map((x) => x.toFixed(1)).join(' / ')} s`,
			);
		}
	}
	refRun.close();
}
const summary: { iterations: number; warm: string; gain: number[]; seconds: number }[] = [];
for (const iterations of RESOLVE_ITS) {
	for (const warm of WARM) {
		const rows = resolves.filter((r) => r.iterations === iterations && r.warm === warm);
		if (!rows.length) continue;
		const mass = rows.reduce((s, r) => s + r.lineReach, 0);
		const g = [0, 1].map((p) => rows.reduce((s, r) => s + r.lineReach * r.gain[p], 0) / mass);
		const secs = rows.reduce((s, r) => s + r.seconds[0] + r.seconds[1], 0) / (2 * rows.length);
		summary.push({ iterations, warm, gain: g, seconds: secs });
		console.log(
			`re-solve ${iterations} it, warm ${warm}: gain weighted by line reach OOP ${g[0].toFixed(3)}% / IP ${g[1].toFixed(3)}%, mean ${secs.toFixed(1)} s each`,
		);
	}
}

const OUT = new URL('./out/', import.meta.url);
mkdirSync(OUT, { recursive: true });
writeFileSync(
	new URL(`${tag}.json`, OUT),
	JSON.stringify(
		{
			tag, storageBytes: spot.estimate.bytes, peakRss, workers: WORKERS, stoppedAt, iterations: done, seconds, exploitability,
			rootError, loss, refLoss, rules, resolves, summary,
			checks: checks.map((c) => ({ ...c, loss: c.loss.map((x) => +x.toFixed(5)) })),
		},
		null,
		1,
	),
);
