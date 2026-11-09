/**
 * Worker-thread parallelism.
 *
 * Purpose: the one place solving is split across cores.
 *
 * The split is by RUNOUT, at the first round with more than one board. Storage
 * is indexed runout-outermost, so each worker owns a disjoint slice of the
 * shared regret and strategy arrays and never needs a lock for anything below
 * that round.
 *
 * The round ABOVE the split is the exception: its regret update needs the value
 * summed over every runout, and CFR+ clamps at zero, which is not linear, so
 * partial updates cannot simply be added. That round stays on the main thread,
 * which walks it twice per traversal — once to collect the reach vectors the
 * workers need, once to apply updates from the totals they returned. It carries
 * a single board, so this costs almost nothing.
 *
 * The main thread takes the first shard itself rather than sleeping while the
 * workers run, so `workers` counts every thread doing the work: two means the
 * main thread and one worker.
 *
 * Every traversal goes through here, not just training: an exploitability
 * check is a full best-response pass, and left single-threaded it would cost
 * as many iterations as there are threads.
 *
 * Coordination is through Atomics rather than messages, so the public solve API
 * stays synchronous.
 *
 * Agreement with a single-threaded solve is to floating point, not bit-for-bit:
 * each worker sums its own slice of runouts before the totals are summed across
 * workers, which is a different association of the same addition.
 */

import { COMBOS } from './cards.ts';
import type { Context, RootTraversal, Solver } from './cfr.ts';
import { Mode } from './cfr.ts';
import type { Runouts } from './runouts.ts';
import type { Tree } from './tree.ts';
import { NodeKind } from './tree.ts';
import type { WorkerHandle } from './platform/node.ts';
import { spawnWorker } from './platform/node.ts';

/** How a pool starts its workers; the platform's `spawnWorker` unless a test swaps it. */
export type SpawnWorker = (setup: WorkerSetup, onError: (error: Error) => void) => WorkerHandle;

export { defaultWorkerCount } from './platform/node.ts';

export const CONTROL = {
	generation: 0,
	done: 1,
	command: 2,
	traverser: 3,
	iterWeight: 4,
	ready: 5,
	mode: 6,
	/** Set, never cleared, once any thread's part of a step threw; see src/worker.ts. */
	failed: 7,
	size: 8,
} as const;

/** What a threaded step throws once a thread has failed mid-iteration, here or in src/engine.ts. */
export const THREAD_FAILED_ERROR =
	'A solver thread failed mid-iteration; this run cannot continue. Close it and solve again, or use workers: 1.';

/**
 * What a threaded step throws once another thread has gone silent past the
 * backstop, here or in src/engine.ts.
 */
export const THREAD_LOST_ERROR =
	'A solver thread stopped answering mid-iteration; it may have run out of memory or been killed. ' +
	'This run cannot continue. Close it and solve again, or use workers: 1.';

/**
 * The backstop on how long the main thread waits for the others in one step.
 *
 * A thread that throws reports itself in shared memory, but one killed
 * without unwinding (a Node worker out of V8 heap, a worker the browser
 * kills) runs no `catch` or `finally`, and its error event cannot reach a
 * main thread waiting in `Atomics.wait`. Every thread's shard is the same
 * size as the main thread's own and runs under the same load, so the wait is
 * bounded at a multiple of the main thread's own shard time, and never under
 * the floor: it only fires with one thread both 20× slower than the main
 * thread and over a minute late.
 */
export const THREAD_BACKSTOP_FLOOR_MS = 60_000;
export const THREAD_BACKSTOP_FACTOR = 20;

/**
 * How long, from the step's dispatch, the main thread waits for the others.
 * @param ownMs the main thread's own shard time this step
 * @param floorMs the shortest wait; tests shorten it
 */
export function backstopMs(ownMs: number, floorMs: number = THREAD_BACKSTOP_FLOOR_MS): number {
	return Math.max(floorMs, THREAD_BACKSTOP_FACTOR * ownMs);
}

/** How long one `Atomics.wait` of {@link awaitThreads} sleeps before looking again. */
const WAIT_SLICE_MS = 50;
/** A wait that overruns its slice by more than this was a stopped process, not a slow thread. */
const STOPPED_MS = 1_000;

/**
 * Wait, after this thread's own shard, for the other threads to count
 * themselves done in `control[slot]`, or until the backstop passes.
 *
 * Time the whole process spends stopped mid-wait (a debugger, Ctrl-Z, a VM
 * pause, a sleep the clock counts) stops every thread alike, so it extends
 * the backstop rather than counting against the others.
 *
 * @param control the pool's control slots
 * @param slot the slot the other threads count themselves done in
 * @param target how many other threads there are
 * @param dispatched `performance.now()` when the step was dispatched
 * @param floorMs the backstop's floor; see {@link backstopMs}
 * @param stopped whether to stop waiting for some other reason
 * @returns {@link THREAD_LOST_ERROR} once the backstop passes, else null
 */
