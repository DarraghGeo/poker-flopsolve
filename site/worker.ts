/**
 * The benchmark page's solver, in a Web Worker.
 *
 * Purpose: estimate a spot's size as the form changes, and solve it while
 * timing every phase: starting threads, building the tree, allocating
 * storage, the iterations themselves and the exploitability measures, which
 * are timed apart so iterations per second count iterations only. The page
 * starts a fresh worker for each solve and ends it before the next, so a
 * solve's memory and threads are gone before the next. Until then the worker
 * keeps the solved run and draws any decision of it the page asks for. In
 * Lite it also re-solves, on request, the street a dealt card opens at the
 * spot's own betting (issue #147), and keeps each re-solve beside the solve
 * it came from, the line's streets one on another. And in Lite, on request,
 * it solves the Exact game beside the Lite solve and measures how
 * exploitable Lite's play is in it (issue #154).
 *
 * Iterations run in chunks of about a fifth of a second with a yield between
 * them, so progress streams and a stop message lands.
 */

import { COMBO_CARDS, createRun, defineSpot, exploitabilityInExact, litePreset, simdAvailable, SpotTooLargeError, trackSettle } from '../src/index.ts';
import type { Estimate, Precision, Solution, SolveOptions, SolveRun, Spot, SpotConfig } from '../src/index.ts';
import { DEFAULT_MAX_BYTES } from '../src/platform/browser.ts';
import { settlePlan } from '../src/settle.ts';
import { enableThreads, threadsUnavailable } from '../src/threads.ts';
import { wasmStorage } from '../src/wasm-storage.ts';
import { checkGap } from './lib/bench.ts';
import type { Check } from './lib/bench.ts';
import { nodeView, runoutsOf } from './lib/explore.ts';
import { liteSummary } from './lib/lite.ts';
import { RESOLVE_CAP, resolvePlan } from './lib/resolve.ts';
import type { Mode } from './lib/settings.ts';
import type { ExactFit, Inbound, Measured, Origin, Outbound, Report, Resolved, SpotSummary, WalkView } from './protocol.ts';

const scope = self as unknown as {
	postMessage(message: Outbound): void;
	onmessage: ((event: { data: Inbound }) => void) | null;
	navigator: { userAgent: string; hardwareConcurrency?: number; deviceMemory?: number };
	crossOriginIsolated?: boolean;
};

const post = (message: Outbound): void => scope.postMessage(message);

const TOO_BIG_FOR_SAMPLING = "Too big for the memory limit once Lite's card sampling is added. Try a higher limit, fewer bet sizes or narrower ranges.";

const TOO_BIG_TO_MEASURE = 'The Exact game is too big to solve in the memory left beside the Lite solve. Try a higher memory limit, fewer bet sizes or narrower ranges.';

const TOO_BIG_TO_RESOLVE = 'This street is too big to re-solve at your sizes in the memory left beside the solve. Try a higher memory limit, fewer sizes or fewer raises.';

/** Solving time each chunk aims at, so progress streams and stop lands. */
const CHUNK_MS = 200;

let stopping = false;
/** Stops the Exact solve a measure makes, apart from `stopping`, which a newer card sets to stop a re-solve. */
let measureStopping = false;
/** Whether the measure under way let the re-solved streets go, so the page hears it even if the measure fails. */
let measureDropped = false;

/** A solve the walk-through reads: the benchmark's, or a street re-solved from one. */
interface Layer {
	readonly spot: Spot;
	readonly solution: Solution;
	/** Kept open while its solution is read; null for the benchmark's, which ends with the worker. */
	readonly run: SolveRun | null;
	/** The original spot's street this solve begins on. */
	readonly base: number;
	/** Where its first card was dealt; null for the benchmark's. */
	readonly from: Origin | null;
	/** Its memory: storage, and sampling's baselines. */
	readonly bytes: number;
}

