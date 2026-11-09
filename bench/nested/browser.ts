/**
 * Issue #47 in headless Chromium: a blueprint solved to 0.3% of pot on one
 * thread and on four (`poker-flopsolve/threads`), then a turn subgame
 * re-solved at T's full betting with each gadget.
 *
 *   node --import tsx bench/nested/browser.ts <rainbow|monotone> <variant> [workers...]
 */

import { runInBrowser } from '../../scripts/browser-harness.ts';
import type { SpotConfig } from '../../src/index.ts';
import { blueprint, target, VARIANTS, type BoardName } from './spots.ts';


const [boardName, variantName, ...rest] = process.argv.slice(2) as [BoardName, string, ...string[]];
const variant = VARIANTS[variantName];
if (!variant) throw new Error(`unknown variant ${variantName}`);
const workerList = rest.length ? rest.map(Number) : [1, 4];
const full = target(boardName);
const config: SpotConfig = { ...blueprint(full, variant.later), runoutBuckets: variant.buckets ?? false, maxBytes: 3.5 * 2 ** 30 };
const later = { betSizes: full.betSizes, raiseSizes: full.raiseSizes, maxRaises: full.maxRaises, allowAllIn: full.allowAllIn };
const turn = boardName === 'rainbow' ? '2c' : '2h';

interface Out {
	threads: number;
	solves: { workers: number; ms: number; iterations: number; exploitability: number; engine: string; heap: number | null }[];
	resolves: { gadget: string; workers: number; ms: number; bytes: number }[];
}

const out = await runInBrowser<Out>(
	`
	import { createRun, defineSpot, solve, NodeKind, parseCards } from './src/index.ts';
	import { resolveSubgame } from './src/resolve.ts';
	import { enableThreads } from './src/threads.ts';
	const CONFIG = ${JSON.stringify(config)};
	const LATER = ${JSON.stringify(later)};
	export default async function run() {
		const threads = await enableThreads(4);
		const out = { threads, solves: [], resolves: [] };
		let last = null;
		for (const workers of ${JSON.stringify(workerList)}) {
			if (workers > threads) continue;
			const spot = defineSpot(CONFIG);
			const started = performance.now();
			const run = createRun(spot, { workers, precision: ${JSON.stringify(variant.precision ?? null)} ?? undefined });
			let done = 0;
			let expl = Infinity;
			// Checks at 20, 40, 80, then every 40 iterations, as solve() would roughly.
			let next = 20;
			while (done < 2000) {
				run.step(next - done);
				done = next;
				expl = run.exploitabilityPercent();
				if (expl <= 0.3) break;
				next = done < 80 ? done * 2 : done + 40;
			}
			const ms = performance.now() - started;
			const heap = performance.memory ? performance.memory.usedJSHeapSize : null;
			out.solves.push({ workers, ms, iterations: done, exploitability: expl, engine: run.engine, heap });
			if (last) last.close();
			last = run;
		}
		if (!last) throw new Error('no blueprint solved: every worker count asked for is above the ' + threads + ' threads available');
		// Snapshots outlive close(), which hands the engine threads back for the re-solves.
		const sol = last.snapshot();
		last.close();
		const tree = sol.spot.tree;
		let node = -1;
		for (let n = 0; n < tree.nodeCount; n++) {
			if (tree.kind[n] === NodeKind.Chance && tree.round[n] === 0 && sol.path(tree.edgeChild[tree.firstEdge[n]]) === 'check check /') {
				node = tree.edgeChild[tree.firstEdge[n]];
			}
		}
		const board = sol.spot.resolveBoard([...sol.spot.board, ...parseCards(${JSON.stringify(turn)})]).board;
		for (const gadget of ['unsafe', 'resolve', 'maxmargin', 'reach-maxmargin']) {
			for (const workers of [1, Math.min(4, threads)]) {
				const started = performance.now();
				const r = resolveSubgame(sol, node, board, { player: 0, gadget, betting: LATER, iterations: 300, solve: { workers } });
				out.resolves.push({ gadget, workers, ms: performance.now() - started, bytes: r.solution.spot.estimate.bytes });
			}
		}
		return out;
	}
	`,
	10_800_000,
	{ isolated: true },
);

console.log(`${boardName} ${variantName} in Chromium (${out.threads} threads available)`);
for (const s of out.solves) {
	console.log(
		`  blueprint, ${s.workers} thread(s), ${s.engine}: ${(s.ms / 1000).toFixed(1)} s, ${s.iterations} it, ` +
			`${s.exploitability.toFixed(3)}%` + (s.heap ? `, JS heap ${(s.heap / 2 ** 20).toFixed(0)} MiB` : ''),
	);
}
for (const r of out.resolves) {
	console.log(`  re-solve ${r.gadget.padEnd(15)} ${r.workers} thread(s): ${(r.ms / 1000).toFixed(1)} s, ${(r.bytes / 2 ** 20).toFixed(1)} MiB`);
}
console.log(JSON.stringify(out));
