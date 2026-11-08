/**
 * Node platform.
 *
 * Purpose: the one place the solver touches Node-only APIs. A browser build
 * swaps this module for `browser.ts`, which has the same exports; see
 * `scripts/browser-platform.ts`.
 */

import { closeSync, fsyncSync, ftruncateSync, openSync, readSync, writeSync } from 'node:fs';
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

/** Start one WebAssembly engine thread on `engine-worker.ts`. */
export function spawnEngineWorker(setup: EngineWorkerSetup, onError: (error: Error) => void): WorkerHandle {
	const url = new URL(import.meta.url.endsWith('.ts') ? '../engine-worker.ts' : './engine-worker.js', import.meta.url);
	const thread = new Worker(fileURLToPath(url), { workerData: setup, execArgv: workerFlags() });
	thread.on('error', onError);
	thread.unref();
	return {
		terminate() {
			void thread.terminate();
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
 * Nothing to start ahead of time in Node: threads start with each solve.
 * @param count threads wanted, this one included; defaults to {@link defaultWorkerCount}
 */
export async function prepareThreads(count?: number): Promise<number> {
	return Math.max(1, Math.floor(count ?? defaultWorkerCount()));
}

/** A positioned-I/O file on disk, for `poker-flopsolve/out-of-core`. */
export function openPageFile(path: string): {
	read(buffer: Uint8Array, options: { at: number }): number;
	write(buffer: Uint8Array, options: { at: number }): number;
	truncate(size: number): void;
	flush(): void;
	close(): void;
} {
	const fd = openSync(path, 'w+');
	// One call moves at most 2 GiB, so larger views go in pieces.
	const STEP = 1 << 30;
	const each = (move: (b: Uint8Array, at: number) => number, buffer: Uint8Array, at: number): number => {
		let done = 0;
		while (done < buffer.length) {
			const n = move(buffer.subarray(done, Math.min(buffer.length, done + STEP)), at + done);
			if (n <= 0) break;
			done += n;
		}
		return done;
	};
	return {
		read: (buffer, { at }) => each((b, p) => readSync(fd, b, 0, b.length, p), buffer, at),
		write: (buffer, { at }) => each((b, p) => writeSync(fd, b, 0, b.length, p), buffer, at),
		truncate: (size) => ftruncateSync(fd, size),
		flush: () => fsyncSync(fd),
		close: () => closeSync(fd),
	};
}
