/**
 * Issue #85 in headless Chromium: issue #47's blueprint (`1size-b3`) with and
 * without `shareHistories`, on 1 and 4 threads (`poker-flopsolve/threads`):
 * when exploitability and the root play stop improving, seconds per
 * iteration, and the tab's peak memory.
 *
 *   node --import tsx bench/blueprint-share/browser.ts <board> <none|river|turn+river> [workers,...] [cap] [sampling]
 *
 * The clock counts solving only (`step`). Every 20 iterations, off the
 * clock, it measures exploitability and the root play: OOP at the root and
 * IP after a check, each as the EV its strategy loses at the reference's
 * per-action values (the unshared blueprint from `measure.ts <board> none`,
 * in `scratch/blueprint-share/<board>-none/root.json`), and how far it moved
 * since the last check (total variation, weighted by the reference's reach).
 * From those:
 *
 * - exploitability plateau: the first check from which it never falls more
 *   than 10% below its value there;
 * - root play still: the first check after which both decisions move less
 *   than 1% at every check;
 * - root loss settled: the first check from which both decisions' loss stays
 *   within 0.01% of pot of its value at the last check.
 *
 * Each solve runs in its own browser. Memory is the renderer process's peak
 * resident set (`VmHWM`), sampled from /proc every 100 ms while it runs: the
 * page, its WebAssembly memory and its worker threads all live in that one
 * process. Linux only.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { runInBrowser } from '../../scripts/browser-harness.ts';
import type { Approximations, SpotConfig } from '../../src/index.ts';
import { blueprintOf, type Board } from './spots.ts';

const [boardName, shareName, workerArg, capArg, approxArg] = process.argv.slice(2) as [Board, string, string?, string?, string?];
const workerList = (workerArg ?? '1,4').split(',').map(Number);
const CAP = Number(capArg ?? 600);
const EVERY = 20;
const approxNames = approxArg ? approxArg.split(',') : [];
const approximations: Approximations = approxNames.includes('sampling') ? { chanceSampling: {} } : {};
const config: SpotConfig = { ...blueprintOf(boardName, shareName), maxBytes: 3.5 * 2 ** 30 };
const reference = JSON.parse(
	readFileSync(new URL(`../../scratch/blueprint-share/${boardName}-none/root.json`, import.meta.url), 'utf8'),
) as { actions: { actions: string[]; evs: (number | null)[][]; reach: (number | null)[] }[] };
const refActions = reference.actions.map((a) => ({ actions: a.actions, evs: a.evs, reach: a.reach }));
const MiB = 2 ** 20;

/** Peak resident set of every Chromium renderer, by pid, in bytes. */
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

interface Check {
	iterations: number;
	solveMs: number;
	exploitability: number;
	/** Per root decision: EV lost at reference values, % of pot. */
	loss: number[];
	/** Per root decision: total variation from the previous check. */
	change: number[];
}
interface Out {
	workers: number;
	engine: string;
	estimateBytes: number;
	checks: Check[];
}