/** The finished solve and what it was asked for, kept for the page to walk through. */
let solved: { config: SpotConfig; mode: Mode; threads: number; maxBytes: number } | null = null;
/** The benchmark's solve, then each street re-solved along the line, in order. */
let layers: Layer[] = [];
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
 * A run of `spot` at the precision `createRun` would pick, made explicit so
 * the page can show it. Lite's sampling needs memory beside the tree, which
 * the estimate does not count: if 32 bits do not fit beside it the tree is
 * compressed to make room, or `tooBig` says plainly why not.
 */
function openRun(spot: Spot, options: SolveOptions, threads: number, maxBytes: number, tooBig: string): { run: SolveRun; precision: 'f32' | 'i16'; storageBytes: number } {
	const open = (at: Precision): SolveRun =>
		createRun(spot, { ...options, workers: threads, precision: at, ...(at === 'i16' ? { wasmStorage } : {}) });
	let precision: 'f32' | 'i16' = precisionFor(spot.estimate, maxBytes);
	let run: SolveRun;
	try {
		run = open(precision);
	} catch (error) {
		if (!/over maxBytes/.test(String(error))) throw error;
		if (precision === 'i16') throw new Error(tooBig);
		precision = 'i16';
		try {
			run = open(precision);
		} catch (again) {
			throw /over maxBytes/.test(String(again)) ? new Error(tooBig) : again;
		}
	}
	return { run, precision, storageBytes: precision === 'i16' ? spot.estimate.compressedBytes : spot.estimate.bytes };
}

/** How {@link drive} stops and reports. */
interface DrivePlan {
	/** Lite's stop on the first decisions; null to stop at `target`. */
	readonly settle: ReturnType<typeof settlePlan> | null;
	readonly tracker: ReturnType<typeof trackSettle> | null;
	/** Exploitability to stop at, % of the pot, without `settle`. */
	readonly target: number;
	readonly cap: number;
	/** On a stop, measure exploitability where it stopped, so the last figure matches the iterations. */
	readonly measureOnStop: boolean;
	/** Whether to stop where it is; unset, `stopping`. */
	readonly stopped?: () => boolean;
	onProgress(solveMs: number, measureMs: number): void;
	onCheck(check: Check): void;
}

/**
 * Step `run` in chunks until it settles (`settle`), reaches `target`, hits
 * `cap` or is stopped, yielding between chunks so progress streams and a
 * stop lands. With `settle` it reads how far the first decisions moved every
 * `settle.every` iterations, as `solveLite` does; without, it measures
 * exploitability on `checkGap`'s schedule. The readings go in `checks`, in %
 * (of the range, or of the pot).
 */
