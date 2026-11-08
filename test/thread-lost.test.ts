/**
 * A solver thread killed without unwinding fails the solve instead of hanging it.
 *
 * A thread that throws reports itself in shared memory (thread-failure.test.ts),
 * but one whose isolate is torn down (a Node worker out of V8 heap) or whose
 * worker the browser kills runs no `catch` or `finally`, and its error event
 * cannot reach a main thread waiting in `Atomics.wait`. The main thread bounds
 * that wait at a backstop relative to its own shard's time instead. Here a
 * thread announces itself ready and then never runs again; the step must
 * throw once the backstop passes, and before the fix it hung for good.
 */

import { describe, expect, it } from 'vitest';
import { Mode } from '../src/cfr.ts';
import { engineAvailable } from '../src/engine.ts';
import { awaitThreads, backstopMs, THREAD_BACKSTOP_FACTOR, THREAD_BACKSTOP_FLOOR_MS } from '../src/parallel.ts';
import { spawnEngineWorker, spawnWorker } from '../src/platform/node.ts';
import { vanishingEngine, vanishingPool } from './thread-faults.ts';

const FLOOR_MS = 300;

describe('a thread killed without unwinding', () => {
	it.skipIf(!engineAvailable())('fails a WebAssembly engine step, and every step after', () => {
		const engine = vanishingEngine(spawnEngineWorker, 3, FLOOR_MS);
		try {
			const step = engine.root(true);
			const started = performance.now();
			expect(() => step(Mode.Train, 0, 1)).toThrow(/stopped answering/);
			expect(performance.now() - started).toBeGreaterThanOrEqual(FLOOR_MS);
			expect(() => step(Mode.Train, 1, 1)).toThrow(/stopped answering/);
		} finally {
			engine.close();
		}
	});

	it('fails a JavaScript pool step, and every step after', () => {
		const pool = vanishingPool(spawnWorker, 3, FLOOR_MS);
		try {
			const started = performance.now();
			expect(() => pool.traverse(Mode.Train, 0, 1)).toThrow(/stopped answering/);
			expect(performance.now() - started).toBeGreaterThanOrEqual(FLOOR_MS);
			expect(() => pool.traverse(Mode.Train, 1, 1)).toThrow(/stopped answering/);
		} finally {
			pool.close();
		}
	});
});

describe('the backstop', () => {
	it('is the floor for a quick shard and a multiple of the shard past it', () => {
		expect(backstopMs(5)).toBe(THREAD_BACKSTOP_FLOOR_MS);
		expect(THREAD_BACKSTOP_FLOOR_MS).toBe(60_000);
		expect(backstopMs(10_000)).toBe(10_000 * THREAD_BACKSTOP_FACTOR);
		expect(backstopMs(10_000, 100)).toBe(10_000 * THREAD_BACKSTOP_FACTOR);
		expect(backstopMs(1, 100)).toBe(100);
	});
});

describe('waiting for the other threads', () => {
	it('returns at once when they are done, or when told to stop', () => {
		const control = new Int32Array(new SharedArrayBuffer(8));
		control[1] = 2;
		expect(awaitThreads(control, 1, 2, performance.now(), 10_000, () => false)).toBeNull();
		expect(awaitThreads(control, 1, 3, performance.now(), 10_000, () => true)).toBeNull();
	});

	it('gives up once the backstop passes with a thread still silent', () => {
		const control = new Int32Array(new SharedArrayBuffer(8));
		const started = performance.now();
		expect(awaitThreads(control, 1, 1, started, 200, () => false)?.message).toMatch(/stopped answering/);
		expect(performance.now() - started).toBeGreaterThanOrEqual(200);
	});
});
