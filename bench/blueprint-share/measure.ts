/**
 * Issue #85: accuracy of issue #47's blueprint with `shareHistories`, in Node
 * on four threads at 32 bits (the WebAssembly engine).
 *
 *   node --import tsx bench/blueprint-share/measure.ts <rainbow|two-tone|monotone> <none|river|turn+river> [iterations] [sampling|sampling<p>,compact|compact-nearest,coarse]
 *
 * The blueprint is `bench/nested`'s `1size-b3`: T's flop betting, one 0.75
 * bet on the turn and river with no raise, `runoutBuckets: 3`. It is solved
 * to 0.3% of pot (`BLUEPRINT_TARGET` to change it) or `iterations` (default
 * 400), then measured against a reference:
 *
 * the unshared blueprint on the same board, from this script's own `none`
 * run (with `BLUEPRINT_TARGET=0.05`), in `scratch/blueprint-share/<board>-none/`.
 * This measures what sharing costs, not distance to the full three-size
 * game, which no full-tree reference here gives (issue #89 will). That run
 * also saves, for the 3 flop lines it reaches most and 3 turns each, the
 * turn subgame at T's full betting solved for 600 iterations: the ranges
 * and values the re-solves are judged under.
 *
 * Reports:
 * - root EV error per combination, % of pot (mean over the range, and max
 *   over combinations of weight ≥ 0.01);
 * - the EV the blueprint's root play loses at reference values, for OOP at
 *   the root and IP after a check: each hand's best reference action minus
 *   the reference value of the mix it plays (`bench/nested/sizes.ts`);
 * - for each saved turn node, the opponent's best-response gain against an
 *   'unsafe' re-solve at T's betting (300 iterations), under the reference
 *   ranges, % of the subgame's pot (`bench/nested/run.ts`), and the mean
 *   weighted by how often each line is reached.
 *
 * Writes `bench/blueprint-share/out/<board>-<share>[-<approx>].json`.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { COMBOS, createRun, defineSpot, NodeKind } from '../../src/index.ts';
import type { Approximations, Solution, SolveRun, SpotConfig } from '../../src/index.ts';
import { matchupMass, Mode } from '../../src/cfr.ts';
import { resolveSubgame } from '../../src/resolve.ts';
import { wasmStorage } from '../../src/wasm-storage.ts';
import {
	configFromJson, configToJson, fromJson, lineNode, nodeEvs, openMass, rootActionEvs, rootEvs, toJson, turnBoard,
} from '../nested/lib.ts';
import { blueprintOf, full as fullTree, TURNS, type Board } from './spots.ts';

const [boardName, shareName, iterArg, approxArg] = process.argv.slice(2) as [Board, string, string?, string?];
const CAP = Number(iterArg ?? 400);
const TARGET = Number(process.env.BLUEPRINT_TARGET ?? 0.3);
const approxNames = approxArg ? approxArg.split(',') : [];
// `sampling` walks each deal with probability 0.35, `sampling0.9` with 0.9 (issue #105).
const samplingName = approxNames.find((name) => name.startsWith('sampling'));
const approximations: Approximations = {
	...(samplingName ? { chanceSampling: samplingName === 'sampling' ? {} : { p: Number(samplingName.slice(8)) } } : {}),
	// The blueprint's own buckets are at a gap of 3, so the coarse copy needs a wider one.
	...(approxNames.includes('coarse') ? { coarseStart: { iterations: 40, runoutBuckets: 6 } } : {}),
};
// BLUEPRINT_TAG suffixes the run's name, e.g. for a lower iteration cap.
const tag = `${boardName}-${shareName}${approxNames.length ? `-${approxNames.join('+')}` : ''}${process.env.BLUEPRINT_TAG ?? ''}`;
const RESOLVE_ITERATIONS = 300;
const REF_ITERATIONS = 600;
const LINE_COUNT = 3;
const MiB = 2 ** 20;

const full = fullTree(boardName);
// `compact` stores 8-bit regrets and sums rounded at random, `compact-nearest` rounded to nearest (issue #105).
const compactName = approxNames.find((name) => name.startsWith('compact'));
const config: SpotConfig = {
	...blueprintOf(boardName, shareName),
	...(compactName ? { compactStorage: compactName === 'compact-nearest' ? { nearest: true } : {} } : {}),
};
const later = {
	betSizes: full.betSizes, raiseSizes: full.raiseSizes, maxRaises: full.maxRaises, allowAllIn: full.allowAllIn, maxBytes: full.maxBytes,
};
const ownDir = new URL(`../../scratch/blueprint-share/${tag}/`, import.meta.url);
mkdirSync(ownDir, { recursive: true });
const REF = new URL(`../../scratch/blueprint-share/${boardName}-none/`, import.meta.url);
// BLUEPRINT_RESOLVES=0 skips the turn re-solves and the subgames they are judged under.
const RESOLVES = process.env.BLUEPRINT_RESOLVES !== '0';
const isOwnReference = RESOLVES && shareName === 'none' && approxNames.length === 0 && !process.env.BLUEPRINT_TAG;

// ---------------------------------------------------------------- blueprint
const spot = defineSpot(config);
console.log(
	`${tag}: ${spot.estimate.decisionNodes} nodes, ${spot.estimate.runouts} runouts, ${((spot.estimate.compactBytes ?? spot.estimate.bytes) / MiB).toFixed(0)} MiB ${compactName ? "8-bit" : "f32"}`,
);
const started = performance.now();
const run = createRun(spot, { workers: 4, approximations, ...(compactName ? { wasmStorage } : {}) });
const history: { iterations: number; seconds: number; exploitability: number }[] = [];
let done = 0;
let next = 20;
let best = Infinity;
for (;;) {
	run.step(next - done);
	done = next;
	const exploitability = run.exploitabilityPercent();
	best = Math.min(best, exploitability);
	history.push({ iterations: done, seconds: (performance.now() - started) / 1000, exploitability });
	console.log(`  ${done} it, ${exploitability.toFixed(3)}%, ${history.at(-1)!.seconds.toFixed(0)} s`);
	if (exploitability <= TARGET || done >= CAP) break;
	next = Math.min(CAP, done < 80 ? done * 2 : done + 40);
}
const seconds = (performance.now() - started) / 1000;
const bp = run.snapshot();
const peakRss = process.resourceUsage().maxRSS * 1024;
const engine = run.engine;
console.log(
	`blueprint: ${done} it, ${bp.exploitabilityPercent().toFixed(3)}% (best ${best.toFixed(3)}%), ${seconds.toFixed(0)} s, ` +
		`engine ${engine}, peak RSS ${(peakRss / MiB).toFixed(0)} MiB`,
);
run.close();

const evs = rootEvs(bp);
const actions = rootActionEvs(bp);
writeFileSync(
	new URL('root.json', ownDir),
	JSON.stringify({
		tag,
		iterations: done,
		exploitability: bp.exploitabilityPercent(),
		evs: evs.map(toJson),
		actions: actions.map((a) => ({ ...a, evs: a.evs.map(toJson), reach: toJson(a.reach), probs: a.probs.map(toJson) })),
	}),
);

// ---------------------------------------------------------------- reference subgames (rainbow, unshared)
if (isOwnReference) {
	// An earlier run's subgames may be for other lines.
	for (const f of readdirSync(REF)) if (/\.(sums|json)$/.test(f) && f !== 'root.json') rmSync(new URL(f, REF));
	const { tree } = bp.spot;
	const rootMass = matchupMass(bp.spot.players[0].weights, bp.spot.players[1].weights);
	const lines: { line: string; mass: number }[] = [];
	for (let node = 0; node < tree.nodeCount; node++) {
		if (tree.kind[node] !== NodeKind.Chance || tree.round[node] !== 0) continue;
		lines.push({ line: bp.path(tree.edgeChild[tree.firstEdge[node]]), mass: matchupMass(bp.reachAt(node, 0, 0), bp.reachAt(node, 0, 1)) });
	}
	lines.sort((a, b) => b.mass - a.mass);
	for (const { line, mass } of lines.slice(0, LINE_COUNT)) {
		const node = lineNode(bp, line);
		for (const turn of TURNS[boardName]) {
			const board = turnBoard(bp, turn);
			const sub = bp.subgameAt(node, board, later);
			const t = performance.now();
			const refRun = createRun(defineSpot(sub), { workers: 4 });
			refRun.step(REF_ITERATIONS);
			const local = refRun.exploitabilityPercent();
			const key = `${line.replaceAll(' ', '_').replaceAll('/', '')}-${turn}`;
			const sums = refRun.solver.ctx.strategySum as Float32Array;
			writeFileSync(new URL(`${key}.sums`, REF), new Uint8Array(sums.buffer, sums.byteOffset, sums.byteLength));
			writeFileSync(
				new URL(`${key}.json`, REF),
				JSON.stringify({ line, turn, node, board, lineReach: mass / rootMass, localExploitability: local, config: configToJson(sub) }),
			);
			console.log(
				`  reference ${key}: line reached ${((100 * mass) / rootMass).toFixed(1)}%, ${REF_ITERATIONS} it, ` +
					`${local.toFixed(3)}% of its pot, ${((performance.now() - t) / 1000).toFixed(0)} s`,
			);
			refRun.close();
		}
	}
}

// ---------------------------------------------------------------- against the reference
const reference = JSON.parse(readFileSync(new URL('root.json', REF), 'utf8')) as {
	evs: (number | null)[][];
	actions: { player: 0 | 1; actions: string[]; evs: (number | null)[][]; reach: (number | null)[]; probs: (number | null)[][] }[];
};

/** Per-combination gap, % of pot: mean weighted by `w`, max over weight ≥ 0.01. As in `bench/nested/run.ts`. */
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
const weights = [spot.players[0].weights, spot.players[1].weights];
const rootError = ([0, 1] as const).map((p) => evError(evs[p], fromJson(reference.evs[p]), weights[p]));
console.log(
	`root EV error, % pot: OOP mean ${rootError[0].mae.toFixed(3)} max ${rootError[0].max.toFixed(3)}; ` +
		`IP mean ${rootError[1].mae.toFixed(3)} max ${rootError[1].max.toFixed(3)}`,
);

