/**
 * Issue #84 in headless Chromium: issue #47's blueprint (flop betting kept,
 * one turn and river size, three runout buckets) solved to 0.3% of pot at
 * 32-bit, 16-bit and compact storage, on the WebAssembly engine with
 * `poker-flopsolve/wasm-storage`, on one thread and on four; then a turn
 * re-solved at the full betting in the same storage.
 *
 * Each storage runs in its own browser, so the tab's peak resident memory —
 * the renderer processes', sampled from /proc every 100 ms — is its own.
 *
 *   node --import tsx bench/nested/wasm-storage.ts <rainbow|monotone> <f32|i16|compact|compact-nosums|js-i16> [workers...]
 *   node --import tsx bench/nested/wasm-storage.ts flop <f32|i16|compact> [workers...]
 */

import { readdirSync, readFileSync } from 'node:fs';
import { runInBrowser } from '../../scripts/browser-harness.ts';
import type { SpotConfig } from '../../src/index.ts';
import { SPOTS as COMPARE } from '../compare/spots.ts';
import { blueprint, target, VARIANTS, type BoardName } from './spots.ts';

const [boardName, storageName, ...rest] = process.argv.slice(2) as [BoardName | 'flop', string, ...string[]];
const workerList = rest.length ? rest.map(Number) : [1, 4];

/** Each storage: how the spot and the solve are set. */
const STORAGES: Record<string, { spot: Partial<SpotConfig>; solve: Record<string, unknown>; wasm: boolean }> = {
	f32: { spot: {}, solve: {}, wasm: false },
	i16: { spot: {}, solve: { precision: 'i16' }, wasm: true },
	compact: { spot: { compactStorage: {} }, solve: {}, wasm: true },
	'compact-nosums': { spot: { compactStorage: { sums: false } }, solve: {}, wasm: true },
	// The JavaScript engine at 16 bits, as before this issue.
	'js-i16': { spot: {}, solve: { precision: 'i16' }, wasm: false },
};
const storage = STORAGES[storageName];
if (!storage) throw new Error(`unknown storage ${storageName}`);

const variant = VARIANTS['1size-b3'];
const isFlop = boardName === 'flop';
const full = isFlop ? null : target(boardName);
const config: SpotConfig = isFlop
	? { ...COMPARE.flop, ...storage.spot }
	: { ...blueprint(full!, variant.later), runoutBuckets: variant.buckets ?? false, maxBytes: 3.5 * 2 ** 30, ...storage.spot };
const later = full
	? { betSizes: full.betSizes, raiseSizes: full.raiseSizes, maxRaises: full.maxRaises, allowAllIn: full.allowAllIn }
	: null;
const turn = boardName === 'rainbow' ? '2c' : '2h';

/** Resident memory of Chromium's renderer processes, in bytes. */
function rendererRss(): number {
	let total = 0;
	for (const pid of readdirSync('/proc')) {
		if (!/^\d+$/.test(pid)) continue;
		try {
			const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
			if (!cmdline.includes('--type=renderer')) continue;
			const status = readFileSync(`/proc/${pid}/status`, 'utf8');
			const kb = /VmRSS:\s+(\d+)/.exec(status);
			if (kb) total += Number(kb[1]) * 1024;
		} catch {
			// The process ended between listing and reading.
		}
	}
	return total;
}

interface Out {
	threads: number;
	solves: { workers: number; ms: number; iterations: number; exploitability: number; engine: string; checkMs: number }[];
	resolves: { workers: number; ms: number; bytes: number }[];
	storageBytes: number;
}

let peak = 0;
const sampler = setInterval(() => (peak = Math.max(peak, rendererRss())), 100);
const out = await runInBrowser<Out>(
	`
	import { createRun, defineSpot, NodeKind, parseCards } from './src/index.ts';
	import { resolveSubgame } from './src/resolve.ts';
	import { enableThreads } from './src/threads.ts';
	import { wasmStorage } from './src/wasm-storage.ts';
	const CONFIG = ${JSON.stringify(config)};
	const SOLVE = ${JSON.stringify(storage.solve)};
	const WASM = ${JSON.stringify(storage.wasm)};
	const LATER = ${JSON.stringify(later)};
	export default async function run() {
		const threads = await enableThreads(${Math.max(...workerList)});
		const out = { threads, solves: [], resolves: [], storageBytes: 0 };
		const options = { ...SOLVE, ...(WASM ? { wasmStorage } : {}) };
		let last = null;
		for (const workers of ${JSON.stringify(workerList)}) {
			if (workers > threads) continue;
			if (last) last.close();
			const spot = defineSpot(CONFIG);
			out.storageBytes = spot.estimate.compactBytes ?? (SOLVE.precision === 'i16' ? spot.estimate.compressedBytes : spot.estimate.bytes);
			const started = performance.now();
			const run = createRun(spot, { workers, ...options });
			let done = 0;
			let expl = Infinity;
			let checkMs = 0;
			// Checks at 20, 40, 80, then every 40 iterations, as bench/nested/browser.ts.
			let next = 20;
			while (done < 3000) {
				run.step(next - done);
				done = next;
				const checking = performance.now();
				expl = run.exploitabilityPercent();
				checkMs += performance.now() - checking;
				if (expl <= 0.3) break;
				next = done < 80 ? done * 2 : done + 40;
			}
			out.solves.push({ workers, ms: performance.now() - started, iterations: done, exploitability: expl, engine: run.engine, checkMs });
			last = run;
		}
		if (!last || !LATER) {
			last?.close();
			return out;
		}
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
		for (const workers of [...new Set([1, Math.min(4, threads)])]) {
			const started = performance.now();
			const r = resolveSubgame(sol, node, board, { player: 0, betting: LATER, iterations: 300, solve: { workers, ...options } });
			const e = r.solution.spot.estimate;
			out.resolves.push({
				workers, ms: performance.now() - started,
				bytes: e.compactBytes ?? (SOLVE.precision === 'i16' ? e.compressedBytes : e.bytes),
			});
		}
		return out;
	}
	`,
	14_400_000,
	{ isolated: true },
);
clearInterval(sampler);

const mib = (bytes: number): string => `${(bytes / 2 ** 20).toFixed(0)} MiB`;
console.log(`${boardName} ${storageName} in Chromium (${out.threads} threads), storage ${mib(out.storageBytes)}, tab peak RSS ${mib(peak)}`);
for (const s of out.solves) {
	console.log(
		`  ${s.workers} thread(s), ${s.engine}: ${(s.ms / 1000).toFixed(1)} s to ${s.exploitability.toFixed(3)}% ` +
			`in ${s.iterations} it (${(s.ms / 1000 / s.iterations).toFixed(3)} s/it with checks; checks ${(s.checkMs / 1000).toFixed(1)} s)`,
	);
}
for (const r of out.resolves) console.log(`  turn re-solve, ${r.workers} thread(s): ${(r.ms / 1000).toFixed(1)} s, ${mib(r.bytes)}`);
console.log(JSON.stringify({ board: boardName, storage: storageName, peak, ...out }));
