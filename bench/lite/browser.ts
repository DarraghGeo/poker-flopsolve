/**
 * Issue #100 in headless Chromium: lite mode on issue #47's target betting,
 * timed to a settled root play, with the tab's peak memory and one turn
 * re-solve.
 *
 *   node --import tsx bench/lite/browser.ts <rainbow|two-tone|monotone> [variant,...] [workers,...] [cap]
 *
 * Variants as in `measure.ts` (`nosample`, `nodonk`, `flop2`, `raise`,
 * `p=<x>`, `keep=<MiB>`, `i16`; the pick is on the clock, as `solveLite`
 * pays for it, and closed before the hybrid starts). `RULE` (`every:tolerance:patience`, default `settle`'s 20:0.01:2)
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
const keepArg = variants.find((v) => v.startsWith('keep='));
const KEEP_BYTES = keepArg ? Number(keepArg.slice(5)) * MiB : 0;
const I16 = variants.includes('i16');
const PICK = Number(process.env.PICK ?? 80);
// GC=1 (a diagnostic) collects garbage after the pick, which no caller can do:
// how much of the peak the picking solve's memory holds until it is collected.
const GC = process.env.GC === '1';
const approximations: Approximations = variants.includes('nosample') ? {} : { chanceSampling: pArg ? { p: Number(pArg.slice(2)) } : {} };
const full = { ...fullTree(boardName), maxBytes: 3.5 * 2 ** 30 };
// T's betting; the blueprint forbids donk bets, T does not.
const later = { betSizes: full.betSizes, raiseSizes: full.raiseSizes, maxRaises: full.maxRaises, allowAllIn: full.allowAllIn, noDonk: false };
const reference = JSON.parse(
	readFileSync(new URL(`../../scratch/blueprint-share/${boardName}-none/root.json`, import.meta.url), 'utf8'),
) as { actions: { actions: string[]; evs: (number | null)[][]; reach: (number | null)[] }[] };
const refActions = reference.actions.map((a) => ({ actions: a.actions, evs: a.evs, reach: a.reach }));

/** Peak (`VmHWM`) or current (`VmRSS`) resident set of every Chromium renderer, by pid, in bytes. */
function renderers(field = 'VmHWM'): Map<number, number> {
	const out = new Map<number, number>();
	for (const entry of readdirSync('/proc')) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
			if (!cmd.includes('--type=renderer')) continue;
			const hwm = new RegExp(`${field}:\\s+(\\d+) kB`).exec(readFileSync(`/proc/${entry}/status`, 'utf8'));
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
	kept: string[];
	pickMs: number;
	storageAt: number;
	/** `Date.now()` as the blueprint run and the re-solve start, and as the page ends. */
	phases: { blueprint: number; resolve: number; end: number };
}

const before = new Set(renderers().keys());
for (const workers of workerList) {
	const peak = new Map<number, number>();
	// The renderers' summed current RSS over time, to split the peak by phase.
	const timeline: [number, number][] = [];
	const sampler = setInterval(() => {
		for (const [pid, bytes] of renderers()) if (!before.has(pid)) peak.set(pid, Math.max(peak.get(pid) ?? 0, bytes));
		let now = 0;
		for (const [pid, bytes] of renderers('VmRSS')) if (!before.has(pid)) now += bytes;
		timeline.push([Date.now(), now]);
	}, 100);
	const out = await runInBrowser<Out>(
		`
		import { createRun, defineSpot, keepWithin, liteConfig, parseCard, rootPlay, storageCost, trackSettle } from './src/index.ts';
		import { resolveSubgame } from './src/resolve.ts';
		import { enableThreads } from './src/threads.ts';
		import { wasmStorage } from './src/wasm-storage.ts';
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
			const storage = ${I16} ? { precision: 'i16', wasmStorage } : {};
			const options = { workers: ${workers}, approximations: ${JSON.stringify(approximations)}, ...storage };
			let config = liteConfig(FULL, LITE);
			let kept = [];
			let pickMs = 0;
			if (${KEEP_BYTES} > 0) {
				// What solveLite's keepBudget does.
				const t = performance.now();
				config = keepWithin(config, {
					...storage, workers: ${workers}, keepBudget: ${KEEP_BYTES}, pickIterations: ${PICK},
					sampling: options.approximations.chanceSampling ?? false,
				});
				kept = config.shareHistories.keepLines;
				pickMs = performance.now() - t;
				if (${GC}) globalThis.gc();
			}
			const spot = defineSpot(config);
			const phases = { blueprint: Date.now(), resolve: 0, end: 0 };
			const run = createRun(spot, options);
			const tracker = trackSettle({ every: ${EVERY}, tolerance: ${TOL}, patience: ${PATIENCE} });
			const checks = [];
			let ms = pickMs;
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
			// The run holds the engine threads until closed; its snapshot stays usable.
			const blueprint = { workers: run.workers, engine: run.engine };
			run.close();
			// The most-reached turn: check, check, then the first sampled turn card.
			const tree = spot.tree;
			const chance = tree.edgeChild[tree.firstEdge[tree.edgeChild[tree.firstEdge[0]]]];
			const node = tree.edgeChild[tree.firstEdge[chance]];
			const cards = [...spot.board, parseCard(TURN)];
			const board = spot.resolveBoard(cards).board;
			phases.resolve = Date.now();
			const t = performance.now();
			const resolved = resolveSubgame(bp, node, board, {
				player: 0, iterations: ${RESOLVE_ITS}, betting: LATER, solve: { workers: ${workers}, ...storage },
			});
			const resolveMs = performance.now() - t;
			phases.end = Date.now();
			const out = {
				...blueprint, estimateBytes: spot.estimate.bytes, stopped, iterations: done, ms, checks,
				resolveMs, resolveWorkers: resolved.solution.workers,
				kept, pickMs, storageAt: storageCost(spot, ${I16} ? 'i16' : 'f32'), phases,
			};
			return out;
		}
		`,
		3_600_000,
		{ isolated: true, ...(GC ? { launch: { args: ['--js-flags=--expose-gc'] } } : {}) },
	);
	clearInterval(sampler);
	const rss = Math.max(0, ...peak.values());
	const most = (from: number, to: number): number => Math.max(0, ...timeline.filter(([t]) => t >= from && t < to).map(([, b]) => b));
	const { phases } = out;
	const byPhase = {
		pick: most(0, phases.blueprint),
		blueprint: most(phases.blueprint, phases.resolve),
		resolve: most(phases.resolve, phases.end + 200),
	};
	const last = out.checks.at(-1)!;
	console.log(
		`${boardName} ${variants.join('+') || 'base'}, ${out.workers} thread(s), ${out.engine}: storage ${(out.storageAt / MiB).toFixed(0)} MiB${I16 ? ' i16' : ''}, ` +
			(out.kept.length ? `kept ${out.kept.length} line(s), picked in ${(out.pickMs / 1000).toFixed(1)} s, ` : '') +
			`renderer peak RSS ${(rss / MiB).toFixed(0)} MiB (pick ${(byPhase.pick / MiB).toFixed(0)}, blueprint ${(byPhase.blueprint / MiB).toFixed(0)}, ` +
			`re-solve ${(byPhase.resolve / MiB).toFixed(0)}), ${(out.ms / out.iterations).toFixed(0)} ms/iteration`,
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
	console.log(JSON.stringify({ board: boardName, variants, rss, byPhase, rule: [EVERY, TOL, PATIENCE], ...out }));
}
