/**
 * The benchmark page's solver, in a Web Worker.
 *
 * Purpose: estimate a spot's size as the form changes, and solve it while
 * timing every phase: starting threads, building the tree, allocating
 * storage, the iterations themselves and the exploitability measures, which
 * are timed apart so iterations per second count iterations only. The page
 * starts a fresh worker for each solve and ends it afterwards, so a solve's
 * memory and threads are gone before the next.
 *
 * Iterations run in chunks of about a fifth of a second with a yield between
 * them, so progress streams and a stop message lands.
 */

import { COMBO_CARDS, createRun, defineSpot, litePreset, simdAvailable, SpotTooLargeError, trackSettle } from '../src/index.ts';
import type { Estimate, Precision, SolveOptions, SpotConfig } from '../src/index.ts';
import { DEFAULT_MAX_BYTES } from '../src/platform/browser.ts';
import { settlePlan } from '../src/settle.ts';
import { enableThreads, threadsUnavailable } from '../src/threads.ts';
import { wasmStorage } from '../src/wasm-storage.ts';
import { checkGap } from './lib/bench.ts';
import type { Check } from './lib/bench.ts';
import { cellOfCards, CELLS } from './lib/hands.ts';
import { liteSummary } from './lib/lite.ts';
import type { Mode } from './lib/settings.ts';
import type { Inbound, Outbound, Report, SpotSummary } from './protocol.ts';

const scope = self as unknown as {
	postMessage(message: Outbound): void;
	onmessage: ((event: { data: Inbound }) => void) | null;
	navigator: { userAgent: string; hardwareConcurrency?: number; deviceMemory?: number };
	crossOriginIsolated?: boolean;
};

const post = (message: Outbound): void => scope.postMessage(message);

const TOO_BIG_FOR_SAMPLING = "Too big for the memory limit once Lite's card sampling is added. Try a higher limit, fewer bet sizes or narrower ranges.";

/** Solving time each chunk aims at, so progress streams and stop lands. */
const CHUNK_MS = 200;

let stopping = false;
let latestEstimate: Extract<Inbound, { type: 'estimate' }> | null = null;

const yieldToMessages = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The precision `createRun` picks by default, made explicit so the page can show it. */
const precisionFor = (estimate: Estimate, maxBytes: number): 'f32' | 'i16' => (estimate.bytes <= maxBytes ? 'f32' : 'i16');

function summarise(estimate: Estimate, maxBytes: number): SpotSummary {
	const precision = precisionFor(estimate, maxBytes);
	return {
		rounds: estimate.rounds,
		runouts: estimate.runouts,
		combos: [estimate.combos[0], estimate.combos[1]],
		decisionNodes: estimate.decisionNodes,
		bytes: estimate.bytes,
		compressedBytes: estimate.compressedBytes,
		maxBytes,
		precision,
		storageBytes: precision === 'i16' ? estimate.compressedBytes : estimate.bytes,
	};
}

/** The spot a mode solves, its solve options, and in Lite what it simplified. */
function prepare(config: SpotConfig, mode: Mode, workers: number): { config: SpotConfig; options: SolveOptions; lite: string[] | null } {
	if (mode === 'exact') return { config, options: { workers }, lite: null };
	const preset = litePreset(config, { workers });
	return { config: preset.config, options: preset.options, lite: liteSummary(config, preset.changes) };
}

function estimateSpot(id: number, config: SpotConfig, mode: Mode): void {
	const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
	try {
		const prepared = prepare(config, mode, 1);
		const spot = defineSpot(prepared.config);
		post({ type: 'estimate', id, ok: true, spot: summarise(spot.estimate, maxBytes), lite: prepared.lite });
	} catch (error) {
		if (error instanceof SpotTooLargeError) {
			post({
				type: 'estimate',
				id,
				ok: false,
				tooLarge: true,
				spot: summarise(error.estimate, maxBytes),
				message: 'This spot is too big for a browser tab.',
				suggestions: [...error.estimate.suggestions],
			});
		} else {
			post({ type: 'estimate', id, ok: false, tooLarge: false, message: (error as Error).message, suggestions: [] });
		}
	}
}

