/**
 * Issue #100: what lite's simplification costs on rainbow, against the exact
 * T₀ solve on As Kh 7d from issue #51 (`bench/adaptive/results/rainbow-T0.json`:
 * bench ranges, pot 55, stack 975, sizes 0.33 / 0.75 / 1.5 on every street,
 * all-in raises, two aggressions, 561 iterations to 0.22% of pot).
 *
 *   node --import tsx bench/lite/t0.ts <lite|unshared> [variant,...] [workers]
 *
 * The caller's betting is T₀'s. `lite` solves `liteConfig(T₀)` with the
 * recipe (river sharing, `runoutBuckets: 3`, `chanceSampling`; variants
 * `nodonk`, `flop2`, `nosample` as in `measure.ts`) until `settle`'s rule
 * fires. `unshared` solves the same simplified tree with no sharing and no
 * sampling to 0.05% of pot (cap 1500), so it isolates what the turn and river
 * simplification costs from what sharing and sampling add.
 *
 * Scores, against T₀:
 * - OOP's root play loss: each hand's best stored action EV minus the stored
 *   EV of the mix the blueprint plays, weighted by OOP's range, % of pot. T₀
 *   stores no strategy, so there is no floor from its own play; its 0.22% of
 *   pot exploitability bounds how far its own values can be trusted. IP's
 *   per-action EVs after a check are not stored, so this is OOP only.
 * - per-hand root EV error, both players, % of pot (`bench/adaptive`'s
 *   `comboError`: mean weighted by range times open opponent mass, max over
 *   weight ≥ 0.01).
 */

import { readFileSync } from 'node:fs';
import { createRun, defineSpot, liteConfig, rootPlay, trackSettle } from '../../src/index.ts';
import type { Approximations, LiteOptions, SpotConfig } from '../../src/index.ts';
import { comboError } from '../adaptive/measure.ts';
import type { ComboEvs } from '../adaptive/measure.ts';
import { rootEvs } from '../nested/lib.ts';

const [mode = 'lite', variantArg, workerArg] = process.argv.slice(2);
const variants = (variantArg ?? 'base').split(',').filter((v) => v !== 'base');
const reference = JSON.parse(readFileSync(new URL('../adaptive/results/rainbow-T0.json', import.meta.url), 'utf8')) as {
	config: SpotConfig;
	evs: (number | null)[][];
	actions: Record<string, (number | null)[]>;
	exploitability: number;
};
const nan = (v: (number | null)[]): number[] => v.map((x) => (x === null ? Number.NaN : x));
const refEvs = reference.evs.map(nan) as ComboEvs;
const refActions = Object.entries(reference.actions).map(([label, evs]) => ({ label, evs: nan(evs) }));

const lite: LiteOptions = {
	...(variants.includes('nodonk') ? { noDonk: true } : {}),
	...(variants.includes('flop2') ? { flopMaxRaises: 2 } : {}),
	...(mode === 'unshared' ? { shareHistories: false } : {}),
};
const sampled = mode === 'lite' && !variants.includes('nosample');
const approximations: Approximations = sampled ? { chanceSampling: {} } : {};
const workers = Number(workerArg ?? (sampled ? 1 : 4));
const config = { ...liteConfig({ ...reference.config, maxBytes: 6 * 2 ** 30 }, lite) };
const spot = defineSpot(config);
console.log(`T0 ${mode} ${variants.join('+') || 'base'}: ${(spot.estimate.bytes / 2 ** 20).toFixed(0)} MiB f32, ${workers} thread(s)`);
const run = createRun(spot, { workers, approximations });
const tracker = trackSettle();
let done = 0;
let ms = 0;
for (;;) {
	const t = performance.now();
	run.step(20);
	done += 20;
	const settled = mode === 'lite' && tracker.check(run.snapshot(), done);
	ms += performance.now() - t;
	if (settled) break;
	if (mode === 'unshared' && done % 100 === 0) {
		const e = run.exploitabilityPercent();
		console.log(`  ${done} it, ${e.toFixed(3)}%`);
		if (e <= 0.05) break;
	}
	if (done >= 1500) break;
}
const sol = run.snapshot();
console.log(`  stopped at ${done} it, ${(ms / 1000).toFixed(1)} s solving, ${run.exploitabilityPercent().toFixed(3)}% of pot (own game)`);

// OOP's root play at T₀'s per-action values.
const view = rootPlay(sol).views[0];
const order = view.actions.map((label) => {
	const i = refActions.findIndex((a) => a.label === label);
	if (i < 0) throw new Error(`root action ${label} not in T0's ${refActions.map((a) => a.label)}`);
	return i;
});
if (order.length !== refActions.length) throw new Error('root actions differ');
const weights = spot.players[0].weights;
const n = view.actions.length;
let lost = 0;
let mass = 0;
for (let i = 0; i < view.combos.length; i++) {
	const combo = view.combos[i];
	const w = weights[combo];
	if (!(w > 0) || refActions.some((a) => Number.isNaN(a.evs[combo]))) continue;
	let best = -Infinity;
	let played = 0;
	for (let a = 0; a < n; a++) {
		const ev = refActions[order[a]].evs[combo];
		best = Math.max(best, ev);
		played += view.probs[i * n + a] * ev;
	}
	lost += w * (best - played);
	mass += w;
}
const error = comboError(rootEvs(sol) as ComboEvs, refEvs, run);
console.log(
	`  OOP root play loss at T0's values: ${(lost / mass).toFixed(4)}% of pot; ` +
		`root EV error OOP mean ${error[0].mae.toFixed(3)} max ${error[0].max.toFixed(3)}, IP mean ${error[1].mae.toFixed(3)} max ${error[1].max.toFixed(3)}`,
);
run.close();
