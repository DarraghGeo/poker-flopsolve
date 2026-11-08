/**
 * Reference solve for issue #47: a full tree solved to 0.3% of pot on four
 * threads. Saves per-combination root EVs, the root decisions' per-action EVs,
 * and for each sampled turn node the subtree below it, as an analysis-only
 * subgame (config + float32 strategy sums), to `scratch/nested/`.
 *
 *   node --import tsx bench/nested/reference.ts <rainbow|monotone> <T|T0> [precision] [engine]
 *
 * NESTED_LOAD=1 reads the saved strategy back instead of solving, to cut the
 * turn subgames out again.
 */

import { closeSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from 'node:fs';
import { createRun, defineSpot, solve } from '../../src/index.ts';
import type { Precision } from '../../src/index.ts';
import { warmStart } from '../../src/warm.ts';
import { NodeKind } from '../../src/index.ts';
import { matchupMass } from '../../src/cfr.ts';
import { configToJson, lineNode, rootActionEvs, rootEvs, toJson, turnBoard } from './lib.ts';
import { small, target, TURNS, type BoardName } from './spots.ts';

const [boardName, treeName, precisionArg, engineArg] = process.argv.slice(2) as [BoardName, 'T' | 'T0', Precision?, string?];
const config = (treeName === 'T' ? target : small)(boardName);
const name = `${boardName}-${treeName}`;
const OUT = new URL(`../../scratch/nested/${name}/`, import.meta.url);
mkdirSync(OUT, { recursive: true });

const spot = defineSpot(config);
const precision = precisionArg ?? (spot.estimate.bytes < 3.5 * 2 ** 30 ? 'f32' : 'i16');
console.log(
	`${name}: ${(spot.estimate.bytes / 2 ** 30).toFixed(2)} GiB f32, ${(spot.estimate.compressedBytes / 2 ** 30).toFixed(2)} GiB i16; solving at ${precision}`,
);
const load = process.env.NESTED_LOAD === '1';
const started = performance.now();
const solution = load
	? loadSaved()
	: solve(spot, {
			workers: 4,
			targetPercent: 0.3,
			iterations: 2000,
			precision,
			engine: engineArg === 'js' ? 'js' : undefined,
			onProgress: (p) =>
				console.log(
					`  ${p.iteration} it, ${((100 * p.exploitability) / config.pot).toFixed(3)}% pot, ${(p.elapsedMs / 1000).toFixed(0)} s, rss ${(process.memoryUsage().rss / 2 ** 30).toFixed(2)} GiB`,
				),
		});
const seconds = (performance.now() - started) / 1000;
if (!load) console.log(`solved: ${solution.iterations} it, ${solution.exploitabilityPercent().toFixed(3)}%, ${seconds.toFixed(0)} s`);

/** The saved average strategy in an analysis-only run of the same spot. */
function loadSaved() {
	const run = createRun(spot, { analysisOnly: true, precision, engine: 'js' });
	const { strategySum, sumScale } = run.solver.ctx;
	const raw = new Uint8Array(strategySum.buffer, strategySum.byteOffset, strategySum.byteLength);
	const fd = openSync(new URL('strategy.sums', OUT), 'r');
	for (let at = 0; at < raw.byteLength; ) at += readSync(fd, raw, at, Math.min(2 ** 30, raw.byteLength - at), at);
	closeSync(fd);
	if (sumScale) {
		const scales = readFileSync(new URL('strategy.scales', OUT));
		new Uint8Array(sumScale.buffer, sumScale.byteOffset, sumScale.byteLength).set(scales);
	}
	return run.snapshot();
}

if (!load) {
	// The whole average strategy, so other nodes can be cut out later without
	// solving again: raw sums, and their per-block scales at 16 bits.
	{
		const { strategySum, sumScale } = solution.solver.ctx;
		const raw = new Uint8Array(strategySum.buffer, strategySum.byteOffset, strategySum.byteLength);
		const fd = openSync(new URL('strategy.sums', OUT), 'w');
		for (let at = 0; at < raw.byteLength; at += 2 ** 30) writeSync(fd, raw.subarray(at, Math.min(raw.byteLength, at + 2 ** 30)));
		closeSync(fd);
		if (sumScale) writeFileSync(new URL('strategy.scales', OUT), new Uint8Array(sumScale.buffer, sumScale.byteOffset, sumScale.byteLength));
	}

	const t0 = performance.now();
	const evs = rootEvs(solution);
	const actions = rootActionEvs(solution);
	console.log(`root EVs read in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
	writeFileSync(
		new URL('root.json', OUT),
		JSON.stringify({
			name,
			precision,
			iterations: solution.iterations,
			seconds,
			exploitability: solution.exploitabilityPercent(),
			evs: evs.map(toJson),
			actions: actions.map((a) => ({
				...a,
				evs: a.evs.map(toJson),
				reach: toJson(a.reach),
				probs: a.probs.map(toJson),
			})),
		}),
	);
}

// The flop lines reaching the turn most often: a rarely reached line's
// strategy is barely trained even in the reference, so it measures nothing.
const { tree } = solution.spot;
const lines: { line: string; mass: number }[] = [];
for (let node = 0; node < tree.nodeCount; node++) {
	if (tree.kind[node] !== NodeKind.Chance || tree.round[node] !== 0) continue;
	const mass = matchupMass(solution.reachAt(node, 0, 0), solution.reachAt(node, 0, 1));
	lines.push({
		line: solution.path(tree.edgeChild[tree.firstEdge[node]]),
		mass,
	});
}
const rootMass = matchupMass(solution.spot.players[0].weights, solution.spot.players[1].weights);
lines.sort((a, b) => b.mass - a.mass);
const LINE_COUNT = 5;
for (const { line, mass } of lines.slice(0, LINE_COUNT)) {
	console.log(`  line ${line}: reached ${((100 * mass) / rootMass).toFixed(2)}% of deals`);
	const node = lineNode(solution, line);
	for (const turn of TURNS[boardName]) {
		const board = turnBoard(solution, turn);
		const sub = solution.subgameAt(node, board);
		const run = createRun(defineSpot(sub), { analysisOnly: true });
		warmStart(run.solver.ctx, solution.solver.ctx, true, undefined, node);
		const key = `${line.replaceAll(' ', '_').replaceAll('/', '')}-${turn}`;
		const sums = run.solver.ctx.strategySum as Float32Array;
		writeFileSync(new URL(`${key}.sums`, OUT), new Uint8Array(sums.buffer, sums.byteOffset, sums.byteLength));
		const local = run.exploitabilityPercent();
		writeFileSync(
			new URL(`${key}.json`, OUT),
			JSON.stringify({
				line,
				turn,
				node,
				board,
				lineReach: mass / rootMass,
				localExploitability: local,
				config: configToJson(sub),
			}),
		);
		console.log(`  saved ${key}: ${(sums.byteLength / 2 ** 20).toFixed(1)} MiB, local exploitability ${local.toFixed(3)}% of its pot`);
		run.close();
	}
}
console.log(`max rss ${(process.resourceUsage().maxRSS / 2 ** 20).toFixed(2)} GiB`);
