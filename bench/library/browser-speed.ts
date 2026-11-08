/**
 * Browser iteration speed of the library spots, single-threaded, beside Node.
 *
 *   node --import tsx bench/library/browser-speed.ts
 *
 * The flop-library experiment (#30) turns its iteration counts into browser
 * seconds with these, so the 15 s budget can be applied without running every
 * solve in Chromium.
 */

import { createRun, defineSpot } from '../../src/index.ts';
import type { SpotConfig } from '../../src/index.ts';
import { runInBrowser } from '../../scripts/browser-harness.ts';
import { SPOTS } from './spots.ts';

const ITERATIONS = 10;

const MEASURE = `
function measure(createRun, defineSpot, config, iterations) {
	const run = createRun(defineSpot(config), { workers: 1 });
	run.step(2);
	const started = performance.now();
	run.step(iterations);
	const msPerIteration = (performance.now() - started) / iterations;
	const startedCheck = performance.now();
	run.exploitabilityPercent();
	const msPerCheck = performance.now() - startedCheck;
	run.close();
	return { msPerIteration, msPerCheck };
}
`;

interface Timing {
	msPerIteration: number;
	msPerCheck: number;
}

const configs: Record<string, SpotConfig> = {};
for (const [name, spot] of Object.entries(SPOTS)) configs[name] = spot.config;

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
	const CONFIGS = ${JSON.stringify(configs)};
	export default async function run() {
		const out = {};
		for (const [name, config] of Object.entries(CONFIGS)) out[name] = measure(createRun, defineSpot, config, ${ITERATIONS});
		return out;
	}
	`,
	1_800_000,
);

console.log('spot        node ms/iter  node ms/check  browser ms/iter  browser ms/check');
const out: Record<string, { node: Timing; browser: Timing }> = {};
for (const [name, config] of Object.entries(configs)) {
	const node = measure(createRun, defineSpot, config, ITERATIONS);
	out[name] = { node, browser: browser[name] };
	console.log(
		`${name.padEnd(10)}${node.msPerIteration.toFixed(0).padStart(14)}${node.msPerCheck.toFixed(0).padStart(15)}` +
			`${browser[name].msPerIteration.toFixed(0).padStart(17)}${browser[name].msPerCheck.toFixed(0).padStart(18)}`,
	);
}
console.log(JSON.stringify(out));
