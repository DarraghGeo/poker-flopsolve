/**
 * Browser benchmark.
 *
 * Purpose: time the browser build where it will run — a Web Worker in
 * Chromium — beside the same spots in Node, so a change is judged on both.
 *
 *   npm run bench:browser
 *   npm run bench:browser -- --iters 100
 *
 * Only the spots the browser is meant for: the river and turn spots of
 * `bin/bench.ts`, single-threaded. Needs Playwright's Chromium.
 */

import { createRun, defineSpot } from '../src/index.ts';
import type { SpotConfig } from '../src/index.ts';
import { runInBrowser } from '../scripts/browser-harness.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';

const SPOTS: Record<string, { config: SpotConfig; iterations: number }> = {
	river: {
		config: { board: 'AsKh7d2c9h', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.33, 0.75]], maxRaises: 2, allowAllIn: true },
		iterations: 200,
	},
	turn: {
		config: { board: 'AsKh7d2c', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.33, 0.75]], maxRaises: 2 },
		iterations: 20,
	},
};

const args = process.argv.slice(2);
const at = args.indexOf('--iters');
if (at >= 0) for (const spot of Object.values(SPOTS)) spot.iterations = Number(args[at + 1]);

interface Timing {
	msPerIteration: number;
	exploitability: number;
}

/** The same measurement in both places: warm up, then time a block. */
const MEASURE = `
function measure(createRun, defineSpot, config, iterations) {
	const run = createRun(defineSpot(config), { workers: 1 });
	run.step(Math.max(2, Math.ceil(iterations / 10)));
	const started = performance.now();
	run.step(iterations);
	const msPerIteration = (performance.now() - started) / iterations;
	const exploitability = run.exploitabilityPercent();
	run.close();
	return { msPerIteration, exploitability };
}
`;

const measure = new Function(`${MEASURE}; return measure;`)() as (
	create: typeof createRun,
	define: typeof defineSpot,
	config: SpotConfig,
	iterations: number,
) => Timing;

const browser = await runInBrowser<Record<string, Timing>>(
	`
	import { createRun, defineSpot } from './src/index.ts';
	${MEASURE}
	const SPOTS = ${JSON.stringify(SPOTS)};
	export default async function run() {
		const out = {};
		for (const [name, { config, iterations }] of Object.entries(SPOTS)) {
			out[name] = measure(createRun, defineSpot, config, iterations);
		}
		return out;
	}
	`,
	600_000,
);

console.log('spot     iters   node ms/iter   browser ms/iter   exploitability % (node / browser)');
for (const [name, { config, iterations }] of Object.entries(SPOTS)) {
	const node = measure(createRun, defineSpot, config, iterations);
	const there = browser[name];
	console.log(
		`${name.padEnd(8)}${String(iterations).padStart(6)}${node.msPerIteration.toFixed(1).padStart(15)}` +
			`${there.msPerIteration.toFixed(1).padStart(18)}     ${node.exploitability.toFixed(4)} / ${there.exploitability.toFixed(4)}`,
	);
}
