/**
 * Browser platform.
 *
 * Purpose: stand in for `node.ts` in a browser build, with the same exports.
 *
 * The browser build is for small solves — river and toy spots — so it is
 * single-threaded: no worker threads, no SharedArrayBuffer, and so no
 * cross-origin isolation headers needed on the page. Run the solve inside a
 * Web Worker to keep the page responsive; see `examples/browser-worker.ts`.
 */

import type { WorkerSetup } from '../parallel.ts';
import type { EngineWorkerSetup } from '../engine.ts';

/** Which build this is. */
export const PLATFORM = 'browser';

/** Whether `workers > 1` can be honoured here. */
export const THREADS_AVAILABLE = false;

/**
 * Default ceiling on solver storage. A tab gets far less memory than a Node
 * process, so an accidental flop solve fails fast with a clear message rather
 * than taking the tab down.
 */
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/** A spawned solver thread. */
export interface WorkerHandle {
	terminate(): void;
}

/** Always one: the browser build solves on the calling thread. */
export function defaultWorkerCount(): number {
	return 1;
}

/** Never called: `createRun` resolves to one thread before planning a pool. */
export function spawnWorker(_setup: WorkerSetup, _onError: (error: Error) => void): WorkerHandle {
	throw new Error('Worker threads are only available in the Node build; use workers: 1 in the browser');
}

/** Never called: the browser build is single-threaded. */
export function spawnEngineWorker(_setup: EngineWorkerSetup, _onError: (error: Error) => void): WorkerHandle {
	throw new Error('Worker threads are only available in the Node build; use workers: 1 in the browser');
}
