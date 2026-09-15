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
 * Coordination is through Atomics rather than messages, so the public solve API
 * stays synchronous.
 *
 * Agreement with a single-threaded solve is to floating point, not bit-for-bit:
 * each worker sums its own slice of runouts before the totals are summed across
 * workers, which is a different association of the same addition.
 */

import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { COMBOS } from './cards.ts';
import type { Context, Solver } from './cfr.ts';
import { Mode } from './cfr.ts';
import type { Runouts } from './runouts.ts';
import type { Tree } from './tree.ts';
import { NodeKind } from './tree.ts';

export const CONTROL = {
	generation: 0,
	done: 1,
	command: 2,
	traverser: 3,
	iterWeight: 4,
	ready: 5,
	size: 8,
} as const;

export const COMMAND = { work: 0, exit: 1 } as const;

/** How the runouts are split and where the cut sits in the tree. */
export interface ShardPlan {
	readonly round: number;
	readonly boards: number;
	/** Chance nodes feeding that round. */
	readonly entryNodes: Int32Array;
	readonly entryIndexOf: Int32Array;
	/** Shard boundaries, `workers + 1` entries. */
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

	return { round, boards, entryNodes: Int32Array.from(entryNodes), entryIndexOf, bounds };
}

/** Everything a worker needs to rebuild the solver. */
export interface WorkerSetup {
	readonly workerId: number;
	readonly payload: unknown;
	readonly plan: { round: number; entryNodes: Int32Array; entryIndexOf: Int32Array };
	readonly shardStart: number;
	readonly shardEnd: number;
	readonly regret: SharedArrayBuffer;
	readonly strategySum: SharedArrayBuffer;
	readonly float64: boolean;
	readonly control: SharedArrayBuffer;
	readonly exchange: SharedArrayBuffer;
	readonly entryCount: number;
	readonly workers: number;
}

/** A running pool of solver workers. */
export interface Pool {
	/** One traversal for one traverser, returning the root value vector. */
	traverse(traverser: 0 | 1, iterWeight: number): Float64Array;
	close(): void;
	readonly workers: number;
}

/**
 * Start a worker pool.
 *
 * @param ctx solver context, whose accumulators must be SharedArrayBuffer backed
 * @param solver single-threaded solver, used for the round above the split
 * @param plan how the runouts are split
 * @param payload everything the worker needs to rebuild the context
 * @param workers worker count
 */
export function startPool(
	ctx: Context,
	solver: Solver,
	plan: ShardPlan,
	payload: unknown,
	workers: number,
): Pool {
	const entryCount = plan.entryNodes.length;
	const reachFloats = entryCount * 2 * COMBOS;
	const partialFloats = workers * entryCount * COMBOS;
	const exchangeBuffer = new SharedArrayBuffer((reachFloats + partialFloats) * 8);
	const exchange = new Float64Array(exchangeBuffer);
	const controlBuffer = new SharedArrayBuffer(CONTROL.size * 4);
	const control = new Int32Array(controlBuffer);

	const workerUrl = new URL(
		import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js',
		import.meta.url,
	);

	const threads: Worker[] = [];
	let failure: Error | null = null;

	for (let w = 0; w < workers; w++) {
		const setup: WorkerSetup = {
			workerId: w,
			payload,
			plan: { round: plan.round, entryNodes: plan.entryNodes, entryIndexOf: plan.entryIndexOf },
			shardStart: plan.bounds[w],
			shardEnd: plan.bounds[w + 1],
			regret: ctx.regret.buffer as SharedArrayBuffer,
			strategySum: ctx.strategySum.buffer as SharedArrayBuffer,
			float64: ctx.regret instanceof Float64Array,
			control: controlBuffer,
			exchange: exchangeBuffer,
			entryCount,
			workers,
		};
		const thread = new Worker(fileURLToPath(workerUrl), { workerData: setup });
		// A worker that dies would otherwise leave the main thread waiting on a
		// counter that can never reach its target.
		thread.on('error', (error: Error) => {
			failure ??= error;
			Atomics.store(control, CONTROL.ready, workers);
			Atomics.add(control, CONTROL.done, workers);
			Atomics.notify(control, CONTROL.done);
			Atomics.notify(control, CONTROL.ready);
		});
		thread.unref();
		threads.push(thread);
	}

	// Barrier: a worker that started after the first dispatch would never see
	// the generation change, and the pool would deadlock.
	for (;;) {
		const ready = Atomics.load(control, CONTROL.ready);
		if (ready >= workers || failure) break;
		Atomics.wait(control, CONTROL.ready, ready, 20);
	}
	if (failure) {
		for (const thread of threads) void thread.terminate();
		throw failure;
	}

	const total = new Float64Array(COMBOS);
	const chanceValues = new Float64Array(entryCount * COMBOS);

	const dispatch = (traverser: 0 | 1, iterWeight: number): void => {
		Atomics.store(control, CONTROL.done, 0);
		Atomics.store(control, CONTROL.traverser, traverser);
		Atomics.store(control, CONTROL.iterWeight, iterWeight);
		Atomics.store(control, CONTROL.command, COMMAND.work);
		Atomics.add(control, CONTROL.generation, 1);
		Atomics.notify(control, CONTROL.generation);

		for (;;) {
			const done = Atomics.load(control, CONTROL.done);
			if (done >= workers) break;
			if (failure) throw failure;
			Atomics.wait(control, CONTROL.done, done, 50);
		}
		if (failure) throw failure;
	};

	return {
		workers,
		traverse(traverser, iterWeight) {
			// Pass A: walk the round above the split to capture what each worker
			// needs, applying nothing.
			ctx.applyUpdates = false;
			ctx.chanceOverride = null;
			ctx.chanceCollect = (node, reachMe, reachOpp) => {
				const entry = plan.entryIndexOf[node];
				exchange.set(reachMe.subarray(0, COMBOS), entry * 2 * COMBOS);
				exchange.set(reachOpp.subarray(0, COMBOS), entry * 2 * COMBOS + COMBOS);
			};
			solver.traverseRoot(Mode.Train, traverser, iterWeight);

			dispatch(traverser, iterWeight);

			chanceValues.fill(0);
			for (let w = 0; w < workers; w++) {
				const base = reachFloats + w * entryCount * COMBOS;
				for (let i = 0; i < entryCount * COMBOS; i++) chanceValues[i] += exchange[base + i];
			}

			// Pass B: finish that round from the totals, now applying updates.
			ctx.chanceCollect = null;
			ctx.chanceOverride = chanceValues;
			ctx.applyUpdates = true;
			const value = solver.traverseRoot(Mode.Train, traverser, iterWeight);
			total.set(value.subarray(0, COMBOS));
			ctx.chanceOverride = null;
			return total;
		},
		close() {
			Atomics.store(control, CONTROL.command, COMMAND.exit);
			Atomics.add(control, CONTROL.generation, 1);
			Atomics.notify(control, CONTROL.generation);
			for (const thread of threads) void thread.terminate();
		},
	};
}

/**
 * Suggested worker count for this machine.
 *
 * One less than the available parallelism. Scaling stays monotone right up to
 * the core count — a flop solve measured 3.3x on 4 workers, 3.9x on 6 and 4.3x
 * on 8 across 8 cores — so the only reason to hold one back is leaving the
 * machine responsive.
 */
export function defaultWorkerCount(): number {
	return Math.max(1, availableParallelism() - 1);
}
