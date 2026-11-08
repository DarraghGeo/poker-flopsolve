/**
 * Reference solves for issue #56, on 4 threads to 0.3% of pot, saved to
 * `scratch/graft/<game>-<board>.json` with everything `measure.ts` reads.
 *
 *   node --import tsx bench/graft/reference.ts <R|T|base> <rainbow|monotone> [precision] [js]
 *
 * Spots over 2 GiB need `js`: the WebAssembly engine reads its results at a
 * signed offset and fails past 2 GiB of memory.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRun, defineSpot } from '../../src/index.ts';
import type { Precision } from '../../src/index.ts';
import { read } from './measure.ts';
import { baseGame, BOARDS, flopGame, target } from './spots.ts';

const OUT = new URL('../../scratch/graft/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const [game, boardName, precision, engine] = process.argv.slice(2);
const make = { R: flopGame, T: target, base: baseGame }[game as 'R' | 'T' | 'base'];
const config = make(BOARDS[boardName]);
const spot = defineSpot(config);
const started = performance.now();
const run = createRun(spot, { workers: 4, precision: precision as Precision | undefined, engine: engine === 'js' ? 'js' : undefined });
console.log(`${game} ${boardName}: ${run.engine}, ${(spot.estimate.bytes / 2 ** 30).toFixed(2)} GiB f32 / ${(spot.estimate.compressedBytes / 2 ** 30).toFixed(2)} GiB i16`);
const target_ = Number(process.env.TARGET ?? 0.3);
let exploit = Infinity;
let next = 10;
while (run.completed < 2000) {
	run.step(next - run.completed);
	exploit = run.exploitabilityPercent();
	console.log(`  ${run.completed} iterations, ${((performance.now() - started) / 1000).toFixed(0)} s, ${exploit.toFixed(3)}% of pot`);
	if (exploit <= target_) break;
	next = run.completed + Math.max(5, Math.round(run.completed * 0.25));
}
const seconds = (performance.now() - started) / 1000;
const reading = read(run);
writeFileSync(
	new URL(`${game}-${boardName}.json`, OUT),
	JSON.stringify({ game, board: boardName, iterations: run.completed, seconds, exploitability: exploit, ...reading }),
);
console.log(`done in ${seconds.toFixed(0)} s (reading took ${((performance.now() - started) / 1000 - seconds).toFixed(0)} s)`);
run.close();