const before = new Set(renderers().keys());
for (const workers of workerList) {
	const peak = new Map<number, number>();
	const sampler = setInterval(() => {
		for (const [pid, bytes] of renderers()) if (!before.has(pid)) peak.set(pid, Math.max(peak.get(pid) ?? 0, bytes));
	}, 100);
	const out = await runInBrowser<Out>(
		`
		import { createRun, defineSpot } from './src/index.ts';
		import { enableThreads } from './src/threads.ts';
		const CONFIG = ${JSON.stringify(config)};
		const REF = ${JSON.stringify(refActions)};
		export default async function run() {
			await enableThreads(${workers});
			const spot = defineSpot(CONFIG);
			const tree = spot.tree;
			const nodes = [0, tree.edgeChild[tree.firstEdge[0]]];
			const run = createRun(spot, { workers: ${workers}, approximations: ${JSON.stringify(approximations)} });
			const checks = [];
			let solveMs = 0;
			let previous = null;
			for (let done = 0; done < ${CAP}; ) {
				const t = performance.now();
				run.step(${EVERY});
				solveMs += performance.now() - t;
				done += ${EVERY};
				const exploitability = run.exploitabilityPercent();
				const sol = run.snapshot();
				const probs = nodes.map((node, d) => {
					const view = sol.strategyAt(node, 0);
					if (view.actions.join() !== REF[d].actions.join()) throw new Error('root actions differ: ' + view.actions + ' vs ' + REF[d].actions);
					const byCombo = new Map();
					for (let i = 0; i < view.combos.length; i++) {
						byCombo.set(view.combos[i], Array.from(view.probs.subarray(i * view.actions.length, (i + 1) * view.actions.length)));
					}
					return byCombo;
				});
				const loss = [];
				const change = [];
				for (let d = 0; d < 2; d++) {
					const { evs, reach } = REF[d];
					let lost = 0, moved = 0, mass = 0;
					for (const [combo, p] of probs[d]) {
						const w = reach[combo];
						if (!(w > 0) || evs[0][combo] === null) continue;
						let best = -Infinity, played = 0;
						for (let a = 0; a < p.length; a++) {
							best = Math.max(best, evs[a][combo]);
							played += p[a] * evs[a][combo];
						}
						lost += w * (best - played);
						if (previous) {
							const q = previous[d].get(combo);
							let tv = 0;
							for (let a = 0; a < p.length; a++) tv += Math.abs(p[a] - q[a]);
							moved += (w * tv) / 2;
						}
						mass += w;
					}
					loss.push(lost / mass);
					change.push(previous ? moved / mass : 1);
				}
				previous = probs;
				checks.push({ iterations: done, solveMs, exploitability, loss, change });
			}
			const out = { workers: run.workers, engine: run.engine, estimateBytes: spot.estimate.bytes, checks };
			run.close();
			return out;
		}
		`,
		10_800_000,
		{ isolated: true },
	);
	clearInterval(sampler);
	const rss = Math.max(0, ...peak.values());
	const { checks } = out;
	const last = checks.at(-1)!;
	const at = (i: number): string =>
		i < 0 ? 'never' : `${checks[i].iterations} it, ${(checks[i].solveMs / 1000).toFixed(1)} s`;
	const plateau = checks.findIndex((c, i) => checks.slice(i).every((d) => d.exploitability >= 0.9 * c.exploitability));
	const still = checks.findIndex((_, i) => checks.slice(i + 1).every((d) => d.change.every((x) => x < 0.01)));
	const settled = checks.findIndex((_, i) =>
		checks.slice(i).every((d) => d.loss.every((x, k) => Math.abs(x - last.loss[k]) <= 0.01)),
	);
	const target = checks.findIndex((c) => c.exploitability <= 0.3);
	console.log(
		`${boardName} ${shareName}${approxNames.length ? ` +${approxNames.join('+')}` : ''}, ${out.workers} thread(s), ${out.engine}: ` +
			`storage ${(out.estimateBytes / MiB).toFixed(0)} MiB, renderer peak RSS ${(rss / MiB).toFixed(0)} MiB, ` +
			`${(last.solveMs / last.iterations).toFixed(0)} ms/iteration`,
	);
	console.log(
		`  exploitability plateau at ${at(plateau)} (${checks[Math.max(plateau, 0)].exploitability.toFixed(3)}%); ` +
			`0.3% at ${at(target)}; root play still (<1% moved) at ${at(still)}; root loss settled (±0.01%) at ${at(settled)}; ` +
			`final ${last.exploitability.toFixed(3)}%, root loss ${last.loss.map((x) => x.toFixed(4)).join(' / ')}% at ${last.iterations} it`,
	);
	console.log(
		`  checks ${checks
			.map((c) => `${c.iterations}:${c.exploitability.toFixed(2)}%,${c.loss.map((x) => x.toFixed(3)).join('/')},${c.change.map((x) => (100 * x).toFixed(1)).join('/')}@${(c.solveMs / 1000).toFixed(0)}s`)
			.join(' ')}`,
	);
	console.log(JSON.stringify({ board: boardName, share: shareName, approx: approxNames, rss, ...out }));
}
