/**
 * An engine worker in Node: one thread of a WebAssembly solve.
 *
 * Purpose: run `serveEngine` (src/engine-thread.ts) on each setup the main
 * thread passes, one solve after another.
 */

import { parentPort, workerData } from 'node:worker_threads';
import type { EngineWorkerSetup } from './engine.ts';
import { serveEngine } from './engine-thread.ts';

// Started on a solve, or idle ahead of one; either way it then waits for the
// next solve's setup, as `spawnEngineWorker` in src/platform/node.ts lends it.
if (workerData) serveEngine(workerData as EngineWorkerSetup);
parentPort?.on('message', (setup: EngineWorkerSetup) => serveEngine(setup));