export function awaitThreads(
	control: Int32Array,
	slot: number,
	target: number,
	dispatched: number,
	floorMs: number | undefined,
	stopped: () => boolean,
): Error | null {
	// Monotonic, so a change to the wall clock is not taken for a silent thread.
	let giveUp = dispatched + backstopMs(performance.now() - dispatched, floorMs);
	for (;;) {
		const done = Atomics.load(control, slot);
		if (done >= target || stopped()) return null;
		const before = performance.now();
		if (before > giveUp) return new Error(THREAD_LOST_ERROR);
		Atomics.wait(control, slot, done, WAIT_SLICE_MS);
		const overrun = performance.now() - before - WAIT_SLICE_MS;
		if (overrun > STOPPED_MS) giveUp += overrun;
	}
}

export const COMMAND = { work: 0, exit: 1 } as const;

/** How long worker threads may take to start before a solve gives up on them. */
export const WORKER_START_MS = 30_000;
export const WORKER_START_ERROR =
	'Worker threads did not start within 30 s. Run with workers: 1, or check that worker threads can load this package.';

/** How the runouts are split and where the cut sits in the tree. */
export interface ShardPlan {
	readonly round: number;
	readonly boards: number;
	/** Chance nodes feeding that round. */
	readonly entryNodes: Int32Array;
	readonly entryIndexOf: Int32Array;
	/** Shard boundaries, `workers + 1` entries; shard 0 is the main thread's. */
	readonly bounds: Int32Array;
}

/**
 * Decide how to split a spot across workers, or null if it is not worth it.
 * @param tree the betting tree
 * @param runouts board completions
 * @param workers worker count
 */
export function planShards(tree: Tree, runouts: Runouts, workers: number): ShardPlan | null {
	if (workers < 2) return null;
	let round = -1;
	for (let r = 1; r < runouts.rounds; r++) {
		if (runouts.counts[r] > 1) {
			round = r;
			break;
		}
	}
	// A river spot has one board and nothing to divide; it also solves instantly.
	if (round < 0) return null;

	const boards = runouts.counts[round];
	if (boards < workers * 2) return null;

	const entryIndexOf = new Int32Array(tree.nodeCount).fill(-1);
	const entryNodes: number[] = [];
	for (let node = 0; node < tree.nodeCount; node++) {
		if (tree.kind[node] !== NodeKind.Chance) continue;
		if (tree.round[node] + 1 !== round) continue;
		entryIndexOf[node] = entryNodes.length;
		entryNodes.push(node);
	}
	if (entryNodes.length === 0) return null;

	const bounds = new Int32Array(workers + 1);
	for (let w = 0; w <= workers; w++) bounds[w] = Math.round((boards * w) / workers);
	if (runouts.lines) {
		// Line runouts deal far fewer boards below a coarse board than below a
		// fine one, so the split follows the boards below each.
		const weight = new Float64Array(boards).fill(1);
		for (const fam of runouts.lines.families) {
			if (fam.round !== round + 1) continue;
			const above = runouts.lines.families[fam.parent];
			for (let b = above.from; b < above.to; b++) weight[b] += fam.childStart[b + 1] - fam.childStart[b];
		}
		let total = 0;
		for (let b = 0; b < boards; b++) total += weight[b];
		let sum = 0;
		let w = 1;
		for (let b = 0; b < boards && w < workers; b++) {
			sum += weight[b];
			while (w < workers && sum >= (total * w) / workers) bounds[w++] = b + 1;
		}
		for (let k = 1; k < workers; k++) if (bounds[k] <= bounds[k - 1]) bounds[k] = Math.min(boards, bounds[k - 1] + 1);
	}

	return { round, boards, entryNodes: Int32Array.from(entryNodes), entryIndexOf, bounds };
}

/** Everything a worker needs to rebuild the solver. */
export interface WorkerSetup {
	/** Index among the spawned threads; this worker owns shard `workerId + 1`. */
	readonly workerId: number;
	readonly payload: unknown;
	readonly plan: { round: number; entryNodes: Int32Array; entryIndexOf: Int32Array };
	readonly shardStart: number;
	readonly shardEnd: number;
	readonly regret: SharedArrayBuffer;
	readonly strategySum: SharedArrayBuffer;
	/** Per-block scales, for 16-bit storage only. */
	readonly regretScale: SharedArrayBuffer | null;
	readonly sumScale: SharedArrayBuffer | null;
	/** Compact storage's regrets and hand scales, else null. */
	readonly compactRegret: SharedArrayBuffer[] | null;
	readonly handShift: SharedArrayBuffer[] | null;
	readonly compactSum: SharedArrayBuffer[] | null;
	readonly sumShift: SharedArrayBuffer[] | null;
	readonly compactScale: SharedArrayBuffer | null;
	/**
	 * Chance sampling's baselines, last walks and last updates, else null.
	 * Each thread reads and writes only its own runouts' entries.
	 */
	readonly sampling: readonly [SharedArrayBuffer, SharedArrayBuffer, SharedArrayBuffer] | null;
	readonly control: SharedArrayBuffer;
	readonly exchange: SharedArrayBuffer;
	readonly entryCount: number;
}

