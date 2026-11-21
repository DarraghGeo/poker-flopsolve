/**
 * Node platform.
 *
 * Purpose: the one place the solver touches Node-only APIs. A browser build
 * swaps this module for `browser.ts`, which has the same exports; see
 * `scripts/browser-platform.ts`.
 */

import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { WorkerSetup } from '../parallel.ts';
import type { EngineWorkerSetup } from '../engine.ts';

/** Which build this is. */
export const PLATFORM = 'node';

/**
 * The most threads a solve can use here: as many as asked, on either engine.
 * @param _engine whether the WebAssembly engine is to run
 */
export function threadLimit(_engine: boolean): number {
	return Infinity;
}

/** Default ceiling on solver storage. */
export const DEFAULT_MAX_BYTES = 6 * 1024 * 1024 * 1024;

/**
 * The parent's Node flags, minus any a worker started from a file rejects:
 * `--input-type` is for code given as a string (`node -e`), and a worker
 * inheriting it fails to start.
 */
function workerFlags(): string[] {
	return process.execArgv.filter((flag) => !flag.startsWith('--input-type'));
}

/** A spawned solver thread. */
export interface WorkerHandle {
	terminate(): void;
}

/**
 * Suggested worker count for this machine, the calling thread included.
 *
 * One less than the available parallelism, but never under two. Scaling stays
 * monotone right up to the core count — a flop solve measured 3.3x on 4
 * workers, 3.9x on 6 and 4.3x on 8 across 8 cores — so the only reason to hold
 * one back is leaving the machine responsive, and on two cores that would mean
 * not splitting at all.
 */
export function defaultWorkerCount(): number {
	const cores = availableParallelism();
	return cores < 2 ? 1 : Math.max(2, cores - 1);
}

/**
 * Start one solver thread on `worker.ts`.
 *
 * @param setup everything the worker needs to rebuild the solver
 * @param onError called if the thread dies, so the pool can stop waiting on it
 */
export function spawnWorker(setup: WorkerSetup, onError: (error: Error) => void): WorkerHandle {
	// From source the worker is TypeScript; from a build it sits beside this
	// bundle as JavaScript.
	const url = new URL(import.meta.url.endsWith('.ts') ? '../worker.ts' : './worker.js', import.meta.url);
	const thread = new Worker(fileURLToPath(url), { workerData: setup, execArgv: workerFlags() });
	thread.on('error', onError);
	thread.unref();
	return {
		terminate() {
			void thread.terminate();
		},
	};
}

/** An engine thread started ahead of a solve, waiting for one. */
interface IdleThread {
	readonly worker: Worker;
	/** Stops it once it has waited past `ENGINE_THREAD_LINGER_MS`. */
	linger: ReturnType<typeof setTimeout> | null;
}

/**
 * Engine threads started and not yet given a solve, and how many
 * `prepareThreads` asked to keep. Starting a thread costs tens of
 * milliseconds, as much as everything else a run does before its first
 * iteration, so threads are started before they are needed: beside a run's
 * own setup, and again when a run closes, for the next. A thread serves one
 * solve and ends with it, so a closed run's storage goes with its threads.
 *
 * Published on `globalThis`, as the browser's pool is: the build's entries
 * (`poker-flopsolve` and `poker-flopsolve/threads`) each carry a copy of this
 * module and must share one pool.
 */
interface EnginePool {
	readonly idle: IdleThread[];
	kept: number;
}

const ENGINE_POOL_KEY = Symbol.for('poker-flopsolve.node-engine-threads');

function enginePool(): EnginePool {
	const holder = globalThis as unknown as Record<symbol, EnginePool | undefined>;
	holder[ENGINE_POOL_KEY] ??= { idle: [], kept: 0 };
	return holder[ENGINE_POOL_KEY];
}

/** How long an engine thread nobody asked to keep waits for a solve before it ends. */
const ENGINE_THREAD_LINGER_MS = 30_000;