async function drive(run: SolveRun, plan: DrivePlan): Promise<{ checks: Check[]; solveMs: number; measureMs: number; stoppedBy: Report['stoppedBy'] }> {
	const now = (): number => performance.now();
	const { settle, tracker, target, cap } = plan;
	const checks: Check[] = [];
	let solveMs = 0;
	let measureMs = 0;
	let nextCheck = settle ? settle.every : 1;
	let perIteration = 0;
	let stoppedBy: Report['stoppedBy'] = 'iterations';
	let t = 0;
	const record = (check: Check): void => {
		checks.push(check);
		plan.onCheck(check);
	};
	for (;;) {
		const room = Math.min(nextCheck, cap) - run.completed;
		const affordable = perIteration > 0 ? Math.max(1, Math.floor(CHUNK_MS / perIteration)) : 1;
		const count = Math.max(1, Math.min(room, affordable));
		t = now();
		run.step(count);
		const stepMs = now() - t;
		solveMs += stepMs;
		perIteration = stepMs / count;
		plan.onProgress(solveMs, measureMs);

		if (tracker && settle) {
			if (run.completed >= nextCheck) {
				t = now();
				const settled = tracker.check(run.snapshot(), run.completed);
				measureMs += now() - t;
				if (Number.isFinite(tracker.movement)) record({ iterations: run.completed, exploitability: tracker.movement * 100, ms: solveMs });
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
			record({ iterations: run.completed, exploitability, ms: solveMs });
			if (exploitability <= target) {
				stoppedBy = 'target';
				break;
			}
			nextCheck = run.completed + checkGap(run.completed);
		}
		if (run.completed >= cap) break;
		await yieldToMessages();
		if (plan.stopped ? plan.stopped() : stopping) {
			stoppedBy = 'stopped';
			if (plan.measureOnStop && !tracker && checks[checks.length - 1]?.iterations !== run.completed) {
				t = now();
				const exploitability = run.exploitabilityPercent();
				measureMs += now() - t;
				record({ iterations: run.completed, exploitability, ms: solveMs });
			}
			break;
		}
	}
	return { checks, solveMs, measureMs, stoppedBy };
}

/**
 * Decision `node` on `board` of solve `layer`, its rounds counted from the
 * original spot's first street. Where a re-solve's street opens, the cards
 * to switch to are the ones the solve it came from could deal there.
 */
function walkView(layer: number, node: number, board: number): WalkView {
	const at = layers[layer];
	if (!at) throw new Error('That solve is no longer held; pick the card again.');
	const view = nodeView(at.spot, at.solution, node, board);
	const opening = at.from !== null && view.round === 0 ? at.from : null;
	const parent = opening ? layers[opening.layer] : null;
	return {
		...view,
		round: view.round + at.base,
		next: view.next.map((step) => (step ? { ...step, round: step.round + at.base } : null)),
		runouts: opening && parent ? runoutsOf(parent.spot, parent.spot.tree.round[opening.node], opening.board) : view.runouts,
		layer,
		dealtFrom: opening,
	};
}

/** Whether each player holds a hand that gets to `node` on `board` of `layer`, the board's cards blocking theirs. */
function reachesBoth(layer: Layer, node: number, board: number): boolean {
	const { runouts, tree } = layer.spot;
	const round = tree.round[node];
	const width = runouts.width[round];
	const cards = runouts.cards[round].subarray(board * width, board * width + width);
	return ([0, 1] as const).every((player) => {
		const reach = layer.solution.reachAt(node, board, player);
		return reach.some((w, combo) => w > 0 && !cards.includes(COMBO_CARDS[combo * 2]) && !cards.includes(COMBO_CARDS[combo * 2 + 1]));
	});
}

/** A run's memory: its storage and, sampled, the baselines beside it. */
const heldBytes = (run: SolveRun, storageBytes: number): number => storageBytes + (run.solver.ctx.sampling?.bytes ?? 0);

/** Close solves `from` and after, freeing their memory. */
function dropLayers(from: number): void {
	for (const layer of layers.splice(Math.max(1, from))) layer.run?.close();
}

/**
 * Re-solve the street `node` opens on `board` in solve `layer`, at the
 * spot's own betting from that street, within the memory the solves kept
 * before it leave; then draw decision `then` of the new solve. The solves
 * after `layer` are dropped first, to make room.
 */
async function resolveStreet(request: Extract<Inbound, { type: 'resolve' }>): Promise<void> {
	const { id } = request;
	const parent = layers[request.layer];
	if (!solved || solved.mode !== 'lite' || !parent) throw new Error('Nothing to re-solve: run the spot in Lite first.');
	const started = performance.now();
	stopping = false;
	if (!reachesBoth(parent, request.node, request.board)) {
		// A player never gets here: nothing to re-solve, so it is read as it stands.
		if (!request.asIs) throw new Error('One of the ranges never gets to this card, so there is nothing to re-solve.');
		post({ type: 'view', id, view: walkView(request.layer, request.node, request.board) });
		return;
	}
	const next = layers[request.layer + 1];
	if (next?.from && next.from.node === request.node && next.from.board === request.board) {
		// Solved already, on the way down this line before.
		post({ type: 'view', id, view: walkView(request.layer + 1, request.then, 0) });
		return;
	}
	dropLayers(request.layer + 1);
	const room = solved.maxBytes - heldNow();
	if (!(room > 0)) throw new Error(TOO_BIG_TO_RESOLVE);
	const plan = resolvePlan(solved.config, parent.solution, request.node, request.board, parent.base, room);
	let spot: Spot;
	try {
		spot = defineSpot(plan.config);
	} catch (error) {
		throw error instanceof SpotTooLargeError ? new Error(TOO_BIG_TO_RESOLVE) : error;
	}
	const { run, storageBytes } = openRun(spot, plan.options, solved.threads, room, TOO_BIG_TO_RESOLVE);
	let stoppedBy: Resolved['stoppedBy'];
	try {
		const settle = plan.settle ? settlePlan(plan.settle) : null;
		const goal = settle ? settle.tolerance * 100 : (plan.target ?? 0);
		let measure: number | null = null;
		const progress = (): void => post({ type: 'resolving', id, iterations: run.completed, measure, goal, settle: settle !== null });
		({ stoppedBy } = await drive(run, {
			settle,
			tracker: settle ? trackSettle(settle) : null,
			target: plan.target ?? 0,
			cap: RESOLVE_CAP,
			measureOnStop: false,
			onProgress: progress,
			onCheck: (check) => {
				measure = check.exploitability;
				progress();
			},
		}));
		layers.push({ spot, solution: run.snapshot(), run, base: plan.round, from: { layer: request.layer, node: request.node, board: request.board }, bytes: heldBytes(run, storageBytes) });
	} catch (error) {
		run.close();
		throw error;
	}
	const resolved: Resolved = { round: plan.round, iterations: run.completed, ms: performance.now() - started, stoppedBy };
	post({ type: 'view', id, view: walkView(layers.length - 1, request.then, 0), resolved });
}

/** Memory the solves the walk-through holds take. */
const heldNow = (): number => layers.reduce((sum, layer) => sum + layer.bytes, 0);

/** The Exact game, the spot as asked, within `room` bytes; null if it does not fit even compressed. */
function exactSpot(config: SpotConfig, room: number): Spot | null {
	const spot = exactSpotOr(config, room);
	return spot instanceof SpotTooLargeError || spot === null ? null : spot;
}

/** The Exact game within `room`, or why it does not fit: the error with its estimate, or null for no room at all. */
function exactSpotOr(config: SpotConfig, room: number): Spot | SpotTooLargeError | null {
	if (!(room > 0)) return null;
	try {
		return defineSpot({ ...config, maxBytes: room });
	} catch (error) {
		if (error instanceof SpotTooLargeError) return error;
		throw error;
	}
}

/** Whether the Exact game fits beside the Lite solve, and at what storage; null if it cannot be built at all. */
function exactFit(config: SpotConfig, room: number): ExactFit | null {
	try {
		const spot = exactSpotOr(config, room);
		if (spot === null) return { fits: false, bytes: 0 };
		if (spot instanceof SpotTooLargeError) return { fits: false, bytes: spot.estimate.compressedBytes };
		return { fits: true, bytes: precisionFor(spot.estimate, room) === 'i16' ? spot.estimate.compressedBytes : spot.estimate.bytes };
	} catch {
		return null;
	}
}

/**
 * Solve the Exact game beside the Lite solve to `target`, then measure how
 * exploitable Lite's play is in it (`exploitabilityInExact`). If it does not
 * fit beside every solve held, the re-solved streets are dropped to make room.
 */
async function measureExact(request: Extract<Inbound, { type: 'measure' }>): Promise<void> {
	const { id } = request;
	const lite = layers[0];
	if (!solved || solved.mode !== 'lite' || !lite) throw new Error('Nothing to measure: run the spot in Lite first.');
	const started = performance.now();
	measureStopping = false;
	measureDropped = false;
	let spot = exactSpot(solved.config, solved.maxBytes - heldNow());
	if (!spot && layers.length > 1) {
		dropLayers(1);
		measureDropped = true;
		spot = exactSpot(solved.config, solved.maxBytes - heldNow());
	}
	if (!spot) throw new Error(TOO_BIG_TO_MEASURE);
	const room = solved.maxBytes - heldNow();
	const { run } = openRun(spot, {}, solved.threads, room, TOO_BIG_TO_MEASURE);
	try {
		let measure: number | null = null;
		const progress = (): void => post({ type: 'measuring', id, iterations: run.completed, measure, goal: request.target });
		const { checks, stoppedBy } = await drive(run, {
			settle: null,
			tracker: null,
			target: request.target,
			cap: request.cap,
			measureOnStop: true,
			stopped: () => measureStopping,
			onProgress: progress,
			onCheck: (check) => {
				measure = check.exploitability;
				progress();
			},
		});
		const floor = checks.length > 0 ? checks[checks.length - 1].exploitability : run.exploitabilityPercent();
		const result: Measured = {
			exploitability: exploitabilityInExact(lite.solution, run),
			exact: { exploitability: floor, iterations: run.completed, stoppedBy: stoppedBy === 'settled' ? 'target' : stoppedBy },
			ms: performance.now() - started,
		};
		post({ type: 'measured', id, result, dropped: measureDropped });
	} finally {
		run.close();
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
	const { run, precision, storageBytes } = openRun(spot, prepared.options, threads, maxBytes, TOO_BIG_FOR_SAMPLING);
	const allocMs = now() - t;
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

	try {
		const { checks, solveMs, measureMs, stoppedBy } = await drive(run, {
			settle,
			tracker,
			target,
			cap,
			measureOnStop: true,
			onProgress: (solveMs, measureMs) => post({ type: 'progress', iterations: run.completed, solveMs, measureMs, wallMs: now() - started }),
			onCheck: (check) => post({ type: 'check', check }),
		});

		post({ type: 'phase', phase: 'finish' });
		await yieldToMessages();
		t = now();
		const solution = run.snapshot();
		const ev: [number, number] = [solution.ev(0), solution.ev(1)];
		// The run stays open, and its solution readable, until the page ends this worker.
		solved = { config, mode, threads: run.workers, maxBytes };
		layers = [{ spot, solution, run: null, base: 0, from: null, bytes: heldBytes(run, storageBytes) }];
		const root = walkView(0, 0, 0);
		const finishMs = now() - t;
		// Outside the timed phases: whether Exact fits beside this solve to measure it.
		const exact = mode === 'lite' ? exactFit(config, maxBytes - heldNow()) : null;

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
			exact,
		};
		post({ type: 'done', report });
	} catch (error) {
		solved = null;
		layers = [];
		run.close();
		throw error;
	}
}

/** The re-solves asked for, one after another: each drops the solves after its own. */
let resolves: Promise<void> = Promise.resolve();

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

scope.onmessage = ({ data }) => {
	if (data.type === 'view') {
		try {
			if (!solved) throw new Error('Nothing is solved yet.');
			post({ type: 'view', id: data.id, view: walkView(data.layer, data.node, data.board) });
		} catch (error) {
			post({ type: 'view', id: data.id, view: null, message: messageOf(error) });
		}
		return;
	}
	if (data.type === 'resolve') {
		// A newer card stops the re-solve under way where it is; this one follows it.
		stopping = true;
		resolves = resolves.then(() =>
			resolveStreet(data).catch((error: unknown) => post({ type: 'view', id: data.id, view: null, message: messageOf(error) })),
		);
		return;
	}
	if (data.type === 'measure') {
		// After any re-solve under way, which the page lets finish first.
		resolves = resolves.then(() =>
			measureExact(data).catch((error: unknown) =>
				post({ type: 'measured', id: data.id, result: null, message: messageOf(error), dropped: measureDropped }),
			),
		);
		return;
	}
	if (data.type === 'stop') {
		stopping = true;
		measureStopping = true;
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
	solveSpot(data.config, data.mode, data.target, data.threads, data.cap).catch((error: unknown) => post({ type: 'error', message: messageOf(error) }));
};