/** A running pool of solver workers. */
export interface Pool {
	/** One traversal for one traverser, returning the root value vector. */
	readonly traverse: RootTraversal;
	close(): void;
	/** Threads doing the work, the main thread included. */
	readonly workers: number;
}

/**
 * Start a worker pool.
 *
 * @param ctx solver context, whose accumulators must be SharedArrayBuffer backed
 * @param solver single-threaded solver, used for the round above the split
 * @param plan how the runouts are split
 * @param payload everything the worker needs to rebuild the context
 * @param workers threads doing the work, the main thread included
 * @param spawn how each worker is started
 * @param backstopFloorMs the shortest a step waits for the workers; see {@link backstopMs}
 */
export function startPool(
	ctx: Context,
	solver: Solver,
	plan: ShardPlan,
	payload: unknown,
	workers: number,
	spawn: SpawnWorker = spawnWorker,
	backstopFloorMs: number = THREAD_BACKSTOP_FLOOR_MS,
): Pool {
	const entryCount = plan.entryNodes.length;
	// The main thread is one of the `workers`; only the rest are spawned.
	const spawned = workers - 1;
	const reachFloats = entryCount * 2 * COMBOS;
	const partialFloats = spawned * entryCount * COMBOS;
	const exchangeBuffer = new SharedArrayBuffer((reachFloats + partialFloats) * 8);
	const exchange = new Float64Array(exchangeBuffer);
	const controlBuffer = new SharedArrayBuffer(CONTROL.size * 4);
	const control = new Int32Array(controlBuffer);

	const threads: WorkerHandle[] = [];
	let failure: Error | null = null;

	for (let w = 0; w < spawned; w++) {
		const setup: WorkerSetup = {
			workerId: w,
			payload,
			plan: { round: plan.round, entryNodes: plan.entryNodes, entryIndexOf: plan.entryIndexOf },
			shardStart: plan.bounds[w + 1],
			shardEnd: plan.bounds[w + 2],
			regret: ctx.regret.buffer as SharedArrayBuffer,
			strategySum: ctx.strategySum.buffer as SharedArrayBuffer,
			regretScale: (ctx.regretScale?.buffer as SharedArrayBuffer | undefined) ?? null,
			sumScale: (ctx.sumScale?.buffer as SharedArrayBuffer | undefined) ?? null,
			compactRegret: ctx.compactRegret?.map((chunk) => chunk.buffer as SharedArrayBuffer) ?? null,
			handShift: ctx.handShift?.map((chunk) => chunk.buffer as SharedArrayBuffer) ?? null,
			compactSum: ctx.compactSum?.map((chunk) => chunk.buffer as SharedArrayBuffer) ?? null,
			sumShift: ctx.sumShift?.map((chunk) => chunk.buffer as SharedArrayBuffer) ?? null,
			compactScale: (ctx.compactScale?.buffer as SharedArrayBuffer | undefined) ?? null,
			sampling: ctx.sampling
				? [
						ctx.sampling.baseline.buffer as SharedArrayBuffer,
						ctx.sampling.lastWalk.buffer as SharedArrayBuffer,
						ctx.sampling.lastUpdate.buffer as SharedArrayBuffer,
					]
				: null,
			control: controlBuffer,
			exchange: exchangeBuffer,
			entryCount,
		};
		// A worker that dies would otherwise leave the main thread waiting on a
		// counter that can never reach its target.
		const thread = spawn(setup, (error: Error) => {
			failure ??= error;
			Atomics.store(control, CONTROL.ready, spawned);
			Atomics.add(control, CONTROL.done, spawned);
			Atomics.notify(control, CONTROL.done);
			Atomics.notify(control, CONTROL.ready);
		});
		threads.push(thread);
	}

	// Barrier: a worker that started after the first dispatch would never see
	// the generation change, and the pool would deadlock.
	// A worker that fails to start reports it by an event, which cannot be
	// delivered while this thread waits here, so the wait is bounded.
	const deadline = Date.now() + WORKER_START_MS;
	for (;;) {
		const ready = Atomics.load(control, CONTROL.ready);
		if (ready >= spawned || failure) break;
		if (Date.now() > deadline) failure = new Error(WORKER_START_ERROR);
		else Atomics.wait(control, CONTROL.ready, ready, 20);
	}
	if (failure) {
		for (const thread of threads) thread.terminate();
		throw failure;
	}

	const total = new Float64Array(COMBOS);
	const chanceValues = new Float64Array(entryCount * COMBOS);

	const mainReachMe = new Float64Array(COMBOS);
	const mainReachOpp = new Float64Array(COMBOS);

	const failed = (): Error | null =>
		failure ?? (Atomics.load(control, CONTROL.failed) ? new Error(THREAD_FAILED_ERROR) : null);

	const dispatch = (mode: Mode, traverser: 0 | 1, iterWeight: number): void => {
		Atomics.store(control, CONTROL.done, 0);
		Atomics.store(control, CONTROL.mode, mode);
		Atomics.store(control, CONTROL.traverser, traverser);
		Atomics.store(control, CONTROL.iterWeight, iterWeight);
		Atomics.store(control, CONTROL.command, COMMAND.work);
		Atomics.add(control, CONTROL.generation, 1);
		Atomics.notify(control, CONTROL.generation);
		const dispatched = performance.now();

		// Shard 0 is this thread's, done while the workers do theirs. With no
		// collect or override set the split-round chance nodes expand as usual,
		// over whatever slice the context names.
		const fullStart = ctx.shardStart;
		const fullEnd = ctx.shardEnd;
		ctx.shardStart = plan.bounds[0];
		ctx.shardEnd = plan.bounds[1];
		// Pass A left updates off; below the split they are this shard's own.
		ctx.applyUpdates = true;
		try {
			for (let entry = 0; entry < entryCount; entry++) {
				for (let i = 0; i < COMBOS; i++) {
					mainReachMe[i] = exchange[entry * 2 * COMBOS + i];
					mainReachOpp[i] = exchange[entry * 2 * COMBOS + COMBOS + i];
				}
				const value = solver.traverseChance(
					mode, traverser, iterWeight, plan.entryNodes[entry], mainReachMe, mainReachOpp,
				);
				chanceValues.set(value.subarray(0, COMBOS), entry * COMBOS);
			}
		} finally {
			ctx.shardStart = fullStart;
			ctx.shardEnd = fullEnd;
		}

		// A worker whose walk throws says so in `failed` and counts itself
		// done, as its error event cannot reach this thread while it waits.
		// One killed without unwinding does neither, hence the backstop.
		failure ??= awaitThreads(control, CONTROL.done, spawned, dispatched, backstopFloorMs, () => failure !== null);
		const dead = failed();
		if (dead) throw dead;
	};

	const traverseAll: RootTraversal = (mode, traverser, iterWeight) => {
		// Pass A: walk the round above the split to capture what each worker
		// needs, applying nothing.
		ctx.applyUpdates = false;
		ctx.chanceOverride = null;
		ctx.chanceCollect = (node, reachMe, reachOpp) => {
			const entry = plan.entryIndexOf[node];
			exchange.set(reachMe.subarray(0, COMBOS), entry * 2 * COMBOS);
			exchange.set(reachOpp.subarray(0, COMBOS), entry * 2 * COMBOS + COMBOS);
		};
		try {
			solver.traverseRoot(mode, traverser, iterWeight);
		} finally {
			ctx.chanceCollect = null;
		}

		// Leaves this thread's own partial in `chanceValues`.
		dispatch(mode, traverser, iterWeight);

		for (let w = 0; w < spawned; w++) {
			const base = reachFloats + w * entryCount * COMBOS;
			for (let i = 0; i < entryCount * COMBOS; i++) chanceValues[i] += exchange[base + i];
		}

		// Pass B: finish that round from the totals, now applying updates.
		ctx.chanceOverride = chanceValues;
		ctx.applyUpdates = true;
		try {
			const value = solver.traverseRoot(mode, traverser, iterWeight);
			total.set(value.subarray(0, COMBOS));
		} finally {
			ctx.chanceOverride = null;
		}
		return total;
	};

	return {
		workers,
		traverse(mode, traverser, iterWeight) {
			// Once any thread has failed, so does every step after, before it
			// touches anything.
			const dead = failed();
			if (dead) throw dead;
			try {
				return traverseAll(mode, traverser, iterWeight);
			} catch (error) {
				// This thread's own part may have thrown with the workers still
				// walking; no later step may run over them.
				Atomics.store(control, CONTROL.failed, 1);
				throw error;
			}
		},
		close() {
			Atomics.store(control, CONTROL.command, COMMAND.exit);
			Atomics.add(control, CONTROL.generation, 1);
			Atomics.notify(control, CONTROL.generation);
			for (const thread of threads) thread.terminate();
		},
	};
}