function engineWorker(setup: EngineWorkerSetup | null): Worker {
	const url = new URL(import.meta.url.endsWith('.ts') ? '../engine-worker.ts' : './engine-worker.js', import.meta.url);
	const worker = new Worker(fileURLToPath(url), { workerData: setup, execArgv: workerFlags() });
	worker.unref();
	return worker;
}

/** Stop a waiting thread and forget it. */
function dropIdle(thread: IdleThread): void {
	if (thread.linger) clearTimeout(thread.linger);
	thread.linger = null;
	void thread.worker.terminate();
	const { idle } = enginePool();
	const at = idle.indexOf(thread);
	if (at >= 0) idle.splice(at, 1);
}

/** Give each waiting thread past the kept ones a time to end, and the kept ones none. */
function setLingers(): void {
	const pool = enginePool();
	pool.idle.forEach((thread, i) => {
		if (i < pool.kept) {
			if (thread.linger) clearTimeout(thread.linger);
			thread.linger = null;
		} else if (!thread.linger) {
			thread.linger = setTimeout(() => dropIdle(thread), ENGINE_THREAD_LINGER_MS);
			thread.linger.unref();
		}
	});
}

/**
 * Start engine threads now so that `count` wait for a solve, without
 * waiting for them: they start on their own threads while the caller goes
 * on. A run calls this before it builds its tables, so its threads are up
 * by the time it needs them. Best effort: where a thread cannot be started
 * it starts none, and a solve that needs one finds that out itself.
 * @param count waiting engine threads wanted
 */
export function warmEngineThreads(count: number): void {
	const { idle } = enginePool();
	try {
		while (idle.length < count) {
			const thread: IdleThread = { worker: engineWorker(null), linger: null };
			// One that dies waiting is only forgotten.
			thread.worker.on('error', () => dropIdle(thread));
			idle.push(thread);
		}
	} catch {
		// No threads here, or not with these flags; the caller may not need any.
	}
	setLingers();
}

/**
 * Give a solve one engine thread: a waiting one if there is one, which
 * joins at once, else a new one. It ends when the solve lets it go, and a
 * new one starts waiting in its place for the next solve.
 * @param setup what the thread needs to join the solve
 * @param onError called if the thread dies, so the solve can stop waiting on it
 */
export function spawnEngineWorker(setup: EngineWorkerSetup, onError: (error: Error) => void): WorkerHandle {
	const waiting = enginePool().idle.shift();
	let worker: Worker;
	if (waiting) {
		if (waiting.linger) clearTimeout(waiting.linger);
		worker = waiting.worker;
		worker.removeAllListeners('error');
		worker.on('error', onError);
		worker.postMessage(setup);
	} else {
		worker = engineWorker(setup);
		worker.on('error', onError);
	}
	let released = false;
	return {
		terminate() {
			if (released) return;
			released = true;
			void worker.terminate();
			// Its replacement starts now, off this thread, for the next solve.
			warmEngineThreads(enginePool().idle.length + 1);
		},
	};
}

/**
 * Why a solve gets fewer threads than it asked for: never, in Node.
 * @param _engine whether the WebAssembly engine is to run
 */
export function threadAdvice(_engine: boolean): string {
	return '';
}

/** Node always has worker threads. */
export function threadsUnavailableReason(): string | null {
	return null;
}

/**
 * Start engine threads ahead of a solve and keep that many waiting between
 * solves, so that solves on up to `count` threads find them up. Optional in
 * Node, where a run starts what it lacks; it saves the first run that wait.
 * A smaller count stops the waiting surplus, so 1 stops them all.
 * @param count threads wanted, this one included; defaults to {@link defaultWorkerCount}
 */
export async function prepareThreads(count?: number): Promise<number> {
	const threads = Math.max(1, Math.floor(count ?? defaultWorkerCount()));
	const pool = enginePool();
	pool.kept = threads - 1;
	for (const thread of pool.idle.slice(pool.kept)) dropIdle(thread);
	warmEngineThreads(pool.kept);
	return threads;
}