/**
 * Solve and time it. Exact measures exploitability as it goes and stops at
 * `target`; Lite reads how far its first decisions moved every `every`
 * iterations, as `solveLite` does, and stops once they settle. Either way the
 * readings go in `checks`, the measure in % (of the pot, or of the range).
 */
async function solveSpot(config: SpotConfig, mode: Mode, target: number, threadsWanted: number, cap: number): Promise<void> {
	const started = performance.now();
	const now = (): number => performance.now();

	post({ type: 'phase', phase: 'threads' });
	let t = now();
	const threads = await enableThreads(threadsWanted > 0 ? threadsWanted : undefined);
	const threadsMs = now() - t;

	post({ type: 'phase', phase: 'build' });
	await yieldToMessages();
	t = now();
	const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
	const prepared = prepare(config, mode, threads);
	const spot = defineSpot(prepared.config);
	const buildMs = now() - t;

	post({ type: 'phase', phase: 'alloc' });
	await yieldToMessages();
	t = now();
	const open = (at: Precision): ReturnType<typeof createRun> =>
		createRun(spot, { ...prepared.options, workers: threads, precision: at, ...(at === 'i16' ? { wasmStorage } : {}) });
	let precision: Precision = precisionFor(spot.estimate, maxBytes);
	let run: ReturnType<typeof createRun>;
	try {
		run = open(precision);
	} catch (error) {
		// Lite's sampling needs memory beside the tree, which the estimate does
		// not count: compress the tree to make room, or say plainly why not.
		if (!/over maxBytes/.test(String(error))) throw error;
		if (precision === 'i16') throw new Error(TOO_BIG_FOR_SAMPLING);
		precision = 'i16';
		try {
			run = open(precision);
		} catch (again) {
			throw /over maxBytes/.test(String(again)) ? new Error(TOO_BIG_FOR_SAMPLING) : again;
		}
	}
	const allocMs = now() - t;
	const storageBytes = precision === 'i16' ? spot.estimate.compressedBytes : spot.estimate.bytes;
	const used = { ...summarise(spot.estimate, maxBytes), precision, storageBytes };
	const settle = mode === 'lite' && prepared.options.settle ? settlePlan(prepared.options.settle) : null;
	const tracker = settle ? trackSettle(settle) : null;
	// Lite's stop, in % of the range, is the target its chart shows.
	const goal = settle ? settle.tolerance * 100 : target;

	post({
		type: 'phase',
		phase: 'solve',
		goal,
		setup: {
			threads: run.workers,
			engine: run.engine,
			precision,
			storageBytes,
			spot: used,
		},
	});

	const checks: Check[] = [];
	let solveMs = 0;
	let measureMs = 0;
	let nextCheck = settle ? settle.every : 1;
	let perIteration = 0;
	let stoppedBy: Report['stoppedBy'] = 'iterations';
	try {
		for (;;) {
			const room = Math.min(nextCheck, cap) - run.completed;
			const affordable = perIteration > 0 ? Math.max(1, Math.floor(CHUNK_MS / perIteration)) : 1;
			const count = Math.max(1, Math.min(room, affordable));
			t = now();
			run.step(count);
			const stepMs = now() - t;
			solveMs += stepMs;
			perIteration = stepMs / count;
			post({ type: 'progress', iterations: run.completed, solveMs, measureMs, wallMs: now() - started });

			if (tracker && settle) {
				if (run.completed >= nextCheck) {
					t = now();
					const settled = tracker.check(run.snapshot(), run.completed);
					measureMs += now() - t;
					if (Number.isFinite(tracker.movement)) {
						const check = { iterations: run.completed, exploitability: tracker.movement * 100, ms: solveMs };
						checks.push(check);
						post({ type: 'check', check });
					}
					if (settled) {
						stoppedBy = 'settled';
						break;
					}
					nextCheck = run.completed + settle.every;
				}
			} else if (run.completed >= nextCheck || run.completed >= cap) {
				t = now();
				const exploitability = run.exploitabilityPercent();
				measureMs += now() - t;
				const check = { iterations: run.completed, exploitability, ms: solveMs };
				checks.push(check);
				post({ type: 'check', check });
				if (exploitability <= target) {
					stoppedBy = 'target';
					break;
				}
				nextCheck = run.completed + checkGap(run.completed);
			}
			if (run.completed >= cap) break;
			await yieldToMessages();
			if (stopping) {
				stoppedBy = 'stopped';
				// Measure where it stopped, so the report's figure matches its iterations.
				if (!tracker && checks[checks.length - 1]?.iterations !== run.completed) {
					t = now();
					const check = { iterations: run.completed, exploitability: run.exploitabilityPercent(), ms: solveMs };
					measureMs += now() - t;
					checks.push(check);
					post({ type: 'check', check });
				}
				break;
			}
		}

		post({ type: 'phase', phase: 'finish' });
		await yieldToMessages();
		t = now();
		const solution = run.snapshot();
		const ev: [number, number] = [solution.ev(0), solution.ev(1)];
		const root = rootStrategy(solution);
		const finishMs = now() - t;

		const g = scope;
		const report: Report = {
			config,
			mode,
			target: goal,
			lite: prepared.lite,
			stoppedBy,
			iterations: run.completed,
			exploitability: checks.length > 0 ? checks[checks.length - 1].exploitability : null,
			checks,
			ms: {
				threads: threadsMs,
				build: buildMs,
				alloc: allocMs,
				solve: solveMs,
				measure: measureMs,
				finish: finishMs,
				total: now() - started,
			},
			setup: {
				threads: run.workers,
				threadsAsked: threadsWanted,
				engine: run.engine,
				precision,
				storageBytes,
				spot: used,
			},
			environment: {
				userAgent: g.navigator.userAgent,
				cores: g.navigator.hardwareConcurrency ?? 1,
				deviceMemory: g.navigator.deviceMemory ?? null,
				crossOriginIsolated: g.crossOriginIsolated === true,
				threadsUnavailable: threadsUnavailable(),
				simd: simdAvailable(),
			},
			ev,
			root,
		};
		post({ type: 'done', report });
	} finally {
		run.close();
	}
}

