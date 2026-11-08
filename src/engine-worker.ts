/**
 * An engine worker in Node: one thread of a WebAssembly solve.
 *
 * Purpose: start `serveEngine` (src/engine-thread.ts) on the setup the main
 * thread passed, and let the thread end once it returns.
 */

import { parentPort, workerData } from 'node:worker_threads';
import type { EngineWorkerSetup } from './engine.ts';
import { serveEngine } from './engine-thread.ts';

serveEngine(workerData as EngineWorkerSetup);
parentPort?.close();
