/**
 * Wall time of the thinned trees in headless Chromium (issue #51): one thread,
 * and four with `poker-flopsolve/threads`, on a cross-origin isolated page.
 *
 *   node --import tsx bench/adaptive/browser.ts [iterations]
 *
 * Times a few iterations of each spot after two warm-up ones, and prints the
 * milliseconds per iteration. Multiplied by the iterations a solve to 0.3% of
 * pot takes in Node (`results/*.json`), that is the browser time to solve.
 */

import type { SpotConfig } from '../../src/index.ts';
import { runInBrowser } from '../../scripts/browser-harness.ts';
import { spotOn } from './spots.ts';
import { TREES } from './trees.ts';

const iterations = Number(process.argv[2] ?? 4);
const SPOTS: Record<string, SpotConfig> = {
	'rainbow T0 thinSizes': { ...spotOn('rainbow', TREES.T0), thinSizes: true },
	'monotone T0 thinSizes': { ...spotOn('monotone', TREES.T0), thinSizes: true },
	'monotone T thinSizes': { ...spotOn('monotone', TREES.T), thinSizes: true },
};

interface Timing {
	workers: number;
	msPerIteration: number;
	engine: string;
}

const out = await runInBrowser<{ threads: number; reason: string | null; spots: Record<string, Timing[]> }>(
	`
	import { createRun, defineSpot } from './src/index.ts';
	import { enableThreads, threadsUnavailable } from './src/threads.ts';
	const SPOTS = ${JSON.stringify(SPOTS)};
	export default async function run() {
		const reason = threadsUnavailable();
		const threads = await enableThreads(4);
		const spots = {};
		for (const [name, config] of Object.entries(SPOTS)) {
			spots[name] = [];
			for (const workers of [1, Math.min(4, threads)]) {
				const run = createRun(defineSpot(config), { workers });
				run.step(2);
				const started = performance.now();
				run.step(${iterations});
				spots[name].push({ workers, msPerIteration: (performance.now() - started) / ${iterations}, engine: run.engine ?? '' });
				run.close();
			}
		}
		return { threads, reason, spots };
	}
	`,
	7_200_000,
	{ isolated: true },
);
console.log(JSON.stringify(out, null, 1));
