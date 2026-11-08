/**
 * Single-threaded costs for the EV experiment of issue #27, in Node and in
 * headless Chromium: one iteration, one average-profile EV pass (both
 * players) and one exploitability pass (best response for both).
 *
 *   node --import tsx bench/ev/timing.ts [--iters 6]
 */

import { createRun, defineSpot } from '../../src/index.ts';
import type { SpotConfig } from '../../src/index.ts';
import { runInBrowser } from '../../scripts/browser-harness.ts';
import { EV_SPOTS } from './spots.ts';

const at = process.argv.indexOf('--iters');
const iterations = at >= 0 ? Number(process.argv[at + 1]) : 6;

interface Timing {
	iterMs: number;
	evalMs: number;
	exploitMs: number;
}

const MEASURE = `
function measure(createRun, defineSpot, config, iterations) {
	const run = createRun(defineSpot(config), { workers: 1 });
	run.step(2);
	let started = performance.now();
	run.step(iterations);
	const iterMs = (performance.now() - started) / iterations;
	started = performance.now();
	for (let i = 0; i < 2; i++) run.snapshot().ev(0);
	const evalMs = (performance.now() - started) / 2;
	started = performance.now();
	for (let i = 0; i < 2; i++) run.snapshot().exploitability();
	const exploitMs = (performance.now() - started) / 2;
	run.close();
	return { iterMs, evalMs, exploitMs };
}
`;

const measure = new Function(`${MEASURE}; return measure;`)() as (
	create: typeof createRun,
	define: typeof defineSpot,
	config: SpotConfig,
	iterations: number,
) => Timing;

const node: Record<string, Timing> = {};
for (const [name, config] of Object.entries(EV_SPOTS)) node[name] = measure(createRun, defineSpot, config, iterations);

const browser = await runInBrowser<Record<string, Timing>>(
	`
	import { createRun, defineSpot } from './src/index.ts';
	${MEASURE}
	const SPOTS = ${JSON.stringify(EV_SPOTS)};
	export default async function run() {
		const out = {};
		for (const [name, config] of Object.entries(SPOTS)) out[name] = measure(createRun, defineSpot, config, ${iterations});
		return out;
	}
	`,
	1_800_000,
);

console.log('spot       node iter / ev / exploit ms      browser iter / ev / exploit ms    ratio');
for (const name of Object.keys(EV_SPOTS)) {
	const [n, b] = [node[name], browser[name]];
	const f = (t: Timing) => `${t.iterMs.toFixed(0).padStart(6)} ${t.evalMs.toFixed(0).padStart(6)} ${t.exploitMs.toFixed(0).padStart(6)}`;
	console.log(`${name.padEnd(10)} ${f(n)}              ${f(b)}            ${(b.iterMs / n.iterMs).toFixed(2)}`);
}
