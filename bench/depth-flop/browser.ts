/**
 * Wall time of a depth-limited flop solve in headless Chromium (issue #48),
 * in a Web Worker on a cross-origin isolated page, on 1 thread and on 4.
 *
 *   node --import tsx bench/depth-flop/browser.ts [T-rainbow] [--k 1,2,4] [--iterations 300]
 *
 * Prints, per thread count and k, seconds for the blueprint, the leaf tables
 * and the flop, and the depth-limited exploitability reached.
 */

import { runInBrowser } from '../../scripts/browser-harness.ts';
import { SPOTS } from './spots.ts';

const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 ? args[at + 1] : fallback;
};
const name = args.find((a) => !a.startsWith('--') && !/^[\d,.]+$/.test(a)) ?? 'T-rainbow';
const ks = option('k', '1,2,4').split(',').map(Number);
const iterations = Number(option('iterations', '300'));
const threadCounts = option('threads', '1,4').split(',').map(Number);

interface Timing {
	threads: number;
	k: number;
	blueprintS: number;
	tablesS: number;
	flopS: number;
	totalS: number;
	blueprintIterations: number;
	exploitability: number;
	heapMiB: number;
}

const results = await runInBrowser<Timing[]>(
	`
	import { createDepthLimitedRun } from './src/depth.ts';
	import { enableThreads } from './src/threads.ts';
	const SETS = { 1: ['blueprint'], 2: ['blueprint', 'raise'], 4: ['blueprint', 'fold', 'call', 'raise'] };
	export default async function run() {
		const out = [];
		for (const threads of ${JSON.stringify(threadCounts)}) {
			const workers = threads > 1 ? await enableThreads(threads) : 1;
			for (const k of ${JSON.stringify(ks)}) {
				const started = performance.now();
				const dl = createDepthLimitedRun(${JSON.stringify(SPOTS[name])}, {
					continuations: SETS[k], workers, blueprintTarget: 0.3, blueprintIterations: 400,
				});
				const built = performance.now();
				dl.step(${iterations});
				const done = performance.now();
				const memory = performance.memory ? performance.memory.usedJSHeapSize : 0;
				out.push({
					threads: workers, k,
					blueprintS: dl.report.blueprintMs / 1000,
					tablesS: dl.report.tablesMs / 1000,
					flopS: (done - built) / 1000,
					totalS: (done - started) / 1000,
					blueprintIterations: dl.report.blueprintIterations,
					exploitability: dl.exploitabilityPercent(),
					heapMiB: memory / 2 ** 20,
				});
				dl.close();
			}
		}
		return out;
	}
	`,
	3_600_000,
	{ isolated: true },
);

console.log(`${name} in headless Chromium, ${iterations} flop iterations`);
console.log('threads  k   blueprint s (it)   tables s   flop s   total s   DL exploitability');
for (const r of results) {
	console.log(
		`${String(r.threads).padStart(7)}  ${r.k}   ${r.blueprintS.toFixed(1).padStart(8)} (${r.blueprintIterations})   ` +
			`${r.tablesS.toFixed(1).padStart(8)}   ${r.flopS.toFixed(1).padStart(6)}   ${r.totalS.toFixed(1).padStart(7)}   ${r.exploitability.toFixed(3)}%`,
	);
}
