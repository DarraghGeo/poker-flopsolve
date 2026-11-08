/**
 * WebGPU river-kernel benchmark (#39).
 *
 * Purpose: decide whether the river's showdown and regret matching are worth
 * moving to the GPU, before any integration. In a Web Worker in Chromium, on
 * each flop spot of the #29 baseline, it times
 *
 * - the WebAssembly engine's river kernels (`assembly/river.ts`, the engine's
 *   own code looped over every river board), on data already in memory;
 * - the WebGPU kernels (`src/gpu/river.ts`) on the same data: round trip
 *   (reach or regrets uploaded, one dispatch, values read back) and GPU alone
 *   (dispatches back to back, no transfer);
 * - a real single-threaded solve iteration, in the same worker;
 *
 * and projects a solve iteration with those kernels on the GPU, both one
 * round trip per tree node over all river boards (what a synchronous solver
 * could do) and with every node's work batched into one round trip per
 * traversal (the best an async restructure could do). Integration is worth it
 * only if the projection clearly beats the 4-thread browser baseline: about
 * 2.85x on the single thread (#29, #36).
 *
 *   npm run bench:gpu                        # GPU through Chromium's flags
 *   npm run bench:gpu -- --channel chrome    # an installed Google Chrome
 *   npm run bench:gpu -- --headed            # a visible window, if headless has no adapter
 *   npm run bench:gpu -- --swiftshader       # CPU emulation: checks it runs, times mean nothing
 *   npm run bench:gpu -- --spots flop --iters 10 --browser-arg --use-vulkan
 *
 * Needs Playwright's Chromium (or `--channel`) and a WebGPU adapter.
 */

import type { SpotConfig } from '../src/index.ts';
import { SPOTS as COMPARE } from '../bench/compare/spots.ts';
import { runInBrowser } from '../scripts/browser-harness.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';

/** The #29 spots, with their measured time to 0.3% of pot on 1 and 4 browser threads. */
const ALL: Record<string, { config: SpotConfig; seconds: [number, number] }> = {
	flop: { config: COMPARE.flop, seconds: [24.2, 8.3] },
	monotone: { config: COMPARE.monotone, seconds: [8.3, 2.9] },
	wide: { config: { board: 'AsKh7d', pot: 60, stack: 120, oop: OOP, ip: IP, betSizes: [[0.66]], maxRaises: 1 }, seconds: [14.2, 5.1] },
};

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 ? args[at + 1] : undefined;
};
const spotNames = (option('spots') ?? Object.keys(ALL).join(',')).split(',');
for (const name of spotNames) if (!ALL[name]) throw new Error(`unknown spot ${name}; known: ${Object.keys(ALL).join(', ')}`);
const iterations = Number(option('iters') ?? 8);
const flags = ['--enable-unsafe-webgpu', '--enable-features=Vulkan'];
if (args.includes('--swiftshader')) flags.push('--use-angle=swiftshader');
args.forEach((arg, i) => {
	if (arg === '--browser-arg') flags.push(args[i + 1]);
});
const launch: Record<string, unknown> = { args: flags, headless: !args.includes('--headed') };
if (option('channel')) launch.channel = option('channel');

/** One spot's timings, in milliseconds. */
interface SpotTiming {
	boards: number;
	meanHands: number;
	showdownNodes: number;
	decisionNodes: number;
	solveIteration: number;
	cpu: { showdown: number; regret: number[] };
	gpu: { showdown: number; showdownKernel: number; regret: number[]; regretKernel: number[] };
}

const source = `
import { createRun, defineSpot } from './src/index.ts';
import { createRiverGpu, requestGpu } from './src/gpu/river.ts';
import { createRiverCpu } from './src/gpu/twin.ts';
import { makeBlocks, makeReach, riverFixture } from './bench/gpu/fixture.ts';

const SPOTS = ${JSON.stringify(Object.fromEntries(spotNames.map((name) => [name, ALL[name].config])))};
const ITERATIONS = ${iterations};

/** Mean milliseconds per call: repeat until a quarter second has passed, after a warm-up. */
async function perCall(call) {
	for (let i = 0; i < 3; i++) await call();
	let calls = 0;
	const started = performance.now();
	while (performance.now() - started < 250 || calls < 5) {
		await call();
		calls++;
	}
	return (performance.now() - started) / calls;
}

export default async function run() {
	const found = await requestGpu();
	if (!found) return { adapter: null, spots: {} };
	const out = {};
	for (const [name, config] of Object.entries(SPOTS)) {
		const fixture = riverFixture(config);
		const { lists, decisions } = fixture;

		// A real solve iteration, single-threaded on the WebAssembly engine.
		const solve = createRun(defineSpot(config), { workers: 1 });
		solve.step(2);
		let started = performance.now();
		solve.step(ITERATIONS);
		const solveIteration = (performance.now() - started) / ITERATIONS;
		solve.close();

		// The kernels on both sides: showdown for each traverser, regret
		// matching for each river decision node's blocks over every board.
		const batches = decisions.map((d, k) => makeBlocks(lists, d.player, d.actions, 100 + k));
		const widest = Math.max(1, ...batches.map((b) => b.regret.length));
		const cpu = createRiverCpu(lists, widest, lists.boards);
		const kernels = await createRiverGpu(found.device, lists);
		const reaches = [makeReach(lists, 1), makeReach(lists, 2)];

		const timing = { cpu: { showdown: 0, regret: [] }, gpu: { showdown: 0, showdownKernel: 0, regret: [], regretKernel: [] } };
		for (const me of [0, 1]) {
			cpu.reach.set(reaches[me]);
			timing.cpu.showdown += (await perCall(() => cpu.showdown(me, fixture.scale))) / 2;
			timing.gpu.showdown += (await perCall(() => kernels.showdown(me, reaches[me], fixture.scale))) / 2;
			timing.gpu.showdownKernel += (await kernels.showdownKernelMs(50)) / 2;
		}
		for (const { blocks, regret } of batches) {
			cpu.regret.set(regret);
			cpu.setBlocks(blocks);
			timing.cpu.regret.push(await perCall(() => cpu.regretMatch()));
			timing.gpu.regret.push(await perCall(() => kernels.regretMatch(regret, blocks)));
			timing.gpu.regretKernel.push(await kernels.regretKernelMs(50));
		}
		kernels.destroy();

		let hands = 0;
		for (let k = 0; k < lists.boards * 2; k++) hands += lists.count[k];
		out[name] = {
			boards: lists.boards,
			meanHands: hands / (lists.boards * 2),
			showdownNodes: fixture.showdownNodes,
			decisionNodes: decisions.length,
			solveIteration,
			...timing,
		};
	}
	found.device.destroy();
	return { adapter: found.info, spots: out };
}
`;

