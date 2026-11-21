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

/** One engine thread: started once, lent to a solve, idle in between. */
interface EngineThread {
	readonly worker: Worker;
	busy: boolean;
	/** The solve it is lent to, to tell if it dies. */
	onError: ((error: Error) => void) | null;
	/** Stops it once it has idled past `ENGINE_THREAD_LINGER_MS`. */
	linger: ReturnType<typeof setTimeout> | null;
}

/**
 * Engine threads alive now, lent or idle. Starting a thread costs tens of
 * milliseconds, as much as everything else a run does before its first
 * iteration, so a closed run's threads wait for the next run instead of
 * ending.
 */
const engineThreads: EngineThread[] = [];

/** How long an engine thread nobody asked to keep waits idle before it ends. */
const ENGINE_THREAD_LINGER_MS = 30_000;

/** Idle engine threads `prepareThreads` asked to keep for good. */
let engineThreadsKept = 0;

/** `ENGINE_CONTROL.command`'s value that ends a thread's solve, and `ENGINE_CONTROL`'s slots used here. */
const ENGINE_COMMAND_EXIT = 1;
const ENGINE_SLOT = { generation: 0, command: 2, failed: 6 } as const;

/** Stop an engine thread for good and forget it. */
function dropEngineThread(thread: EngineThread): void {
	if (thread.linger) clearTimeout(thread.linger);
	thread.linger = null;
	void thread.worker.terminate();
	const at = engineThreads.indexOf(thread);
	if (at >= 0) engineThreads.splice(at, 1);
}

/** Start an engine thread, on a solve's setup or idle. */
function startEngineThread(setup: EngineWorkerSetup | null, onError: ((error: Error) => void) | null): EngineThread {
	const url = new URL(import.meta.url.endsWith('.ts') ? '../engine-worker.ts' : './engine-worker.js', import.meta.url);
	const worker = new Worker(fileURLToPath(url), { workerData: setup, execArgv: workerFlags() });
	const thread: EngineThread = { worker, busy: setup !== null, onError, linger: null };
	worker.on('error', (error) => {
		const tell = thread.onError;
		dropEngineThread(thread);
		tell?.(error);
	});
	worker.unref();
	engineThreads.push(thread);
	return thread;
}

/** Leave an idle thread waiting: for good if it is one of those kept, else until it has lingered. */
function idleEngineThread(thread: EngineThread): void {
	thread.busy = false;
	thread.onError = null;
	if (thread.linger) clearTimeout(thread.linger);
	thread.linger = null;
	if (engineThreads.filter((other) => !other.busy).length <= engineThreadsKept) return;
	thread.linger = setTimeout(() => {
		if (!thread.busy) dropEngineThread(thread);
	}, ENGINE_THREAD_LINGER_MS);
	thread.linger.unref();
}

/**
 * Start engine threads now so that `count` are idle, without waiting for
 * them: they start on their own threads while the caller goes on. A run
 * calls this before it builds its tables, so its threads are up by the time
 * it needs them.
 * @param count idle engine threads wanted
 */
export function warmEngineThreads(count: number): void {
	let idle = engineThreads.filter((thread) => !thread.busy).length;
	for (; idle < count; idle++) idleEngineThread(startEngineThread(null, null));
}

/**
 * Lend one engine thread to a solve: an idle one if there is one, which
 * joins at once, else a new one.
 * @param setup what the thread needs to join the solve
 * @param onError called if the thread dies, so the solve can stop waiting on it
 */
export function spawnEngineWorker(setup: EngineWorkerSetup, onError: (error: Error) => void): WorkerHandle {
	let thread = engineThreads.find((candidate) => !candidate.busy);
	if (thread) {
		if (thread.linger) clearTimeout(thread.linger);
		thread.linger = null;
		thread.busy = true;
		thread.onError = onError;
		thread.worker.postMessage(setup);
	} else {
		thread = startEngineThread(setup, onError);
	}
	const lent = thread;
	const control = new Int32Array(setup.control);
	let released = false;
	return {
		terminate() {
			// A run may be closed twice; by then the thread may serve another.
			if (released) return;
			released = true;
			if (!engineThreads.includes(lent)) return;
			// A solve a thread failed: which thread is not recorded, and its
			// engine is not to be trusted, so every one of that solve's ends.
			if (Atomics.load(control, ENGINE_SLOT.failed) !== 0) {
				dropEngineThread(lent);
				return;
			}
			// Tell the thread its solve is over, started or not: it goes back
			// to waiting for the next setup.
			if (Atomics.load(control, ENGINE_SLOT.command) !== ENGINE_COMMAND_EXIT) {
				Atomics.store(control, ENGINE_SLOT.command, ENGINE_COMMAND_EXIT);
				Atomics.add(control, ENGINE_SLOT.generation, 1);
				Atomics.notify(control, ENGINE_SLOT.generation);
			}
			idleEngineThread(lent);
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
 * Start engine threads ahead of a solve and keep them between solves, so
 * that solves on up to `count` threads find them waiting. Optional in Node,
 * where a run starts what it lacks; it saves the first run that wait. A
 * smaller count stops the idle surplus, so 1 stops them all.
 * @param count threads wanted, this one included; defaults to {@link defaultWorkerCount}
 */
export async function prepareThreads(count?: number): Promise<number> {
	const threads = Math.max(1, Math.floor(count ?? defaultWorkerCount()));
	engineThreadsKept = threads - 1;
	warmEngineThreads(engineThreadsKept);
	const idle = engineThreads.filter((thread) => !thread.busy);
	for (const thread of idle.slice(engineThreadsKept)) dropEngineThread(thread);
	for (const thread of idle.slice(0, engineThreadsKept)) idleEngineThread(thread);
	return threads;
}
