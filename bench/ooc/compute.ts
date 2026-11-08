/**
 * Issue #55: compute time per iteration in memory, i16, one thread, for the
 * spots paging would serve, to set beside the I/O OPFS would add.
 *   node --import tsx bench/ooc/compute.ts [T0|Tmono] [iters]
 */
import { createRun, defineSpot } from '../../src/index.ts';
import { T } from './size.ts';

const which = process.argv[2] ?? 'Tmono';
const iters = Number(process.argv[3] ?? 3);
const cfg = which === 'T0' ? T('As Kh 7d', { raiseSizes: ['allin'], maxRaises: 2 }) : T('Ks 9s 4s');
const spot = defineSpot(cfg);
const t0 = performance.now();
const run = createRun(spot, { workers: 1, precision: 'i16' });
console.log(which, 'setup ms', (performance.now() - t0).toFixed(0), 'slots', spot.estimate.totalSlots);
run.step(1);
const t = performance.now();
run.step(iters);
const ms = (performance.now() - t) / iters;
console.log(which, 'ms/iteration', ms.toFixed(0), 'ns/slot', ((ms * 1e6) / spot.estimate.totalSlots).toFixed(2),
	'rss GiB', (process.memoryUsage().rss / 2 ** 30).toFixed(2));
run.close();
