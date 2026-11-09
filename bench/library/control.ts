/**
 * Control for the flop-library experiment (#30): a cold solve whose iteration
 * count starts at 10, with nothing seeded.
 *
 *   node --import tsx bench/library/control.ts
 *
 * The flop-only seeds helped only with `warmIteration: 10`. This tells apart
 * what the seed bought from what starting DCFR's discounting at iteration 10
 * buys on its own. Results go to `results/control.json`; `summary.ts control=…`
 * does not apply (several spots), so read the table printed here.
 */

import { writeFileSync } from 'node:fs';
import { createRun, defineSpot, solve } from '../../src/index.ts';
import type { SpotConfig } from '../../src/index.ts';
import { SPOTS as COMPARE } from '../compare/spots.ts';
import type { Trace } from './measure.ts';
import { REFERENCE_PERCENT, THREADS, evsOf, trace } from './measure.ts';
import { SPOTS } from './spots.ts';

const CASES: Record<string, { config: SpotConfig; browserMs: number }> = {
	flop: { config: SPOTS.flop.config, browserMs: 387 },
	monotone: { config: SPOTS.monotone.config, browserMs: 155 },
	wide: { config: SPOTS.wide.config, browserMs: 416 },
	'flop, IP pairs and broadway': { config: { ...COMPARE.flop, ip: 'TT-22,AQs-ATs,KQs-KTs,QJs-QTs,JTs,AQo-ATo,KQo' }, browserMs: 387 },
};

const out: Record<string, Trace[]> = {};
for (const [name, { config, browserMs }] of Object.entries(CASES)) {
	const spot = defineSpot(config);
	console.log(`\n== ${name}`);
	const reference = evsOf(spot, solve(spot, { targetPercent: REFERENCE_PERCENT, iterations: 3000, workers: THREADS }));
	const traces = [0, 10].map((start) =>
		trace(
			`cold t=${start}`,
			spot,
			() => {
				// An unstepped run of the same spot seeds nothing; it only carries the count.
				const blank = createRun(spot, { workers: 1 });
				const run = createRun(spot, { workers: 1, warmStart: blank, warmIteration: start });
				blank.close();
				return run;
			},
			reference,
			config.pot,
		),
	);
	out[name] = traces;
	const budget = Math.floor(15_000 / browserMs);
	for (const t of traces) {
		const hit = (target: number): string => String(t.checkpoints.find((c) => c.exploitability <= target)?.iterations ?? '-');
		let at = t.checkpoints[0];
		for (const c of t.checkpoints) if (c.iterations <= budget) at = c;
		console.log(
			`${t.label}: to 1% / 0.5% / 0.3% in ${hit(1)} / ${hit(0.5)} / ${hit(0.3)} iterations; at ${at.iterations} (15 s browser) ` +
				`expl ${at.exploitability.toFixed(3)}%, MAE ${at.error[0].mae.toFixed(2)} / ${at.error[1].mae.toFixed(2)}, max ${at.error[0].max.toFixed(1)} / ${at.error[1].max.toFixed(1)}`,
		);
	}
}
writeFileSync(new URL('./results/control.json', import.meta.url), JSON.stringify(out, null, 1));
