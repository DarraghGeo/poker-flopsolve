/**
 * An engine worker in Node: one thread of a WebAssembly solve.
 *
 * Purpose: run `serveEngine` (src/engine-thread.ts) on the setup the main
 * thread passes, and let the thread end once it returns.
 */

import { parentPort, workerData } from 'node:worker_threads';
import type { EngineWorkerSetup } from './engine.ts';
import { serveEngine } from './engine-thread.ts';

// Started on a solve, or ahead of one to wait for its setup
// (`warmEngineThreads` in src/platform/node.ts). Either way it serves that
// one solve, and the thread ends when the solve lets it go.
if (workerData) {
	serveEngine(workerData as EngineWorkerSetup);
	parentPort?.close();
} else {
	parentPort?.once('message', (setup: EngineWorkerSetup) => {
		serveEngine(setup);
		parentPort?.close();
	});
}
