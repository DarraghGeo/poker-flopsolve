/**
 * Reference solves for issue #24: each spot solved exactly to 0.1% of pot on
 * every core, its per-combination root EVs saved to
 * `scratch/coarse-to-fine/<spot>.json` for `run.ts` to measure against.
 *
 *   node --import tsx bench/coarse-to-fine/reference.ts [spot ...]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRun, defineSpot, solve } from '../../src/index.ts';
import { rangeEvs, rootEvs } from './measure.ts';
import { SPOTS } from './spots.ts';

const OUT = new URL('../../scratch/coarse-to-fine/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SPOTS);
for (const name of names) {
	const config = SPOTS[name];
	const started = performance.now();
	const solution = solve(defineSpot(config), { workers: 'auto', targetPercent: 0.1, iterations: 3000 });
	const seconds = (performance.now() - started) / 1000;
	if (solution.stoppedAt !== 'target') throw new Error(`${name} did not reach 0.1% of pot; not a reference`);
	// Per-combination values are read on one thread: copy the strategy over.
	const copy = createRun(defineSpot(config), { workers: 1, warmStart: solution });
	const evs = rootEvs(copy);
	const ranges = rangeEvs(evs, copy);
	const pot = config.pot;
	console.log(
		`${name}: ${solution.iterations} iterations, ${seconds.toFixed(1)} s, ` +
			`${solution.exploitabilityPercent().toFixed(4)}% of pot; range EV ` +
			`${ranges.map((v) => v.toFixed(4)).join(' / ')} vs ev() ` +
			`${[0, 1].map((p) => ((100 * solution.evChips(p as 0 | 1)) / pot).toFixed(4)).join(' / ')} (% of pot)`,
	);
	writeFileSync(
		new URL(`${name}.json`, OUT),
		JSON.stringify({ name, iterations: solution.iterations, exploitability: solution.exploitabilityPercent(), evs }),
	);
	copy.close();
}