/** EV the played mix loses against each hand's best action, at reference values (`bench/nested/sizes.ts`). */
function playLoss(probs: ArrayLike<number>[], refEv: number[][], reach: number[]): { mean: number; max: number } {
	let sum = 0;
	let mass = 0;
	let max = 0;
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
		max = Math.max(max, bestEv - played);
	}
	return { mean: sum / mass, max };
}
const loss = actions.map((mine, d) => {
	const ref = reference.actions[d];
	if (mine.actions.join() !== ref.actions.join()) throw new Error(`root actions differ: ${mine.actions} vs ${ref.actions}`);
	const refEv = ref.evs.map(fromJson);
	const reach = fromJson(ref.reach);
	return {
		decision: d === 0 ? 'OOP at root' : 'IP after check',
		blueprint: playLoss(mine.probs, refEv, reach),
		reference: playLoss(ref.probs.map(fromJson), refEv, reach),
	};
});
for (const l of loss) {
	console.log(
		`  ${l.decision}: root play loses ${l.blueprint.mean.toFixed(4)}% pot at reference values (max ${l.blueprint.max.toFixed(3)}); ` +
			`the reference's own ${l.reference.mean.toFixed(4)}%`,
	);
}

// ---------------------------------------------------------------- turn re-solves
/** The saved reference subgame, analysis-only. */
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

