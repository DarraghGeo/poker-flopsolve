/**
 * Reference solves for issue #51, and the size census on them.
 *
 *   node --import tsx bench/adaptive/reference.ts <board> <tree> [targetPercent] [precision] [workers]
 *
 * <board> is `rainbow` or `monotone`, <tree> a name in `TREES` (`T0`, ...).
 * Solves to the target (default 0.3% of pot), then writes per-combination root
 * EVs, the EVs of each root action and the census of every bet size to
 * `bench/adaptive/results/<board>-<tree>.json`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRun, defineSpot } from '../../src/index.ts';
import type { Precision } from '../../src/index.ts';
import { census, rootActionEvs, rootEvs } from './measure.ts';
import type { BoardName } from './spots.ts';
import { spotOn } from './spots.ts';
import { TREES } from './trees.ts';

const [board = 'rainbow', name = 'T0', target = '0.3', precision = 'i16', workers = '4'] = process.argv.slice(2);
const OUT = new URL('./results/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const config = spotOn(board as BoardName, TREES[name]);
const spot = defineSpot(config);
const started = performance.now();
const run = createRun(spot, { precision: precision as Precision, workers: Number(workers) });
console.log(`${board}-${name}: ${(spot.estimate.bytes / 2 ** 30).toFixed(2)} GiB f32, engine ${run.engine}, ${run.workers} threads`);

// Checks at growing gaps, as `solve` does, but logged.
let next = 10;
let exploitability = Infinity;
const history: { iteration: number; exploitability: number; seconds: number }[] = [];
while (run.completed < 2000) {
	run.step(next - run.completed);
	exploitability = run.exploitabilityPercent();
	const seconds = (performance.now() - started) / 1000;
	history.push({ iteration: run.completed, exploitability, seconds });
	console.log(`  ${run.completed} iterations, ${exploitability.toFixed(3)}% of pot, ${seconds.toFixed(0)} s`);
	if (exploitability <= Number(target)) break;
	next = Math.ceil(run.completed * 1.3);
}
run.close();
const seconds = (performance.now() - started) / 1000;

const evs = rootEvs(run);
const actions = rootActionEvs(run);
const result: Record<string, unknown> = {
	board, tree: name, config, iterations: run.completed, exploitability, seconds, history,
	bytes: spot.estimate.bytes, compressedBytes: spot.estimate.compressedBytes, evs, actions,
};
writeFileSync(new URL(`${board}-${name}.json`, OUT), JSON.stringify(result));
console.log(`  saved EVs after ${seconds.toFixed(0)} s; census...`);

if (process.env.CENSUS !== '0') {
	let last = Date.now();
	result.census = census(run, 2, (done, total) => {
		if (Date.now() - last > 30_000) {
			last = Date.now();
			console.log(`  census ${done}/${total}`);
		}
	});
	writeFileSync(new URL(`${board}-${name}.json`, OUT), JSON.stringify(result));
	console.log(`  census done, ${((performance.now() - started) / 1000).toFixed(0)} s`);
}
