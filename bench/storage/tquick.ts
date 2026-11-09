/**
 * The target spot T itself, briefly: does it define and run with compact
 * storage, how long is an iteration, and what is the peak memory?
 *
 *   node --import tsx bench/storage/tquick.ts <spot> <storage json> [workers] [iterations]
 */

import { createRun, defineSpot } from '../../src/index.ts';
import type { CompactStorage, SolveOptions } from '../../src/index.ts';
import { STORAGE_SPOTS } from './spots.ts';

const [name, storageJson, workersArg, itersArg, algorithm, share] = process.argv.slice(2);
const storage = JSON.parse(storageJson) as CompactStorage | null;
const t0 = performance.now();
const spot = defineSpot({
	...STORAGE_SPOTS[name], ...(storage ? { compactStorage: storage } : {}), ...(share === 'share' ? { shareHistories: true } : {}),
});
const options: SolveOptions = { workers: Number(workersArg ?? 4), ...(algorithm && algorithm !== '-' ? { algorithm: algorithm as 'cfr+' } : {}), ...(storage ? {} : { precision: 'i16' }) };
const run = createRun(spot, options);
const setup = (performance.now() - t0) / 1000;
run.step(1);
const t1 = performance.now();
const iterations = Number(itersArg ?? 4);
run.step(iterations);
const perIteration = (performance.now() - t1) / 1000 / iterations;
const memory = process.memoryUsage();
console.log(JSON.stringify({
	spot: name, storage, shared: share === 'share', workers: run.workers, engine: run.engine,
	estimateGiB: +(((spot.estimate.compactBytes ?? spot.estimate.compressedBytes) / 2 ** 30)).toFixed(2),
	layoutGiB: +((run.solver.ctx.layout.bytes) / 2 ** 30).toFixed(2),
	chunks: run.solver.ctx.compactRegret?.length ?? 0,
	rssGiB: +(memory.rss / 2 ** 30).toFixed(2), arrayBuffersGiB: +(memory.arrayBuffers / 2 ** 30).toFixed(2), heapGiB: +(memory.heapUsed / 2 ** 30).toFixed(2),
	setupSeconds: +setup.toFixed(1), secondsPerIteration: +perIteration.toFixed(1),
	exploitability: +run.exploitabilityPercent().toFixed(2),
}));
run.close();
