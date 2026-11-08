/**
 * Issue #55: iterations to 0.3% of pot, which out-of-core storage does not
 * change (it is the same solve). In memory, 16-bit, threads in Node.
 *   node --import tsx bench/ooc/iterations.ts [T0|Tmono] [workers]
 */
import { createRun, defineSpot } from '../../src/index.ts';
import { T } from './size.ts';

const which = process.argv[2] ?? 'T0';
const workers = Number(process.argv[3] ?? 4);
const cfg = which === 'T0' ? T('As Kh 7d', { raiseSizes: ['allin'], maxRaises: 2 }) : T('Ks 9s 4s');
const run = createRun(defineSpot(cfg), { workers, precision: 'i16', engine: 'js' });
const started = performance.now();
for (let done = 0; done < 400; ) {
	const step = done < 20 ? 5 : 10;
	run.step(step);
	done += step;
	const e = run.exploitabilityPercent();
	console.log(which, 'iterations', done, 'exploitability %', e.toFixed(3), 's', ((performance.now() - started) / 1000).toFixed(0));
	if (e <= 0.3) break;
}
run.close();
