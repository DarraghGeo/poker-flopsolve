/**
 * A solver thread that fails mid-iteration fails the solve instead of hanging it.
 *
 * The main thread waits for the others with `Atomics.wait`, so it never runs
 * its event loop while they work and never sees a worker's `error` event. Each
 * thread therefore reports its own failure in shared memory. Here real threads
 * fail inside their slice of an iteration (see thread-faults.ts), and the step
 * must throw; before the fix it hung for good. The browser's engine threads
 * are checked the same way in browser-threads.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { Mode } from '../src/cfr.ts';
import { engineAvailable } from '../src/engine.ts';
import { spawnEngineWorker, spawnWorker } from '../src/platform/node.ts';
import { brokenEngine, brokenPool } from './thread-faults.ts';

describe('a thread that fails mid-iteration', () => {
	it.skipIf(!engineAvailable())('fails a WebAssembly engine step, and every step after', () => {
		const engine = brokenEngine(spawnEngineWorker, 3);
		try {
			const step = engine.root(true);
			expect(() => step(Mode.Train, 0, 1)).toThrow(/thread failed mid-iteration/);
			expect(() => step(Mode.Train, 1, 1)).toThrow(/thread failed mid-iteration/);
		} finally {
			engine.close();
		}
	});

	it('fails a JavaScript pool step, and every step after', () => {
		const pool = brokenPool(spawnWorker, 3);
		try {
			expect(() => pool.traverse(Mode.Train, 0, 1)).toThrow(/thread failed mid-iteration/);
			expect(() => pool.traverse(Mode.Train, 1, 1)).toThrow(/thread failed mid-iteration/);
		} finally {
			pool.close();
		}
	});
});
