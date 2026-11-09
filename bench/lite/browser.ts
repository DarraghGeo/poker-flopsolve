/**
 * Issue #100 in headless Chromium: lite mode on issue #47's target betting,
 * timed to a settled root play, with the tab's peak memory and one turn
 * re-solve.
 *
 *   node --import tsx bench/lite/browser.ts <rainbow|two-tone|monotone> [variant,...] [workers,...] [cap]
 *
 * Variants as in `measure.ts` (`nosample`, `nodonk`, `flop2`, `raise`,
 * `p=<x>`). `RULE` (`every:tolerance:patience`, default `settle`'s 20:0.01:2)
 * is the stop; `RESOLVE_ITS` the re-solve's iterations (default 300).
 *
 * The page does what `solveLite` does, stepped so it can be timed: a run of
 * `liteConfig`'s blueprint, checked with `trackSettle` every `every`
 * iterations. The clock counts solving and the settle checks (a caller pays
 * for both); off the clock, at each check, it also scores the root play at
 * the unshared blueprint's per-action values (`measure.ts`'s reference), and
 * every 100 iterations the exploitability. After the stop it re-solves the
 * most-reached turn (check, check, 2c on rainbow) for out of position at
 * T's betting, timed.
 *
 * Memory is the renderer process's peak resident set (`VmHWM`), sampled from
 * /proc every 100 ms: page, WebAssembly memory and worker threads all live
 * in that one process. Linux only. Each run gets its own browser.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { runInBrowser } from '../../scripts/browser-harness.ts';
import type { Approximations, LiteOptions } from '../../src/index.ts';
import { full as fullTree, TURNS, type Board } from '../blueprint-share/spots.ts';

const [boardName, variantArg, workerArg, capArg] = process.argv.slice(2) as [Board, string?, string?, string?];
const variants = (variantArg ?? 'base').split(',').filter((v) => v !== 'base');
const workerList = (workerArg ?? '1,2,4').split(',').map(Number);
const CAP = Number(capArg ?? 1500);
const [EVERY, TOL, PATIENCE] = (process.env.RULE ?? '20:0.01:2').split(':').map(Number);
const RESOLVE_ITS = Number(process.env.RESOLVE_ITS ?? 300);
const MiB = 2 ** 20;

const lite: LiteOptions = {
	...(variants.includes('nodonk') ? { noDonk: true } : {}),
	...(variants.includes('flop2') ? { flopMaxRaises: 2 } : {}),
	...(variants.includes('raise') ? { laterRaise: true } : {}),
};
const pArg = variants.find((v) => v.startsWith('p='));
const approximations: Approximations = variants.includes('nosample') ? {} : { chanceSampling: pArg ? { p: Number(pArg.slice(2)) } : {} };
const full = { ...fullTree(boardName), maxBytes: 3.5 * 2 ** 30 };
const later = { betSizes: full.betSizes, raiseSizes: full.raiseSizes, maxRaises: full.maxRaises, allowAllIn: full.allowAllIn };
const reference = JSON.parse(
	readFileSync(new URL(`../../scratch/blueprint-share/${boardName}-none/root.json`, import.meta.url), 'utf8'),
) as { actions: { actions: string[]; evs: (number | null)[][]; reach: (number | null)[] }[] };
const refActions = reference.actions.map((a) => ({ actions: a.actions, evs: a.evs, reach: a.reach }));

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

interface Out {
	workers: number;
	engine: string;
	estimateBytes: number;
	stopped: string;
	iterations: number;
	ms: number;
	checks: { iterations: number; ms: number; movement: number; loss: number[]; exploitability: number | null }[];
	resolveMs: number;
	resolveWorkers: number;
}

const before = new Set(renderers().keys());
for (const workers of workerList) {
	const peak = new Map<number, number>();
	const sampler = setInterval(() => {
		for (const [pid, bytes] of renderers()) if (!before.has(pid)) peak.set(pid, Math.max(peak.get(pid) ?? 0, bytes));
	}, 100);
	const out = await runInBrowser<Out>(
		`
		import { createRun, defineSpot, liteConfig, parseCard, rootPlay, trackSettle } from './src/index.ts';
		import { resolveSubgame } from './src/resolve.ts';
		import { enableThreads } from './src/threads.ts';
		const FULL = ${JSON.stringify(full)};
		const LITE = ${JSON.stringify(lite)};
		const LATER = ${JSON.stringify(later)};
		const REF = ${JSON.stringify(refActions)};
		const TURN = ${JSON.stringify(TURNS[boardName][0])};
		function lossOf(play) {
			return play.views.map((view, d) => {
				const { evs, reach, actions } = REF[d];
				if (view.actions.join() !== actions.join()) throw new Error('root actions differ: ' + view.actions + ' vs ' + actions);
				let lost = 0, mass = 0;
				const n = view.actions.length;
				for (let i = 0; i < view.combos.length; i++) {
					const combo = view.combos[i];
					const w = reach[combo];
					if (!(w > 0) || evs[0][combo] === null) continue;
					let best = -Infinity, played = 0;
					for (let a = 0; a < n; a++) {
						best = Math.max(best, evs[a][combo]);
						played += view.probs[i * n + a] * evs[a][combo];
					}
					lost += w * (best - played);
					mass += w;
				}
				return lost / mass;
			});
		}
		export default async function run() {
			await enableThreads(${workers});
			const spot = defineSpot(liteConfig(FULL, LITE));
			const run = createRun(spot, { workers: ${workers}, approximations: ${JSON.stringify(approximations)} });
			const tracker = trackSettle({ every: ${EVERY}, tolerance: ${TOL}, patience: ${PATIENCE} });
			const checks = [];
			let ms = 0;
			let stopped = 'cap';
			let done = 0;
			while (done < ${CAP}) {
				const t = performance.now();
				run.step(${EVERY});
				done += ${EVERY};
				const sol = run.snapshot();
				const settled = tracker.check(sol, done);
				ms += performance.now() - t;
				const loss = lossOf(rootPlay(sol));
				const exploitability = done % 100 === 0 ? run.exploitabilityPercent() : null;
				checks.push({ iterations: done, ms, movement: tracker.movement, loss, exploitability });
				if (settled) { stopped = 'settled'; break; }
			}
			const bp = run.snapshot();
			// The most-reached turn: check, check, then the first sampled turn card.
			const tree = spot.tree;
			const chance = tree.edgeChild[tree.firstEdge[tree.edgeChild[tree.firstEdge[0]]]];
			const node = tree.edgeChild[tree.firstEdge[chance]];
			const cards = [...spot.board, parseCard(TURN)];
			const board = spot.resolveBoard(cards).board;
			const t = performance.now();
			const resolved = resolveSubgame(bp, node, board, {
				player: 0, iterations: ${RESOLVE_ITS}, betting: LATER, solve: { workers: ${workers} },
			});
			const resolveMs = performance.now() - t;
			const out = {
				workers: run.workers, engine: run.engine, estimateBytes: spot.estimate.bytes, stopped, iterations: done, ms, checks,
				resolveMs, resolveWorkers: resolved.solution.workers,
			};
			run.close();
			return out;
		}
		`,
		3_600_000,
		{ isolated: true },
	);
	clearInterval(sampler);
	const rss = Math.max(0, ...peak.values());
	const last = out.checks.at(-1)!;
	console.log(
		`${boardName} ${variants.join('+') || 'base'}, ${out.workers} thread(s), ${out.engine}: storage ${(out.estimateBytes / MiB).toFixed(0)} MiB, ` +
			`renderer peak RSS ${(rss / MiB).toFixed(0)} MiB, ${(out.ms / out.iterations).toFixed(0)} ms/iteration`,
	);
	console.log(
		`  ${out.stopped} at ${out.iterations} it, ${(out.ms / 1000).toFixed(1)} s; root loss ${last.loss.map((x) => x.toFixed(4)).join(' / ')}% of pot; ` +
			`turn re-solve ${RESOLVE_ITS} it on ${out.resolveWorkers} thread(s): ${(out.resolveMs / 1000).toFixed(1)} s`,
	);
	console.log(
		`  checks ${out.checks
			.map((c) => `${c.iterations}:${c.loss.map((x) => x.toFixed(3)).join('/')},${(100 * c.movement).toFixed(1)}${c.exploitability === null ? '' : `,${c.exploitability.toFixed(2)}%`}@${(c.ms / 1000).toFixed(0)}s`)
			.join(' ')}`,
	);
	console.log(JSON.stringify({ board: boardName, variants, rss, rule: [EVERY, TOL, PATIENCE], ...out }));
}
