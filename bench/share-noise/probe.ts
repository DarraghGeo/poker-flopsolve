/**
 * Issue #105: exploitability of the average and the current profile under
 * `shareHistories`, on #103's small turn spot, in Node on one thread.
 *
 *   node --import tsx bench/share-noise/probe.ts [spot JSON] [solve JSON]
 *
 * The spot JSON is spread over the turn spot (e.g. '{"shareHistories":false}'),
 * the solve JSON over `{ workers: 1, engine: 'js' }` (e.g. '{"precision":"f64"}').
 * Prints both exploitabilities at 100, 300, 1000 and 3000 iterations; the
 * current profile's is read by putting the positive regrets in place of the
 * strategy sums for one measurement.
 *
 * With `probes.patch` applied (it is not part of the solver), these variables
 * steer it: SEED salts chance sampling's random draws; DITHER scales each
 * shared history's regret update by a uniform random factor of mean 1 and
 * that standard deviation, on iterations FROM+1 to UNTIL; EPS is a function
 * of the iteration `t` (e.g. 'Math.min(0.5, 5 / t)'), the share of uniform
 * play mixed into the training strategy at every node. DITHER acts on
 * DCFR's update only, not CFR+'s.
 */
import { readFileSync } from 'node:fs';
import { createRun, defineSpot } from '../../src/index.ts';
import { TURN_SPOT } from './spot.ts';

const hooks = ['SEED', 'DITHER', 'EPS'].filter((name) => process.env[name]);
if (hooks.length > 0 && !readFileSync(new URL('../../src/cfr.ts', import.meta.url), 'utf8').includes('__dither')) {
	throw new Error(`${hooks.join(', ')} need bench/share-noise/probes.patch applied`);
}

const G = globalThis as Record<string, unknown>;
G.__seed = Number(process.env.SEED ?? 0);
G.__dither = Number(process.env.DITHER ?? 0);
G.__from = Number(process.env.FROM ?? 0);
G.__until = Number(process.env.UNTIL ?? 1e9);
if (process.env.EPS) G.__eps = new Function('t', `return ${process.env.EPS}`);


const extra = JSON.parse(process.argv[2] ?? '{}');
const opts = JSON.parse(process.argv[3] ?? '{}');
const spot = defineSpot({ ...TURN_SPOT, ...extra });
const run = createRun(spot, { workers: 1, engine: 'js', ...opts });
const ctx = run.solver.ctx as { regret: Float32Array | Float64Array; strategySum: Float32Array | Float64Array };
let done = 0;
for (const target of [100, 300, 1000, 3000]) {
	run.step(target - done);
	done = target;
	const average = run.exploitabilityPercent();
	let current = NaN;
	if (ctx.regret.length === ctx.strategySum.length && ctx.regret.length > 0) {
		const saved = ctx.strategySum.slice();
		for (let i = 0; i < ctx.regret.length; i++) ctx.strategySum[i] = Math.max(0, ctx.regret[i]);
		current = run.exploitabilityPercent();
		ctx.strategySum.set(saved);
	}
	console.log(`${done} it: average ${average.toFixed(3)}%, current ${current.toFixed(3)}%`);
}
