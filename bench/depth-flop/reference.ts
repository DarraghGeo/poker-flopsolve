/**
 * Exact reference solves for issue #48, at 16 bits on every core, to 0.3% of
 * pot. Saves root EVs per combination for both players and for each
 * out-of-position root action to `scratch/depth-flop/<spot>.json`.
 *
 *   node --import tsx bench/depth-flop/reference.ts T0-rainbow [...]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRun, defineSpot } from '../../src/index.ts';
import { rootReport } from './measure.ts';
import { SPOTS } from './spots.ts';

const OUT = new URL('../../scratch/depth-flop/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const target = Number(process.env.TARGET ?? 0.3);
for (const name of process.argv.slice(2)) {
	const config = { ...SPOTS[name], maxBytes: 14 * 2 ** 30 };
	const spot = defineSpot(config);
	const started = performance.now();
	const run = createRun(spot, { workers: 4, precision: 'i16' });
	console.log(`${name}: ${(spot.estimate.compressedBytes / 2 ** 30).toFixed(2)} GiB at i16, ${run.workers} threads, ${run.engine}`);
	let done = 0;
	let next = 20;
	let exploitability = Infinity;
	while (done < 2000) {
		run.step(next - done);
		done = next;
		exploitability = run.exploitabilityPercent();
		const seconds = (performance.now() - started) / 1000;
		console.log(`  ${done} iterations, ${seconds.toFixed(0)} s, ${exploitability.toFixed(3)}% of pot`);
		// Saved at every check, so a long solve can be stopped with what it has.
		if (exploitability < 3) {
			const report = rootReport(spot, run.solver);
			writeFileSync(new URL(`${name}.json`, OUT), JSON.stringify({ name, iterations: done, seconds, exploitability, ...report }));
		}
		if (exploitability <= target) break;
		next = Math.ceil(done * (exploitability > 2 * target ? 1.5 : 1.2));
	}
	console.log(`  saved`);
	run.close();
}
process.exit(0);
