/**
 * The WebAssembly engine's threads take the split round's boards off a
 * shared queue, costliest first (issue #133), and each board's values are
 * kept apart and summed in board order. So which thread walks which board
 * changes nothing: a solve is bitwise the same from run to run and at any
 * thread count from two up, with sampling, shared storage and 16-bit
 * storage alike. And the work spreads: no thread walks far longer than the
 * others.
 */

import { describe, expect, it } from 'vitest';
import { createRun, defineSpot } from '../src/index.ts';
import type { SolveOptions, SpotConfig } from '../src/index.ts';
import { PROFILE, scheduleBytes, scheduleViews, threadProfiles } from '../src/engine.ts';
import { serveEngine } from '../src/engine-thread.ts';
import { wasmStorage } from '../src/wasm-storage.ts';

const flop: SpotConfig = {
	board: 'Ts 9s 4h', pot: 60, stack: 100,
	oop: 'AA,KK,QQ,AKs,AQs,KQs,76s,65s', ip: 'JJ,TT,99,AJs,KJs,QJs,JTs,T9s',
	betSizes: [[0.66]], maxRaises: 1,
};

function solveOn(workers: number, config: SpotConfig, options: SolveOptions, iterations = 12) {
	const run = createRun(defineSpot(config), { workers, ...options });
	try {
		run.step(iterations);
		return {
			engine: run.engine,
			workers: run.workers,
			regret: Float64Array.from(run.solver.ctx.regret),
			sums: Float64Array.from(run.solver.ctx.strategySum),
			ev: run.snapshot().evChips(0),
		};
	} finally {
		run.close();
	}
}

/** Index of the first entry that differs, or -1. */
function firstDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
	if (a.length !== b.length) return 0;
	for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return i;
	return -1;
}

const CASES: Record<string, { config: SpotConfig; options: SolveOptions }> = {
	plain: { config: flop, options: {} },
	'sampled, shared, buckets': {
		config: { ...flop, shareHistories: true, runoutBuckets: 3 },
		options: { approximations: { chanceSampling: {} } },
	},
	'16-bit storage': { config: flop, options: { precision: 'i16', wasmStorage } },
};

describe('engine threads share out boards', () => {
	for (const [name, { config, options }] of Object.entries(CASES)) {
		it(`gives the same solve, bit for bit, on 2, 3 and 4 threads and run to run (${name})`, () => {
			const two = solveOn(2, config, options);
			expect(two.engine).toBe('wasm');
			expect(two.workers).toBe(2);
			for (const other of [solveOn(3, config, options), solveOn(4, config, options), solveOn(2, config, options)]) {
				expect(firstDifference(other.regret, two.regret)).toBe(-1);
				expect(firstDifference(other.sums, two.sums)).toBe(-1);
				expect(other.ev).toBe(two.ev);
			}
		});
	}

	it('lays the schedule out in the threads as the main thread does', () => {
		// `serveEngine` runs as source in a browser thread, so it inlines the
		// layout rather than importing it: the two must not drift apart.
		const boards = 37;
		const buffer = new SharedArrayBuffer(scheduleBytes(boards));
		const { order, cost } = scheduleViews(buffer, boards);
		expect([order.byteOffset, order.length, cost.byteOffset, cost.length]).toEqual([0, boards, Math.ceil(boards / 2) * 8, 2 * boards]);
		const source = serveEngine.toString();
		expect(source).toContain('new Int32Array(setup.schedule, 0, boards)');
		expect(source).toContain('new Float64Array(setup.schedule, Math.ceil(boards / 2) * 8, 2 * boards)');
	});

	it('keeps every thread walking for about as long as the others', () => {
		const run = createRun(defineSpot(flop), { workers: 3 });
		try {
			run.step(30);
			const profile = threadProfiles.get(run.solver)!;
			const busy = [0, 1, 2].map((w) => profile[PROFILE.busy + w]);
			expect(profile[PROFILE.traversals]).toBe(60);
			// The slowest within half the mean again, with room for a loaded machine;
			// fixed slices could leave one thread with every costly board.
			const mean = busy.reduce((a, b) => a + b, 0) / busy.length;
			expect(Math.max(...busy) / mean).toBeLessThan(1.5);
		} finally {
			run.close();
		}
	});
});
