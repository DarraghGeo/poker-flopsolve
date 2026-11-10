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

import { COMBO_CARDS, createRun, defineSpot, simdAvailable, SpotTooLargeError } from '../src/index.ts';
import type { Estimate, Precision, SpotConfig } from '../src/index.ts';
import { enableThreads, threadsUnavailable } from '../src/threads.ts';
import { wasmStorage } from '../src/wasm-storage.ts';
import { checkGap } from './lib/bench.ts';
import type { Check } from './lib/bench.ts';
import { cellOfCards, CELLS } from './lib/hands.ts';
import type { Inbound, Outbound, Report, SpotSummary } from './protocol.ts';

const scope = self as unknown as {
	postMessage(message: Outbound): void;
	onmessage: ((event: { data: Inbound }) => void) | null;
	navigator: { userAgent: string; hardwareConcurrency?: number; deviceMemory?: number };
	crossOriginIsolated?: boolean;
};

const post = (message: Outbound): void => scope.postMessage(message);

/** Solving time each chunk aims at, so progress streams and stop lands. */
const CHUNK_MS = 200;

let stopping = false;

const yieldToMessages = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function summarise(estimate: Estimate): SpotSummary {
	return {
		rounds: estimate.rounds,
		runouts: estimate.runouts,
		combos: [estimate.combos[0], estimate.combos[1]],
		decisionNodes: estimate.decisionNodes,
		bytes: estimate.bytes,
		compressedBytes: estimate.compressedBytes,
	};
}

function estimateSpot(id: number, config: SpotConfig): void {
	try {
		const spot = defineSpot(config);
		post({ type: 'estimate', id, ok: true, spot: summarise(spot.estimate) });
	} catch (error) {
		if (error instanceof SpotTooLargeError) {
			post({
				type: 'estimate',
				id,
				ok: false,
				tooLarge: true,
				spot: summarise(error.estimate),
				message: 'This spot is too big for a browser tab.',
				suggestions: [...error.estimate.suggestions],
			});
		} else {
			post({ type: 'estimate', id, ok: false, tooLarge: false, message: (error as Error).message, suggestions: [] });
		}
	}
}

async function solveSpot(config: SpotConfig, target: number, threadsWanted: number, cap: number): Promise<void> {
	const started = performance.now();
	const now = (): number => performance.now();

	post({ type: 'phase', phase: 'threads' });
	let t = now();
	const threads = await enableThreads(threadsWanted > 0 ? threadsWanted : undefined);
	const threadsMs = now() - t;

	post({ type: 'phase', phase: 'build' });
	await yieldToMessages();
	t = now();
	const spot = defineSpot(config);
	const buildMs = now() - t;
	const maxBytes = 512 * 2 ** 20;
	const precision: Precision = spot.estimate.bytes <= maxBytes ? 'f32' : 'i16';

	post({ type: 'phase', phase: 'alloc' });
	await yieldToMessages();
	t = now();
	const run = createRun(spot, { workers: threads, precision, ...(precision === 'i16' ? { wasmStorage } : {}) });
	const allocMs = now() - t;
	const storageBytes = precision === 'i16' ? spot.estimate.compressedBytes : spot.estimate.bytes;

	post({
		type: 'phase',
		phase: 'solve',
		setup: {
			threads: run.workers,
			engine: run.engine,
			precision,
			storageBytes,
			spot: summarise(spot.estimate),
		},
	});

	const checks: Check[] = [];
	let solveMs = 0;
	let measureMs = 0;
	let nextCheck = 1;
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

			if (run.completed >= nextCheck || run.completed >= cap) {
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
			target,
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
				spot: summarise(spot.estimate),
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
		estimateSpot(data.id, data.config);
		return;
	}
	stopping = false;
	solveSpot(data.config, data.target, data.threads, data.cap).catch((error: unknown) =>
		post({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
	);
};