const result = await runInBrowser<{ adapter: { vendor: string; architecture: string; description: string } | null; spots: Record<string, SpotTiming> }>(
	source,
	1_800_000,
	{ launch },
);
if (!result.adapter) {
	console.error('Chromium offers no WebGPU adapter. Try --headed, --channel chrome, or --browser-arg flags for your GPU.');
	process.exit(1);
}
const { vendor, architecture, description } = result.adapter;
console.log(`Adapter: ${[vendor, architecture, description].filter(Boolean).join(' / ')}`);
if (/swiftshader/i.test(`${vendor} ${architecture} ${description}`)) {
	console.log('SwiftShader is a CPU emulation of a GPU: these timings say nothing about a real one.');
}

const ms = (value: number): string => (value >= 100 ? value.toFixed(0) : value >= 1 ? value.toFixed(2) : value.toFixed(3));
const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

console.log('\n## Kernels, per tree node over every river board (ms)\n');
console.log('| spot | boards | hands/list | showdown: WASM | GPU round trip | GPU alone | regret match: WASM | GPU round trip | GPU alone |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const [name, t] of Object.entries(result.spots)) {
	const n = Math.max(1, t.decisionNodes);
	console.log(
		`| ${name} | ${t.boards} | ${t.meanHands.toFixed(0)} | ${ms(t.cpu.showdown)} | ${ms(t.gpu.showdown)} | ${ms(t.gpu.showdownKernel)} | ` +
			`${ms(sum(t.cpu.regret) / n)} | ${ms(sum(t.gpu.regret) / n)} | ${ms(sum(t.gpu.regretKernel) / n)} |`,
	);
}

console.log('\n## Projected solve iteration (ms) and time to 0.3% of pot (s)\n');
console.log(
	'Two traversals per iteration; each runs every river showdown node and regret-matches every river decision node on every river board. ' +
		'"Per node" keeps one GPU round trip per tree node, as a synchronous solver must; "batched" assumes every node of a traversal shares ' +
		'one round trip, the best an async restructure could reach. Both assume the rest of the iteration is unchanged and nothing else moves ' +
		'between CPU and GPU, so they are upper bounds on the gain.\n',
);
console.log('| spot | iteration: measured | in these kernels | GPU per node | GPU batched | 1 thread (#29) | 4 threads (#29) | GPU per node | GPU batched | verdict |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const [name, t] of Object.entries(result.spots)) {
	const share = 2 * (t.showdownNodes * t.cpu.showdown + sum(t.cpu.regret));
	const perNode = 2 * (t.showdownNodes * t.gpu.showdown + sum(t.gpu.regret));
	const transfer = Math.max(0, t.gpu.showdown - t.gpu.showdownKernel);
	const batched = 2 * (t.showdownNodes * t.gpu.showdownKernel + sum(t.gpu.regretKernel) + transfer);
	const rest = Math.max(0, t.solveIteration - share);
	const [one, four] = ALL[name].seconds;
	const project = (gpu: number): number => (one * (rest + gpu)) / t.solveIteration;
	const best = project(batched);
	const verdict = best < four * 0.8 ? 'beats 4 threads' : best < four ? 'marginal' : 'loses to 4 threads';
	console.log(
		`| ${name} | ${ms(t.solveIteration)} | ${ms(share)} (${((100 * share) / t.solveIteration).toFixed(0)}%) | ${ms(rest + perNode)} | ${ms(rest + batched)} | ` +
			`${one} | ${four} | ${project(perNode).toFixed(1)} | ${best.toFixed(1)} | ${verdict} |`,
	);
}
