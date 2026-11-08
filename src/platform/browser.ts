/**
 * Browser platform.
 *
 * Purpose: stand in for `node.ts` in a browser build, with the same exports.
 *
 * Out of the box the browser build is single-threaded: no worker threads, no
 * SharedArrayBuffer, and so no cross-origin isolation headers needed on the
 * page. Run the solve inside a Web Worker to keep the page responsive; see
 * `examples/browser-worker.ts`.
 *
 * Threads are opt-in, through `enableThreads` in `poker-flopsolve/threads`
 * (`prepareThreads` here). A browser starts a Web Worker only asynchronously —
 * a worker spawned and then waited on with `Atomics.wait` never starts, as
 * the thread that would start it is the one blocked — while a solve is
 * synchronous. So the workers are started ahead of time, once, and wait idle
 * between solves; a solve with `workers: n` hands n − 1 of them its setup and
 * takes them back on `close()`. Only the WebAssembly engine is threaded here:
 * its workers share the engine's memory exactly as Node's do and run the same
 * loop (`serveEngine`), so a fixed thread count gives the same answer as Node
 * at that count.
 *
 * The pool lives in `browser-threads.ts` and is found through `globalThis`
 * under a registered symbol, so the threads entry and the main build share
 * it even when bundled separately, and the main build carries none of it.
 */

import type { WorkerSetup } from '../parallel.ts';
import type { EngineWorkerSetup } from '../engine.ts';
import { compiledEngine } from '../engine.ts';
import type { ThreadProvider } from './browser-threads.ts';
import { THREADS_KEY } from './browser-threads.ts';

export { prepareThreads, threadsUnavailableReason } from './browser-threads.ts';

/** Which build this is. */
export const PLATFORM = 'browser';

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

/** The engine threads `prepareThreads` started, if any. */
function provider(): ThreadProvider | undefined {
	return (globalThis as unknown as Record<symbol, ThreadProvider | undefined>)[THREADS_KEY];
}

/**
 * The most threads a solve can use now: one, plus the idle engine threads
 * when the WebAssembly engine is to run and can run over shared memory here.
 * @param engine whether the WebAssembly engine is to run
 */
export function threadLimit(engine: boolean): number {
	const threads = provider();
	if (!engine || !threads || threads.idle() === 0) return 1;
	return compiledEngine('shared') ? 1 + threads.idle() : 1;
}

/** One, plus every idle engine thread `prepareThreads` started. */
export function defaultWorkerCount(): number {
	return 1 + (provider()?.idle() ?? 0);
}

/**
 * Why a solve gets fewer threads than it asked for, for the one warning.
 * @param engine whether the WebAssembly engine is to run
 */
export function threadAdvice(engine: boolean): string {
	if (!provider()) return 'call enableThreads() from poker-flopsolve/threads first, in a cross-origin isolated Web Worker';
	if (!engine) return 'browser threads run only the WebAssembly engine (default engine, f32 precision)';
	return 'the other threads are held by open runs; close() a run to free its threads';
}

/** Never called: the browser build threads only the WebAssembly engine; see `threadLimit`. */
export function spawnWorker(_setup: WorkerSetup, _onError: (error: Error) => void): WorkerHandle {
	throw new Error('The browser build threads only the WebAssembly engine; use workers: 1 with this solve');
}

/**
 * Hand one idle engine thread a solve's setup.
 * @param setup what the thread needs to join the solve
 * @param onError called if the thread dies, so the solve can stop waiting on it
 */
export function spawnEngineWorker(setup: EngineWorkerSetup, onError: (error: Error) => void): WorkerHandle {
	const threads = provider();
	if (!threads) throw new Error('No engine threads; call enableThreads() from poker-flopsolve/threads first');
	return threads.spawn(setup, onError);
}

/** Node only: in a browser the page file is an OPFS `FileSystemSyncAccessHandle`. */
export function openPageFile(_path: string): never {
	throw new Error('openPageFile is for Node; in a browser, pass an OPFS FileSystemSyncAccessHandle to outOfCore()');
}
