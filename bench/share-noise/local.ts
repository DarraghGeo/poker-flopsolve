/**
 * Issue #105: by how many histories hands reach shared blocks, on #103's
 * turn spot. Needs `probes.patch` applied (it adds a probe pass to `traverse`).
 *
 *   node --import tsx bench/share-noise/local.ts [spot JSON] [solve JSON]
 *
 * At several iteration counts it walks one training pass per player without
 * updating, under the profile the next iteration would play, and prints the
 * share of each player's own reach into shared blocks that arrives by a
 * history other than each hand's most-reached one: 0 when every hand reaches
 * each shared block by one history alone, `NaN` when no shared block is
 * reached at all.
 */
import { createRun, defineSpot } from '../../src/index.ts';
import { TURN_SPOT } from './spot.ts';

const G = globalThis as Record<string, unknown>;
G.__seed = Number(process.env.SEED ?? 0);
const extra = JSON.parse(process.argv[2] ?? '{}');
const opts = JSON.parse(process.argv[3] ?? '{}');
const run = createRun(defineSpot({ ...TURN_SPOT, ...extra }), { workers: 1, engine: 'js', precision: 'f64', ...opts });
let done = 0;
for (const target of [0, 1, 2, 3, 5, 10, 30, 100, 1000]) {
	if (target > done) run.step(target - done);
	done = target;
	const shares = ([0, 1] as const).map((p) => {
		const probe = new Map<number, { sum: Float64Array; max: Float64Array }>();
		G.__probe = probe;
		run.solver.traverseRoot(0 /* Mode.Train */, p, done + 1);
		G.__probe = undefined;
		let mass = 0;
		let split = 0;
		for (const { sum, max } of probe.values()) {
			for (let i = 0; i < sum.length; i++) {
				mass += sum[i];
				split += sum[i] - max[i];
			}
		}
		return `${((100 * split) / mass).toFixed(1)}%`;
	});
	console.log(`after ${done} it: reach off the main history, OOP ${shares[0]}, IP ${shares[1]}`);
}
