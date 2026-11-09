/**
 * Issue #102 in headless Chromium: seconds per iteration and the tab's peak
 * memory of one combination of memory levers on one spot, with
 * `poker-flopsolve/threads`. Accuracy is measured in Node (`measure.ts`),
 * whose solves Chromium's match.
 *
 *   node --import tsx bench/combos/browser.ts <spot> <combination> [workers] [iterations] [sampling]
 *
 * Runs one iteration to warm up, then `iterations` (default 20) on the clock.
 * Memory is the renderer process's peak resident set (`VmHWM`), sampled from
 * /proc every 100 ms: the page, its WebAssembly memory and its worker threads
 * all live in that one process (as in `bench/blueprint-share/browser.ts`).
 * Linux only.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { runInBrowser } from '../../scripts/browser-harness.ts';
import { combination, SPOTS } from './spots.ts';

const [spotName, comboName, workerArg, iterArg, approxArg] = process.argv.slice(2);
const workers = Number(workerArg ?? 4);
const iterations = Number(iterArg ?? 20);
const sampling = approxArg === 'sampling';
const { config: levers, options } = combination(comboName);
const config = { ...SPOTS[spotName], ...levers, maxBytes: 3.5 * 2 ** 30 };
const storage = 'wasmStorage' in options;
const precision = options.precision ?? null;
const engineJs = options.engine === 'js';
const MiB = 2 ** 20;

function renderers(): Map<number, number> {
	const out = new Map<number, number>();
	for (const entry of readdirSync('/proc')) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
			if (!cmd.includes('--type=renderer')) continue;
			const hwm = /VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${entry}/status`, 'utf8'));
			if (hwm) out.set(Number(entry), Number(hwm[1]) * 1024);
		} catch {
			// Gone between listing and reading.
		}
	}
	return out;
}

const before = new Set(renderers().keys());
const peak = new Map<number, number>();
const sampler = setInterval(() => {
	for (const [pid, bytes] of renderers()) if (!before.has(pid)) peak.set(pid, Math.max(peak.get(pid) ?? 0, bytes));
}, 100);
const out = await runInBrowser<{ engine: string; workers: number; storageBytes: number; msPerIteration: number }>(
	`
	import { createRun, defineSpot } from './src/index.ts';
	import { enableThreads } from './src/threads.ts';
	import { wasmStorage } from './src/wasm-storage.ts';
	export default async function run() {
		await enableThreads(${workers});
		const spot = defineSpot(${JSON.stringify(config)});
		const run = createRun(spot, {
			workers: ${workers},
			${precision ? `precision: ${JSON.stringify(precision)},` : ''}
			${storage ? 'wasmStorage,' : ''}
			${engineJs ? "engine: 'js'," : ''}
			${sampling ? 'approximations: { chanceSampling: {} },' : ''}
		});
		run.step(1);
		const t = performance.now();
		run.step(${iterations});
		const msPerIteration = (performance.now() - t) / ${iterations};
		const out = { engine: run.engine, workers: run.workers, storageBytes: run.solver.ctx.layout.bytes, msPerIteration };
		run.close();
		return out;
	}
	`,
	10_800_000,
	{ isolated: true },
);
clearInterval(sampler);
const rss = Math.max(0, ...peak.values());
console.log(
	JSON.stringify({
		spot: spotName, combination: comboName, sampling, ...out,
		storageMiB: Math.round(out.storageBytes / MiB), rendererPeakMiB: Math.round(rss / MiB),
		secondsPerIteration: +(out.msPerIteration / 1000).toFixed(3),
	}),
);