const keys = !RESOLVES ? [] : readdirSync(REF)
	.filter((f) => f.endsWith('.sums') && f !== 'strategy.sums')
	.map((f) => f.slice(0, -5))
	.sort();
const resolves: { key: string; lineReach: number; gain: [number, number] }[] = [];
for (const key of keys) {
	const { sol: ref, run: refRun, meta } = loadReference(key);
	const node = lineNode(bp, meta.line);
	const board = turnBoard(bp, meta.turn);
	const g = ([0, 1] as const).map((player) => {
		const resolved = resolveSubgame(bp, node, board, {
			player, gadget: 'unsafe', betting: later, iterations: RESOLVE_ITERATIONS, solve: { workers: 4 },
		});
		if (resolved.solution.spot.tree.nodeCount !== ref.spot.tree.nodeCount) throw new Error(`${key}: re-solved tree differs`);
		return gain(resolved.solution, ref, player);
	}) as [number, number];
	resolves.push({ key, lineReach: meta.lineReach, gain: g });
	console.log(`  re-solve ${key} (line reached ${(100 * meta.lineReach).toFixed(1)}%): opponent gains ${g.map((x) => x.toFixed(3)).join(' / ')}% of its pot`);
	refRun.close();
}
const weighted = ([0, 1] as const).map((p) => {
	const mass = resolves.reduce((s, r) => s + r.lineReach, 0);
	return mass > 0 ? resolves.reduce((s, r) => s + r.lineReach * r.gain[p], 0) / mass : Number.NaN;
});
console.log(`re-solve gain, weighted by line reach: OOP refined ${weighted[0].toFixed(3)}%, IP refined ${weighted[1].toFixed(3)}%`);

const OUT = new URL('./out/', import.meta.url);
mkdirSync(OUT, { recursive: true });
writeFileSync(
	new URL(`${tag}.json`, OUT),
	JSON.stringify(
		{
			tag,
			storageBytes: spot.estimate.compactBytes ?? spot.estimate.bytes,
			peakRss,
			engine,
			seconds,
			iterations: done,
			exploitability: bp.exploitabilityPercent(),
			best,
			history,
			rootError,
			loss,
			resolves,
			resolveGain: weighted,
		},
		null,
		1,
	),
);