/**
 * Out of position's first decision: each action's frequency over the whole
 * range, and per grid cell, weighted by how much of each hand is held.
 */
function rootStrategy(solution: ReturnType<ReturnType<typeof createRun>['snapshot']>): Report['root'] {
	const view = solution.strategyAt(0, 0);
	const reach = solution.reachAt(0, 0, view.player);
	const actions = view.actions.length;
	const total = new Float64Array(actions);
	const cellMix = new Float64Array(CELLS * actions);
	const cellWeight = new Float64Array(CELLS);
	let mass = 0;
	for (let i = 0; i < view.combos.length; i++) {
		const combo = view.combos[i];
		const weight = reach[combo];
		if (!(weight > 0)) continue;
		const cell = cellOfCards(COMBO_CARDS[combo * 2], COMBO_CARDS[combo * 2 + 1]);
		mass += weight;
		cellWeight[cell] += weight;
		for (let a = 0; a < actions; a++) {
			const p = view.probs[i * actions + a] * weight;
			total[a] += p;
			cellMix[cell * actions + a] += p;
		}
	}
	const cells: (number[] | null)[] = [];
	for (let cell = 0; cell < CELLS; cell++) {
		const w = cellWeight[cell];
		cells.push(w > 0 ? Array.from({ length: actions }, (_, a) => cellMix[cell * actions + a] / w) : null);
	}
	return {
		player: view.player,
		actions: [...view.actions],
		frequencies: Array.from(total, (p) => (mass > 0 ? p / mass : 0)),
		cells,
	};
}

scope.onmessage = ({ data }) => {
	if (data.type === 'stop') {
		stopping = true;
		return;
	}
	if (data.type === 'estimate') {
		// Messages that queued while an estimate was building run before this
		// timeout, so only the newest is built; the page ignores older replies.
		const first = latestEstimate === null;
		latestEstimate = data;
		if (first) {
			setTimeout(() => {
				const request = latestEstimate!;
				latestEstimate = null;
				estimateSpot(request.id, request.config, request.mode);
			}, 0);
		}
		return;
	}
	stopping = false;
	solveSpot(data.config, data.mode, data.target, data.threads, data.cap).catch((error: unknown) =>
		post({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
	);
};
